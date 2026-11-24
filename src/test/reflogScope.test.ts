import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { setLocale, t } from '../i18n';

/**
 * The reflog dialog answers two questions — "what moved this branch" and "what
 * moved HEAD" — and the toggle between them is a round trip, not a second
 * dialog. These pin the parts that are easy to regress: the message belongs to
 * the command switch (it carries a scope, not an action), a cancelled read must
 * undim the rows it left behind, and an empty scope is an answer shown in place
 * rather than a reason to close the window the user is looking at.
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');
const webview = fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'src', 'views', 'messages.ts'), 'utf8');

describe('reflog scope toggle', () => {
    it('is a command-level message carrying a scope', () => {
        assert.ok(
            /\| \{ command: 'reflogScope'; scope: string \}/.test(messages),
            'the toggle must be a discriminated-union member of its own, not an action string'
        );
        const commandAt = source.indexOf('switch (message.command)');
        const actionAt = source.indexOf('switch (message.action)');
        const caseAt = source.indexOf("case 'reflogScope':");
        assert.ok(commandAt >= 0 && actionAt > commandAt && caseAt > commandAt, 'both switches and the case must exist');
        assert.ok(
            caseAt < actionAt,
            "the case reads message.scope, which only exists on the command union — inside the action switch it is a compile error and a dead toggle"
        );
    });

    it('reads through the cancellable query path and reports cancellation', () => {
        const handler = source.match(/case 'reflogScope': \{[\s\S]*?\n {16}\}/);
        assert.ok(handler, 'the reflogScope handler must exist');
        assert.ok(
            /_withCancellableGitQuery\(/.test(handler[0]),
            'a reflog read is a user-initiated read-only query: it must be cancellable like the rest'
        );
        assert.ok(
            /kind: 'reflog', scope/.test(handler[0]),
            'on cancel the webview keeps the old rows but must undim them, which needs the scope it asked for'
        );
    });

    it('the tab asks the host instead of guessing the other scope', () => {
        const tabs = webview.match(/overlay\.querySelector\('\.reflog-tabs'\)\.addEventListener\('click'[\s\S]*?\n {4}\}\);/);
        assert.ok(tabs, 'the tab strip must have one delegated click handler');
        assert.ok(
            /reflogState\.pending = target;[\s\S]*?command: 'reflogScope', scope: target/.test(tabs[0]),
            'the pending scope is what lets a cancelled read undim only its own request'
        );
    });

    it('an empty scope answers in place and keeps the dialog', () => {
        const fill = webview.match(/function fillReflogDialog\(overlay, scope, entries\) \{[\s\S]*?\n\}/);
        assert.ok(fill, 'fillReflogDialog must exist');
        assert.ok(
            /entries\.length === 0[\s\S]*?reflog-empty/.test(fill[0]),
            'the dialog is already on screen: closing it on an empty scope would look like the toggle dismissed the window'
        );
        assert.ok(
            /classList\.remove\('reflog-busy'\)/.test(fill[0]),
            'the answer arriving is what undims the rows'
        );
        const open = webview.match(/function showReflogDialog\(scope, entries\) \{[\s\S]*?\n {4}\}/);
        assert.ok(open, 'showReflogDialog must exist');
        assert.ok(
            /getElementById\('reflog-dialog'\)[\s\S]*?fillReflogDialog\(existing, scope, entries\)/.test(open[0]),
            'the shell survives a scope switch: rebuilding it would throw away the width the user dragged out'
        );
    });

    it('a cancelled read undims only the request it cancelled', () => {
        const cancelled = webview.match(/m\.kind === 'reflog'[\s\S]*?\n {8}\} else \{/);
        assert.ok(cancelled, 'queryCancelled must know the reflog kind');
        assert.ok(
            /reflogState\.pending === m\.scope/.test(cancelled[0]),
            'rapid tab clicks queue two reads; the first cancellation must not undim the second'
        );
    });
});

describe('the branch tab is the selection, not the checkout', () => {
    afterEach(() => setLocale('zh-cn'));

    it('both entry points ask for the branch the commit list is scoped to', () => {
        const scope = webview.match(/function reflogBranchScope\(\) \{[\s\S]*?\n\}/);
        assert.ok(scope, 'reflogBranchScope must exist');
        assert.match(
            scope[0],
            /state\.selectedBranch \|\| state\.current/,
            'the checked-out branch is only the fallback for the all-branches view'
        );
        const toolbar = webview.match(/getElementById\('btn-reflog'\)\.addEventListener\('click'[\s\S]*?\n\}\);/);
        assert.ok(toolbar, 'the toolbar button must have a click handler');
        assert.match(toolbar[0], /action: 'reflog', branch: state\.selectedBranch \|\| ''/);
    });

    it('the label says which branch it means, in both languages', () => {
        assert.equal(t('reflog.tabBranch'), '选中分支');
        assert.match(t('reflog.tabBranchHint'), /提交列表所选分支/);
        setLocale('en');
        assert.equal(t('reflog.tabBranch'), 'Selected branch');
        assert.match(t('reflog.tabBranchHint'), /selected in the list/);
    });
});

describe('reflog failure is not emptiness', () => {
    const gitService = fs.readFileSync(path.join(ROOT, 'src', 'services', 'gitService.ts'), 'utf8');
    const reflogCommands = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'reflogCommands.ts'), 'utf8');

    it('a failed read returns null, an empty reflog returns []', () => {
        assert.match(gitService, /async getReflog\(rev\?: string, limit = 500\): Promise<ReflogEntry\[\] \| null>/,
            'the failure is typed apart from the empty list');
        const impl = gitService.slice(gitService.indexOf('async getReflog('), gitService.indexOf('async getReflogImpact('));
        assert.match(impl, /return null;/);
        assert.match(impl, /'--format=%gd%x00%H%x00%gs%x00%aI', '-n', String\(limit\)/);
        assert.match(impl, /limit = 500/,
            'log -g walks the same file either way: a deeper window covers multi-round rebases for free');
    });

    it('the command layer reports a failed read instead of showing an empty dialog', () => {
        assert.match(reflogCommands, /entries === null[\s\S]*?showErrorMessage\(t\('reflog\.failed'\)/);
        assert.match(reflogCommands, /entries\.length === 0[\s\S]*?showInformationMessage\(t\('reflog\.empty'\)/,
            'a genuinely empty reflog keeps its information-level answer');
    });

    it('a failed scope switch says "failed" in place, keeping the dialog open', () => {
        const fill = webview.match(/function fillReflogDialog\(overlay, scope, entries\) \{[\s\S]*?\n\}/);
        assert.ok(fill, 'fillReflogDialog must exist');
        assert.ok(
            fill[0].indexOf('entries === null') < fill[0].indexOf('entries.length === 0'),
            'the null check must come first: null has no length'
        );
        assert.match(fill[0], /reflog\.failedScope/);
        const receive = webview.match(/m\.command === 'showReflog'[\s\S]*?\n {8}\} else if/);
        assert.ok(receive, 'the showReflog receive must exist');
        assert.match(receive[0], /m\.entries === null \? null : /,
            'the webview must forward null instead of coercing it to []');
    });
});

describe('reflog row: see the commits a step affected', () => {
    const gitService = fs.readFileSync(path.join(ROOT, 'src', 'services', 'gitService.ts'), 'utf8');

    it('is an action with both endpoints on the message', () => {
        assert.match(messages, /\| 'reflogLost'/, 'the action must be typed');
        assert.match(messages, /\/\*\* The "before" end of a reflog step \(`reflogLost`\); `hash` is the "after" end\. \*\/\s*\n\s*oldHash\?: string;/);
    });

    it('the menu offers it only on rewrite steps that have a before-position', () => {
        const menu = webview.match(/scroll\.addEventListener\('contextmenu'[\s\S]*?\n {4}\}\);/);
        assert.ok(menu, 'the reflog row context menu must exist');
        assert.match(menu[0], /entry\.oldHash && \(/, 'no oldHash (the oldest row), no entry');
        assert.match(menu[0], /entry\.action === 'reset'|entry\.action\.indexOf\('rebase'\) === 0|entry\.action === 'cherry-pick'/,
            'checkout rows observe, they do not rewrite — no entry for them');
        assert.match(menu[0], /items\.push\(\['reflogLost', T\('reflog\.menu\.affected'\)\]\)/);
        const send = menu[0].slice(menu[0].indexOf("action === 'reflogLost'"));
        assert.match(send, /action: 'reflogLost', hash: hash, oldHash: entry\.oldHash/);
        assert.ok(send.indexOf('overlay.remove()') > send.indexOf('return;'),
            'the reflog dialog stays under the compare dialog: a failed host query still leaves the user their rows');
    });

    it('rows carry their index so the menu recovers the entry, not a hash twin', () => {
        assert.match(webview, /data-idx="' \+ idx \+ '"/);
        const fill = webview.match(/visible\.map\(reflogRow\)/);
        assert.ok(fill, 'slice.map passes (entry, index) already');
        assert.match(webview, /reflogRow\(entry, reflogState\.visibleCount \+ i\)/,
            'load-more batches offset their indices into reflogState.entries');
    });

    it('the host reads the range and reuses the compare dialog with a real title', () => {
        const handler = source.match(/case 'reflogLost': \{[\s\S]*?\n {16}\}/);
        assert.ok(handler, 'the reflogLost handler must exist');
        assert.match(handler[0], /getReflogImpact\(message\.oldHash, message\.hash\)/,
            'before..after, taken from the message, never re-derived');
        assert.match(handler[0], /showCompareDialog\(/);
        assert.match(handler[0], /reflog\.impactTitle/);
        assert.match(handler[0], /showInformationMessage\(t\('reflog\.impactEmpty'\)\)/);
        assert.match(handler[0], /showErrorMessage\(t\('reflog\.impactFailed'/);
        assert.match(gitService, /async getReflogImpact\(oldHash: string, newHash: string\): Promise<GitCommit\[\]>/);
        const impl = gitService.slice(gitService.indexOf('async getReflogImpact('), gitService.indexOf('async getReflogImpact(') + 600);
        assert.match(impl, /assertHash\(oldHash\)/, 'both endpoints are hashes, checked as hashes');
        assert.match(impl, /`\$\{oldHash\}\.\.\$\{newHash\}`/);
    });

    it('the compare dialog accepts a custom title instead of raw hex', () => {
        const dialog = webview.match(/function showCompareDialog\(branchName, currentBranch, commits, title\) \{[\s\S]*?\n\}/);
        assert.ok(dialog, 'showCompareDialog must take a title');
        assert.match(dialog[0], /var headerText = title\s*\n\s*\? esc\(title\)\s*\n\s*: T\('compare\.title'\)/);
        assert.match(webview, /showCompareDialog\(m\.branchName, m\.currentBranch, m\.commits \|\| \[\], m\.title\)/);
        assert.match(messages, /title\?: string;/);
    });

    it('localizes the new keys in both dictionaries', () => {
        assert.equal(t('reflog.menu.affected'), '查看这一步影响的提交');
        assert.equal(t('reflog.impactTitle', { n: 3 }), '这一步影响的提交（3 个）');
        assert.equal(t('reflog.failed'), '读取操作记录失败（详见日志）');
        setLocale('en');
        assert.equal(t('reflog.menu.affected'), 'See the commits this step affected');
        assert.equal(t('reflog.impactTitle', { n: 3 }), 'Commits affected by this step (3)');
        for (const key of ['reflog.menu.affected', 'reflog.impactTitle', 'reflog.impactEmpty', 'reflog.impactFailed', 'reflog.failedScope']) {
            const i18nSrc = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'index.ts'), 'utf8');
            assert.equal((i18nSrc.match(new RegExp(`'${key}'`, 'g')) || []).length, 2,
                `${key} must exist once per locale`);
        }
    });
});