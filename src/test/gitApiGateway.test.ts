import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type {
    GitApiRepository,
    GitApiV1
} from '../services/gitApiTypes';
import {
    findRepository,
    isGitApiReady,
    isObjectHash,
    isParentHashes,
    normalizeFsPath
} from '../services/gitApiProbe';
import {
    API_FIRST_CAPABILITIES,
    GIT_API_CAPABILITIES,
    GitApiBackend,
    type GitApiCapability
} from '../services/gitApiBackend';

/** A stable, plausible mock of the PUBLIC API v1 surface. No vscode import. */
const HASH = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const ROOT = 'D:/work/GitCharm';

type RepoOverrides = Partial<Record<keyof GitApiRepository, unknown>> & {
    state?: Partial<GitApiRepository['state']>;
};

function makeRepo(root: string = ROOT, overrides: RepoOverrides = {}): GitApiRepository {
    const state = {
        HEAD: { name: 'main', commit: HASH },
        refs: [{ name: 'main', type: 0 }],
        remotes: [{ name: 'origin', fetchUrl: 'https://example.test/repo.git', isReadOnly: false }],
        rebaseCommit: undefined,
        mergeChanges: [],
        indexChanges: [],
        workingTreeChanges: [],
        untrackedChanges: [],
        ...(overrides.state ?? {})
    };
    const base: GitApiRepository = {
        rootUri: { fsPath: root },
        state: state as GitApiRepository['state'],
        getObjectDetails: async () => ({ mode: '100644', object: HASH, size: 12 }),
        getCommit: async () => ({ hash: HASH, message: '  subject\n\nbody\n  ', parents: [PARENT] }),
        // Upstream getBranches({remote:true}) returns Head + RemoteHead MIXED.
        getBranches: async () => [{ name: 'main', type: 0 }, { name: 'origin/main', type: 1 }]
    };
    // `overrides.state` was already merged into `state` above; spreading it
    // again would replace the whole state object with a partial one.
    const rest = { ...overrides };
    delete rest.state;
    return { ...base, ...rest } as unknown as GitApiRepository;
}

function makeApi(repo: GitApiRepository, state: 'initialized' | 'uninitialized' = 'initialized'): GitApiV1 {
    return { state, repositories: [repo] } as unknown as GitApiV1;
}

function backend(overrides: RepoOverrides = {}, apiState: 'initialized' | 'uninitialized' = 'initialized'): GitApiBackend | undefined {
    return GitApiBackend.create(makeApi(makeRepo(ROOT, overrides), apiState), ROOT, false);
}

describe('gitApiProbe — pure detection helpers', () => {
    it('normalizes Windows paths and honours case sensitivity', () => {
        assert.equal(normalizeFsPath('D:\\work\\GitCharm\\', true), 'd:/work/gitcharm');
        assert.equal(normalizeFsPath('D:/work/GitCharm/', false), 'D:/work/GitCharm');
        assert.equal(normalizeFsPath('///', false), '/');
    });

    it('only an initialized API with a repository array is ready', () => {
        assert.equal(isGitApiReady(undefined), false);
        assert.equal(isGitApiReady({ state: 'uninitialized', repositories: [] } as GitApiV1), false);
        assert.equal(isGitApiReady({ state: 'initialized', repositories: undefined } as unknown as GitApiV1), false);
        assert.equal(isGitApiReady(makeApi(makeRepo())), true);
    });

    it('matches the repository by root, tolerating separators and case', () => {
        const repo = makeRepo('D:\\work\\GitCharm\\');
        assert.equal(findRepository(makeApi(repo), 'D:/work/GitCharm', true), repo);
        assert.equal(findRepository(makeApi(repo), 'D:/elsewhere', true), undefined);
        assert.equal(findRepository(makeApi(repo), undefined, true), undefined);
    });

    it('validates object ids and the historically unstable parents field', () => {
        assert.equal(isObjectHash(HASH), true);
        assert.equal(isObjectHash('c'.repeat(64)), true);
        assert.equal(isObjectHash('nope'), false);
        assert.equal(isParentHashes([PARENT]), true);
        assert.equal(isParentHashes(PARENT), false, 'a bare string must be rejected');
        assert.equal(isParentHashes(['zzz']), false);
    });
});

describe('GitApiBackend.create — availability detection', () => {
    it('returns undefined whenever the API is unusable (full local fallback)', () => {
        assert.equal(GitApiBackend.create(undefined, ROOT), undefined);
        assert.equal(backend({}, 'uninitialized'), undefined);
        assert.equal(GitApiBackend.create(makeApi(makeRepo()), 'D:/other'), undefined);
        assert.equal(GitApiBackend.create(makeApi(makeRepo()), undefined), undefined);
        assert.equal(backend({ state: { remotes: undefined } as unknown as GitApiRepository['state'] }), undefined);
    });

    it('exposes exactly the api-first capabilities that the repository supports', () => {
        const full = backend();
        assert.ok(full);
        assert.equal(full.available, true);
        assert.deepEqual([...full.capabilities].sort(), [...API_FIRST_CAPABILITIES].sort());

        const noMethods = backend({
            getBranches: undefined,
            getCommit: undefined,
            getObjectDetails: undefined
        });
        assert.ok(noMethods);
        assert.deepEqual([...noMethods.capabilities].sort(),
            ['currentBranch', 'headHash', 'remoteNames', 'remotes'].sort());
    });

    it('a backend is bound to its repository root', () => {
        const full = backend();
        assert.ok(full);
        assert.equal(full.matchesRoot(ROOT), true);
        assert.equal(full.matchesRoot('d:\\work\\gitcharm'), false); // case-sensitive probe
        assert.equal(full.matchesRoot('D:/another'), false);
        assert.equal(full.matchesRoot(undefined), false);
    });
});

describe('GitApiBackend — api-first results and graceful degradation', () => {
    it('serves current branch, HEAD, remotes and branch lists', async () => {
        const b = backend();
        assert.ok(b);
        assert.equal(b.tryCurrentBranch(), 'main');
        assert.equal(b.tryHeadHash(), HASH);
        assert.deepEqual(b.tryRemoteNames(), ['origin']);
        assert.deepEqual(b.tryRemotes(), [{ name: 'origin', url: 'https://example.test/repo.git' }]);
        assert.deepEqual(await b.tryLocalBranches(), ['main']);
        assert.deepEqual(await b.tryRemoteBranches(), ['origin/main']);
    });

    it('upstream getBranches({remote:true}) mixes Head+RemoteHead — filter by RefType', async () => {
        // Verified against microsoft/vscode extensions/git/src/repository.ts:
        //   refs.filter(v => v.type === Head || (v.type === RemoteHead && query.remote))
        // so "remote" does NOT mean "only remote refs".
        const mixed = [
            { name: 'main', type: 0 },
            { name: 'feature/x', type: 0 },
            { name: 'origin/main', type: 1 },
            { name: 'v1.0', type: 2 },
            { name: 'no-type' }
        ];
        const b = backend({ getBranches: async () => mixed });
        assert.ok(b);
        assert.deepEqual(await b.tryLocalBranches(), ['main', 'feature/x']);
        assert.deepEqual(await b.tryRemoteBranches(), ['origin/main']);
        // A build whose refs carry no numeric type degrades to the local reader.
        assert.equal(await backend({ getBranches: async () => [{ name: 'main' }] })?.tryLocalBranches(), undefined);
    });

    it('detached HEAD answers empty string, rebase defers to the local reader', () => {
        assert.equal(backend({ state: { HEAD: { commit: HASH } } })?.tryCurrentBranch(), '');
        assert.equal(backend({ state: { rebaseCommit: { hash: HASH, message: 'x', parents: [] } } })?.tryCurrentBranch(), undefined);
    });

    it('rejects implausible values instead of returning them', async () => {
        assert.equal(backend({ state: { HEAD: { name: 'main', commit: 'not-a-hash' } } })?.tryHeadHash(), undefined);
        assert.equal(backend({ state: { remotes: [] } })?.tryRemoteNames(), undefined);
        assert.equal(backend({ state: { remotes: [] } })?.tryRemotes(), undefined);
        assert.equal(await backend({ getBranches: async () => [] })?.tryLocalBranches(), undefined);
        assert.equal(await backend({ getCommit: async () => ({ hash: HASH, message: 'm', parents: 'oops' }) })?.tryCommitParents(HASH), undefined);
        assert.equal(await backend({ getCommit: async () => ({ hash: HASH, message: 'm', parents: ['bad'] }) })?.tryCommitParents(HASH), undefined);
    });

    it('serves immutable commit data and validates the parents shape', async () => {
        const b = backend();
        assert.ok(b);
        assert.equal(await b.tryCommitMessage(HASH), 'subject\n\nbody');
        assert.deepEqual(await b.tryCommitParents(HASH), [PARENT]);
        assert.equal(await b.tryBlobExists(HASH, 'src/a.ts'), true);
    });

    it('degrades on pseudo-refs, unverifiable objects and API exceptions', async () => {
        const b = backend();
        assert.ok(b);
        assert.equal(await b.tryBlobExists('index', 'src/a.ts'), undefined);
        assert.equal(await b.tryBlobExists('index:2', 'src/a.ts'), undefined);
        assert.equal(await backend({ getObjectDetails: async () => ({ mode: 'x', object: 'bad', size: 0 }) })?.tryBlobExists(HASH, 'x'), undefined);
        assert.equal(await backend({ getObjectDetails: async () => { throw new Error('missing'); } })?.tryBlobExists(HASH, 'x'), undefined);
        assert.equal(await backend({ getCommit: async () => { throw new Error('bad ref'); } })?.tryCommitMessage(HASH), undefined);
        assert.equal(await backend({ getBranches: async () => { throw new Error('scan failed'); } })?.tryLocalBranches(), undefined);
    });
});

describe('two-path behaviour consistency', () => {
    it('every api-first result has the same shape as the local implementation', async () => {
        const b = backend();
        assert.ok(b);
        // Local implementations (GitService) return exactly these types:
        // string / string / string[] / {name,url}[] / string[] / string /
        // string[] / boolean. Any divergence would break the two-path contract.
        assert.equal(typeof b.tryCurrentBranch(), 'string');
        assert.equal(typeof b.tryHeadHash(), 'string');
        assert.ok(Array.isArray(b.tryRemoteNames()));
        assert.ok(Array.isArray(b.tryRemotes()));
        assert.ok(Array.isArray(await b.tryLocalBranches()));
        assert.equal(typeof await b.tryCommitMessage(HASH), 'string');
        assert.ok(Array.isArray(await b.tryCommitParents(HASH)));
        assert.equal(typeof await b.tryBlobExists(HASH, 'x'), 'boolean');
    });

    it('undefined is the single, unambiguous fallback signal', async () => {
        const b = backend();
        assert.ok(b);
        // Empty-string / empty-array / false are real answers, never fallback.
        assert.notEqual(b.tryCurrentBranch(), undefined);
        assert.notEqual(b.tryHeadHash(), undefined);
        assert.notEqual(await b.tryBlobExists(HASH, 'x'), undefined);
        // Anything untrustworthy must be undefined so the local code runs.
        assert.equal(b.tryHeadHash() === undefined || isObjectHash(b.tryHeadHash() as string), true);
    });
});

describe('capability policy is complete and conservative', () => {
    it('every registered capability has a policy and a reason', () => {
        const caps = Object.keys(GIT_API_CAPABILITIES) as GitApiCapability[];
        assert.ok(caps.length >= 40, 'the whole Git capability surface must be registered');
        for (const cap of caps) {
            const rule = GIT_API_CAPABILITIES[cap];
            assert.ok(rule.policy === 'api-first' || rule.policy === 'local-only');
            assert.ok(rule.reason.length > 0, `${cap} needs a documented reason`);
        }
    });

    it('all writes, network calls and custom-argv reads stay local-only', () => {
        const mustStayLocal: GitApiCapability[] = [
            'checkout', 'commit', 'merge', 'rebase', 'reset', 'revert', 'cherryPick',
            'squash', 'historyRewrite', 'push', 'pull', 'fetch', 'branchWrite',
            'tagWrite', 'stashWrite', 'worktreeWrite', 'remoteWrite', 'stage', 'sequencer',
            'commitGraph', 'commitDetail', 'commitFiles', 'fileDiff', 'log', 'reflog',
            'stash', 'worktree', 'blame', 'repoWatch', 'cancellation', 'cache',
            // Verified against the upstream implementation: these two cannot
            // reproduce GitCharm's exact behaviour, so they must stay local.
            'readBlob', 'configValue'
        ];
        for (const cap of mustStayLocal) {
            assert.equal(GIT_API_CAPABILITIES[cap].policy, 'local-only', `${cap} must keep the existing implementation`);
        }
    });

    it('only read-only equivalent capabilities are delegated', () => {
        assert.equal(API_FIRST_CAPABILITIES.length, 9);
        for (const cap of API_FIRST_CAPABILITIES) {
            assert.equal(GIT_API_CAPABILITIES[cap].policy, 'api-first');
        }
    });
});
