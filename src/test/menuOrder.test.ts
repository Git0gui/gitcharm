import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const webview = fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8').replace(/\r\n/g, '\n');

function between(start: string, end: string): string {
    const from = webview.indexOf(start);
    assert.ok(from >= 0, `missing start marker: ${start}`);
    const to = webview.indexOf(end, from);
    assert.ok(to > from, `missing end marker: ${end}`);
    return webview.slice(from, to);
}

function ordered(source: string, ...actions: string[]): void {
    let previous = -1;
    for (const action of actions) {
        const index = source.indexOf(action);
        assert.ok(index > previous, `${action} must appear after the preceding higher-frequency action`);
        previous = index;
    }
}

describe('context menu frequency order', () => {
    it('puts common branch actions before maintenance and keeps favorites last', () => {
        const branches = between(
            'var menuItems;\n    if (isRemote)',
            "\ndocument.getElementById('rows').addEventListener('click'"
        );
        const localBranch = branches.slice(branches.indexOf('// Other local branches:'));
        ordered(
            localBranch,
            "['checkout'",
            "['update'",
            "['push'",
            "['compareBranch'",
            "['merge'",
            "['rebase'",
            "['newBranchFrom'",
            "['worktreeAdd'",
            "['openRemoteBranch'",
            "['rename'",
            "['deleteBranch'"
        );
        assert.match(branches, /menuItems\.concat\(\[\['toggleFavorite'/);
        const currentBranch = branches.match(/else if \(isCurrent\) \{[\s\S]*?\n\s{4}\} else \{/)?.[0];
        assert.ok(currentBranch, 'current branch menu should be separate from other local branches');
        assert.doesNotMatch(currentBranch, /\['checkout'/, 'the checked-out branch cannot be checked out again');
        assert.match(branches, /if \(hasRemote\) \{menuItems\.push\(\['update', T\('menu\.pull'\)\], \['push'/);
        assert.match(webview, /var hasRemote = state\.branchMenuStateLoaded && state\.hasRemote;/);
        assert.match(webview, /state\.branchMenuStateLoaded = true;/);
    });

    it('puts commit inspection before history changes and destructive actions last', () => {
        const commit = between(
            'var isHead = !!state.headHash',
            "\ndocument.getElementById('d-files').addEventListener('click'"
        );
        const singleCommit = commit.slice(commit.indexOf('} else {'));
        ordered(
            singleCommit,
            "['showDiff'",
            "['copy'",
            "['openRemoteCommit'",
            "['cherryPick'",
            "['revert'",
            "['newBranchFrom'",
            "['newTag'",
            "['reset'",
            "['dropCommit'"
        );
        const multiCommit = commit.slice(commit.indexOf('if (isMultiSelect) {'), commit.indexOf('} else {'));
        ordered(
            multiCommit,
            "['cherryPick'",
            "['revert'",
            "['squashCommits'",
            "['copy'",
            "['openRemoteCommit'",
            "['dropCommit'"
        );
    });

    it('puts common file navigation and comparison before filtering and cherry-picking', () => {
        const files = between(
            "document.getElementById('d-files').addEventListener('contextmenu'",
            '/* ---------- inline diff preview ---------- */'
        );
        ordered(
            files,
            "['fileJumpToSource'",
            "['fileOpenRevision'",
            "['fileCompareLocal'",
            "['filterPath'",
            "['fileCherryPick'"
        );
    });

    it('keeps stash and worktree removal behind their common open/apply actions', () => {
        const menu = between(
            "document.getElementById('btree').addEventListener('contextmenu'",
            "document.getElementById('rows').addEventListener('click'"
        );
        ordered(menu, "['worktreeOpen'", "['worktreeRemove'");
        ordered(menu, "['stashApply'", "['stashPop'", "['stashDrop'");
    });

    it('places repo-wide tag deletion after push and management', () => {
        const tags = between(
            "document.getElementById('tag-push').addEventListener('click'",
            "document.getElementById('tg-files').addEventListener('click'"
        );
        ordered(tags, "['pickPushTags'", "['remoteTags'", "['deleteTags'");
    });

    it('puts reflog inspection and recovery before reset', () => {
        const reflog = between(
            "scroll.addEventListener('contextmenu'",
            "\n    });\n\n    overlay.querySelectorAll"
        );
        ordered(
            reflog,
            "['showDiff'",
            "['cherryPick'",
            "['newBranchFrom'",
            "['reset'",
            "['copy'"
        );
    });

    it('does not replace the commit selection when opening a row context menu', () => {
        const rows = between(
            "document.getElementById('rows').addEventListener('contextmenu'",
            "document.getElementById('d-files').addEventListener('click'"
        );
        assert.match(rows, /var contextHashes = state\.selectedHashes\.indexOf\(hash\) >= 0[\s\S]*?: \[hash\];/);
        assert.doesNotMatch(rows, /state\.selectedHashes\s*=/);
    });
});
