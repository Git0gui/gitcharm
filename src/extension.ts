import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './services/gitService';
import { logger } from './services/logger';
import { GraphViewProvider } from './views/graphView';
import { BlameProvider } from './services/blameProvider';
import { getVscodeGitApi, getBranchesFromVscodeGit, gitBlobUri } from './commands/helpers';
import { registerBranchCommands } from './commands/branchCommands';
import { registerCommitCommands } from './commands/commitCommands';
import { registerOperationCommands } from './commands/operationCommands';
import { resolveLocale, setLocale, t } from './i18n';

export function activate(ctx: vscode.ExtensionContext) {
    // Locale: VSCode display language, overridable via idea-git.language
    const applyLocale = () => setLocale(resolveLocale(
        vscode.env.language,
        vscode.workspace.getConfiguration('idea-git').get<string>('language', 'auto')
    ));
    applyLocale();

    // Single shared GitService for the webview and all commands
    const gitService = new GitService(ctx.workspaceState);

    // Check if current workspace has a git repository
    const hasGitRepo = gitService.repositoryPath !== undefined;

    // Debug logging toggle ("idea-git.debug" setting)
    logger.setDebug(vscode.workspace.getConfiguration('idea-git').get<boolean>('debug', false));
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('idea-git.debug')) {
            logger.setDebug(vscode.workspace.getConfiguration('idea-git').get<boolean>('debug', false));
        }
    }));

    // Register webview provider (always registered, but visibility controlled by context)
    const graphView = new GraphViewProvider(gitService, ctx.extensionUri, ctx.workspaceState);
    ctx.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'idea-git.mainView',
            graphView
        )
    );

    // Language override ("idea-git.language" setting): re-resolve locale and
    // rebuild the webview so both host and webview strings switch
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('idea-git.language')) {
            applyLocale();
            graphView.relocalize();
        }
    }));

    // File icons come from the workbench themes, so a switch has to re-send the pack
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('workbench.iconTheme')) {
            graphView.refreshFileIconTheme();
        }
    }));
    ctx.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => {
        graphView.refreshFileIconTheme();
    }));

    // Set context key for view visibility
    vscode.commands.executeCommand('setContext', 'idea-git.hasGitRepo', hasGitRepo);

    // Status bar entry stays put in every workspace: without a repository it is the
    // route into the panel's guidance page
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(repo) GitCharm';
    statusBarItem.command = 'idea-git.openGraphView';
    statusBarItem.show();
    ctx.subscriptions.push(statusBarItem);
    const setStatusBarTooltip = (hasRepo: boolean): void => {
        statusBarItem.tooltip = t(hasRepo ? 'ext.statusTooltip' : 'ext.statusTooltipNoRepo');
    };
    setStatusBarTooltip(hasGitRepo);

    // Watch for git repository changes (git init, clone, etc.)
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file('.'), '.git')
    );

    watcher.onDidCreate(() => {
        vscode.commands.executeCommand('setContext', 'idea-git.hasGitRepo', true);
        gitService.refreshRepositoryPath();
        void graphView.refreshRepoState(true);
        setStatusBarTooltip(true);
    });

    watcher.onDidDelete(() => {
        vscode.commands.executeCommand('setContext', 'idea-git.hasGitRepo', false);
        gitService.refreshRepositoryPath();
        void graphView.refreshRepoState(true);
        setStatusBarTooltip(false);
    });

    ctx.subscriptions.push(watcher);

    // Register event-driven cache invalidation using VSCode's built-in Git extension
    // This ensures caches stay fresh without polling - react to actual repository changes
    const repoPath = gitService.repositoryPath;
    if (repoPath) {
        getVscodeGitApi().then(api => {
            if (api) {
                const disposables = gitService.registerVscodeGitEventListeners(api);
                ctx.subscriptions.push(...disposables);
                logger.info('[GitCharm] Event-driven cache invalidation enabled via vscode.git');
            } else {
                logger.debug('[GitCharm] vscode.git not available, falling back to manual refresh');
            }
        }).catch(error => {
            logger.debug('[GitCharm] Failed to register vscode.git event listeners:', error);
        });
    }

    // Command to focus the Git Log panel
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.openGraphView', () => {
            vscode.commands.executeCommand('idea-git.mainView.focus');
        })
    );

    // Git-blame annotations in the editor gutter
    const blameProvider = new BlameProvider(gitService, hash => graphView.revealCommit(hash));
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.toggleBlame', () => blameProvider.toggle()),
        vscode.commands.registerCommand('idea-git.revealCommit', (hash: string) => {
            if (hash) {graphView.revealCommit(hash);}
        })
    );

    // Serve file blobs at arbitrary git refs so vscode.diff can render them natively
    ctx.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('idea-git-diff', {
            async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
                const ref = decodeURIComponent(new URLSearchParams(uri.query).get('ref') ?? '');
                const filePath = decodeURIComponent(uri.path).replace(/^\/+/, '');
                if (!ref || !filePath) {
                    return '';
                }
                try {
                    return await gitService.showBlob(ref, filePath);
                } catch {
                    return '';
                }
            }
        })
    );

    // --- File click: open diff (parent commit vs this commit) via VSCode built-in diff ---
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.openFileDiff', async (fileNode: any) => {
            const filePath = fileNode?.relativePath;
            const commitHash = gitService.selectedCommitHash;
            if (!filePath || !commitHash) {return;}

            const fileName = filePath.split('/').pop() || filePath;
            const title = `${fileName} (${commitHash.substring(0, 7)})`;
            try {
                await vscode.commands.executeCommand(
                    'vscode.diff',
                    gitBlobUri(`${commitHash}^`, filePath),
                    gitBlobUri(commitHash, filePath),
                    title
                );
            } catch (e) {
                vscode.window.showErrorMessage(t('ext.openDiffFailed', { error: String(e) }));
            }
        }),

        // --- Right-click a file: compare it against the same file on another branch ---
        vscode.commands.registerCommand('idea-git.compareFileWithBranch', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target || target.scheme !== 'file') {
                vscode.window.showErrorMessage(t('ext.selectFile'));
                return;
            }
            const repoPath = gitService.repositoryPath;
            if (!repoPath) {
                vscode.window.showErrorMessage(t('ext.noGitRepo'));
                return;
            }
            const rel = path.relative(repoPath, target.fsPath).replace(/\\/g, '/');
            if (!rel || rel.startsWith('..')) {
                vscode.window.showErrorMessage(t('ext.fileNotInRepo'));
                return;
            }

            try {
                // Try to get branch data from VSCode's built-in Git extension first (fastest)
                let localBranches: string[] = [];
                let remoteBranches: string[] = [];

                const vscodeBranches = await getBranchesFromVscodeGit(repoPath);
                if (vscodeBranches) {
                    // Got branches from vscode.git - use them!
                    localBranches = vscodeBranches.local;
                    remoteBranches = vscodeBranches.remote;
                    logger.debug('[GitCharm] Using vscode.git cache for file comparison');
                } else {
                    // Fallback to our own cache
                    const branchDetails = await gitService.getBranchesWithDetails(false);
                    localBranches = branchDetails.local.map(b => b.name);
                    remoteBranches = branchDetails.remote.map(b => b.name);
                    logger.debug('[GitCharm] Using internal cache for file comparison');
                }

                const items = [
                    ...localBranches.map(b => ({ label: `$(git-branch) ${b}`, description: t('common.local'), branch: b })),
                    ...remoteBranches.map(b => ({ label: `$(cloud) ${b}`, description: t('common.remote'), branch: b }))
                ];
                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: t('ext.pickBranchPlaceHolder', { path: rel }),
                    title: t('ext.pickBranchTitle'),
                    matchOnDescription: true
                });
                if (!picked) {return;}

                const exists = await gitService.blobExists(picked.branch, rel);
                if (!exists) {
                    vscode.window.showWarningMessage(t('ext.fileNotInBranch', { branch: picked.branch, path: rel }));
                    return;
                }

                const fileName = rel.split('/').pop() || rel;
                await vscode.commands.executeCommand(
                    'vscode.diff',
                    gitBlobUri(picked.branch, rel),
                    target,
                    `${fileName} (${picked.branch} ↔ ${t('ext.workingTree')})`
                );
            } catch (error) {
                vscode.window.showErrorMessage(t('ext.compareFailed', { error: String(error) }));
            }
        })
    );

    // Command groups by domain (each pushes its own disposables)
    registerBranchCommands(ctx, gitService, graphView);
    registerCommitCommands(ctx, gitService, graphView);
    registerOperationCommands(ctx, gitService, graphView);

    // Register cleanup callback: clear all caches when extension deactivates (project close)
    ctx.subscriptions.push({
        dispose: () => {
            graphView.dispose();
            gitService.clearAllCaches();
        }
    });
}

export function deactivate() {}
