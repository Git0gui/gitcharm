import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts: string[]): string =>
    fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const webview = read('media', 'webview.js');
const css = read('media', 'webview.css');
const graphView = read('src', 'views', 'graphView.ts');
const messages = read('src', 'views', 'messages.ts');
const branchCommands = read('src', 'commands', 'branchCommands.ts');
const i18n = read('src', 'i18n', 'index.ts');

describe('push dialog', () => {
    it('confirms every force push with stable action keys', () => {
        // Force-push is no longer confirmed only for protected branches.
        // The dialog result is captured once and reused for the confirmation
        // and for the replayable network leg (auth-failure retry).
        assert.match(branchCommands, /force = result\.force === true;/);
        assert.match(branchCommands, /if \(force\) \{[\s\S]*?\['force', 'cancel'\]/);
        assert.doesNotMatch(branchCommands, /result\.force === true && matchesBranchPattern/);
        assert.match(branchCommands, /proceed !== 'force' && proceed !== t\('push\.forceAnyway'\)/);
        assert.match(i18n, /'push\.forceConfirm':/);
        assert.equal((i18n.match(/'push\.forceConfirm':/g) || []).length, 2, 'zh/en dictionaries must both define the force-push warning');

        // The webview answers with data-action keys, never with localized labels.
        assert.match(messages, /\{ command: 'showDialog'; message: string; actions: string\[\]; type\?: string; actionKeys\?: string\[\] \}/);
        assert.match(graphView, /showDialog\(message: string, actions: string\[\], type: [^)]*actionKeys\?: string\[\]\)/);
        assert.match(graphView, /command: 'showDialog', message, actions, type, actionKeys/);
        assert.match(webview, /\}, m\.actionKeys\)/);
        assert.match(webview, /var action = actionKeys && actionKeys\[i\] \? actionKeys\[i\] : a;/);
    });

    it('gives commit messages more room than files and detail', () => {
        const rules = css.slice(css.indexOf('#push-dialog .push-commits-list'));
        assert.match(rules, /#push-dialog \.push-commits-list \{ width: 560px; max-width: 62%; \}/);
        assert.match(rules, /#push-dialog \.push-files-section \{ flex: 1 1 66%; \}/);
        assert.match(rules, /#push-dialog \.push-detail-section \{ flex: 0 1 34%; \}/);
        // The shared defaults stay intact for compare/reflog/file-history dialogs.
        assert.match(css, /\.push-commits-list \{[\s\S]*?width: 440px;[\s\S]*?max-width: 56%;/);
    });
});
