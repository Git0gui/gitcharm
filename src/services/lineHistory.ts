/**
 * Line history: which commits last touched the lines under the cursor, and what
 * each of those commits changed in the file.
 *
 * Everything here is a pure transform so it can be tested without an editor:
 * `git blame --porcelain` in, commit list out; `git diff` in, renderable rows out.
 * The vscode half lives in views/lineHistoryPanel.ts.
 */

/** `git blame` reports uncommitted worktree lines as an all-zero hash. */
export const ZERO_HASH = /^0+$/;

/** One page of the commit list; bigger windows are a "load more" click away. */
export const LINE_HISTORY_PAGE = 10;

/** Rendering more than this is neither readable nor fast; the rest is a note. */
export const MAX_DIFF_ROWS = 2000;

export interface BlameLineInfo {
    hash: string;
    author: string;
    /** Author time, used for display (an amend keeps the original author date). */
    authorTime: number;
    /** Committer time, used for ordering — that is the order `git log` shows. */
    committerTime: number;
    summary: string;
    /** Path the file had at that commit; a diff has to ask for this name. */
    path: string;
    /**
     * Where the selected lines sit in *this commit's* version of the file.
     * Blame's header carries both numbers (`<sha> <orig> <final>`); the final
     * one indexes the buffer the user is looking at, while the original one is
     * the only way to find those lines again in `diff base..commit`, where the
     * numbering is the commit's, not today's.
     */
    origLines: number[];
}

/**
 * Parse `git blame --porcelain` into an array indexed by the file's line number
 * (0-based); holes are lines the output did not cover.
 *
 * The header names the commit once per contiguous block and the commit's fields
 * follow it once, so the metadata is collected per hash and every block points
 * at the same object. `-L a,b` narrows the walk but keeps absolute line numbers
 * in the header, which is why the result stays indexed by the real line.
 */
export function parseBlamePorcelain(output: string): (BlameLineInfo | undefined)[] {
    const meta = new Map<string, BlameLineInfo>();
    const result: (BlameLineInfo | undefined)[] = [];
    let current: { hash: string; orig: number; line: number } | undefined;

    for (const raw of output.split('\n')) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        const head = /^\^?([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
        if (head) {
            current = { hash: head[1], orig: parseInt(head[2], 10), line: parseInt(head[3], 10) };
            if (!meta.has(current.hash)) {
                meta.set(current.hash, {
                    hash: current.hash, author: '', authorTime: 0, committerTime: 0,
                    summary: '', path: '', origLines: []
                });
            }
            continue;
        }
        if (line.startsWith('\t')) {
            // The tab marks a content line. A block can cover several lines
            // (the header's trailing count), and they are consecutive on both
            // sides — blaming only the header's first line would leave the rest
            // of the block holding whichever line came last.
            if (current) {
                meta.get(current.hash)!.origLines.push(current.orig);
                result[current.line - 1] = meta.get(current.hash);
                current.orig++;
                current.line++;
            }
            continue;
        }
        if (!current) {continue;}
        const entry = meta.get(current.hash)!;
        if (line.startsWith('author ')) {entry.author = line.substring(7);}
        else if (line.startsWith('author-time ')) {entry.authorTime = parseInt(line.substring(12), 10) || 0;}
        else if (line.startsWith('committer-time ')) {entry.committerTime = parseInt(line.substring(15), 10) || 0;}
        else if (line.startsWith('summary ')) {entry.summary = line.substring(8);}
        // The name the file had at that commit: blame follows renames, so a
        // commit from before the rename only diffs under this old path.
        else if (line.startsWith('filename ')) {entry.path = line.substring(9);}
    }
    return result;
}

export interface LineHistoryCommit {
    hash: string;
    author: string;
    authorTime: number;
    committerTime: number;
    summary: string;
    /** Path the file had at that commit (diff and native compare use it). */
    path: string;
    /** How many of the selected lines currently come from this commit. */
    lines: number;
    /** Those same lines numbered in this commit's version (diff filtering). */
    origLines: number[];
}

export interface LineHistorySelection {
    commits: LineHistoryCommit[];
    /** Selected lines with no commit yet (edited in the worktree, never committed). */
    skipped: number;
    /** Lines the selection covers. */
    scanned: number;
}

/**
 * The commits behind a line range, newest first, each counted once.
 *
 * `startLine`/`endLine` are 0-based and inclusive. Ordering is by committer time,
 * i.e. the order `git log` prints: author time is preserved by rebase and amend,
 * so on a rewritten branch it would put the commits in the wrong order. Ties
 * (a single branch merge landing in the same second) fall back to the hash so
 * the list never reshuffles between two identical queries.
 */
export function commitsForLines(
    blame: readonly (BlameLineInfo | undefined)[],
    startLine: number,
    endLine: number
): LineHistorySelection {
    const byHash = new Map<string, LineHistoryCommit>();
    let skipped = 0;
    let scanned = 0;

    const from = Math.max(0, Math.min(startLine, endLine));
    const to = Math.max(startLine, endLine);
    for (let index = from; index <= to; index++) {
        scanned++;
        const info = blame[index];
        if (!info || ZERO_HASH.test(info.hash)) {
            skipped++;
            continue;
        }
        const existing = byHash.get(info.hash);
        if (existing) {
            existing.lines++;
            continue;
        }
        byHash.set(info.hash, {
            hash: info.hash,
            author: info.author,
            authorTime: info.authorTime,
            committerTime: info.committerTime,
            summary: info.summary,
            path: info.path,
            lines: 1,
            origLines: [...new Set(info.origLines)].sort((a, b) => a - b)
        });
    }

    const commits = [...byHash.values()].sort((a, b) =>
        b.committerTime - a.committerTime || (a.hash < b.hash ? -1 : 1)
    );
    return { commits, skipped, scanned };
}

export type DiffRowType = 'hunk' | 'ctx' | 'add' | 'del';

export interface DiffRow {
    type: DiffRowType;
    /** Line content without the leading `+`/`-`/space; hunk rows keep the heading text. */
    text: string;
    oldLine?: number;
    newLine?: number;
    /** This row is one of the lines the selection owns (highlighted in the panel). */
    hit?: boolean;
}

/**
 * Which lines of the patch matter.
 *
 * The numbers are the selection's position in the *commit's* file, which is the
 * new side of `diff base..commit` — the only numbering that is valid on both.
 */
export interface DiffLineFilter {
    lines: readonly number[];
    /** Keep only the hunks that touch those lines; otherwise merely mark them. */
    restrict: boolean;
}

export interface ParsedPatch {
    rows: DiffRow[];
    truncated: boolean;
    /** git refused to diff the bytes; the caller shows a note instead of rows. */
    binary: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** How many rows of the hunk body survive on each side of a wanted line. */
const HIT_CONTEXT_ROWS = 3;

/** Marks a stretch of the hunk that the panel left out. */
const GAP_TEXT = '⋯';

/**
 * Keep only the neighbourhood of the wanted rows, and mark where the rest went.
 *
 * Git's three lines of context belong to the *hunk*, and a hunk can be the whole
 * file — the initial import of a file is one hunk from line 1 to the end, so a
 * line that has not changed since then would otherwise still paint thousands of
 * rows. A `⋯` bar keeps the coordinates honest: the numbers on the next row
 * jump, and the reader can see why.
 */
function trimToHits(body: DiffRow[]): DiffRow[] {
    const inside = body.map(() => false);
    let last = -1;
    for (let i = 0; i < body.length; i++) {
        if (!body[i].hit) {continue;}
        const from = Math.max(0, i - HIT_CONTEXT_ROWS);
        const to = Math.min(body.length - 1, i + HIT_CONTEXT_ROWS);
        for (let k = from; k <= to; k++) {inside[k] = true;}
    }
    for (let i = inside.length - 1; i >= 0; i--) {
        if (inside[i]) {last = i; break;}
    }

    const rows: DiffRow[] = [];
    let gap = false;
    for (let i = 0; i <= last; i++) {
        if (inside[i]) {
            rows.push(body[i]);
            gap = false;
        } else if (!gap) {
            rows.push({ type: 'hunk', text: GAP_TEXT });
            gap = true;
        }
    }
    return rows;
}

/**
 * Turn a unified patch into rows the panel can render with two line-number
 * columns. Everything before the first `@@` (the `diff --git` / `index` /
 * `---` / `+++` block) is dropped: the panel always knows which file and which
 * two revisions it asked about, so repeating that in the body is noise.
 *
 * A hunk body is positional, not labelled: every line is exactly one of
 * context (` `), addition (`+`) or deletion (`-`), and the two running counters
 * are what give each row its numbers. `\ No newline at end of file` carries no
 * content and is skipped.
 *
 * With a `restrict` filter, a hunk survives only if its new-side range covers
 * one of the lines of interest, and only the rows within three rows of such a
 * line are kept (see `trimToHits`). Whole hunks are otherwise untouched: a
 * single added line with no surroundings is unreadable. Deletion-only hunks
 * never survive — they have no new-side width, so they cannot contain a line
 * that still exists at this commit.
 */
export function parseUnifiedDiff(
    patch: string,
    maxRows: number = MAX_DIFF_ROWS,
    filter?: DiffLineFilter
): ParsedPatch {
    const keep = filter && filter.lines.length > 0 ? new Set(filter.lines) : undefined;
    const restrict = !!filter?.restrict && !!keep;

    const rows: DiffRow[] = [];
    let truncated = false;
    let stopped = false;

    // One hunk at a time: whether it belongs to the selection depends on its
    // new-side range, which is only known once its header has been read.
    let head: DiffRow | undefined;
    let body: DiffRow[] = [];
    let rangeFrom = 0;
    let rangeTo = -1;
    let oldNo = 0;
    let newNo = 0;
    let inHunk = false;

    const wanted = (): boolean => {
        if (!restrict || !keep) { return true; }
        for (let n = rangeFrom; n <= rangeTo; n++) {
            if (keep.has(n)) { return true; }
        }
        return false;
    };

    const flush = (): void => {
        if (head && wanted()) {
            const visible = restrict ? trimToHits(body) : body;
            if (visible.length === 0) {
                head = undefined;
                body = [];
                return;
            }
            if (rows.length >= maxRows) {
                truncated = true;
                stopped = true;
                return;
            }
            rows.push(head);
            for (const row of visible) {
                if (rows.length >= maxRows) {
                    truncated = true;
                    stopped = true;
                    return;
                }
                rows.push(row);
            }
        }
        head = undefined;
        body = [];
    };

    for (const raw of patch.split('\n')) {
        if (stopped) {break;}
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.startsWith('@@')) {
            flush();
            if (stopped) {break;}
            const match = HUNK_HEADER.exec(line);
            if (!match) {
                inHunk = false;
                continue;
            }
            const newStart = parseInt(match[3], 10);
            const newCount = match[4] === undefined ? 1 : parseInt(match[4], 10);
            oldNo = parseInt(match[1], 10);
            newNo = newStart;
            rangeFrom = newStart;
            rangeTo = newStart + newCount - 1;
            inHunk = true;
            // Keep the coordinates: a hunk with no enclosing function has no
            // heading at all, and a blank separator reads as a rendering bug.
            head = { type: 'hunk', text: line.trim() };
            continue;
        }
        if (!inHunk || !head) {continue;}
        if (line.startsWith('\\')) {continue;}

        let row: DiffRow | undefined;
        if (line.startsWith('+')) {
            row = { type: 'add', text: line.slice(1), newLine: newNo++ };
        } else if (line.startsWith('-')) {
            row = { type: 'del', text: line.slice(1), oldLine: oldNo++ };
        } else if (line.startsWith(' ') || line === '') {
            // A truly empty line here is the artifact of splitting the final
            // newline; a real empty context line arrives as a single space.
            if (line === '') {continue;}
            row = { type: 'ctx', text: line.slice(1), oldLine: oldNo++, newLine: newNo++ };
        }
        if (!row) {continue;}
        if (keep && row.newLine !== undefined && keep.has(row.newLine)) {row.hit = true;}
        body.push(row);
    }
    flush();

    return { rows, truncated, binary: /^Binary files .* differ$/m.test(patch) };
}
