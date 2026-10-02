import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseBranchCache, serializeBranchCache, BRANCH_CACHE_VERSION } from '../services/branchCacheStore';
import { parseTrackInfo, parseSymbolicRef } from '../services/gitUtils';

describe('parseTrackInfo', () => {
    it('parses ahead and behind counts', () => {
        assert.deepEqual(parseTrackInfo('[ahead 2, behind 1]'), { ahead: 2, behind: 1 });
    });

    it('parses ahead-only', () => {
        assert.deepEqual(parseTrackInfo('[ahead 3]'), { ahead: 3, behind: 0 });
    });

    it('parses behind-only', () => {
        assert.deepEqual(parseTrackInfo('[behind 5]'), { ahead: 0, behind: 5 });
    });

    it('returns zeros for empty or missing track info', () => {
        assert.deepEqual(parseTrackInfo(''), { ahead: 0, behind: 0 });
        assert.deepEqual(parseTrackInfo(undefined), { ahead: 0, behind: 0 });
    });

    it('returns zeros for gone upstream', () => {
        assert.deepEqual(parseTrackInfo('[gone]'), { ahead: 0, behind: 0 });
    });
});

describe('parseSymbolicRef', () => {
    it('parses a branch ref', () => {
        assert.equal(parseSymbolicRef('ref: refs/heads/main'), 'main');
    });

    it('parses nested branch names and trailing newline', () => {
        assert.equal(parseSymbolicRef('ref: refs/heads/feature/my-branch\n'), 'feature/my-branch');
    });

    it('returns undefined for detached HEAD', () => {
        assert.equal(parseSymbolicRef('8e9cf03f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'), undefined);
    });

    it('returns undefined for non-branch refs', () => {
        assert.equal(parseSymbolicRef('ref: refs/remotes/origin/main'), undefined);
    });
});

describe('branchCacheStore', () => {
    const sample = {
        local: [{ name: 'main', upstream: 'origin/main', ahead: 1, behind: 2 }],
        remote: [{ name: 'origin/main' }]
    };

    it('round-trips through serialize/parse', () => {
        const text = serializeBranchCache('/repo', sample);
        const parsed = parseBranchCache(text);
        assert.ok(parsed);
        assert.equal(parsed.version, BRANCH_CACHE_VERSION);
        assert.equal(parsed.repoPath, '/repo');
        assert.deepEqual(parsed.branches, sample);
        assert.equal(typeof parsed.timestamp, 'number');
    });

    it('rejects cache without a version field (legacy format)', () => {
        const legacy = JSON.stringify({ timestamp: Date.now(), repoPath: '/repo', branches: sample });
        assert.equal(parseBranchCache(legacy), undefined);
    });

    it('rejects cache with a stale version', () => {
        const stale = JSON.stringify({ version: BRANCH_CACHE_VERSION + 1, timestamp: 1, repoPath: '/repo', branches: sample });
        assert.equal(parseBranchCache(stale), undefined);
    });

    it('rejects malformed JSON', () => {
        assert.equal(parseBranchCache('{not json'), undefined);
        assert.equal(parseBranchCache(''), undefined);
    });

    it('rejects quoted branch names (poisoned by the old spawn quoting bug)', () => {
        const poisoned = JSON.stringify({
            version: BRANCH_CACHE_VERSION,
            timestamp: 1,
            repoPath: '/repo',
            branches: { local: [{ name: '"main', ahead: 0, behind: 0 }], remote: [] }
        });
        assert.equal(parseBranchCache(poisoned), undefined);
    });

    it('rejects entries with wrong field types', () => {
        const bad = JSON.stringify({
            version: BRANCH_CACHE_VERSION,
            timestamp: 1,
            repoPath: '/repo',
            branches: { local: [{ name: 'main', ahead: 'many', behind: 0 }], remote: [] }
        });
        assert.equal(parseBranchCache(bad), undefined);
    });

    it('rejects missing branches arrays', () => {
        const bad = JSON.stringify({ version: BRANCH_CACHE_VERSION, timestamp: 1, repoPath: '/repo', branches: {} });
        assert.equal(parseBranchCache(bad), undefined);
    });
});
