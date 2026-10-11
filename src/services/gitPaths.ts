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
