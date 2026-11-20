/**
 * OPTIONAL reuse of VS Code's own account sign-in through the PUBLIC, STABLE
 * `vscode.authentication.getSession` API (available since VS Code 1.53; this
 * extension targets ^1.66). Host-side only — never imported by node:test.
 *
 * Three layers, and every one of them degrades to GitCharm's own credential
 * box without changing the push itself:
 *  1. `readSessionToken(host)` — silent, no UI at all, called inside the
 *     askpass request while git is waiting for a username/password;
 *  2. `signIn(host)` — interactive consent + browser OAuth, offered ONLY after
 *     a push actually failed with an authentication error;
 *  3. `idea-git.authentication.useVSCodeSession` disables the whole thing,
 *     restoring the 0.2.5 behaviour byte-for-byte.
 *
 * Only hosts with a built-in VS Code provider (currently github.com) reach
 * `getSession`. GitLab and every other host are handled by the generic
 * guidance in the command layer — no provider id is ever guessed.
 *
 * The token never leaves memory, is never logged, and is never written to git
 * config or disk. It is only returned to the git process as a Basic-auth
 * password for the matching host.
 */
import * as vscode from 'vscode';
import { resolveAuthProvider } from './authPrompt';
import { logger } from './logger';

const SETTINGS_SECTION = 'idea-git';
const SETTING_KEY = 'authentication.useVSCodeSession';

/** Explicit off-switch; any configuration failure also means "stay local". */
export function isVSCodeSessionEnabled(): boolean {
    try {
        return vscode.workspace.getConfiguration(SETTINGS_SECTION)
            .get<boolean>(SETTING_KEY, true) !== false;
    } catch {
        return false;
    }
}

/** Silent: never opens a browser or a consent dialog from inside a git prompt. */
export async function readSessionToken(host: string): Promise<string | undefined> {
    const spec = resolveAuthProvider(host);
    if (!spec || !isVSCodeSessionEnabled()) {return undefined;}
    try {
        const session = await vscode.authentication.getSession(spec.id, spec.scopes, { silent: true });
        return session?.accessToken || undefined;
    } catch {
        // Provider missing, access not yet granted, or API unavailable. Never
        // log the session or the error object (it may carry token-shaped text).
        logger.debug('[GitCharm] VS Code account session unavailable; using local credential prompt');
        return undefined;
    }
}

/** Interactive: VS Code shows its own consent modal and browser OAuth flow. */
export async function signIn(host: string): Promise<boolean> {
    const spec = resolveAuthProvider(host);
    if (!spec || !isVSCodeSessionEnabled()) {return false;}
    try {
        const session = await vscode.authentication.getSession(spec.id, spec.scopes, { createIfNone: true });
        return !!session?.accessToken;
    } catch {
        // Cancelled by the user, or no provider installed. The caller keeps the
        // original error notification and the local fallback.
        logger.debug('[GitCharm] VS Code account sign-in cancelled or unavailable');
        return false;
    }
}
