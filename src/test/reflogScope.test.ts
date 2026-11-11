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