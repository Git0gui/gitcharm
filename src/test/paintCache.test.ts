import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { paintSignature, samePaint, PaintScope, PaintSnapshot } from '../services/paintCache';

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');
const paintSource = fs.readFileSync(path.join(ROOT, 'src', 'services', 'paintCache.ts'), 'utf8');

function body(signature: string): string {
    const match = source.match(new RegExp(`${signature}[\\s\\S]*?\\n {4}\\}(?:\\r?\\n)`));
    assert.ok(match, `${signature} must exist in graphView.ts`);
    return match[0];
}

function scope(over: Partial<PaintScope> = {}): PaintScope {
    return {
        epoch: 0, repoPath: '/repo', branch: 'main', tip: 'a'.repeat(40), rootRev: '',
        filters: {}, ...over
    };
}

function snap(over: Partial<PaintSnapshot> = {}): PaintSnapshot {
    return {
        commits: [{ hash: 'h1' }, { hash: 'h2' }],
        local: ['main', 'feature'],
        remote: ['origin/main'],
        currentBranch: 'main',
        selectedBranch: 'main',
        repoName: 'demo',
        hasMore: true,
        hasMoreAbove: false,
        headHash: 'a'.repeat(40),
        favorites: [],
        recent: [],
        ...over
    };
}

describe('paintSignature — every scope dimension changes the identity', () => {
    it('is stable for identical input', () => {
        assert.equal(paintSignature(scope()), paintSignature(scope()));
    });

    it('separates repository, branch, tip and reveal root', () => {
        const base = paintSignature(scope());
        for (const changed of [
            scope({ repoPath: '/other' }),
            scope({ branch: 'feature' }),
            scope({ tip: 'b'.repeat(40) }),
            scope({ rootRev: 'c'.repeat(40) })
        ]) {
            assert.notEqual(paintSignature(changed), base);
        }
    });

    it('separates a cache invalidation from the same screen', () => {
        const base = paintSignature(scope());
        assert.notEqual(paintSignature(scope({ epoch: 1 })), base);
    });

    it('separates every filter dimension', () => {
        const base = paintSignature(scope());
        const changed = [
            { text: 'fix' }, { regex: true }, { caseSensitive: true },
            { author: 'me' }, { from: '2026-01-01' }, { to: '2026-02-01' },
            { path: 'src/a.ts' }
        ];
        for (const filters of changed) {
            assert.notEqual(paintSignature(scope({ filters })), base);
        }
    });

    it('does not collide when neighbouring fields hold similar text', () => {
        assert.notEqual(
            paintSignature(scope({ branch: 'a', tip: 'b' })),
            paintSignature(scope({ branch: 'b', tip: 'a' }))
        );
    });
});

describe('samePaint — only a byte-identical screen is reused', () => {
    it('accepts an identical payload', () => {
        assert.equal(samePaint(snap(), snap()), true);
    });

    it('rejects a different commit list', () => {
        assert.equal(samePaint(snap(), snap({ commits: [{ hash: 'h1' }] })), false, 'length');
        assert.equal(samePaint(snap(), snap({ commits: [{ hash: 'h2' }, { hash: 'h1' }] })), false, 'order');
        assert.equal(samePaint(snap(), snap({ commits: [{ hash: 'h1' }, { hash: 'h3' }] })), false, 'hash');
    });

    it('rejects a changed scalar field', () => {
        const a = snap();
        const changed = [
            { currentBranch: 'feature' }, { selectedBranch: 'feature' },
            { repoName: 'other' }, { hasMore: false }, { hasMoreAbove: true },
            { headHash: 'b'.repeat(40) }, { inProgress: 'rebase' }
        ];
        for (const over of changed) {
            assert.equal(samePaint(a, snap(over)), false, JSON.stringify(over));
        }
    });

    it('rejects changed branch lists and marks', () => {
        assert.equal(samePaint(snap(), snap({ local: ['main'] })), false);
        assert.equal(samePaint(snap(), snap({ remote: ['origin/main', 'origin/dev'] })), false);
        assert.equal(samePaint(snap(), snap({ favorites: ['main'] })), false);
        assert.equal(samePaint(snap(), snap({ recent: ['dev'] })), false);
    });

    it('rejects a changed reveal banner', () => {
        assert.equal(samePaint(snap(), snap({ rooted: { hash: 'h1', filtersPaused: false } })), false);
        const rooted = snap({ rooted: { hash: 'h1', filtersPaused: false } });
        assert.equal(samePaint(rooted, snap({ rooted: { hash: 'h1', filtersPaused: true } })), false);
    });

    it('treats a missing optional array as empty', () => {
        assert.equal(samePaint(snap({ favorites: undefined, recent: undefined }), snap()), true);
    });

    it('never reuses a screen when the previous payload is missing', () => {
        assert.equal(samePaint(undefined, snap()), false);
        assert.equal(samePaint(snap(), undefined), false);
    });
});

describe('reload short circuit wiring', () => {
    const shown = body('private async _onPanelShown\\(\\): Promise<void> \\{');
    const reload = body('private async _reload\\(force: boolean = false, preserveSelection = false, forceDivergence = false\\) \\{');
    const switched = body('async switchRepository\\(rootPath: string\\): Promise<void> \\{');
    const select = source.slice(
        source.indexOf("case 'selectBranch': {"),
        source.indexOf("case 'refresh':")
    );

    it('replays the cached payload instead of reloading on an unchanged re-show', () => {
        assert.match(shown, /this\._lastPaint && tip === this\._lastKnownTip/);
        assert.match(shown, /this\._lastPaint\.signature === this\._paintSignature\(tip\)/);
        assert.match(shown, /command: 'setData'/);
        assert.match(shown, /preserveSelection: true/);
        assert.match(shown, /void this\._refreshDivergence\(false\)/);
    });

    it('keeps the startup in-flight guard ahead of the fallback reload', () => {
        const guard = shown.indexOf('if (this._initialCommitLoadInProgress)');
        const fallback = shown.indexOf('void this._reload(');
        assert.ok(guard >= 0 && fallback > guard);
        assert.match(shown.slice(guard, fallback), /this\._startBranchCheck\(\);\s*return;/);
    });

    it('skips a full reload when the same branch is double-clicked', () => {
        assert.match(select, /const tip = await this\._tipOfDisplayedRev\(\)/);
        assert.match(select, /this\._lastPaint\.signature === this\._paintSignature\(tip\)/);
        assert.match(select, /void this\._refreshDivergence\(true\)/);
        const short = select.indexOf('void this._refreshDivergence(true)');
        // The vanished-branch path has its own cancellable reload earlier in
        // the case; the last one is the full reload the short circuit skips.
        const full = select.lastIndexOf('_withCancellableGitQuery');
        assert.ok(short >= 0 && full > short, 'short circuit must precede the full reload');
    });

    it('uses a rows-only repaint when the reload answer is identical', () => {
        assert.match(reload, /samePaint\(this\._lastPaint\.payload, payload\)/);
        assert.match(reload, /command: 'setCommits'/);
        assert.match(reload, /command: 'setData'/);
        assert.match(reload, /this\._lastPaint = \{ payload, signature \}/);
    });

    it('drops the cached paint when the repository changes', () => {
        assert.match(switched, /this\._lastPaint = undefined/);
    });

    it('folds the volatile epoch into the painted identity', () => {
        assert.match(source, /epoch: this\._gitService\.volatileEpoch/);
    });

    it('bumps the epoch whenever volatile caches are dropped', () => {
        const service = fs.readFileSync(path.join(ROOT, 'src', 'services', 'gitService.ts'), 'utf8');
        const start = service.indexOf('invalidateVolatile(): void {');
        assert.ok(start >= 0);
        assert.match(service.slice(start, start + 240), /this\._volatileEpoch\+\+/);
    });

    it('keeps the comparison helpers free of vscode', () => {
        assert.doesNotMatch(paintSource, /from ['"]vscode['"]|require\(['"]vscode['"]\)/);
    });
});
