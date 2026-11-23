/*
 * Pure helpers for the "nothing changed, do not reload" short circuit.
 *
 * A re-shown panel must still paint its rows: hiding a WebviewView destroys the
 * DOM. But the rows it needs are already in the extension host's memory, so the
 * host can replay the last payload instead of running `_collect` (git log +
 * refs snapshot + a loading spinner) a second time. These functions decide
 * whether that replay is honest. No vscode import so node:test can load them.
 */

/** The parts of a full `setData` payload that describe what is on screen. */
export interface PaintSnapshot {
    commits: Array<{ hash: string }>;
    local: string[];
    remote: string[];
    currentBranch: string;
    selectedBranch: string;
    repoName: string;
    hasMore: boolean;
    hasMoreAbove: boolean;
    headHash: string;
    inProgress?: string;
    favorites?: string[];
    recent?: string[];
    rooted?: { hash: string; filtersPaused: boolean };
}

/** Everything that can change the answer without changing the commit list. */
export interface PaintScope {
    repoPath: string;
    branch: string;
    tip: string;
    rootRev: string;
    /** GitService.volatileEpoch: invalidated caches mean the screen is stale. */
    epoch: number;
    filters: {
        text?: string;
        regex?: boolean;
        caseSensitive?: boolean;
        author?: string;
        from?: string;
        to?: string;
        path?: string;
    };
}

/**
 * Identity of the painted screen. U+001F is illegal in a ref name and cannot
 * appear in any of these fields, so values cannot collide across boundaries.
 * `epoch` makes an external ref change (which drops the volatile caches) a
 * different screen, so a stale payload can never be replayed as current.
 */
export function paintSignature(scope: PaintScope): string {
    const f = scope.filters;
    return [
        String(scope.epoch), scope.repoPath, scope.branch, scope.tip, scope.rootRev,
        f.text ?? '', f.regex ? 'R' : '-', f.caseSensitive ? 'C' : '-',
        f.author ?? '', f.from ?? '', f.to ?? '', f.path ?? ''
    ].join('\u001f');
}

function eqStrings(a: string[] | undefined, b: string[] | undefined): boolean {
    const x = a ?? [];
    const y = b ?? [];
    if (x.length !== y.length) {return false;}
    for (let i = 0; i < x.length; i++) {
        if (x[i] !== y[i]) {return false;}
    }
    return true;
}

/**
 * True only when a full `setData` would paint exactly the same screen. A
 * rows-only `setCommits` is then safe: it leaves the branch tree alone and
 * keeps the selected commit and its detail, which `setData` would clear.
 */
export function samePaint(a: PaintSnapshot | undefined, b: PaintSnapshot | undefined): boolean {
    if (a === b) {return true;}
    if (!a || !b) {return false;}
    if (a.commits.length !== b.commits.length) {return false;}
    for (let i = 0; i < a.commits.length; i++) {
        if (a.commits[i].hash !== b.commits[i].hash) {return false;}
    }
    return a.currentBranch === b.currentBranch
        && a.selectedBranch === b.selectedBranch
        && a.repoName === b.repoName
        && a.hasMore === b.hasMore
        && a.hasMoreAbove === b.hasMoreAbove
        && a.headHash === b.headHash
        && (a.inProgress ?? undefined) === (b.inProgress ?? undefined)
        && eqStrings(a.local, b.local)
        && eqStrings(a.remote, b.remote)
        && eqStrings(a.favorites, b.favorites)
        && eqStrings(a.recent, b.recent)
        && (a.rooted?.hash ?? '') === (b.rooted?.hash ?? '')
        && (a.rooted?.filtersPaused ?? false) === (b.rooted?.filtersPaused ?? false);
}
