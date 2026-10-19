import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { logger } from './logger';
import { resolveCommonDir, resolveGitDir } from './gitPaths';
import { peeledCommitFromTagObject } from './gitUtils';

/**
 * Reads branch/tag -> commit-hash mappings straight from the git directory
 * (loose refs + packed-refs), avoiding a subprocess per query. Results are
 * cached with a short TTL and must be invalidated after ref-mutating operations.
 */
export class RefsReader {
    private static readonly TTL_MS = 5000;
    private static readonly PEEL_CACHE_LIMIT = 500;

    private _branchCache: Map<string, string> | null = null;
    private _branchNames: { local: string[]; remote: string[] } | null = null;
    private _tagCache: Map<string, string> | null = null;
    private _timestamp = 0;
    /** tag-object hash -> peeled commit, or null when the loose object is not a tag. */
    private readonly _peelCache = new Map<string, string | null>();

    constructor(private readonly _getRepoPath: () => string | undefined) {}

    /** branchName (locals plain, remotes as remote/name) -> commit hash */
    readBranchRefs(): Map<string, string> {
        this._ensureBranchData();
        return new Map(this._branchCache ?? new Map());
    }

    /** Branch names split by locality; empty lists when the repository has none. */
    readBranchNames(): { local: string[]; remote: string[] } {
        this._ensureBranchData();
        const names = this._branchNames ?? { local: [], remote: [] };
        return { local: [...names.local], remote: [...names.remote] };
    }

    /** Single filesystem pass building both the merged hash map and the split name lists. */
    private _ensureBranchData(): void {
        const now = Date.now();
        if (this._branchCache && this._branchNames && (now - this._timestamp) < RefsReader.TTL_MS) {
            return;
        }

        const localMap = new Map<string, string>();
        const remoteMap = new Map<string, string>();
        try {
            const dirs = this._resolveDirs();
            this._readRefDir(path.join(dirs.refsDir, 'heads'), '', localMap);
            this._readRefDir(path.join(dirs.refsDir, 'remotes'), '', remoteMap);

            for (const [refName, hash] of this._readPackedRefs(dirs.packedRefsPath)) {
                if (refName.startsWith('refs/heads/')) {
                    localMap.set(refName.substring(11), hash);
                } else if (refName.startsWith('refs/remotes/')) {
                    remoteMap.set(refName.substring(13), hash);
                }
            }

            this._branchCache = new Map([...localMap, ...remoteMap]);
            this._branchNames = {
                local: Array.from(localMap.keys()).sort(),
                remote: Array.from(remoteMap.keys()).sort()
            };
            this._timestamp = now;
        } catch (error) {
            logger.error('[GitCharm] Failed to read branch refs:', error);
        }
    }

    /** tagName -> commit hash (annotated tags peeled to the commit they point at) */
    readTagRefs(): Map<string, string> {
        const now = Date.now();
        if (this._tagCache && (now - this._timestamp) < RefsReader.TTL_MS) {
            return new Map(this._tagCache);
        }

        const tagMap = new Map<string, string>();
        try {
            const dirs = this._resolveDirs();
            this._readRefDir(path.join(dirs.refsDir, 'tags'), '', tagMap);

            for (const [refName, hash] of this._readPackedRefs(dirs.packedRefsPath)) {
                if (refName.startsWith('refs/tags/')) {
                    tagMap.set(refName.substring(10), hash);
                }
            }

            // An annotated tag ref holds the tag-object hash, not a commit hash,
            // so it would match no row in the log until peeled.
            for (const [name, hash] of tagMap) {
                const peeled = this._peelTagObject(dirs.objectsDir, hash);
                if (peeled) {tagMap.set(name, peeled);}
            }

            this._tagCache = new Map(tagMap);
            this._timestamp = now;
        } catch (error) {
            logger.error('[GitCharm] Failed to read tag refs:', error);
        }
        return tagMap;
    }

    /**
     * Inflate a loose object and return the commit it tags, or undefined when it
     * is not a tag object. A packed tag object has no loose file to read, and
     * then the raw hash is kept — same as before peeling existed, so nothing
     * that works today regresses.
     */
    private _peelTagObject(objectsDir: string, hash: string): string | undefined {
        if (!/^[0-9a-f]{40}$/.test(hash)) {return undefined;}
        const cached = this._peelCache.get(hash);
        if (cached !== undefined) {return cached ?? undefined;}
        try {
            const file = path.join(objectsDir, hash.substring(0, 2), hash.substring(2));
            if (!fs.existsSync(file)) {return undefined;}
            const raw = zlib.inflateSync(fs.readFileSync(file)).toString('utf8');
            const peeled = peeledCommitFromTagObject(raw) ?? null;
            // A missing loose file is not cached: the object may still be packed
            // and become readable later. Everything read from the file itself is
            // immutable under this hash.
            if (this._peelCache.size >= RefsReader.PEEL_CACHE_LIMIT) {
                const oldest = this._peelCache.keys().next().value;
                if (oldest !== undefined) {this._peelCache.delete(oldest);}
            }
            this._peelCache.set(hash, peeled);
            return peeled ?? undefined;
        } catch {
            return undefined;
        }
    }

    /** Call after operations that create/rename/delete refs. */
    invalidate(): void {
        this._branchCache = null;
        this._branchNames = null;
        this._tagCache = null;
        this._timestamp = 0;
    }

    /**
     * Refs of a linked worktree live in the shared common dir, and a worktree's
     * `.git` is a pointer file rather than a directory, so a naive `.git/refs`
     * read would come up empty.
     */
    private _resolveDirs(): { refsDir: string; packedRefsPath: string; objectsDir: string } {
        const repoPath = this._getRepoPath() || '';
        const gitDir = resolveGitDir(repoPath);
        if (!gitDir) {
            const fallback = path.join(repoPath, '.git');
            return {
                refsDir: path.join(fallback, 'refs'),
                packedRefsPath: path.join(fallback, 'packed-refs'),
                objectsDir: path.join(fallback, 'objects')
            };
        }
        const refsBase = resolveCommonDir(gitDir);
        return {
            refsDir: path.join(refsBase, 'refs'),
            packedRefsPath: path.join(refsBase, 'packed-refs'),
            objectsDir: path.join(refsBase, 'objects')
        };
    }

    private _readPackedRefs(packedPath: string): Array<[string, string]> {
        const out: Array<[string, string]> = [];
        if (!fs.existsSync(packedPath)) {return out;}
        const content = fs.readFileSync(packedPath, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) {continue;}
            const parts = trimmed.split(' ');
            if (parts.length === 2 && parts[1].startsWith('refs/')) {
                out.push([parts[1], parts[0]]);
            }
        }
        return out;
    }

    private _readRefDir(dirPath: string, prefix: string, map: Map<string, string>): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
            return; // Directory might not exist, skip
        }
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                this._readRefDir(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name, map);
            } else if (entry.isFile()) {
                try {
                    const hash = fs.readFileSync(fullPath, 'utf-8').trim();
                    if (/^[0-9a-f]{40}$/.test(hash)) {
                        map.set(prefix ? `${prefix}/${entry.name}` : entry.name, hash);
                    }
                } catch {
                    // File might be locked or unreadable, skip
                }
            }
        }
    }
}
