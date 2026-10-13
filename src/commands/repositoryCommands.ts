import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { GraphViewProvider } from '../views/graphView';
import { repositoryKey } from '../services/gitUtils';
import { t } from '../i18n';

/**
 * Repository switcher for multi-root workspaces.
 *
 * The panel carries the same control above the branch tree, but this command
 * also works with the panel hidden and from the palette. Both routes go through
 * GraphViewProvider.switchRepository on purpose: whatever changes the visible
 * repository has to reset the same state, and two places that each know how to
 * do that is how a stale branch or selection from another project survives.
 */
export function registerRepositoryCommands(
    ctx: vscode.ExtensionContext,
    gitService: GitService,
    graphView: GraphViewProvider
): void {
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.selectRepository', async () => {
            const repos = gitService.listRepositories();
            if (repos.length < 2) {
                vscode.window.showInformationMessage(t('repo.single'));
                return;
            }

            const current = gitService.repositoryPath;
            const items = repos.map(repo => ({
                label: (current && repositoryKey(repo.path) === repositoryKey(current))
                    ? `$(check) ${repo.name}`
                    : repo.name,
                description: repo.path,
                path: repo.path
            }));

            const picked = await vscode.window.showQuickPick(items, {
                title: t('repo.pickTitle'),
                placeHolder: t('repo.pickPlaceHolder')
            });
            if (!picked) {return;}
            await graphView.switchRepository(picked.path);
        })
    );
}
