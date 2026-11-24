import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyWorktreeLiveness, parseWorktreeList } from '../services/gitUtils';
import { hasLinkedWorktrees, linkedWorktreeStamp } from '../services/gitPaths';

/**
 * A temporary `.git`-shaped layout: commonDir/worktrees/<name>/{HEAD,gitdir}.
 * The gitdir file points at <target>/.git exactly like a real registration.
 */
function makeRepoLayout(): { commonDir: string; worktreesDir: string } {
    const commonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-wt-'));
    return { commonDir, worktreesDir: path.join(commonDir, 'worktrees') };
}

function addRegistration(worktreesDir: string, name: string, target: string): void {
    const dir = path.join(worktreesDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/feat\n');
    fs.writeFileSync(path.join(dir, 'gitdir'), path.join(target, '.git') + '\n');
}

function addLiveTarget(): string {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-wt-target-'));
    fs.writeFileSync(path.join(target, '.git'), 'gitdir: somewhere\n');
    return target;
}

describe('applyWorktreeLiveness', () => {
    const raw = [
        'worktree D:/repo', 'HEAD aaa', 'branch refs/heads/main', '',
        'worktree D:/repo-feat', 'HEAD bbb', 'branch refs/heads/feat',
        'prunable gitdir file points to non-existent location', '',
        'worktree D:/repo-locked', 'HEAD ccc', 'branch refs/heads/locked', 'locked reason', ''
    ].join('\n');

    it('marks prunable and on-disk-missing entries, keeps live ones', () => {
        const entries = parseWorktreeList(raw);
        assert.equal(entries.length, 3);
        const marked = applyWorktreeLiveness(entries, target => target === 'D:/repo');
        assert.equal(marked[0].missing, false);
        assert.equal(marked[1].missing, true, 'prunable is missing even without a disk check');
        assert.equal(marked[2].missing, true, 'a locked registration whose folder is gone is missing too');
    });

    it('never marks a present folder missing, prunable or not', () => {
        const entries = parseWorktreeList(raw);
        const marked = applyWorktreeLiveness(entries, () => true);
        assert.deepEqual(marked.map(entry => entry.missing), [false, true, false]);
    });
});

describe('linkedWorktreeStamp', () => {
    it('is empty without a worktrees directory', () => {
        const { worktreesDir } = makeRepoLayout();
        assert.equal(linkedWorktreeStamp(worktreesDir), '');
    });

    it('changes when the target folder is deleted by hand, no git file touched', () => {
        const { worktreesDir } = makeRepoLayout();
        const target = addLiveTarget();
        addRegistration(worktreesDir, 'repo-feat', target);
        const before = linkedWorktreeStamp(worktreesDir);
        assert.match(before, /:1$/);

        // Deleting the folder in Explorer touches no file inside .git, so only
        // the liveness flag can move — this is the regression being pinned.
        fs.rmSync(target, { recursive: true, force: true });
        const after = linkedWorktreeStamp(worktreesDir);
        assert.match(after, /:0$/);
        assert.notEqual(after, before);
    });

    it('does not change when nothing moved', () => {
        const { worktreesDir } = makeRepoLayout();
        const target = addLiveTarget();
        addRegistration(worktreesDir, 'repo-feat', target);
        assert.equal(linkedWorktreeStamp(worktreesDir), linkedWorktreeStamp(worktreesDir));
    });
});

describe('hasLinkedWorktrees', () => {
    it('is false without registrations and true with one', () => {
        const { commonDir, worktreesDir } = makeRepoLayout();
        assert.equal(hasLinkedWorktrees(commonDir), false, 'no worktrees dir');
        fs.mkdirSync(worktreesDir, { recursive: true });
        assert.equal(hasLinkedWorktrees(commonDir), false, 'empty worktrees dir');
        addRegistration(worktreesDir, 'repo-feat', addLiveTarget());
        assert.equal(hasLinkedWorktrees(commonDir), true);
    });
});
