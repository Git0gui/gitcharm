/**
 * Optional capability gateway for the built-in Git extension's PUBLIC API v1.
 *
 * Contract (AGENTS.md §3, "controlled opt-in"):
 *  - GitCharm's own implementation is the authority. Every `tryXxx` here
 *    returns `T | undefined`; `undefined` means "not handled — run the local
 *    implementation". Callers in `GitService` do exactly that, and the local
 *    code below the guard is left byte-for-byte intact.
 *  - Only read-only capabilities with an equivalent public API are delegated.
 *    Anything that needs custom argv, own askpass / lock recovery / conflict
 *    handling / progress / cache invalidation / error wording stays local-only
 *    (see `GIT_API_CAPABILITIES`).
 *  - An API exception, a missing method, an uninitialized state, an implausible
 *    value (bad `parents`, non-hex HEAD, `index` pseudo-ref) or an empty
 *    snapshot all degrade to `undefined`. Nothing throws to the caller.
 *
 * This module does not import vscode (AGENTS.md §5) and is directly unit-testable.
 */
import type {
    GitApiRepository,
    GitApiV1
} from './gitApiTypes';
import {
    findRepository,
    hasMethod,
    hasUsableState,
    isGitApiReady,
    isObjectHash,
    isParentHashes,
    isStringArray,
    normalizeFsPath
} from './gitApiProbe';
import { logger } from './logger';

/** Shape returned by `GitService.getRemotes()`, reproduced structurally so the
 *  service layer does not need to import this module's concrete types. */
export interface GitApiRemoteInfo {
    name: string;
    url: string;
}

/** Every Git capability domain, including the ones that must stay local.
 *  Registering all of them is what makes this a *complete* integration map
 *  rather than a partial swap: each domain has an explicit, auditable policy. */
export type GitApiCapability =
    // read-only, equivalent public API available
    | 'currentBranch' | 'headHash' | 'localBranches' | 'remoteBranches'
    | 'remoteNames' | 'remotes' | 'commitMessage' | 'commitParents'
    | 'readBlob' | 'blobExists' | 'configValue'
    // read-only, no equivalent public API (custom argv / formats / caches)
    | 'commitGraph' | 'commitDetail' | 'commitFiles' | 'fileDiff' | 'log'
    | 'reflog' | 'stash' | 'worktree' | 'tagsAt' | 'aheadBehind'
    | 'statusEntries' | 'workingTreeSummary' | 'blame' | 'diffBase'
    | 'repoDiscovery' | 'cache' | 'repoWatch' | 'cancellation'
    // writes / network / history rewrites — own chain must stay authoritative
    | 'checkout' | 'commit' | 'merge' | 'rebase' | 'reset' | 'revert'
    | 'cherryPick' | 'squash' | 'historyRewrite' | 'push' | 'pull' | 'fetch'
    | 'branchWrite' | 'tagWrite' | 'stashWrite' | 'worktreeWrite'
    | 'remoteWrite' | 'stage' | 'sequencer';

export type CapabilityPolicy = 'api-first' | 'local-only';

export interface CapabilityRule {
    policy: CapabilityPolicy;
    reason: string;
}

const API_FIRST = (reason: string): CapabilityRule => ({ policy: 'api-first', reason });
const LOCAL_ONLY = (reason: string): CapabilityRule => ({ policy: 'local-only', reason });

/**
 * The integration policy for every capability domain. A `local-only` entry is
 * not a missing implementation: it is the deliberate decision to keep the
 * existing code path because the public API cannot reproduce its behaviour.
 */
export const GIT_API_CAPABILITIES: Readonly<Record<GitApiCapability, CapabilityRule>> = {
    currentBranch: API_FIRST('RepositoryState.HEAD.name is equivalent to reading HEAD'),
    headHash: API_FIRST('RepositoryState.HEAD.commit is the HEAD object id'),
    localBranches: API_FIRST('getBranches({remote:false}) returns RefType.Head(0) refs only'),
    remoteBranches: API_FIRST('getBranches({remote:true}) mixes Head+RemoteHead; filter by RefType.RemoteHead(1)'),
    remoteNames: API_FIRST('RepositoryState.remotes[].name matches config parsing'),
    remotes: API_FIRST('RepositoryState.remotes carries name + fetch/push URL'),
    commitMessage: API_FIRST('Repository.getCommit(ref).message is the full commit message'),
    commitParents: API_FIRST('Repository.getCommit(ref).parents, validated for the upstream type instability'),
    readBlob: LOCAL_ONLY('upstream show() runs "git show --textconv" then workspace.decode() — not byte-exact, unlike our raw-utf8 untrimmed readBlob'),
    blobExists: API_FIRST('getObjectDetails(ref, path) resolves only when the object exists (lstree + cat-file -s)'),
    configValue: LOCAL_ONLY('upstream getConfig(key) forces --local scope; our git config --get also reads global/system'),

    commitGraph: LOCAL_ONLY('custom --format / -z / --topo-order graph, filters, paging and swimlanes'),
    commitDetail: LOCAL_ONLY('assembled detail with files, refs and author/committer dates'),
    commitFiles: LOCAL_ONLY('diff-tree with numstat and NUL-separated parsing'),
    fileDiff: LOCAL_ONLY('unified diff preview, binary detection and pseudo-ref index'),
    log: LOCAL_ONLY('repo.log() ignores the branch argument and lacks GitCharm filters'),
    reflog: LOCAL_ONLY('no public reflog API'),
    stash: LOCAL_ONLY('no public API listing stash entries with files'),
    worktree: LOCAL_ONLY('no public API for the full worktree list used by the tree'),
    tagsAt: LOCAL_ONLY('tag decoration comes from the shared refs snapshot'),
    aheadBehind: LOCAL_ONLY('one for-each-ref snapshot powers divergence and tag badges'),
    statusEntries: LOCAL_ONLY('porcelain -z status parsing with six distinct XY fields'),
    workingTreeSummary: LOCAL_ONLY('must match parseWorkingTreeSummary exactly'),
    blame: LOCAL_ONLY('blame must run on the editor buffer via --contents -'),
    diffBase: LOCAL_ONLY('root commit falls back to the empty-tree hash'),
    repoDiscovery: LOCAL_ONLY('up+down repository discovery and pinning'),
    cache: LOCAL_ONLY('LruCache / Memento persistence / refs snapshot TTL'),
    repoWatch: LOCAL_ONLY('fs.watch on the git dir + 2s polling is the authoritative invalidation source'),
    cancellation: LOCAL_ONLY('AsyncLocalStorage signal + argv whitelist'),

    checkout: LOCAL_ONLY('checkout -m carries uncommitted changes; public checkout(treeish) does not'),
    commit: LOCAL_ONLY('message via -F temp file, own progress and post-commit semantics'),
    merge: LOCAL_ONLY('own conflict / empty-commit-stop handling and error wording'),
    rebase: LOCAL_ONLY('interactive rebase todo via GIT_SEQUENCE_EDITOR'),
    reset: LOCAL_ONLY('soft/mixed/hard modes plus cache invalidation'),
    revert: LOCAL_ONLY('conflict and sequencer handling'),
    cherryPick: LOCAL_ONLY('conflict and resume handling'),
    squash: LOCAL_ONLY('contiguous groups, per-group messages, --root support'),
    historyRewrite: LOCAL_ONLY('drop/amend/rebase-todo rewriting'),
    push: LOCAL_ONLY('force-with-lease, protected-branch confirmation, askpass, network error hints'),
    pull: LOCAL_ONLY('askpass, timeoutMs:0, network error classification'),
    fetch: LOCAL_ONLY('silent background fetch must bypass askpass entirely'),
    branchWrite: LOCAL_ONLY('create/delete/rename must invalidate RefsReader and persisted cache'),
    tagWrite: LOCAL_ONLY('annotated tag message via temp file, remote deletion order'),
    stashWrite: LOCAL_ONLY('include-untracked stash behaviour'),
    worktreeWrite: LOCAL_ONLY('main-worktree guard and path validation'),
    remoteWrite: LOCAL_ONLY('config edits must refresh the pure-fs remote cache'),
    stage: LOCAL_ONLY('stage/unstage/discard share the status parser'),
    sequencer: LOCAL_ONLY('continue/abort/skip with empty-commit-stop detection')
};

/** All capabilities whose public API is allowed to run. */
export const API_FIRST_CAPABILITIES: readonly GitApiCapability[] =
    (Object.keys(GIT_API_CAPABILITIES) as GitApiCapability[])
        .filter(cap => GIT_API_CAPABILITIES[cap].policy === 'api-first');

/**
 * `RefType` is declared as a `const enum` upstream, so there is no runtime
 * object to import. But `Ref.type` on returned refs carries these numeric
 * values (extensions/git/src/api/git.constants.ts, verified against main):
 * Head=0, RemoteHead=1, Tag=2. We filter explicitly because
 * `getBranches({remote:true})` returns BOTH local and remote refs — see the
 * upstream filter `type === Head || (type === RemoteHead && query.remote)`.
 */
const REF_TYPE_HEAD = 0;
const REF_TYPE_REMOTE_HEAD = 1;

export class GitApiBackend {
    private readonly _caps: Set<GitApiCapability>;
    private readonly _rootPath: string;
    private readonly _caseInsensitive: boolean;

    private constructor(
        private readonly _repository: GitApiRepository,
        caps: Set<GitApiCapability>,
        rootPath: string,
        caseInsensitive: boolean
    ) {
        this._caps = caps;
        this._rootPath = rootPath;
        this._caseInsensitive = caseInsensitive;
    }

    /**
     * Build a backend only when the API is initialized AND a repository matches
     * the current root. Any failure returns `undefined` → full local fallback.
     */
    static create(
        api: GitApiV1 | undefined,
        repoPath: string | undefined,
        caseInsensitive: boolean = process.platform === 'win32'
    ): GitApiBackend | undefined {
        if (!isGitApiReady(api) || !repoPath) {return undefined;}
        const repository = findRepository(api, repoPath, caseInsensitive);
        if (!repository || !hasUsableState(repository)) {return undefined;}

        const caps = new Set<GitApiCapability>();
        const add = (cap: GitApiCapability, available: boolean): void => {
            if (available && GIT_API_CAPABILITIES[cap].policy === 'api-first') {caps.add(cap);}
        };
        const stateOk = hasUsableState(repository);
        add('currentBranch', stateOk);
        add('headHash', stateOk);
        add('remoteNames', stateOk);
        add('remotes', stateOk);
        add('localBranches', hasMethod(repository, 'getBranches'));
        add('remoteBranches', hasMethod(repository, 'getBranches'));
        add('commitMessage', hasMethod(repository, 'getCommit'));
        add('commitParents', hasMethod(repository, 'getCommit'));
        add('blobExists', hasMethod(repository, 'getObjectDetails'));

        return caps.size > 0 ? new GitApiBackend(repository, caps, repoPath, caseInsensitive) : undefined;
    }

    /** True when at least one public capability can be served. */
    get available(): boolean {return this._caps.size > 0;}

    /** Capabilities currently served by the API (useful for diagnostics/tests). */
    get capabilities(): readonly GitApiCapability[] {return [...this._caps];}

    /**
     * A backend is bound to the repository root it was created for. GitCharm can
     * switch repositories without the built-in extension firing an event, so a
     * stale backend must be ignored rather than answering for another repo.
     */
    matchesRoot(rootPath: string | undefined): boolean {
        if (!rootPath) {return false;}
        return normalizeFsPath(rootPath, this._caseInsensitive) ===
            normalizeFsPath(this._rootPath, this._caseInsensitive);
    }

    private _has(cap: GitApiCapability): boolean {
        return GIT_API_CAPABILITIES[cap].policy === 'api-first' && this._caps.has(cap);
    }

    private _noteFailure(cap: GitApiCapability, error: unknown): void {
        // Never surface an API failure to the user: the local path is about to
        // run and will produce the same result (or its own well-formed error).
        logger.debug('[gitapi] %s unavailable, falling back to local implementation: %s',
            cap, error instanceof Error ? error.message : String(error));
    }

    private _trySync<T>(cap: GitApiCapability, read: () => T, validate: (value: T) => boolean): T | undefined {
        if (!this._has(cap)) {return undefined;}
        try {
            const value = read();
            return validate(value) ? value : undefined;
        } catch (error) {
            this._noteFailure(cap, error);
            return undefined;
        }
    }

    private async _tryAsync<T>(
        cap: GitApiCapability,
        read: () => Promise<T>,
        validate: (value: T) => boolean
    ): Promise<T | undefined> {
        if (!this._has(cap)) {return undefined;}
        try {
            const value = await read();
            return validate(value) ? value : undefined;
        } catch (error) {
            this._noteFailure(cap, error);
            return undefined;
        }
    }

    /** Current branch name. Detached HEAD answers '' just like the fs reader.
     *  During an interactive rebase the name lives in rebase-merge/head-name,
     *  which the API does not expose, so we defer to the local reader. */
    tryCurrentBranch(): string | undefined {
        if (!this._has('currentBranch')) {return undefined;}
        try {
            const state = this._repository.state;
            if (state.rebaseCommit) {return undefined;}
            const name = typeof state.HEAD?.name === 'string' ? state.HEAD.name : '';
            return typeof name === 'string' ? name : undefined;
        } catch (error) {
            this._noteFailure('currentBranch', error);
            return undefined;
        }
    }

    tryHeadHash(): string | undefined {
        return this._trySync('headHash',
            () => this._repository.state.HEAD?.commit ?? '',
            value => isObjectHash(value));
    }

    tryRemoteNames(): string[] | undefined {
        return this._trySync('remoteNames', () => {
            const remotes = this._repository.state.remotes;
            return remotes.map(remote => remote.name).filter(name => typeof name === 'string' && name.length > 0);
        }, value => isStringArray(value) && value.length > 0);
    }

    tryRemotes(): GitApiRemoteInfo[] | undefined {
        return this._trySync('remotes', () => {
            const remotes = this._repository.state.remotes;
            return remotes
                .filter(remote => typeof remote.name === 'string' && remote.name.length > 0)
                .map(remote => ({ name: remote.name, url: remote.fetchUrl ?? remote.pushUrl ?? '' }));
        }, value => Array.isArray(value) && value.length > 0 && value.every(
            item => typeof item.name === 'string' && typeof item.url === 'string'));
    }

    tryLocalBranches(): Promise<string[] | undefined> {
        return this._tryAsync('localBranches',
            () => this._repository.getBranches({ remote: false })
                .then(refs => this._branchNames(refs, REF_TYPE_HEAD)),
            value => isStringArray(value) && value.length > 0);
    }

    tryRemoteBranches(): Promise<string[] | undefined> {
        return this._tryAsync('remoteBranches',
            () => this._repository.getBranches({ remote: true })
                .then(refs => this._branchNames(refs, REF_TYPE_REMOTE_HEAD)),
            value => isStringArray(value) && value.length > 0);
    }

    /**
     * `getBranches({remote:true})` returns local + remote refs mixed together,
     * so the caller must filter by `Ref.type`. A ref without a numeric `type`
     * (older VS Code builds) is skipped, which degrades to the local reader.
     */
    private _branchNames(refs: unknown, wantedType: number): string[] | undefined {
        if (!Array.isArray(refs)) {return undefined;}
        const names: string[] = [];
        for (const ref of refs) {
            if (!ref || typeof ref !== 'object') {continue;}
            const typed = ref as { name?: unknown; type?: unknown };
            if (typed.type !== wantedType) {continue;}
            if (typeof typed.name === 'string' && typed.name.length > 0) {names.push(typed.name);}
        }
        return names;
    }

    tryCommitMessage(hash: string): Promise<string | undefined> {
        return this._tryAsync('commitMessage',
            async () => (await this._repository.getCommit(hash)).message.trim(),
            value => typeof value === 'string');
    }

    /** Guards the upstream `Commit.parents` type instability explicitly. */
    tryCommitParents(hash: string): Promise<string[] | undefined> {
        return this._tryAsync('commitParents',
            async () => (await this._repository.getCommit(hash)).parents,
            value => isParentHashes(value));
    }

    /**
     * Only a positive, verified answer is trusted. `getObjectDetails` rejects
     * either when the path is absent OR when the API itself is broken, so any
     * rejection degrades to the local `cat-file -e` check.
     * `index` / `index:<stage>` are GitCharm pseudo-refs for staged content
     * (the upstream API spells those ':1'/':2'/':3'), so they stay local too.
     */
    tryBlobExists(ref: string, filePath: string): Promise<boolean | undefined> {
        if (ref === 'index' || ref.startsWith('index:')) {return Promise.resolve(undefined);}
        return this._tryAsync('blobExists',
            async () => {
                const details = await this._repository.getObjectDetails(ref, filePath);
                return !!details && isObjectHash(details.object);
            },
            value => value === true);
    }
}
