import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './services/gitService';
import { formatGitError } from './services/gitUtils';
import { GitAskpass } from './services/askpass';
import { logger } from './services/logger';
import { GraphViewProvider } from './views/graphView';
import { BlameProvider } from './services/blameProvider';
import { gitBlobUri } from './commands/helpers';
import { registerBranchCommands } from './commands/branchCommands';
import { registerCommitCommands } from './commands/commitCommands';
import { registerOperationCommands } from './commands/operationCommands';
import { registerRemoteCommands } from './commands/remoteCommands';
import { registerTagCommands } from './commands/tagCommands';
import { registerStashCommands } from './commands/stashCommands';
import { registerReflogCommands } from './commands/reflogCommands';
import { registerRepositoryCommands } from './commands/repositoryCommands';
import { registerWorktreeCommands } from './commands/worktreeCommands';
import { resolveLocale, setLocale, t } from './i18n';

export function activate(ctx: vscode.ExtensionContext) {
    // Locale: VSCode display language, overridable via idea-git.language
    const applyLocale = () => setLocale(resolveLocale(
        vscode.env.language,
        vscode.workspace.getConfiguration('idea-git').get<string>('language', 'auto')
    ));
    applyLocale();

    // Full-fidelity diagnostics: notifications show a capped, friendly message,
    // so long git stderr (auth/proxy/conflict dumps) needs somewhere it can be
    // read and copied. The sink keeps the service layer free of vscode imports.
    const logChannel = vscode.window.createOutputChannel('GitCharm');
    ctx.subscriptions.push(logChannel);
    logger.setSink((level, message) => {
        logChannel.appendLine(`${new Date().toISOString()} [${level}] ${message}`);
    });
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.showLog', () => logChannel.show(true))
    );

    // Credential prompts for push/pull/fetch: git's GIT_ASKPASS points at a
    // script in this extension which talks back to a loopback-only server here.
    const askpass = new GitAskpass(ctx.extensionPath);
    ctx.subscriptions.push(askpass);

    // Single shared GitService for the webview and all commands
    const gitService = new GitService(ctx.workspaceState, askpass);
    // Owns a workspace-folders listener and the .git watchers; without this they
    // outlive the service when the extension deactivates.
    ctx.subscriptions.push(gitService);

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

    // Auto-fetch interval ("idea-git.autoFetchMinutes" setting): re-arm the timer
    // so a change applies without reopening the panel (0 stops it entirely)
    ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('idea-git.autoFetchMinutes')) {
            graphView.resyncAutoFetch();
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
    // A theme installed in this session only appears in the extension registry once
    // it settles; re-resolve then so the icons apply without a window reload.
    ctx.subscriptions.push(vscode.extensions.onDidChange(() => {
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

    // Watch for git repository changes (git init, clone, etc.) — in every
    // workspace folder, not just the first: a repository created in any root of a
    // multi-folder workspace has to reach the panel's switcher.
    const repoWatchers = (vscode.workspace.workspaceFolders ?? []).map(folder =>
        vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git'))
    );
    // One handler in both directions, and for folder add/remove as well: what the
    // context key and the tooltip say is whatever the service resolves now — so
    // deleting one repository in a multi-folder workspace does not blank the panel
    // while another root still has one, and adding a folder can light it up again.
    const onRepositoryChange = () => {
        const hasRepo = gitService.refreshRepositoryPath() !== undefined;
        vscode.commands.executeCommand('setContext', 'idea-git.hasGitRepo', hasRepo);
        void graphView.refreshRepoState(true);
        setStatusBarTooltip(hasRepo);
    };
    for (const watcher of repoWatchers) {
        watcher.onDidCreate(onRepositoryChange);
        watcher.onDidDelete(onRepositoryChange);
        ctx.subscriptions.push(watcher);
    }

    ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(onRepositoryChange));

    // Event-driven cache invalidation: watch the git directory itself, so changes
    // made outside this extension (CLI, other tools) are picked up without polling
    // and without depending on the built-in git extension being enabled.
    ctx.subscriptions.push(gitService.watchRepositoryChanges());

    // Command to focus the Git Log panel
    ctx.subscriptions.push(
        vscode.commands.registerCommand('idea-git.openGraphView', () => {
            vscode.commands.executeCommand('idea-git.mainView.focus');
        })
    );

    // Git-blame annotations in the editor gutter
    const blameProvider = new BlameProvider(gitService, hash => graphView.revealCommit(hash));
    ctx.subscriptions.push(
        blameProvider,
        vscode.commands.registerCommand('idea-git.toggleBlame', () => blameProvider.toggle()),
        vscode.commands.registerCommand('idea-git.revealCommit', (hash: string) => {
            if (hash) {graphView.revealCommit(hash);}
        })
    );

    // Serve file blobs at arbitrary git refs so vscode.diff can render them natively
    ctx.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('idea-git-diff', {
            async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
                // `uri.path` and URLSearchParams already give the decoded value;
                // decoding again would rewrite a name containing a percent sign.
                const params = new URLSearchParams(uri.query);
                const ref = params.get('ref') ?? '';
                const filePath = uri.path.replace(/^\/+/, '');
                if (!ref || !filePath) {
                    return '';
                }
                try {
                    // Byte-exact in every view: a diff side has to match the
                    // worktree exactly, and trimming the final newline made
                    // every unmodified file look like it had an added line
                    // at the end.
                    return await gitService.readBlob(ref, filePath);
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
                vscode.window.showErrorMessage(t('ext.openDiffFailed', { error: formatGitError(e) }));
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
                // Branch names come from our own refs cache (read off disk), so the
                // picker works whether or not the built-in git extension is enabled.
                const branchDetails = await gitService.getBranchesWithDetails(false);
                const localBranches = branchDetails.local.map(b => b.name);
                const remoteBranches = branchDetails.remote.map(b => b.name);

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
                vscode.window.showErrorMessage(t('ext.compareFailed', { error: formatGitError(error) }));
            }
        }),

        // --- Editor context menu: uncommitted worktree content vs the last commit ---
        vscode.commands.registerCommand('idea-git.showWorkingDiff', async (uri?: vscode.Uri) => {
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

            const fileName = rel.split('/').pop() || rel;
            try {
                await vscode.commands.executeCommand(
                    'vscode.diff',
                    gitBlobUri('HEAD', rel),
                    target,
                    `${fileName} (HEAD ↔ ${t('ext.workingTree')})`
                );
            } catch (error) {
                vscode.window.showErrorMessage(t('ext.openDiffFailed', { error: formatGitError(error) }));
            }
        })
    );

    // Command groups by domain (each pushes its own disposables)
    registerBranchCommands(ctx, gitService, graphView);
    registerCommitCommands(ctx, gitService, graphView);
    registerOperationCommands(ctx, gitService, graphView);
    registerRemoteCommands(ctx, gitService, graphView);
    registerTagCommands(ctx, gitService, graphView);
    registerStashCommands(ctx, gitService, graphView);
    registerReflogCommands(ctx, gitService, graphView);
    registerRepositoryCommands(ctx, gitService, graphView);
    registerWorktreeCommands(ctx, gitService, graphView);

    // Register cleanup callback: clear all caches when extension deactivates (project close)
    ctx.subscriptions.push({
        dispose: () => {
            graphView.dispose();
            gitService.clearAllCaches();
            gitService.dispose();
        }
    });
}

export function deactivate() {}
