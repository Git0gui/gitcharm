import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { RefreshScheduler, filterSignature, sameFilters } from '../services/refreshScheduler';

describe('refresh scheduler collapses duplicate work', () => {
    it('folds a concurrent call with the same key into the running one', () => {
        const scheduler = new RefreshScheduler<string>(0);
        const first = scheduler.begin('branch-a', 'first');
        assert.ok(first, 'the first caller owns the channel');

        const second = scheduler.begin('branch-a', 'second');
        assert.equal(second, undefined, 'an identical concurrent request must not spawn again');
        assert.equal(scheduler.generation, 1, 'sharing a run does not supersede it');
        assert.equal(scheduler.isLatest(first!.generation), true);

        assert.equal(scheduler.end(), undefined, 'nothing was queued');
    });

    it('queues one follow-up for a different scope and drops the stale result', () => {
        const scheduler = new RefreshScheduler<string>(0);
        const first = scheduler.begin('branch-a', 'first');
        assert.ok(first);

        const second = scheduler.begin('branch-b', 'second');
        assert.equal(second, undefined, 'the superseded call is folded in, not started in parallel');
        assert.equal(scheduler.isLatest(first!.generation), false, 'the in-flight answer is stale now');

        // A third call with the newest scope replaces the queued one; only one
        // follow-up survives, so a burst of watcher events costs one reload.
        const third = scheduler.begin('branch-b', 'third');
        assert.equal(third, undefined);

        const followUp = scheduler.end();
        assert.equal(followUp, 'third', 'only the newest queued request is replayed');
        assert.equal(scheduler.end(), undefined, 'the queue is drained');
    });

    it('reuses a freshly painted screen for the same key', () => {
        const scheduler = new RefreshScheduler<number>(500);
        assert.ok(scheduler.begin('same', 1));
        scheduler.end();
        assert.equal(scheduler.begin('same', 2), undefined, 'a watcher event right after our own reload is answered by that paint');
        assert.ok(scheduler.begin('other', 3), 'a different scope still runs');
        scheduler.end();
    });

    it('never lets the reuse window swallow a queued follow-up', () => {
        const scheduler = new RefreshScheduler<string>(500);
        const first = scheduler.begin('a', 'first');
        assert.ok(first);
        assert.equal(scheduler.begin('b', 'queued'), undefined);
        assert.equal(scheduler.end(), 'queued');

        // The follow-up arrives with the *new* key, but a naive reuse check
        // would compare against the run that just finished and drop it.
        const follow = scheduler.begin('b', 'follow');
        assert.ok(follow, 'a queued scope change must always get its own run');
        scheduler.end();
    });

    it('a stale generation cannot paint after a newer call arrived', () => {
        const scheduler = new RefreshScheduler<number>(0);
        const first = scheduler.begin('a', 1);
        assert.ok(first);
        scheduler.begin('b', 2);
        assert.equal(scheduler.isLatest(first!.generation), false);
        assert.equal(scheduler.isLatest(999), false);
    });
});

describe('filter comparison is field-wise and separator-safe', () => {
    it('treats identical filters as the same request', () => {
        assert.equal(sameFilters({ text: 'fix', regex: true }, { text: 'fix', regex: true }), true);
        assert.equal(sameFilters(undefined, {}), true);
    });

    it('recognises every field that changes the git log answer', () => {
        assert.equal(sameFilters({ text: 'fix' }, { text: 'fix', caseSensitive: true }), false);
        assert.equal(sameFilters({ author: 'a' }, { author: 'b' }), false);
        assert.equal(sameFilters({ from: '2026-01-01' }, { from: '2026-01-01', to: '2026-02-01' }), false);
        assert.equal(sameFilters({ path: 'src' }, { path: 'src', regex: true }), false);
    });

    it('does not confuse values that contain the separator', () => {
        const a = { text: 'x\u001fy', author: '' };
        const b = { text: 'x', author: 'y' };
        assert.equal(filterSignature(a) === filterSignature(b), false);
    });
});
