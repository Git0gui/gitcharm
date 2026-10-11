import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseBranchCache, serializeBranchCache, BRANCH_CACHE_VERSION } from '../services/branchCacheStore';
import { parseTrackInfo, parseSymbolicRef, parseRefPath, parseWorkingTreeSummary, parseStatusEntries, operationFromStateFiles, isOperationStateFile } from '../services/gitUtils';

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

describe('parseRefPath', () => {
    it('accepts both HEAD and head-name spellings', () => {
        assert.equal(parseRefPath('ref: refs/heads/main'), 'main');
        assert.equal(parseRefPath('refs/heads/feature_x\n'), 'feature_x');
    });

    it('keeps nested branch paths', () => {
        assert.equal(parseRefPath('refs/heads/v0.0.5/no-vscode-git'), 'v0.0.5/no-vscode-git');
    });

    it('returns undefined for SHAs and non-branch refs', () => {
        assert.equal(parseRefPath('8e9cf03f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'), undefined);
        assert.equal(parseRefPath('refs/tags/v1.0.0'), undefined);
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

describe('parseWorkingTreeSummary', () => {
    it('returns zero files for a clean working tree', () => {
        assert.deepEqual(parseWorkingTreeSummary(''), { files: 0, untracked: 0 });
    });

    it('counts untracked entries', () => {
        const raw = '?? a.txt\0?? dir/b.txt\0';
        assert.deepEqual(parseWorkingTreeSummary(raw), { files: 2, untracked: 2 });
    });

    it('counts staged and unstaged changes as files', () => {
        const raw = 'M  a.txt\0 D b.txt\0?? c.txt\0';
        assert.deepEqual(parseWorkingTreeSummary(raw), { files: 3, untracked: 1 });
    });

    it('does not double-count the rename source field', () => {
        const raw = 'R  renamed_a.txt\0a.txt\0?? new.txt\0';
        assert.deepEqual(parseWorkingTreeSummary(raw), { files: 2, untracked: 1 });
    });
});

describe('parseStatusEntries', () => {
    it('returns no entries for a clean working tree', () => {
        assert.deepEqual(parseStatusEntries(''), []);
        assert.deepEqual(parseStatusEntries('\0'), []);
    });

    it('splits index and worktree status letters', () => {
        const [staged, modified] = parseStatusEntries('M  a.txt\0 M b.txt\0');
        assert.equal(staged.path, 'a.txt');
        assert.equal(staged.indexStatus, 'M');
        assert.equal(staged.worktreeStatus, ' ');
        assert.equal(modified.path, 'b.txt');
        assert.equal(modified.indexStatus, ' ');
        assert.equal(modified.worktreeStatus, 'M');
    });

    it('keeps both stages for an MM entry', () => {
        const [entry] = parseStatusEntries('MM c.txt\0');
        assert.equal(entry.indexStatus, 'M');
        assert.equal(entry.worktreeStatus, 'M');
        assert.equal(entry.conflicted, false);
    });

    it('marks untracked entries', () => {
        const [entry] = parseStatusEntries('?? new/dir.txt\0');
        assert.equal(entry.untracked, true);
        assert.equal(entry.conflicted, false);
    });

    it('consumes the rename source field as fromPath', () => {
        const entries = parseStatusEntries('R  b.txt\0a.txt\0?? c.txt\0');
        assert.equal(entries.length, 2);
        assert.equal(entries[0].path, 'b.txt');
        assert.equal(entries[0].fromPath, 'a.txt');
        assert.equal(entries[1].path, 'c.txt');
    });

    it('flags every unmerged status code as conflicted', () => {
        const entries = parseStatusEntries('AA a\0DD b\0AU c\0UA d\0DU e\0UD f\0');
        assert.equal(entries.length, 6);
        for (const entry of entries) {
            assert.equal(entry.conflicted, true);
        }
    });

    it('flags ignored entries', () => {
        const [entry] = parseStatusEntries('!! build/out.js\0');
        assert.equal(entry.ignored, true);
    });

    it('keeps quoted-looking and unicode paths verbatim (no shell involved)', () => {
        const [entry] = parseStatusEntries(' M 中文 "quoted".txt\0');
        assert.equal(entry.path, '中文 "quoted".txt');
    });
});

describe('operationFromStateFiles', () => {
    const present = (...names: string[]) => (name: string) => names.includes(name);

    it('reports undefined when no state file exists', () => {
        assert.equal(operationFromStateFiles(present()), undefined);
    });

    it('maps each state file to its operation', () => {
        assert.equal(operationFromStateFiles(present('MERGE_HEAD')), 'merge');
        assert.equal(operationFromStateFiles(present('CHERRY_PICK_HEAD')), 'cherry-pick');
        assert.equal(operationFromStateFiles(present('rebase-merge')), 'rebase');
        assert.equal(operationFromStateFiles(present('rebase-apply')), 'rebase');
    });

    it('lets rebase win — a rebase drives cherry-pick internally and leaves its own head file', () => {
        assert.equal(
            operationFromStateFiles(present('CHERRY_PICK_HEAD', 'MERGE_HEAD', 'rebase-merge')),
            'rebase'
        );
    });

    it('lets cherry-pick win over merge', () => {
        assert.equal(operationFromStateFiles(present('CHERRY_PICK_HEAD', 'MERGE_HEAD')), 'cherry-pick');
    });
});

describe('isOperationStateFile', () => {
    it('accepts exactly the four files git removes when an operation settles', () => {
        for (const name of ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'MERGE_HEAD']) {
            assert.equal(isOperationStateFile(name), true, name);
        }
    });

    it('rejects ordinary git directory entries', () => {
        for (const name of ['HEAD', 'index', 'packed-refs', 'ORIG_HEAD', 'COMMIT_EDITMSG']) {
            assert.equal(isOperationStateFile(name), false, name);
        }
    });
});
