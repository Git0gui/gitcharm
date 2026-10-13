import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, InProgressOperation } from '../services/gitService';
import { GraphViewProvider } from '../views/graphView';
import { isEmptyCommitStop, emptyCommitStopInfo, formatGitError } from '../services/gitUtils';
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
    operationLabel: string
): Promise<boolean> {
    if (isConflictError(combineErrorText(error))) {
        await handleConflictLoop(gitService, graphView, operationLabel);
        return true;
    }

    const conflictFiles = await gitService.getConflictFiles();
    if (conflictFiles.length > 0) {
        await handleConflictLoop(gitService, graphView, operationLabel);
        return true;
    }

    return false;
}

/** The choice the user made about a step that turned out to be empty. */
export type EmptyStepChoice = 'skip' | 'keep' | 'abort' | 'cancel';

/**
 * `op.<kind>` / `op.cherryPick` — the label for whichever operation is in
 * progress, used by the conflict and abort paths below. Adding a kind to
 * InProgressOperation means adding that key in both dictionaries; the i18n
 * parity test fails until it is there.
 */
export function inProgressLabel(operation: InProgressOperation): string {
    return operation === 'cherry-pick' ? t('op.cherryPick') : `op.${operation}`;
}

/**
 * End whichever operation is in progress. Shared by the panel's 终止 command and
 * the empty-step dialog below, which have to dispatch the same four ways.
 */
export async function abortInProgressOperation(
    gitService: GitService,
    operation: InProgressOperation
): Promise<void> {
    if (operation === 'rebase') {
        await gitService.rebaseAbort();
    } else if (operation === 'merge') {
        await gitService.mergeAbort();
    } else if (operation === 'revert') {
        await gitService.revertAbort();
    } else {
        await gitService.abortCherryPick();
    }
}

/**
 * git stops a cherry-pick / rebase / revert when the step's changes turn out to
 * be empty — normally because the user resolved a conflict by keeping what the
 * other side already had. It answers by printing its whole advice block, which
 * is really three options: skip the step, land it anyway as an empty commit, or
 * call it off. Ask for one of those instead, and carry out the answer.
 *
 * Returns undefined when this is not that kind of stop, so the caller keeps its
 * own handling; 'cancel' means the user declined to choose and the operation is
 * still in progress (the panel's continue/abort bar is then the way out).
 */
export async function tryHandleEmptyCommitStop(
    error: unknown,
    gitService: GitService,
    graphView: GraphViewProvider
): Promise<EmptyStepChoice | undefined> {
    if (!isEmptyCommitStop(combineErrorText(error))) {return undefined;}

    const operation = await gitService.getInProgressOperation();
    if (!operation) {
        // Nothing is in progress any more: git finished the step its own way
        // (it drops a commit that is already upstream). Let the caller report.
        return undefined;
    }

    const info = emptyCommitStopInfo(combineErrorText(error));
    const commit = info.hash ? `${info.hash.substring(0, 7)}${info.subject ? ` ${info.subject}` : ''}` : '';
    const choice = await graphView.showDialog(
        t('op.emptyStop', { commit }),
        [t('op.emptySkip'), t('op.emptyKeep'), t('op.abort')],
        'warn'
    );

    if (choice !== t('op.emptySkip') && choice !== t('op.emptyKeep') && choice !== t('op.abort')) {
        return 'cancel';
    }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: choice === t('op.emptySkip') ? t('op.emptySkip') : choice,
            cancellable: false
        }, async () => {
            if (choice === t('op.emptySkip')) {
                if (operation === 'rebase') {
                    await gitService.rebaseSkip();
                } else if (operation === 'revert') {
                    await gitService.revertSkip();
                } else {
                    await gitService.cherryPickSkip();
                }
                return;
            }
            if (choice === t('op.emptyKeep')) {
                await gitService.commitEmptyStep();
                // Committing the step ends it, but a rebase always has a todo
                // left, and a multi-commit cherry-pick/revert keeps its queue in
                // .git/sequencer — git commit does not resume either.
                if (operation === 'rebase') {
                    await gitService.rebaseContinue();
                } else if (gitService.hasPendingSequencerSteps()) {
                    if (operation === 'revert') {
                        await gitService.revertContinue();
                    } else {
                        await gitService.cherryPickContinue();
                    }
                }
                return;
            }
            await abortInProgressOperation(gitService, operation);
        });
    } catch (inner) {
        // Resuming the queue can stop on the *next* step's conflicts, which is
        // the ordinary conflict path, not a failure of the choice just made.
        if (await gitService.getInProgressOperation()) {
            await handleConflictLoop(gitService, graphView, inProgressLabel(operation));
            return 'cancel';
        }
        vscode.window.showErrorMessage(t('op.emptyStopFailed', { error: formatGitError(inner) }));
        graphView.refresh();
        return 'cancel';
    }

    vscode.window.showInformationMessage(
        choice === t('op.emptySkip')
            ? t('op.emptySkipped', { commit })
            : choice === t('op.emptyKeep')
                ? t('op.emptyKept', { commit })
                : t('op.aborted')
    );
    graphView.refresh();
    return choice === t('op.emptySkip') ? 'skip' : choice === t('op.emptyKeep') ? 'keep' : 'abort';
}

/** Cap so a rebase over a wide conflict set doesn't flood the editor with tabs. */
const MAX_CONFLICT_FILES_OPENED = 10;

/**
 * Open the unmerged files in editors and return their repo-relative paths.
 * A path may be missing on disk ("deleted by us" side of a conflict), which is
 * skipped rather than reported.
 */
export async function openConflictFiles(gitService: GitService): Promise<string[]> {
    const files = await gitService.getConflictFiles();
    const root = gitService.repositoryPath;
    if (!root) {return files;}

    for (const relative of files.slice(0, MAX_CONFLICT_FILES_OPENED)) {
        try {
            const doc = await vscode.workspace.openTextDocument(
                vscode.Uri.file(path.join(root, relative.split('/').join(path.sep)))
            );
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
        } catch {
            // nothing to open for this side of the conflict
        }
    }
    return files;
}

/**
 * Extract the worktree path from a "branch used by worktree" error message.
 */
export function extractWorktreePath(message: string): string | undefined {
    const match = message.match(/used by worktree at ['"]?([^'"\n]+)['"]?/i);
    return match ? match[1] : undefined;
}

/**
 * Surface merge conflicts where they are actually resolved: the conflicted files
 * themselves. The workbench's core merge-conflict editor contributes the
 * "Accept Current / Incoming Change" actions, so opening the file is enough —
 * no built-in git extension involved. The panel keeps its continue/abort bar
 * because `graphView.refresh()` republishes the in-progress state.
 */
export async function handleConflictLoop(
    gitService: GitService,
    graphView: GraphViewProvider,
    operationLabel: string
): Promise<void> {
    const conflictFiles = await openConflictFiles(gitService);
    if (conflictFiles.length === 0) {
        vscode.window.showInformationMessage(t('conflict.noneDetected'));
        return;
    }

    graphView.refresh();
    vscode.window.showWarningMessage(t('conflict.hasConflicts', {
        operation: operationLabel,
        count: conflictFiles.length
    }));
}
