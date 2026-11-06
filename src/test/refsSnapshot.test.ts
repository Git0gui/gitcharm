import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runGit } from '../services/gitRunner';
import { REFS_SNAPSHOT_ARGS, REFS_SNAPSHOT_SEP, parseRefsSnapshot } from '../services/refsSnapshot';

/**
 * The one refs query that replaced two `for-each-ref` spawns.
 *
 * What used to go wrong and is pinned here: the two old formats split on `|`,
 * which is a legal character in a git ref name, so a branch called `feat/a|b`
 * parsed into the wrong upstream. The snapshot format therefore separates with
 * U+001F — illegal in every ref name, so no field can contain it.
 */

const GIT_PRESENT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

/** One output line, built from the format's fields in order. */
function refLine(refname: string, object = A, peeled = '', upstream = '', track = ''): string {
    return [refname, object, peeled, upstream, track].join(REFS_SNAPSHOT_SEP);
}

describe('parseRefsSnapshot', () => {

    it('reads upstream and divergence from the branch lines', () => {
        const snap = parseRefsSnapshot([
            refLine('refs/heads/main', A, '', 'origin/main', '[ahead 2, behind 1]'),
            refLine('refs/heads/loose', B)
        ].join('\n'));
        assert.deepEqual(snap.branches.get('main'), { upstream: 'origin/main', ahead: 2, behind: 1 });
        assert.deepEqual(snap.branches.get('loose'), { upstream: undefined, ahead: 0, behind: 0 });
    });

    it('peels annotated tags and keeps lightweight tags on their commit', () => {
        const snap = parseRefsSnapshot([
            refLine('refs/tags/v1.0.0', A, B),
            refLine('refs/tags/v1.0.0-rc.1', C)
        ].join('\n'));
        assert.equal(snap.tags.get('v1.0.0'), B);
        assert.equal(snap.tags.get('v1.0.0-rc.1'), C);
    });

    it('keeps a ref name containing a pipe intact', () => {
        const snap = parseRefsSnapshot(
            refLine('refs/heads/feat/a|b', A, '', 'origin/feat/a|b', '[ahead 1]')
        );
        assert.deepEqual([...snap.branches], [['feat/a|b', { upstream: 'origin/feat/a|b', ahead: 1, behind: 0 }]]);
    });

    it('ignores refs outside heads and tags', () => {
        // `refs/stash` and whatever another tool wrote under refs/ are neither a
        // row of the branch tree nor a badge on a commit; `--all` used to drag
        // them into the log, and the snapshot must not reintroduce them.
        const snap = parseRefsSnapshot([
            refLine('refs/heads/main'),
            refLine('refs/remotes/origin/main'),
            refLine('refs/stash'),
            refLine('refs/agents/session/checkpoints/turn-1')
        ].join('\n'));
        assert.deepEqual([...snap.branches.keys()], ['main']);
        assert.deepEqual([...snap.tags.keys()], []);
    });

    it('skips empty lines, malformed hashes and escaped ref names', () => {
        const snap = parseRefsSnapshot([
            '',
            refLine('refs/tags/broken', 'not-a-hash', ''),
            refLine('refs/heads/'),
            refLine('"refs/heads/\\345\\210\\206\\346\\224\\257"', A),
            'junk-without-separator'
        ].join('\n'));
        assert.equal(snap.branches.size, 0);
        assert.equal(snap.tags.size, 0);
    });

    it('asks for both namespaces in a single argument-free format', () => {
        assert.deepEqual(REFS_SNAPSHOT_ARGS.slice(0, 3), ['for-each-ref', 'refs/heads', 'refs/tags']);
        const format = REFS_SNAPSHOT_ARGS[3];
        assert.ok(format.startsWith('--format='));
        assert.equal(format.split(REFS_SNAPSHOT_SEP).length, 5);
    });
});

/** git makes pack/object files read-only; Windows rm then refuses the whole tree. */
function removeRepo(dir: string): void {
    const unlock = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                unlock(full);
            } else {
                try { fs.chmodSync(full, 0o666); } catch { /* best effort */ }
            }
        }
        try { fs.chmodSync(current, 0o777); } catch { /* best effort */ }
    };
    try {
        unlock(dir);
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    } catch { /* the temp directory is not the assertion */ }
}

describe('refs snapshot against real git', { skip: GIT_PRESENT ? false : 'git is not available' }, () => {

    it('answers upstream, divergence and the tag peel from one spawn', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-refs-'));
        const repo = path.join(dir, 'work');
        const run = (args: string[]) => runGit([
            '-c', 'user.name=GitCharm Test',
            '-c', 'user.email=test@example.invalid',
            '-c', 'commit.gpgsign=false',
            '-c', 'core.autocrlf=false',
            '-c', 'init.defaultBranch=main',
            ...args
        ], { cwd: repo, timeoutMs: 60_000 });
        try {
            fs.mkdirSync(repo, { recursive: true });
            await run(['init', '-q', '.']);
            await run(['init', '-q', '--bare', path.join(dir, 'remote.git')]);
            await run(['remote', 'add', 'origin', path.join(dir, 'remote.git')]);

            fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n', 'utf8');
            await run(['add', '-A']);
            await run(['commit', '-qm', 'C-a']);
            const commit = (await run(['rev-parse', 'HEAD'])).trim();
            await run(['push', '-q', '-u', 'origin', 'main']);

            // A second branch with its own upstream, so the parse has to tell two
            // local refs apart. (`|` in a name would be the sharper case and the
            // parser suite pins it — but NTFS refuses the loose ref file, so a
            // real git can only ever carry such a ref in packed-refs.)
            await run(['branch', 'side']);
            await run(['push', '-q', '-u', 'origin', 'side']);
            fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n', 'utf8');
            await run(['add', '-A']);
            await run(['commit', '-qm', 'C-b']);

            await run(['tag', '-a', 'annotated', '-m', 'release', commit]);
            await run(['tag', 'light', commit]);
            // A ref no consumer of this snapshot owns.
            await run(['update-ref', 'refs/agents/test/checkpoints/turn-1', commit]);

            const snap = parseRefsSnapshot(await runGit([...REFS_SNAPSHOT_ARGS], { cwd: repo }));

            // `main` carries the second commit locally, `side` stops at the first.
            assert.deepEqual(snap.branches.get('main'), { upstream: 'origin/main', ahead: 1, behind: 0 });
            assert.deepEqual(snap.branches.get('side'), { upstream: 'origin/side', ahead: 0, behind: 0 });
            assert.deepEqual([...snap.branches.keys()].sort(), ['main', 'side'], 'names must be short');
            assert.equal(snap.tags.get('annotated'), commit, 'annotated tag must peel to the commit');
            assert.equal(snap.tags.get('light'), commit);
            assert.notEqual(snap.tags.get('annotated'), (await run(['rev-parse', 'refs/tags/annotated'])).trim());
        } finally {
            removeRepo(dir);
        }
    });
});
