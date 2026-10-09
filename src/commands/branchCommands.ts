import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { parseLogLine } from '../services/gitUtils';
import { logger } from '../services/logger';
import { GraphViewProvider } from '../views/graphView';
import {
    getBranchesFromVscodeGit,
    getBranchName,
    combineErrorText,
    tryHandleConflict,
    handleConflictLoop,
    extractWorktreePath
} from './helpers';
import { t } from '../i18n';

/** Branch lifecycle + remote sync commands (create/checkout/rename/delete/merge/rebase/push/pull/fetch/...). */
export function registerBranchCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService,
    graphView: GraphViewProvider
): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.createBranch', async () => {
            const branchName = await vscode.window.showInputBox({
                prompt: t('branch.promptNewName'),
                placeHolder: 'feature/my-branch'
            });
            if (branchName) {
                // Optimistic update: add to UI first
                graphView.addBranchOptimistically(branchName, true);

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('branch.creating', { name: branchName }),
                    cancellable: false
                }, async () => {
                    try {
                        await gitService.checkout(branchName, true);
                        vscode.window.showInformationMessage(t('branch.created', { name: branchName }));
                        // Refresh to get accurate state from git
                        graphView.refresh();
                    } catch (error) {
                        // Rollback on failure
                        graphView.removeBranchOptimistically(branchName);
                        vscode.window.showErrorMessage(t('branch.createFailed', { error: String(error) }));
                    }
                });
            }
        }),

        vscode.commands.registerCommand('idea-git.checkoutBranch', async (branchNode: any) => {
            const branchName = getBranchName(branchNode);
            if (!branchName) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('branch.switching', { name: branchName }),
                cancellable: false
            }, async () => {
                try {
                    // Check for in-progress rebase/merge before switching branches
                    const inProgress = await gitService.getInProgressOperation();
                    if (inProgress) {
                        const opLabel = t(inProgress === 'rebase' ? 'op.rebase' : 'op.merge');
                        const conflictCount = (await gitService.getConflictFiles()).length;
                        const choice = await graphView.showDialog(
                            t('checkout.opInProgress', { op: opLabel, count: conflictCount }),
                            [t('checkout.resolveBtn'), t('common.cancel')],
                            'warn'
                        );
                        if (choice !== t('checkout.resolveBtn')) {return;}

                        // Open SCM view and show the conflict dialog
                        await vscode.commands.executeCommand('workbench.view.scm');
                        const currentBranch = await gitService.getCurrentBranch().catch(() => undefined);
                        if (inProgress === 'rebase') {
                            await handleConflictLoop(
                                gitService, graphView, t('op.rebase'),
                                () => gitService.rebaseContinue(),
                                () => gitService.rebaseAbort(),
                                currentBranch, undefined, 'rebase'
                            );
                        } else {
                            await handleConflictLoop(
                                gitService, graphView, t('op.merge'),
                                () => gitService.mergeContinue(),
                                () => gitService.mergeAbort(),
                                currentBranch, undefined, 'merge'
                            );
                        }
                        // After resolving, try checkout again
                        return;
                    }

                    let actualBranch = branchName;
                    if (branchName.startsWith('origin/')) {
                        const localName = branchName.replace(/^origin\//, '');
                        const localBranches = await gitService.getLocalBranches();
                        if (localBranches.includes(localName)) {
                            // Local branch already exists: switch to it.
                            await gitService.checkout(localName);
                        } else {
                            // Create a local tracking branch from the remote ref.
                            await gitService.checkoutTracking(branchName);
                        }
                        actualBranch = localName;
                    } else {
                        await gitService.checkout(branchName);
                    }
                    gitService.selectedBranch = actualBranch;

                    // Instant visual feedback: update current branch highlight immediately
                    graphView.updateCurrentBranch(actualBranch);

                    vscode.window.showInformationMessage(t('branch.switched', { name: actualBranch }));

                    // Async full refresh in background (fetches new commits, ahead/behind, etc.)
                    graphView.refresh();
                } catch (error: any) {
                    const errMsg = error?.message ?? String(error);
                    vscode.window.showErrorMessage(t('branch.switchFailed', { error: errMsg }));
                }
            });
        }),

        vscode.commands.registerCommand('idea-git.deleteBranch', async (branchNode: any) => {
            const branchName = getBranchName(branchNode);
            if (!branchName) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }

            const confirm = await graphView.showDialog(
                t('branch.deleteConfirm', { name: branchName }),
                [t('branch.deleteBtn'), t('common.cancel')],
                'warn'
            );

            if (confirm === t('branch.deleteBtn')) {
                // Optimistic update: remove from UI first
                graphView.removeBranchOptimistically(branchName);

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('branch.deleting', { name: branchName }),
                    cancellable: false
                }, async () => {
                    try {
                        await gitService.deleteLocalBranch(branchName, true);

                        // Invalidate caches after successful delete
                        gitService.invalidateVolatile();

                        // Pause branch check to prevent periodic detection from interfering
                        graphView.pauseBranchCheck(5000);

                        vscode.window.showInformationMessage(t('branch.deleted', { name: branchName }));
                        // Don't refresh - optimistic update is sufficient and avoids vscode.git state delay issues
                    } catch (error: any) {
                        // Rollback on failure
                        graphView.addBranchOptimistically(branchName, false);
                        const errMsg = error?.message ?? String(error);
                        const worktreePath = extractWorktreePath(errMsg);
                        if (worktreePath) {
                            const choice = await graphView.showDialog(
                                t('branch.worktreeInUse', { name: branchName, path: worktreePath }),
                                [t('branch.openWorktree'), t('common.cancel')],
                                'warn'
                            );
                            if (choice === t('branch.openWorktree')) {
                                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), true);
                            }
                        } else {
                            vscode.window.showErrorMessage(t('branch.deleteFailed', { error: errMsg }));
                        }
                    }
                });
            }
        }),

        vscode.commands.registerCommand('idea-git.renameBranch', async (branchNode: any) => {
            const oldName = getBranchName(branchNode);
            if (!oldName) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }

            const newName = await vscode.window.showInputBox({
                prompt: t('branch.promptNewName'),
                placeHolder: oldName,
                value: oldName
            });

            if (newName && newName !== oldName) {
                // Optimistic update: rename in UI immediately
                graphView.renameBranchOptimistically(oldName, newName);

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('branch.renaming', { old: oldName, new: newName }),
                    cancellable: false
                }, async () => {
                    try {
                        await gitService.renameBranch(oldName, newName);

                        // Invalidate caches after successful rename
                        gitService.invalidateVolatile();

                        // Pause branch checking for 5 seconds to let vscode.git update its state
                        // This prevents the periodic check from overwriting the optimistic update with stale data
                        graphView.pauseBranchCheck(5000);

                        vscode.window.showInformationMessage(t('branch.renamed', { old: oldName, new: newName }));
                        // Reconcile the tree from authoritative git refs (filesystem/for-each-ref),
                        // so the new name persists even if a stale in-flight branch list arrives.
                        graphView.refreshBranchesOnly();
                    } catch (error) {
                        // Rollback on failure
                        graphView.renameBranchOptimistically(newName, oldName);
                        vscode.window.showErrorMessage(t('branch.renameFailed', { error: String(error) }));
                    }
                });
            }
        }),

        vscode.commands.registerCommand('idea-git.mergeBranch', async (branchNode: any) => {
            const branchName = getBranchName(branchNode);
            if (!branchName) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }

            const confirm = await graphView.showDialog(
                t('merge.confirm', { name: branchName }),
                [t('merge.confirmBtn'), t('common.cancel')],
                'warn'
            );

            if (confirm === t('merge.confirmBtn')) {
                // Progress auto-stops when the git call settles: success, or
                // conflict (git exits non-zero and the op stays suspended).
                const outcome = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('merge.merging', { name: branchName }),
                    cancellable: false
                }, async () => {
                    try {
                        await gitService.mergeBranch(branchName);
                        return { ok: true as const };
                    } catch (error) {
                        return { ok: false as const, error };
                    }
                });
                if (outcome.ok) {
                    vscode.window.showInformationMessage(t('merge.success', { name: branchName }));
                    graphView.refresh();
                } else {
                    const error: any = outcome.error;
                    const currentBranch = await gitService.getCurrentBranch().catch(() => undefined);
                    const handled = await tryHandleConflict(
                        error,
                        gitService,
                        graphView,
                        t('merge.conflictTitle', { name: branchName }),
                        () => gitService.mergeContinue(),
                        () => gitService.mergeAbort(),
                        currentBranch,
                        branchName,
                        'merge'
                    );
                    if (!handled) {
                        vscode.window.showErrorMessage(t('merge.failed', { error: error?.message ?? String(error) }));
                    }
                }
            }
        }),

        vscode.commands.registerCommand('idea-git.rebaseOnto', async (branchNode: any) => {
            const branchName = getBranchName(branchNode);
            if (!branchName) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }

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

            const confirm = await graphView.showDialog(
                t('rebase.confirm', { name: branchName }),
                [t('rebase.confirmBtn'), t('common.cancel')],
                'warn'
            );

            if (confirm === t('rebase.confirmBtn')) {
                // Progress auto-stops when the git call settles: success, or
                // conflict (rebase pauses at the conflicting commit).
                const outcome = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('rebase.rebasing', { name: branchName }),
                    cancellable: false
                }, async () => {
                    try {
                        await gitService.rebaseOnto(branchName);
                        return { ok: true as const };
                    } catch (error) {
                        return { ok: false as const, error };
                    }
                });
                if (outcome.ok) {
                    vscode.window.showInformationMessage(t('rebase.success', { name: branchName }));
                    graphView.refresh();
                } else {
                    const error: any = outcome.error;
                    const currentBranch = await gitService.getCurrentBranch().catch(() => undefined);
                    const handled = await tryHandleConflict(
                        error,
                        gitService,
                        graphView,
                        t('rebase.conflictTitle', { name: branchName }),
                        () => gitService.rebaseContinue(),
                        () => gitService.rebaseAbort(),
                        currentBranch,
                        branchName,
                        'rebase'
                    );
                    if (!handled) {
                        vscode.window.showErrorMessage(t('rebase.failed', { error: error?.message ?? String(error) }));
                    }
                }
            }
        }),

        vscode.commands.registerCommand('idea-git.pushBranch', async (branchNode: any) => {
            const branchName = getBranchName(branchNode);
            if (!branchName) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }

            try {
                // Try to get branch data from VSCode's built-in Git extension first (fastest)
                const repoPath = gitService.repositoryPath;
                let remoteExists: boolean;

                if (repoPath) {
                    const vscodeBranches = await getBranchesFromVscodeGit(repoPath);
                    if (vscodeBranches) {
                        // Got branches from vscode.git - use them!
                        // Note: vscodeBranches.remote already contains full names like "origin/main"
                        const searchName = branchName.startsWith('origin/') ? branchName : `origin/${branchName}`;
                        remoteExists = vscodeBranches.remote.includes(searchName);
                        logger.debug(`[GitCharm] Using vscode.git cache for push check. Looking for: ${searchName}, Found: ${remoteExists}`);
                        logger.debug(`[GitCharm] Remote branches: ${vscodeBranches.remote.join(', ')}`);
                    } else {
                        // Fallback to our own cache
                        const branchDetails = await gitService.getBranchesWithDetails(false);
                        const remoteNames = branchDetails.remote.map(b => b.name);
                        const searchName = branchName.startsWith('origin/') ? branchName : `origin/${branchName}`;
                        remoteExists = remoteNames.includes(searchName);
                        logger.debug(`[GitCharm] Using internal cache for push check. Looking for: ${searchName}, Found: ${remoteExists}`);
                    }
                } else {
                    // No repo path, use internal cache
                    const branchDetails = await gitService.getBranchesWithDetails(false);
                    const remoteNames = branchDetails.remote.map(b => b.name);
                    const searchName = branchName.startsWith('origin/') ? branchName : `origin/${branchName}`;
                    remoteExists = remoteNames.includes(searchName);
                }

                // For existing branches, get commits for display
                // For new branches, skip commit fetching (show empty list)
                let commits: Array<{ hash: string; shortHash: string; message: string; author: string; date: string }> = [];
                let hasUpstream = false;
                let aheadCount = 0;
                let baseRef: string | undefined; // ref the "全部提交" aggregate diff compares against
                const isFirstPush = !remoteExists; // First push if remote branch doesn't exist

                if (remoteExists) {
                    baseRef = `origin/${branchName}`;
                    // Get branch details from cache (same data source as divergence arrows)
                    const branchDetails = await gitService.getBranchesWithDetails(false);
                    const localBranch = branchDetails.local.find(b => b.name === branchName);

                    if (localBranch) {
                        aheadCount = localBranch.ahead || 0;
                        baseRef = localBranch.upstream || baseRef;

                        if (localBranch.upstream) {
                            // Has upstream - use the same method as divergence arrows
                            hasUpstream = true;
                            if (aheadCount > 0) {
                                const aheadCommits = await gitService.getAheadCommits(branchName, localBranch.upstream);
                                commits = aheadCommits.map(c => ({
                                    hash: c.hash, shortHash: c.shortHash, message: c.message, author: c.author, date: c.date
                                }));
                            }
                        } else {
                            // No upstream configured, but remote branch exists - compare directly
                            const remoteRef = `origin/${branchName}`;
                            const output = (await gitService.executeGitArgs([
                                'log', `${remoteRef}..${branchName}`, '--format=%H|%h|%an|%ae|%ai|%ar|%s|%P'
                            ])).trim();
                            if (output) {
                                for (const line of output.split('\n')) {
                                    if (!line.trim()) {continue;}
                                    const commit = parseLogLine(line);
                                    if (commit) {
                                        commits.push({
                                            hash: commit.hash,
                                            shortHash: commit.shortHash,
                                            message: commit.message,
                                            author: commit.author,
                                            date: commit.date
                                        });
                                    }
                                }
                            }
                        }
                    }

                    // Only show "up to date" message if we have upstream AND no ahead commits AND no behind commits
                    const behindCount = localBranch?.behind || 0;
                    if (hasUpstream && aheadCount === 0 && behindCount === 0) {
                        vscode.window.showInformationMessage(t('push.upToDate', { name: branchName }));
                        return;
                    }
                    // If behind remote, still show dialog with force-push option
                    if (behindCount > 0 && aheadCount === 0) {
                        logger.debug(`[GitCharm] Branch ${branchName} is behind remote by ${behindCount} commits; showing push dialog with force option`);
                    }
                }
                // For new branches or branches without upstream, commits array may be empty but we still show the dialog

                // Show dialog with state information
                const result = await graphView.showPushDialog(branchName, commits, remoteExists, isFirstPush, baseRef);

                if (!result || result.action === 'cancel') {return;}

                await gitService.push('origin', branchName, result.force === true);
                vscode.window.showInformationMessage(t(result.force ? 'push.forceSuccess' : 'push.success', { name: branchName }));

                // Invalidate cache after push to ensure fresh divergence data
                gitService.invalidateVolatile();

                // Get current branch to decide refresh strategy
                const currentBranch = await gitService.getCurrentBranch();
                if (branchName === currentBranch) {
                    // Full refresh including commits for current branch
                    graphView.refresh(true);
                } else {
                    // Just refresh branches tree and divergence arrows
                    graphView.refreshBranchesOnly();
                }
            } catch (error) {
                const errMsg = String(error);
                // Parse common git push errors into user-friendly messages
                let friendlyMsg: string;
                if (errMsg.includes('non-fast-forward') || errMsg.includes('[rejected]')) {
                    friendlyMsg = t('push.rejectedNonFastForward', { name: branchName });
                } else if (errMsg.includes('remote contains work that you do not have locally')) {
                    friendlyMsg = t('push.remoteAhead', { name: branchName });
                } else if (errMsg.includes('permission denied') || errMsg.includes('403')) {
                    friendlyMsg = t('push.permissionDenied');
                } else if (errMsg.includes('authentication failed') || errMsg.includes('401')) {
                    friendlyMsg = t('push.authFailed');
                } else {
                    // Fallback: show first line of error only
                    const firstLine = errMsg.split('\n')[0].trim();
                    friendlyMsg = t('push.failed', { error: firstLine });
                }
                vscode.window.showErrorMessage(friendlyMsg);
            }
        }),

        vscode.commands.registerCommand('idea-git.pullBranch', async (branchNode: any) => {
            const branchName = getBranchName(branchNode);
            if (!branchName) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }

            try {
                // Get current branch before pulling
                const currentBranch = await gitService.getCurrentBranch();

                // Read pull strategy from configuration
                const config = vscode.workspace.getConfiguration('idea-git');
                const pullStrategy = config.get<string>('pullStrategy', 'merge');

                logger.debug('[GitCharm] Pull strategy from config:', pullStrategy);

                // Execute pull based on strategy
                const useRebase = pullStrategy === 'rebase';
                logger.debug('[GitCharm] Executing pull with useRebase:', useRebase, 'branch:', branchName);
                await gitService.pull('origin', branchName, useRebase);

                const strategyLabel = t(pullStrategy === 'rebase' ? 'pull.strategyRebase' : 'pull.strategyMerge');
                vscode.window.showInformationMessage(t('pull.success', { strategy: strategyLabel, name: branchName }));

                // Invalidate cache after pull to ensure fresh divergence data
                gitService.invalidateVolatile();

                // Smart refresh: if pulled branch is current branch, full refresh; otherwise just refresh branches
                if (branchName === currentBranch) {
                    // Full refresh including commits for current branch
                    graphView.refresh(true);
                } else {
                    // Just refresh branches tree and divergence arrows
                    graphView.refreshBranchesOnly();
                }
            } catch (error: any) {
                // Check for pull-specific conflict errors first
                const errorText = combineErrorText(error);
                const lowerError = errorText.toLowerCase();
                const isPullConflict = lowerError.includes('pulling is not possible') ||
                                       lowerError.includes('unmerged files') ||
                                       lowerError.includes('you have unmerged files') ||
                                       lowerError.includes('could not apply') ||
                                       lowerError.includes('automatic merge failed');

                if (isPullConflict) {
                    // Simple conflict notification without technical details
                    vscode.window.showWarningMessage(t('pull.conflict', { name: branchName }));

                    // Refresh webview to show operation status bar immediately
                    graphView.refresh();

                    // Open SCM view for conflict resolution
                    try {
                        await vscode.commands.executeCommand('workbench.view.scm');
                    } catch {
                        // Ignore if SCM view cannot be opened
                    }
                    return;
                }

                // Try to handle other types of conflicts using unified handler
                const currentBranch = await gitService.getCurrentBranch().catch(() => undefined);
                const handled = await tryHandleConflict(
                    error,
                    gitService,
                    graphView,
                    t('pull.conflictTitle', { name: branchName }),
                    () => Promise.resolve(''), // Pull doesn't have a continue operation like merge --continue
                    () => gitService.executeGitArgs(['reset', '--merge']).then(() => ''), // Abort by resetting merge state
                    currentBranch,
                    branchName
                );

                if (!handled) {
                    vscode.window.showErrorMessage(t('pull.failed', { error: String(error) }));
                }
            }
        }),

        vscode.commands.registerCommand('idea-git.fetch', async () => {
            try {
                await gitService.fetch();
                vscode.window.showInformationMessage(t('fetch.success'));
                graphView.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(t('fetch.failed', { error: String(error) }));
            }
        }),

        vscode.commands.registerCommand('idea-git.compareBranch', async (branchNode: any) => {
            const branchName = getBranchName(branchNode);
            if (!branchName) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }

            try {
                const currentBranch = await gitService.getCurrentBranch();
                if (branchName === currentBranch) {
                    vscode.window.showInformationMessage(t('branch.isCurrent', { name: branchName }));
                    return;
                }
                const [commits, diffFiles] = await Promise.all([
                    gitService.compareBranches(branchName),
                    gitService.getDiffFilesBetweenRefs(currentBranch, branchName)
                ]);
                if (commits.length === 0 && diffFiles.length === 0) {
                    vscode.window.showInformationMessage(t('branch.noDiffWithCurrent', { name: branchName }));
                    return;
                }
                graphView.showCompareDialog(
                    branchName,
                    currentBranch,
                    commits.map(c => ({ hash: c.hash, shortHash: c.shortHash, message: c.message, author: c.author, date: c.date }))
                );
            } catch (error) {
                vscode.window.showErrorMessage(t('branch.compareFailed', { error: String(error) }));
            }
        }),

        vscode.commands.registerCommand('idea-git.updateBranch', async (branchNode: any) => {
            const branchName = getBranchName(branchNode);
            if (!branchName) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }

            try {
                const result = await gitService.updateBranch(branchName);
                const first = (result || '').split('\n')[0];
                vscode.window.showInformationMessage(t('branch.updated', { name: branchName, detail: first ? `: ${first}` : '' }));
                graphView.refresh();
            } catch (error: any) {
                // Check for pull-specific conflict errors first
                const errorText = combineErrorText(error);
                const lowerError = errorText.toLowerCase();
                const isPullConflict = lowerError.includes('pulling is not possible') ||
                                       lowerError.includes('unmerged files') ||
                                       lowerError.includes('you have unmerged files') ||
                                       lowerError.includes('could not apply') ||
                                       lowerError.includes('automatic merge failed');

                if (isPullConflict) {
                    // Simple conflict notification without technical details
                    vscode.window.showWarningMessage(t('pull.conflict', { name: branchName }));

                    // Refresh webview to show operation status bar immediately
                    graphView.refresh();

                    // Open SCM view for conflict resolution
                    try {
                        await vscode.commands.executeCommand('workbench.view.scm');
                    } catch {
                        // Ignore if SCM view cannot be opened
                    }
                    return;
                }

                // Try to handle other types of conflicts using unified handler
                const currentBranch = await gitService.getCurrentBranch().catch(() => undefined);
                const handled = await tryHandleConflict(
                    error,
                    gitService,
                    graphView,
                    t('branch.updateConflictTitle', { name: branchName }),
                    () => Promise.resolve(''), // Pull doesn't have a continue operation like merge --continue
                    () => gitService.executeGitArgs(['reset', '--merge']).then(() => ''), // Abort by resetting merge state
                    currentBranch,
                    branchName
                );

                if (!handled) {
                    vscode.window.showErrorMessage(t('branch.updateFailed', { error: String(error) }));
                }
            }
        }),

        vscode.commands.registerCommand('idea-git.commitBranch', async (branchNode: any) => {
            const branchName = getBranchName(branchNode);
            if (!branchName) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }
            const message = await vscode.window.showInputBox({
                prompt: branchName ? t('commit.promptToBranch', { name: branchName }) : t('commit.promptMessage'),
                placeHolder: t('commit.messagePlaceHolder')
            });
            if (!message) {return;}

            const confirm = await vscode.window.showWarningMessage(
                t('commit.confirmMessage', { message }),
                { modal: true },
                t('commit.confirmBtn')
            );
            if (confirm !== t('commit.confirmBtn')) {return;}

            try {
                const out = await gitService.commit(message);
                const first = (out || '').split('\n')[0];
                vscode.window.showInformationMessage(t('commit.success', { detail: first ? `: ${first}` : '' }));
                graphView.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(t('commit.failed', { error: String(error) }));
            }
        }),

        vscode.commands.registerCommand('idea-git.newBranchFrom', async (node: any) => {
            const startPoint = node?.name ?? node?.label ?? node?.hash;
            if (!startPoint) {return;}

            const defaultName = startPoint.replace(/^origin\//, '');

            const branchName = await vscode.window.showInputBox({
                prompt: t('branch.promptFrom', { start: startPoint }),
                placeHolder: 'feature/new-branch',
                value: defaultName
            });
            if (!branchName) {return;}

            try {
                const [localBranches, remoteBranches] = await Promise.all([
                    gitService.getLocalBranches(),
                    gitService.getRemoteBranches()
                ]);
                if (localBranches.includes(branchName) || remoteBranches.includes(`origin/${branchName}`)) {
                    vscode.window.showErrorMessage(t('branch.alreadyExists', { name: branchName }));
                    return;
                }

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('branch.creatingFrom', { start: startPoint, name: branchName }),
                    cancellable: false
                }, async () => {
                    await gitService.createBranch(branchName, startPoint);
                    await gitService.checkout(branchName);

                    // Invalidate all caches after branch switch
                    gitService.invalidateVolatile();

                    vscode.window.showInformationMessage(t('branch.created', { name: branchName }));

                    // Refresh with force reload to ensure current branch is updated
                    graphView.refresh(true);
                });
            } catch (error) {
                vscode.window.showErrorMessage(t('branch.createFailed', { error: String(error) }));
            }
        })
    );
}
