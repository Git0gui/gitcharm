/**
 * Versioned persistence for the branch list cache. Pure functions with no
 * vscode/git dependencies so the format is unit-testable. Any cache file
 * that fails validation is discarded by the caller and rebuilt from git.
 */

export const BRANCH_CACHE_VERSION = 1;

export interface PersistedLocalBranch {
    name: string;
    upstream?: string;
    ahead: number;
    behind: number;
}

export interface PersistedRemoteBranch {
    name: string;
}

export interface PersistedBranches {
    local: PersistedLocalBranch[];
    remote: PersistedRemoteBranch[];
}

export interface BranchCacheFile {
    version: number;
    timestamp: number;
    repoPath: string;
    branches: PersistedBranches;
}

// Names wrapped in quotes were produced by the old spawn quoting bug;
// such entries must never be trusted again.
function _hasCleanName(b: unknown): b is { name: string } {
    return !!b && typeof (b as any).name === 'string'
        && (b as any).name.length > 0
        && !(b as any).name.startsWith('"') && !(b as any).name.endsWith('"');
}

function _isValidLocal(b: unknown): b is PersistedLocalBranch {
    if (!_hasCleanName(b)) {return false;}
    const v = b as any;
    return (v.upstream === undefined || typeof v.upstream === 'string')
        && typeof v.ahead === 'number' && typeof v.behind === 'number';
}

function _isValidRemote(b: unknown): b is PersistedRemoteBranch {
    return _hasCleanName(b);
}

export function serializeBranchCache(repoPath: string, branches: PersistedBranches): string {
    const data: BranchCacheFile = {
        version: BRANCH_CACHE_VERSION,
        timestamp: Date.now(),
        repoPath,
        branches: { local: branches.local, remote: branches.remote }
    };
    return JSON.stringify(data, null, 2);
}

/**
 * Parse and validate persisted cache content. Returns undefined when the
 * JSON is malformed, the version is stale, or any entry fails validation.
 */
export function parseBranchCache(content: string): BranchCacheFile | undefined {
    try {
        const raw = JSON.parse(content);
        if (!raw || typeof raw !== 'object') {return undefined;}
        if (raw.version !== BRANCH_CACHE_VERSION) {return undefined;}
        if (typeof raw.timestamp !== 'number' || typeof raw.repoPath !== 'string') {return undefined;}
        const branches = raw.branches;
        if (!branches || !Array.isArray(branches.local) || !Array.isArray(branches.remote)) {return undefined;}
        if (!branches.local.every(_isValidLocal) || !branches.remote.every(_isValidRemote)) {return undefined;}
        return raw as BranchCacheFile;
    } catch {
        return undefined;
    }
}
