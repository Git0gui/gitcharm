import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveCommonDir, resolveGitDir } from '../services/gitPaths';
import { RefsReader } from '../services/refsReader';

const HASH_MAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_FEATURE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

interface Layout {
    repo: string;
    common: string;
    worktreeGitDir: string;
}

/**
 * Build `common/` (shared refs) plus a linked worktree whose `.git` is a pointer
 * file — the layout that used to make direct ref reads come up empty.
 */
function createWorktreeLayout(root: string, pointerStyle: 'absolute' | 'relative'): Layout {
    const common = path.join(root, 'common');
    writeFile(path.join(common, 'refs', 'heads', 'main'), `${HASH_MAIN}\n`);
    writeFile(path.join(common, 'refs', 'heads', 'feature'), `${HASH_FEATURE}\n`);

    const worktreeGitDir = path.join(common, 'worktrees', 'wt1');
    writeFile(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    // Real git writes the path back to the shared dir, relative to the worktree git dir
    writeFile(path.join(worktreeGitDir, 'commondir'), '../..\n');

    const repo = path.join(root, 'wt1');
    fs.mkdirSync(repo, { recursive: true });
    const pointer = pointerStyle === 'absolute'
        ? worktreeGitDir
        : path.relative(repo, worktreeGitDir);
    fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${pointer}\n`, 'utf8');
    return { repo, common, worktreeGitDir };
}

describe('resolveGitDir', () => {
    let tmp: string;

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-paths-'));
    });
    after(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('returns the .git directory of a plain clone', () => {
        const repo = path.join(tmp, 'plain');
        writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        assert.equal(resolveGitDir(repo), path.join(repo, '.git'));
    });

    it('follows an absolute gitdir pointer', () => {
        const { repo, worktreeGitDir } = createWorktreeLayout(path.join(tmp, 'abs-pointer'), 'absolute');
        assert.equal(resolveGitDir(repo), worktreeGitDir);
    });

    it('resolves a relative gitdir pointer against the repository root', () => {
        const { repo, worktreeGitDir } = createWorktreeLayout(path.join(tmp, 'rel-pointer'), 'relative');
        assert.equal(resolveGitDir(repo), worktreeGitDir);
    });

    it('returns undefined outside a repository', () => {
        const bare = path.join(tmp, 'not-a-repo');
        fs.mkdirSync(bare, { recursive: true });
        assert.equal(resolveGitDir(bare), undefined);
    });

    it('returns undefined when the gitdir pointer no longer resolves', () => {
        const repo = path.join(tmp, 'stale-pointer', 'wt1');
        fs.mkdirSync(repo, { recursive: true });
        fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /nope/does-not-exist\n', 'utf8');
        assert.equal(resolveGitDir(repo), undefined);
    });
});

describe('resolveCommonDir', () => {
    let tmp: string;

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-common-'));
    });
    after(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('defaults to the git dir when there is no commondir file', () => {
        const gitDir = path.join(tmp, 'gitdir');
        writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
        assert.equal(resolveCommonDir(gitDir), gitDir);
    });

    it('follows a relative commondir pointer', () => {
        const { repo, common } = createWorktreeLayout(path.join(tmp, 'worktree'), 'absolute');
        assert.equal(resolveCommonDir(resolveGitDir(repo)!), common);
    });
});

describe('RefsReader across a linked worktree', () => {
    let tmp: string;

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-refs-'));
    });
    after(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('reads shared refs through the worktree pointer instead of coming up empty', () => {
        const { repo } = createWorktreeLayout(path.join(tmp, 'refs'), 'relative');
        const reader = new RefsReader(() => repo);
        assert.deepEqual(reader.readBranchNames().local, ['feature', 'main']);
        assert.equal(reader.readBranchRefs().get('main'), HASH_MAIN);
    });
});
