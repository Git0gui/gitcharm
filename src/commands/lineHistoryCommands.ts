import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../services/gitService';
import { GraphViewProvider } from '../views/graphView';
import { LineHistoryPanel, LineHistoryTarget } from '../views/lineHistoryPanel';
import { formatGitError } from '../services/gitUtils';
import { t } from '../i18n';

/**
 * `idea-git.lineHistory` — Alt+H on an editor, or the GitCharm submenu.
 *
 * The selection decides the range; no selection means the cursor's line. The
 * buffer text travels with the request so unsaved edits are blamed as they
 * are on screen.
 */
export function registerLineHistoryCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService,
    graphView: GraphViewProvider
): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.lineHistory', async (uri?: vscode.Uri) => {
            const editor = vscode.window.activeTextEditor;
            const target = uri ?? editor?.document.uri;
            if (!target || target.scheme !== 'file') {
                vscode.window.showErrorMessage(t('lineHistory.noEditor'));
                return;
            }

            const repoPath = gitService.repositoryPath;
            if (!repoPath) {
                vscode.window.showErrorMessage(t('ext.noGitRepo'));
                return;
            }
            const rel = path.relative(repoPath, target.fsPath).replace(/\\/g, '/');
            if (!rel || rel.startsWith('..')) {
                vscode.window.showErrorMessage(t('lineHistory.notInRepo'));
                return;
            }

            try {
                const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === target.toString());
                const text = doc
                    ? doc.getText()
                    : Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');

                // A selection in some other editor says nothing about this file.
                const selection = editor && editor.document.uri.toString() === target.toString()
                    ? editor.selection
                    : undefined;
                const startLine = selection ? Math.min(selection.start.line, selection.end.line) : 0;
                const endLine = selection ? Math.max(selection.start.line, selection.end.line) : 0;

                const payload: LineHistoryTarget = { repoPath, file: rel, startLine, endLine, text };
                LineHistoryPanel.show(gitService, ctx.extensionUri, payload, (hash, file) => {
                    graphView.revealCommit(hash, file);
                });
            } catch (error) {
                vscode.window.showErrorMessage(t('lineHistory.openFailed', { error: formatGitError(error) }));
            }
        })
    );
}
