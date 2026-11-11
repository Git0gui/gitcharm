import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A search repaints rows, not the repository. These pin the two halves of that
 * promise: the host must not re-read the branch tree / arrows on every Enter,
 * and the panel must keep the old list readable under a hairline instead of
 * burying it under the full-cover blur — while still dropping everything that
 * belonged to the old list (upward window, rooted banner, dead selection).
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');
const webview = fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8');
const sheet = fs.readFileSync(path.join(ROOT, 'media', 'webview.css'), 'utf8');

function body(text: string, signature: RegExp): string {
    const match = text.match(signature);
    assert.ok(match, `${signature.source} must exist`);
    return match[0];
}

describe('search takes the rows-only path', () => {
    it('setFilters stores the filter and reloads rows, not the repository', () => {
        const handler = body(source, /case 'setFilters':[\s\S]*?break;/);
        assert.ok(/this\._filters = \{/.test(handler), 'the host owns the applied filter');
        assert.ok(/_reloadRows\(\)/.test(handler), 'a filter changes the answer, not the repository');
        assert.ok(!/this\._reload\(\)/.test(handler), '_reload re-reads branches and arrows on every Enter');
    });

    it('the rows path reads no branch list and refreshes no arrows', () => {
        const rows = body(source, /private async _reloadRows\([\s\S]*?\n {4}\}/);
        assert.ok(!/getBranchesWithDetails/.test(rows), 'the tree on screen is still true while a filter narrows the list');
        assert.ok(!/_refreshDivergence/.test(rows), 'arrows are repository state, not search results');
        assert.ok(!/this\._collect\(/.test(rows), '_collect is the full payload; the light path must not fall back into it');
    });

    it('commits only the bookkeeping a rows-only paint owns', () => {
        const rows = body(source, /private async _reloadRows\([\s\S]*?\n {4}\}/);
        const guard = rows.indexOf('ticket !== this._dataTicket');
        const loaded = rows.indexOf('this._loaded =');
        assert.ok(guard >= 0 && loaded > guard, 'a superseded search must not move the page counters');
        assert.ok(/this\._lastKnownTip = tip/.test(rows), 'the poll baseline must follow the rows it painted');
        assert.ok(!/this\._lastInProgress =/.test(rows), 'operation state is not delivered here, so baselining it would hide a real change from the watcher');
        assert.ok(/command: 'setCommits'/.test(rows), 'rows go out as setCommits: setData would rebuild the tree');
    });

    it('a vanished selection still gets the full path', () => {
        const rows = body(source, /private async _reloadRows\([\s\S]*?\n {4}\}/);
        assert.ok(
            /_dropVanishedBranch\(\)\) \{\s*await this\._reload\(force\);/.test(rows),
            'a deleted branch is structural: the ghost row in the tree needs the full reload'
        );
    });
});

describe('a search keeps the old list under a hairline', () => {
    it('the search busy area is its own strip, not the cover overlay', () => {
        const busy = body(webview, /function setBusy\(area, on\) \{[\s\S]*?\n\}/);
        assert.ok(/'search-busy'/.test(busy), 'the search indicator must be the hairline element');
        assert.ok(/var base = area === 'search' \? 'search-busy' : 'busy'/.test(busy), 'turning it off must not strip its base class');
        assert.ok(/id="search-busy"/.test(source), 'the strip must exist in the panel document');
        assert.ok(/\.search-busy\.on/.test(sheet), 'and have a visible on-state');
        assert.ok(!/\.search-busy\.on \{[^}]*position: absolute;\s*inset: 0/.test(sheet), 'a full-cover strip would bury the list it is meant to keep readable');
    });

    it('setCommits drops what belonged to the old list', () => {
        const handler = body(webview, /m\.command === 'setCommits'\) \{[\s\S]*?\n {4}\} else if/);
        assert.ok(/state\.hasMoreAbove = !!m\.hasMoreAbove/.test(handler), 'the upward window dies with the rooted list, or the top loader spins forever');
        assert.ok(/state\.loadingMoreAbove = false/.test(handler), 'same for the in-flight flag');
        assert.ok(/state\.rooted = m\.rooted \|\| null/.test(handler), 'the rooted banner must go when the search un-roots the list');
        assert.ok(/announceSearch\(m\.searchContext\)/.test(handler), 'the result count is announced on the rows-only path too');
    });

    it('a selection the results still hold keeps its detail', () => {
        const handler = body(webview, /m\.command === 'setCommits'\) \{[\s\S]*?\n {4}\} else if/);
        assert.ok(
            /var keep = !!state\.selectedHash && state\.commits\.some/.test(handler),
            'searching must not wipe the third column for a commit that is still in the results'
        );
        assert.ok(/if \(!keep\) \{[\s\S]*?state\.detail = null/.test(handler), 'one the results no longer hold must not keep pointing at a gone row');
    });

    it('both painters announce the count the same way', () => {
        const setData = body(webview, /m\.command === 'setData'\) \{[\s\S]*?\n {4}\} else if/);
        assert.ok(/announceSearch\(m\.searchContext\)/.test(setData), 'the full path and the light path must not drift apart');
        assert.ok(/function announceSearch\(ctx\) \{/.test(webview), 'one implementation, two callers');
    });
});