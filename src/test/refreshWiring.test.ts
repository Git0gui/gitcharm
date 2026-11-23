import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The refresh coalescing is behavioural, but its wiring is load-bearing: a
 * path that quietly drops the scheduler, or a duplicate call point that comes
 * back, reintroduces the "one commit, several git log spawns" bug. These pin
 * the call sites the same way startupReload / paintCache pin theirs.
 */
const ROOT = path.resolve(__dirname, '..', '..');
const view = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');
const service = fs.readFileSync(path.join(ROOT, 'src', 'services', 'gitService.ts'), 'utf8');

function slice(text: string, from: string, to: string): string {
    const start = text.indexOf(from);
    assert.ok(start >= 0, `${from} must exist`);
    const end = to ? text.indexOf(to, start + from.length) : -1;
    return end > start ? text.slice(start, end) : text.slice(start);
}

describe('rows and arrows go through the refresh scheduler', () => {
    const reload = slice(view, 'private async _reload(force:', 'private async _reloadRows(');
    const rows = slice(view, 'private async _reloadRows(', 'private async _reloadBranchesOnly(');
    const divergence = slice(view, 'private async _refreshDivergence(', 'private _getHtmlForWebview(');
    const branches = slice(view, 'private async _refreshBranchesOnly(', 'private _postLoading(');

    it('a full reload claims the channel, checks its generation and releases it', () => {
        assert.match(reload, /_rowsRefresh\.begin\(/);
        assert.match(reload, /_rowsRefresh\.isLatest\(claim\.generation\)/);
        assert.match(reload, /_finishRowsRefresh\(\)/);
    });

    it('the rows-only search path shares the same channel', () => {
        assert.match(rows, /_rowsRefresh\.begin\(/);
        assert.match(rows, /_rowsRefresh\.isLatest\(claim\.generation\)/);
        assert.match(rows, /_finishRowsRefresh\(\)/);
    });

    it('divergence is claimed, generation-checked and released', () => {
        assert.match(divergence, /_divergenceRefresh\.begin\(/);
        assert.match(divergence, /_divergenceRefresh\.isLatest\(claim\.generation\)/);
        assert.match(divergence, /_finishDivergenceRefresh\(\)/);
    });

    it('divergence treats force as a strength, not a separate scope', () => {
        assert.doesNotMatch(divergence, /force \? 'force' : 'cached'/,
            'encoding force in the key bought a second full query after every forced one');
        const channel = slice(view, 'private _divergenceRefresh = new RefreshScheduler',
            'private _branchesRefresh');
        assert.match(channel, /prev\.force \|\| next\.force/,
            'a later cached request must not downgrade a queued forced refresh');
        assert.match(channel, /next\.force && !running\.force/,
            'a fresh request must not be answered by the cached query already in flight');
    });

    it('there is exactly one branches-only implementation and no 50ms timer', () => {
        assert.match(branches, /_branchesRefresh\.begin\(/);
        assert.match(branches, /_finishBranchesRefresh\(\)/);
        assert.doesNotMatch(view, /setTimeout\(\(\) => \{\s*void this\._refreshDivergence/,
            'the floating 50ms divergence query raced with user refreshes');
        assert.match(slice(view, 'private async _reloadBranchesOnly(', 'private async _refreshBranchesOnly('),
            /await this\._refreshBranchesOnly\(\)/, 'the old duplicate must delegate, not re-implement');
    });
});

describe('duplicate trigger points stay removed', () => {
    it('auto-fetch does not refresh divergence twice', () => {
        const auto = slice(view, 'private async _tickAutoFetch(', 'private _startBranchCheck(');
        assert.match(auto, /await this\._refreshBranchesOnly\(\)/);
        assert.doesNotMatch(auto, /this\._refreshDivergence\(\)/);
    });

    it('a re-shown panel and a double-click force their arrows through', () => {
        const shown = slice(view, 'private async _onPanelShown(', 'private _flushViewState(');
        assert.match(shown, /_divergenceRefresh\.invalidateReuse\(\)/);
        assert.match(shown, /void this\._refreshDivergence\(false\)/);
        // A forced read drops the reuse window inside _refreshDivergence itself,
        // so no caller can forget it. The double-click just asks for `true`.
        const divBody = slice(view, 'private async _refreshDivergence(', 'private _getHtmlForWebview(');
        assert.match(divBody, /if \(force\) \{/);
        assert.match(divBody, /this\._divergenceRefresh\.invalidateReuse\(\)/);
        const select = slice(view, "case 'selectBranch': {", "case 'refresh':");
        assert.match(select, /void this\._refreshDivergence\(true\)/);
    });

    it('an external tip change is never answered by a reused paint', () => {
        const check = slice(view, 'private async _checkBranchNow(', '/**\n     * Whether a branch still resolves');
        assert.match(check, /_rowsRefresh\.invalidateReuse\(\)/);
        assert.match(check, /_lastPaint\.signature === this\._paintSignature\(tip\)/);
    });

    it('a repeated filter still reaches the rows channel (0 spawn, one repaint)', () => {
        const handler = slice(view, "case 'setFilters':", "case 'loadMore':");
        assert.match(handler, /_reloadRows\(\)/);
        assert.doesNotMatch(handler, /sameFilters/,
            'suppressing the reply would break the search probe, which waits for setCommits');
    });
});

describe('the .git watcher does not invalidate our own mutation twice', () => {
    const watch = slice(service, 'private _scheduleWatchInvalidation()', 'private _stopRepositoryWatch()');

    it('skips the echo inside the self-write window but still invalidates external writes', () => {
        assert.match(watch, /Date\.now\(\) < this\._selfWriteUntil/);
        assert.match(watch, /return;/, 'the echo must not reach invalidateVolatile');
        assert.match(watch, /this\.invalidateVolatile\(\);/, 'an external change still drops caches');
    });

    it('keeps the pinned invalidateVolatile signature intact', () => {
        assert.match(service, /invalidateVolatile\(\): void \{/);
        assert.match(service, /this\._volatileEpoch\+\+/);
    });

    it('opens the self-write window ONLY from real mutation paths', () => {
        const invalidate = slice(service, 'invalidateVolatile(): void {',
            'private _invalidateAfterMutation()');
        assert.doesNotMatch(invalidate, /_selfWriteUntil/,
            'a read-side invalidation must not suppress the watcher of a real external change');
        const afterMutation = slice(service, 'private _invalidateAfterMutation(): void {',
            '/**\n     * Read-only generation counter');
        assert.match(afterMutation, /_selfWriteUntil = Date\.now\(\) \+ WATCH_SELF_WRITE_SUPPRESS_MS/);
        assert.match(afterMutation, /this\.invalidateVolatile\(\)/);

        for (const [start, end] of [
            ['private async _execMutate(args:', '/**\n     * Mutating exec with extra'],
            ['private async _execMutateWithEnv(', '/**\n     * A failed write'],
            ['private async _execNetwork(', '/**\n     * True when the user dismissed'],
            ['async fetchSilent(', '/**\n     * Compare a branch']
        ]) {
            assert.match(slice(service, start, end), /_invalidateAfterMutation\(\)/,
                `${start} must open the window after its write`);
        }
    });
});
