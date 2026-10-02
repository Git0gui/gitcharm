import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { logger } from '../services/logger';
import { GraphViewProvider } from '../views/graphView';
import { t } from '../i18n';

/**
 * Get VSCode's built-in Git extension API for accessing cached branch data.
 * Returns undefined if the Git extension is not available or not activated.
 */
export async function getVscodeGitApi(): Promise<any> {
    try {
        const gitExt = vscode.extensions.getExtension('vscode.git');
        if (!gitExt) {
            logger.debug('[GitCharm] vscode.git extension not found');
            return undefined;
        }

        // Activate the extension if not already activated
        if (!gitExt.isActive) {
            await gitExt.activate();
        }

        // Get the exported API
        const api = gitExt.exports.getAPI(1);
        return api;
    } catch (error) {
        logger.debug('[GitCharm] Failed to get vscode.git API:', error);
        return undefined;
    }
}

/**
 * Get branch list from VSCode's built-in Git extension cache (if available).
 * Falls back to null if the API is not accessible.
 */
export async function getBranchesFromVscodeGit(repoPath: string): Promise<{ local: string[]; remote: string[]; current: string } | null> {
    const api = await getVscodeGitApi();
    if (!api) {
        logger.debug('[GitCharm] vscode.git API not available');
        return null;
    }

    try {
        // Find the repository matching our workspace
        const repositories = api.repositories || [];

        const repo = repositories.find((r: any) => r.rootUri && r.rootUri.fsPath === repoPath);

        if (!repo) {
            logger.debug(`[GitCharm] Repository not found in vscode.git. Looking for: ${repoPath}`);
            return null;
        }

        // Access cached state from the repository
        const state = repo.state;
        if (!state) {
            logger.debug('[GitCharm] Repository state is null/undefined');
            return null;
        }

        // Get HEAD (current branch)
        const head = state.HEAD;
        const currentBranch = head?.name || '';

        // Try to get refs using the new API: repo.getRefs()
        let refs: any[] = [];

        if (typeof repo.getRefs === 'function') {
            try {
                // New API: getRefs() returns a Promise<Ref[]>
                refs = await repo.getRefs();
                logger.debug(`[GitCharm] Got ${refs.length} refs via repo.getRefs()`);
            } catch (e) {
                logger.debug('[GitCharm] repo.getRefs() failed:', e);
                // Fallback to state.refs if getRefs fails
                refs = state.refs || [];
            }
        } else {
            // Old API: direct access to state.refs
            refs = state.refs || [];
            logger.debug(`[GitCharm] Using legacy state.refs (${refs.length} refs)`);
        }

        const local: string[] = [];
        const remote: string[] = [];

        for (const ref of refs) {
            if (ref.type === 0) { // RefType.Head - local branch
                if (ref.name) {local.push(ref.name);}
            } else if (ref.type === 1) { // RefType.RemoteHead - remote branch
                if (ref.name) {
                    // Normalize remote branch name: strip "refs/remotes/" prefix if present
                    let remoteName = ref.name;
                    if (remoteName.startsWith('refs/remotes/')) {
                        remoteName = remoteName.substring('refs/remotes/'.length);
                    }
                    remote.push(remoteName);
                }
            }
        }

        logger.debug(`[GitCharm] Processed branches: ${local.length} local, ${remote.length} remote (from ${refs.length} total refs)`);
        if (remote.length > 0) {
            logger.debug(`[GitCharm] Sample remote branches: ${remote.slice(0, 5).join(', ')}`);
        } else if (refs.length === 0) {
            logger.debug('[GitCharm] WARNING: No refs returned from repo.getRefs()');
        }

        return { local, remote, current: currentBranch };
    } catch (error) {
        logger.debug('[GitCharm] Failed to get branches from vscode.git:', error);
        return null;
    }
}

/**
 * Get VSCode Git repository instance for a given path.
 * Returns the repository object which provides access to cached state and methods.
 */
export async function getVscodeGitRepository(repoPath: string): Promise<any> {
    const api = await getVscodeGitApi();
    if (!api) {return null;}

    try {
        const repositories = api.repositories || [];
        const repo = repositories.find((r: any) => r.rootUri && r.rootUri.fsPath === repoPath);
        return repo || null;
    } catch (error) {
        logger.debug('[GitCharm] Failed to get repository from vscode.git:', error);
        return null;
    }
}

/**
 * Build a virtual-document URI whose content is the file blob at a given git ref.
 */
export function gitBlobUri(ref: string, filePath: string): vscode.Uri {
    return vscode.Uri.from({
        scheme: 'idea-git-diff',
        path: '/' + filePath,
        query: 'ref=' + encodeURIComponent(ref)
    });
}

/**
 * Extract branch name from tree item (handles different argument formats from click/context menu)
 */
export function getBranchName(node: any): string | undefined {
    if (node?.name && typeof node.name === 'string') {
        return node.name;
    }

    if (node?.label) {
        if (typeof node.label === 'string') {
            return node.label;
        }
        if (typeof node.label === 'object' && node.label.label) {
            return node.label.label;
        }
    }

    if (node?.resource?.name) {
        return node.resource.name;
    }

    if (typeof node === 'string') {
        return node;
    }

    return undefined;
}

/**
 * Determine whether a git error message indicates an operation stopped due to
 * merge conflicts (rebase, merge, cherry-pick, etc.).
 */
export function isConflictError(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes('could not apply') ||
        lower.includes('resolve all conflicts') ||
        lower.includes('rebase --continue') ||
        lower.includes('rebase --abort') ||
        lower.includes('automatic merge failed') ||
        lower.includes('merge conflict') ||
        lower.includes('fix conflicts') ||
        lower.includes('conflict') ||
        lower.includes('unmerged files') ||
        lower.includes('cherry-pick failed');
}

/**
 * Combine message, stderr and stdout from a failed git exec so we don't miss
 * conflict indicators that git wrote to a non-default stream.
 */
export function combineErrorText(error: any): string {
    return [error?.message, error?.stderr, error?.stdout]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n');
}

/**
 * Detect whether a failed git operation stopped because of merge conflicts.
 * Falls back to scanning for unmerged files when the error text is unclear
 * (some Windows git builds strip stderr from the thrown error message).
 */
export async function tryHandleConflict(
    error: any,
    gitService: GitService,
    graphView: GraphViewProvider,
    operationLabel: string,
    continueOperation: () => Promise<string>,
    abortOperation: () => Promise<string>,
    currentBranch?: string,
    targetBranch?: string,
    kind?: 'rebase' | 'merge'
): Promise<boolean> {
    if (isConflictError(combineErrorText(error))) {
        await handleConflictLoop(gitService, graphView, operationLabel, continueOperation, abortOperation, currentBranch, targetBranch, kind);
        return true;
    }

    const conflictFiles = await gitService.getConflictFiles();
    if (conflictFiles.length > 0) {
        await handleConflictLoop(gitService, graphView, operationLabel, continueOperation, abortOperation, currentBranch, targetBranch, kind);
        return true;
    }

    return false;
}

/**
 * Extract the worktree path from a "branch used by worktree" error message.
 */
export function extractWorktreePath(message: string): string | undefined {
    const match = message.match(/used by worktree at ['"]?([^'"\n]+)['"]?/i);
    return match ? match[1] : undefined;
}

/**
 * Open files with unresolved merge conflicts in the editor and let the user
 * choose to abort the operation. VSCode's built-in SCM view handles conflict resolution.
 */
export async function handleConflictLoop(
    gitService: GitService,
    graphView: GraphViewProvider,
    operationLabel: string,
    continueOperation: () => Promise<string>,
    abortOperation: () => Promise<string>,
    currentBranch?: string,
    targetBranch?: string,
    kind?: 'rebase' | 'merge'
): Promise<void> {
    const conflictFiles = await gitService.getConflictFiles();
    if (conflictFiles.length === 0) {
        vscode.window.showInformationMessage(t('conflict.noneDetected'));
        return;
    }

    // Refresh webview immediately to show operation status bar
    graphView.refresh();

    // Show warning with conflict count and operation context
    vscode.window.showWarningMessage(t('conflict.hasConflicts', { 
        operation: operationLabel, 
        count: conflictFiles.length 
    }));
}
