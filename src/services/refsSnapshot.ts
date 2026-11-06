/**
 * The one refs query the panel needs at startup.
 *
 * Two `for-each-ref` spawns used to run for this: one for the branch track info
 * (upstream + ahead/behind), one to peel tags. Asking for both namespaces in a
 * single format string takes one, which is what the first paint was paying for
 * twice — and on a repository with loose objects the track query alone is the
 * most expensive query after `git log` itself.
 *
 * Pure module (no vscode import) so it can be unit-tested with node:test.
 */

import { parseTrackInfo } from './gitUtils';

/**
 * Field separator. Ref names may legally contain `|`, which is exactly what the
 * two formats this replaced split on, while U+00–U+1F is illegal in a ref name —
 * so this byte cannot appear inside any field.
 *
 * It reaches git as a literal byte in argv: `--format` copies anything that is
 * not a `%` placeholder, and GitCommandRunner spawns without a shell.
 */
export const REFS_SNAPSHOT_SEP = '\u001f';

/**
 * refname | objectname | *objectname | upstream:short | upstream:track.
 *
 * `%(refname)` (not `:short`) because the response now mixes namespaces and each
 * line has to say which one it came from.
 */
export const REFS_SNAPSHOT_FORMAT = [
    '%(refname)', '%(objectname)', '%(*objectname)', '%(upstream:short)', '%(upstream:track)'
].join(REFS_SNAPSHOT_SEP);

/** The argv every refs-snapshot query uses, so callers cannot drift apart. */
export const REFS_SNAPSHOT_ARGS: readonly string[] = [
    'for-each-ref', 'refs/heads', 'refs/tags', `--format=${REFS_SNAPSHOT_FORMAT}`
];

/** Upstream and divergence of one local branch. */
export interface BranchTrackInfo {
    upstream?: string;
    ahead: number;
    behind: number;
}

export interface RefsSnapshot {
    /** Local branch name -> upstream + ahead/behind. */
    branches: Map<string, BranchTrackInfo>;
    /** Tag name -> the commit it peels to (annotated tags are peeled). */
    tags: Map<string, string>;
}

/**
 * Turn REFS_SNAPSHOT_FORMAT output into the two maps.
 *
 * Everything outside refs/heads and refs/tags is ignored: `refs/stash`, the
 * agent hosts' checkpoint refs and any other tool's refs are neither a row of
 * the branch tree nor a badge on a commit.
 */
export function parseRefsSnapshot(output: string): RefsSnapshot {
    const branches = new Map<string, BranchTrackInfo>();
    const tags = new Map<string, string>();
    const hashRe = /^[0-9a-f]{40,64}$/i;

    for (const line of output.split('\n')) {
        if (!line) {continue;}
        const fields = line.split(REFS_SNAPSHOT_SEP);
        const ref = fields[0] ?? '';
        // A quoted name is an escaped one (non-ASCII ref with core.quotePath
        // left on, so the rest of the field carries octal escapes). Guessing at
        // it would hand git a name no ref answers to; the runner always sets
        // quotePath=false, so this only guards a caller that forgot to.
        if (!ref || ref.startsWith('"')) {continue;}

        if (ref.startsWith('refs/heads/')) {
            const name = ref.substring('refs/heads/'.length);
            if (!name) {continue;}
            const upstream = (fields[3] ?? '').trim();
            const { ahead, behind } = parseTrackInfo(fields[4]);
            branches.set(name, { upstream: upstream || undefined, ahead, behind });
        } else if (ref.startsWith('refs/tags/')) {
            const name = ref.substring('refs/tags/'.length);
            const object = (fields[1] ?? '').trim();
            const peeled = (fields[2] ?? '').trim();
            if (!name || !hashRe.test(object)) {continue;}
            // `%(*objectname)` is the commit an annotated tag peels to and empty
            // for a lightweight tag, whose object name already is the commit.
            tags.set(name, peeled && hashRe.test(peeled) ? peeled : object);
        }
    }

    return { branches, tags };
}
