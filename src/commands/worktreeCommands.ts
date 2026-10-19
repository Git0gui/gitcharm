import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService, WorktreeEntry } from '../services/gitService';
import { repositoryKey, formatGitError } from '../services/gitUtils';
import { GraphViewProvider } from '../views/graphView';
import { getBranchName, combineErrorText, extractWorktreePath } from './helpers';
import { t } from '../i18n';

/**
 * Worktree lifecycle: create one from a local branch, open one in a new window,
 * remove one. Listing and the current-worktree mark live in GitService; the
 * panel's tree only calls these commands.
 */
export function registerWorktreeCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService,
    graphView: GraphViewProvider
): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.createWorktree', async (branchNode: any) => {
            const branch = getBranchName(branchNode);
            if (!branch) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }

            const repoPath = gitService.repositoryPath;
            if (!repoPath) {
                vscode.window.showErrorMessage(t('worktree.noRepository'));
                return;
            }
            const currentBranch = await gitService.getCurrentBranch().catch(() => undefined);
            if (currentBranch === branch) {
                vscode.window.showErrorMessage(t('worktree.currentBranch', { branch }));
                return;
            }

            // Sibling of the repository, branch slashes flattened: `feat/x` in
            // `~/code/gitcharm` suggests `~/code/gitcharm-feat-x`.
            const suggested = path.join(
                path.dirname(repoPath),
                `${path.basename(repoPath)}-${branch.replace(/\//g, '-')}`
            );
            const picked = await vscode.window.showInputBox({
                prompt: t('worktree.promptPath', { branch }),
                value: suggested
            });
            if (!picked || !picked.trim()) {return;}

            const raw = picked.trim();
            // A relative answer is read against the repository's parent: resolving
            // it against the extension host's cwd would put it somewhere unrelated.
            const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(path.dirname(repoPath), raw);
            if (fs.existsSync(target)) {
                vscode.window.showErrorMessage(t('worktree.pathExists', { path: target }));
                return;
            }

            let created = false;
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('worktree.creating', { path: target }),
                cancellable: false
            }, async () => {
                try {
                    await gitService.addWorktree(target, branch);
                    created = true;
                } catch (error) {
                    const usedPath = extractWorktreePath(combineErrorText(error));
                    if (!usedPath) {
                        vscode.window.showErrorMessage(t('worktree.createFailed', { error: formatGitError(error) }));
                        return;
                    }
                    // The branch is already checked out somewhere: opening that
                    // worktree is what the user wanted, not a second copy of it.
                    const openLabel = t('branch.openWorktree');
                    const choice = await graphView.showDialog(
                        t('worktree.alreadyUsed', { branch, path: usedPath }),
                        [openLabel, t('common.cancel')],
                        'warn'
                    );
                    if (choice === openLabel) {
                        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(usedPath), true);
                    }
                }
            });

            if (!created) {return;}
            graphView.refreshWorktrees();
            const openLabel = t('worktree.open');
            const choice = await vscode.window.showInformationMessage(
                t('worktree.created', { path: target }),
                openLabel
            );
            if (choice === openLabel) {
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), true);
            }
        }),

        vscode.commands.registerCommand('idea-git.openWorktree', async (node: any) => {
            const target = typeof node === 'string' ? node : node?.path;
            if (!target) {
                vscode.window.showInformationMessage(t('worktree.pickFromTree'));
                return;
            }
            if (!fs.existsSync(target)) {
                vscode.window.showErrorMessage(t('worktree.pathMissing', { path: target }));
                // The row outlived its folder; let the tree drop it right away.
                graphView.refreshWorktrees();
                return;
            }
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), true);
        }),

        vscode.commands.registerCommand('idea-git.removeWorktree', async (node: any) => {
            const target = typeof node === 'string' ? node : node?.path;
            if (!target) {
                vscode.window.showInformationMessage(t('worktree.pickFromTree'));
                return;
            }

            let entry: WorktreeEntry | undefined;
            try {
                entry = (await gitService.getWorktrees())
                    .find(item => repositoryKey(item.path) === repositoryKey(target));
            } catch (error) {
                vscode.window.showErrorMessage(t('worktree.loadFailed', { error: formatGitError(error) }));
                return;
            }
            if (!entry) {
                vscode.window.showErrorMessage(t('worktree.notRegistered', { path: target }));
                graphView.refreshWorktrees();
                return;
            }
            if (entry.isCurrent) {
                vscode.window.showErrorMessage(t('worktree.removeCurrent'));
                return;
            }
            if (entry.main) {
                vscode.window.showErrorMessage(t('worktree.removeMain'));
                return;
            }

            const name = path.basename(entry.path);
            const removeLabel = t('worktree.removeBtn');
            const confirm = await graphView.showDialog(
                t('worktree.removeConfirm', { name }),
                [removeLabel, t('common.cancel')],
                'warn'
            );
            if (confirm !== removeLabel) {return;}

            let removed = false;
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('worktree.removing', { path: entry.path }),
                cancellable: false
            }, async () => {
                try {
                    await gitService.removeWorktree(entry.path);
                    removed = true;
                    return;
                } catch (error) {
                    // Git only refuses over local changes; anything else (locked,
                    // in use) is reported as-is. Deleting uncommitted work needs
                    // its own confirmation.
                    if (!/contains modified or untracked files|use --force to delete/i.test(combineErrorText(error))) {
                        vscode.window.showErrorMessage(t('worktree.removeFailed', { error: formatGitError(error) }));
                        return;
                    }
                    const forceLabel = t('worktree.forceRemoveBtn');
                    const choice = await graphView.showDialog(
                        t('worktree.removeDirty', { name }),
                        [forceLabel, t('common.cancel')],
                        'warn'
                    );
                    if (choice !== forceLabel) {return;}
                    try {
                        await gitService.removeWorktree(entry.path, true);
                        removed = true;
                    } catch (forceError) {
                        vscode.window.showErrorMessage(t('worktree.removeFailed', { error: formatGitError(forceError) }));
                    }
                }
            });

            if (!removed) {return;}
            graphView.refreshWorktrees();
            vscode.window.showInformationMessage(t('worktree.removed', { path: entry.path }));
        })
    );
}
