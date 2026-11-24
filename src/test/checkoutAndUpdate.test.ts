import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'node:vm';
import { setLocale, t, webviewStrings } from '../i18n';

const ROOT = path.resolve(__dirname, '..', '..');
function read(...parts: string[]): string {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

const webview = read('media', 'webview.js');
const i18nSrc = read('src', 'i18n', 'index.ts');
const messages = read('src', 'views', 'messages.ts');
const graphView = read('src', 'views', 'graphView.ts');
const branchCommands = read('src', 'commands', 'branchCommands.ts');
const gitService = read('src', 'services', 'gitService.ts');

// The three branch-row variants share one `menuItems` variable.
const menuStart = webview.indexOf('var menuItems;');
const menuEnd = webview.indexOf("\ndocument.getElementById('rows').addEventListener('click'", menuStart);
const branchMenu = webview.slice(menuStart, menuEnd);
const remoteMenu = branchMenu.slice(branchMenu.indexOf('if (isRemote) {'), branchMenu.indexOf('} else if (isCurrent) {'));
const currentMenu = branchMenu.slice(branchMenu.indexOf('} else if (isCurrent) {'), branchMenu.indexOf('} else {'));
const otherMenu = branchMenu.slice(branchMenu.indexOf('} else {'));

describe('branch menu: rename Pull to Update, add Check out and Update', () => {
    afterEach(() => setLocale('zh-cn'));

    it('renames the standalone entry to Update in both dictionaries', () => {
        assert.equal(t('menu.update'), '更新');
        assert.equal(t('menu.pull'), 'menu.pull', 'the old key must be gone');
        assert.equal(webviewStrings()['menu.update'], '更新');
        setLocale('en');
        assert.equal(t('menu.update'), 'Update');
        assert.equal(webviewStrings()['menu.pull'], undefined);
    });

    it('localizes the combined label and the update progress', () => {
        assert.equal(t('menu.checkoutAndUpdate'), '检出并更新');
        assert.equal(t('branch.updating', { name: 'feat' }), '正在更新 "feat"…');
        setLocale('en');
        assert.equal(t('menu.checkoutAndUpdate'), 'Check out and Update');
        assert.equal(t('branch.updating', { name: 'feat' }), 'Updating "feat"…');
    });

    it('defines each new key exactly once per locale and removes the stale ones', () => {
        assert.equal((i18nSrc.match(/'menu\.update'/g) || []).length, 2);
        assert.equal((i18nSrc.match(/'menu\.checkoutAndUpdate'/g) || []).length, 2);
        assert.doesNotMatch(i18nSrc, /'menu\.pull'/);
        assert.doesNotMatch(webview, /T\('menu\.pull'\)/);
    });

    it('offers the combined action only on another local branch', () => {
        const entry = "['checkoutAndUpdate', T('menu.checkoutAndUpdate')]";
        assert.ok(otherMenu.includes(entry), 'a non-current local branch must offer it');
        assert.ok(!remoteMenu.includes('checkoutAndUpdate'), 'remote rows create a tracking branch, not this');
        assert.ok(!currentMenu.includes('checkoutAndUpdate'), 'the checked-out branch has nothing to check out');
    });

    it('gates the combined action behind a remote counterpart, right after checkout', () => {
        assert.match(webview, /var canCheckoutAndUpdate = hasRemote && hasRemoteCounterpart\(branch\);/);
        const gate = otherMenu.slice(0, otherMenu.indexOf("menuItems.push(\n            ['compareBranch'"));
        assert.match(gate, /if \(canCheckoutAndUpdate\) \{/, 'a purely local branch must not offer it');
        assert.ok(gate.indexOf("['checkout'") < gate.indexOf("['checkoutAndUpdate'"));
        assert.ok(gate.indexOf("['checkoutAndUpdate'") < gate.indexOf("['update'"));
        assert.match(gate, /if \(hasRemote\) \{\s*\n\s*menuItems\.push\(\['update', T\('menu\.update'\)\], \['push', pushLabel\]\)/,
            'standalone update/push keep the repo-level remote gate');
        // The standalone update stays available on both local variants.
        assert.match(currentMenu, /\['update', T\('menu\.update'\)\]/);
        assert.match(otherMenu, /\['update', T\('menu\.update'\)\], \['push', pushLabel\]\)/);
    });

    it('matches a remote twin by exact branch name, not merely by suffix', () => {
        const source = webview.slice(webview.indexOf('function hasRemoteCounterpart('),
            webview.indexOf("document.getElementById('btree').addEventListener('contextmenu'"));
        const probe = (remote: string[], branch: string): boolean => {
            const sandbox: { state: { remote: string[] }; result?: boolean } = { state: { remote } };
            vm.runInNewContext(`${source}\nthis.result = hasRemoteCounterpart(${JSON.stringify(branch)});`, sandbox);
            return sandbox.result === true;
        };
        assert.equal(probe(['origin/main', 'fork/dev/x'], 'main'), true);
        assert.equal(probe(['origin/feature/x'], 'feature/x'), true, 'nested branch names work');
        assert.equal(probe(['origin/feature/x'], 'x'), false, 'a loose suffix would offer a branch with no remote twin');
        assert.equal(probe([], 'main'), false, 'no remote branches at all');
        assert.equal(probe(['main'], 'main'), false, 'a ref without a remote prefix is not a remote branch');
    });
});

describe('check out and update: action wiring', () => {
    it('declares the action in the webview protocol', () => {
        const types = messages.slice(messages.indexOf('export type WebviewAction'), messages.indexOf('export type WebviewToExtMessage'));
        assert.match(types, /'checkoutAndUpdate'/);
    });

    it('gates the update on a successful checkout at the host', () => {
        const from = graphView.indexOf("case 'checkoutAndUpdate'");
        assert.ok(from >= 0, 'host must handle the new action');
        const body = graphView.slice(from, graphView.indexOf("case 'push'", from));
        assert.ok(body.indexOf("'idea-git.checkoutBranch'") < body.indexOf("'idea-git.updateBranch'"), 'checkout must run first');
        assert.match(body, /executeCommand<boolean>\('idea-git\.checkoutBranch', branchNode\)/);
        assert.match(body, /if \(switched !== true\) \{return;\}/, 'never update when HEAD did not move');
        assert.match(body, /\{ \.\.\.branchNode, asCurrent: true \}/, 'ask for the pull path explicitly');
        assert.match(body, /this\._branch = message\.branch;/);
        assert.match(body, /forceReload = true;\s*\n\s*break;/, 'reload from the new branch scope');
        // The gate is the only early return; success must fall through to reload.
        assert.equal((body.match(/\{return;\}/g) || []).length, 1);
    });

    it('makes checkoutBranch report HEAD movement as a boolean on every path', () => {
        const checkout = branchCommands.slice(
            branchCommands.indexOf("registerCommand('idea-git.checkoutBranch'"),
            branchCommands.indexOf("registerCommand('idea-git.deleteBranch'")
        );
        assert.match(checkout, /Promise<boolean>/);
        assert.match(checkout, /return await vscode\.window\.withProgress/);
        assert.match(checkout, /async \(\): Promise<boolean>/);
        assert.doesNotMatch(checkout, /return;/, 'no bare early return may leak undefined');
        // Six failure exits: no branch, a worktree already holding the branch
        // (live jump offer or a missing-folder prune offer), dialog cancelled,
        // conflict resolved (but not retried), a thrown git error that names a
        // worktree, and a thrown git error without one.
        assert.equal((checkout.match(/return false;/g) || []).length, 6);
        assert.match(checkout, /graphView\.refresh\(\);\s*\n\s*return true;/);
    });

    it('forwards asCurrent through the update command into the service', () => {
        const update = branchCommands.slice(
            branchCommands.indexOf("registerCommand('idea-git.updateBranch'"),
            branchCommands.indexOf("registerCommand('idea-git.commitBranch'")
        );
        assert.match(update, /branchNode\?\.asCurrent === true/);
        assert.match(update, /gitService\.updateBranch\(branchName, asCurrent\)/);
        assert.match(gitService, /async updateBranch\(branchName: string, asCurrent = false\): Promise<string>/);
    });

    it('keeps the non-current fast-forward path intact for plain Update', () => {
        const impl = gitService.slice(gitService.indexOf('async updateBranch('), gitService.indexOf('async mergeBranch('));
        assert.match(impl, /if \(asCurrent \|\| branchName === current\)/);
        assert.match(impl, /await this\.fetch\(remote\)/);
        assert.match(impl, /update-ref/);
    });
});

describe('update failure: guide binding an upstream for a local-only branch', () => {
    afterEach(() => setLocale('zh-cn'));

    it('runs the guidance only after the existing handlers had their turn', () => {
        const update = branchCommands.slice(
            branchCommands.indexOf("registerCommand('idea-git.updateBranch'"),
            branchCommands.indexOf("registerCommand('idea-git.commitBranch'")
        );
        const guided = update.indexOf('promptUpstreamBinding(branchName, asCurrent)');
        const conflict = update.indexOf('if (isPullConflict)');
        const unified = update.indexOf('await tryHandleConflict(');
        assert.ok(conflict >= 0 && unified >= 0, 'conflict handling must stay in place');
        assert.ok(unified < guided, 'guidance is the last resort, after conflict handlers');
        assert.match(update, /if \(!guided\) \{\s*\n\s*showNetworkError\(t\('branch\.updateFailed'/,
            'a branch that already has an upstream keeps the plain error report');
        assert.ok(update.indexOf('tryHandleEmptyCommitStop') < guided,
            'the empty-commit advice stays ahead of the guidance');
    });

    it('binds a picked remote branch and retries the update once', () => {
        const fn = branchCommands.slice(
            branchCommands.indexOf('const promptUpstreamBinding'),
            branchCommands.indexOf('ctx.subscriptions.push(')
        );
        assert.match(fn, /const upstream = await gitService\.getUpstream\(branchName\)\.catch\(\(\) => undefined\);/);
        assert.match(fn, /if \(upstream\) \{return false;\}/, 'a tracked branch is never offered guidance');
        assert.match(fn, /gitService\.setUpstreamBranch\(branchName, picked\)/, 'binding must go through the service');
        const bindAt = fn.indexOf('setUpstreamBranch');
        const retryAt = fn.indexOf('gitService.updateBranch(branchName, asCurrent)', bindAt);
        assert.ok(retryAt > bindAt, 'the retry runs only after a successful binding');
        assert.match(fn, /showErrorMessage\(t\('branch\.upstreamBindFailed'/, 'a failed binding is reported, not retried');
        // One retry: the retry's own catch reports plainly instead of recursing.
        const retryBlock = fn.slice(retryAt);
        assert.doesNotMatch(retryBlock, /promptUpstreamBinding/);
        assert.match(retryBlock, /showNetworkError\(t\('branch\.updateFailed'/);
    });

    it('points a repo without any remote branch at push instead of a picker', () => {
        const fn = branchCommands.slice(
            branchCommands.indexOf('const promptUpstreamBinding'),
            branchCommands.indexOf('ctx.subscriptions.push(')
        );
        assert.match(fn, /const remotes = gitService\.getRemoteNames\(\);/);
        assert.match(fn, /remotes\.length === 0 \|\| remoteBranches\.length === 0/,
            'no remote, or remotes with nothing fetched: both mean nothing to bind');
        const noRemote = fn.slice(fn.indexOf('if (remotes.length === 0 || remoteBranches.length === 0)'), fn.indexOf('const counterpart'));
        assert.match(noRemote, /showDialog\(/, 'the no-remote case explains itself in a dialog');
        assert.match(noRemote, /'idea-git\.pushBranch'/, 'push is offered as the remedy');
        assert.doesNotMatch(noRemote, /showQuickPick/);
    });

    it('puts the same-name twin first so Enter picks the expected ref', () => {
        const fn = branchCommands.slice(
            branchCommands.indexOf('const promptUpstreamBinding'),
            branchCommands.indexOf('ctx.subscriptions.push(')
        );
        assert.match(fn, /const counterpart = matchRemoteBranch\(remoteBranches, branchName\);/);
        assert.match(fn, /const ordered = counterpart\s*\n\s*\? \[counterpart\.ref, \.\.\.remoteBranches\.filter\(ref => ref !== counterpart\.ref\)\]/);
        assert.match(fn, /showQuickPick\(ordered/);
        assert.match(fn, /if \(!picked\) \{return true;\}/, 'cancelling the picker ends quietly');
    });

    it('binds through a hardened service method, not a raw git call', () => {
        const impl = gitService.slice(
            gitService.indexOf('async setUpstreamBranch('),
            gitService.indexOf('async mergeBranch(')
        );
        assert.match(impl, /assertRef\(branchName\);/);
        assert.match(impl, /assertRef\(remoteRef, t\('label\.remote'\)\)/);
        assert.match(impl, /this\._execMutate\(\['branch', `--set-upstream-to=\$\{remoteRef\}`/, 
            'the mutate path keeps the self-write suppression window');
    });

    it('localizes the new guidance keys in both dictionaries', () => {
        assert.equal(t('branch.upstreamMissingNoRemote', { name: 'feat' }),
            '本地分支 "feat" 尚未推送到任何远程分支，无法更新。可先上传（推送）该分支，之后即可正常更新。');
        assert.equal(t('branch.upstreamPickPlaceholder', { name: 'feat' }),
            '选择要与 "feat" 绑定的远程分支');
        assert.equal(t('branch.upstreamBindFailed', { error: 'x' }), '绑定远程分支失败: x');
        setLocale('en');
        assert.equal(t('branch.upstreamMissingNoRemote', { name: 'feat' }),
            'Local branch "feat" has not been pushed to any remote branch, so it cannot be updated. Upload (push) the branch first, then update will work.');
        assert.equal(t('branch.upstreamPickPlaceholder', { name: 'feat' }),
            'Pick the remote branch to bind to "feat"');
        for (const key of ['branch.upstreamMissingPush', 'branch.upstreamBindFailed']) {
            assert.equal((i18nSrc.match(new RegExp(`'${key}'`, 'g')) || []).length, 2,
                `${key} must exist once per locale`);
        }
    });
});
