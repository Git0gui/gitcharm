import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

/**
 * Reads branch/tag -> commit-hash mappings straight from the .git filesystem
 * (loose refs + packed-refs), avoiding a subprocess per query. Results are
 * cached with a short TTL and must be invalidated after ref-mutating operations.
 */
export class RefsReader {
    private static readonly TTL_MS = 5000;

    private _branchCache: Map<string, string> | null = null;
    private _branchNames: { local: string[]; remote: string[] } | null = null;
    private _tagCache: Map<string, string> | null = null;
    private _timestamp = 0;

    constructor(private readonly _getRepoPath: () => string | undefined) {}

    /** branchName (locals plain, remotes as remote/name) -> commit hash */
    readBranchRefs(): Map<string, string> {
        this._ensureBranchData();
        return new Map(this._branchCache ?? new Map());
    }

    /** Branch names split by locality; empty lists on unusual layouts (e.g. worktrees). */
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
            const gitDir = path.join(this._getRepoPath() || '', '.git');
            this._readRefDir(path.join(gitDir, 'refs', 'heads'), '', localMap);
            this._readRefDir(path.join(gitDir, 'refs', 'remotes'), '', remoteMap);

            for (const [refName, hash] of this._readPackedRefs(gitDir)) {
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

    /** tagName -> commit hash */
    readTagRefs(): Map<string, string> {
        const now = Date.now();
        if (this._tagCache && (now - this._timestamp) < RefsReader.TTL_MS) {
            return new Map(this._tagCache);
        }

        const tagMap = new Map<string, string>();
        try {
            const gitDir = path.join(this._getRepoPath() || '', '.git');
            this._readRefDir(path.join(gitDir, 'refs', 'tags'), '', tagMap);

            for (const [refName, hash] of this._readPackedRefs(gitDir)) {
                if (refName.startsWith('refs/tags/')) {
                    tagMap.set(refName.substring(10), hash);
                }
            }

            this._tagCache = new Map(tagMap);
            this._timestamp = now;
        } catch (error) {
            logger.error('[GitCharm] Failed to read tag refs:', error);
        }
        return tagMap;
    }

    /** Call after operations that create/rename/delete refs. */
    invalidate(): void {
        this._branchCache = null;
        this._branchNames = null;
        this._tagCache = null;
        this._timestamp = 0;
    }

    private _readPackedRefs(gitDir: string): Array<[string, string]> {
        const packedPath = path.join(gitDir, 'packed-refs');
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
