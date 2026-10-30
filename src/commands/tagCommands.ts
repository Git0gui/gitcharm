import * as vscode from 'vscode';
import { GitService, TagPushResult, tagNameProblem } from '../services/gitService';
import { diffTagRefs, formatGitError, redactUrlCredentials, RemoteTagRef } from '../services/gitUtils';
import { logger } from '../services/logger';
import { TagSyncOperation, TagSyncRow } from '../views/messages';
import { GraphViewProvider } from '../views/graphView';
import { combineErrorText } from './helpers';
import { t } from '../i18n';

/**
 * Tag management: create on a commit, delete locally, push to the remote.
 *
 * The tag list always comes from `listTags()`/`getTagsAt()`, which peel packed
 * annotated tags through `git for-each-ref`; these commands never touch
 * vscode.git.
 */
export function registerTagCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService,
    graphView: GraphViewProvider
): void {
    /**
     * Which tags the caller means: one badge right-clicked in the commit list
     * (`{ tag }`), the tags on the commit it clicked, or — with no commit in
     * play — every tag in the repository. The webview only ever sends a hash or
     * a tag name, so resolution stays on this side.
     */
    const resolveTagNames = async (node: any): Promise<string[]> => {
        if (typeof node?.tag === 'string' && node.tag) {return [node.tag];}
        const hash = node?.hash ?? node?.commit?.hash;
        if (hash) {return gitService.getTagsAt(hash);}
        return (await gitService.listTags()).map(tag => tag.name);
    };

    /**
     * A tag list that still reads as one line when the repository carries
     * hundreds of them. Past three names the count says more than the tail.
     */
    const summarizeNames = (names: readonly string[]): string =>
        names.length <= 3
            ? names.join(', ')
            : `${names.slice(0, 3).join(', ')}… (${names.length})`;

    /** The verb as it reads inside a confirmation summary. */
    const actionLabel = (action: TagSyncOperation): string => {
        switch (action) {
            case 'deleteRemote': return t('tag.actionDeleteRemote');
            case 'deleteLocal': return t('tag.actionDeleteLocal');
            case 'pullForce': return t('tag.actionPullOverwrite');
            case 'pull': return t('tag.actionPull');
            case 'push': return t('tag.actionPush');
            default: return t('tag.actionKeepLocal');
        }
    };

    /** Network failures stay short here; the full git output is in the log. */
    const showNetworkError = (message: string): void => {
        void vscode.window.showErrorMessage(message, t('log.showEntry')).then(choice => {
            if (choice) {void vscode.commands.executeCommand('idea-git.showLog');}
        });
    };

    /**
     * A tag held back by the "commit must already be on the remote" rule is not
     * a git failure — no network call was made — so it reads as a warning that
     * names the next step instead of an error with a log button. A remote that
     * already carries the tag is not a failure either, and one that carries a
     * different tag under the same name needs the user's decision.
     */
    const reportPush = (result: TagPushResult): void => {
        if (result.pushed.length > 0) {
            vscode.window.showInformationMessage(
                result.pushed.length === 1
                    ? t('tag.pushed', { name: result.pushed[0] })
                    : t('tag.pushedMultiple', { count: result.pushed.length })
            );
        }
        if (result.upToDate.length > 0) {
            vscode.window.showInformationMessage(t('tag.alreadyOnRemote', {
                names: summarizeNames(result.upToDate),
                remote: result.remote
            }));
        }
        if (result.skipped.length > 0) {
            vscode.window.showWarningMessage(t('tag.commitNotPushed', {
                names: summarizeNames(result.skipped),
                remote: result.remote
            }));
        }
        if (result.diverged.length > 0) {
            vscode.window.showWarningMessage(t('tag.divergedRemote', {
                names: summarizeNames(result.diverged),
                remote: result.remote
            }));
        }
    };

    const runPush = async (
        title: string,
        push: () => Promise<TagPushResult>,
        failureMessage: (error: string) => string
    ): Promise<void> => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable: false
        }, async () => {
            try {
                reportPush(await push());
            } catch (error) {
                logger.error(`[GitCharm] tag push failed: ${redactUrlCredentials(combineErrorText(error))}`);
                showNetworkError(failureMessage(formatGitError(error)));
            }
        });
    };

    const pickTags = async (
        names: string[],
        placeHolderKey: string,
        describe?: (name: string) => string | undefined
    ): Promise<string[] | undefined> => {
        if (names.length === 0) {
            vscode.window.showInformationMessage(t('tag.none'));
            return undefined;
        }
        if (names.length === 1) {return names;}

        const picked = await vscode.window.showQuickPick(
            names.map(name => ({ label: name, description: describe?.(name) })),
            {
                canPickMany: true,
                placeHolder: t(placeHolderKey),
                title: t('tag.pickTitle')
            }
        );
        return picked && picked.length > 0 ? picked.map(p => p.label) : undefined;
    };

    /**
     * What the remote already carries, keyed by local tag name. `undefined`
     * means the remote could not be reached: the picker then lists every tag as
     * before and the push itself reports the network error.
     */
    const readRemoteState = async (): Promise<Map<string, 'same' | 'diverged'> | undefined> => {
        try {
            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('tag.remoteReading'),
                cancellable: false
            }, async () => {
                const info = await gitService.listRemoteTags();
                const local = new Map((await gitService.listTags()).map(tag => [tag.name, tag.hash] as const));
                const state = new Map<string, 'same' | 'diverged'>();
                for (const tag of info.tags) {
                    const mine = local.get(tag.name);
                    if (mine === undefined) {continue;}
                    state.set(tag.name, mine === tag.commit ? 'same' : 'diverged');
                }
                return state;
            });
        } catch (error) {
            logger.debug(`[GitCharm] remote tag listing skipped: ${redactUrlCredentials(combineErrorText(error))}`);
            return undefined;
        }
    };

    /**
     * A local-only repository has no remote to push tags to. Letting the push
     * run would end in "fatal: 'origin' does not appear to be a git repository",
     * which reads like a broken repo instead of "add a remote first".
     */
    const ensureRemote = async (): Promise<boolean> => {
        if (gitService.getRemoteNames().length > 0) {return true;}
        const choice = await vscode.window.showInformationMessage(
            t('tag.noRemotePush'),
            t('remote.manageTitle')
        );
        if (choice) {void vscode.commands.executeCommand('idea-git.manageRemotes');}
        return false;
    };

    /**
     * Delete tags on the remote. A tag the remote never had is not a failure —
     * there is simply nothing to remove. Returns the tags that really failed and
     * the first git message, so callers can decide whether to go on with the
     * local half.
     */
    const deleteRemoteTags = async (
        names: string[],
        remote: string
    ): Promise<{ failed: string[]; error: string }> => {
        const failed: string[] = [];
        let firstError = '';
        for (const name of names) {
            try {
                await gitService.deleteRemoteTag(name, remote);
            } catch (error) {
                const text = combineErrorText(error);
                if (/remote ref does not exist/i.test(text)) {continue;}
                logger.error(`[GitCharm] remote tag delete failed (${name}): ${redactUrlCredentials(text)}`);
                if (!firstError) {firstError = formatGitError(error);}
                failed.push(name);
            }
        }
        return { failed, error: firstError };
    };

    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.createTag', async (node: any) => {
            const hash = node?.hash ?? node?.commit?.hash ?? gitService.selectedCommitHash;
            if (!hash) {
                vscode.window.showErrorMessage(t('common.noCommitSelected'));
                return;
            }

            const existing = (await gitService.listTags()).map(tag => tag.name);
            const name = await vscode.window.showInputBox({
                prompt: t('tag.namePrompt', { hash: String(hash).substring(0, 7) }),
                placeHolder: 'v1.0.0',
                ignoreFocusOut: true,
                validateInput: value => tagNameProblem(value, existing)
            });
            if (!name) {return;}

            const finalProblem = tagNameProblem(name, existing);
            if (finalProblem) {
                vscode.window.showErrorMessage(finalProblem);
                return;
            }

            // An empty message keeps the tag lightweight — asking for one is the
            // only thing that turns `git tag -a` into an annotated tag.
            const message = await vscode.window.showInputBox({
                prompt: t('tag.messagePrompt'),
                placeHolder: t('tag.messagePlaceholder'),
                ignoreFocusOut: true
            });
            if (message === undefined) {return;}

            const trimmedName = name.trim();
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('tag.creating', { name: trimmedName }),
                    cancellable: false
                }, async () => {
                    await gitService.createTag(trimmedName, hash, message);
                    vscode.window.showInformationMessage(t('tag.created', { name: trimmedName }));
                    graphView.refresh();
                });
            } catch (error) {
                vscode.window.showErrorMessage(t('tag.createFailed', { error: formatGitError(error) }));
            }
        }),

        vscode.commands.registerCommand('idea-git.deleteTag', async (node: any) => {
            const candidates = await resolveTagNames(node);
            const names = await pickTags(candidates, 'tag.pickDeletePlaceHolder');
            if (!names || names.length === 0) {return;}

            const summary = summarizeNames(names);
            // Deleting on the remote is a separate answer, not a hidden extra: the
            // dialog offers both destinations. Without a remote there is nothing
            // to ask about, so it stays a local-only question.
            const remote = gitService.getFetchRemote();
            const localBtn = t('tag.deleteLocalBtn');
            const bothBtn = t('tag.deleteLocalRemoteBtn');
            const confirm = await graphView.showDialog(
                t(remote ? 'tag.deleteConfirm' : 'tag.deleteConfirmNoRemote', { names: summary }),
                remote
                    ? [localBtn, bothBtn, t('common.cancel')]
                    : [localBtn, t('common.cancel')],
                'warn'
            );
            if (confirm !== localBtn && confirm !== bothBtn) {return;}
            const alsoRemote = confirm === bothBtn;

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: alsoRemote
                    ? t('tag.deletingBoth', { names: summary })
                    : t('tag.deleting', { names: summary }),
                cancellable: false
            }, async () => {
                // Remote first: the network half can fail (auth, protected tags)
                // and that must not stop the local removal the user also asked for.
                const remoteResult = alsoRemote
                    ? await deleteRemoteTags(names, remote)
                    : { failed: [] as string[], error: '' };
                const remoteFailed = remoteResult.failed;

                const deleted: string[] = [];
                const failed: string[] = [];
                for (const name of names) {
                    try {
                        await gitService.deleteTag(name);
                        deleted.push(name);
                    } catch {
                        failed.push(name);
                    }
                }

                if (deleted.length > 0) {
                    if (alsoRemote && failed.length === 0 && remoteFailed.length === 0) {
                        vscode.window.showInformationMessage(t('tag.deletedBoth', { names: summary }));
                    } else {
                        vscode.window.showInformationMessage(
                            deleted.length === 1
                                ? t('tag.deleted', { name: deleted[0] })
                                : t('tag.deletedMultiple', { count: deleted.length })
                        );
                    }
                }
                if (failed.length > 0) {
                    vscode.window.showErrorMessage(t('tag.deleteFailed', { error: summarizeNames(failed) }));
                }
                if (remoteFailed.length > 0) {
                    showNetworkError(t('tag.deleteRemoteFailed', {
                        names: summarizeNames(remoteFailed),
                        remote,
                        error: remoteResult.error
                    }));
                }
                if (deleted.length > 0) {graphView.refresh();}
            });
        }),

        /**
         * The toolbar entry always means "both sides". Unlike the badge menu
         * (which offers local or local+remote), the remote half runs first and
         * must succeed before any local tag goes: a failed remote deletion
         * leaves everything as it was, so the user can retry instead of ending
         * up with the remote copy orphaned.
         */
        vscode.commands.registerCommand('idea-git.deleteTags', async (node: any) => {
            if (!(await ensureRemote())) {return;}
            const candidates = await resolveTagNames(node);
            const names = await pickTags(candidates, 'tag.pickDeletePlaceHolder');
            if (!names || names.length === 0) {return;}

            const remote = gitService.getFetchRemote();
            const summary = summarizeNames(names);
            const confirmBtn = t('tag.deleteLocalRemoteBtn');
            const confirm = await graphView.showDialog(
                t('tag.deleteBothConfirm', { names: summary, remote }),
                [confirmBtn, t('common.cancel')],
                'warn'
            );
            if (confirm !== confirmBtn) {return;}

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('tag.deletingBoth', { names: summary }),
                cancellable: false
            }, async () => {
                const remoteResult = await deleteRemoteTags(names, remote);
                if (remoteResult.failed.length > 0) {
                    showNetworkError(t('tag.deleteRemoteAborted', {
                        names: summarizeNames(remoteResult.failed),
                        remote,
                        error: remoteResult.error
                    }));
                    return;
                }

                const deleted: string[] = [];
                const failed: string[] = [];
                for (const name of names) {
                    try {
                        await gitService.deleteTag(name);
                        deleted.push(name);
                    } catch {
                        failed.push(name);
                    }
                }
                if (deleted.length > 0) {
                    vscode.window.showInformationMessage(t('tag.deletedBoth', { names: summarizeNames(deleted) }));
                    graphView.refresh();
                }
                if (failed.length > 0) {
                    vscode.window.showErrorMessage(t('tag.deleteFailed', { error: summarizeNames(failed) }));
                }
            });
        }),

        vscode.commands.registerCommand('idea-git.pushTag', async (node: any) => {
            let candidates = await resolveTagNames(node);
            if (candidates.length === 0) {
                vscode.window.showInformationMessage(t('tag.none'));
                return;
            }
            if (!(await ensureRemote())) {return;}

            // Reading the remote once is what keeps the picker honest: tags the
            // remote already has at the same commit drop out (there is nothing
            // to push), and ones it has at another commit stay listed with a
            // warning, because the push guard will not overwrite them.
            let state: Map<string, 'same' | 'diverged'> | undefined;
            if (candidates.length > 1) {
                const remoteState = await readRemoteState();
                if (remoteState) {
                    state = remoteState;
                    candidates = candidates.filter(name => remoteState.get(name) !== 'same');
                    if (candidates.length === 0) {
                        vscode.window.showInformationMessage(t('tag.noneToPush'));
                        return;
                    }
                }
            }

            const names = await pickTags(
                candidates,
                'tag.pickPushPlaceHolder',
                name => state?.get(name) === 'diverged' ? t('tag.remoteStateDiverged') : undefined
            );
            if (!names || names.length === 0) {return;}

            await runPush(
                names.length === 1
                    ? t('tag.pushing', { name: names[0] })
                    : t('tag.pushingMultiple', { count: names.length }),
                () => gitService.pushTags(names),
                error => t('tag.pushFailed', { names: summarizeNames(names), error })
            );
            // Nothing about the local repository changed, so the panel must
            // not reload — the tags already have badges.
        }),

        vscode.commands.registerCommand('idea-git.pushAllTags', async () => {
            const names = (await gitService.listTags()).map(tag => tag.name);
            if (names.length === 0) {
                vscode.window.showInformationMessage(t('tag.none'));
                return;
            }
            if (!(await ensureRemote())) {return;}

            const confirm = await graphView.showDialog(
                t('tag.pushAllConfirm', { count: names.length }),
                [t('tag.pushAllBtn'), t('common.cancel')],
                'info'
            );
            if (confirm !== t('tag.pushAllBtn')) {return;}

            await runPush(
                t('tag.pushingAll', { count: names.length }),
                () => gitService.pushTags(names),
                error => t('tag.pushAllFailed', { error })
            );
        }),

        /**
         * Compare local tags with what the remote advertises.
         *
         * git has no remote-tag namespace — fetching a tag simply creates a
         * local one — so "I deleted it here" and "I never fetched it" leave the
         * exact same local state. The list therefore describes the difference
         * ("remote has it, local does not") and lets the user choose: fetch it
         * back, delete it on the remote, or push a local-only tag.
         */
        vscode.commands.registerCommand('idea-git.remoteTags', async () => {
            const local = new Map((await gitService.listTags()).map(tag => [tag.name, tag.hash] as const));
            // The dialog is not gated on a remote check: it opens whenever there
            // is at least one tag to look at. Without a configured remote the
            // table is a read-only view of the local tags — no network call, no
            // invented "in sync" conclusion — and only a repository with no tags
            // on either side stays a notification.
            const configured = gitService.getRemoteNames().length > 0;
            let remote = gitService.getFetchRemote();
            let remoteTags: RemoteTagRef[] = [];
            if (configured) {
                try {
                    const info = await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: t('tag.remoteReading'),
                        cancellable: false
                    }, () => gitService.listRemoteTags());
                    if (!info) {return;}
                    remote = info.remote;
                    remoteTags = info.tags;
                } catch (error) {
                    logger.error(`[GitCharm] remote tag listing failed: ${redactUrlCredentials(combineErrorText(error))}`);
                    showNetworkError(t('tag.remoteReadFailed', { error: formatGitError(error) }));
                    return;
                }
            }
            if (local.size === 0 && remoteTags.length === 0) {
                vscode.window.showInformationMessage(t('tag.none'));
                return;
            }

            const diff = diffTagRefs(local, remoteTags);
            const remoteCommits = new Map(remoteTags.map(tag => [tag.name, tag.commit] as const));
            const inSync = [...local.keys()]
                .filter(name => remoteCommits.get(name) === local.get(name))
                .sort((a, b) => a.localeCompare(b));
            // Conflicts first: they are the rows that actually need a decision,
            // while one-sided tags have an obvious default and agreeing tags
            // offer deletions only (the differences-only filter hides them).
            const rows: TagSyncRow[] = [
                ...diff.different.map(name => ({
                    name,
                    state: 'different' as const,
                    localHash: local.get(name),
                    remoteHash: remoteCommits.get(name)
                })),
                ...diff.remoteOnly.map(name => ({
                    name,
                    state: 'remoteOnly' as const,
                    remoteHash: remoteCommits.get(name)
                })),
                ...diff.localOnly.map(name => ({
                    name,
                    state: 'localOnly' as const,
                    localHash: local.get(name)
                })),
                ...inSync.map(name => ({
                    name,
                    state: 'inSync' as const,
                    localHash: local.get(name),
                    remoteHash: remoteCommits.get(name)
                }))
            ];

            // The table keeps every tag visible with its own action, so the
            // user decides per row instead of reading a multi-action quick pick
            // where the same name appears once per possible verb.
            const picked = await graphView.showTagSyncDialog(remote, rows, !configured);
            // "Keep local" is a decision that runs nothing: ticking such a row
            // only records that the conflict was reviewed.
            const actionable = (picked ?? []).filter(item => item.action !== 'keep');
            if (actionable.length === 0) {return;}

            // Overwriting a local tag and deleting either side both destroy
            // something, so they get one explicit confirmation up front.
            const risky = actionable.filter(item => item.action !== 'pull' && item.action !== 'push');
            if (risky.length > 0) {
                const summary = summarizeNames(risky.map(item => `${actionLabel(item.action)} ${item.name}`));
                const confirm = await graphView.showDialog(
                    t('tag.confirmDestructive', { items: summary }),
                    [t('tag.runBtn'), t('common.cancel')],
                    'warn'
                );
                if (confirm !== t('tag.runBtn')) {return;}
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('tag.syncingTags', { count: actionable.length }),
                cancellable: false
            }, async () => {
                let done = 0;
                let localChanged = false;
                const toPush: string[] = [];
                const skipped: string[] = [];
                const diverged: string[] = [];
                const failed: string[] = [];
                let firstError = '';
                for (const item of actionable) {
                    if (item.action === 'push') {
                        toPush.push(item.name);
                        continue;
                    }
                    try {
                        if (item.action === 'deleteRemote') {
                            await gitService.deleteRemoteTag(item.name, remote);
                            done++;
                        } else if (item.action === 'deleteLocal') {
                            await gitService.deleteTag(item.name);
                            localChanged = true;
                            done++;
                        } else {
                            await gitService.fetchTag(item.name, remote, item.action === 'pullForce');
                            localChanged = true;
                            done++;
                        }
                    } catch (error) {
                        logger.error(`[GitCharm] tag sync failed (${item.action} ${item.name}): ${redactUrlCredentials(combineErrorText(error))}`);
                        if (!firstError) {firstError = formatGitError(error);}
                        failed.push(item.name);
                    }
                }
                // One push for the whole selection: `pushTags` already reads
                // the remote list, so per-tag calls would repeat that network
                // round trip once per row.
                if (toPush.length > 0) {
                    try {
                        const result = await gitService.pushTags(toPush, remote);
                        done += result.pushed.length + result.upToDate.length;
                        skipped.push(...result.skipped);
                        diverged.push(...result.diverged);
                    } catch (error) {
                        logger.error(`[GitCharm] tag sync failed (push ${toPush.join(', ')}): ${redactUrlCredentials(combineErrorText(error))}`);
                        if (!firstError) {firstError = formatGitError(error);}
                        failed.push(...toPush);
                    }
                }

                if (done > 0) {
                    vscode.window.showInformationMessage(t('tag.syncDone', { count: done }));
                }
                if (skipped.length > 0) {
                    vscode.window.showWarningMessage(t('tag.syncSkipped', { names: summarizeNames(skipped) }));
                }
                if (diverged.length > 0) {
                    vscode.window.showWarningMessage(t('tag.divergedRemote', {
                        names: summarizeNames(diverged),
                        remote
                    }));
                }
                if (failed.length > 0) {
                    showNetworkError(t('tag.syncFailed', { names: summarizeNames(failed), error: firstError }));
                }
                // Fetches and local deletions change the badges; pushes and
                // remote deletions leave the local refs exactly as they were.
                if (localChanged) {graphView.refresh();}
            });
        })
    );
}
