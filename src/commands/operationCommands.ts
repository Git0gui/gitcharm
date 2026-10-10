import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { GraphViewProvider } from '../views/graphView';
import { isConflictError, combineErrorText } from './helpers';
import { t } from '../i18n';

type OpKind = 'rebase' | 'merge' | 'cherry-pick';

function opLabelKey(op: OpKind): string {
    return op === 'cherry-pick' ? 'op.cherryPick' : `op.${op}`;
}

function opCompletedKey(op: OpKind): string {
    return op === 'cherry-pick' ? 'op.cherryPickCompleted' : `op.${op}Completed`;
}

function opAbortedKey(op: OpKind): string {
    return op === 'cherry-pick' ? 'op.cherryPickAborted' : `op.${op}Aborted`;
}

/** Continue/abort in-progress rebase/merge/cherry-pick operations. */
export function registerOperationCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService,
    graphView: GraphViewProvider
): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.continueOperation', async () => {
            try {
                const operation = await gitService.getInProgressOperation();
                if (!operation) {
                    vscode.window.showInformationMessage(t('op.noneInProgress'));
                    return;
                }

                const opLabel = t(opLabelKey(operation));

                const confirm = await graphView.showDialog(
                    t('op.continueConfirm', { op: opLabel }),
                    [t('op.continue'), t('common.cancel')],
                    'info'
                );

                if (confirm !== t('op.continue')) {return;}

                if (operation === 'rebase') {
                    await gitService.rebaseContinue();
                } else if (operation === 'merge') {
                    await gitService.mergeContinue();
                } else if (operation === 'cherry-pick') {
                    await gitService.executeGitArgs(['cherry-pick', '--continue']);
                }
                vscode.window.showInformationMessage(t(opCompletedKey(operation)));
                graphView.refresh();
            } catch (error: any) {
                const errMsg = combineErrorText(error) || String(error);
                if (isConflictError(errMsg)) {
                    // Still has conflicts, show simplified dialog
                    try {
                        await vscode.commands.executeCommand('workbench.view.scm');
                    } catch {}

                    const choice = await graphView.showDialog(
                        t('conflict.stillUnresolved'),
                        [t('conflict.abortAction'), t('common.cancel')],
                        'warn'
                    );

                    if (choice === t('conflict.abortAction')) {
                        try {
                            const currentOp = await gitService.getInProgressOperation();
                            if (currentOp === 'rebase') {
                                await gitService.rebaseAbort();
                            } else if (currentOp === 'merge') {
                                await gitService.mergeAbort();
                            } else if (currentOp === 'cherry-pick') {
                                await gitService.abortCherryPick();
                            }
                            vscode.window.showInformationMessage(t('op.aborted'));
                            graphView.refresh();
                        } catch (abortError: any) {
                            vscode.window.showErrorMessage(t('op.abortFailed', { error: combineErrorText(abortError) }));
                        }
                    }
                } else {
                    vscode.window.showErrorMessage(t('op.continueFailed', { error: errMsg }));
                }
            }
        }),

        vscode.commands.registerCommand('idea-git.abortOperation', async () => {
            try {
                const operation = await gitService.getInProgressOperation();
                if (!operation) {
                    vscode.window.showInformationMessage(t('op.noneInProgress'));
                    return;
                }

                const opLabel = t(opLabelKey(operation));

                const confirm = await graphView.showDialog(
                    t('op.abortConfirm', { op: opLabel }),
                    [t('op.abort'), t('common.cancel')],
                    'warn'
                );

                if (confirm !== t('op.abort')) {return;}

                if (operation === 'rebase') {
                    await gitService.rebaseAbort();
                } else if (operation === 'merge') {
                    await gitService.mergeAbort();
                } else if (operation === 'cherry-pick') {
                    await gitService.abortCherryPick();
                }
                vscode.window.showInformationMessage(t(opAbortedKey(operation)));
                graphView.refresh();
            } catch (error: any) {
                vscode.window.showErrorMessage(t('op.abortFailed', { error: combineErrorText(error) }));
            }
        }),

        // Create a repository in the open folder. The panel never disappears, so
        // the guidance page flips straight to the empty-repository checklist.
        vscode.commands.registerCommand('idea-git.initRepository', async () => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                vscode.window.showErrorMessage(t('repo.noFolder'));
                return;
            }
            if (gitService.repositoryPath) {
                vscode.window.showInformationMessage(t('repo.alreadyRepo'));
                return;
            }

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: t('repo.initProgress'),
                    cancellable: false
                },
                async () => {
                    try {
                        await gitService.initRepository(folder.uri.fsPath);
                        gitService.refreshRepositoryPath();
                        void vscode.commands.executeCommand('setContext', 'idea-git.hasGitRepo', true);
                        await graphView.refreshRepoState(true);
                        vscode.window.showInformationMessage(t('repo.initSuccess', { path: folder.uri.fsPath }));
                    } catch (error) {
                        vscode.window.showErrorMessage(t('repo.initFailed', { error: String(error) }));
                    }
                }
            );
        })
    );
}
