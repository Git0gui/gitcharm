import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseBranchCache, serializeBranchCache, PersistedBranches } from './branchCacheStore';
import { logger } from './logger';

const STORAGE_KEY = 'idea-git.branchCache';

/**
 * Persists the branch list via VSCode's workspaceState Memento — the same
 * mechanism Git Graph uses; no cache files are written into the workspace.
 * The payload stays a versioned, schema-validated JSON string from
 * branchCacheStore; anything invalid is dropped and rebuilt from git.
 * `current` is never persisted — it must always be queried in real time.
 */
export class PersistedBranchCache {
    constructor(
        private readonly _memento: vscode.Memento,
        private readonly _getRepoPath: () => string | undefined
    ) {
        this._migrateLegacyFile();
    }

    private _isEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('idea-git.cache');
        return config.get<boolean>('enabled', true);
    }

    /**
     * Load persisted branches if the cache is enabled, valid, and belongs to
     * the current repository. Returns undefined otherwise.
     */
    load(): PersistedBranches | undefined {
        if (!this._isEnabled()) {
            logger.debug('[GitService] Cache is disabled by configuration');
            return undefined;
        }

        const repoPath = this._getRepoPath();
        if (!repoPath) {
            logger.debug('[GitService] Repository path not resolved yet, skip cache loading');
            return undefined;
        }

        try {
            const raw = this._memento.get<string>(STORAGE_KEY);
            if (!raw) {
                return undefined;
            }

            const cached = parseBranchCache(raw);
            if (!cached) {
                logger.debug('[GitService] Persisted branch cache invalid or outdated, discarding');
                this.clear();
                return undefined;
            }

            logger.debug('[GitService] Cache check - repo match:', cached.repoPath === repoPath,
                       ', age (seconds):', Math.round((Date.now() - cached.timestamp) / 1000));

            if (cached.repoPath !== repoPath) {
                // Cache is for a different repo (workspace moved/multi-root)
                return undefined;
            }

            logger.debug('[GitService] ✓ Branch cache loaded successfully with',
                cached.branches.local.length, 'local and',
                cached.branches.remote.length, 'remote branches');
            return cached.branches;
        } catch (error) {
            logger.debug('[GitService] Failed to load branch cache:', error);
            return undefined;
        }
    }

    save(repoPath: string, branches: PersistedBranches): void {
        if (!this._isEnabled()) {return;}
        try {
            void this._memento.update(STORAGE_KEY, serializeBranchCache(repoPath, branches));
            logger.debug('[GitService] Branch cache saved to workspaceState (without current branch)');
        } catch (error) {
            logger.debug('[GitService] Failed to save branch cache:', error);
        }
    }

    clear(): void {
        void this._memento.update(STORAGE_KEY, undefined);
    }

    /**
     * One-time migration: adopt a still-valid legacy cache file written by
     * older versions (.vscode/.qoder/.idea-git-cache/branches.json), then
     * remove the file and its (now empty) cache directory.
     */
    private _migrateLegacyFile(): void {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {return;}
            const ws = workspaceFolders[0].uri.fsPath;

            for (const dir of ['.vscode', '.qoder']) {
                const file = path.join(ws, dir, '.idea-git-cache', 'branches.json');
                if (!fs.existsSync(file)) {continue;}
                try {
                    const raw = fs.readFileSync(file, 'utf-8');
                    if (this._isEnabled() && !this._memento.get(STORAGE_KEY) && parseBranchCache(raw)) {
                        void this._memento.update(STORAGE_KEY, raw);
                        logger.debug('[GitService] Migrated legacy branch cache file into workspaceState');
                    }
                    fs.unlinkSync(file);
                    fs.rmdirSync(path.dirname(file)); // only succeeds when empty
                } catch {
                    // Best effort: keep legacy file if cleanup fails
                }
            }
        } catch {
            // Best effort
        }
    }
}
