import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    parseBlamePorcelain,
    commitsForLines,
    parseUnifiedDiff,
    mapToHeadLines,
    parseLineLog,
    mergeChain,
    buildLineLogArgs,
    worktreeEntry,
    WORKTREE_COMMIT,
    MAX_DIFF_ROWS,
    LineHistoryCommit
} from '../services/lineHistory';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const ZERO = '0'.repeat(40);

function block(hash: string, orig: number, final: number, extra: string, content: string): string {
    return `${hash} ${orig} ${final}${extra}\n${content}`;
}

function meta(hash: string, author: string, authored: number, committed: number, summary: string): string {
    return [
        `author ${author}`,
        'author-mail <dev@example.com>',
        `author-time ${authored}`,
        'author-tz +0800',
        'committer Someone',
        'committer-mail <dev@example.com>',
        `committer-time ${committed}`,
        'committer-tz +0800',
        `summary ${summary}`,
        'filename src/app.py',
        ''
    ].join('\n');
}

describe('parseBlamePorcelain', () => {
    it('maps every content line to the commit named by its header', () => {
        const out = [
            block(A, 1, 1, ' 2', `${meta(A, 'Alice', 100, 200, 'first')}\tline one`),
            '\tline two',
            block(B, 3, 3, ' 1', `${meta(B, 'Bob', 300, 400, 'second')}\tline three`)
        ].join('\n');

        const blame = parseBlamePorcelain(out);
        assert.equal(blame.length, 3);
        assert.equal(blame[0]?.hash, A);
        assert.equal(blame[0]?.author, 'Alice');
        assert.equal(blame[0]?.authorTime, 100);
        assert.equal(blame[0]?.committerTime, 200);
        assert.equal(blame[0]?.summary, 'first');
        assert.equal(blame[1]?.hash, A, 'a repeated block without metadata reuses the commit');
        assert.equal(blame[2]?.hash, B);
        assert.equal(blame[2]?.path, 'src/app.py', 'the path at that commit travels with the commit');
    });

    it('accepts the ^ boundary prefix git uses for root commits', () => {
        const out = block(`^${A}`, 1, 1, ' 1', `${meta(A, 'Alice', 1, 2, 'root')}\tbody`);
        assert.equal(parseBlamePorcelain(out)[0]?.hash, A);
    });

    it('keeps absolute line numbers for a -L narrowed walk', () => {
        const out = [
            block(A, 40, 40, ' 1', `${meta(A, 'Alice', 1, 2, 'x')}\tforty`),
            block(B, 41, 41, ' 1', `${meta(B, 'Bob', 3, 4, 'y')}\tforty-one`)
        ].join('\n');

        const blame = parseBlamePorcelain(out);
        assert.equal(blame.length, 41);
        assert.equal(blame[0], undefined);
        assert.equal(blame[39]?.hash, A);
        assert.equal(blame[40]?.hash, B);
    });

    it('tolerates CRLF line endings', () => {
        const out = block(A, 1, 1, ' 1', `${meta(A, 'Alice', 1, 2, 'x')}\tbody`).replace(/\n/g, '\r\n');
        assert.equal(parseBlamePorcelain(out)[0]?.hash, A);
    });

    it('leaves uncommitted lines with the zero hash', () => {
        const out = block(ZERO, 1, 1, ' 1', `${meta(ZERO, 'Not Committed Yet', 0, 0, '')}\tdraft`);
        assert.equal(parseBlamePorcelain(out)[0]?.hash, ZERO);
    });

    it('keeps the original-side line numbers, which differ from the buffer ones', () => {
        // Header: <sha> <orig> <final> [<count>]. A line that was line 10 in
        // its commit can be line 3 today; a diff of that commit only knows the
        // first numbering.
        const out = `${A} 10 3 2\n${meta(A, 'Alice', 1, 2, 'x')}\tone\n\ttwo`;
        const sel = commitsForLines(parseBlamePorcelain(out), 2, 3);
        assert.deepEqual(sel.commits[0].origLines, [10, 11]);
    });

    it('merges the original-side numbers of one commit across blocks', () => {
        const out = [
            block(A, 5, 1, ' 1', `${meta(A, 'Alice', 1, 2, 'x')}\tone`),
            block(A, 20, 2, ' 1', '\ttwo')
        ].join('\n');
        assert.deepEqual(commitsForLines(parseBlamePorcelain(out), 0, 1).commits[0].origLines, [5, 20]);
    });
});

describe('commitsForLines', () => {
    const blame = parseBlamePorcelain([
        block(A, 1, 1, ' 1', `${meta(A, 'Alice', 100, 200, 'old commit')}\tone`),
        block(B, 2, 2, ' 2', `${meta(B, 'Bob', 900, 500, 'rewritten later')}\ttwo`),
        '\tthree',
        block(C, 4, 4, ' 1', `${meta(C, 'Carol', 950, 600, 'newest by committer')}\tfour`),
        block(ZERO, 5, 5, ' 1', `${meta(ZERO, 'Not Committed Yet', 0, 0, '')}\tdraft`)
    ].join('\n'));

    it('dedupes commits and counts the selected lines each one owns', () => {
        const sel = commitsForLines(blame, 0, 3);
        assert.equal(sel.scanned, 4);
        assert.deepEqual(sel.commits.map(c => [c.hash, c.lines]), [[C, 1], [B, 2], [A, 1]]);
    });

    it('orders by committer time, not author time', () => {
        // Bob's author date is later than Carol's, but Carol landed last: a
        // rebase or amend preserves author dates and rewrites committer dates.
        const sel = commitsForLines(blame, 0, 3);
        assert.deepEqual(sel.commits.map(c => c.hash), [C, B, A]);
    });

    it('counts lines without a commit yet as skipped', () => {
        const sel = commitsForLines(blame, 0, 4);
        assert.equal(sel.skipped, 1);
        assert.equal(sel.commits.length, 3);
    });

    it('normalizes a reversed range', () => {
        const forward = commitsForLines(blame, 1, 3);
        const backward = commitsForLines(blame, 3, 1);
        assert.deepEqual(backward, forward);
    });

    it('reports holes outside a -L narrowed walk as skipped', () => {
        const narrow = parseBlamePorcelain(
            block(A, 12, 12, ' 1', `${meta(A, 'Alice', 1, 2, 'x')}\ttwelve`)
        );
        const sel = commitsForLines(narrow, 10, 12);
        assert.equal(sel.scanned, 3);
        assert.equal(sel.skipped, 2);
        assert.equal(sel.commits.length, 1);
    });
});

describe('parseUnifiedDiff', () => {
    it('drops the file header and numbers hunk rows', () => {
        const patch = [
            'diff --git a/src/app.py b/src/app.py',
            'index 111..222 100644',
            '--- a/src/app.py',
            '+++ b/src/app.py',
            '@@ -3,4 +3,5 @@ def main():',
            ' keep',
            '-old',
            '+new',
            '+added',
            ' tail',
            ''
        ].join('\n');

        const parsed = parseUnifiedDiff(patch);
        assert.deepEqual(parsed.rows.map(r => r.type), ['hunk', 'ctx', 'del', 'add', 'add', 'ctx']);
        assert.equal(parsed.rows[0].text, '@@ -3,4 +3,5 @@ def main():');
        assert.deepEqual(
            parsed.rows.slice(1).map(r => [r.oldLine, r.newLine]),
            [[3, 3], [4, undefined], [undefined, 4], [undefined, 5], [5, 6]]
        );
        assert.equal(parsed.binary, false);
        assert.equal(parsed.truncated, false);
    });

    it('skips the no-newline marker', () => {
        const patch = ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file'].join('\n');
        assert.deepEqual(parseUnifiedDiff(patch).rows.map(r => r.text), ['@@ -1 +1 @@', 'a', 'b']);
    });

    it('handles several hunks with independent counters', () => {
        const patch = ['@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -10,1 +10,1 @@', '-x', '+X'].join('\n');
        const rows = parseUnifiedDiff(patch).rows;
        assert.deepEqual(rows.map(r => r.type), ['hunk', 'ctx', 'del', 'add', 'hunk', 'del', 'add']);
        assert.deepEqual([rows[5].oldLine, rows[6].newLine], [10, 10]);
    });

    it('flags binary diffs', () => {
        assert.equal(parseUnifiedDiff('Binary files a/logo.png and b/logo.png differ\n').binary, true);
    });

    it('truncates past the row cap', () => {
        const body = Array.from({ length: 10 }, (_, i) => `+line ${i}`);
        const parsed = parseUnifiedDiff(['@@ -1,1 +1,10 @@', ...body].join('\n'), 5);
        assert.equal(parsed.rows.length, 5);
        assert.equal(parsed.truncated, true);
    });

    it('never exceeds the default cap', () => {
        const body = Array.from({ length: MAX_DIFF_ROWS + 50 }, () => '+x');
        assert.equal(parseUnifiedDiff(['@@ -1,1 +1,2050 @@', ...body].join('\n')).rows.length, MAX_DIFF_ROWS);
    });

    it('keeps only the hunks that touch the requested lines', () => {
        const patch = [
            '@@ -1,2 +1,2 @@',
            ' a',
            '-b',
            '+B',
            '@@ -98,2 +98,2 @@',
            ' x',
            '-y',
            '+Y'
        ].join('\n');

        const parsed = parseUnifiedDiff(patch, MAX_DIFF_ROWS, { lines: [99], restrict: true });
        assert.deepEqual(parsed.rows.map(r => r.text), ['@@ -98,2 +98,2 @@', 'x', 'y', 'Y']);
        assert.equal(parsed.truncated, false);
    });

    it('drops a deletion-only hunk: it holds no line that still exists', () => {
        const patch = ['@@ -1,1 +1,1 @@', '-a', '+b', '@@ -5,1 +4,0 @@', '-gone'].join('\n');
        const parsed = parseUnifiedDiff(patch, MAX_DIFF_ROWS, { lines: [4], restrict: true });
        assert.deepEqual(parsed.rows, []);
    });

    it('marks the requested lines without dropping anything when not restricted', () => {
        const patch = ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'].join('\n');
        const rows = parseUnifiedDiff(patch, MAX_DIFF_ROWS, { lines: [2], restrict: false }).rows;
        assert.deepEqual(rows.map(r => !!r.hit), [false, false, false, true, false]);
        assert.equal(rows[3].newLine, 2);
    });

    it('counts only the kept rows against the cap', () => {
        const first = ['@@ -1,1 +1,1 @@', '-a', '+b'];
        const second = ['@@ -50,1 +50,6 @@', '+1', '+2', '+3', '+4', '+5'];
        const parsed = parseUnifiedDiff([...first, ...second].join('\n'), 4, { lines: [50], restrict: true });
        assert.equal(parsed.rows.length, 4);
        assert.equal(parsed.truncated, true);
    });

    it('trims a huge hunk down to the wanted line and marks the gap', () => {
        // The initial import of a file is one hunk from line 1 to the end, so
        // "only the selected line" is not a property of the hunk's range.
        const body = Array.from({ length: 30 }, (_, i) => `+l${i + 1}`);
        const rows = parseUnifiedDiff(['@@ -0,0 +1,30 @@', ...body].join('\n'), MAX_DIFF_ROWS, {
            lines: [16], restrict: true
        }).rows;

        assert.deepEqual(rows.map(r => r.text), ['@@ -0,0 +1,30 @@', '⋯', 'l13', 'l14', 'l15', 'l16', 'l17', 'l18', 'l19']);
        assert.equal(rows.filter(r => r.hit).length, 1);
    });

    it('does not mark a gap when the trim only cuts git\'s own context', () => {
        // One change plus three context lines anyway: the ±3 window reaches the
        // edge of what git printed, so a `⋯` would claim something is missing.
        const patch = [
            '@@ -2,8 +2,8 @@',
            ' c2',
            ' c3',
            ' c4',
            '-v5',
            '+V5',
            ' c6',
            ' c7',
            ' c8'
        ].join('\n');

        const rows = parseUnifiedDiff(patch, MAX_DIFF_ROWS, { lines: [5], restrict: true }).rows;
        assert.deepEqual(rows.map(r => r.text), ['@@ -2,8 +2,8 @@', 'c3', 'c4', 'v5', 'V5', 'c6', 'c7', 'c8']);
    });
});

/* An uncommitted line has no commit of its own, so its chain has to start at the
 * line it replaced — which only the HEAD..worktree patch can name. */
describe('mapToHeadLines', () => {
    it('pairs an edited line with the line it replaced', () => {
        const patch = ['@@ -5,1 +5,1 @@', '-five', '+FIVE'].join('\n');
        const rows = parseUnifiedDiff(patch).rows;
        assert.deepEqual(mapToHeadLines(rows, [5]), [5]);
    });

    it('maps through a block whose size changed, clamping to its last line', () => {
        const patch = ['@@ -4,2 +4,3 @@', '-four', '-five', '+FOUR', '+FIVE', '+five and a half'].join('\n');
        const rows = parseUnifiedDiff(patch).rows;
        assert.deepEqual(mapToHeadLines(rows, [5]), [5]);
        assert.deepEqual(mapToHeadLines(rows, [4, 5, 6]), [4, 5]);
    });

    it('gives an inserted line no ancestor', () => {
        const patch = ['@@ -4,0 +5,1 @@', '+brand new'].join('\n');
        const rows = parseUnifiedDiff(patch).rows;
        assert.deepEqual(mapToHeadLines(rows, [5]), []);
    });

    it('keeps blocks apart: a hit only answers to its own hunk', () => {
        const patch = [
            '@@ -2,1 +2,1 @@',
            '-two',
            '+TWO',
            '@@ -9,1 +9,1 @@',
            '-nine',
            '+NINE'
        ].join('\n');
        const rows = parseUnifiedDiff(patch).rows;
        assert.deepEqual(mapToHeadLines(rows, [9]), [9]);
    });
});

/* `git log -L` records start with \x1e, carry NUL-separated fields, then the
 * commit's patch — the patch is where the tracked lines' content lives. */
function record(
    hash: string,
    author: string,
    authored: number,
    committed: number,
    summary: string,
    patch: string[]
): string {
    return ['\x1e' + [hash, author, authored, committed, summary].join('\0'), ...patch].join('\n');
}

describe('parseLineLog', () => {
    it('reads each record into a revision with its content and position', () => {
        const out = [
            record(A, 'Alice', 100, 200, 'bump', [
                'diff --git a/package.json b/package.json',
                '--- a/package.json',
                '+++ b/package.json',
                '@@ -5,1 +5,1 @@',
                '-  "version": "0.1.6",',
                '+  "version": "0.1.7",'
            ]),
            record(B, 'Bob', 300, 400, 'initial', [
                'diff --git a/package.json b/package.json',
                '--- /dev/null',
                '+++ b/package.json',
                '@@ -0,0 +1,1 @@',
                '+  "version": "0.1.0",'
            ])
        ].join('');

        const revisions = parseLineLog(out);
        assert.equal(revisions.length, 2);
        assert.deepEqual(revisions[0], {
            hash: A,
            author: 'Alice',
            authorTime: 100,
            committerTime: 200,
            summary: 'bump',
            path: 'package.json',
            content: ['  "version": "0.1.7",'],
            lines: [5]
        });
        assert.deepEqual(revisions[1].lines, [1]);
    });

    it('numbers added lines past the context lines that survive them', () => {
        const revision = parseLineLog(record(A, 'Alice', 1, 2, 'edit', [
            'diff --git a/a.ts b/a.ts',
            '+++ b/a.ts',
            '@@ -10,2 +10,3 @@',
            ' ctx',
            '+new one',
            '+new two',
            '-gone'
        ]))[0];

        assert.deepEqual(revision.content, ['new one', 'new two']);
        assert.deepEqual(revision.lines, [11, 12]);
    });

    it('keeps the name the file had at that revision', () => {
        const revision = parseLineLog(record(A, 'Alice', 1, 2, 'rename', [
            'diff --git a/src/old.ts b/src/new.ts',
            'similarity index 90%',
            'rename from src/old.ts',
            'rename to src/new.ts',
            '--- a/src/old.ts',
            '+++ b/src/new.ts',
            '@@ -3,1 +3,1 @@',
            '-a',
            '+b'
        ]))[0];

        assert.equal(revision.path, 'src/new.ts');
    });

    it('returns nothing for empty output or text that is not a record', () => {
        assert.deepEqual(parseLineLog(''), []);
        assert.deepEqual(parseLineLog('fatal: no such path\n'), []);
    });
});

describe('buildLineLogArgs', () => {
    it('spans the blamed lines in the blamed commit and ends at that revision', () => {
        const commit: LineHistoryCommit = {
            hash: A, author: '', authorTime: 0, committerTime: 0, summary: '',
            path: 'src/app.ts', lines: 2, origLines: [9, 7]
        };
        const args = buildLineLogArgs(commit, 5);

        assert.deepEqual(args.slice(-3), ['-L', '7,9:src/app.ts', A]);
        assert.deepEqual(args.slice(0, 2), ['log', '--format=%x1e%H%x00%an%x00%at%x00%ct%x00%s']);
        assert.deepEqual(args.slice(2, 5), ['--no-merges', '-n', '5']);
    });
});

describe('mergeChain', () => {
    const blamed: LineHistoryCommit[] = [
        {
            hash: A, author: 'Alice', authorTime: 100, committerTime: 300,
            summary: 'a', path: 'src/app.ts', lines: 2, origLines: [3, 4]
        },
        {
            hash: B, author: 'Bob', authorTime: 90, committerTime: 200,
            summary: 'b', path: 'src/app.ts', lines: 1, origLines: [9]
        }
    ];

    it('adds revisions blame cannot see and keeps the blamed metadata', () => {
        const merged = mergeChain(blamed, [
            {
                hash: A, author: 'Alice', authorTime: 100, committerTime: 300,
                summary: 'a', path: 'src/app.ts', content: ['x'], lines: [3]
            },
            {
                hash: C, author: 'Carol', authorTime: 50, committerTime: 100,
                summary: 'older rewrite', path: 'src/app.ts', content: ['y'], lines: [2]
            }
        ]);

        assert.deepEqual(merged.map(c => c.hash), [A, B, C]);
        assert.equal(merged[0].lines, 2);
        assert.deepEqual(merged[0].origLines, [3, 4]);
        assert.deepEqual(merged[0].content, ['x']);
        assert.equal(merged[2].lines, 0);
        assert.deepEqual(merged[2].origLines, [2]);
        assert.deepEqual(merged[2].content, ['y']);
    });

    it('keeps the worktree entry pinned above history', () => {
        const merged = mergeChain([worktreeEntry('src/app.ts', 1, ['now']), ...blamed], []);
        assert.equal(merged[0].hash, WORKTREE_COMMIT);
        assert.equal(merged[0].dirty, true);
        assert.deepEqual(merged.map(c => c.hash).slice(1), [A, B]);
    });
});
