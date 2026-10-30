import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    parseBlamePorcelain,
    commitsForLines,
    parseUnifiedDiff,
    MAX_DIFF_ROWS
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
});
