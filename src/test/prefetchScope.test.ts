import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The first page two different code paths ask for must be the same page.
 *
 * The startup prefetch exists only because its query turns the first open's
 * `git log` into a cache hit; the moment the two requests disagree — different
 * limit, different scope, a filter the other one forgot — the panel pays for
 * both. So the prefetch calls `_firstPageRows` itself, and this file is what
 * keeps it from growing a second, hand-written copy of that request.
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');

function body(signature: string): string {
    // The closing `}` has to be the whole line: `_firstPageRows` opens its return
    // type with a `}> {` that is indented exactly like a method close.
    const match = source.match(new RegExp(`${signature}[\\s\\S]*?\\n {4}\\}(?:\\r?\\n)`));
    assert.ok(match, `${signature} must exist in graphView.ts`);
    return match[0];
}

describe('startup prefetch shares the first-page request', () => {
    const entry = body('private _runStartupPrefetch\\(\\): void \\{');
    const scheduled = body('prefetchFirstPage\\(\\): void \\{');
    const page = body('private async _firstPageRows\\(force: boolean\\)');

    it('asks for the page through _firstPageRows, not a request of its own', () => {
        assert.match(entry, /this\._firstPageRows\(/);
        for (const [name, text] of [['prefetchFirstPage', scheduled], ['_runStartupPrefetch', entry]] as const) {
            assert.doesNotMatch(
                text,
                /getCommitGraphData\(/,
                `${name} building its own git log request is how the two pages drift apart and the first open stops being a cache hit`
            );
        }
    });

    it('starts the page before installing the task that waits for it', () => {
        const started = entry.indexOf('this._firstPageRows(');
        const installed = entry.indexOf('this._prefetchTask =');
        assert.ok(started >= 0 && installed >= 0);
        assert.ok(
            started < installed,
            '_firstPageRows awaits _prefetchTask, so assigning it first makes the prefetch await itself and never finish'
        );
    });

    it('warms the refs snapshot the divergence arrows read', () => {
        assert.match(entry, /getBranchesWithDetails\(false\)/);
        assert.match(entry, /getHeadHash\(\)/);
    });

    it('matches the page request the first open makes', () => {
        assert.match(page, /limit:\s*pageLimit/);
        assert.match(page, /branch:\s*this\._listRev\(\)/);
        assert.match(page, /filters:\s*this\._pageFilters\(\)/);
    });

    it('restores the remembered branch so the warmed scope is the shown scope', () => {
        assert.match(entry, /this\._branch = remembered/);
        assert.match(entry, /getBranchTipHash\(remembered\)/);
    });
});

describe('a panel nobody looked at does not compete with startup', () => {
    const scheduled = body('prefetchFirstPage\\(\\): void \\{');
    const resolve = body('async resolveWebviewView\\(webviewView');

    it('delays the prefetch only when the last session ended hidden', () => {
        assert.match(scheduled, /PANEL_VISIBLE_KEY[\s\S]*=== false/);
        assert.match(scheduled, /this\._prefetchDelay = setTimeout\(/);
    });

    it('fires immediately once the panel is opened', () => {
        assert.match(resolve, /clearTimeout\(this\._prefetchDelay\)/);
        assert.match(resolve, /this\._runStartupPrefetch\(\)/);
        assert.match(resolve, /_rememberPanelVisibility\(webviewView\.visible/);
    });

    it('records both visibility outcomes', () => {
        const visibility = source.match(/webviewView\.onDidChangeVisibility\(\(\) => \{[\s\S]*?\n {8}\}\)/);
        assert.ok(visibility, 'the panel visibility handler must exist');
        assert.match(visibility[0], /_rememberPanelVisibility\(!!webviewView\.visible\)/);
    });

    it('drops a scheduled prefetch when the repository changes', () => {
        const switched = body('async switchRepository\\(rootPath: string\\)');
        assert.match(switched, /clearTimeout\(this\._prefetchDelay\)/);
    });

    it('clears the timer on dispose', () => {
        const disposed = body('dispose\\(\\): void \\{');
        assert.match(disposed, /clearTimeout\(this\._prefetchDelay\)/);
    });
});

describe('the remembered page survives its own verification', () => {
    const reload = body('private async _reload\\(force: boolean = false, preserveSelection = false\\)');
    const paint = body('private async _paintPersistedFirstPage\\(\\)');

    it('a reload that lands on the snapshot keeps what the panel restored', () => {
        assert.match(
            reload,
            /preserveSelection: preserveSelection \|\| this\._takeSnapshotPaint\(\)/,
            'setData without preserveSelection resets selection, folds and scroll. The cold load answers with setCommits, which only replaces the page, '
            + 'but any _reload that arrives while the remembered rows are still on screen (the refresh button, an external commit) would wipe exactly the '
            + 'state restoreViewState had just put back — measured with a stubbed webview: the first setData after the paint carries true, the next one false'
        );
    });

    it('the paint is what spends that credit', () => {
        assert.match(paint, /this\._rowsPaintedFromSnapshot = true/);
        const root = body('private _setRoot\\(rev: string\\)');
        assert.match(root, /this\._rowsPaintedFromSnapshot = false/);
    });
});

describe('the remembered page is painted, then answered', () => {
    const persist = body('private _persistFirstPage\\(commits: GraphCommit\\[\\]\\)');
    const page = body('private async _firstPageRows\\(force: boolean\\)');
    const paint = body('private async _paintPersistedFirstPage\\(\\)');
    const resolve = body('async resolveWebviewView\\(webviewView');

    it('remembers only a plain first page', () => {
        assert.match(page, /if \(!rooted && !this\._hasActiveFilters\(\)\) \{void this\._persistFirstPage/);
        assert.match(persist, /serializeFirstPage\(/);
    });

    it('holds the rows to the tip they were walked from', () => {
        assert.match(paint, /parseFirstPage\(/);
        assert.match(paint, /snap\.repoPath !== this\._gitService\.repositoryPath/);
        assert.match(paint, /snap\.branch !== this\._branch/);
        assert.match(paint, /tip !== snap\.tip/);
    });

    it('never paints over a reveal or over rows that already arrived', () => {
        assert.match(paint, /if \(this\._pendingReveal \|\| this\._revRoot \|\| this\._hasActiveFilters\(\)\)/);
        assert.match(paint, /_loadedHashes\.size > 0 \|\| this\._pendingReveal \|\| this\._revRoot/);
    });

    it('seeds the paging counters with what it painted', () => {
        assert.match(paint, /this\._loaded = snap\.commits\.length/);
        assert.match(paint, /this\._hasMore = snap\.hasMore/);
        assert.match(paint, /this\._loadedHashes = new Set\(/);
    });

    it('paints before the git-backed load starts', () => {
        const painted = resolve.indexOf('_paintPersistedFirstPage()');
        const loaded = resolve.indexOf('this.refreshRepoState()');
        assert.ok(painted >= 0 && loaded >= 0);
        assert.ok(painted < loaded, 'the snapshot is the point: rows first, verification after');
    });
});
