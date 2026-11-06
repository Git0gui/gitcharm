import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Two invariants the commit list keeps breaking in the field.
 *
 * 1. 「全部分支」 means branches. `--all` means every ref under refs/, so commits
 *    no branch owns walk into the list — this repo carries three of them under
 *    `refs/agents/<session>/checkpoints/`, and they render as rows with no badge
 *    and nothing in the tree on the left. The same scope has to answer
 *    `countCommitsAfter`, or the rooted window's `--skip` is computed against a
 *    wider ref set and leaves a hole.
 * 2. The rows above a revealed commit must be its own descendants, so they walk a
 *    ref that contains it (`up`), never simply the scope the panel happened to be
 *    on — blame reports commits for the checked-out branch while the list may sit
 *    on another one, and then the whole of that other history stacks up above.
 *
 * Like the other guard files, these read the source: the code they pin is inside
 * a module that imports vscode and cannot be loaded by node:test.
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const service = fs.readFileSync(path.join(ROOT, 'src', 'services', 'gitService.ts'), 'utf8');
const provider = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8');
const sheet = fs.readFileSync(path.join(ROOT, 'media', 'webview.css'), 'utf8');

function body(text: string, signature: RegExp): string {
    const match = text.match(signature);
    assert.ok(match, `${signature.source} must exist`);
    return match[0];
}

describe('all-branches scope', () => {
    it('is local plus remote, not every ref', () => {
        const decl = body(service, /const ALL_BRANCHES_SCOPE = \[[^\]]*\]/);
        assert.deepEqual(
            decl.match(/'([^']+)'/g)!.map(s => s.slice(1, -1)),
            ['--branches', '--remotes']
        );
    });

    it('is what the commit list walks when no branch is selected', () => {
        const build = body(service, /const buildArgs = \(forHash[\s\S]*?a\.push\('--topo-order'\)/);
        assert.ok(/ALL_BRANCHES_SCOPE/.test(build), 'the list query must use the shared scope');
        assert.ok(!/'--all'/.test(build), "`--all` would add commits no branch owns to 「全部分支」");
    });

    it('is the same scope the rooted window counts', () => {
        const count = body(service, /async countCommitsAfter\([\s\S]*?\n {8}\}/);
        assert.ok(/ALL_BRANCHES_SCOPE/.test(count), 'a count over a wider ref set than the list leaves a hole above the rooted commit');
        assert.ok(!/'--all'/.test(count), "`--all` here and branches-remotes in the list are two different histories");
    });
});

describe('rooted list (blame jump / reveal commit)', () => {
    it('walks a ref resolved to contain the commit, above and below', () => {
        const descendants = body(provider, /private async _rootedDescendants\([\s\S]*?\n {4}\}/);
        const up = body(provider, /private async _loadMoreUp\([\s\S]*?\n {4}\}/);
        for (const fn of [descendants, up]) {
            assert.ok(/await root\.up/.test(fn), 'both halves of the upward window must come from the same resolved scope');
            assert.ok(/branch: up/.test(fn), 'the descendant walk runs against the containing branch');
            assert.ok(!/branch: root\.branch/.test(fn), 'the panel scope can be a branch that does not contain the commit at all');
        }
    });

    it('shows nothing above a commit no branch contains', () => {
        const descendants = body(provider, /private async _rootedDescendants\([\s\S]*?\n {4}\}/);
        assert.ok(
            /if \(!up\) \{return \{ commits: \[\], above: 0, after: 0 \};\}/.test(descendants),
            'an unrootable commit gets no upward rows instead of every other branch history'
        );
    });

    it('prefers the panel branch, then the checked-out branch, then any containing one', () => {
        const scope = body(provider, /private async _rootUpScope\([\s\S]*?\n {4}\}/);
        const panel = scope.indexOf('this._branch) {candidates.push');
        const head = scope.indexOf('getCurrentBranch()');
        const scan = scope.indexOf('getBranchesContaining(');
        assert.ok(panel >= 0 && head > panel && scan > head, 'the three probes must stay in that order');
    });

    it('is claimed before the first await of the reveal', () => {
        const reveal = body(provider, /revealCommit\(hash: string, file\?: string, opts\?: RevealOptions\)[\s\S]*?\n {4}\}/);
        const focus = reveal.indexOf("executeCommand('idea-git.mainView.focus')");
        const root = reveal.indexOf('_setRoot(hash)');
        assert.ok(root > focus, 'a load that focusing starts must not run against the branch tip');
    });

    it('moves the panel scope to the ref that contains the commit', () => {
        const adopt = body(provider, /private async _adoptRevealScope\(\): Promise<void> \{[\s\S]*?\n {4}\}/);
        assert.ok(/if \(!up \|\| up === this\._branch \|\| !this\._branchExists\(up\)\)/.test(adopt),
            'an unresolved or nonexistent scope must leave the panel where it was');
        assert.ok(/_revRoot = \{ \.\.\.root, branch: up \}/.test(adopt),
            'the rooted window has to remember the new scope, or the next refresh drops the rows above');
        const reveal = body(provider, /private async _revealFrom\([\s\S]*?\n {4}\}/);
        assert.ok(reveal.indexOf('await this._adoptRevealScope()') < reveal.indexOf('this._collect('),
            'the scope must be adopted before the page is collected: rows, tree highlight and the tip baseline all read it');
        assert.ok(!/_lastKnownBranch/.test(adopt), 'the HEAD poll baseline is not the panel scope');
    });

    it('never lets a filter hide the commit the user jumped to', () => {
        const pageFilters = body(provider, /private _pageFilters\(\)[\s\S]*?\n {4}\}/);
        assert.ok(/_isRootedList\(\) \? \{\} : this\._filters/.test(pageFilters),
            'a search term that matches nothing else would otherwise drop the revealed row and the scroll target with it');
        assert.ok((provider.match(/filters: this\._pageFilters\(\)/g) || []).length >= 2,
            'both the first page and the paged window must go through it');
        assert.ok(/_hasActiveFilters\(\)/.test(body(provider, /private async _collect\([\s\S]*?\n {4}\}/)),
            'the list says out loud that the filters are paused');
    });

    it('leaves the rooted view through the banner', () => {
        assert.ok(/postMessage\(\{ command: 'leaveReveal' \}\)/.test(script), 'the banner button has somewhere to send');
        const leave = body(provider, /case 'leaveReveal':[\s\S]*?break;/);
        assert.ok(/_reload\(false, true\)/.test(leave), 'a full reload is what clears the root and repaints the branch tip');
        assert.ok(/id="rev-bar"/.test(provider), 'the banner is part of the panel frame, not injected per reveal');
        assert.ok(/#rev-bar \{[^}]*display: none/.test(sheet), 'and hidden until a rooted list shows it');
        assert.ok(/function renderRootedBar\(\)/.test(script), 'and the webview draws it on every list repaint');
        assert.ok(/state\.rooted = m\.rooted \|\| null;/.test(script),
            'setData is the only writer of the banner, so a reload cannot leave it stale');
    });

    it('switches repository first when the blame came from another one', () => {
        const reveal = body(provider, /revealCommit\(hash: string, file\?: string, opts\?: RevealOptions\)[\s\S]*?\n {4}\}/);
        assert.ok(reveal.indexOf('this._switchAndReveal(') < reveal.indexOf('this._setRoot(hash)'),
            'rooting before switching would search the hash in the wrong repository');
        const guard = body(provider, /private _revealRepository\([\s\S]*?\n {4}\}/);
        assert.ok(/listRepositories\(\)/.test(guard),
            'a public command must not be able to move the panel to any .git on disk');
    });

    it('lands the preview on the blamed lines', () => {
        const lines = body(provider, /function revealLines\([\s\S]*?\n\}/);
        assert.ok(/Math\.floor\(first\) < 1/.test(lines), 'a number outside the file is no anchor at all');
        assert.ok(!/first \+ 1/.test(lines), 'the numbers arrive in the commit\u0027s own 1-based space, not the editor\u0027s');
        assert.ok(/\.dl\.hit \{/.test(sheet), 'and the row it matches has to be visibly lit');
    });
});

describe('commit row keeps its refs visible', () => {
    it('gives the subject the space and caps the badge cell', () => {
        const msg = body(sheet, /\.msg \{[^}]*\}/);
        assert.ok(/flex: 1 1 0/.test(msg) && /min-width: 0/.test(msg), 'the subject fills what the badges leave and ellipsizes there');
        const refs = body(sheet, /\.refs \{[^}]*\}/);
        const cap = refs.match(/max-width: (\d+)%/);
        assert.ok(cap, 'an uncapped badge cell is what used to be clipped out of the row entirely');
        assert.ok(Number(cap![1]) < 50, 'badges must not take the majority of the row');
        assert.ok(!/flex: none/.test(refs), 'a badge cell wider than the row would be clipped, so it cannot be rigid');
    });

    it('never hides the badges with the graph column', () => {
        assert.ok(!/#rows\.no-refs \.refs \{ display: none/.test(sheet), 'the refs have to stay shown, they just do not get the leading role');
        assert.ok(!/'no-refs'/.test(script), 'the class is not set any more');
    });

    it('ellipsizes the ref name, not the badge', () => {
        const chip = body(script, /function refChipHtml\([\s\S]*?\n\}/);
        assert.ok(/chip-name/.test(chip), 'the name needs its own span so the +N counter survives a long branch name');
        const name = body(sheet, /\.chip-name \{[^}]*\}/);
        assert.ok(/text-overflow: ellipsis/.test(name) && /min-width: 0/.test(name));
        const more = body(sheet, /\.chip-more \{[^}]*\}/);
        assert.ok(/flex: none/.test(more), 'the counter is part of the always-visible minimum');
    });
});
