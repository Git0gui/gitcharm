import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const view = read('src/views/graphView.ts');
const service = read('src/services/gitService.ts');
const commands = read('src/commands/branchCommands.ts');
const worktreeCommands = read('src/commands/worktreeCommands.ts');
const webview = read('media/webview.js');

function slice(src: string, start: string, end: string): string {
    const from = src.indexOf(start);
    const to = from < 0 ? -1 : src.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `slice not found: ${start} .. ${end}`);
    return src.substring(from, to);
}

describe('external worktree detection stays off the hot paths', () => {
    it('the poll compares the file-based stamp and only then posts', () => {
        const poll = slice(view, 'private async _checkBranchNow(', 'private _branchExists(');
        assert.match(poll, /getWorktreeSignature\(\) !== this\._lastWorktreeSignature/);
        assert.match(poll, /void this\._postWorktrees\(\)/);
    });

    it('posting the list records the stamp used for the comparison', () => {
        const post = slice(view, 'private async _postWorktrees()', 'private _branchMarks(');
        assert.match(post, /_lastWorktreeSignature = this\._gitService\.getWorktreeSignature\(\)/);
    });

    it('startup still loads worktrees after the two primary sections', () => {
        const refresh = slice(view, 'async refreshRepoState(', 'private _dropVanishedBranch(');
        assert.match(refresh, /\.then\(\(\) => this\._postWorktrees\(\)\)/);
    });
});

describe('checkout occupancy handling', () => {
    const checkout = slice(commands, "registerCommand('idea-git.checkoutBranch'", "registerCommand('idea-git.deleteBranch'");

    it('pre-checks only when a linked worktree exists, so plain repositories add no spawn', () => {
        const guard = checkout.indexOf('if (gitService.hasLinkedWorktrees()) {');
        assert.ok(guard > 0, 'the occupancy query must sit behind the pure file check');
        assert.ok(checkout.indexOf('getBranchWorktreePath(localName)') > guard);
        // The whole pre-check runs before the progress-wrapped checkout.
        assert.ok(guard < checkout.indexOf('return await vscode.window.withProgress({'));
    });

    it('offers a jump for a live worktree and a prune for a deleted one', () => {
        assert.match(checkout, /promptWorktreeOccupied\(localName, occupiedPath\)/);
        assert.match(checkout, /fs\.existsSync\(occupiedPath\)/);
        assert.match(checkout, /'idea-git\.pruneWorktree'/);
    });

    it('falls back to the same offer when git itself refuses', () => {
        assert.match(checkout, /extractWorktreePath\(combineErrorText\(error\)\)/);
        assert.match(commands, /t\('checkout\.worktreeOccupied'/);
    });

    it('check out and update reuses the gated checkout command', () => {
        const combined = slice(view, "case 'checkoutAndUpdate':", "case '");
        assert.match(combined, /'idea-git\.checkoutBranch'/);
        assert.match(combined, /switched !== true/);
    });
});

describe('missing worktree rows are shown and prunable', () => {
    it('the section no longer hides prunable entries', () => {
        const section = slice(webview, 'function worktreeSection()', 'var head =');
        assert.ok(!section.includes('filter('), 'missing worktrees must stay listed');
    });

    it('the row carries a missing badge and class', () => {
        const item = slice(webview, 'function worktreeItem(entry)', 'function worktreeSection()');
        assert.match(item, /entry\.missing/);
        assert.match(item, /' missing'/);
        assert.match(item, /T\('w\.worktreeMissing'\)/);
    });

    it('a missing row offers prune instead of open/remove', () => {
        const menu = slice(webview, "var worktreePath = worktreeRow.getAttribute('data-worktree');", 'showMenu(');
        assert.match(menu, /contains\('missing'\)/);
        assert.match(menu, /\['worktreePrune', T\('menu\.worktreePrune'\)\]/);
    });

    it('prune is a confirmed mutation with --expire now and clears the cache', () => {
        const prune = slice(service, 'async pruneWorktrees()', '/**');
        assert.match(prune, /_execMutate\(\['worktree', 'prune', '--expire', 'now'\]/);
        assert.match(prune, /_worktreeCache = null/);
        assert.match(worktreeCommands, /registerCommand\('idea-git\.pruneWorktree'/);
        assert.match(worktreeCommands, /worktree\.pruneConfirm/);
        assert.match(view, /case 'worktreePrune':/);
    });

    it('opening a deleted folder offers the prune instead of just an error', () => {
        const open = slice(worktreeCommands, "registerCommand('idea-git.openWorktree'", "registerCommand('idea-git.removeWorktree'");
        assert.match(open, /fs\.existsSync\(target\)/);
        assert.match(open, /worktree\.pathMissingPrune/);
        assert.match(open, /'idea-git\.pruneWorktree'/);
    });
});

describe('packaging excludes workbuddy files', () => {
    it('.vscodeignore lists .workbuddy/**', () => {
        const ignore = read('.vscodeignore');
        assert.ok(ignore.split(/\r?\n/).some(line => line.trim() === '.workbuddy/**'));
    });
});
