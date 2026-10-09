import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService, GraphCommit, LogFilters } from '../services/gitService';
import { ExtToWebviewMessage, OperationKind, PersistedViewState, WebviewToExtMessage } from './messages';
import { logger } from '../services/logger';
import { getLocale, t, webviewStrings } from '../i18n';

interface GraphPayload {
    commits: GraphCommit[];
    local: string[];
    remote: string[];
    currentBranch: string;
    selectedBranch: string;
    repoName: string;
    hasMore: boolean;
    headHash: string;
    inProgress?: OperationKind;
}

/** Well-known empty tree: diffing against it marks every file as added (first push). */
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Synthetic row hash for the aggregate "全部提交/全部差异" entry in dialogs. */
const ALL_COMMITS_ROW = '__all__';

export class GraphViewProvider implements vscode.WebviewViewProvider {
    private static readonly PAGE_FIRST = 20;
    private static readonly PAGE_MORE = 10;
    /** Session-restore window: reopen within this period restores the last view; later opens start fresh. */
    private static readonly SESSION_RESTORE_TTL_MS = 2 * 60 * 60 * 1000;

    private _view: vscode.WebviewView | undefined;
    private _gitService: GitService;
    private _extensionUri: vscode.Uri;
    private _branch: string | undefined;
    private _pendingReveal: string | undefined;
    private _filters: LogFilters = {};
    private _loaded = 0;
    private _hasMore = false;
    private _loadingMore = false;
    private _loadedHashes = new Set<string>();
    private _branchCheckTimer: NodeJS.Timeout | undefined;
    private _headWatcher: fs.FSWatcher | undefined;
    private _headDebounce: NodeJS.Timeout | undefined;
    private _lastKnownBranch: string | undefined;
    private _skipBranchCheckUntil: number = 0; // Timestamp until which to skip branch checks
    private _webviewReady = false;
    private _initialInProgress: 'rebase' | 'merge' | 'cherry-pick' | null = null;
    private _memento: vscode.Memento;
    private _pendingViewState: PersistedViewState | undefined;
    private _viewStateTimer: NodeJS.Timeout | undefined;

    constructor(gitService: GitService, extensionUri: vscode.Uri, memento: vscode.Memento) {
        this._gitService = gitService;
        this._extensionUri = extensionUri;
        this._memento = memento;
    }

    /** Type-checked postMessage; silently drops when the panel is not created yet. */
    private _post(msg: ExtToWebviewMessage): void {
        void this._view?.webview.postMessage(msg);
    }

    /**
     * Focus the GitCharm panel and select/scroll to a specific commit.
     */
    revealCommit(hash: string): void {
        vscode.commands.executeCommand('idea-git.mainView.focus');
        if (!this._view) {
            this._pendingReveal = hash;
            return;
        }
        
        // If commit is already loaded, reveal it immediately
        if (this._loadedHashes.size > 0 && this._loadedHashes.has(hash)) {
            this._post({ command: 'revealCommit', hash });
            return;
        }
        
        // Commit not loaded - search for it directly in current branch
        void this._searchAndRevealCommit(hash);
    }
    
    /**
     * Search for a commit by hash in the current branch and display only that commit.
     */
    private async _searchAndRevealCommit(targetHash: string): Promise<void> {
        try {
            const shortHash = targetHash.substring(0, 7);
            
            // Search for the specific commit using git log with exact hash
            const searchResult = await this._gitService.getCommitGraphData({
                limit: 1,
                branch: this._branch,
                filters: { text: shortHash },
                force: true
            });
            
            if (searchResult.commits.length === 0 || searchResult.commits[0].hash !== targetHash) {
                vscode.window.showInformationMessage(t('view.commitNotFound', { hash: targetHash.substring(0, 12) }));
                return;
            }
            
            // Found! Display only this single commit
            this._loaded = 1;
            this._loadedHashes = new Set([targetHash]);
            this._hasMore = false;
            
            const payload = await this._collect(true);
            payload.commits = searchResult.commits;

            this._post({ command: 'setData', ...payload });

            // Highlight the target commit immediately
            setTimeout(() => {
                this._post({ command: 'revealCommit', hash: targetHash });
            }, 50);
            
        } catch (error) {
            vscode.window.showErrorMessage(t('view.findCommitFailed', { error: String(error) }));
        }
    }

    /**
     * Re-query the repository (current branch included) and repaint the webview.
     */
    refresh(force: boolean = true): void {
        void this._reload(force);
    }

    /**
     * Optimistically add a branch to the UI before git operation completes.
     * @param branchName The branch name to add
     * @param isCurrent Whether this should be marked as current branch
     */
    addBranchOptimistically(branchName: string, isCurrent: boolean = false): void {
        this._post({ command: 'addBranchOptimistic', branch: branchName, isCurrent });
    }

    /**
     * Optimistically remove a branch from the UI before git operation completes.
     * @param branchName The branch name to remove
     */
    removeBranchOptimistically(branchName: string): void {
        // If we're currently viewing the deleted branch, switch to current branch and reload commits
        if (this._branch === branchName) {
            // Get current branch and switch to it
            this._gitService.getCurrentBranch().then(currentBranch => {
                this._branch = currentBranch || undefined;
                // Reload commits for current branch
                void this._reload(true);
            }).catch(() => {
                // Fallback to all branches if getting current branch fails
                this._branch = undefined;
                void this._reload(true);
            });
        }
        
        this._post({ command: 'removeBranchOptimistic', branch: branchName });
    }

    /**
     * Optimistically rename a branch in the UI before git operation completes.
     * @param oldName Current branch name
     * @param newName New branch name
     */
    renameBranchOptimistically(oldName: string, newName: string): void {
        // Update internal branch reference if we're currently viewing the renamed branch
        if (this._branch === oldName) {
            this._branch = newName;
        }
        
        this._post({ command: 'renameBranchOptimistic', oldName, newName });
    }

    /**
     * Immediately update the current branch highlight without reloading data.
     * This provides instant visual feedback when switching branches.
     */
    updateCurrentBranch(branchName: string): void {
        this._post({ command: 'setCurrentBranch', branch: branchName });
    }

    /**
     * Get the currently selected/displayed branch in the webview.
     * Returns empty string if showing all branches.
     */
    getSelectedBranch(): string {
        return this._branch || '';
    }

    /**
     * Refresh only the branch tree without reloading commits.
     * Used for operations like rename that don't affect commit history.
     */
    refreshBranchesOnly(): void {
        void this._reloadBranchesOnly();
    }

    /**
     * Send cherry-pick resume state to webview after conflict occurs.
     */
    showCherryPickResume(remainingHashes: string[], conflictHash: string): void {
        if (this._view) {
            this._post({ command: 'showCherryPickResume', remainingHashes, conflictHash });
        }
    }

    /**
     * Show a custom theme-aware dialog inside the webview.
     * Returns the selected action or undefined if dismissed.
     */
    showDialog(message: string, actions: string[], type: 'warn' | 'info' | 'error' = 'warn'): Promise<string | undefined> {
        return new Promise((resolve) => {
            if (!this._view) {
                resolve(undefined);
                return;
            }
            const handler = this._view.webview.onDidReceiveMessage((msg: WebviewToExtMessage) => {
                if (msg.command === 'dialogAction') {
                    handler.dispose();
                    resolve(msg.action);
                }
            });
            this._post({ command: 'showDialog', message, actions, type });
            // Fallback: resolve after 30s in case user closes panel
            setTimeout(() => {
                handler.dispose();
                resolve(undefined);
            }, 30000);
        });
    }

    /**
     * Show a squash message editor dialog with editable multi-line text.
     * Returns the edited message or undefined if cancelled.
     */
    showSquashMessageDialog(prompt: string, initialValue: string, placeholder: string): Promise<string | undefined> {
        return new Promise((resolve) => {
            if (!this._view) {
                resolve(undefined);
                return;
            }
            const handler = this._view.webview.onDidReceiveMessage((msg: WebviewToExtMessage) => {
                if (msg.command === 'squashMessageResponse') {
                    handler.dispose();
                    resolve(msg.message);
                }
            });
            this._post({ command: 'showSquashMessageDialog', prompt, initialValue, placeholder });
            // Fallback: resolve after 60s in case user closes panel
            setTimeout(() => {
                handler.dispose();
                resolve(undefined);
            }, 60000);
        });
    }

    /**
     * Show a push confirmation dialog with commit list and file diffs.
     * Returns { action: string, force?: boolean } or undefined.
     * baseRef: ref the push is compared against (upstream or origin/<branch>);
     * undefined for a first push (falls back to the empty tree).
     */
    showPushDialog(
        branchName: string,
        commits: Array<{ hash: string; shortHash: string; message: string; author: string; date: string }>,
        remoteExists: boolean,
        isFirstPush: boolean = false,
        baseRef?: string
    ): Promise<{ action: string; force?: boolean } | undefined> {
        return new Promise((resolve) => {
            if (!this._view) {
                resolve(undefined);
                return;
            }
            const allBase = baseRef ?? EMPTY_TREE_HASH;
            const handler = this._view.webview.onDidReceiveMessage((msg: WebviewToExtMessage) => {
                if (msg.command === 'pushDialogAction') {
                    handler.dispose();
                    resolve({ action: msg.action, force: msg.force });
                } else if (msg.command === 'pushDialogFileDiff') {
                    if (msg.hash === ALL_COMMITS_ROW) {
                        void this._openRefFileDiff(allBase, branchName, msg.path);
                    } else {
                        void this._openFileDiff(msg.hash, msg.path);
                    }
                } else if (msg.command === 'getPushAllFiles') {
                    void (async () => {
                        try {
                            const files = await this._gitService.getDiffFilesBetweenRefs(allBase, branchName);
                            this._post({ command: 'pushFilesResponse', hash: ALL_COMMITS_ROW, files });
                        } catch {
                            this._post({ command: 'pushFilesResponse', hash: ALL_COMMITS_ROW, files: [] });
                        }
                    })();
                }
            });
            this._post({
                command: 'showPushDialog',
                branchName,
                commits,
                remoteExists,
                isFirstPush
            });
            setTimeout(() => {
                handler.dispose();
                resolve(undefined);
            }, 60000);
        });
    }

    /** Show file history dialog */
    async showFileHistory(filePath: string, history: Array<{ hash: string; shortHash: string; author: string; date: string; message: string }>): Promise<void> {
        if (!this._view) {return;}
        this._post({ command: 'showFileHistory', filePath, history });
    }

    /**
     * Show a read-only branch compare dialog: commits the selected branch has
     * that the current branch lacks, per-commit files, and an aggregate
     * "全部差异" row (tip-to-tip diff).
     */
    showCompareDialog(
        branchName: string,
        currentBranch: string,
        commits: Array<{ hash: string; shortHash: string; message: string; author: string; date: string }>
    ): void {
        if (!this._view) {return;}
        const handler = this._view.webview.onDidReceiveMessage((msg: WebviewToExtMessage) => {
            if (msg.command === 'compareDialogClosed') {
                handler.dispose();
            } else if (msg.command === 'getCompareFiles') {
                void (async () => {
                    try {
                        const files = await this._gitService.getCommitFilesWithStats(msg.hash, false);
                        this._post({
                            command: 'compareFilesResponse',
                            hash: msg.hash,
                            files: files.map(f => ({ path: f.path, status: f.status || '' }))
                        });
                    } catch {
                        this._post({ command: 'compareFilesResponse', hash: msg.hash, files: [] });
                    }
                })();
            } else if (msg.command === 'getCompareAllFiles') {
                void (async () => {
                    try {
                        const files = await this._gitService.getDiffFilesBetweenRefs(currentBranch, branchName);
                        this._post({ command: 'compareFilesResponse', hash: ALL_COMMITS_ROW, files });
                    } catch {
                        this._post({ command: 'compareFilesResponse', hash: ALL_COMMITS_ROW, files: [] });
                    }
                })();
            } else if (msg.command === 'compareFileDiff') {
                if (msg.hash === ALL_COMMITS_ROW) {
                    void this._openRefFileDiff(currentBranch, branchName, msg.path);
                } else {
                    void this._openFileDiff(msg.hash, msg.path);
                }
            }
        });
        this._post({ command: 'showCompareDialog', branchName, currentBranch, commits });
        setTimeout(() => handler.dispose(), 300000);
    }

    /**
     * Create a git blob URI for diff viewing (matches extension.ts gitBlobUri)
     */
    private _gitBlobUri(ref: string, filePath: string): vscode.Uri {
        return vscode.Uri.from({
            scheme: 'idea-git-diff',
            path: '/' + filePath,
            query: 'ref=' + encodeURIComponent(ref)
        });
    }

    private async _openFileDiff(hash: string, path: string): Promise<void> {
        try {
            const title = `${path} (${hash.substring(0, 7)})`;
            // Use the same git blob URI scheme as the right-side commit file view
            // This shows the diff between parent commit (hash^) and current commit (hash)
            const beforeUri = this._gitBlobUri(hash + '^', path);
            const afterUri = this._gitBlobUri(hash, path);
            await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
        } catch (err) {
            vscode.window.showErrorMessage(t('view.openDiffFailed', { error: String(err) }));
        }
    }

    /** Diff a file between two refs (branch tips / remote ref), e.g. push preview or branch compare. */
    private async _openRefFileDiff(baseRef: string, targetRef: string, path: string): Promise<void> {
        try {
            const title = `${path} (${baseRef === EMPTY_TREE_HASH ? t('view.emptyRef') : baseRef} ↔ ${targetRef})`;
            const beforeUri = this._gitBlobUri(baseRef, path);
            const afterUri = this._gitBlobUri(targetRef, path);
            await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
        } catch (err) {
            vscode.window.showErrorMessage(t('view.openDiffFailed', { error: String(err) }));
        }
    }

    private _guessLanguage(path: string): string {
        const ext = path.split('.').pop()?.toLowerCase() || '';
        const langMap: Record<string, string> = {
            ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
            py: 'python', java: 'java', go: 'go', rs: 'rust', c: 'c', cpp: 'cpp', h: 'c',
            css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml', json: 'json',
            md: 'markdown', yaml: 'yaml', yml: 'yaml', sh: 'shellscript', bash: 'shellscript',
            sql: 'sql', txt: 'plaintext'
        };
        return langMap[ext] || 'plaintext';
    }

    async resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        this._webviewReady = false;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
        };

        webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtMessage) => {
            switch (message.command) {
                case 'selectBranch':
                    this._branch = message.branch || undefined;
                    // Clear cherry-pick resume state when switching branches
                    await this._gitService.clearCherryPickResume(this._memento);
                    await this._reload();
                    break;
                case 'refresh':
                    await this._reload(true);
                    break;
                case 'showNotification':
                    // Forward notification request from webview
                    if (message.type === 'info') {
                        vscode.window.showInformationMessage(message.message);
                    } else if (message.type === 'error') {
                        vscode.window.showErrorMessage(message.message);
                    } else if (message.type === 'warning') {
                        vscode.window.showWarningMessage(message.message);
                    }
                    break;
                case 'showStatusBarMessage':
                    // Forward status bar message request from webview
                    vscode.window.setStatusBarMessage(message.message, message.timeout || 3000);
                    break;
                case 'setFilters':
                    // Show loading indicator during search
                    this._postLoading('search', true);
                    try {
                        this._filters = {
                            text: (message.text || '').trim() || undefined,
                            author: (message.author || '').trim() || undefined,
                            from: message.from || undefined,
                            to: message.to || undefined
                        };
                        await this._reload();
                        // _reload will send setData with searchContext
                        // Frontend will handle showing the result count
                    } finally {
                        this._postLoading('search', false);
                    }
                    break;
                case 'loadMore':
                    await this._loadMore();
                    break;
                case 'selectCommit':
                    this._postLoading('detail', true);
                    try {
                        const [commit, files] = await Promise.all([
                            this._gitService.getCommitDetail(message.hash, !!message.force),
                            this._gitService.getCommitFilesWithStats(message.hash, !!message.force)
                        ]);
                        this._post({ command: 'setDetail', commit, files });
                    } catch (error) {
                        vscode.window.showErrorMessage(t('view.loadDetailFailed', { error: String(error) }));
                    } finally {
                        this._postLoading('detail', false);
                    }
                    break;
                case 'selectCommits':
                    // Handle multi-select commits
                    this._postLoading('multiCommits', true);
                    try {
                        const hashes: string[] = message.hashes || [];
                        if (hashes.length === 0) {
                            this._post({ command: 'multiCommitsResponse', commits: [], files: [] });
                            break;
                        }
                        
                        // Fetch all commits and their files in parallel
                        const results = await Promise.all(
                            hashes.map(hash => 
                                Promise.all([
                                    this._gitService.getCommitDetail(hash),
                                    this._gitService.getCommitFilesWithStats(hash)
                                ])
                            )
                        );
                        
                        const commits = results.map(([commit]) => commit);
                        const allFiles = results.flatMap(([, files]) => files);
                        
                        this._post({ 
                            command: 'multiCommitsResponse', 
                            commits, 
                            files: allFiles 
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage(t('view.loadDataFailed', { error: String(error) }));
                    } finally {
                        this._postLoading('multiCommits', false);
                    }
                    break;
                case 'refreshBranches':
                    await this._refreshBranchesOnly();
                    break;
                case 'ready':
                    this._webviewReady = true;
                    if (this._initialInProgress) {
                        this._post({ command: 'setInProgress', inProgress: this._initialInProgress });
                    }
                    {
                        // Restore persisted view state (selection, scroll, folds) within the session TTL
                        const saved = this._restorableState();
                        if (saved) {
                            this._post({ command: 'restoreViewState', state: saved });
                        }
                    }
                    {
                        // Restore cherry-pick resume state if valid and conflicts are resolved
                        const resumeState = this._gitService.loadCherryPickResume(this._memento);
                        if (resumeState && resumeState.remainingHashes.length > 0) {
                            // Verify cherry-pick conflicts have been resolved (CHERRY_PICK_HEAD removed)
                            const repoPath = this._gitService.repositoryPath;
                            if (repoPath) {
                                const fs = require('fs');
                                const path = require('path');
                                const hasCherryPickHead = fs.existsSync(path.join(repoPath, '.git', 'CHERRY_PICK_HEAD'));
                                
                                // Only show resume button when conflicts are resolved (no CHERRY_PICK_HEAD)
                                if (!hasCherryPickHead) {
                                    this._post({ 
                                        command: 'showCherryPickResume', 
                                        remainingHashes: resumeState.remainingHashes, 
                                        conflictHash: resumeState.conflictHash 
                                    });
                                } else {
                                    // Conflicts still exist - don't show resume button yet
                                    // User needs to resolve in SCM first
                                }
                            }
                        }
                    }
                    if (this._pendingReveal) {
                        const hash = this._pendingReveal;
                        this._pendingReveal = undefined;
                        this._post({ command: 'revealCommit', hash });
                    }
                    break;
                case 'saveViewState':
                    this._pendingViewState = message.state;
                    if (this._viewStateTimer) {clearTimeout(this._viewStateTimer);}
                    this._viewStateTimer = setTimeout(() => this._flushViewState(), 400);
                    break;
                case 'refreshFiles': {
                    const hash = message.hash;
                    if (!hash) {break;}
                    this._postLoading('detail', true);
                    try {
                        const [commit, files] = await Promise.all([
                            this._gitService.getCommitDetail(hash, true),
                            this._gitService.getCommitFilesWithStats(hash, true)
                        ]);
                        this._post({ command: 'setDetail', commit, files });
                    } catch (error) {
                        vscode.window.showErrorMessage(t('view.refreshFilesFailed', { error: String(error) }));
                    } finally {
                        this._postLoading('detail', false);
                    }
                    break;
                }
                case 'action':
                    await this._runAction(message);
                    break;
                case 'getCommitFilesForPush': {
                    const hash = message.hash;
                    if (!hash) {break;}
                    try {
                        const files = await this._gitService.getCommitFilesWithStats(hash, false);
                        const simpleFiles = files.map(f => ({ path: f.path, status: f.status || '' }));
                        this._post({ command: 'pushFilesResponse', hash, files: simpleFiles });
                    } catch {
                        this._post({ command: 'pushFilesResponse', hash, files: [] });
                    }
                    break;
                }
            }
        });

        // Step 1: Show skeleton UI immediately (no git commands)
        webviewView.webview.html = this._getSkeletonHtml();
        
        // Step 1.5: Detect in-progress operation (merge/rebase/cherry-pick) in background;
        // delivered to the webview when it reports 'ready' (messages sent before the
        // webview script loads can be dropped)
        this._gitService.getInProgressOperation()
            .then(op => {
                this._initialInProgress = op || null;
                if (this._view && this._webviewReady) {
                    this._post({ command: 'setInProgress', inProgress: this._initialInProgress });
                }
            })
            .catch(() => {});

        // Step 2 & 3: Load branches AND commits in parallel for maximum speed
        // Both operations run concurrently, each updates the UI when ready.
        // Restore the previously viewed branch first so the initial commit
        // load targets it directly (Git Graph-style state restoration),
        // but only when the snapshot is within the session TTL window.
        const savedView = this._restorableState();
        if (savedView?.branch) {
            this._branch = savedView.branch;
        }
        Promise.all([
            this._loadAndDisplayBranches(),
            this._loadAndDisplayCommits()
        ]).catch(error => {
            vscode.window.showErrorMessage(t('view.loadDataFailed', { error: String(error) }));
        });
        
        // Step 4: Async refresh divergence data (non-blocking, updates arrows when ready)
        setTimeout(() => {
            void this._refreshDivergence();
        }, 100);

        // Re-query (current branch included) every time the panel is shown again
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._reload(true);
                this._startBranchCheck();
            } else {
                this._stopBranchCheck();
                this._flushViewState();
                // Git Graph-style hide cleanup: drop heavy per-commit payloads
                // (file stats, details) but keep the lightweight commit index
                this._gitService.releaseHeavyCaches();
            }
        });
    }

    private _flushViewState(): void {
        if (this._viewStateTimer) {
            clearTimeout(this._viewStateTimer);
            this._viewStateTimer = undefined;
        }
        if (this._pendingViewState) {
            this._pendingViewState.savedAt = Date.now();
            void this._memento.update('idea-git.viewState', this._pendingViewState);
            this._pendingViewState = undefined;
        }
    }

    /**
     * Read the persisted view state, but only honour it when it was saved within
     * the session TTL window. Expired snapshots are dropped so a reopen after a long
     * absence starts from a clean state instead of a stale branch/selection.
     */
    private _restorableState(): PersistedViewState | undefined {
        const saved = this._memento.get<PersistedViewState>('idea-git.viewState');
        if (!saved) {return undefined;}
        if (typeof saved.savedAt !== 'number' || Date.now() - saved.savedAt > GraphViewProvider.SESSION_RESTORE_TTL_MS) {
            void this._memento.update('idea-git.viewState', undefined);
            return undefined;
        }
        return saved;
    }

    /**
     * Watch .git/HEAD for external branch switches (CLI, other tools).
     * Falls back to 2s polling when the watcher cannot be set up.
     */
    private _startBranchCheck(): void {
        this._stopBranchCheck(); // Clear any existing watcher/timer

        // Record current branch
        this._gitService.getCurrentBranch().then(branch => {
            this._lastKnownBranch = branch;
        });

        const repoPath = this._gitService.repositoryPath;
        const headFile = repoPath ? path.join(repoPath, '.git', 'HEAD') : undefined;
        if (headFile && fs.existsSync(headFile)) {
            try {
                this._headWatcher = fs.watch(headFile, () => {
                    if (this._headDebounce) {clearTimeout(this._headDebounce);}
                    this._headDebounce = setTimeout(() => void this._checkBranchNow(), 300);
                });
                this._headWatcher.on('error', () => this._startBranchPolling());
                return;
            } catch {
                // Fall through to polling
            }
        }
        this._startBranchPolling();
    }

    private _startBranchPolling(): void {
        if (this._branchCheckTimer) {return;} // Already polling
        this._branchCheckTimer = setInterval(() => void this._checkBranchNow(), 2000);
    }

    private async _checkBranchNow(): Promise<void> {
        // Skip checks if within cooldown period (e.g., after rename operation)
        if (Date.now() < this._skipBranchCheckUntil) {
            return;
        }

        try {
            const currentBranch = await this._gitService.getCurrentBranch();
            if (currentBranch && currentBranch !== this._lastKnownBranch) {
                logger.info(`[GitCharm] Branch changed externally: ${this._lastKnownBranch} -> ${currentBranch}`);
                this._lastKnownBranch = currentBranch;

                // Update webview with new current branch
                if (this._view) {
                    this._post({ command: 'setCurrentBranch', branch: currentBranch });

                    // Also refresh branches to update highlight
                    void this._reloadBranchesOnly();
                }
            }
        } catch (err) {
            // Ignore errors during branch check
        }
    }

    /**
     * Pause branch checking for a specified duration (ms).
     * Used after operations like rename that temporarily confuse vscode.git state.
     */
    pauseBranchCheck(durationMs: number): void {
        this._skipBranchCheckUntil = Date.now() + durationMs;
    }

    /**
     * Stop branch detection (watcher and/or polling timer).
     */
    private _stopBranchCheck(): void {
        if (this._headWatcher) {
            this._headWatcher.close();
            this._headWatcher = undefined;
        }
        if (this._headDebounce) {
            clearTimeout(this._headDebounce);
            this._headDebounce = undefined;
        }
        if (this._branchCheckTimer) {
            clearInterval(this._branchCheckTimer);
            this._branchCheckTimer = undefined;
        }
    }

    dispose(): void {
        this._stopBranchCheck();
        this._flushViewState();
    }

    /**
     * Context-menu actions from the webview reuse the palette commands by
     * passing them a node-shaped argument they already understand.
     */
    private async _runAction(message: Extract<WebviewToExtMessage, { command: 'action' }>) {
        const branchNode = { name: message.branch, label: message.branch };
        const commitNode = { hash: message.hash, label: message.hash?.substring(0, 7) };
        // checkout changes HEAD, so the current branch must be re-queried, not cached
        let forceReload = false;
        try {
            switch (message.action) {
                case 'continueOperation':
                    await vscode.commands.executeCommand('idea-git.continueOperation');
                    break;
                case 'abortOperation':
                    await vscode.commands.executeCommand('idea-git.abortOperation');
                    break;
                case 'checkout':
                    await vscode.commands.executeCommand('idea-git.checkoutBranch', branchNode);
                    // Update branch to current after checkout
                    try {
                        this._branch = await this._gitService.getCurrentBranch();
                    } catch {}
                    forceReload = true;
                    break;
                case 'push':
                    await vscode.commands.executeCommand('idea-git.pushBranch', branchNode);
                    break;
                case 'pull':
                    await vscode.commands.executeCommand('idea-git.pullBranch', branchNode);
                    break;
                case 'fetch':
                    await vscode.commands.executeCommand('idea-git.fetch');
                    break;
                case 'merge':
                    await vscode.commands.executeCommand('idea-git.mergeBranch', branchNode);
                    forceReload = true;
                    break;
                case 'rebase':
                    await vscode.commands.executeCommand('idea-git.rebaseOnto', branchNode);
                    forceReload = true;
                    break;
                case 'update': {
                    await vscode.commands.executeCommand('idea-git.updateBranch', branchNode);
                    // Check if pulled branch matches current display branch
                    const branchName = message.branch || '';
                    if (branchName && this._branch && branchName === this._branch) {
                        // If pulling current branch, refresh commit list
                        forceReload = true;
                    } else if (branchName) {
                        // If pulling other branch, just clear its cache without reloading
                        this._gitService.clearBranchGraphCache(branchName);
                        return; // Don't call _reload() for other branches
                    }
                    break;
                }
                case 'commit':
                    await vscode.commands.executeCommand('idea-git.commitBranch', branchNode);
                    break;
                case 'rename':
                    await vscode.commands.executeCommand('idea-git.renameBranch', branchNode);
                    break;
                case 'deleteBranch':
                    await vscode.commands.executeCommand('idea-git.deleteBranch', branchNode);
                    break;
                case 'newBranchFrom':
                    await vscode.commands.executeCommand('idea-git.newBranchFrom', message.branch ? branchNode : commitNode);
                    forceReload = true;
                    break;
                case 'compareBranch':
                    await vscode.commands.executeCommand('idea-git.compareBranch', branchNode);
                    return;
                case 'showDiff':
                    await vscode.commands.executeCommand('idea-git.showCommitDiff', commitNode);
                    return;
                case 'cherryPick': {
                    // Pass multiple hashes if present
                    const cherryPickNode = message.hashes && message.hashes.length > 1 
                        ? { hashes: message.hashes, label: `${message.hashes.length} commits` }
                        : commitNode;
                    await vscode.commands.executeCommand('idea-git.cherryPick', cherryPickNode);
                    forceReload = true;
                    break;
                }
                case 'reset':
                    await vscode.commands.executeCommand('idea-git.resetToCommit', commitNode);
                    forceReload = true;
                    break;
                case 'dropCommit': {
                    // Pass multiple hashes if present
                    const dropNode = message.hashes && message.hashes.length > 1
                        ? { hashes: message.hashes, label: `${message.hashes.length} commits` }
                        : commitNode;
                    await vscode.commands.executeCommand('idea-git.dropCommit', dropNode);
                    forceReload = true;
                    break;
                }
                case 'squashCommits': {
                    // Pass multiple hashes for squash operation
                    const squashNode = message.hashes && message.hashes.length > 0
                        ? { hashes: message.hashes, label: `${message.hashes.length} commits` }
                        : commitNode;
                    await vscode.commands.executeCommand('idea-git.squashCommits', squashNode);
                    forceReload = true;
                    break;
                }
                case 'resumeCherryPick': {
                    // Resume cherry-pick after conflict resolution
                    const remainingHashes = message.remainingHashes || [];
                    if (remainingHashes.length > 0) {
                        // Verify conflicts have been resolved (CHERRY_PICK_HEAD should not exist)
                        try {
                            const repoPath = this._gitService.repositoryPath;
                            if (repoPath) {
                                const fs = require('fs');
                                const path = require('path');
                                const hasCherryPickHead = fs.existsSync(path.join(repoPath, '.git', 'CHERRY_PICK_HEAD'));
                                
                                if (hasCherryPickHead) {
                                    // Conflicts still exist - user needs to resolve them first
                                    vscode.window.showWarningMessage(t('cherryPick.resolveConflictsFirst'));
                                    return;
                                }
                            }
                            
                            await vscode.commands.executeCommand('idea-git.cherryPick', { hashes: remainingHashes });
                            forceReload = true;
                        } catch (error: any) {
                            vscode.window.showErrorMessage(t('cherryPick.resumeFailed', { error: String(error) }));
                        }
                    }
                    break;
                }
                case 'interactiveRebase':
                    await vscode.commands.executeCommand('idea-git.interactiveRebase');
                    forceReload = true;
                    break;
                case 'editMessage':
                    await vscode.commands.executeCommand('idea-git.editCommitMessage', commitNode);
                    forceReload = true;
                    break;
                case 'fileDiff':
                    this._gitService.selectedCommitHash = message.hash;
                    await vscode.commands.executeCommand('idea-git.openFileDiff', { relativePath: message.path });
                    return;
                case 'fileCompareLocal': {
                    const hash = message.hash;
                    const relPath = message.path;
                    if (!hash || !relPath) { return; }
                    const repoPath = this._gitService.repositoryPath;
                    if (!repoPath) { return; }
                    try {
                        const localUri = vscode.Uri.file(path.join(repoPath, relPath));
                        const fileName = relPath.split('/').pop() || relPath;
                        const title = `${fileName} (${hash.substring(0, 7)} ↔ ${t('ext.workingTree')})`;
                        await vscode.commands.executeCommand('vscode.diff', this._gitBlobUri(hash, relPath), localUri, title);
                    } catch (err) {
                        vscode.window.showErrorMessage(t('view.openDiffFailed', { error: String(err) }));
                    }
                    return;
                }
                case 'fileCherryPick': {
                    const hash = message.hash;
                    const relPath = message.path;
                    if (!hash || !relPath) { return; }
                    try {
                        await this._gitService.checkoutFileFromCommit(hash, relPath);
                        const fileName = relPath.split('/').pop() || relPath;
                        vscode.window.showInformationMessage(t('cherryPick.fileSuccess', { file: fileName }));
                    } catch (err) {
                        vscode.window.showErrorMessage(t('cherryPick.fileFailed', { error: String(err) }));
                    }
                    return;
                }
            }
            await this._reload(forceReload);
        } catch (error) {
            vscode.window.showErrorMessage(t('view.actionFailed', { error: String(error) }));
        }
    }

    private async _collect(force: boolean = false): Promise<GraphPayload> {
        logger.debug(`[GitCharm] _collect called with branch=${this._branch || 'all'}, force=${force}`);
        logger.debug(`[GitCharm] Filters: from=${this._filters.from}, to=${this._filters.to}, author=${this._filters.author}, text=${this._filters.text}`);
        const [graphData, details] = await Promise.all([
            this._gitService.getCommitGraphData({
                limit: GraphViewProvider.PAGE_FIRST,
                branch: this._branch,
                filters: this._filters,
                force
            }),
            this._gitService.getBranchesWithDetails(force)
        ]);
        logger.debug(`[GitCharm] _collect got ${graphData.commits.length} commits for branch=${this._branch || 'all'}`);
        let headHash = '';
        try {
            headHash = await this._gitService.getHeadHash();
        } catch { /* empty repo */ }
        
        // Check for in-progress rebase/merge/cherry-pick operation
        let inProgress: 'rebase' | 'merge' | 'cherry-pick' | undefined;
        try {
            inProgress = await this._gitService.getInProgressOperation();
        } catch (error) {
            // Ignore errors
        }
        
        this._loaded = graphData.commits.length;
        this._hasMore = graphData.commits.length >= GraphViewProvider.PAGE_FIRST;
        this._loadedHashes = new Set(graphData.commits.map(c => c.hash));
        const repoPath = this._gitService.repositoryPath;
        return {
            commits: graphData.commits,
            local: details.local.map(b => b.name),
            remote: details.remote.map(b => b.name),
            currentBranch: details.current,
            selectedBranch: this._branch || '',
            repoName: repoPath ? path.basename(repoPath) : '',
            hasMore: this._hasMore,
            headHash,
            inProgress
        };
    }

    /**
     * Fetch the next page of commits and report whether more remain.
     */
    private async _loadMore(): Promise<void> {
        if (this._loadingMore || !this._hasMore || !this._view) {return;}
        this._loadingMore = true;
        try {
            const data = await this._gitService.getCommitGraphData({
                limit: GraphViewProvider.PAGE_MORE,
                skip: this._loaded,
                branch: this._branch,
                filters: this._filters
            });
            this._loaded += data.commits.length;
            this._hasMore = data.commits.length >= GraphViewProvider.PAGE_MORE;
            for (const c of data.commits) {this._loadedHashes.add(c.hash);}
            this._post({ command: 'appendCommits', commits: data.commits, hasMore: this._hasMore });
        } catch (error) {
            vscode.window.showErrorMessage(t('view.loadMoreFailed', { error: String(error) }));
        } finally {
            this._loadingMore = false;
        }
    }

    private async _reload(force: boolean = false) {
        if (!this._view) {return;}
        logger.debug(`[GitCharm] _reload called with branch=${this._branch || 'all'}, force=${force}`);
        this._postLoading('rows', true);
        try {
            const payload = await this._collect(force);
            logger.debug(`[GitCharm] _reload sending setData with ${payload.commits.length} commits`);
            
            // Include search context if filters are active
            const hasSearchFilter = !!this._filters?.text;
            this._post({
                command: 'setData',
                ...payload,
                searchContext: hasSearchFilter ? {
                    query: this._filters.text,
                    resultCount: payload.commits.length
                } : undefined
            });
            this._refreshDivergence();
        } catch (error) {
            vscode.window.showErrorMessage(t('view.loadCommitsFailed', { error: String(error) }));
        } finally {
            this._postLoading('rows', false);
        }
    }

    /**
     * Reload only branches without affecting commits.
     */
    private async _reloadBranchesOnly(): Promise<void> {
        if (!this._view) {return;}
        
        // Show loading indicator for branches area only
        this._postLoading('branches', true);
        
        try {
            const details = await this._gitService.getBranchesWithDetails(true);
            
            // Send only branch data, don't affect commits
            this._post({
                command: 'setBranches',
                local: details.local.map(b => b.name),
                remote: details.remote.map(b => b.name),
                currentBranch: details.current
            });
            
            // Async refresh divergence after branches are updated (non-blocking)
            setTimeout(() => {
                void this._refreshDivergence();
            }, 50);
        } catch (error) {
            vscode.window.showErrorMessage(t('view.loadBranchesFailed', { error: String(error) }));
        } finally {
            this._postLoading('branches', false);
        }
    }

    /**
     * Generate skeleton UI HTML immediately (no git commands).
     */
    private _getSkeletonHtml(): string {
        const repoName = this._gitService.repositoryPath 
            ? path.basename(this._gitService.repositoryPath) 
            : 'Git';
        
        return this._getHtmlForWebview({
            commits: [],
            local: [],
            remote: [],
            currentBranch: '',
            selectedBranch: '',
            repoName,
            hasMore: false,
            headHash: '',
            inProgress: undefined
        });
    }

    /**
     * Load branches in background and update webview when ready.
     */
    private async _loadAndDisplayBranches(): Promise<void> {
        if (!this._view) {return;}
        
        try {
            // Get cached branch data (fast, no git commands if cache hit)
            const detailsPromise = this._gitService.getBranchesWithDetails(false);
            
            // Get head hash in parallel (may require git command, but don't block branches)
            const headHashPromise = this._gitService.getHeadHash().catch(() => '');
            
            // Update branches immediately when ready
            const details = await detailsPromise;
            this._post({
                command: 'setBranches',
                local: details.local.map(b => b.name),
                remote: details.remote.map(b => b.name),
                currentBranch: details.current
            });

            // Update head hash separately when ready (don't wait for it)
            const headHash = await headHashPromise;
            if (headHash) {
                this._post({ command: 'setHeadHash', headHash });
            }
        } catch (error) {
            vscode.window.showErrorMessage(t('view.loadBranchesFailed', { error: String(error) }));
        }
    }

    /**
     * Generate initial HTML with branches only, commits will load asynchronously.
     */
    private async _getInitialHtml(): Promise<string> {
        try {
            // Load branches, head hash, and in-progress operation in parallel for speed
            const [details, headHash, inProgress] = await Promise.all([
                this._gitService.getBranchesWithDetails(false),
                this._gitService.getHeadHash().catch(() => ''),
                this._gitService.getInProgressOperation().catch(() => undefined)
            ]);
            
            const repoPath = this._gitService.repositoryPath;
            
            // Create payload with empty commits (will be filled later)
            const payload: GraphPayload = {
                commits: [],
                local: details.local.map(b => b.name),
                remote: details.remote.map(b => b.name),
                currentBranch: details.current,
                selectedBranch: this._branch || '',
                repoName: repoPath ? path.basename(repoPath) : '',
                hasMore: false,
                headHash,
                inProgress
            };
            
            return this._getHtmlForWebview(payload);
        } catch (error) {
            // Fallback to empty state if branches fail to load
            vscode.window.showErrorMessage(t('view.loadBranchesFailed', { error: String(error) }));
            return this._getHtmlForWebview({
                commits: [],
                local: [],
                remote: [],
                currentBranch: '',
                selectedBranch: '',
                repoName: '',
                hasMore: false,
                headHash: '',
                inProgress: undefined
            });
        }
    }

    /**
     * Load commits in background and update webview when ready.
     */
    private async _loadAndDisplayCommits(): Promise<void> {
        if (!this._view) {return;}
        
        const startTime = Date.now();
        logger.debug('[GitCharm] Starting commit load...');
        
        // Show loading indicator for commits area
        this._postLoading('rows', true);
        
        try {
            const fetchStart = Date.now();
            const graphData = await this._gitService.getCommitGraphData({
                limit: GraphViewProvider.PAGE_FIRST,
                branch: this._branch,
                filters: this._filters,
                force: false
            });
            const fetchTime = Date.now() - fetchStart;
            logger.debug(`[GitCharm] Git fetch took ${fetchTime}ms, got ${graphData.commits.length} commits`);
            
            this._loaded = graphData.commits.length;
            this._hasMore = graphData.commits.length >= GraphViewProvider.PAGE_FIRST;
            this._loadedHashes = new Set(graphData.commits.map(c => c.hash));
            
            // Update webview with commits
            const postStart = Date.now();
            this._post({
                command: 'setCommits',
                commits: graphData.commits,
                hasMore: this._hasMore
            });
            const postTime = Date.now() - postStart;
            
            const totalTime = Date.now() - startTime;
            logger.debug(`[GitCharm] Total commit load: ${totalTime}ms (fetch: ${fetchTime}ms, postMessage: ${postTime}ms)`);
        } catch (error) {
            vscode.window.showErrorMessage(t('view.loadCommitsFailed', { error: String(error) }));
        } finally {
            this._postLoading('rows', false);
        }
    }

    /**
     * Refresh only the branch tree without reloading commits.
     */
    private async _refreshBranchesOnly(): Promise<void> {
        if (!this._view) {return;}
        try {
            const details = await this._gitService.getBranchesWithDetails(true);
            this._post({
                command: 'setBranches',
                local: details.local.map(b => b.name),
                remote: details.remote.map(b => b.name)
            });
            // Also refresh divergence info (ahead/behind arrows)
            await this._refreshDivergence();
        } catch (error) {
            vscode.window.showErrorMessage(t('view.refreshBranchesFailed', { error: String(error) }));
        }
    }

    /**
     * Tell the webview to show/hide a "loading" hint for a region. The webview
     * delays showing it briefly so fast operations never flicker a spinner.
     */
    private _postLoading(area: 'rows' | 'detail' | 'branches' | 'search' | 'multiCommits', on: boolean): void {
        this._post({ command: 'loading', area, on });
    }

    /**
     * Background-compute each local branch's ahead/behind versus its upstream so
     * the tree can show push/pull arrows without blocking the main data load.
     */
    private async _refreshDivergence(): Promise<void> {
        if (!this._view) {return;}
        try {
            // Use lightweight method that only queries divergence info (much faster than full branch details)
            const divergenceMap = await this._gitService.getDivergenceInfo();
            
            logger.debug('[GitCharm] Divergence info:', JSON.stringify(divergenceMap));
            
            // Convert to the format expected by webview
            const divergence: Record<string, { ahead: number; behind: number }> = {};
            for (const [branchName, info] of Object.entries(divergenceMap)) {
                if (info.ahead > 0 || info.behind > 0) {
                    divergence[branchName] = { ahead: info.ahead, behind: info.behind };
                }
            }
            
            logger.debug('[GitCharm] Sending divergence to webview:', JSON.stringify(divergence));
            this._post({ command: 'setDivergence', divergence });
        } catch (error) {
            logger.debug('[GitCharm] Failed to refresh divergence:', error);
        }
    }

    private _getHtmlForWebview(payload: GraphPayload): string {
        const webview = this._view?.webview;
        const cssUri = webview
            ? webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.css'))
            : 'media/webview.css';
        const jsUri = webview
            ? webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.js'))
            : 'media/webview.js';
        const nonce = this._nonce();
        const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');
        const i18nJson = JSON.stringify(webviewStrings()).replace(/</g, '\\u003c');
        const htmlLang = getLocale() === 'zh-cn' ? 'zh-CN' : 'en';

        return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Git Log</title>
    <link rel="stylesheet" href="${cssUri}">
</head>
<body>
    <div id="main">
        <div id="left">
            <div id="operation-status" style="display: none;">
                <span class="op-status-icon">⚠️</span>
                <span id="operation-status-text"></span>
            </div>
            <div id="bf-row">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h12l-4.5 5.5V14l-3-1.5V8.5z"/></svg>
                <input id="f-bfilter" type="text" placeholder="${t('ui.filterBranches')}">
                <button class="clr" style="display:none" id="clr-bfilter" title="${t('ui.clear')}" type="button">&#10005;</button>
                <button class="col-refresh" id="rf-branch" title="${t('ui.refreshBranches')}">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 1.5v3h-3"/></svg>
                </button>
            </div>
            <div id="btree"></div>
        </div>
        <div class="resizer" id="resizer-left"></div>
        <div id="center">
            <div id="cbar">
                <label class="tb">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14.5" y2="14.5"/></svg>
                    <input id="f-search" type="text" placeholder="${t('ui.searchCommits')}">
                    <button class="clr" style="display:none" id="clr-search" title="${t('ui.clear')}" type="button">&#10005;</button>
                </label>
                <div class="tb author-dropdown-wrapper">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/></svg>
                    <input id="f-author" type="text" placeholder="${t('ui.author')}" autocomplete="off">
                    <div id="author-dropdown" class="author-dropdown"></div>
                    <button class="clr" style="display:none" id="clr-author" title="${t('ui.clear')}" type="button">&#10005;</button>
                </div>
                <label class="tb date">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1"/><line x1="2" y1="6.5" x2="14" y2="6.5"/><line x1="5.5" y1="1.5" x2="5.5" y2="4"/><line x1="10.5" y1="1.5" x2="10.5" y2="4"/></svg>
                    <input id="f-from" type="date" title="${t('ui.fromDate')}">
                    <span class="arrow">&#8594;</span>
                    <input id="f-to" type="date" title="${t('ui.toDate')}">
                    <button class="clr" style="display:none" id="clr-date" title="${t('ui.clearDate')}" type="button">&#10005;</button>
                </label>
                <button id="btn-refresh" title="${t('ui.refreshCommits')}">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 1.5v3h-3"/></svg>
                </button>
            </div>
            <div id="scroll"><div id="rows"></div><div id="loader"><span class="spin"></span>${t('ui.loading')}</div><div id="rows-busy" class="busy"><span class="spin"></span>${t('ui.loadingCommits')}</div></div>
        </div>
        <div class="resizer" id="resizer-right"></div>
        <div id="right">
            <div class="repo-row">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 1.5h6l3 3v10h-9z"/></svg>
                <span id="repo-name"></span>
                <button class="col-refresh" id="tg-files" title="${t('ui.showCommitFiles')}" style="margin-left:auto">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>
                </button>
                <button class="col-refresh" id="rf-files" title="${t('ui.refreshFiles')}">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 1.5v3h-3"/></svg>
                </button>
            </div>
            <div id="d-busy" class="busy"><span class="spin"></span>${t('ui.loadingCommitFiles')}</div>
            <div id="d-files"></div>
            <div class="resizer-v" id="resizer-info"></div>
            <div id="d-info"></div>
        </div>
    </div>
    <script nonce="${nonce}">window.__INITIAL__=${payloadJson};window.I18N_STRINGS=${i18nJson};</script>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }

    /** Re-render the webview with the active locale (language switch). The
     *  ready handshake + persisted view state restore the UI afterwards. */
    public relocalize(): void {
        if (this._view) {
            this._view.webview.html = this._getSkeletonHtml();
        }
    }

    private _nonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 32; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
}
