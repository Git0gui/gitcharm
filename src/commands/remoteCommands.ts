import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { branchWebUrl, commitWebUrl } from '../services/gitUtils';
import { getBranchName } from './helpers';
import { t } from '../i18n';

/**
 * Open a commit or a branch on the remote's web UI. The address is derived from
 * this repository's own remote URL (never a hardcoded host), so it works for
 * GitHub, GitLab and self-hosted instances alike.
 */
export function registerRemoteCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService
): void {
    const open = async (url: string | undefined): Promise<void> => {
        if (!url) {
            // No remote, or a remote that is just a local path — say which, and give
            // the user something actionable instead of a silent no-op.
            vscode.window.showWarningMessage(t('remote.noWebUrl'));
            return;
        }
        try {
            const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
            if (!opened) {
                // The OS refused (no browser handler / cancelled): leave the address
                // somewhere usable.
                await vscode.env.clipboard.writeText(url);
                vscode.window.showInformationMessage(t('remote.copied', { url }));
            }
        } catch (error) {
            vscode.window.showErrorMessage(t('remote.openFailed', { error: String(error) }));
        }
    };

    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.openCommitOnRemote', async (commitNode?: any) => {
            const hash = commitNode?.hash ?? commitNode?.commit?.hash ?? gitService.selectedCommitHash;
            if (!hash) {
                vscode.window.showErrorMessage(t('common.noCommitSelected'));
                return;
            }
            await open(commitWebUrl(gitService.getRemoteWebBase(), hash));
        }),

        vscode.commands.registerCommand('idea-git.openBranchOnRemote', async (branchNode?: any) => {
            const branch = getBranchName(branchNode) ?? await gitService.getCurrentBranch();
            if (!branch) {
                vscode.window.showErrorMessage(t('common.noBranchSelected'));
                return;
            }
            await open(branchWebUrl(gitService.getRemoteWebBase(), branch));
        })
    );
}
