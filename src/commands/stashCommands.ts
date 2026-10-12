import * as vscode from 'vscode';
import { GitService, StashEntry } from '../services/gitService';
import { GraphViewProvider } from '../views/graphView';
import { tryHandleConflict } from './helpers';
import { t } from '../i18n';

/**
 * Stash management: save the current changes, then apply / pop / drop entries
 * from the stack.
 *
 * The list always comes from `GitService.getStashes()`, so no command here needs
 * (or gets) the built-in git extension. Positions are re-read before every
 * operation: dropping `stash@{0}` shifts every other entry down by one, so an
 * index the user clicked moments ago may now name a different stash.
 */
export function registerStashCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService,
    graphView: GraphViewProvider
): void {
    /** `stash@{2}` — stable in messages even though the panel label shows the subject. */
    const stashRef = (stash: StashEntry): string => `stash@{${stash.index}}`;

    /** `2026-10-12T23:28:36+08:00` -> `2026-10-12 23:28`; unparseable text is kept. */
    const stashDate = (iso: string): string => (iso ? iso.replace('T', ' ').substring(0, 16) : '');

    /**
     * Which stash the caller means: the tree row that was clicked when it is still
     * in the stack, otherwise the only one there is, otherwise a pick.
     */
    const resolveStash = async (node: any, placeHolderKey: string): Promise<StashEntry | undefined> => {
        const stashes = await gitService.getStashes();
        if (stashes.length === 0) {
            vscode.window.showInformationMessage(t('stash.none'));
            return undefined;
        }

        const wanted = typeof node?.stash === 'number' ? node.stash : undefined;
        if (wanted !== undefined) {
            const hit = stashes.find(entry => entry.index === wanted);
            if (hit) {return hit;}
        }
        if (stashes.length === 1) {return stashes[0];}

        const picked = await vscode.window.showQuickPick(
            stashes.map(entry => ({
                label: entry.message || stashRef(entry),
                description: stashDate(entry.date),
                detail: stashRef(entry),
                entry
            })),
            { placeHolder: t(placeHolderKey), title: t('stash.pickTitle') }
        );
        return picked?.entry;
    };

    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.stashSave', async () => {
            // `git stash push` says "No local changes to save" and stores nothing when
            // the tree only has untracked files, so ask before running it.
            let stashable = true;
            try {
                stashable = await gitService.hasStashableChanges();
            } catch {
                stashable = true; // let git report whatever went wrong
            }
            if (!stashable) {
                vscode.window.showInformationMessage(t('stash.nothingToSave'));
                return;
            }

            const message = await vscode.window.showInputBox({
                prompt: t('stash.messagePrompt'),
                placeHolder: t('stash.messagePlaceholder'),
                ignoreFocusOut: true
            });
            if (message === undefined) {return;}

            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('stash.saving'),
                    cancellable: false
                }, async () => {
                    await gitService.saveStash(message.trim() || undefined);
                    vscode.window.showInformationMessage(t('stash.saved'));
                    graphView.refreshStashes();
                });
            } catch (error) {
                vscode.window.showErrorMessage(t('stash.saveFailed', { error: String(error) }));
            }
        }),

        vscode.commands.registerCommand('idea-git.stashApply', async (node: any) => {
            const stash = await resolveStash(node, 'stash.pickApplyPlaceHolder');
            if (!stash) {return;}
            const ref = stashRef(stash);

            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('stash.applying', { ref }),
                    cancellable: false
                }, async () => {
                    await gitService.applyStash(stash.index);
                    vscode.window.showInformationMessage(t('stash.applied', { ref }));
                });
            } catch (error) {
                // A conflicted apply keeps the stash entry and leaves the index
                // unmerged; the opened files are where it gets resolved.
                if (!(await tryHandleConflict(error, gitService, graphView, t('stash.operationLabel')))) {
                    vscode.window.showErrorMessage(t('stash.applyFailed', { error: String(error) }));
                }
            }
            graphView.refreshStashes();
        }),

        vscode.commands.registerCommand('idea-git.stashPop', async (node: any) => {
            const stash = await resolveStash(node, 'stash.pickPopPlaceHolder');
            if (!stash) {return;}
            const ref = stashRef(stash);

            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('stash.popping', { ref }),
                    cancellable: false
                }, async () => {
                    await gitService.popStash(stash.index);
                    vscode.window.showInformationMessage(t('stash.popped', { ref }));
                });
            } catch (error) {
                // git drops the entry only after a clean apply, so a conflict here
                // means the stash is still on the stack — the re-list below shows it.
                if (!(await tryHandleConflict(error, gitService, graphView, t('stash.operationLabel')))) {
                    vscode.window.showErrorMessage(t('stash.popFailed', { error: String(error) }));
                }
            }
            graphView.refreshStashes();
        }),

        vscode.commands.registerCommand('idea-git.stashDrop', async (node: any) => {
            const stash = await resolveStash(node, 'stash.pickDropPlaceHolder');
            if (!stash) {return;}
            const ref = stashRef(stash);

            const confirm = await graphView.showDialog(
                t('stash.dropConfirm', { ref, message: stash.message }),
                [t('stash.dropBtn'), t('common.cancel')],
                'warn'
            );
            if (confirm !== t('stash.dropBtn')) {return;}

            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('stash.dropping', { ref }),
                    cancellable: false
                }, async () => {
                    await gitService.dropStash(stash.index);
                    vscode.window.showInformationMessage(t('stash.dropped', { ref }));
                });
            } catch (error) {
                vscode.window.showErrorMessage(t('stash.dropFailed', { error: String(error) }));
            }
            graphView.refreshStashes();
        })
    );
}
