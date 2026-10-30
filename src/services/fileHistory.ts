/**
 * File history: every commit that touched one file, newest first.
 *
 * `git log --follow` is what makes this "one file" rather than "one path" — it
 * crosses renames, and `--name-status` then reports the name the file had at
 * each commit, which is the only name a diff of that commit can ask for.
 *
 * Pure transform, same as services/lineHistory.ts: the panel owns the spawn.
 */

import { LineHistoryCommit } from './lineHistory';

/** One page of the graph log is 100; a whole file's history fits in one walk. */
export const FILE_HISTORY_LIMIT = 1000;

const RECORD_SEPARATOR = '\x1e';
const FIELD_SEPARATOR = '\x00';
const HASH_LINE = /^[0-9a-f]{40}$/;

/**
 * `--no-merges` keeps every record carrying a name-status: without it git
 * prints merge commits with no file status at all, and a row with no path
 * cannot be diffed. `--follow` also implies merge simplification, so the walk
 * is the file's own line of descent anyway.
 */
export function buildFileLogArgs(file: string, limit: number = FILE_HISTORY_LIMIT): string[] {
    return [
        'log',
        '--follow',
        '--name-status',
        '--no-merges',
        '--format=%x1e%H%x00%an%x00%at%x00%ct%x00%s',
        '-n', String(limit),
        '--', file
    ];
}

/**
 * Parse the log into list rows.
 *
 * Each record is a `\x1e`-prefixed header line (NUL-separated fields), a blank
 * line, then the commit's name-status lines. A rename prints `R100\told\tnew`,
 * so the *last* field is always the name this commit wrote — that is the one
 * `diff base..hash` must use, and the one the next (older) record describes as
 * its `old`. Git already followed the rename; no chain bookkeeping is needed.
 */
export function parseFileLog(output: string): LineHistoryCommit[] {
    const commits: LineHistoryCommit[] = [];

    for (const record of output.split(RECORD_SEPARATOR)) {
        const eol = record.indexOf('\n');
        if (eol < 0) {continue;}
        const fields = record.slice(0, eol).split(FIELD_SEPARATOR);
        if (fields.length < 5) {continue;}
        const [hash, author, authored, committed, summary] = fields;
        if (!HASH_LINE.test(hash)) {continue;}

        commits.push({
            hash,
            author,
            authorTime: parseInt(authored, 10) || 0,
            committerTime: parseInt(committed, 10) || 0,
            summary,
            path: commitPath(record.slice(eol + 1)),
            lines: 0,
            origLines: []
        });
    }
    return commits;
}

/** The name the file had at the commit whose record body this is. */
function commitPath(body: string): string {
    for (const line of body.split('\n')) {
        if (!line) {continue;}
        const parts = line.split('\t');
        if (parts.length < 2) {continue;}
        return parts[parts.length - 1];
    }
    return '';
}
