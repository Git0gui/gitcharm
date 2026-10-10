import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { GraphViewProvider } from '../views/graphView';
import { t } from '../i18n';

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
