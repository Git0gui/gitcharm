import * as vscode from 'vscode';
import { GitService, ReflogEntry } from '../services/gitService';
import { GraphViewProvider } from '../views/graphView';
import { t } from '../i18n';

/**
 * Reflog viewer — the rescue path for a commit that no longer sits on a branch.
 *
 * The scope follows the entry point: the toolbar button asks for HEAD's reflog
 * (HEAD is what records `checkout` and `reset`, the two operations that hide
 * finished work), while a branch row asks for that branch's own movements.
 *
 * Reading only: the rows are rendered by the webview and its context menu
 * reuses the existing commit actions (create branch / reset / diff), so this
 * command never mutates the repository and needs no reload of its own.
 */
export function registerReflogCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService,
    graphView: GraphViewProvider
): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.showReflog', async (node?: { name?: string }) => {
            const scope: string = node?.name || 'HEAD';
            const entries: ReflogEntry[] = await gitService.getReflog(scope);
            if (entries.length === 0) {
                // A brand-new or reflog-garbage-collected repository has nothing to
                // list; say so instead of opening an empty dialog over the panel.
                vscode.window.showInformationMessage(t('reflog.empty'));
                return;
            }
            graphView.showReflog(scope, entries);
        })
    );
}
