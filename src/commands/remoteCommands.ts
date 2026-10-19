import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { assertRemoteName, branchWebUrl, commitWebUrl, formatGitError, redactUrlCredentials, RemoteInfo } from '../services/gitUtils';
import { GraphViewProvider } from '../views/graphView';
import { getBranchName } from './helpers';
import { t } from '../i18n';

/**
 * Open a commit or a branch on the remote's web UI. The address is derived from
 * this repository's own remote URL (never a hardcoded host), so it works for
 * GitHub, GitLab and self-hosted instances alike.
 */
export function registerRemoteCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService,
    graphView: GraphViewProvider
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
            vscode.window.showErrorMessage(t('remote.openFailed', { error: formatGitError(error) }));
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
        }),

        vscode.commands.registerCommand('idea-git.manageRemotes', async () => {
            /** Same rules for the add and rename prompts; returns the reason instead of throwing. */
            const validateRemoteName = (value: string): string | undefined => {
                try {
                    assertRemoteName(value);
                    return undefined;
                } catch (error) {
                    return (error as Error).message;
                }
            };

            try {
                const remotes = await gitService.getRemotes();
                type RemotePick = vscode.QuickPickItem & { remote?: RemoteInfo };
                const picks: RemotePick[] = [
                    ...remotes.map(remote => ({
                        label: remote.name,
                        // The URL can carry a token; show the address without it.
                        description: redactUrlCredentials(remote.url),
                        remote
                    })),
                    { label: t('remote.add'), description: t('remote.addDesc') }
                ];
                const picked = await vscode.window.showQuickPick(picks, {
                    title: t('remote.manageTitle'),
                    placeHolder: t('remote.managePlaceHolder'),
                    ignoreFocusOut: true
                });
                if (!picked) {return;}

                if (!picked.remote) {
                    const name = await vscode.window.showInputBox({
                        prompt: t('remote.namePrompt'),
                        placeHolder: t('remote.namePlaceholder'),
                        ignoreFocusOut: true,
                        validateInput: validateRemoteName
                    });
                    if (!name) {return;}
                    const url = await vscode.window.showInputBox({
                        prompt: t('remote.urlPrompt'),
                        placeHolder: t('remote.urlPlaceholder'),
                        ignoreFocusOut: true
                    });
                    if (!url || !url.trim()) {return;}
                    await gitService.addRemote(name, url);
                    vscode.window.showInformationMessage(t('remote.added', { name }));
                    graphView.refreshBranchesOnly();
                    return;
                }

                const remote = picked.remote;
                const action = await vscode.window.showQuickPick(
                    [
                        { label: t('remote.actionEditUrl'), action: 'url' as const },
                        { label: t('remote.actionRename'), action: 'rename' as const },
                        { label: t('remote.actionRemove'), action: 'remove' as const }
                    ],
                    { placeHolder: t('remote.actionPlaceHolder', { name: remote.name }), ignoreFocusOut: true }
                );
                if (!action) {return;}

                if (action.action === 'url') {
                    const url = await vscode.window.showInputBox({
                        prompt: t('remote.urlPrompt'),
                        value: remote.url,
                        ignoreFocusOut: true
                    });
                    if (url === undefined || !url.trim() || url.trim() === remote.url) {return;}
                    await gitService.setRemoteUrl(remote.name, url);
                    vscode.window.showInformationMessage(t('remote.urlUpdated', { name: remote.name }));
                    return;
                }

                if (action.action === 'rename') {
                    const newName = await vscode.window.showInputBox({
                        prompt: t('remote.namePrompt'),
                        value: remote.name,
                        ignoreFocusOut: true,
                        validateInput: validateRemoteName
                    });
                    if (!newName || newName === remote.name) {return;}
                    await gitService.renameRemote(remote.name, newName);
                    vscode.window.showInformationMessage(t('remote.renamed', { old: remote.name, new: newName }));
                    graphView.refreshBranchesOnly();
                    return;
                }

                const confirm = await graphView.showDialog(
                    t('remote.removeConfirm', { name: remote.name }),
                    [t('remote.removeBtn'), t('common.cancel')],
                    'warn'
                );
                if (confirm !== t('remote.removeBtn')) {return;}
                await gitService.removeRemote(remote.name);
                vscode.window.showInformationMessage(t('remote.removed', { name: remote.name }));
                graphView.refreshBranchesOnly();
            } catch (error) {
                vscode.window.showErrorMessage(t('remote.actionFailed', { error: formatGitError(error) }));
            }
        })
    );
}
