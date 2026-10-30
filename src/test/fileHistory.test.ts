import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildFileLogArgs, parseFileLog } from '../services/fileHistory';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function record(hash: string, author: string, at: number, ct: number, summary: string, status: string): string {
    return `\x1e${hash}\x00${author}\x00${at}\x00${ct}\x00${summary}\n\n${status}\n`;
}

describe('buildFileLogArgs', () => {
    it('follows renames and keeps the path after --', () => {
        const args = buildFileLogArgs('src/app.ts', 25);
        assert.equal(args[0], 'log');
        assert.ok(args.includes('--follow'), 'a rename must not end the history');
        assert.ok(args.includes('--name-status'), 'each commit has to name the file as it was then');
        assert.deepEqual(args.slice(0, 2), ['log', '--follow']);
        assert.equal(args[args.indexOf('-n') + 1], '25');
        assert.equal(args[args.length - 2], '--');
        assert.equal(args[args.length - 1], 'src/app.ts');
    });
});

describe('parseFileLog', () => {
    it('reads one row per record, newest first, with the fields git printed', () => {
        const output = [
            record(A, 'Alice', 100, 200, 'edit b', 'M\tb.txt'),
            record(B, 'Bob', 90, 190, 'rename a to b', 'R100\ta.txt\tb.txt'),
            record(C, 'Cara', 80, 180, 'add a', 'A\ta.txt')
        ].join('');
        const rows = parseFileLog(output);

        assert.equal(rows.length, 3);
        assert.deepEqual(rows.map(r => r.hash), [A, B, C]);
        assert.deepEqual(rows.map(r => r.path), ['b.txt', 'b.txt', 'a.txt']);
        const [first] = rows;
        assert.equal(first.author, 'Alice');
        assert.equal(first.authorTime, 100);
        assert.equal(first.committerTime, 200);
        assert.equal(first.summary, 'edit b');
        assert.equal(first.lines, 0, 'a file row owns no lines');
        assert.deepEqual(first.origLines, []);
    });

    it('takes the new name out of a rename, never the old one', () => {
        const rows = parseFileLog(record(A, 'Alice', 1, 1, 'move', 'R087\tsrc/old name.ts\tsrc/new name.ts'));
        assert.equal(rows[0]?.path, 'src/new name.ts');
    });

    it('keeps the file\'s then-name for a deletion so the diff can find it', () => {
        const rows = parseFileLog(record(A, 'Alice', 1, 1, 'remove', 'D\tlegacy/old.ts'));
        assert.equal(rows[0]?.path, 'legacy/old.ts');
    });

    it('drops malformed records instead of inventing rows', () => {
        const output = [
            'not a record\nM\tx.ts\n',
            record(A, 'Alice', 1, 1, 'ok', 'M\ta.ts'),
            '\x1e' + 'x'.repeat(40) + '\x00short\n\nM\ta.ts\n',
            record(A, '', 0, 0, 'no status line', '')
        ].join('');

        const rows = parseFileLog(output);
        assert.deepEqual(rows.map(r => r.summary), ['ok', 'no status line']);
        assert.equal(rows[1]?.path, '', 'a record with no status line has no path to diff');
    });
});

describe('parseFileLog ordering', () => {
    it('leaves the log order alone — git already prints committer order', () => {
        const rows = parseFileLog([
            record(A, 'a', 999, 5, 'second in log', 'M\tf.ts'),
            record(B, 'b', 1, 9, 'later author date', 'M\tf.ts')
        ].join(''));
        assert.deepEqual(rows.map(r => r.hash), [A, B]);
    });
});
