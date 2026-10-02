import * as vscode from 'vscode';
import { GitService, GitCommit, assertHash } from '../services/gitService';
import { logger } from '../services/logger';
import { GraphViewProvider } from '../views/graphView';
import {
    isConflictError,
    combineErrorText,
    tryHandleConflict
} from './helpers';
import { t } from '../i18n';

/** Commit-level commands (diff/cherry-pick/rebase/drop/amend/squash/reset). */
export function registerCommitCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService,
    graphView: GraphViewProvider
): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.showCommitDiff', async (commit: GitCommit) => {
            if (!commit) {
                vscode.window.showErrorMessage(t('common.noCommitSelected'));
                return;
            }

            try {
                const diff = await gitService.getCommitDiff(commit.hash);
                const doc = await vscode.workspace.openTextDocument({
                    content: diff,
                    language: 'diff'
                });
                await vscode.window.showTextDocument(doc);
            } catch (error) {
                vscode.window.showErrorMessage(t('commit.showDiffFailed', { error: String(error) }));
            }
        }),

        vscode.commands.registerCommand('idea-git.cherryPick', async (commitNode: any) => {
            // Check if hashes array is provided directly from webview multi-select
            const hashesFromWebview = commitNode?.hashes;
            const singleHash = commitNode?.hash ?? commitNode?.commit?.hash;
            
            let selectedHashes: string[] = [];
            
            if (hashesFromWebview && Array.isArray(hashesFromWebview) && hashesFromWebview.length > 0) {
                // Direct multi-select from webview - need to sort by date (oldest first)
                const commitDetails = await Promise.all(
                    hashesFromWebview.map(async (hash: string) => {
                        try {
                            const detail = await gitService.getCommitDetail(hash);
                            return { hash, date: detail.authorDate };
                        } catch {
                            return { hash, date: '' };
                        }
                    })
                );
                commitDetails.sort((a, b) => a.date.localeCompare(b.date));
                selectedHashes = commitDetails.map(c => c.hash);
            } else if (singleHash) {
                // Single commit from context menu
                selectedHashes = [singleHash];
            } else {
                // No commit provided - show picker
                const commits = await gitService.getLog(50);
                if (commits.length === 0) {
                    vscode.window.showErrorMessage(t('common.noCommitSelected'));
                    return;
                }
                
                const items = commits.map(c => ({
                    label: c.message || t('commit.noMessage'),
                    description: c.shortHash,
                    detail: `${c.author} · ${c.relativeDate}`,
                    hash: c.hash,
                    date: c.date
                }));
                
                const selected = await vscode.window.showQuickPick(items, {
                    canPickMany: true,
                    placeHolder: t('cherryPick.pickPlaceHolder'),
                    title: t('cherryPick.pickTitle')
                });
                
                if (!selected || selected.length === 0) {return;}
                // Sort by date ascending (oldest first) for cherry-pick
                selected.sort((a, b) => a.date.localeCompare(b.date));
                selectedHashes = selected.map(s => s.hash);
            }
            
            // Validate hashes
            const currentBranch = await gitService.getCurrentBranch();
            const blockedHashes: Array<{ hash: string; reason: string }> = [];
            
            for (const hash of selectedHashes) {
                try {
                    assertHash(hash);
                    
                    // Check if commit already exists in current branch
                    const exists = await gitService.commitExistsInBranch(hash, currentBranch);
                    if (exists) {
                        blockedHashes.push({ hash: hash.substring(0, 7), reason: t('err.cherryPickExistsInBranch') });
                        continue;
                    }
                    
                    // Check if it's a merge commit
                    const isMerge = await gitService.isMergeCommit(hash);
                    if (isMerge) {
                        blockedHashes.push({ hash: hash.substring(0, 7), reason: t('err.cherryPickMergeCommit') });
                    }
                } catch {
                    vscode.window.showErrorMessage(t('err.invalidHash', { value: hash.substring(0, 7) }));
                    return;
                }
            }
            
            if (blockedHashes.length > 0) {
                const reasons = blockedHashes.map(b => `${b.hash}: ${b.reason}`).join('\n');
                vscode.window.showErrorMessage(reasons);
                return;
            }
            
            // Confirm
            const hashList = selectedHashes.map(h => h.substring(0, 7)).join(', ');
            const confirm = await graphView.showDialog(
                selectedHashes.length === 1
                    ? t('cherryPick.confirm', { hash: selectedHashes[0].substring(0, 7) })
                    : t('cherryPick.confirmMultiple', { count: selectedHashes.length, hashes: hashList }),
                [t('cherryPick.confirmBtn'), t('common.cancel')],
                'warn'
            );
            
            if (confirm !== t('cherryPick.confirmBtn')) {return;}
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: selectedHashes.length === 1 
                    ? t('cherryPick.picking', { hash: selectedHashes[0].substring(0, 7) })
                    : t('cherryPick.pickingMultiple', { count: selectedHashes.length }),
                cancellable: false
            }, async () => {
                // Cherry-pick commits one by one in order (oldest first)
                let successCount = 0;
                const failedHashes: string[] = [];
                
                for (let i = 0; i < selectedHashes.length; i++) {
                    const hash = selectedHashes[i];
                    try {
                        await gitService.cherryPick(hash);
                        successCount++;
                    } catch (error: any) {
                        const errText = combineErrorText(error);
                        
                        // Check if cherry-pick failed due to conflicts
                        if (isConflictError(errText)) {
                            const remainingHashes = selectedHashes.slice(i + 1);
                            
                            // Save resume state to workspace cache (with 24h TTL to prevent infinite loops)
                            await gitService.saveCherryPickResume(remainingHashes, hash.substring(0, 7), ctx.workspaceState);
                            
                            // Open SCM view and notify user
                            graphView.refresh();
                            try {
                                await vscode.commands.executeCommand('workbench.view.scm');
                            } catch {
                                // Ignore error - SCM view may not be available
                            }
                            
                            // Send message to webview to show resume button on current branch
                            graphView.showCherryPickResume(remainingHashes, hash.substring(0, 7));
                            
                            // Show warning message
                            vscode.window.showWarningMessage(
                                t('cherryPick.conflictBatch', { 
                                    hash: hash.substring(0, 7), 
                                    remaining: remainingHashes.length 
                                })
                            );
                            
                            // Stop the loop - user must resolve in SCM then click resume in webview
                            break;
                        } else {
                            failedHashes.push(hash.substring(0, 7));
                        }
                    }
                }
                
                // Show result
                if (failedHashes.length === 0 && successCount > 0) {
                    // Clear resume state after successful completion
                    await gitService.clearCherryPickResume(ctx.workspaceState);
                    
                    vscode.window.showInformationMessage(
                        selectedHashes.length === 1
                            ? t('cherryPick.success', { hash: selectedHashes[0].substring(0, 7) })
                            : t('cherryPick.successMultiple', { count: successCount })
                    );
                    
                    graphView.refresh();
                } else if (successCount > 0 || failedHashes.length > 0) {
                    // Clear resume state even on partial failure (user may have resolved some manually)
                    await gitService.clearCherryPickResume(ctx.workspaceState);
                    
                    vscode.window.showWarningMessage(
                        t('cherryPick.partialSuccess', { success: successCount, failed: failedHashes.join(', ') })
                    );
                    
                    graphView.refresh();
                }
            });
        }),

        vscode.commands.registerCommand('idea-git.interactiveRebase', async () => {
            // Check for unstaged changes before rebase
            try {
                const hasUnstagedChanges = !(await gitService.isClean());
                if (hasUnstagedChanges) {
                    vscode.window.showErrorMessage(t('common.worktreeDirty'));
                    return;
                }
            } catch (error) {
                logger.debug('[GitCharm] Failed to check working tree status:', error);
            }

            const upstream = await vscode.window.showInputBox({
                prompt: t('rebase.promptBase'),
                placeHolder: 'HEAD~5'
            });

            if (!upstream) {return;}

            try {
                const todos = await gitService.getRebaseTodo(upstream);
                if (todos.length === 0) {
                    vscode.window.showInformationMessage(t('rebase.noCommits'));
                    return;
                }

                const actions: Array<{ hash: string; action: string }> = [];
                for (const todo of todos) {
                    const action = await vscode.window.showQuickPick(
                        ['pick', 'reword', 'squash', 'fixup', 'drop', 'edit'],
                        {
                            placeHolder: t('rebase.actionPlaceHolder', { hash: todo.hash.substring(0, 7), msg: todo.message }),
                            title: t('rebase.title', { hash: todo.hash.substring(0, 7) })
                        }
                    );
                    if (!action) {return;}
                    actions.push({ hash: todo.hash, action });
                }

                const confirm = await graphView.showDialog(
                    t('rebase.interactiveConfirm', { n: todos.length }),
                    [t('rebase.interactiveBtn'), t('common.cancel')],
                    'warn'
                );

                if (confirm === t('rebase.interactiveBtn')) {
                    const result = await gitService.executeRebaseWithActions(upstream, actions);
                    vscode.window.showInformationMessage(result);
                    graphView.refresh();
                }
            } catch (error: any) {
                const currentBranch = await gitService.getCurrentBranch().catch(() => undefined);
                const handled = await tryHandleConflict(
                    error,
                    gitService,
                    graphView,
                    t('rebase.title', { hash: upstream }),
                    () => gitService.rebaseContinue(),
                    () => gitService.rebaseAbort(),
                    currentBranch,
                    upstream,
                    'rebase'
                );
                if (!handled) {
                    vscode.window.showErrorMessage(t('rebase.interactiveFailed', { error: error?.message ?? String(error) }));
                }
            }
        }),

        vscode.commands.registerCommand('idea-git.dropCommit', async (commitNode: any) => {
            // Check if hashes array is provided directly from webview multi-select
            const hashesFromWebview = commitNode?.hashes;
            const singleHash = commitNode?.hash ?? commitNode?.commit?.hash;
            
            let selectedHashes: string[] = [];
            
            if (hashesFromWebview && Array.isArray(hashesFromWebview) && hashesFromWebview.length > 0) {
                // Direct multi-select from webview - need to sort by date (oldest first for consistent rebase order)
                const commitDetails = await Promise.all(
                    hashesFromWebview.map(async (hash: string) => {
                        try {
                            const detail = await gitService.getCommitDetail(hash);
                            return { hash, date: detail.authorDate };
                        } catch {
                            return { hash, date: '' };
                        }
                    })
                );
                commitDetails.sort((a, b) => a.date.localeCompare(b.date));
                selectedHashes = commitDetails.map(c => c.hash);
            } else if (singleHash) {
                // Single commit from context menu
                selectedHashes = [singleHash];
            } else {
                // No commit provided - show picker
                const commits = await gitService.getLog(50);
                if (commits.length === 0) {
                    vscode.window.showErrorMessage(t('common.noCommitSelected'));
                    return;
                }
                
                const items = commits.map(c => ({
                    label: c.message || t('commit.noMessage'),
                    description: c.shortHash,
                    detail: `${c.author} · ${c.relativeDate}`,
                    hash: c.hash
                }));
                
                const selected = await vscode.window.showQuickPick(items, {
                    canPickMany: true,
                    placeHolder: t('commit.dropPickPlaceHolder'),
                    title: t('commit.dropPickTitle')
                });
                
                if (!selected || selected.length === 0) {return;}
                selectedHashes = selected.map(s => s.hash);
            }
            
            // Validate: only allow dropping commits that are reachable from HEAD
            const head = await gitService.getHeadHash();
            const invalidHashes: string[] = [];
            const blockedHashes: Array<{ hash: string; reason: string }> = [];
            const warnedHashes: string[] = []; // Pushed commits - warn but allow
            
            for (const hash of selectedHashes) {
                try {
                    assertHash(hash);
                    
                    // Check if this commit is an ancestor of HEAD
                    const isAncestor = await gitService.executeGitArgs(['merge-base', '--is-ancestor', hash, head]).then(() => true).catch(() => false);
                    if (!isAncestor && hash !== head) {
                        invalidHashes.push(hash.substring(0, 7));
                        continue;
                    }
                    
                    // Check if it's the initial commit
                    const isInitial = await gitService.isInitialCommit(hash);
                    if (isInitial) {
                        blockedHashes.push({ hash: hash.substring(0, 7), reason: t('err.dropInitialCommit') });
                        continue;
                    }
                    
                    // Check if already pushed to remote (warn but don't block)
                    const isPushed = await gitService.isCommitPushed(hash);
                    if (isPushed) {
                        warnedHashes.push(hash.substring(0, 7));
                    }
                } catch {
                    invalidHashes.push(hash.substring(0, 7));
                }
            }
            
            if (invalidHashes.length > 0) {
                vscode.window.showErrorMessage(t('commit.dropNotReachable', { hashes: invalidHashes.join(', ') }));
                return;
            }
            
            if (blockedHashes.length > 0) {
                const reasons = blockedHashes.map(b => `${b.hash}: ${b.reason}`).join('\n');
                vscode.window.showErrorMessage(reasons);
                return;
            }
            
            // For multiple commits, we need to drop them in reverse topological order
            // Get the topological order
            const topoOrder = await gitService.executeGitArgs(['rev-list', '--topo-order', head]);
            const orderedHashes = topoOrder.split('\n').filter(Boolean);
            
            // Filter selected hashes to only those in topo order, then reverse
            const toDrop = orderedHashes.filter(h => selectedHashes.includes(h)).reverse();
            
            if (toDrop.length === 0) {
                vscode.window.showErrorMessage(t('commit.dropNoValid'));
                return;
            }
            
            // Confirm with warning if any commits are pushed
            const hashList = toDrop.map(h => h.substring(0, 7)).join(', ');
            let confirmMessage = toDrop.length === 1 
                ? t('commit.dropConfirm', { hash: toDrop[0].substring(0, 7), subject: '' })
                : t('commit.dropMultipleConfirm', { count: toDrop.length, hashes: hashList });
            
            if (warnedHashes.length > 0) {
                confirmMessage += `\n\n⚠️ ${warnedHashes.length} 个提交已推送到远程：${warnedHashes.join(', ')}\n删除后将导致本地与远程历史不一致，需要强制推送。`;
            }
            
            const confirm = await graphView.showDialog(
                confirmMessage,
                [t('branch.deleteBtn'), t('common.cancel')],
                'warn'
            );
            
            if (confirm !== t('branch.deleteBtn')) {return;}
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('commit.droppingMultiple', { count: toDrop.length }),
                cancellable: false
            }, async () => {
                // toDrop is in chronological order (oldest first)
                const oldestHash = toDrop[0];
                const parents = await gitService.getParents(oldestHash);
                
                if (parents.length === 0) {
                    throw new Error(t('err.dropInitialCommit'));
                }
                
                const baseRef = parents[0];
                
                // Use interactive rebase to drop all selected commits at once
                await gitService.dropCommitsWithRebase(baseRef, toDrop);
                
                const newHead = await gitService.getHeadHash();
                vscode.window.showInformationMessage(
                    toDrop.length === 1
                        ? t('commit.dropped', { hash: toDrop[0].substring(0, 7), head: newHead.substring(0, 7) })
                        : t('commit.droppedMultiple', { count: toDrop.length, head: newHead.substring(0, 7) })
                );
                graphView.refresh();
            });
        }),

        vscode.commands.registerCommand('idea-git.editCommitMessage', async (commitNode: any) => {
            const hash = commitNode?.hash ?? commitNode?.commit?.hash;
            if (!hash) {
                vscode.window.showErrorMessage(t('common.noCommitSelected'));
                return;
            }

            try {
                const head = await gitService.getHeadHash();
                if (hash !== head) {
                    vscode.window.showErrorMessage(t('commit.editOnlyLast'));
                    return;
                }

                const orig = await gitService.getCommitMessage(hash);
                const initialValue = orig.replace(/\n+$/, '');
                const input = await vscode.window.showInputBox({
                    prompt: t('commit.editPrompt'),
                    value: initialValue,
                    ignoreFocusOut: true
                });

                if (input === undefined) {return;}
                if (input.trim() === '' || input === initialValue) {
                    vscode.window.showInformationMessage(t('commit.messageUnchanged'));
                    return;
                }

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('commit.updatingMessage'),
                    cancellable: false
                }, async () => {
                    const result = await gitService.amendMessage(hash, input);
                    vscode.window.showInformationMessage(result);
                    graphView.refresh();
                });
            } catch (error) {
                vscode.window.showErrorMessage(t('commit.editFailed', { error: String(error) }));
            }
        }),

        vscode.commands.registerCommand('idea-git.squashCommits', async (commitNode: any) => {
            // Check if hashes array is provided directly from webview multi-select
            const hashesFromWebview = commitNode?.hashes;
            
            let selectedHashes: string[] = [];
            
            if (hashesFromWebview && Array.isArray(hashesFromWebview) && hashesFromWebview.length > 0) {
                // Direct multi-select from webview - need to sort by date (oldest first for squash order)
                const commitDetails = await Promise.all(
                    hashesFromWebview.map(async (hash: string) => {
                        try {
                            const detail = await gitService.getCommitDetail(hash);
                            return { hash, date: detail.authorDate };
                        } catch {
                            return { hash, date: '' };
                        }
                    })
                );
                commitDetails.sort((a, b) => a.date.localeCompare(b.date));
                selectedHashes = commitDetails.map(c => c.hash);
            } else {
                // No commit provided - show picker (legacy mode)
                const upstream = await vscode.window.showInputBox({
                    prompt: t('commit.squashPromptBase'),
                    placeHolder: t('commit.squashBasePlaceHolder')
                });

                if (!upstream) {return;}

                try {
                    const todos = await gitService.getRebaseTodo(upstream);
                    if (todos.length < 2) {
                        vscode.window.showErrorMessage(t('err.squashNeedTwo'));
                        return;
                    }

                    const selectedItems = await vscode.window.showQuickPick(
                        todos.map(t => ({
                            label: t.hash.substring(0, 7),
                            description: t.message,
                            picked: true,
                            hash: t.hash
                        })),
                        {
                            canPickMany: true,
                            placeHolder: t('commit.squashPickPlaceHolder'),
                            title: t('commit.squashPickTitle')
                        }
                    );

                    if (!selectedItems || selectedItems.length < 2) {
                        vscode.window.showErrorMessage(t('err.squashNeedTwo'));
                        return;
                    }

                    selectedHashes = selectedItems.map(item => item.hash);
                } catch (error) {
                    vscode.window.showErrorMessage(t('commit.squashFailed', { error: String(error) }));
                    return;
                }
            }
            
            // Validate: need at least 2 commits
            if (selectedHashes.length < 2) {
                vscode.window.showErrorMessage(t('err.squashNeedTwo'));
                return;
            }
            
            // Validate: check for merge commits
            const blockedHashes: Array<{ hash: string; reason: string }> = [];
            
            for (const hash of selectedHashes) {
                assertHash(hash);
                
                try {
                    const isMerge = await gitService.isMergeCommit(hash);
                    if (isMerge) {
                        blockedHashes.push({ hash: hash.substring(0, 7), reason: t('err.squashContainsMerge') });
                    }
                } catch {
                    // If we can't determine, skip validation for this commit
                }
            }
            
            if (blockedHashes.length > 0) {
                const reasons = blockedHashes.map(b => `${b.hash}: ${b.reason}`).join('\n');
                vscode.window.showErrorMessage(reasons);
                return;
            }
            
            // Get commit messages for the squash input box
            const commitDetails = await Promise.all(
                selectedHashes.map(hash => gitService.getCommitDetail(hash))
            );
            
            // Sort by date (oldest first) to show in chronological order
            commitDetails.sort((a, b) => new Date(a.authorDate).getTime() - new Date(b.authorDate).getTime());
            
            // Validate: check if selected commits are contiguous in history
            const oldestCommit = commitDetails[0];
            const parents = await gitService.getParents(oldestCommit.hash);
            const baseRef = parents[0] || `${oldestCommit.hash}~1`;
            
            try {
                const todos = await gitService.getRebaseTodo(baseRef);
                const selectedSet = new Set(selectedHashes);
                
                // Find positions of selected commits in todo list
                const positions: number[] = [];
                for (let i = 0; i < todos.length; i++) {
                    if (selectedSet.has(todos[i].hash)) {
                        positions.push(i);
                    }
                }
                
                // Check if positions are contiguous (no gaps)
                positions.sort((a, b) => a - b);
                for (let i = 1; i < positions.length; i++) {
                    if (positions[i] !== positions[i - 1] + 1) {
                        // Found a gap - there are unselected commits between selected ones
                        vscode.window.showErrorMessage(t('err.squashNotContiguous'));
                        return;
                    }
                }
            } catch {
                // If we can't get rebase todo, skip this validation
            }
            
            // Build combined message with all commit messages separated by newlines
            const combinedMessage = commitDetails.map(c => c.message).join('\n\n');
            
            // Show custom multi-line dialog for editing combined message
            const finalMessage = await graphView.showSquashMessageDialog(
                t('commit.squashMessagePrompt', { count: selectedHashes.length }),
                combinedMessage,
                t('commit.squashMessagePlaceHolder')
            );
            
            if (finalMessage === undefined || finalMessage.trim() === '') {return;}
            
            // Execute squash using interactive rebase
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('commit.squashing', { n: selectedHashes.length }),
                    cancellable: false
                }, async () => {
                    // Find the oldest commit among selected ones to use as rebase base
                    const oldestCommit = commitDetails[0];
                    
                    // Use the parent of the oldest commit as the rebase base
                    const parents = await gitService.getParents(oldestCommit.hash);
                    const baseRef = parents[0] || `${oldestCommit.hash}~1`;
                    
                    // Use interactive rebase with squash and custom message
                    await gitService.squashCommits(baseRef, selectedHashes, finalMessage);
                    vscode.window.showInformationMessage(t('commit.squashSuccess', { n: selectedHashes.length }));
                    graphView.refresh();
                });
            } catch (error) {
                vscode.window.showErrorMessage(t('commit.squashFailed', { error: String(error) }));
            }
        }),

        vscode.commands.registerCommand('idea-git.resetToCommit', async (commitNode: any) => {
            const hash = commitNode?.hash ?? commitNode?.commit?.hash;
            if (!hash) {
                vscode.window.showErrorMessage(t('common.noCommitSelected'));
                return;
            }

            const resetModes: Array<{ label: string; value: 'soft' | 'mixed' | 'hard' }> = [
                { label: t('commit.resetModeSoft'), value: 'soft' },
                { label: t('commit.resetModeMixed'), value: 'mixed' },
                { label: t('commit.resetModeHard'), value: 'hard' }
            ];
            const mode = await vscode.window.showQuickPick(resetModes, { placeHolder: t('commit.resetModePlaceHolder') });

            if (!mode) {return;}

            const confirm = await vscode.window.showWarningMessage(
                t('commit.resetConfirm', { hash: hash.substring(0, 7), mode: mode.label.split(' - ')[0] }),
                { modal: true },
                t('commit.resetBtn')
            );

            if (confirm === t('commit.resetBtn')) {
                try {
                    await gitService.resetToCommit(hash, mode.value);
                    vscode.window.showInformationMessage(t('commit.resetSuccess', { hash: hash.substring(0, 7) }));
                    graphView.refresh();
                } catch (error) {
                    vscode.window.showErrorMessage(t('commit.resetFailed', { error: String(error) }));
                }
            }
        })
    );
}
