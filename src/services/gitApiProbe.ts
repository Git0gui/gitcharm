/**
 * Pure, host-free probing helpers for the optional built-in Git API backend.
 *
 * No `import 'vscode'`, no `import 'vscode.git'`, no string literal naming the
 * extension id and no `getAPI(` call live in this module: the thin host layer
 * (`gitApiHost.ts`) owns those and hands the resulting `GitApiV1` object here.
 * That keeps this file importable by `node:test` (AGENTS.md §5) and lets the
 * guard in `noVscodeGit.test.ts` stay a narrow whitelist.
 *
 * Every function is total: it never throws on a malformed API object. A bad
 * object simply yields `false` / `undefined`, which is the signal to fall back
 * to GitCharm's own implementation.
 */
import type {
    GitApiRepository,
    GitApiV1
} from './gitApiTypes';

/** Normalize a filesystem path for repository matching. */
export function normalizeFsPath(value: string, caseInsensitive: boolean): string {
    let normalized = value.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    if (normalized.length === 0 && value.length > 0) {normalized = '/';}
    return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * Only a fully initialized API is usable. `state === 'uninitialized'` means
 * the built-in extension has not finished its repository scan, so its refs and
 * HEAD would be stale — exactly the historical regression we must avoid.
 */
export function isGitApiReady(api: GitApiV1 | undefined | null): api is GitApiV1 {
    if (!api || api.state !== 'initialized') {return false;}
    try {
        return Array.isArray(api.repositories);
    } catch {
        return false;
    }
}

/**
 * Match the API's repository list to GitCharm's current working-tree root.
 * We deliberately do NOT use `api.getRepository(uri)`: that needs a real
 * `vscode.Uri`, which this pure module cannot construct.
 */
export function findRepository(
    api: GitApiV1,
    repoPath: string | undefined,
    caseInsensitive: boolean = process.platform === 'win32'
): GitApiRepository | undefined {
    if (!repoPath) {return undefined;}
    const wanted = normalizeFsPath(repoPath, caseInsensitive);
    let repositories: GitApiRepository[];
    try {
        repositories = api.repositories;
    } catch {
        return undefined;
    }
    if (!Array.isArray(repositories)) {return undefined;}
    for (const repository of repositories) {
        const root = repository && repository.rootUri && repository.rootUri.fsPath;
        if (typeof root !== 'string') {continue;}
        if (normalizeFsPath(root, caseInsensitive) === wanted) {return repository;}
    }
    return undefined;
}

/** A repository state object we can actually read from.
 *  NOTE: `state.refs` is marked `@deprecated` upstream and always returns `[]`
 *  (api1.ts: "Use ApiRepository.getRefs() instead"), so it must NOT be used as
 *  a readiness signal. `remotes` is a live array and is the reliable member. */
export function hasUsableState(repository: GitApiRepository): boolean {
    try {
        const state = repository.state;
        return !!state && Array.isArray(state.remotes);
    } catch {
        return false;
    }
}

/** `typeof repo.<method> === 'function'`, tolerating getters that throw. */
export function hasMethod(repository: GitApiRepository, name: keyof GitApiRepository): boolean {
    try {
        return typeof (repository as unknown as Record<string, unknown>)[name as string] === 'function';
    } catch {
        return false;
    }
}

/** 40- or 64-character object id (sha1 / sha256 repositories). */
export function isObjectHash(value: unknown): value is string {
    return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

export function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** `Commit.parents` has historically been type-unstable upstream. */
export function isParentHashes(value: unknown): value is string[] {
    return isStringArray(value) && value.every(item => isObjectHash(item));
}
