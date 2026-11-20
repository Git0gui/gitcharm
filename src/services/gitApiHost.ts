/**
 * Thin runtime host for the OPTIONAL built-in Git API backend.
 *
 * This is the ONLY production file allowed to name the built-in extension or
 * call `getExtension` / `getAPI` (guarded by `src/test/noVscodeGit.test.ts`).
 * Everything else is pure, host-free logic in `gitApiProbe.ts` /
 * `gitApiBackend.ts` / self-contained types in `gitApiTypes.ts`.
 *
 * Design decisions:
 *  - NO dependency is declared anywhere: no `extensionDependencies`, no
 *    `import 'vscode.git'`, no npm package, no activation event. The extension
 *    is discovered through the generic `vscode.extensions.getExtension` host
 *    API; if it is absent or disabled, `createGitApiBackend` returns undefined
 *    and GitCharm's own implementation runs unchanged.
 *  - NO eager `activate()`. Historically that triggered a multi-spawn
 *    repository scan on cold start. We only adopt the API when VS Code has
 *    already activated the built-in extension (`ext.isActive === true`).
 *    `watchGitApiAvailability` then picks it up automatically through the
 *    public enablement / open-repository events — so availability is detected
 *    at runtime without GitCharm ever paying for that scan.
 *  - ONLY `getAPI(1)`. The upstream declaration is `getAPI(version: 1): API`;
 *    there is no stable v2, and no proposed / experimental / internal member
 *    is referenced. `register*` extension points are never used.
 */
import * as vscode from 'vscode';
import type { GitApiExtension, GitApiV1 } from './gitApiTypes';
import { GitApiBackend } from './gitApiBackend';

/** The built-in Git extension id. Kept here so the guard stays a one-file whitelist. */
const GIT_EXTENSION_ID = 'vscode.git';

/** The only stable, publicly documented API version. */
const GIT_API_VERSION = 1 as const;

/** Shape of a VS Code event subscription; duck-typed to avoid referencing
 *  `vscode.Event` generics for optional events. */
interface EventSubscription {
    (listener: () => void): { dispose(): void };
}

/**
 * Detect whether the public Git API can serve the current repository.
 * Returns `undefined` on every unavailable / malformed / not-yet-ready state.
 */
export function createGitApiBackend(repoPath: string | undefined): GitApiBackend | undefined {
    if (!repoPath) {return undefined;}
    try {
        const extension = vscode.extensions.getExtension<GitApiExtension>(GIT_EXTENSION_ID);
        // Deliberately do NOT call extension.activate(): see header comment.
        if (!extension || !extension.isActive) {return undefined;}
        const exports = extension.exports;
        if (!exports || exports.enabled !== true || typeof exports.getAPI !== 'function') {return undefined;}

        let api: GitApiV1 | undefined;
        try {
            api = exports.getAPI(GIT_API_VERSION);
        } catch {
            return undefined;
        }
        return GitApiBackend.create(api, repoPath);
    } catch {
        return undefined;
    }
}

/**
 * Re-evaluate availability whenever the built-in extension becomes enabled or
 * opens/closes a repository. The callback receives the fresh backend (or
 * `undefined` = full local fallback). Never throws; the returned Disposable
 * releases all subscriptions.
 */
export function watchGitApiAvailability(
    repoPath: () => string | undefined,
    onChange: (backend: GitApiBackend | undefined) => void
): vscode.Disposable {
    const subscriptions: Array<{ dispose(): void }> = [];
    const refresh = (): void => {
        try {
            onChange(createGitApiBackend(repoPath()));
        } catch {
            onChange(undefined);
        }
    };
    const subscribe = (event: unknown): void => {
        if (typeof event !== 'function') {return;}
        try {
            const disposable = (event as EventSubscription)(refresh);
            if (disposable && typeof disposable.dispose === 'function') {
                subscriptions.push(disposable);
            }
        } catch { /* optional event unavailable on this VS Code version */ }
    };

    try {
        const extension = vscode.extensions.getExtension<GitApiExtension>(GIT_EXTENSION_ID);
        subscribe(extension?.exports?.onDidChangeEnablement);
        let api: GitApiV1 | undefined;
        try {
            if (extension?.isActive && extension.exports?.enabled === true) {
                api = extension.exports.getAPI(GIT_API_VERSION);
            }
        } catch { /* not ready yet */ }
        subscribe(api?.onDidOpenRepository);
        subscribe(api?.onDidCloseRepository);
    } catch { /* no built-in extension at all */ }

    return new vscode.Disposable(() => {
        for (const subscription of subscriptions) {
            try { subscription.dispose(); } catch { /* already disposed */ }
        }
        subscriptions.length = 0;
    });
}
