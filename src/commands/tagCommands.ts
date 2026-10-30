import * as vscode from 'vscode';
import { GitService, TagPushResult, tagNameProblem } from '../services/gitService';
import { formatGitError, redactUrlCredentials } from '../services/gitUtils';
import { logger } from '../services/logger';
import { GraphViewProvider } from '../views/graphView';
import { combineErrorText } from './helpers';
import { t } from '../i18n';

/**
 * Tag management: create on a commit, delete locally, push to the remote.
 *
 * The tag list always comes from `listTags()`/`getTagsAt()` — a refs-directory
 * read with no subprocess — so these commands never touch vscode.git.
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
    const resolveTagNames = (node: any): string[] => {
        if (typeof node?.tag === 'string' && node.tag) {return [node.tag];}
        const hash = node?.hash ?? node?.commit?.hash;
        if (hash) {return gitService.getTagsAt(hash);}
        return gitService.listTags().map(tag => tag.name);
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
     * names the next step instead of an error with a log button.
     */
    const reportPush = (result: TagPushResult): void => {
        if (result.pushed.length === 0) {
            vscode.window.showWarningMessage(t('tag.commitNotPushed', {
                names: result.skipped.join(', '),
                remote: result.remote
            }));
            return;
        }
        vscode.window.showInformationMessage(
            result.skipped.length > 0
                ? t('tag.pushedSkipped', {
                    count: result.pushed.length,
                    names: result.skipped.join(', '),
                    remote: result.remote
                })
                : result.pushed.length === 1
                    ? t('tag.pushed', { name: result.pushed[0] })
                    : t('tag.pushedMultiple', { count: result.pushed.length })
        );
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

    const pickTags = async (names: string[], placeHolderKey: string): Promise<string[] | undefined> => {
        if (names.length === 0) {
            vscode.window.showInformationMessage(t('tag.none'));
            return undefined;
        }
        if (names.length === 1) {return names;}

        const picked = await vscode.window.showQuickPick(
            names.map(name => ({ label: name })),
            {
                canPickMany: true,
                placeHolder: t(placeHolderKey),
                title: t('tag.pickTitle')
            }
        );
        return picked && picked.length > 0 ? picked.map(p => p.label) : undefined;
    };

    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.createTag', async (node: any) => {
            const hash = node?.hash ?? node?.commit?.hash ?? gitService.selectedCommitHash;
            if (!hash) {
                vscode.window.showErrorMessage(t('common.noCommitSelected'));
                return;
            }

            const existing = gitService.listTags().map(tag => tag.name);
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
            const candidates = resolveTagNames(node);
            const names = await pickTags(candidates, 'tag.pickDeletePlaceHolder');
            if (!names || names.length === 0) {return;}

            const summary = names.length === 1 ? names[0] : `${names.length}: ${names.join(', ')}`;
            const confirm = await graphView.showDialog(
                t('tag.deleteConfirm', { names: summary }),
                [t('tag.deleteBtn'), t('common.cancel')],
                'warn'
            );
            if (confirm !== t('tag.deleteBtn')) {return;}

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('tag.deleting', { names: summary }),
                cancellable: false
            }, async () => {
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
                    vscode.window.showInformationMessage(
                        deleted.length === 1
                            ? t('tag.deleted', { name: deleted[0] })
                            : t('tag.deletedMultiple', { count: deleted.length })
                    );
                }
                if (failed.length > 0) {
                    vscode.window.showErrorMessage(t('tag.deleteFailed', { error: failed.join(', ') }));
                }
                if (deleted.length > 0) {graphView.refresh();}
            });
        }),

        vscode.commands.registerCommand('idea-git.pushTag', async (node: any) => {
            const candidates = resolveTagNames(node);
            const names = await pickTags(candidates, 'tag.pickPushPlaceHolder');
            if (!names || names.length === 0) {return;}

            await runPush(
                names.length === 1
                    ? t('tag.pushing', { name: names[0] })
                    : t('tag.pushingMultiple', { count: names.length }),
                () => gitService.pushTags(names),
                error => t('tag.pushFailed', { names: names.join(', '), error })
            );
            // Nothing about the local repository changed, so the panel must
            // not reload — the tags already have badges.
        }),

        vscode.commands.registerCommand('idea-git.pushAllTags', async () => {
            const names = gitService.listTags().map(tag => tag.name);
            if (names.length === 0) {
                vscode.window.showInformationMessage(t('tag.none'));
                return;
            }

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
        })
    );
}
