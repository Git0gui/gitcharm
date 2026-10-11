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
