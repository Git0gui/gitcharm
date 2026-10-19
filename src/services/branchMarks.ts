import * as fs from 'fs';
import * as path from 'path';
import { resolveGitDir } from './gitPaths';
import { repositoryKey } from './gitUtils';
import { logger } from './logger';

/**
 * The branch tree's two pinned sections: favorites the user marked, and the
 * branches HEAD has actually moved through. Both are lists of branch names, both
 * belong to one repository, and neither is git state the panel invents — a
 * favorite is a preference, a recent branch is git's own record.
 */

/** Shape version of the persisted favorites; a mismatch is discarded, not migrated. */
export const FAVORITES_VERSION = 1;

/** How far back the checkout log is mined, and at most how many rows "Recent" shows. */
export const RECENT_BRANCH_LIMIT = 8;

/**
 * Favorites keyed by repository. Two roots of a multi-folder workspace may both
 * own a branch named `main`, so a single shared list would let one project's
 * marks leak into another's tree.
 */
export interface FavoriteStore {
    version: number;
    byRepository: Record<string, string[]>;
}

export function emptyFavoriteStore(): FavoriteStore {
    return { version: FAVORITES_VERSION, byRepository: {} };
}

/**
 * Read a persisted value back into a store. Anything failing validation is
 * dropped rather than repaired, so one poisoned entry (the old quoted-branch
 * bug produced those) cannot make the whole feature unusable.
 */
export function normalizeFavoriteStore(raw: unknown): FavoriteStore {
    if (!raw || typeof raw !== 'object') {return emptyFavoriteStore();}
    const value = raw as { version?: unknown; byRepository?: unknown };
    if (value.version !== FAVORITES_VERSION || !value.byRepository || typeof value.byRepository !== 'object') {
        return emptyFavoriteStore();
    }

    const byRepository: Record<string, string[]> = {};
    for (const [key, list] of Object.entries(value.byRepository as Record<string, unknown>)) {
        if (!Array.isArray(list)) {continue;}
        const clean: string[] = [];
        for (const name of list) {
            if (typeof name !== 'string') {continue;}
            const trimmed = name.trim();
            // A quoted name is the signature of the old spawn-quoting bug.
            if (!trimmed || trimmed.startsWith('"') || trimmed.endsWith('"')) {continue;}
            if (!clean.includes(trimmed)) {clean.push(trimmed);}
        }
        if (clean.length > 0) {byRepository[key] = clean;}
    }
    return { version: FAVORITES_VERSION, byRepository };
}

export function favoritesOf(store: FavoriteStore, repoPath: string | undefined): string[] {
    if (!repoPath) {return [];}
    return [...(store.byRepository[repositoryKey(repoPath)] ?? [])];
}

/** Add the branch when it is not marked yet, otherwise drop the mark. */
export function withFavoriteToggled(
    store: FavoriteStore,
    repoPath: string | undefined,
    branch: string
): { store: FavoriteStore; favorites: string[] } {
    if (!repoPath || !branch) {
        return { store, favorites: favoritesOf(store, repoPath) };
    }
    const key = repositoryKey(repoPath);
    const current = store.byRepository[key] ?? [];
    const next = current.includes(branch)
        ? current.filter(name => name !== branch)
        : [...current, branch];

    const byRepository = { ...store.byRepository };
    if (next.length === 0) {
        delete byRepository[key];
    } else {
        byRepository[key] = next;
    }
    return { store: { version: store.version, byRepository }, favorites: next };
}

/** Move a mark from a branch's old name to its new one, keeping its position. */
export function withFavoriteRenamed(
    store: FavoriteStore,
    repoPath: string | undefined,
    oldName: string,
    newName: string
): { store: FavoriteStore; favorites: string[] } {
    const current = favoritesOf(store, repoPath);
    const at = current.indexOf(oldName);
    if (!repoPath || at < 0) {return { store, favorites: current };}
    const next = current.map(name => (name === oldName ? newName : name));
    const byRepository = { ...store.byRepository, [repositoryKey(repoPath)]: next };
    return { store: { version: store.version, byRepository }, favorites: next };
}

const CHECKOUT_PREFIX = 'checkout: moving from ';

/**
 * The branch a `checkout:` reflog subject moved HEAD onto, or undefined when the
 * step did not land on a branch. Detached checkouts are named `(detached …)` or
 * a bare hash, and both would render as a row that cannot be checked out.
 *
 * The target is read from the last ` to ` because the *source* side may itself
 * contain spaces (`moving from (detached from 1ab) to main`), while a branch
 * name never does.
 */
export function checkoutTarget(subject: string): string | undefined {
    if (!subject.startsWith(CHECKOUT_PREFIX)) {return undefined;}
    const rest = subject.substring(CHECKOUT_PREFIX.length);
    const at = rest.lastIndexOf(' to ');
    if (at < 0) {return undefined;}
    const target = rest.substring(at + 4).trim();
    if (!target || target.startsWith('(') || /^[0-9a-f]{7,40}$/i.test(target)) {return undefined;}
    return target;
}

/**
 * Branch names HEAD moved onto, newest first, read out of a `.git/logs/HEAD`
 * body. Every line is `<old> <new> <committer> <timestamp> <tz>\t<subject>`.
 */
export function parseCheckoutTargets(logText: string, limit = RECENT_BRANCH_LIMIT): string[] {
    const names: string[] = [];
    const lines = logText.split('\n');
    for (let i = lines.length - 1; i >= 0 && names.length < limit; i--) {
        const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
        const tab = line.indexOf('\t');
        if (tab < 0) {continue;}
        const target = checkoutTarget(line.substring(tab + 1).trim());
        if (!target || names.includes(target)) {continue;}
        names.push(target);
    }
    return names;
}

/**
 * Tail bytes of the log worth reading. A long-lived repository's `logs/HEAD` can
 * reach megabytes, and only the end of it can answer "what did I check out
 * lately" — the first line of a partial window is skipped as possibly truncated.
 */
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * Recent branches straight from git's HEAD reflog.
 *
 * Mining the log instead of recording our own checkout commands is what makes a
 * branch switched in a terminal, by the built-in Git UI, or from another worktree
 * show up here too — the panel is not the only thing that moves HEAD. The cost is
 * that git's retention rules apply: `gc.reflogExpire` (90 days by default) and a
 * `git gc --prune` can drop old entries, so this is "as far back as git remembers".
 */
export class RecentBranchReader {
    private _cache: { signature: string; names: string[] } | undefined;

    constructor(private readonly _getRepoPath: () => string | undefined) {}

    /**
     * Most recent first, with `currentBranch` always heading the list — HEAD's own
     * row is the one checkout record that cannot be missing.
     */
    read(currentBranch: string, limit = RECENT_BRANCH_LIMIT): string[] {
        const repoPath = this._getRepoPath();
        if (!repoPath) {return currentBranch ? [currentBranch] : [];}

        const names: string[] = [];
        const push = (name: string) => {
            if (name && !names.includes(name) && names.length < limit) {names.push(name);}
        };
        push(currentBranch);
        for (const name of this._readLog(repoPath)) {push(name);}
        return names;
    }

    invalidate(): void {
        this._cache = undefined;
    }

    private _readLog(repoPath: string): string[] {
        const gitDir = resolveGitDir(repoPath);
        if (!gitDir) {return [];}
        // HEAD's log belongs to this worktree, not to the shared commondir.
        const logPath = path.join(gitDir, 'logs', 'HEAD');

        let signature: string;
        try {
            const stat = fs.statSync(logPath);
            signature = `${repoPath}|${stat.mtimeMs}|${stat.size}`;
        } catch {
            return [];
        }
        if (this._cache && this._cache.signature === signature) {
            return this._cache.names;
        }

        let names: string[] = [];
        try {
            names = parseCheckoutTargets(this._readTail(logPath));
        } catch (error) {
            logger.debug('[GitCharm] HEAD checkout log unreadable:', error);
        }
        this._cache = { signature, names };
        return names;
    }

    /** Read the last bytes of a file — the log is appended to, so the tail is the present. */
    private _readTail(filePath: string): string {
        const fd = fs.openSync(filePath, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const length = Math.min(size, LOG_TAIL_BYTES);
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, size - length);
            const text = buffer.toString('utf8');
            return size > length ? text.substring(text.indexOf('\n') + 1) : text;
        } finally {
            fs.closeSync(fd);
        }
    }
}
