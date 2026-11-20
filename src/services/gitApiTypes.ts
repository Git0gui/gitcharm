/**
 * Structural types for the STABLE, PUBLIC VS Code Git extension API (version 1).
 *
 * Source of truth: `extensions/git/src/api/git.d.ts` in microsoft/vscode
 * (https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts).
 *
 * Rules enforced by `src/test/noVscodeGit.test.ts` and `gitApiGateway.test.ts`:
 *  - `getAPI(1)` is the ONLY stable public version. No v2, no proposed API.
 *  - Only read-only members of `API` / `Repository` / `RepositoryState` are
 *    declared here. Registration points (`register*Provider`), history-item
 *    providers, branch-protection providers and anything experimental are
 *    deliberately NOT part of this surface.
 *  - `RefType` / `Status` / `ForcePushMode` are `const enum`s: they do not
 *    exist at runtime, so their values are modelled as plain `number` and
 *    never imported or referenced by name.
 *  - This file is pure TypeScript: no `import 'vscode'`, no `import 'vscode.git'`,
 *    no npm package. The extension is discovered at runtime through the generic
 *    `vscode.extensions.getExtension` host API, and NO dependency on it is
 *    declared in `package.json` (no `extensionDependencies`, no `@types`).
 *  - Being importable by node:test without a vscode host is a hard requirement
 *    (AGENTS.md §5), hence the duck-typed `UriLike` instead of `vscode.Uri`.
 */

/** Minimal shape of `vscode.Uri` that we actually read. */
export interface GitApiUriLike {
    readonly fsPath: string;
}

/** Public `Commit`: `parents` is typed `string[]` upstream but has historically
 *  been unstable, so every consumer validates it before use. */
export interface GitApiCommit {
    readonly hash: string;
    readonly message: string;
    readonly parents: string[];
    readonly authorDate?: Date;
    readonly authorName?: string;
    readonly authorEmail?: string;
    readonly commitDate?: Date;
}

export interface GitApiUpstreamRef {
    readonly remote: string;
    readonly name: string;
    readonly commit?: string;
}

/** `RefType` is a const enum (Head=0, RemoteHead=1, Tag=2) — number at runtime. */
export interface GitApiRef {
    readonly type?: number;
    readonly name?: string;
    readonly commit?: string;
    readonly remote?: string;
}

export interface GitApiBranch extends GitApiRef {
    readonly upstream?: GitApiUpstreamRef;
    readonly ahead?: number;
    readonly behind?: number;
}

export interface GitApiRemote {
    readonly name: string;
    readonly fetchUrl?: string;
    readonly pushUrl?: string;
    readonly isReadOnly: boolean;
}

/** `Status` is a const enum — number at runtime. */
export interface GitApiChange {
    readonly uri: GitApiUriLike;
    readonly status: number;
}

export interface GitApiRepositoryState {
    readonly HEAD?: GitApiBranch;
    /** @deprecated upstream: always returns `[]` (api1.ts points at getRefs()).
     *  Declared for structural completeness but NEVER read by GitCharm. */
    readonly refs: GitApiRef[];
    readonly remotes: GitApiRemote[];
    readonly rebaseCommit?: GitApiCommit;
    readonly mergeChanges: GitApiChange[];
    readonly indexChanges: GitApiChange[];
    readonly workingTreeChanges: GitApiChange[];
    readonly untrackedChanges: GitApiChange[];
}

/** Public `BranchQuery`. `remote` distinguishes local from remote-tracking
 *  refs without needing the const-enum `RefType`. */
export interface GitApiBranchQuery {
    readonly remote?: boolean;
    readonly contains?: string;
    readonly count?: number;
    readonly pattern?: string | string[];
}

/**
 * Only the READ-ONLY public `Repository` members GitCharm may use.
 * Write/network members are intentionally absent: they must keep flowing
 * through GitCharm's own runner (askpass, lock recovery, conflict handling,
 * progress, cache invalidation and error wording all depend on it).
 *
 * Also deliberately absent, after checking the upstream implementation:
 *  - `show()` runs `git show --textconv` + `workspace.decode()`, so its bytes
 *    are not identical to our raw-utf8 `readBlob()`;
 *  - `getConfig(key)` forces the `--local` scope while our `git config --get`
 *    also reads global/system config.
 *  - `state.refs` is `@deprecated` and always returns `[]` upstream.
 */
export interface GitApiRepository {
    readonly rootUri: GitApiUriLike;
    readonly state: GitApiRepositoryState;
    getObjectDetails(treeish: string, path: string): Promise<{ mode: string; object: string; size: number }>;
    getCommit(ref: string): Promise<GitApiCommit>;
    getBranches(query: GitApiBranchQuery): Promise<GitApiRef[]>;
}

/** Public `API` members used for discovery only. */
export interface GitApiV1 {
    readonly state: 'uninitialized' | 'initialized';
    readonly repositories: GitApiRepository[];
    readonly onDidOpenRepository?: unknown;
    readonly onDidCloseRepository?: unknown;
}

/**
 * Public `GitExtension` exports. `getAPI` accepts exactly version `1`;
 * the upstream declaration is `getAPI(version: 1): API`.
 */
export interface GitApiExtension {
    readonly enabled: boolean;
    readonly onDidChangeEnablement?: unknown;
    /** The public `getAPI(version: 1)` contract. Declared as a property so the
     *  guard's call pattern only ever appears in the single host layer. */
    readonly getAPI: (version: 1) => GitApiV1;
}
