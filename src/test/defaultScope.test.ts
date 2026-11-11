import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A panel with no remembered choice opens on the checked-out branch, not on every
 * ref. "All branches" stays available — it is a click, and the view snapshot
 * records that click as an empty branch name, which must not be mistaken for
 * "never chose". These pin the resolution itself and the two things that make it
 * visible: the prefetch warming the same scope, and the tree highlighting it.
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const view = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');
const service = fs.readFileSync(path.join(ROOT, 'src', 'services', 'gitService.ts'), 'utf8');
const webview = fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'src', 'views', 'messages.ts'), 'utf8');

function body(source: string, signature: string): string {
    const match = source.match(new RegExp(`${signature}[\\s\\S]*?\\n {4}\\}(?:\\r?\\n)`));
    assert.ok(match, `${signature} must exist`);
    return match[0];
}

describe('the default scope is the checked-out branch', () => {
    it('reads HEAD off the disk, synchronously and without a subprocess', () => {
        const read = body(service, 'readCurrentBranch\\(\\): string \\{');
        assert.doesNotMatch(
            read,
            /executeGitArgs|await/,
            'the scope has to be settled before the first query starts; a spawn or an await here puts it on the paint path'
        );
        assert.match(read, /parseSymbolicRef/);
        assert.match(read, /rebase-merge/, 'during a rebase HEAD is detached and the branch is parked in head-name');

        const current = body(service, 'async getCurrentBranch\\(\\): Promise<string> \\{');
        assert.match(current, /return this\.readCurrentBranch\(\)/, 'one reading of HEAD, not two that can drift');
        assert.match(current, /symbolic-ref/, 'the plumbing fallback for an unreadable layout stays');
    });

    it('applies only when there is no snapshot to honour', () => {
        const scope = body(view, 'private _defaultBranchScope\\(\\): string \\| undefined \\{');
        assert.match(scope, /readCurrentBranch\(\) \|\| undefined/);

        const resolve = body(view, 'async resolveWebviewView\\(webviewView');
        assert.match(resolve, /if \(savedView\?\.branch\) \{/);
        assert.match(
            resolve,
            /else if \(!savedView\) \{\s*this\._branch = this\._defaultBranchScope\(\);/,
            "a snapshot whose branch is '' is the user's all-branches click; defaulting over it would undo their choice on every reopen"
        );
    });

    it('settles before the prefetch starts its page, in the same synchronous turn', () => {
        assert.match(
            view,
            /private _runStartupPrefetch\(\): void \{/,
            'an async prefetch would install its task after an await, and the first open would warm a second scope in that gap'
        );
        const entry = body(view, 'private _runStartupPrefetch\\(\\): void \\{');
        const settled = entry.indexOf('this._defaultBranchScope()');
        const started = entry.indexOf('this._firstPageRows(');
        assert.ok(settled >= 0 && started > settled, 'the warmed page must be the page the panel shows');
        assert.match(entry, /else if \(!saved\) \{/);
    });

    it('a switched repository opens on its own current branch', () => {
        const switched = body(view, 'async switchRepository\\(rootPath: string\\)');
        const selected = switched.indexOf('this._gitService.selectRepository(rootPath)');
        const scoped = switched.indexOf('this._branch = this._defaultBranchScope()');
        assert.ok(selected >= 0 && scoped > selected, 'HEAD must be read after the root moved, not before');
    });

    it('clicking "all branches" is still an explicit scope of its own', () => {
        const pick = view.match(/case 'selectBranch': \{[\s\S]*?\n {16}\}/);
        assert.ok(pick, 'the selectBranch handler must exist');
        assert.match(pick[0], /const branch = message\.branch \|\| undefined/);
        assert.doesNotMatch(
            pick[0],
            /_defaultBranchScope/,
            'the empty name is the choice: re-defaulting here would make "all branches" unselectable'
        );
    });
});

describe('the tree highlights the scope the list is on', () => {
    it('setBranches carries it — a first open sends no setData', () => {
        assert.match(messages, /command: 'setBranches';[\s\S]*?selectedBranch\?: string;/);
        const post = body(view, 'private _postBranchList\\(details: BranchDetails\\): void \\{');
        assert.match(post, /selectedBranch: this\._branch \|\| ''/);
    });

    it('the webview mirrors the host value, empty string included', () => {
        const handler = webview.match(/m\.command === 'setBranches'\) \{[\s\S]*?\n {4}\} else if/);
        assert.ok(handler, 'the setBranches handler must exist');
        assert.match(
            handler[0],
            /m\.selectedBranch !== undefined[\s\S]*?state\.selectedBranch = m\.selectedBranch/,
            "'' means every branch and must clear the highlight; testing truthiness would leave the old row selected"
        );
    });
});