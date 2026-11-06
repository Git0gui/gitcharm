/**
 * Versioned persistence for the first page of the commit list.
 *
 * The page the panel paints on open is `git log -n 20`, and that single spawn is
 * the most expensive thing between opening a window and seeing rows (43–58ms
 * measured on this repository, more with loose objects). Everything the rows need
 * is immutable history, so the last page can be remembered and painted
 * immediately — then re-validated by the normal load. The stamp that makes that
 * safe is the tip of the rev the page was walked from: while the tip still
 * matches, the rows are not merely similar, they are the same rows.
 *
 * Pure functions with no vscode/git dependencies, so the format is unit-testable.
 * Anything that fails validation is discarded by the caller and rebuilt from git.
 */

import type { GraphCommit } from './gitService';

export const FIRST_PAGE_VERSION = 1;

/**
 * How stale a remembered page may be and still be painted. Deliberately the same
 * window as the view-state snapshot (graphView.SESSION_RESTORE_TTL_MS): beyond it
 * the panel starts fresh anyway, and a page from yesterday would be describing a
 * repository the user has since been working in.
 */
export const FIRST_PAGE_TTL_MS = 2 * 60 * 60 * 1000;

/** One page is PAGE_FIRST rows; nothing legitimate comes near this cap. */
const MAX_ROWS = 60;
/** A page of rows with long messages can outgrow what belongs in a Memento. */
const MAX_BYTES = 64 * 1024;

const HASH_RE = /^[0-9a-f]{7,64}$/i;

export interface PersistedFirstPage {
    version: number;
    /** Wall clock when the rows were read; the TTL is measured from this. */
    savedAt: number;
    repoPath: string;
    /** Branch the list was rooted at; undefined is the all-branches scope. */
    branch: string | undefined;
    /** Tip of that rev when the page was walked. */
    tip: string;
    commits: GraphCommit[];
    hasMore: boolean;
}

function _isCleanRefName(name: unknown): name is string {
    // Names wrapped in quotes came from the old spawn quoting bug and must never
    // be trusted again; an empty name is the all-branches scope, not a branch.
    return typeof name === 'string' && name.length > 0
        && !name.startsWith('"') && !name.endsWith('"');
}

function _isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function _isValidRow(value: unknown): value is GraphCommit {
    if (!value || typeof value !== 'object') {return false;}
    const c = value as Record<string, unknown>;
    return typeof c.hash === 'string' && HASH_RE.test(c.hash)
        && typeof c.shortHash === 'string' && HASH_RE.test(c.shortHash)
        && typeof c.message === 'string'
        && typeof c.author === 'string'
        && typeof c.authorEmail === 'string'
        && typeof c.date === 'string'
        && typeof c.committer === 'string'
        && typeof c.committerEmail === 'string'
        && typeof c.committerDate === 'string'
        && typeof c.isMerge === 'boolean'
        && _isStringArray(c.parents) && _isStringArray(c.refs) && _isStringArray(c.tags);
}

/**
 * Serialize a first page for persistence. Returns undefined when the payload
 * would not fit or the scope is not describable — a page the panel could not
 * re-validate against a tip is not worth remembering.
 */
export function serializeFirstPage(input: {
    repoPath: string;
    branch?: string;
    tip: string;
    commits: GraphCommit[];
    hasMore: boolean;
    savedAt?: number;
}): string | undefined {
    if (!input.repoPath || !HASH_RE.test(input.tip) || input.commits.length === 0) {return undefined;}
    if (input.branch !== undefined && !_isCleanRefName(input.branch)) {return undefined;}
    if (input.commits.length > MAX_ROWS || !input.commits.every(_isValidRow)) {return undefined;}

    const data: PersistedFirstPage = {
        version: FIRST_PAGE_VERSION,
        savedAt: input.savedAt ?? Date.now(),
        repoPath: input.repoPath,
        branch: input.branch,
        tip: input.tip,
        commits: input.commits,
        hasMore: input.hasMore
    };
    const json = JSON.stringify(data, null, 2);
    return json.length > MAX_BYTES ? undefined : json;
}

/**
 * Parse and validate persisted content. Returns undefined for anything that is
 * malformed, of a stale version, outside the TTL, or carries a row that is not a
 * row — the caller then rebuilds the page from git and overwrites it.
 */
export function parseFirstPage(content: string, now: number = Date.now()): PersistedFirstPage | undefined {
    try {
        const raw = JSON.parse(content);
        if (!raw || typeof raw !== 'object') {return undefined;}
        if (raw.version !== FIRST_PAGE_VERSION) {return undefined;}
        if (typeof raw.savedAt !== 'number' || typeof raw.repoPath !== 'string' || !raw.repoPath) {return undefined;}
        if (raw.branch !== undefined && !_isCleanRefName(raw.branch)) {return undefined;}
        if (typeof raw.tip !== 'string' || !HASH_RE.test(raw.tip)) {return undefined;}
        if (typeof raw.hasMore !== 'boolean') {return undefined;}
        if (!Array.isArray(raw.commits) || raw.commits.length === 0 || raw.commits.length > MAX_ROWS) {return undefined;}
        if (!raw.commits.every(_isValidRow)) {return undefined;}
        if (now - raw.savedAt > FIRST_PAGE_TTL_MS) {return undefined;}
        return raw as PersistedFirstPage;
    } catch {
        return undefined;
    }
}
