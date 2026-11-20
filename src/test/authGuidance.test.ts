import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'node:test';
import {
    parseCredentialPrompt,
    resolveAuthProvider,
    credentialHelperCommand,
    GITHUB_TOKEN_USERNAME
} from '../services/authPrompt';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('credential prompt parsing (pure)', () => {
    it('recognises HTTPS username / password prompts', () => {
        const u = parseCredentialPrompt("Username for 'https://github.com': ");
        assert.equal(u.kind, 'https-username');
        assert.equal(u.host, 'github.com');
        assert.equal(u.authority, 'github.com');
        const p = parseCredentialPrompt("Password for 'https://x-access-token@github.com': ");
        assert.equal(p.kind, 'https-password');
        assert.equal(p.host, 'github.com');
    });

    it('strips userinfo, keeps the port in the authority and lower-cases the host', () => {
        const p = parseCredentialPrompt("Password for 'https://User@GitHub.COM:8443/o/r.git': ");
        assert.equal(p.host, 'github.com');
        assert.equal(p.authority, 'github.com:8443');
    });

    it('never treats SSH or unrelated prompts as HTTPS credentials', () => {
        for (const text of [
            "Enter passphrase for key '/c/Users/me/.ssh/id_ed25519':",
            "The authenticity of host 'github.com (1.2.3.4)' can't be established.",
            '',
            'Git needs credentials',
            "Password for '/c/Users/me/.ssh/id_ed25519':"
        ]) {
            assert.equal(parseCredentialPrompt(text).kind, 'other');
        }
    });

    it('only github.com has a built-in VS Code provider; GitLab/Gitee/self-hosted degrade', () => {
        const gh = resolveAuthProvider('github.com');
        assert.equal(gh?.id, 'github');
        assert.deepEqual(gh?.scopes, ['repo']);
        for (const host of [
            'gitlab.com', 'gitee.com', 'github.com.evil.test',
            'ghe.company.com', 'git.self-hosted.local', '', 'GITHUB.COM'
        ]) {
            assert.equal(resolveAuthProvider(host), undefined, `${host} must degrade to generic guidance`);
        }
    });

    it('credential helper command is platform specific and runnable', () => {
        assert.match(credentialHelperCommand('win32'), /credential\.helper manager/);
        assert.match(credentialHelperCommand('darwin'), /credential\.helper osxkeychain/);
        assert.match(credentialHelperCommand('linux'), /credential\.helper libsecret/);
        assert.equal(GITHUB_TOKEN_USERNAME, 'x-access-token');
    });
});

describe('auth guidance is wired with a full local fallback', () => {
    it('askpass keeps the original input box as the fallback', () => {
        const code = read('src/services/askpass.ts');
        assert.match(code, /const answer = await this\._prompt\(prompt, secret\);/);
        assert.match(code, /this\._cancelled = true;/);
        assert.match(code, /res\.writeHead\(204\)/);
        assert.match(code, /resolveAuthProvider\(info\.host\)/);
        assert.match(code, /readSessionToken\(host\)/);
        // The silent path is tried BEFORE the input box, never instead of it.
        // Scope the order check to _handle: the helper it calls is defined
        // later in the file, so a whole-file indexOf would be misleading.
        const handle = code.slice(code.indexOf('private async _handle'), code.indexOf('private async _vscodeCredentials'));
        assert.match(handle, /_vscodeCredentials\(info\.authority, info\.host\)/);
        assert.ok(handle.indexOf('_vscodeCredentials(') < handle.indexOf('const answer = await this._prompt'));
    });

    it('vscodeAuth never guesses a provider id and never prompts from the askpass', () => {
        const code = read('src/services/vscodeAuth.ts');
        assert.match(code, /resolveAuthProvider\(host\)/);
        assert.match(code, /silent: true/);
        assert.match(code, /createIfNone: true/);
        assert.doesNotMatch(code, /getSession\('gitlab'|getSession\('gitee'|getSession\('github-enterprise'/);
        assert.match(code, /isVSCodeSessionEnabled\(\)/);
        assert.equal((code.match(/catch \{/g) ?? []).length >= 2, true, 'both API calls must degrade');
    });

    it('the token is never logged or persisted', () => {
        const code = read('src/services/vscodeAuth.ts') + read('src/services/askpass.ts');
        assert.doesNotMatch(code, /logger\.(debug|info|warn|error)\([^\n]*token/);
        assert.doesNotMatch(code, /writeFile|appendFile|secretStorage|globalState|credential\.helper/);
    });

    it('push failure offers generic, platform-independent actions', () => {
        const code = read('src/commands/branchCommands.ts');
        assert.match(code, /showAuthFailure\(/);
        assert.match(code, /classifyGitNetworkFailure\(rawText\)/);
        assert.match(code, /consumeCredentialCancellation\(\)/);
        assert.match(code, /remoteUrlToWebBase\(url\)/);
        assert.match(code, /hasCredentialHelper\(\)/);
        assert.match(code, /credentialHelperCommand\(\)/);
        assert.match(code, /vscode\.env\.openExternal/);
        assert.match(code, /vscode\.env\.clipboard\.writeText/);
        // A retry reuses the same target and force flag, not a fresh dialog.
        assert.match(code, /runPush\(retryTarget, force\)/);
    });

    it('the original terminal-prompt discipline is untouched', () => {
        const runner = read('src/services/gitRunner.ts');
        assert.match(runner, /GIT_TERMINAL_PROMPT: '0'/);
        const service = read('src/services/gitService.ts');
        assert.match(service, /fetchSilent/);
        assert.match(service, /GIT_TERMINAL_PROMPT: '0'/);
    });

    it('the setting is an explicit off-switch with a safe default', () => {
        const manifest = JSON.parse(read('package.json'));
        const prop = manifest.contributes.configuration.properties['idea-git.authentication.useVSCodeSession'];
        assert.equal(prop.type, 'boolean');
        assert.equal(prop.default, true);
        assert.match(prop.description, /config\.useVSCodeSession/);
        for (const nls of ['package.nls.json', 'package.nls.zh-cn.json']) {
            assert.match(read(nls), /"config\.useVSCodeSession":/);
        }
    });

    it('every new user-facing string has both zh and en entries', () => {
        const i18n = read('src/i18n/index.ts');
        for (const key of [
            'auth.signInWithVSCode', 'auth.openRemotePage', 'auth.retryOperation',
            'auth.copyHelperCommand', 'auth.commandCopied', 'auth.actionFailed',
            'auth.signInCancelled', 'auth.signInSuccess', 'auth.retrySuccess',
            'auth.retryFailed', 'auth.cancelledHint', 'auth.patHint',
            'auth.noHelperHint', 'auth.staleHelperHint'
        ]) {
            assert.equal((i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}'\\s*:`, 'g')) ?? []).length, 2,
                `${key} must exist in both dictionaries`);
        }
    });
});
