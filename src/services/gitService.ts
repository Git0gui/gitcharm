import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { runGit, splitNul, GitRunOptions } from './gitRunner';
import { RefsReader } from './refsReader';
import { PersistedBranchCache } from './persistedBranchCache';
import { resolveCommonDir, resolveGitDir } from './gitPaths';
import { logger } from './logger';
import {
    GitCommit,
    assertShellSafe,
    assertRef,
    assertHash,
    LruCache,
    parseLogLine,
    parseGraphLine,
    parseTrackInfo,
    parseSymbolicRef,
    parseRefPath,
    parseWorkingTreeSummary,
    WorkingTreeSummary
} from './gitUtils';
import { t } from '../i18n';

export {
    GitCommit,
    assertShellSafe,
    assertRef,
    assertHash,
    LruCache,
    parseLogLine,
    parseGraphLine
} from './gitUtils';

export interface GraphCommit {
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    date: string;
    parents: string[];
    refs: string[];
    isMerge: boolean;
}

export interface GraphData {
    commits: GraphCommit[];
    branches: string[];
}

export interface LogFilters {
    text?: string;
    author?: string;
    from?: string;
    to?: string;
}

export interface LogOptions {
    limit?: number;
    skip?: number;
    branch?: string;
    filters?: LogFilters;
    force?: boolean;
}

export interface BranchDetails {
    current: string;
    local: Array<{ name: string; upstream?: string; ahead: number; behind: number }>;
    remote: Array<{ name: string }>;
}

type BranchTrackMap = Map<string, { upstream?: string; ahead: number; behind: number }>;

export interface FileStat {
    status: string;
    path: string;
    added: number;
    deleted: number;
}

export interface CommitDetail {
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    authorEmail: string;
    authorDate: string;
    committer?: string;
    committerEmail?: string;
    committerDate?: string;
}

function q(value: string): string {
    return `"${value}"`;
}

/** Git dir writes arrive in bursts (one command touches several files). */
const WATCH_DEBOUNCE_MS = 250;

/** Top-level git dir files whose contents the caches depend on. */
const WATCHED_STATE_FILES = new Set(['HEAD', 'index', 'packed-refs', 'commondir']);

export class GitService {
    /** Max cached entries per cache (branch list / commit log / per-commit files). */
    static readonly CACHE_MAX = 20; // Reduced from 30 to save memory
    
    private _repositoryPath: string | undefined;
    private _selectedBranch: string | undefined;
    private _selectedCommitHash: string | undefined;
    private _commitSearchKeyword: string | undefined;
    private _authorFilter: string | undefined;
    private _dateFromFilter: string | undefined;
    private _dateToFilter: string | undefined;

    // Volatile caches: invalidated whenever history/refs change
    private _graphCache = new LruCache<GraphData>(GitService.CACHE_MAX);
    private _branchCache = new LruCache<BranchDetails>(GitService.CACHE_MAX);
    // Immutable caches: keyed by commit hash, safe until evicted
    private _filesCache = new LruCache<FileStat[]>(GitService.CACHE_MAX);
    private _detailCache = new LruCache<CommitDetail>(GitService.CACHE_MAX);

    // Commit index cache: bounded LRU to avoid unbounded growth
    private _commitIndex = new LruCache<GraphCommit>(200); // Reduced from 500 to save memory
    
    // Refs reader: branch/tag mappings straight from .git filesystem (TTL-cached)
    private _refsReader = new RefsReader(() => this._repositoryPath);
    private _trackInfoCache: { at: number; map: BranchTrackMap } | undefined;
    private _trackInfoPromise: Promise<BranchTrackMap> | undefined;
    // Persistent branch cache (workspaceState Memento, versioned payload)
    private _persistedCache: PersistedBranchCache;
    
    // Cherry-pick resume state: persisted to workspaceState for crash recovery
    private static readonly CHERRY_PICK_RESUME_KEY = 'git-charm.cherryPickResume';

    // Git-root discovery is a filesystem walk; memoize per start dir
    private _rootMemo = new Map<string, string | undefined>();
    private _rootKey: string | undefined;
    private _rootValue: string | undefined;
    // Cached result of the `git --version` probe (undefined = not probed yet)
    private _gitAvailable: boolean | undefined;

    // Git directory watcher: external changes (CLI, other tools) invalidate caches
    private _repoWatchers: fs.FSWatcher[] = [];
    private _watchDebounce: NodeJS.Timeout | undefined;
    private _watchRequested = false;
    private readonly _watchTokens = new Set<symbol>();

    constructor(memento: vscode.Memento) {
        this._persistedCache = new PersistedBranchCache(memento, () => this._repositoryPath);
        this._repositoryPath = this._resolveRoot();

        // Load persisted branch cache on startup
        const cachedBranches = this._persistedCache.load();
        if (cachedBranches && this._repositoryPath) {
            // Note: current branch is not persisted, filled by getBranchesWithDetails
            this._branchCache.set(`${this._repositoryPath}|details`, cachedBranches as BranchDetails);
        }

        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            // Only clear root memo when workspace folders change; keep caches alive
            this._rootMemo.clear();
            this._rootKey = undefined;
            this._rootValue = undefined;
            // Re-resolve root for new workspace
            this._repositoryPath = this._resolveRoot();
            this._startRepositoryWatch();
        });
    }

    /**
     * Watch the git directory so changes made outside this extension (CLI
     * commits, fetches, branch switches by other tools) drop the caches that
     * would otherwise go stale. Replaces the state events we used to borrow
     * from vscode.git; debounced because git writes many files per command.
     */
    watchRepositoryChanges(): vscode.Disposable {
        this._watchRequested = true;
        this._startRepositoryWatch();

        const token = Symbol('gitWatch');
        this._watchTokens.add(token);

        return new vscode.Disposable(() => {
            this._watchTokens.delete(token);
            if (this._watchTokens.size === 0) {
                this._watchRequested = false;
                this._stopRepositoryWatch();
            }
        });
    }

    private _startRepositoryWatch(): void {
        this._stopRepositoryWatch();
        if (!this._watchRequested) {return;}

        const repoPath = this._resolveRoot();
        const gitDir = repoPath ? resolveGitDir(repoPath) : undefined;
        if (!gitDir) {return;}

        // HEAD/index/packed-refs live in the worktree's own git dir; refs may be
        // shared through commondir, so both places get a watcher.
        const targets: Array<{ dir: string; recursive: boolean }> = [
            { dir: gitDir, recursive: false },
            { dir: path.join(resolveCommonDir(gitDir), 'refs'), recursive: true }
        ];
        for (const target of targets) {
            if (!fs.existsSync(target.dir)) {continue;}
            try {
                const watcher = fs.watch(target.dir, { recursive: target.recursive }, (_event, filename) => {
                    if (target.recursive || !filename || WATCHED_STATE_FILES.has(filename.toString())) {
                        this._scheduleWatchInvalidation();
                    }
                });
                // Watching is a nicety: on failure the explicit invalidation after
                // every mutation plus the webview's HEAD poll still keeps UI correct.
                watcher.on('error', () => watcher.close());
                this._repoWatchers.push(watcher);
            } catch { /* platform without watch support */ }
        }
    }

    private _scheduleWatchInvalidation(): void {
        if (this._watchDebounce) {clearTimeout(this._watchDebounce);}
        this._watchDebounce = setTimeout(() => {
            this._watchDebounce = undefined;
            logger.debug('[GitCharm] Git directory changed, volatile caches dropped');
            this.invalidateVolatile();
        }, WATCH_DEBOUNCE_MS);
    }

    private _stopRepositoryWatch(): void {
        for (const watcher of this._repoWatchers) {
            try { watcher.close(); } catch { /* already closed */ }
        }
        this._repoWatchers = [];
        if (this._watchDebounce) {
            clearTimeout(this._watchDebounce);
            this._watchDebounce = undefined;
        }
    }

    get repositoryPath(): string | undefined {
        return this._resolveRoot();
    }

    /**
     * Whether a `git` binary can be spawned at all. Separates "git is not
     * installed / not on PATH" from "this folder is not a repository" so the
     * panel can give the right guidance. The result is cached because the probe
     * runs on a hot path; pass `force` after the user asks to re-check.
     */
    async isGitAvailable(force: boolean = false): Promise<boolean> {
        if (!force && this._gitAvailable !== undefined) {return this._gitAvailable;}
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        try {
            await runGit(['--version'], { cwd, timeoutMs: 8000 });
            this._gitAvailable = true;
        } catch (error) {
            // Only a failed spawn (git missing / not executable) means "no git";
            // a non-zero exit comes from a binary that is installed and working.
            const code = (error as { code?: unknown }).code;
            this._gitAvailable = code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM';
            logger.debug('[GitCharm] git binary probe:', this._gitAvailable, error);
        }
        return this._gitAvailable;
    }

    /**
     * Drop the memoised git-root discovery and re-read the filesystem. Call this
     * after `git init` or when an external tool creates/removes `.git`, so the
     * panel reacts without a restart.
     */
    refreshRepositoryPath(): string | undefined {
        this._rootMemo.clear();
        this._rootKey = undefined;
        this._rootValue = undefined;
        this.clearAllCaches();
        const root = this._resolveRoot();
        // The watcher follows a specific directory, so a new repo (git init, clone)
        // or a removed one needs the watch re-pointed.
        this._startRepositoryWatch();
        return root;
    }

    /**
     * True once at least one commit exists anywhere in the repository. A freshly
     * initialised repo has none, and every history command would fail there.
     */
    async hasAnyCommit(): Promise<boolean> {
        const output = await this.executeGitArgs(['rev-list', '--all', '--max-count=1'], { timeoutMs: 8000 });
        return output.trim() !== '';
    }

    /** Working-tree change counts for the empty-repository guidance page. */
    async getWorkingTreeSummary(): Promise<WorkingTreeSummary> {
        const raw = await this.executeGitArgs(['status', '--porcelain', '-z'], { timeoutMs: 10000 });
        return parseWorkingTreeSummary(raw);
    }

    /**
     * Create a repository in `cwd` (which must not be inside one already).
     * Not repo-scoped, so it runs straight through the runner with an explicit cwd.
     */
    async initRepository(cwd: string): Promise<void> {
        await runGit(['init'], { cwd, timeoutMs: 20000 });
    }

    /**
     * Save cherry-pick resume state to workspaceState for crash recovery.
     */
    saveCherryPickResume(remainingHashes: string[], conflictHash: string, memento: vscode.Memento): void {
        const key = GitService.CHERRY_PICK_RESUME_KEY;
        const value = { remainingHashes, conflictHash, timestamp: Date.now() };
        memento.update(key, value);
    }

    /**
     * Load cherry-pick resume state from workspaceState.
     * Returns null if no saved state or state is stale (> 24 hours).
     */
    loadCherryPickResume(memento: vscode.Memento): { remainingHashes: string[]; conflictHash: string } | null {
        const key = GitService.CHERRY_PICK_RESUME_KEY;
        const value = memento.get<{ remainingHashes: string[]; conflictHash: string; timestamp: number }>(key);
        
        if (!value) {return null;}
        
        // Clear state if older than 24 hours (prevent stale data)
        const age = Date.now() - value.timestamp;
        if (age > 24 * 60 * 60 * 1000) {
            memento.update(key, undefined);
            return null;
        }
        
        return { remainingHashes: value.remainingHashes, conflictHash: value.conflictHash };
    }

    /**
     * Clear cherry-pick resume state after successful completion.
     */
    clearCherryPickResume(memento: vscode.Memento): void {
        memento.update(GitService.CHERRY_PICK_RESUME_KEY, undefined);
    }

    /**
     * Resolve the git root for the current workspace/active editor, re-probing
     * only when the set of candidate start directories changes.
     */
    private _resolveRoot(): string | undefined {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const editorUri = vscode.window.activeTextEditor?.document?.uri;
        const editorDir = editorUri ? require('path').dirname(editorUri.fsPath) : '';
        const key = folders.map(f => f.uri.fsPath).join('\u0000') + '\u0001' + editorDir;
        if (key !== this._rootKey) {
            this._rootKey = key;
            this._rootValue = this._findGitRoot();
        }
        this._repositoryPath = this._rootValue;
        return this._rootValue;
    }

    get selectedBranch(): string | undefined {
        return this._selectedBranch;
    }

    set selectedBranch(branch: string | undefined) {
        this._selectedBranch = branch;
    }

    get selectedCommitHash(): string | undefined {
        return this._selectedCommitHash;
    }

    set selectedCommitHash(hash: string | undefined) {
        this._selectedCommitHash = hash;
    }

    get commitSearchKeyword(): string | undefined {
        return this._commitSearchKeyword;
    }

    set commitSearchKeyword(keyword: string | undefined) {
        this._commitSearchKeyword = keyword;
    }

    get authorFilter(): string | undefined {
        return this._authorFilter;
    }

    set authorFilter(value: string | undefined) {
        this._authorFilter = value;
    }

    get dateFromFilter(): string | undefined {
        return this._dateFromFilter;
    }

    set dateFromFilter(value: string | undefined) {
        this._dateFromFilter = value;
    }

    get dateToFilter(): string | undefined {
        return this._dateToFilter;
    }

    set dateToFilter(value: string | undefined) {
        this._dateToFilter = value;
    }

    /**
     * Check if any search filter is active
     */
    hasActiveFilters(): boolean {
        return !!(this._commitSearchKeyword || this._authorFilter || this._dateFromFilter || this._dateToFilter);
    }

    /**
     * Clear all search filters
     */
    clearAllFilters(): void {
        this._commitSearchKeyword = undefined;
        this._authorFilter = undefined;
        this._dateFromFilter = undefined;
        this._dateToFilter = undefined;
    }

    /**
     * Get full metadata for a single commit
     */
    async getCommitDetail(hash: string, force: boolean = false): Promise<CommitDetail> {
        assertHash(hash);
        const key = `${this._repositoryPath ?? ''}|${hash}`;
        const hit = force ? undefined : this._detailCache.get(key);
        if (hit) {return hit;}

        // Format includes both author and committer info
        // %an=author name, %ae=author email, %ai=author date
        // %cn=committer name, %ce=committer email, %ci=committer date
        const output = (await this.executeGitArgs([
            'show', '-s', '--format=%H|%h|%s|%an|%ae|%ai|%cn|%ce|%ci', hash
        ])).trim();
        const parts = output.split('|');
        
        const detail: CommitDetail = {
            hash: parts[0] || hash,
            shortHash: parts[1] || hash.substring(0, 7),
            message: parts[2] || '',
            author: parts[3] || '',
            authorEmail: parts[4] || '',
            authorDate: parts[5] || '',
            committer: parts[6] || '',
            committerEmail: parts[7] || '',
            committerDate: parts[8] || ''
        };
        
        this._detailCache.set(key, detail);
        return detail;
    }

    /**
     * Check whether a file exists at a given ref (branch/commit)
     */
    async blobExists(ref: string, filePath: string): Promise<boolean> {
        assertShellSafe(ref, t('label.ref'));
        assertShellSafe(filePath, t('label.filePath'));
        try {
            await this.executeGitArgs(['cat-file', '-e', `${ref}:${filePath}`]);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get files changed in a commit together with added/deleted line counts
     */
    async getCommitFilesWithStats(hash: string, force: boolean = false): Promise<FileStat[]> {
        assertHash(hash);
        const key = `${this._repositoryPath ?? ''}|${hash}`;
        const hit = force ? undefined : this._filesCache.get(key);
        if (hit) {return hit;}

        // NUL-delimited plumbing output: stable across versions and safe for
        // paths containing spaces or newlines.
        // --root is required for the initial commit: diff-tree diffs against the
        // first parent, so a parentless commit would otherwise report no files.
        const [nameStatus, numStat] = await Promise.all([
            this.executeGitArgs(['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', '-z', hash]).catch(() => ''),
            this.executeGitArgs(['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--numstat', '-z', hash]).catch(() => '')
        ]);

        // numstat -z entry: "added\tdeleted\tpath"; renames: "added\tdeleted\t" + src + dst tokens
        const stats = new Map<string, { added: number; deleted: number }>();
        const numTokens = splitNul(numStat);
        for (let i = 0; i < numTokens.length; i++) {
            const header = numTokens[i];
            const t1 = header.indexOf('\t');
            const t2 = t1 >= 0 ? header.indexOf('\t', t1 + 1) : -1;
            if (t2 < 0) {continue;}
            let path = header.slice(t2 + 1);
            if (path === '' && i + 2 < numTokens.length + 1) {
                // Rename entry: header path is empty, src and dst follow as tokens
                const dst = numTokens[i + 2] ?? numTokens[i + 1] ?? '';
                i += 2;
                path = dst;
            }
            const added = header.slice(0, t1);
            const deleted = header.slice(t1 + 1, t2);
            stats.set(path, {
                added: added === '-' ? 0 : parseInt(added) || 0,
                deleted: deleted === '-' ? 0 : parseInt(deleted) || 0
            });
        }

        // name-status -z tokens: status, path; renames: status, src, dst
        const files: FileStat[] = [];
        const nsTokens = splitNul(nameStatus);
        for (let i = 0; i < nsTokens.length; i++) {
            const statusToken = nsTokens[i];
            const letter = (statusToken || 'M').charAt(0);
            let path = nsTokens[++i] || '';
            if ((letter === 'R' || letter === 'C') && i + 1 < nsTokens.length) {
                // Display the new name for renames/copies
                path = nsTokens[++i];
            }
            if (!path) {continue;}
            const s = stats.get(path) || { added: 0, deleted: 0 };
            files.push({ status: letter, path, added: s.added, deleted: s.deleted });
        }
        this._filesCache.set(key, files);
        return files;
    }

    /**
     * Find the git root directory.
     * Prioritizes workspace folders over the active editor's file location, and
     * requires a real `.git` layout (HEAD / gitdir redirect) so stale or
     * corrupted `.git` entries do not produce false positives.
     */
    private _findGitRoot(): string | undefined {
        const path = require('path');

        // Collect candidate start directories: workspace folders first, then active editor
        const candidates: string[] = [];

        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            for (const folder of vscode.workspace.workspaceFolders) {
                candidates.push(folder.uri.fsPath);
            }
        }

        const editor = vscode.window.activeTextEditor;
        if (editor?.document?.uri) {
            candidates.push(path.dirname(editor.document.uri.fsPath));
        }

        if (candidates.length === 0) {
            return undefined;
        }

        for (const startDir of candidates) {
            if (this._rootMemo.has(startDir)) {
                const memoized = this._rootMemo.get(startDir);
                if (memoized) {return memoized;}
                continue;
            }
            const root = this._probeRoot(startDir);
            this._rootMemo.set(startDir, root);
            if (root) {return root;}
        }

        return undefined;
    }

    /**
     * Walk up from `startDir` until a directory holding a real `.git` is found.
     * Detection is filesystem-only: spawning git here would make a missing git
     * binary indistinguishable from a folder that simply is not a repository.
     */
    private _probeRoot(startDir: string): string | undefined {
        let currentDir = startDir;
        while (currentDir !== path.dirname(currentDir)) {
            if (this._hasGitDir(path.join(currentDir, '.git'))) {
                return currentDir;
            }
            currentDir = path.dirname(currentDir);
        }
        return undefined;
    }

    /**
     * A `.git` directory is a repository when it carries HEAD; a `.git` file is
     * one when it redirects to a gitdir (worktree / submodule).
     */
    private _hasGitDir(gitPath: string): boolean {
        try {
            const stat = fs.lstatSync(gitPath);
            if (stat.isDirectory()) {
                return fs.existsSync(path.join(gitPath, 'HEAD'));
            }
            if (stat.isFile()) {
                return fs.readFileSync(gitPath, 'utf8').startsWith('gitdir:');
            }
        } catch {
            // Unreadable or absent .git — keep walking up
        }
        return false;
    }

    /**
     * Execute git with an argv array (no shell, no tokenizing). Returns raw
     * stdout untrimmed so NUL-terminated and exact-format output survives.
     */
    async executeGitArgs(args: string[], opts: Omit<GitRunOptions, 'cwd'> = {}): Promise<string> {
        const repo = this._resolveRoot();
        if (!repo) {
            throw new Error('No git repository found');
        }
        return runGit(args, { cwd: repo, ...opts });
    }

    /**
     * Run a git command that mutates history/refs, then drop volatile caches
     * so subsequent reads reflect the new state.
     */
    private async _execMutate(args: string[], opts: Omit<GitRunOptions, 'cwd' | 'env'> = {}): Promise<string> {
        const out = await this.executeGitArgs(args, opts);
        this.invalidateVolatile();
        return out.trim();
    }

    /**
     * Mutating exec with extra environment variables. Needed for GIT_SEQUENCE_EDITOR:
     * the shell `VAR=x git ...` prefix does not work under Windows cmd.exe.
     * No timeout: interactive rebase/merge sequences can be slow on large repos.
     */
    private async _execMutateWithEnv(args: string[], extraEnv: Record<string, string>): Promise<string> {
        const out = await this.executeGitArgs(args, { env: extraEnv, timeoutMs: 0 });
        this.invalidateVolatile();
        return out.trim();
    }

    /**
     * Run a commit/amend taking the message from a temp file so the message
     * content is preserved verbatim (no shell escaping, no character stripping).
     */
    private async _commitWithMessage(args: string[], message: string): Promise<string> {
        const fs = require('fs');
        const tempFile = require('path').join(require('os').tmpdir(), `idea-git-msg-${Date.now()}.txt`);
        fs.writeFileSync(tempFile, message, 'utf8');
        try {
            return await this._execMutate([...args, '-F', tempFile]);
        } finally {
            try { fs.unlinkSync(tempFile); } catch {}
        }
    }

    /**
     * Run `rebase -i` non-interactively by handing git a prepared todo file via
     * GIT_SEQUENCE_EDITOR. Git invokes the editor through its bundled shell,
     * where `cp <prepared> <todo>` replaces the todo; GIT_EDITOR=true keeps the
     * squashed-commit message template from opening an interactive editor.
     */
    private async _runRebaseWithTodo(upstream: string, todo: string): Promise<string> {
        const fs = require('fs');
        const tempFile = require('path').join(require('os').tmpdir(), `idea-git-todo-${Date.now()}.txt`);
        fs.writeFileSync(tempFile, todo, 'utf8');
        try {
            const out = await this._execMutateWithEnv(
                ['rebase', '-i', assertShellSafe(upstream, t('label.rebaseBase'))],
                { GIT_SEQUENCE_EDITOR: `cp ${q(tempFile)}`, GIT_EDITOR: 'true' }
            );
            return out || t('op.rebaseCompleted');
        } finally {
            try { fs.unlinkSync(tempFile); } catch {}
        }
    }

    /**
     * Drop caches whose contents depend on refs/history (commit log).
     * Branch cache is now persistent and only cleared manually or when repo changes.
     */
    invalidateVolatile(): void {
        this._graphCache.clear();
        this._trackInfoCache = undefined;
        // Head hashes must be re-read: divergence checks compare them against
        // remote-tracking refs, and a stale cache hides the arrows.
        this._refsReader.invalidate();
        // Don't clear branch cache - it's now persistent
        // Only clear persisted cache file if needed (but we're keeping it persistent now)
        // this._persistedCache.clear();
    }

    /**
     * Release heavy per-commit payloads (file stats, commit details) while
     * keeping the lightweight commit index — Git Graph-style hide cleanup.
     */
    releaseHeavyCaches(): void {
        this._filesCache.clear();
        this._detailCache.clear();
    }

    /**
     * Drop every cache entry.
     */
    clearAllCaches(): void {
        this.invalidateVolatile();
        this._filesCache.clear();
        this._detailCache.clear();
        this._commitIndex.clear();
    }

    /**
     * Clear graph cache for a specific branch to force refresh on next load.
     * Branch cache is persistent and not affected by this method.
     */
    clearBranchGraphCache(branchName: string): void {
        // Only invalidate graph cache, keep branch cache persistent
        this._graphCache.clear();
    }

    /**
     * Switch to (or create) a branch; invalidates volatile caches.
     */
    async checkout(ref: string, create: boolean = false): Promise<void> {
        assertRef(ref);
        await this._execMutate(['checkout', ...(create ? ['-b'] : []), ref]);
    }

    /**
     * Create and switch to a local branch that tracks a remote ref.
     * Example: checkoutTracking('origin/feature-x') creates local 'feature-x'.
     */
    async checkoutTracking(remoteRef: string): Promise<void> {
        assertRef(remoteRef);
        await this._execMutate(['checkout', '--track', remoteRef]);
    }

    /**
     * Get git log with customizable format
     */
    async getLog(limit: number = 100, filePath?: string, branch?: string): Promise<GitCommit[]> {
        // Format: hash|shortHash|author|email|authorDate|relativeAuthorDate|message|parentHashes
        const format = `%H|%h|%an|%ae|%ai|%ar|%s|%P`;
        // Options must precede the `--` pathspec separator
        const args = ['log', '-n', String(limit), branch || 'HEAD', `--format=${format}`];
        if (filePath) {args.push('--', filePath);}
        const output = (await this.executeGitArgs(args)).trim();

        if (!output) {
            return [];
        }

        const commits: GitCommit[] = [];
        for (const line of output.split('\n')) {
            if (!line.trim()) {continue;}
            const commit = parseLogLine(line);
            if (commit) {commits.push(commit);}
        }

        // Fetch branch refs for each commit
        await this._populateBranchRefs(commits);

        return commits;
    }

    /**
     * Populate branch references for commits using for-each-ref (much faster than branch --contains)
     */
    private async _populateBranchRefs(commits: GitCommit[]): Promise<void> {
        try {
            const commitSet = new Set(commits.map(c => c.hash));
            const branchOutput = await this.executeGitArgs([
                'for-each-ref', 'refs/heads/', 'refs/remotes/', '--format=%(objectname) %(refname:short)'
            ]);

            if (!branchOutput) {return;}

            const branchMap = new Map<string, string[]>();
            for (const line of branchOutput.split('\n')) {
                if (!line.trim()) {continue;}
                const spaceIdx = line.indexOf(' ');
                if (spaceIdx === -1) {continue;}
                const hash = line.substring(0, spaceIdx);
                const refName = line.substring(spaceIdx + 1);
                if (commitSet.has(hash)) {
                    if (!branchMap.has(hash)) {branchMap.set(hash, []);}
                    branchMap.get(hash)!.push(refName);
                }
            }

            for (const commit of commits) {
                commit.branchRefs = branchMap.get(commit.hash) || [];
            }
        } catch {
            // Ignore errors in branch resolution
        }
    }

    /**
     * Get the diff for a specific commit
     */
    async getCommitDiff(hash: string): Promise<string> {
        assertHash(hash);
        return (await this.executeGitArgs(['show', '--stat', hash])).trim();
    }

    /** Checkout a single file from a specific commit into working tree */
    async checkoutFileFromCommit(commitHash: string, filePath: string): Promise<void> {
        assertHash(commitHash);
        await this.executeGitArgs(['checkout', commitHash, '--', filePath]);
    }

    /** Get full history of a file across all branches (single spawn, newest first). */
    async getFileHistory(filePath: string): Promise<Array<{ hash: string; shortHash: string; author: string; date: string; message: string }>> {
        const repo = this._resolveRoot();
        if (!repo) {return [];}
        const output = (await this.executeGitArgs([
            'log', '--all', '--max-count=1000', '--format=%H|%h|%an|%ai|%s', '--', filePath
        ])).trim();
        if (!output) {return [];}

        const entries: Array<{ hash: string; shortHash: string; author: string; date: string; message: string }> = [];
        for (const line of output.split('\n')) {
            if (!line.trim()) {continue;}
            const parts = line.split('|');
            if (parts.length < 5) {continue;}
            entries.push({
                hash: parts[0],
                shortHash: parts[1],
                author: parts[2],
                date: parts[3],
                message: parts.slice(4).join('|')
            });
        }
        return entries;
    }

    /**
     * Current branch name, read straight from the git directory. `.git/HEAD` is
     * authoritative and updated synchronously by checkout / `branch -m` (even from
     * another terminal), so no subprocess and no cached view is involved. Detached
     * HEAD has no branch name and returns an empty string.
     */
    async getCurrentBranch(): Promise<string> {
        const repo = this._resolveRoot();
        if (!repo) {return '';}

        const gitDir = resolveGitDir(repo);
        if (gitDir) {
            // During an interactive rebase HEAD is detached; the branch we started
            // from is parked in rebase-merge/head-name as a full ref path.
            const headName = this._readGitFile(path.join(gitDir, 'rebase-merge', 'head-name'));
            const rebasing = headName ? parseRefPath(headName) : undefined;
            if (rebasing) {return rebasing;}

            const branch = parseSymbolicRef(this._readGitFile(path.join(gitDir, 'HEAD')) ?? '');
            return branch ?? '';
        }

        // Layout we cannot read (worktree pointer that no longer resolves): one
        // plumbing call, still without activating any other extension.
        const output = (await this.executeGitArgs(['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
        return output === 'HEAD' ? '' : output;
    }

    /** Read a small git bookkeeping file; undefined when it is missing or locked. */
    private _readGitFile(filePath: string): string | undefined {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return undefined;
        }
    }

    /** Working tree has neither staged nor unstaged changes (single status call). */
    async isClean(): Promise<boolean> {
        const summary = await this.getWorkingTreeSummary();
        return summary.files === 0;
    }

    /** Local branch names, from refs on disk (no subprocess unless the layout is odd). */
    async getLocalBranches(): Promise<string[]> {
        const names = this._refsReader.readBranchNames();
        if (names.local.length > 0) {return names.local;}
        return this._readRefNames('refs/heads/');
    }

    /** Remote-tracking branch names (`origin/main` style), from refs on disk. */
    async getRemoteBranches(): Promise<string[]> {
        const names = this._refsReader.readBranchNames();
        if (names.remote.length > 0) {return names.remote;}
        return this._readRefNames('refs/remotes/');
    }

    private async _readRefNames(namespace: string): Promise<string[]> {
        const output = await this.executeGitArgs([
            'for-each-ref', namespace, '--format=%(refname:short)'
        ]);
        return output.split('\n')
            .map(line => line.replace(/^"|"$/g, '').trim())
            .filter(Boolean);
    }

    /**
     * Get stash list
     */
    async getStashes(): Promise<{ index: number; message: string }[]> {
        const output = (await this.executeGitArgs(['stash', 'list', '--format=%gd|%gs'])).trim();
        if (!output) {return [];}

        return output.split('\n').filter(l => l.trim()).map(line => {
            const parts = line.split('|');
            const indexMatch = parts[0]?.match(/stash@\{(\d+)\}/);
            return {
                index: indexMatch ? parseInt(indexMatch[1]) : 0,
                message: parts[1] || parts[0] || ''
            };
        });
    }

    /**
     * Create a new branch from a specific commit (default HEAD)
     */
    async createBranch(branchName: string, startPoint: string = 'HEAD'): Promise<void> {
        assertRef(branchName);
        await this._execMutate(['branch', branchName, startPoint]);
        // Invalidate refs cache after branch creation
        this._refsReader.invalidate();
        this._trackInfoCache = undefined;
    }

    /**
     * Delete a local branch
     */
    async deleteLocalBranch(branchName: string, force: boolean = false): Promise<void> {
        assertRef(branchName);
        const flag = force ? '-D' : '-d';
        await this._execMutate(['branch', flag, branchName]);
        // Invalidate all caches after branch deletion
        this._refsReader.invalidate();
        this._trackInfoCache = undefined;
        this._branchCache.clear();
        // Also clear persisted cache
        this._persistedCache.clear();
    }

    /**
     * Print a file's content at a given ref (backs the diff content provider).
     */
    async showBlob(ref: string, filePath: string): Promise<string> {
        assertShellSafe(ref, t('label.ref'));
        assertShellSafe(filePath, t('label.filePath'));
        return (await this.executeGitArgs(['show', `${ref}:${filePath}`])).trim();
    }

    /**
     * Rename a local branch
     */
    async renameBranch(oldName: string, newName: string): Promise<void> {
        assertRef(oldName);
        assertRef(newName);
        await this._execMutate(['branch', '-m', oldName, newName]);
        // Invalidate all caches after branch rename
        this._refsReader.invalidate();
        this._trackInfoCache = undefined;
        this._branchCache.clear();
        // Also clear persisted cache
        this._persistedCache.clear();
    }

    /**
     * Commit staged changes with the given message.
     * When all=true, stage tracked modifications first (git commit -a).
     */
    async commit(message: string, all: boolean = false): Promise<string> {
        const output = await this._commitWithMessage(['commit', ...(all ? ['-a'] : [])], message);
        return output || t('commit.success', { detail: '' });
    }

    /**
     * Get the configured upstream (tracking) ref for a local branch, or undefined.
     */
    async getUpstream(branchName: string): Promise<string | undefined> {
        assertRef(branchName);
        const out = await this.executeGitArgs([
            'for-each-ref', `refs/heads/${branchName}`, '--format=%(upstream:short)'
        ]);
        return out.trim() || undefined;
    }

    /**
     * Update a local branch from its upstream.
     * For the checked-out branch, run pull. For a non-current branch, fetch the
     * upstream and fast-forward the local ref (fails if not fast-forwardable).
     */
    async updateBranch(branchName: string): Promise<string> {
        assertRef(branchName);
        const current = await this.getCurrentBranch();
        let upstream = await this.getUpstream(branchName);
        
        // If no upstream configured, try to infer from remote branches
        if (!upstream) {
            const branchDetails = await this.getBranchesWithDetails(false);
            const remoteBranchName = `origin/${branchName}`;
            const hasRemoteBranch = branchDetails.remote.some(b => b.name === remoteBranchName);
            
            if (hasRemoteBranch) {
                // Set upstream tracking relationship
                upstream = remoteBranchName;
                await this._execMutate(['branch', `--set-upstream-to=${remoteBranchName}`, branchName]);
            } else {
                throw new Error(t('err.noUpstreamNoRemote', { name: branchName }));
            }
        }
        
        if (branchName === current) {
            // Read pull strategy from configuration
            const config = require('vscode').workspace.getConfiguration('idea-git');
            const pullStrategy = config.get('pullStrategy', 'merge');
            const useRebase = pullStrategy === 'rebase';
            logger.debug('[GitCharm] updateBranch() pulling current branch with useRebase:', useRebase);
            return this.pull('origin', undefined, useRebase);
        }
        // upstream is like "origin/main"; split into remote and remote branch
        const slash = upstream.indexOf('/');
        const remote = slash > 0 ? upstream.slice(0, slash) : 'origin';
        assertRef(remote, t('label.remote'));
        await this.fetch(remote);
        
        // Try to fast-forward update the local branch reference
        // Use git update-ref for a safer approach that respects branch protection
        const remoteBranch = upstream.slice(remote.length + 1);
        try {
            // First try: use merge-base to check if fast-forward is possible
            const baseOutput = await this.executeGitArgs(['merge-base', branchName, upstream]);
            const headOutput = await this.executeGitArgs(['rev-parse', branchName]);

            if (baseOutput.trim() === headOutput.trim()) {
                // Fast-forward is possible, use update-ref
                const remoteHead = await this.executeGitArgs(['rev-parse', upstream]);
                await this._execMutate(['update-ref', `refs/heads/${branchName}`, remoteHead.trim()]);
                return t('branch.updatedToUpstream', { name: branchName, upstream });
            } else {
                // Not fast-forward, provide informative message
                throw new Error(t('err.behindRemote', { name: branchName }));
            }
        } catch (error: any) {
            const errMsg = String(error);
            if (errMsg.includes('non-fast-forward') || errMsg.includes('rejected')) {
                throw new Error(t('err.nonFastForward', { name: branchName }));
            }
            throw error;
        }
    }

    /**
     * Merge a branch into the current branch
     */
    async mergeBranch(branchName: string): Promise<string> {
        assertRef(branchName);
        // No timeout: merging a large branch can be slow; the progress UI
        // stays up until the command settles (success or conflict exit).
        const output = await this._execMutate(['merge', branchName], { timeoutMs: 0 });
        return output || t('merge.mergedInto', { name: branchName });
    }

    /**
     * Rebase current branch onto another branch/commit
     */
    async rebaseOnto(target: string): Promise<string> {
        assertShellSafe(target, t('label.rebaseTarget'));
        const output = await this._execMutate(['rebase', target], { timeoutMs: 0 });
        return output || t('rebase.rebasedTo', { target });
    }

    /**
     * Stage files so that resolved conflicts can be committed/continued.
     */
    async add(paths: string[]): Promise<void> {
        if (paths.length === 0) {return;}
        const safe = paths.map(p => assertShellSafe(p, t('label.filePath')));
        await this._execMutate(['add', '--', ...safe]);
    }

    /**
     * Continue a rebase that paused because of conflicts.
     * GIT_EDITOR=true prevents git from trying to open an interactive editor
     * inside the extension host.
     */
    async rebaseContinue(): Promise<string> {
        const output = await this._execMutateWithEnv(['rebase', '--continue'], { GIT_EDITOR: 'true' });
        return output || t('op.rebaseContinued');
    }

    /**
     * Abort the current rebase and restore the original branch.
     */
    async rebaseAbort(): Promise<string> {
        const output = await this._execMutate(['rebase', '--abort']);
        return output || t('op.rebaseAborted');
    }

    /**
     * Continue a merge after conflicts are resolved.
     * GIT_EDITOR=true prevents git from opening an editor for the merge message.
     */
    async mergeContinue(): Promise<string> {
        const output = await this._execMutateWithEnv(['merge', '--continue'], { GIT_EDITOR: 'true' });
        return output || t('op.mergeCompleted');
    }

    /**
     * Abort the current merge and restore the pre-merge state.
     */
    async mergeAbort(): Promise<string> {
        const output = await this._execMutate(['merge', '--abort']);
        return output || t('op.mergeAborted');
    }

    /**
     * Return the paths of files with unresolved merge conflicts.
     * Uses plumbing (`ls-files -u`) with NUL-delimited output: stable across
     * git versions and locales, and safe for paths containing newlines.
     */
    async getConflictFiles(): Promise<string[]> {
        try {
            const output = await this.executeGitArgs(['ls-files', '-u', '-z']);
            if (!output) {return [];}
            const seen = new Set<string>();
            for (const entry of splitNul(output)) {
                // Entry form: "<mode> <sha> <stage>\t<path>"
                const tab = entry.indexOf('\t');
                const p = tab >= 0 ? entry.slice(tab + 1) : entry;
                if (p) {seen.add(p);}
            }
            return [...seen];
        } catch {
            return [];
        }
    }

    /**
     * Detect whether a rebase, merge, or cherry-pick is currently in progress.
     * Returns 'rebase' | 'merge' | 'cherry-pick' | undefined.
     */
    async getInProgressOperation(): Promise<'rebase' | 'merge' | 'cherry-pick' | undefined> {
        const repo = this._resolveRoot();
        if (!repo) {return undefined;}
        const fs = require('fs');
        const path = require('path');
        const gitDir = path.join(repo, '.git');

        // Check for rebase in progress (including pull --rebase conflicts)
        if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
            return 'rebase';
        }

        // Check for cherry-pick in progress
        if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
            return 'cherry-pick';
        }

        // Check for merge in progress (including pull --no-rebase conflicts)
        if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
            return 'merge';
        }

        // Check for pull conflict (unmerged files without MERGE_HEAD means pull was interrupted)
        // Treat as merge since it's a non-rebase conflict
        const conflictFiles = await this.getConflictFiles();
        if (conflictFiles.length > 0 && !fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
            return 'merge';
        }

        return undefined;
    }

    /**
     * Find the filesystem path of the worktree that currently has `branchName`
     * checked out. Returns undefined if no worktree uses the branch.
     */
    async getBranchWorktreePath(branchName: string): Promise<string | undefined> {
        assertRef(branchName);
        const output = await this.executeGitArgs(['worktree', 'list', '--porcelain']);
        if (!output) {return undefined;}

        const blocks = output.split('\n\n');
        for (const block of blocks) {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            let worktreePath: string | undefined;
            let branch: string | undefined;
            for (const line of lines) {
                if (line.startsWith('worktree ')) {
                    worktreePath = line.substring('worktree '.length).trim();
                } else if (line.startsWith('branch ')) {
                    branch = line.substring('branch '.length).trim();
                }
            }
            if (worktreePath && branch === `refs/heads/${branchName}`) {
                return worktreePath;
            }
        }
        return undefined;
    }

    /**
     * Push current branch to remote
     */
    async push(remote: string = 'origin', branchName?: string, force: boolean = false): Promise<string> {
        assertRef(remote, t('label.remote'));
        if (branchName) {assertRef(branchName);}
        const args = ['push', ...(force ? ['--force-with-lease'] : []), remote, ...(branchName ? [branchName] : [])];
        const output = await this._execMutate(args, { timeoutMs: 0 });
        return output || t('push.pushedTo', { remote, branch: branchName ? ' ' + branchName : '' });
    }

    /**
     * Pull from remote
     */
    async pull(remote: string = 'origin', branchName?: string, useRebase: boolean = false): Promise<string> {
        assertRef(remote, t('label.remote'));
        if (branchName) {assertRef(branchName);}
        const args = ['pull', ...(useRebase ? ['--rebase'] : []), remote, ...(branchName ? [branchName] : [])];
        const output = await this._execMutate(args, { timeoutMs: 0 });
        return output || t('pull.pulledFrom', { remote });
    }

    /**
     * Fetch from remote
     */
    async fetch(remote: string = 'origin'): Promise<string> {
        assertRef(remote, t('label.remote'));
        const output = await this._execMutate(['fetch', remote], { timeoutMs: 0 });
        return output || t('fetch.fetchedFrom', { remote });
    }

    /**
     * Compare a branch with the current branch (returns log of commits in the other branch not in current)
     */
    async compareBranches(branchName: string): Promise<GitCommit[]> {
        assertRef(branchName);
        const currentBranch = await this.getCurrentBranch();
        const output = (await this.executeGitArgs([
            'log', `${currentBranch}..${branchName}`, '--format=%H|%h|%an|%ae|%ai|%ar|%s|%P'
        ])).trim();
        if (!output) {return [];}

        const commits: GitCommit[] = [];
        for (const line of output.split('\n')) {
            if (!line.trim()) {continue;}
            const commit = parseLogLine(line);
            if (commit) {commits.push(commit);}
        }
        return commits;
    }

    /**
     * Files differing between two refs (tip-to-tip, two-dot). Used by the push
     * dialog's "全部提交" row and the branch compare dialog's "全部差异" row.
     */
    async getDiffFilesBetweenRefs(baseRef: string, targetRef: string): Promise<Array<{ path: string; status: string }>> {
        assertRef(baseRef, t('label.baseRef'));
        assertRef(targetRef, t('label.targetRef'));
        const output = await this.executeGitArgs(['diff', '--name-status', '-z', '-M', `${baseRef}..${targetRef}`]).catch(() => '');
        // name-status -z tokens: status, path; renames: status, src, dst
        const tokens = splitNul(output);
        const files: Array<{ path: string; status: string }> = [];
        for (let i = 0; i < tokens.length; i++) {
            const letter = (tokens[i] || 'M').charAt(0);
            let path = tokens[++i] || '';
            if ((letter === 'R' || letter === 'C') && i + 1 < tokens.length) {
                path = tokens[++i];
            }
            if (path) {files.push({ status: letter, path });}
        }
        return files;
    }

    /**
     * Get commits that are ahead of upstream (would be pushed).
     */
    async getAheadCommits(localBranch: string, upstream: string): Promise<GitCommit[]> {
        assertRef(localBranch);
        assertRef(upstream);
        const output = (await this.executeGitArgs([
            'log', `${upstream}..${localBranch}`, '--format=%H|%h|%an|%ae|%ai|%ar|%s|%P'
        ])).trim();
        if (!output) {return [];}

        const commits: GitCommit[] = [];
        for (const line of output.split('\n')) {
            if (!line.trim()) {continue;}
            const commit = parseLogLine(line);
            if (commit) {commits.push(commit);}
        }
        return commits;
    }

    /**
     * Get detailed branch info with upstream and ahead/behind counts
     */
    async getBranchesWithDetails(force: boolean = false): Promise<BranchDetails> {
        const key = `${this._repositoryPath ?? ''}|details`;
        let details: BranchDetails;
        
        if (!force) {
            const hit = this._branchCache.get(key);
            if (hit) {
                // Use cached branch list but always get current branch in real-time
                const currentBranch = await this.getCurrentBranch();
                details = { ...hit, current: currentBranch };
                return details;
            }
        }
        
        details = await this._loadBranchDetails();
        this._branchCache.set(key, details);
        
        // Persist to file for next startup
        this._persistedCache.save(this._repositoryPath || '', { local: details.local, remote: details.remote });
        
        return details;
    }

    /**
     * Shared `for-each-ref` track-info query (upstream + ahead/behind per local
     * branch). Concurrent callers share one in-flight spawn and results are
     * cached for a short TTL; invalidated by ref-mutating operations.
     */
    private _getBranchTrackInfo(): Promise<BranchTrackMap> {
        const TTL_MS = 3000;
        if (this._trackInfoCache && (Date.now() - this._trackInfoCache.at) < TTL_MS) {
            return Promise.resolve(this._trackInfoCache.map);
        }
        if (this._trackInfoPromise) {
            return this._trackInfoPromise;
        }
        this._trackInfoPromise = this.executeGitArgs([
            'for-each-ref', 'refs/heads/', '--format=%(refname:short)|%(upstream:short)|%(upstream:track)'
        ]).then(output => {
            const map: BranchTrackMap = new Map();
            for (const line of output.split('\n').filter(l => l.trim())) {
                const parts = line.split('|');
                // Strip surrounding quotes that some git builds add around refnames
                const name = parts[0]?.replace(/^"|"$/g, '') || '';
                if (!name) {continue;}
                const upstream = parts[1]?.replace(/^"|"$/g, '') || '';
                const { ahead, behind } = parseTrackInfo(parts[2]);
                map.set(name, { upstream: upstream || undefined, ahead, behind });
            }
            this._trackInfoCache = { at: Date.now(), map };
            return map;
        }).catch(error => {
            logger.debug('[GitCharm] for-each-ref track info failed:', error);
            return new Map() as BranchTrackMap;
        }).finally(() => {
            this._trackInfoPromise = undefined;
        });
        return this._trackInfoPromise;
    }

    /**
     * Lightweight method to get only divergence info (ahead/behind) for all branches.
     * Much faster than getBranchesWithDetails as it only queries track info.
     */
    async getDivergenceInfo(): Promise<Record<string, { ahead: number; behind: number; upstream?: string }>> {
        const result: Record<string, { ahead: number; behind: number; upstream?: string }> = {};

        try {
            const trackMap = await this._getBranchTrackInfo();
            const untracked: string[] = [];
            for (const [branchName, t] of trackMap) {
                if (t.upstream) {
                    if (t.ahead > 0 || t.behind > 0) {
                        result[branchName] = { ahead: t.ahead, behind: t.behind, upstream: t.upstream };
                    }
                } else {
                    untracked.push(branchName);
                }
            }
            // Branches without a configured upstream (e.g. pushed without -u) still
            // get ahead/behind when a same-named remote-tracking branch exists.
            await this._applyUntrackedDivergence(untracked, result);
            logger.debug('[GitCharm] getDivergenceInfo complete, total branches:', Object.keys(result).length);
        } catch (error) {
            logger.debug('[GitCharm] Failed to get divergence info:', error);
        }

        return result;
    }

    /**
     * For local branches with no upstream, compute divergence against a same-named
     * remote-tracking branch so the tree arrows are not limited to tracked branches.
     * Spawns are bounded and run only for branches that actually have a remote twin.
     */
    private async _applyUntrackedDivergence(
        branches: string[],
        result: Record<string, { ahead: number; behind: number; upstream?: string }>
    ): Promise<void> {
        if (branches.length === 0) {return;}
        const { remote } = this._refsReader.readBranchNames();
        if (remote.length === 0) {return;}

        const remoteSet = new Set(remote);
        // Remote names are the first path segment of each remote-tracking ref;
        // prefer "origin" so multi-remote repos resolve the conventional twin.
        const remotes = Array.from(new Set(remote.map(r => r.split('/')[0])))
            .sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b)));

        // Cheap, spawn-free pre-filter: identical head hashes mean zero divergence,
        // so only branches that actually differ from their remote twin are counted.
        const branchRefs = this._refsReader.readBranchRefs();

        const MAX_FALLBACK = 50;
        const matched: Array<{ name: string; ref: string }> = [];
        for (const name of branches) {
            if (matched.length >= MAX_FALLBACK) {break;}
            const ref = remotes.map(r => `${r}/${name}`).find(candidate => remoteSet.has(candidate));
            if (!ref) {continue;}
            const localHash = branchRefs.get(name);
            const remoteHash = branchRefs.get(ref);
            if (!localHash || !remoteHash || localHash === remoteHash) {continue;}
            matched.push({ name, ref });
        }

        await Promise.all(matched.map(async ({ name, ref }) => {
            try {
                // Fully-qualified refs avoid ambiguity when branch names contain '/'.
                const out = await this.executeGitArgs([
                    'rev-list', '--left-right', '--count', `refs/remotes/${ref}...refs/heads/${name}`
                ]);
                const [behindStr, aheadStr] = out.trim().split(/\s+/);
                const behind = parseInt(behindStr, 10) || 0;
                const ahead = parseInt(aheadStr, 10) || 0;
                if (ahead > 0 || behind > 0) {
                    result[name] = { ahead, behind };
                }
            } catch (error) {
                logger.debug('[GitCharm] Untracked divergence fallback failed for', name, error);
            }
        }));
    }

    private async _loadBranchDetails(): Promise<BranchDetails> {
        // Cold-path design: no subprocess for names. Branch names come straight
        // from the refs files (incl. packed-refs); upstream/track info comes from
        // one shared for-each-ref spawn.
        const [currentBranch, trackMap] = await Promise.all([
            this.getCurrentBranch(),
            this._getBranchTrackInfo()
        ]);

        const names = this._refsReader.readBranchNames();

        if (names.local.length === 0 && names.remote.length === 0) {
            // Nothing readable on disk (unborn branch, inaccessible refs): ask git
            const local: BranchDetails['local'] = [];
            for (const [name, t] of trackMap) {
                local.push({ name, upstream: t.upstream, ahead: t.ahead, behind: t.behind });
            }
            let remote: BranchDetails['remote'] = [];
            try {
                remote = (await this._readRefNames('refs/remotes/')).map(name => ({ name }));
            } catch { /* no remotes */ }
            return { current: currentBranch, local, remote };
        }

        const local: BranchDetails['local'] = names.local.map(name => {
            const t = trackMap.get(name);
            return { name, upstream: t?.upstream, ahead: t?.ahead ?? 0, behind: t?.behind ?? 0 };
        });
        const remote: BranchDetails['remote'] = names.remote.map(name => ({ name }));

        return { current: currentBranch, local, remote };
    }

    /**
     * Save current changes as a stash with an optional message
     */
    async saveStash(message?: string): Promise<void> {
        await this._execMutate(['stash', 'push', ...(message ? ['-m', assertShellSafe(message, t('label.stashMessage'))] : [])]);
    }

    async applyStash(index: number = 0): Promise<void> {
        await this._execMutate(['stash', 'apply', `stash@{${index}}`]);
    }

    async popStash(index: number = 0): Promise<void> {
        await this._execMutate(['stash', 'pop', `stash@{${index}}`]);
    }

    async dropStash(index: number = 0): Promise<void> {
        await this._execMutate(['stash', 'drop', `stash@{${index}}`]);
    }

    async clearStashes(): Promise<void> {
        await this._execMutate(['stash', 'clear']);
    }

    /**
     * Get commit graph data for visualization
     * Returns commits with branch/decoration info suitable for rendering a topology graph
     */
    async getCommitGraphData(opts: LogOptions = {}): Promise<GraphData> {
        const limit = opts.limit ?? 20;
        const skip = opts.skip ?? 0;
        const f = opts.filters ?? {};
        const key = `${this._repositoryPath ?? ''}|${opts.branch ?? '__all__'}|${limit}|${skip}|${f.text ?? ''}|${f.author ?? ''}|${f.from ?? ''}|${f.to ?? ''}`;
        if (!opts.force) {
            const hit = this._graphCache.get(key);
            if (hit) {return hit;}
        }
        const data = await this._loadGraphData(limit, skip, opts.branch, f);
        this._graphCache.set(key, data);
        return data;
    }

    private async _loadGraphData(limit: number, skip: number, branch: string | undefined, f: LogFilters): Promise<GraphData> {
        const startTime = Date.now();
        logger.debug(`[GitCharm] _loadGraphData called: limit=${limit}, skip=${skip}, branch=${branch || 'all'}`);
        
        // A hash-like query resolves to that single commit rather than a text search
        const searchText = f.text?.trim();
        const isHashLike = (v: string): boolean => /^[0-9a-f]{4,40}$/i.test(v);
        const hashSearch = searchText && isHashLike(searchText) ? searchText : undefined;
        if (hashSearch) {
            logger.debug(`[GitCharm] Hash-like search detected (${hashSearch})`);
        }
        logger.debug('[GitCharm] Using git commands');
        
        // Use git log with graph format to get topology info
        // %ai = author date (matches GitCharm default display)
        const format = '%H|%h|%s|%an|%ai|%P';
        const safe = (v: string) => v.replace(/["\\$`]/g, '');

        const buildArgs = (forHash: boolean, useBranch: string | undefined): string[] => {
            const a: string[] = ['log'];
            if (forHash) {
                // Hash search: limit to exactly 1 commit to avoid returning all ancestors
                a.push('-n', '1', safe(hashSearch!));
            } else {
                a.push(useBranch ? safe(useBranch) : '--all');
            }
            a.push('--topo-order');
            if (searchText && !forHash) {
                // Use --grep for commit message search without --fixed-strings to allow partial matching
                a.push('--regexp-ignore-case', `--grep=${safe(searchText)}`);
            }
            if (f.author) {a.push(`--author=${safe(f.author)}`);}
            if (f.from) {
                // Git prefers 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' format
                // Convert ISO 8601 back to space-separated format for better compatibility
                let fromDate = f.from;
                if (fromDate.includes('T')) {
                    fromDate = fromDate.replace('T', ' ');
                } else if (!fromDate.includes(' ')) {
                    fromDate = fromDate + ' 00:00:00';
                }
                logger.debug(`[GitCharm] Date filter --since: "${fromDate}"`);
                a.push(`--since=${safe(fromDate)}`);
            }
            if (f.to) {
                // Git prefers 'YYYY-MM-DD HH:MM:SS' format
                let toDate = f.to;
                if (toDate.includes('T')) {
                    toDate = toDate.replace('T', ' ');
                } else if (!toDate.includes(' ')) {
                    toDate = toDate + ' 23:59:59';
                }
                logger.debug(`[GitCharm] Date filter --until: "${toDate}"`);
                a.push(`--until=${safe(toDate)}`);
            }
            if (skip > 0 && !forHash) {a.push(`--skip=${skip}`);}
            if (!forHash) {
                a.push('-n', String(limit), `--format=${format}`);
            } else {
                a.push(`--format=${format}`);
            }
            return a;
        };

        const logStart = Date.now();
        const output = await (hashSearch
            ? this.executeGitArgs(buildArgs(true, branch)).catch(() =>
                  this.executeGitArgs(buildArgs(false, branch))
              )
            : this.executeGitArgs(buildArgs(false, branch)));
        logger.debug(`[GitCharm] git log took ${Date.now() - logStart}ms`);

        if (!output) {
            logger.debug('[GitCharm] No output from git log');
            return { commits: [], branches: [] };
        }

        const parseStart = Date.now();
        // Parse commits first to collect hashes we care about
        const tempCommits: Array<{ hash: string; parsed: any }> = [];
        for (const line of output.split('\n')) {
            if (!line.trim()) {continue;}
            const parsed = parseGraphLine(line);
            if (parsed) {
                tempCommits.push({ hash: parsed.hash, parsed });
            }
        }

        // Read branch and tag refs efficiently from filesystem (no subprocess)
        const branchRefsMap = this._refsReader.readBranchRefs();
        const tagRefsMap = this._refsReader.readTagRefs();
        
        // Build reverse map: hash -> [ref names]
        const hashToRefs = new Map<string, string[]>();
        
        // Add branches
        for (const [branchName, hash] of branchRefsMap.entries()) {
            if (!hashToRefs.has(hash)) {
                hashToRefs.set(hash, []);
            }
            hashToRefs.get(hash)!.push(branchName);
        }
        
        // Add tags
        for (const [tagName, hash] of tagRefsMap.entries()) {
            if (!hashToRefs.has(hash)) {
                hashToRefs.set(hash, []);
            }
            hashToRefs.get(hash)!.push(tagName);
        }
        
        // Parse commits - always create new objects to avoid stale references
        const commits: GraphCommit[] = [];
        for (const { hash, parsed } of tempCommits) {
            const commit: GraphCommit = {
                ...parsed,
                refs: [],
                isMerge: parsed.parents.length > 1
            };
            
            // Apply refs to this commit
            const refs = hashToRefs.get(parsed.hash);
            if (refs && refs.length > 0) {
                commit.refs = refs;
            }
            
            this._commitIndex.set(hash, commit);
            commits.push(commit);
        }
        const parseTime = Date.now() - parseStart;
        logger.debug(`[GitCharm] Parsed ${commits.length} commits in ${parseTime}ms`);

        // Get all branch names for display
        const branches = Array.from(branchRefsMap.keys());

        const totalTime = Date.now() - startTime;
        logger.debug(`[GitCharm] _loadGraphData completed in ${totalTime}ms (using git commands + fs refs + tags)`);

        return { commits, branches };
    }

    /**
     * Cherry-pick a commit onto the current branch
     */
    async cherryPick(hash: string): Promise<void> {
        assertHash(hash);
        await this._execMutate(['cherry-pick', hash]);
    }

    /**
     * Abort an ongoing cherry-pick operation
     */
    async abortCherryPick(): Promise<void> {
        await this._execMutate(['cherry-pick', '--abort']);
    }

    /**
     * Get the rebase todo content (commits to be rebased)
     */
    async getRebaseTodo(upstream: string): Promise<Array<{ action: string; hash: string; message: string }>> {
        assertShellSafe(upstream, t('label.rebaseBase'));
        const output = (await this.executeGitArgs([
            'log', '--reverse', '--format=%H|%s', `${upstream}..HEAD`
        ])).trim();

        if (!output) {return [];}

        return output.split('\n').filter(l => l.trim()).map(line => {
            const parts = line.split('|');
            return {
                action: 'pick',
                hash: parts[0] || '',
                message: parts[1] || ''
            };
        });
    }

    /**
     * Execute a rebase with custom actions (squash/reword/drop/edit).
     * The todo always lists every commit in the range; commits without an
     * explicit action keep `pick` so they are not silently dropped.
     */
    async executeRebaseWithActions(
        upstream: string,
        actions: Array<{ hash: string; action: string }>
    ): Promise<string> {
        const todos = await this.getRebaseTodo(upstream);
        if (todos.length === 0) {
            throw new Error(t('err.noRebaseCommits'));
        }
        const actionByHash = new Map(actions.map(a => [a.hash, a.action]));
        const lines = todos.map(t => `${actionByHash.get(t.hash) ?? 'pick'} ${t.hash}`);
        return await this._runRebaseWithTodo(upstream, lines.join('\n') + '\n');
    }

    /**
     * Resolve the current HEAD commit hash.
     */
    async getHeadHash(): Promise<string> {
        // Read .git/HEAD + refs from the filesystem (no subprocess); fall back
        // to rev-parse for unusual layouts (worktrees) or empty repos.
        const repoPath = this._repositoryPath;
        if (repoPath) {
            try {
                const head = fs.readFileSync(path.join(repoPath, '.git', 'HEAD'), 'utf8').trim();
                if (head.startsWith('ref:')) {
                    const short = head.substring(4).trim().replace(/^refs\/(heads|remotes)\//, '');
                    const hash = this._refsReader.readBranchRefs().get(short);
                    if (hash) {return hash;}
                } else if (/^[0-9a-f]{40}$/i.test(head)) {
                    return head; // detached HEAD
                }
            } catch { /* fall through to git command */ }
        }
        return (await this.executeGitArgs(['rev-parse', 'HEAD'])).trim();
    }

    /**
     * True when the working tree has no uncommitted changes.
     */
    async isWorkingTreeClean(): Promise<boolean> {
        return (await this.executeGitArgs(['status', '--porcelain'])).trim() === '';
    }

    /**
     * Full commit message body for a given hash.
     */
    async getCommitMessage(hash: string): Promise<string> {
        assertHash(hash);
        return (await this.executeGitArgs(['log', '-1', '--format=%B', hash])).trim();
    }

    /**
     * Delete the tip commit by moving the branch ref to its parent. Git keeps the
     * old commit as a dangling object until gc; its changes are discarded, so the
     * working tree must be clean first.
     */
    async dropLastCommit(commitHash: string): Promise<string> {
        const head = await this.getHeadHash();
        if (commitHash !== head) {
            throw new Error(t('commit.dropOnlyLast'));
        }
        if (!(await this.isWorkingTreeClean())) {
            throw new Error(t('err.dropDirtyWorktree'));
        }
        await this._execMutate(['reset', '--hard', 'HEAD~1']);
        return await this.getHeadHash();
    }

    /**
     * Rewrite only the tip commit's message (amend); the old commit object is
     * left dangling and replaced by the new one.
     */
    async amendMessage(commitHash: string, message: string): Promise<string> {
        const head = await this.getHeadHash();
        if (commitHash !== head) {
            throw new Error(t('commit.editOnlyLast'));
        }
        const out = await this._commitWithMessage(['commit', '--amend'], message);
        return out || t('commit.messageUpdated');
    }

    /**
     * Squash multiple commits into one
     * @param upstream - the base commit before the range to squash
     * @param commitHashes - array of commit hashes to squash together
     */
    async squashCommits(upstream: string, commitHashes: string[], customMessage?: string): Promise<void> {
        if (commitHashes.length < 2) {
            throw new Error(t('err.squashNeedTwo'));
        }
        commitHashes.forEach(assertHash);

        const todos = await this.getRebaseTodo(upstream);
        const selected = new Set(commitHashes);
        if (commitHashes.some(h => !todos.some(t => t.hash === h))) {
            throw new Error(t('err.squashNotInRange'));
        }

        // Keep unselected commits in place; move the selected ones into one
        // contiguous block (at the oldest selected position) so squash applies.
        const others: string[] = [];
        const block: string[] = [];
        let insertAt = -1;
        for (const t of todos) {
            if (selected.has(t.hash)) {
                if (insertAt === -1) {insertAt = others.length;}
                block.push(t.hash);
            } else {
                others.push(`pick ${t.hash}`);
            }
        }
        const squashed = block.map((h, i) => `${i === 0 ? 'pick' : 'squash'} ${h}`);
        others.splice(insertAt, 0, ...squashed);

        // If custom message provided, use it as the final commit message after squash
        if (customMessage && customMessage.trim()) {
            // Use GIT_SEQUENCE_EDITOR to skip editor during rebase
            // Then amend the final commit with custom message
            const originalSequenceEditor = process.env.GIT_SEQUENCE_EDITOR;
            try {
                process.env.GIT_SEQUENCE_EDITOR = 'true'; // Skip sequence editor
                
                // Run rebase with squash todo
                await this._runRebaseWithTodo(upstream, others.join('\n') + '\n');
                
                // After successful rebase, amend the last commit with custom message
                const head = await this.getHeadHash();
                if (head) {
                    await this.amendMessage(head, customMessage);
                }
            } finally {
                // Restore original GIT_SEQUENCE_EDITOR
                if (originalSequenceEditor !== undefined) {
                    process.env.GIT_SEQUENCE_EDITOR = originalSequenceEditor;
                } else {
                    delete process.env.GIT_SEQUENCE_EDITOR;
                }
            }
        } else {
            // No custom message, use default squash behavior
            await this._runRebaseWithTodo(upstream, others.join('\n') + '\n');
        }
    }

    /**
     * Drop multiple commits using interactive rebase in a single operation.
     * All selected commits are removed from the history at once.
     */
    async dropCommitsWithRebase(upstream: string, commitHashes: string[]): Promise<void> {
        if (commitHashes.length === 0) {
            throw new Error(t('commit.dropNoValid'));
        }
        commitHashes.forEach(assertHash);

        const todos = await this.getRebaseTodo(upstream);
        const selected = new Set(commitHashes);
        
        // Build rebase todo: skip selected commits entirely
        const remaining: string[] = [];
        for (const t of todos) {
            if (!selected.has(t.hash)) {
                remaining.push(`pick ${t.hash}`);
            }
        }

        // If all commits are being dropped, just reset to upstream
        if (remaining.length === 0) {
            await this._execMutate(['reset', '--hard', assertShellSafe(upstream, t('label.rebaseBase'))]);
            return;
        }

        // If nothing was selected from the range (all commits outside range), error
        if (remaining.length === todos.length) {
            throw new Error(t('err.squashNotInRange') + ': ' + 
                commitHashes.map(h => h.substring(0, 7)).join(', '));
        }

        await this._runRebaseWithTodo(upstream, remaining.join('\n') + '\n');
    }

    /**
     * Reset current branch to a specific commit (soft/hard/mixed)
     */
    async resetToCommit(hash: string, mode: 'soft' | 'mixed' | 'hard' = 'mixed'): Promise<void> {
        assertHash(hash);
        await this._execMutate(['reset', `--${mode}`, hash]);
    }

    /**
     * Check if a commit is the initial commit (no parents)
     */
    async isInitialCommit(hash: string): Promise<boolean> {
        assertHash(hash);
        const output = await this.executeGitArgs(['rev-list', '--parents', '-n', '1', hash]);
        // Format: "hash parent1 parent2 ..." - initial commit has only one token
        const parts = output.trim().split(/\s+/);
        return parts.length === 1;
    }

    /**
     * Check if a commit has already been pushed to any remote
     */
    async isCommitPushed(hash: string): Promise<boolean> {
        assertHash(hash);
        try {
            // Get all remote branches that contain this commit
            const remotes = await this.executeGitArgs(['branch', '-r', '--contains', hash]);
            return remotes.trim().length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Check if a commit exists in the current branch
     */
    async commitExistsInBranch(hash: string, branch?: string): Promise<boolean> {
        assertHash(hash);
        const targetBranch = branch || await this.getCurrentBranch();
        try {
            await this.executeGitArgs(['merge-base', '--is-ancestor', hash, targetBranch]);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if a commit is a merge commit (has multiple parents)
     */
    async isMergeCommit(hash: string): Promise<boolean> {
        assertHash(hash);
        const output = await this.executeGitArgs(['rev-list', '--parents', '-n', '1', hash]);
        const parts = output.trim().split(/\s+/);
        return parts.length > 2; // hash + at least 2 parents
    }

    /**
     * Get parent hashes of a commit
     */
    async getParents(hash: string): Promise<string[]> {
        assertHash(hash);
        const output = await this.executeGitArgs(['rev-list', '--parents', '-n', '1', hash]);
        const parts = output.trim().split(/\s+/);
        return parts.slice(1); // Skip the commit hash itself
    }
}
