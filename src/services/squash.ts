import { t } from '../i18n';
import { assertHash, shSingleQuote } from './gitUtils';

/**
 * Squash planning and execution.
 *
 * What a squash is allowed to do: the selection splits into runs of commits that
 * sit next to each other in history, and every run folds into ONE commit in
 * place. The commits before a run and after it keep their own messages — the
 * user never selected them.
 *
 * The shape this replaces: folding the whole selection into a single block (which
 * reorders commits that were not selected) and then applying the edited message
 * with `commit --amend` on HEAD. That last step is why squashing two old commits
 * rewrote the message of the newest one, and with a gap in the middle the reorder
 * conflicts and leaves the repository inside a half-finished rebase.
 *
 * Everything here is free of `vscode` so the acceptance suite can drive a real
 * repository through the same functions the panel runs.
 */

/** One commit as the rebase sees it: oldest → newest within a range. */
export interface SquashTodoEntry {
    hash: string;
    subject: string;
}

/** A run of adjacent commits plus the ref the folding pass starts from. */
export interface SquashGroup {
    /** Oldest → newest, always at least two commits. */
    hashes: string[];
    /** Parent of `hashes[0]`; null when the run starts at the initial commit. */
    baseRef: string | null;
}

/** The single git primitive the executor needs: argv in, stdout out, no shell. */
export type SquashRun = (args: string[], env?: Record<string, string>) => Promise<string>;

/** Where git can read a prepared file from, and how to let go of it again. */
export interface SquashFiles {
    /** Persist `text` for git; returns an absolute path. */
    write(prefix: string, text: string): string;
    dispose(file: string): void;
}

/**
 * Split a selection into runs that are adjacent in the branch's own order.
 *
 * `orderedHashes` is every commit between the base and HEAD, oldest → newest
 * (git log order — NOT author time, which cherry-picks and amends can invert);
 * `selectedHashes` is whatever the user picked, in any order.
 */
export function splitContiguousGroups(
    orderedHashes: readonly string[],
    selectedHashes: readonly string[]
): string[][] {
    const selected = new Set(selectedHashes);
    const groups: string[][] = [];
    let run: string[] = [];
    for (const hash of orderedHashes) {
        if (selected.has(hash)) {
            run.push(hash);
            continue;
        }
        if (run.length > 0) {
            groups.push(run);
            run = [];
        }
    }
    if (run.length > 0) {
        groups.push(run);
    }
    return groups;
}

/**
 * A run of one commit has nothing to fold into, so it cannot be squashed. What is
 * left is the work the operation can really do, oldest group first.
 */
export function foldableGroups(groups: readonly (readonly string[])[]): string[][] {
    return groups.filter(group => group.length >= 2).map(group => [...group]);
}

/**
 * Todo lines for folding one group in place.
 *
 * The group becomes `pick` + `squash`…; every other commit in `entries` stays a
 * plain `pick` where it is. Listing the commits AFTER the group is not optional:
 * `rebase -i` replays exactly what the todo says, so a todo that stops at the
 * group deletes the rest of the branch (measured — a 4-line todo over a 6-commit
 * range left 4 commits and no warning).
 */
export function buildGroupTodo(
    entries: readonly SquashTodoEntry[],
    groupHashes: readonly string[]
): string[] {
    const group = new Set(groupHashes);
    const lines: string[] = [];
    let folded = 0;
    for (const entry of entries) {
        if (!group.has(entry.hash)) {
            lines.push(`pick ${entry.hash}`);
            continue;
        }
        lines.push(`${folded++ === 0 ? 'pick' : 'squash'} ${entry.hash}`);
    }
    return lines;
}

/**
 * Commits from `baseRef` (exclusive) to HEAD, oldest → newest.
 * A null base means the range starts at the initial commit.
 */
export async function readTodo(run: SquashRun, baseRef: string | null): Promise<SquashTodoEntry[]> {
    const range = baseRef ? `${baseRef}..HEAD` : 'HEAD';
    const output = await run(['log', '--reverse', '--format=%H|%s', range]);
    return output
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const cut = line.indexOf('|');
            // Split on the FIRST pipe only: subjects are user text and may contain any.
            return cut === -1
                ? { hash: line, subject: '' }
                : { hash: line.slice(0, cut), subject: line.slice(cut + 1) };
        });
}

/** First parent, or null for the initial commit (which has none). */
export async function parentOf(run: SquashRun, hash: string): Promise<string | null> {
    assertHash(hash);
    const output = await run(['rev-list', '--parents', '-n', '1', hash]);
    const parts = output.trim().split(/\s+/);
    return parts.length > 1 ? parts[1] : null;
}

/**
 * Selected commits in history order, oldest → newest, whatever order they were
 * clicked in.
 *
 * `rev-list --no-walk --topo-order` cannot answer this: with `--no-walk` there is
 * no walk left to order, and git hands the commits back roughly in the order it
 * was given (measured on a linear history — asking for `b z a y` returns
 * `b z a y`). That is click order, not history order, which is exactly the mistake
 * this function exists to prevent: cherry-picks and amends keep the original
 * author date, so a selection can read newest-to-oldest while it landed
 * oldest-to-newest.
 *
 * A real walk emits every commit before its own parents, so filtering that stream
 * down to the wanted set IS the order. The walk starts at the selected commits
 * themselves rather than HEAD, so it stays correct while the panel is showing a
 * branch other than the checked-out one; it is bounded from the top and widened
 * only when a wanted commit has not turned up yet.
 */
const ORDER_WINDOWS = [200, 2000, 0];

export async function orderHistoryOldestFirst(
    run: SquashRun,
    hashes: readonly string[]
): Promise<string[]> {
    const unique = [...new Set(hashes)];
    unique.forEach(assertHash);
    if (unique.length === 0) {
        return [];
    }
    const wanted = new Set(unique);

    for (const limit of ORDER_WINDOWS) {
        const args = ['rev-list', '--topo-order'];
        if (limit > 0) {
            args.push(`-n${limit}`);
        }
        const output = await run([...args, ...unique]);
        const found = output.split('\n').map(line => line.trim()).filter(hash => wanted.has(hash));
        if (found.length === wanted.size || limit === 0) {
            // A rev the walk never reached stays at the end instead of vanishing —
            // callers read both ends of this list.
            const placed = new Set(found);
            return [...found.reverse(), ...unique.filter(hash => !placed.has(hash))];
        }
    }
    return [];
}

/**
 * Work out which runs the selection folds into and where each pass starts.
 *
 * Throws when nothing can be folded, so the caller never has to invent an answer.
 */
export async function planSquashGroups(
    selectedHashes: readonly string[],
    run: SquashRun
): Promise<SquashGroup[]> {
    const ordered = await orderHistoryOldestFirst(run, selectedHashes);
    if (ordered.length < 2) {
        throw new Error(t('err.squashNeedTwo'));
    }

    const baseRef = await parentOf(run, ordered[0]);
    const todo = await readTodo(run, baseRef);
    const inRange = new Set(todo.map(entry => entry.hash));
    if (ordered.some(hash => !inRange.has(hash))) {
        throw new Error(t('err.squashNotInRange'));
    }

    const groups = foldableGroups(splitContiguousGroups(todo.map(entry => entry.hash), ordered));
    if (groups.length === 0) {
        throw new Error(t('err.squashNoAdjacent'));
    }

    const plan: SquashGroup[] = [];
    for (const hashes of groups) {
        plan.push({ hashes, baseRef: await parentOf(run, hashes[0]) });
    }
    return plan;
}

/**
 * Fold every group, one `rebase -i` pass each, NEWEST group first.
 *
 * The order is what keeps the plan honest: a pass rewrites the commits after the
 * group it folded, so hashes of groups that have not run yet (all older) are still
 * the ones the plan was built from. Reading the range again per pass is still
 * required — the tail above the group may be a commit this operation just created.
 *
 * `messages[i]` belongs to `plan[i]`. Without one, git's own combined message for
 * that group stands.
 */
export async function executeSquashGroups(
    plan: readonly SquashGroup[],
    messages: readonly (string | undefined)[],
    run: SquashRun,
    files: SquashFiles
): Promise<void> {
    for (let index = plan.length - 1; index >= 0; index--) {
        const group = plan[index];
        const entries = await readTodo(run, group.baseRef);
        const present = new Set(entries.map(entry => entry.hash));
        if (group.hashes.some(hash => !present.has(hash))) {
            throw new Error(t('err.squashNotInRange'));
        }
        await runFoldPass(run, files, {
            baseRef: group.baseRef,
            todo: buildGroupTodo(entries, group.hashes),
            message: messages[index]
        });
    }
}

/**
 * One folding pass.
 *
 * Git launches its editors through a shell, so both editor variables are a
 * `cp <prepared file>` and every path goes through `shSingleQuote` — a temp path
 * may hold `$`, backticks or a quote, and inside single quotes those are plain
 * text. Only the group's `squash` step opens the message editor (plain picks
 * reuse their own message), which is what lets one file name one group.
 */
async function runFoldPass(
    run: SquashRun,
    files: SquashFiles,
    opts: { baseRef: string | null; todo: string[]; message?: string }
): Promise<void> {
    if (opts.baseRef) {
        assertHash(opts.baseRef);
    }
    const todoFile = files.write('idea-git-todo', opts.todo.join('\n') + '\n');
    const messageFile = opts.message && opts.message.trim()
        ? files.write('idea-git-msg', opts.message)
        : undefined;
    try {
        await run(
            ['rebase', '-i', opts.baseRef ?? '--root'],
            {
                GIT_SEQUENCE_EDITOR: `cp ${shSingleQuote(todoFile)}`,
                GIT_EDITOR: messageFile ? `cp ${shSingleQuote(messageFile)}` : 'true'
            }
        );
    } finally {
        files.dispose(todoFile);
        if (messageFile) {
            files.dispose(messageFile);
        }
    }
}
