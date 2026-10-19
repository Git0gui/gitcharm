import { t } from '../i18n';

export interface GitCommit {
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    authorEmail: string;
    date: string;
    relativeDate: string;
    branchRefs: string[];
    parentHashes: string[];
}

// Characters that break out of double quotes under cmd.exe (exec's shell on Windows)
// eslint-disable-next-line no-control-regex
const SHELL_UNSAFE = /["%!\x00-\x1f]/;
// Characters git itself forbids in ref names
const REF_ILLEGAL = /[\s~^:?*[\\]/;

export function assertShellSafe(value: string, label: string): string {
    if (!value || SHELL_UNSAFE.test(value)) {
        throw new Error(t('err.unsupportedChars', { label, value }));
    }
    return value;
}

export function assertRef(value: string, label = t('label.branch')): string {
    assertShellSafe(value, label);
    // A ref that begins with '-' would be parsed as an option by git; check-ref-format
    // forbids it for real refs anyway, so this only rejects hostile input.
    if (REF_ILLEGAL.test(value) || value.includes('..') || value.includes('@{') || value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) {
        throw new Error(t('err.invalidRef', { label, value }));
    }
    return value;
}

export function assertHash(value: string): string {
    if (!/^[0-9a-f]{4,40}$/i.test(value)) {
        throw new Error(t('err.invalidHash', { value }));
    }
    return value;
}

/**
 * Why a tag name would be refused, or undefined when git accepts it.
 *
 * `assertRef` already covers the shared ref rules (illegal punctuation, `..`,
 * `@{`, leading/trailing slash, leading dash — that one also keeps `git tag -x`
 * from reading the name as an option). The three checks here are the rest of
 * `git check-ref-format`, verified against git rather than assumed: a path
 * component may not start with a dot, and the name may not end with a dot or
 * with `.lock` (git reserves those for its own ref transactions).
 */
export function tagNameProblem(name: string, existing: readonly string[] = []): string | undefined {
    const trimmed = name.trim();
    if (!trimmed) {return t('tag.nameEmpty');}
    try {
        assertRef(trimmed, t('label.tag'));
    } catch {
        return t('tag.nameChars');
    }
    if (trimmed.endsWith('.')) {return t('tag.nameDot');}
    if (trimmed.endsWith('.lock')) {return t('tag.nameLock');}
    if (trimmed.split('/').some(part => part.startsWith('.'))) {return t('tag.nameDot');}
    if (existing.includes(trimmed)) {return t('tag.nameExists', { name: trimmed });}
    return undefined;
}

/**
 * The commit an annotated tag points at, read straight out of its loose object.
 *
 * `refs/tags/…` stores the *tag object* hash for annotated tags, so a raw ref
 * read would never match any commit in the log — the badge would vanish and
 * "delete/push tag on this commit" could not find the tag. A tag object is a
 * small text blob (`tag <len>` NUL, then header lines, then a blank line and
 * the message), so peeling costs one inflated read instead of a
 * `git rev-parse` per tag.
 *
 * Returns undefined for anything that is not a tag object (lightweight tags
 * point at the commit directly) or has no usable `object` line.
 */
export function peeledCommitFromTagObject(raw: string): string | undefined {
    const nul = raw.indexOf('\0');
    if (nul < 0 || !/^tag \d+$/.test(raw.slice(0, nul))) {return undefined;}

    // Only the header is authoritative: a message line may read like one.
    const bodyStart = nul + 1;
    const blank = raw.indexOf('\n\n', bodyStart);
    const header = blank >= 0 ? raw.slice(bodyStart, blank) : raw.slice(bodyStart);
    const match = /^object ([0-9a-f]{40})[ \t]*$/m.exec(header);
    return match ? match[1] : undefined;
}

export class LruCache<V> {
    private _map = new Map<string, V>();

    constructor(private readonly _max: number) {}

    get(key: string): V | undefined {
        const value = this._map.get(key);
        if (value === undefined) {return undefined;}
        this._map.delete(key);
        this._map.set(key, value);
        return value;
    }

    set(key: string, value: V): void {
        if (this._map.has(key)) {this._map.delete(key);}
        this._map.set(key, value);
        while (this._map.size > this._max) {
            const oldest = this._map.keys().next().value;
            if (oldest === undefined) {break;}
            this._map.delete(oldest);
        }
    }

    clear(): void {
        this._map.clear();
    }

    delete(key: string): boolean {
        return this._map.delete(key);
    }

    get size(): number {
        return this._map.size;
    }
}

export function parseLogLine(line: string): GitCommit | null {
    const parts = line.split('|');
    if (parts.length < 8) {return null;}
    const [hash, shortHash, author, email, date, relativeDate, message, ...parentParts] = parts;
    return {
        hash,
        shortHash,
        message,
        author,
        authorEmail: email,
        date,
        relativeDate,
        branchRefs: [],
        parentHashes: parentParts.join('|').split(' ').filter(h => h.length > 0)
    };
}

export function parseGraphLine(line: string): { hash: string; shortHash: string; message: string; author: string; date: string; parents: string[] } | null {
    const parts = line.split('|');
    if (parts.length < 6) {return null;}
    const [hash, shortHash, message, author, date, ...parentParts] = parts;
    return {
        hash,
        shortHash,
        message,
        author,
        date,
        parents: parentParts.join('|').split(' ').filter(p => p.length > 0)
    };
}

/**
 * Parse git for-each-ref %(upstream:track) text ("[ahead 2, behind 1]") into counts.
 */
export function parseTrackInfo(track: string | undefined): { ahead: number; behind: number } {
    let ahead = 0, behind = 0;
    if (track) {
        const a = track.match(/ahead (\d+)/);
        const b = track.match(/behind (\d+)/);
        ahead = a ? parseInt(a[1]) : 0;
        behind = b ? parseInt(b[1]) : 0;
    }
    return { ahead, behind };
}

/**
 * Parse `.git/HEAD`-style content ("ref: refs/heads/<branch>") into a branch name.
 * Returns undefined for detached HEAD (raw SHA content).
 */
export function parseSymbolicRef(content: string): string | undefined {
    const m = content.trim().match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1] : undefined;
}

/**
 * Extract a branch name from either a `ref: refs/heads/<branch>` line (HEAD) or a
 * bare `refs/heads/<branch>` path (`rebase-merge/head-name`). Returns undefined for
 * raw SHAs and for refs outside refs/heads.
 */
export function parseRefPath(content: string): string | undefined {
    const trimmed = content.trim();
    const symbolic = trimmed.match(/^(?:ref: )?refs\/heads\/(.+)$/);
    return symbolic ? symbolic[1] : undefined;
}

/** One file from `git status --porcelain` (v1 format). */
export interface StatusEntry {
    /** Path relative to the repository root. */
    path: string;
    /** Source path, present only for rename/copy entries. */
    fromPath?: string;
    /** Index (staged) status letter; ' ' means nothing staged. */
    indexStatus: string;
    /** Worktree status letter; ' ' means the worktree matches the index. */
    worktreeStatus: string;
    /** The file is unmerged in the index, i.e. needs conflict resolution. */
    conflicted: boolean;
    untracked: boolean;
    ignored: boolean;
}

/** The six porcelain-v1 XY codes git uses for unmerged index entries. */
const UNMERGED_CODES = new Set(['AA', 'DD', 'AU', 'UA', 'DU', 'UD']);

/**
 * Parse `git status --porcelain -z` output into per-file entries.
 * Rename/copy entries carry their source path in the following NUL field, which
 * belongs to the same file and must not become a separate entry.
 */
export function parseStatusEntries(raw: string): StatusEntry[] {
    const fields = raw.split('\0').filter(field => field.length > 0);
    const entries: StatusEntry[] = [];
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const indexStatus = field.charAt(0);
        const worktreeStatus = field.charAt(1);
        const code = indexStatus + worktreeStatus;
        const path = field.substring(3);
        const entry: StatusEntry = {
            path,
            indexStatus,
            worktreeStatus,
            conflicted: UNMERGED_CODES.has(code),
            untracked: code === '??',
            ignored: code === '!!'
        };
        if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
            const from = fields[++i];
            if (from !== undefined) {entry.fromPath = from;}
        }
        entries.push(entry);
    }
    return entries;
}

/** Working-tree change counts used by the empty-repository guidance page. */
export interface WorkingTreeSummary {
    files: number;
    untracked: number;
}

/**
 * Summarise `git status --porcelain -z` output (NUL-separated entries).
 * A rename/copy entry is followed by an extra field carrying the source path,
 * which belongs to the same file and must not be counted again.
 */
export function parseWorkingTreeSummary(raw: string): WorkingTreeSummary {
    const entries = parseStatusEntries(raw);
    return {
        files: entries.length,
        untracked: entries.filter(entry => entry.untracked).length
    };
}

/** One entry of the stash stack, i.e. one commit of the stash reflog. */
export interface StashEntry {
    /** Position in the stack: `stash@{0}` is the newest. Shifts when a stash is dropped. */
    index: number;
    /** The stash subject (`On main: note`, `WIP on main: 1a2b3c4 msg`, …). */
    message: string;
    /** ISO 8601 author date of the stash commit. */
    date: string;
}

/**
 * Parse `git log -g stash --format=%gd%x00%gs%x00%aI` output.
 *
 * Fields are NUL-separated, not pipe-separated, because a stash subject is free
 * text that routinely contains a pipe (`WIP on main: 1a2b3c4 fix a|b`) and would
 * otherwise be cut in half. The date comes from `%aI`: `git stash list` cannot
 * emit any date format, while the reflog log gives index, subject and date in a
 * single spawn.
 */
export function parseStashList(raw: string): StashEntry[] {
    const entries: StashEntry[] = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (!trimmed.trim()) {continue;}

        const parts = trimmed.split('\0');
        const indexMatch = /stash@\{(\d+)\}/.exec(parts[0] ?? '');
        if (!indexMatch) {continue;}
        entries.push({
            index: Number.parseInt(indexMatch[1], 10),
            message: (parts[1] ?? '').trim(),
            date: (parts[2] ?? '').trim()
        });
    }
    return entries;
}

/**
 * Split the commit-list path filter into git pathspecs.
 *
 * Comma-separated so several files/directories can be tracked at once, and
 * patterns are handed to git untouched: git's own pathspec wildmatch is what
 * the user gets (`src/*.ts`, a directory prefix, an exact path). A leading
 * '-' is deliberately NOT rejected — the caller always appends these after a
 * `--` separator, so git cannot read them as options. Control characters are
 * dropped because they cannot survive as a process argument anyway.
 */
export function parsePathFilter(raw: string | undefined): string[] {
    if (!raw) {return [];}
    // eslint-disable-next-line no-control-regex
    return raw.split(',').map(part => part.trim()).filter(part => part.length > 0 && !/[\x00-\x1f]/.test(part));
}

/** A changed file of one commit, as the panel's file list needs it. */
export interface FileStatLike {
    status: string;
    path: string;
    added: number;
    deleted: number;
}

/**
 * Merge the file lists of several commits into one row per path — what the panel
 * shows when the user selects a group of commits in the log.
 *
 * `batches` must arrive ordered oldest → newest, because the status a path ends up
 * with is the *net* effect of those commits rather than whichever commit the user
 * happened to click first: a file created inside the selection stays 'A' even when
 * a later commit also modifies it, and a later deletion wins over earlier edits.
 * Line counts accumulate — the number answers "how much did this group change the
 * file", which is what a multi-commit selection is for.
 */
export function mergeCommitFileStats(batches: readonly (readonly FileStatLike[])[]): FileStatLike[] {
    const merged = new Map<string, FileStatLike>();
    for (const files of batches) {
        for (const file of files) {
            const row = merged.get(file.path);
            if (!row) {
                // Copy, never reuse: these entries come out of the host's file cache
                // and the accumulation below must not rewrite what is cached.
                merged.set(file.path, { ...file });
                continue;
            }
            row.added += file.added;
            row.deleted += file.deleted;
            row.status = netFileStatus(row.status, file.status);
        }
    }
    return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function netFileStatus(previous: string, next: string): string {
    if (next === 'A') {return 'A';}
    if (next === 'D') {return 'D';}
    if (previous === 'A') {return 'A';}
    return next;
}

/** One reflog record: a movement of a rev, newest first. */
export interface ReflogEntry {
    /** Selector as printed by `%gd`, e.g. `HEAD@{3}` or `main@{0}`. */
    ref: string;
    hash: string;
    shortHash: string;
    /** Kind of movement: the subject up to its first `': '` (`commit`, `reset`, `checkout`…). */
    action: string;
    /** Subject without that prefix; empty when the subject has no colon. */
    message: string;
    /** ISO 8601 author date of the record. */
    date: string;
}

/**
 * Parse NUL-separated reflog output (`%gd%x00%H%x00%gs%x00%aI`).
 *
 * NUL again because the subject is free text: `commit: <user message>` can
 * contain anything, including colons — which is also why `action` splits on the
 * FIRST `': '` only, so `reset: moving to 1a2b` stays one action. The hash is
 * the full one: these rows feed `reset`/`checkout`, and an abbreviated hash can
 * be ambiguous in a large repository.
 */
export function parseReflogList(raw: string): ReflogEntry[] {
    const entries: ReflogEntry[] = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (!trimmed.trim()) {continue;}

        const parts = trimmed.split('\0');
        const hash = (parts[1] ?? '').trim();
        if (!hash) {continue;}
        const subject = (parts[2] ?? '').trim();
        const split = subject.indexOf(': ');
        entries.push({
            ref: (parts[0] ?? '').trim(),
            hash,
            shortHash: hash.substring(0, 7),
            action: split > 0 ? subject.substring(0, split) : subject,
            message: split > 0 ? subject.substring(split + 2).trim() : '',
            date: (parts[3] ?? '').trim()
        });
    }
    return entries;
}

/** The operation an in-progress merge/rebase/cherry-pick leaves behind. */
export type InProgressOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert';

/**
 * Files git keeps in `.git` while an operation is unfinished. Their removal is
 * what "resolved" means: `git commit` deletes MERGE_HEAD, `--continue` deletes
 * CHERRY_PICK_HEAD, a finished/aborted rebase deletes rebase-merge|rebase-apply.
 * A conflicted `git revert` writes REVERT_HEAD (and no MERGE_HEAD), so it needs
 * its own entry or the panel would show a conflict nobody can continue.
 */
export const OPERATION_STATE_FILES: readonly string[] = [
    'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_HEAD'
];

/** True when `name` (a bare filename inside `.git`) is one of the state files. */
export function isOperationStateFile(name: string): boolean {
    return OPERATION_STATE_FILES.includes(name);
}

/**
 * Decide the in-progress operation from the presence of git's state files alone —
 * no subprocess, so it is cheap enough to run on every poll tick. Order matters:
 * a rebase runs cherry-pick internally, so `rebase-*` must win over the head files.
 * Returns undefined when nothing is in progress (the caller may still need the
 * authoritative check for unmerged index entries without a state file).
 */
export function operationFromStateFiles(
    exists: (name: string) => boolean
): InProgressOperation | undefined {
    if (exists('rebase-merge') || exists('rebase-apply')) {return 'rebase';}
    if (exists('CHERRY_PICK_HEAD')) {return 'cherry-pick';}
    if (exists('REVERT_HEAD')) {return 'revert';}
    if (exists('MERGE_HEAD')) {return 'merge';}
    return undefined;
}

/**
 * Turn a git remote URL into the base of its web UI, so a commit or branch can be
 * opened in the browser. Handles the forms remotes actually come in: scp-like
 * (`git@host:org/repo.git`), ssh/git/https URLs (with optional user and port), and
 * local paths — for those there is no web UI, so it returns undefined.
 */
export function remoteUrlToWebBase(url: string): string | undefined {
    const trimmed = url.trim();
    if (!trimmed) {return undefined;}

    let host: string | undefined;
    let path: string | undefined;

    const scheme = /^(?:git\+)?(https?|ssh|git):\/\/(?:[^/@]+@)?([^/]+)/.exec(trimmed);
    if (scheme) {
        host = scheme[2];
        path = trimmed.slice(scheme[0].length).replace(/^\/+/, '');
    } else {
        // scp-like: [user@]host:path — the colon only counts when it precedes a '/'
        // and nothing before it looks like a Windows drive letter or scheme.
        const scp = /^(?:[^/@]+@)?([^/@\s:]+):(.+)$/.exec(trimmed);
        if (scp && !/^[a-zA-Z]$/.test(scp[1])) {
            host = scp[1];
            path = scp[2];
        } else {
            return undefined; // local path or unparseable
        }
    }

    host = host.replace(/:\d+$/, ''); // strip a port (ssh://git@host:22/…)
    path = path.replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!host || !path) {return undefined;}
    return `https://${host}/${path}`;
}

/** Build the web URL for a commit, or undefined when the remote has no web UI. */
export function commitWebUrl(webBase: string | undefined, hash: string): string | undefined {
    return webBase ? `${webBase}/commit/${hash}` : undefined;
}

/** Build the web URL for a branch (its tip), or undefined when unavailable. */
export function branchWebUrl(webBase: string | undefined, branch: string): string | undefined {
    return webBase ? `${webBase}/tree/${branch}` : undefined;
}

/**
 * Remote names in git's config file, in file order with duplicates removed.
 * Same section grammar as `parseGitConfigRemoteUrl`, just without the values —
 * a background fetch needs to know whether a remote exists at all before
 * spending a subprocess on it.
 */
export function parseGitConfigRemoteNames(raw: string): string[] {
    const names: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {continue;}
        const section = /^\[remote\s+(?:["']([^"'\]]+)["']|([^"'\]\s]+))\]$/.exec(trimmed);
        if (section) {
            const name = section[1] ?? section[2];
            if (name && !names.includes(name)) {names.push(name);}
        }
    }
    return names;
}

/**
 * Pick the remote a background fetch should contact: `origin` when it exists
 * (the convention every tool assumes), otherwise the first configured remote,
 * otherwise nothing — an empty string means "do not fetch".
 */
export function pickFetchRemote(names: readonly string[]): string {
    return names.includes('origin') ? 'origin' : (names[0] ?? '');
}

/**
 * The remote half of an upstream ref: `origin/main` → `origin`, and also
 * `fork` for the less common `fork/dev/main` (branch names carry slashes,
 * remote names are read as the leading segment — same split `updateBranch` uses).
 */
export function remoteNameFromUpstream(upstream: string | undefined): string | undefined {
    const text = (upstream || '').trim();
    if (!text) {return undefined;}
    const slash = text.indexOf('/');
    return slash > 0 ? text.slice(0, slash) : undefined;
}

export interface RemoteBranchMatch {
    remote: string;
    /** The remote-tracking ref as listed by the repository, e.g. `fork/dev/x`. */
    ref: string;
}

/**
 * Find the remote branch a local branch would push to. `origin` wins because it
 * is the remote every other tool assumes; otherwise the first listing that
 * carries the same tail matches. Comparing tails is what makes nested branch
 * names work — `dev/x` on `origin` is stored as the single string
 * `origin/dev/x`, so a plain "strip the first segment" split would miss it.
 */
export function matchRemoteBranch(
    remoteRefs: readonly string[],
    branchName: string,
    preferredRemote: string = 'origin'
): RemoteBranchMatch | undefined {
    if (!branchName) {return undefined;}
    const suffix = `/${branchName}`;
    let fallback: RemoteBranchMatch | undefined;
    for (const ref of remoteRefs) {
        if (!ref.endsWith(suffix)) {continue;}
        const remote = ref.slice(0, ref.length - suffix.length);
        if (!remote) {continue;}
        if (remote === preferredRemote) {return { remote, ref };}
        if (!fallback) {fallback = { remote, ref };}
    }
    return fallback;
}

export interface PushTarget {
    remote: string;
    /** Whether the remote already has a branch of this name. */
    exists: boolean;
    /** Remote-tracking ref carrying the branch, when it exists. */
    ref?: string;
    /** The local branch's configured upstream is this remote's branch. */
    hasUpstream: boolean;
}

/**
 * Decide where a push of `branchName` goes. An explicit `preferredRemote`
 * (the dialog's remote picker) wins outright and must NOT fall back to another
 * remote that happens to carry a twin branch: choosing `fork` for a branch that
 * only exists on `origin` is a first push to `fork`, not a push to `origin`.
 * Without a preference: the tracked remote, then any remote with the same
 * branch (`origin` preferred), then `origin` as the conventional default.
 */
export function resolvePushTarget(
    remoteRefs: readonly string[],
    branchName: string,
    upstream: string | undefined,
    preferredRemote?: string
): PushTarget {
    const picked = (preferredRemote || '').trim()
        || remoteNameFromUpstream(upstream)
        || matchRemoteBranch(remoteRefs, branchName)?.remote
        || 'origin';
    const match = matchRemoteBranch(remoteRefs, branchName, picked);
    const onPicked = match && match.remote === picked ? match : undefined;
    const hasUpstream = !!upstream && remoteNameFromUpstream(upstream) === picked;
    return {
        remote: picked,
        exists: hasUpstream || !!onPicked,
        ref: hasUpstream ? upstream : onPicked?.ref,
        hasUpstream
    };
}

/** One repository of a multi-root workspace, as offered by the panel's switcher. */
export interface RepositoryOption {
    path: string;
    name: string;
}

/**
 * Comparable form of a repository path: separators unified, trailing ones
 * stripped, and case folded only where the filesystem ignores case. Two
 * spellings of the same root must collapse into one entry in the switcher —
 * but not on Linux, where they are genuinely different directories.
 */
export function repositoryKey(repoPath: string, caseInsensitive = process.platform === 'win32'): string {
    const unified = repoPath.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? unified.toLowerCase() : unified;
}

/**
 * Repository roots behind `startDirs`, in the given order, deduplicated.
 * `probe` resolves one directory to its git root (the caller's own detection),
 * so this stays a pure function and keeps the semantics the implicit lookup has
 * always had: several folders of one repository yield a single entry, and a
 * folder inside a bigger repository reports that repository.
 */
export function collectRepositoryRoots(
    startDirs: readonly string[],
    probe: (dir: string) => string | undefined,
    caseInsensitive = process.platform === 'win32'
): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const dir of startDirs) {
        const root = probe(dir);
        if (!root) {continue;}
        const key = repositoryKey(root, caseInsensitive);
        if (seen.has(key)) {continue;}
        seen.add(key);
        roots.push(root);
    }
    return roots;
}

/** Never worth descending into: dependency and build trees hold no project. */
const SCAN_IGNORED_DIRS: ReadonlySet<string> = new Set([
    'node_modules', 'bower_components', 'jspm_packages', 'web_modules', 'vendor',
    'dist', 'build', 'out', 'target', 'bin', 'obj', '__pycache__'
]);

export interface RepositoryScanOptions {
    /** Levels below the start directory to look for a repository (0 checks only the starts). */
    maxDepth?: number;
    /** Directories to visit at most, so an unusual workspace root cannot stall the host. */
    budget?: number;
}

/**
 * Repositories contained in the trees below `startDirs`, breadth-first, in
 * discovery order and deduplicated.
 *
 * Walking up from a workspace folder only finds a repository when the folder
 * *is* one. The layout that actually shows up in practice is a plain parent
 * directory holding a dozen sibling projects, each with its own `.git` — git
 * itself reports those, so a repository picker has to look downward too.
 *
 * Describing the tree is the caller's job through `isRepository` / `listChildren`
 * to keep this testable and fs-free; `budget` is consumed per directory listed.
 */
export function discoverRepositoryRoots(
    startDirs: readonly string[],
    join: (dir: string, child: string) => string,
    isRepository: (dir: string) => boolean,
    listChildren: (dir: string) => readonly string[],
    options: RepositoryScanOptions = {},
    caseInsensitive = process.platform === 'win32'
): string[] {
    const maxDepth = options.maxDepth ?? 2;
    let budget = options.budget ?? 1000;
    const roots: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ dir: string; depth: number }> = startDirs.map(dir => ({ dir, depth: 0 }));

    while (queue.length > 0) {
        const next = queue.shift() as { dir: string; depth: number };
        const key = repositoryKey(next.dir, caseInsensitive);
        if (seen.has(key)) {continue;}
        seen.add(key);

        if (isRepository(next.dir)) {
            roots.push(next.dir);
            // A repository's own tree is never listed: that is where the huge,
            // irrelevant directories live, and its projects are already roots.
            continue;
        }
        if (next.depth >= maxDepth || budget <= 0) {continue;}
        budget--;

        for (const child of listChildren(next.dir)) {
            // Dot-directories are tooling state, not projects, and listing them is
            // how a scan wanders into ~/.gradle-sized trees for nothing.
            if (!child || child.startsWith('.') || SCAN_IGNORED_DIRS.has(child.toLowerCase())) {continue;}
            queue.push({ dir: join(next.dir, child), depth: next.depth + 1 });
        }
    }

    return roots;
}

/**
 * Read a remote's URL straight out of git's config file (no subprocess).
 * Sections look like `[remote "origin"]` followed by `url = …`; the quotes are
 * optional and either kind is accepted, since git only requires them when the
 * name contains whitespace. Returns the preferred remote's URL, falling back to
 * the first remote defined; the first `url` key inside a section wins.
 */
export function parseGitConfigRemoteUrl(raw: string, preferred = 'origin'): string | undefined {
    let preferredUrl: string | undefined;
    let firstUrl: string | undefined;
    let current: string | undefined;

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {continue;}

        const section = /^\[remote\s+(?:["']([^"'\]]+)["']|([^"'\]\s]+))\]$/.exec(trimmed);
        if (section) {
            current = section[1] ?? section[2];
            continue;
        }
        if (trimmed.startsWith('[')) {current = undefined; continue;}
        if (!current) {continue;}

        const url = /^url\s*=\s*(.*)$/.exec(trimmed);
        if (!url) {continue;}
        const value = url[1].trim().replace(/^["'](.*)["']$/, '$1');
        if (!value) {continue;}

        if (firstUrl === undefined) {firstUrl = value;}
        if (current === preferred && preferredUrl === undefined) {preferredUrl = value;}
    }

    return preferredUrl ?? firstUrl;
}

/** Lines of git output worth showing, in order, without repeats. */
function gitErrorLines(error: unknown): string[] {
    const sources = [
        typeof error === 'string' ? error : undefined,
        (error as { message?: unknown } | null | undefined)?.message,
        (error as { stderr?: unknown } | null | undefined)?.stderr,
        (error as { stdout?: unknown } | null | undefined)?.stdout
    ];
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const source of sources) {
        if (typeof source !== 'string') {continue;}
        for (const raw of source.split(/\r?\n/)) {
            // GitCommandRunner stores stderr in `message` as well, and turning an
            // Error into a string adds `Error: ` on top of that.
            const line = raw.trim().replace(/^Error:\s*/, '').replace(/^(?:fatal|error):\s*/, '');
            if (!line || seen.has(line)) {continue;}
            seen.add(line);
            lines.push(line);
        }
    }
    return lines;
}

/**
 * Show a failed git exec the way a person reads it: git's own sentence, once,
 * without the `Error: fatal: …` wrapper that stringifying the Error produced.
 */
export function formatGitError(error: unknown, maxLines = 4, maxLength = 400): string {
    const lines = gitErrorLines(error).slice(0, maxLines);
    if (lines.length === 0) {return '';}
    const text = lines.join(' ');
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** The actionable half of a remote failure: what to do about it. */
export type GitNetworkFailure = 'auth' | 'tls' | 'unreachable' | 'unknown';

/**
 * Sort a remote failure into the kinds the user can act on. Order matters: a TLS
 * problem arrives wrapped in a connect error, and git words a dead proxy exactly
 * like a dead network.
 */
export function classifyGitNetworkFailure(text: string): GitNetworkFailure {
    const lower = text.toLowerCase();
    if (/terminal prompts disabled|could not read (?:username|password)|authentication failed|invalid credentials|permission denied \(publickey\)|\b401\b|\b403\b|repository .*not found/.test(lower)) {
        return 'auth';
    }
    if (/ssl certificate|certificate verification failed|unable to get local issuer|certificate is not trusted|ssl_error|wrong version number/.test(lower)) {
        return 'tls';
    }
    if (/failed to connect|couldn'?t connect|could not connect|connect to \S+ port|could not resolve|name or service not known|nodename nor servname|connection refused|connection timed out|network is unreachable|recv failure|send failure|remote end hung up|returned error|timed out/.test(lower)) {
        return 'unreachable';
    }
    return 'unknown';
}

/**
 * A spawn that never reached git at all: the binary is missing or cannot be
 * executed. Unlike a non-zero exit, this is the one failure that means "no git
 * on this machine" rather than "git said no" — the availability memo uses it to
 * drop a positive probe taken in an earlier session.
 */
export function isMissingGitBinary(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM';
}

/**
 * A sequencer stop caused by a step whose changes turned out to be empty —
 * typically after the user resolved a conflict by keeping the other side. git
 * answers this with a wall of advice (`The previous cherry-pick is now empty, …
 * git commit --allow-empty … Otherwise, please use 'git cherry-pick --skip'`),
 * which is exactly the three choices the user has; ask for one instead.
 *
 * Measured on git 2.45.1: cherry-pick and rebase print that advice block, while
 * `git revert --continue` prints only the status header and
 * `nothing to commit, working tree clean` — the same stop, less talkative. Both
 * shapes are matched here; a plain "nothing to commit" on its own is not, and
 * neither is any stop that still has unmerged paths (git lists those under
 * "Unmerged paths:" instead of reporting a clean tree).
 */
export function isEmptyCommitStop(text: string): boolean {
    const lower = text.toLowerCase();
    if (lower.includes('is now empty') && lower.includes('allow-empty')) {return true;}
    return lower.includes('all conflicts fixed') && lower.includes('nothing to commit, working tree clean');
}

/**
 * Which commit the empty stop is about. git names it either as the pick in
 * progress (`You are currently cherry-picking commit a3c2a35.`) or in the
 * failure line of the same run (`Could not apply d9acd2da9... subject`); a
 * rebase says the latter and a bare cherry-pick the former.
 */
export function emptyCommitStopInfo(text: string): { hash?: string; subject?: string } {
    const picking = /currently (?:cherry-picking|reverting|applying) commit ([0-9a-f]{7,40})/i.exec(text);
    const applied = /could not apply ([0-9a-f]{7,40})\.\.\.[ \t]*([^\r\n]*)/i.exec(text);
    const hash = picking?.[1] ?? applied?.[1];
    const subject = applied?.[2]?.trim();
    return { hash, subject: subject ? subject : undefined };
}

/**
 * Hide credentials a proxy URL or remote URL may carry — only the host part is
 * ever worth putting in front of the user.
 */
export function redactUrlCredentials(value: string): string {
    return value.replace(/\/\/[^@/]+@/g, '//');
}

/**
 * The host git was talking to, so the message can name it:
 * `https://github.com/sveltejs/svelte/` → `github.com`,
 * `git@github.com:sveltejs/svelte.git` → `github.com`.
 */
export function gitFailureHost(text: string): string | undefined {
    const url = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s"']+@)?([^/:?\s"']+)/i.exec(text);
    if (url) {return url[1];}
    const scp = /[\w.-]+@([\w.-]+):/.exec(text);
    return scp ? scp[1] : undefined;
}

/**
 * The proxy a browser on this machine uses, read from a
 * `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
 * dump. git never consults the registry — it honours `http.proxy` and its own
 * env vars — which is precisely why "the site works in my browser" and
 * `Failed to connect to … port 443` are both true at the same time.
 *
 * Credentials are dropped rather than redacted: WinINET keeps them in a
 * separate value, and the result is meant to be pasted into
 * `git config --global http.proxy …`, so it has to stay a runnable URL.
 */
export function parseWindowsProxySettings(text: string): string | undefined {
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)\b/i.exec(text);
    if (!enabled || Number.parseInt(enabled[1], 16) === 0) {return undefined;}
    const server = /ProxyServer\s+REG_SZ\s+(\S[^\r\n]*)/i.exec(text);
    return server ? wininetProxyToUrl(server[1].trim()) : undefined;
}

/**
 * `ProxyServer` is free-form: a bare `host:port`, a full URL, or a `;`-separated
 * per-protocol list (`http=proxy:8080;https=proxy:8080`). `<local>`/`<-` markers
 * are bypass rules, not proxies.
 */
function wininetProxyToUrl(raw: string): string | undefined {
    const entries = raw.split(';').map(part => part.trim()).filter(part => part.length > 0 && !part.includes('<'));
    if (entries.length === 0) {return undefined;}
    const byProto: Record<string, string> = {};
    let bare: string | undefined;
    for (const entry of entries) {
        const eq = entry.indexOf('=');
        if (eq < 0) {
            bare = bare ?? entry;
            continue;
        }
        const value = entry.slice(eq + 1).trim();
        if (value.length > 0) {byProto[entry.slice(0, eq).toLowerCase()] = value;}
    }
    let value = bare;
    let proto: string | undefined;
    if (value === undefined) {
        const key = ['https', 'http', 'socks5', 'socks4', 'socks', 'all'].find(name => byProto[name] !== undefined)
            ?? Object.keys(byProto)[0];
        value = byProto[key];
        proto = key;
    }
    if (!value) {return undefined;}
    const withoutAuth = value.replace(/^((?:https?|socks\d\w*)):\/\/[^@/]+@/i, '$1://');
    if (/^(?:https?|socks\d\w*):\/\//i.test(withoutAuth)) {return withoutAuth;}
    if (!/^[\w.-]+(?::\d+)?$/.test(withoutAuth)) {return undefined;}
    // WinINET's `https=` says which traffic uses this proxy, not that the proxy
    // speaks TLS — the proxy itself takes a plain HTTP CONNECT, so git wants
    // `http://` there. A socks entry is a different protocol and has to keep its
    // scheme, and bare `socks` becomes `socks5` because git has no `socks://`.
    if (!proto || !proto.startsWith('socks')) {return `http://${withoutAuth}`;}
    return `${proto === 'socks' ? 'socks5' : proto}://${withoutAuth}`;
}

/** One configured remote: `git remote -v` gives the name and its fetch URL. */
export interface RemoteInfo {
    name: string;
    url: string;
}

/**
 * `git remote -v` output → one entry per remote. Each remote prints a fetch and
 * a push line; the fetch URL is the one every other part of the panel uses
 * (web links, push preview), so the push line only stands in when fetch is
 * absent. GitHub Actions-style multiline values cannot appear here: git
 * prints one line per URL by contract.
 */
export function parseRemoteList(raw: string): RemoteInfo[] {
    const byName = new Map<string, string>();
    for (const line of raw.split(/\r?\n/)) {
        const match = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line.trim());
        if (!match) {continue;}
        if (match[3] === 'fetch' || !byName.has(match[1])) {
            byName.set(match[1], match[2]);
        }
    }
    return Array.from(byName, ([name, url]) => ({ name, url }));
}

/**
 * Remote names end up in ref names (`refs/remotes/<name>/...`) and as argv, so
 * they follow git's conservative shape: no whitespace, no `..`, no leading
 * dash. `--` already keeps a leading dash from being read as an option, but a
 * name that git itself would reject should fail here with a readable message.
 */
export function assertRemoteName(value: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..')) {
        throw new Error(t('err.invalidRemoteName', { value }));
    }
    return value;
}

/**
 * Whether a branch name matches one of the protected patterns. `*` matches any
 * run of characters (`release/*`), everything else is literal. Branch names are
 * case-sensitive on every platform git supports, so this is too.
 */
export function matchesBranchPattern(name: string, patterns: readonly string[]): boolean {
    return patterns.some(raw => {
        const pattern = raw.trim();
        if (!pattern) {return false;}
        const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${source}$`).test(name);
    });
}

