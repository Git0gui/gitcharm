import * as fs from 'fs';
import * as path from 'path';

/**
 * Locate the git directory of a repository root.
 *
 * Plain clones keep a `.git` directory, but linked worktrees, submodules and
 * `GIT_DIR`-style setups replace it with a one-line file (`gitdir: <path>`).
 * Reading the pointer ourselves is what lets every refs/HEAD lookup stay
 * subprocess-free, which previously only vscode.git could answer.
 */
export function resolveGitDir(repoRoot: string): string | undefined {
    const dotGit = path.join(repoRoot, '.git');
    let stat: fs.Stats;
    try {
        stat = fs.statSync(dotGit);
    } catch {
        return undefined;
    }

    if (stat.isDirectory()) {return dotGit;}
    if (!stat.isFile()) {return undefined;}

    try {
        const content = fs.readFileSync(dotGit, 'utf8');
        const match = /^gitdir:[ \t]*(.*\S)[ \t]*$/m.exec(content);
        if (!match) {return undefined;}
        const target = path.resolve(repoRoot, match[1].trim());
        return fs.existsSync(target) ? target : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The directory holding refs for the whole repository. Linked worktrees keep
 * HEAD and index to themselves but share refs, which live in `commondir`.
 */
export function resolveCommonDir(gitDir: string): string {
    const pointer = path.join(gitDir, 'commondir');
    try {
        const content = fs.readFileSync(pointer, 'utf8').trim();
        if (!content) {return gitDir;}
        return path.resolve(gitDir, content);
    } catch {
        return gitDir;
    }
}

/**
 * Whether any linked worktree is registered for this repository. Pure file
 * check: callers on interactive paths (checkout) use it to skip the
 * `git worktree list` spawn entirely in the common single-worktree case.
 */
export function hasLinkedWorktrees(commonDir: string): boolean {
    try {
        return fs.readdirSync(path.join(commonDir, 'worktrees')).length > 0;
    } catch {
        return false;
    }
}

/**
 * Stamp for the linked-worktree registrations: each registration's HEAD and
 * lock mtime plus whether its target folder still exists. Deleting a worktree
 * folder in Explorer touches none of git's own files, so without the liveness
 * flag a signature match would keep serving the pre-delete list forever.
 */
export function linkedWorktreeStamp(worktreesDir: string): string {
    const stamp = (file: string): string => {
        try {return fs.statSync(file).mtimeMs.toFixed(3);} catch {return '-';}
    };
    let names: string[];
    try {
        names = fs.readdirSync(worktreesDir).sort();
    } catch {
        return '';
    }
    const parts: string[] = [];
    for (const name of names) {
        const dir = path.join(worktreesDir, name);
        let alive = '0';
        try {
            const target = fs.readFileSync(path.join(dir, 'gitdir'), 'utf8').trim();
            alive = target && fs.existsSync(target) ? '1' : '0';
        } catch { /* an unreadable registration counts as not alive */ }
        parts.push(`${name}:${stamp(path.join(dir, 'HEAD'))}:${stamp(path.join(dir, 'locked'))}:${alive}`);
    }
    return parts.join('|');
}
