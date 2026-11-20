/**
 * Pure helpers for the HTTPS credential (askpass) path.
 *
 * No `vscode` import: node:test loads this directly (AGENTS.md §5).
 * Host mapping is deliberately conservative — an unknown host must never be
 * answered with somebody else's token.
 */
import { URL } from 'url';

export type CredentialPromptKind = 'https-username' | 'https-password' | 'other';

export interface CredentialPromptInfo {
    readonly kind: CredentialPromptKind;
    /** Lower-cased hostname (no userinfo, no port); '' when not an HTTPS prompt. */
    readonly host: string;
    /** Lower-cased host[:port], used as the cache key for one credential pair. */
    readonly authority: string;
}

const OTHER: CredentialPromptInfo = { kind: 'other', host: '', authority: '' };

/** git words HTTPS prompts as `Username for 'https://host':` / `Password for '…':`. */
export function parseCredentialPrompt(prompt: string): CredentialPromptInfo {
    // SSH passphrase / host authenticity prompts also contain quoted text.
    if (/passphrase|authenticity|fingerprint/i.test(prompt)) {return OTHER;}
    const match = /^(username|password)\s+for\s+'([^']+)'/i.exec(prompt.trim());
    if (!match) {return OTHER;}
    let parsed: URL;
    try {
        parsed = new URL(match[2]);
    } catch {
        return OTHER;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {return OTHER;}
    return {
        kind: match[1].toLowerCase() === 'username' ? 'https-username' : 'https-password',
        host: parsed.hostname.toLowerCase(),
        authority: parsed.host.toLowerCase()
    };
}

export interface AuthProviderSpec {
    /** VS Code authentication provider id, passed to `getSession(id, scopes, …)`. */
    readonly id: string;
    readonly scopes: readonly string[];
    /** Human-readable name used in the sign-in prompt. */
    readonly label: string;
}

/**
 * Which of VS Code's BUILT-IN authentication providers can serve this host.
 *
 * The VS Code API reference lists only `github`, `microsoft`,
 * `github-enterprise` and `microsoft-sovereign-cloud`. There is NO built-in
 * GitLab / Gitee provider, and `vscode.authentication` has no API to enumerate
 * providers registered by third-party extensions, so guessing an id (e.g.
 * `gitlab`) would be unreliable. GitHub Enterprise also needs its own URI
 * configuration and cannot be recognised from a hostname alone.
 *
 * Therefore only github.com gets an automatic sign-in. Every other host —
 * GitLab.com, self-hosted GitLab, Gitee, GHE, anything self-hosted — returns
 * `undefined` and degrades to the generic PAT / credential-helper guidance.
 */
export function resolveAuthProvider(host: string): AuthProviderSpec | undefined {
    if (host === 'github.com') {
        return { id: 'github', scopes: ['repo'], label: 'GitHub' };
    }
    return undefined;
}

/** Username GitHub accepts for token-based Basic auth. */
export const GITHUB_TOKEN_USERNAME = 'x-access-token';

/** The runnable fallback we offer to copy when no VS Code session is available. */
export function credentialHelperCommand(platform: string = process.platform): string {
    if (platform === 'win32') {return 'git config --global credential.helper manager';}
    if (platform === 'darwin') {return 'git config --global credential.helper osxkeychain';}
    return 'git config --global credential.helper libsecret';
}
