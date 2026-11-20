import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const webview = fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8').replace(/\r\n/g, '\n');
const graphView = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8').replace(/\r\n/g, '\n');
const commitCommands = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'commitCommands.ts'), 'utf8').replace(/\r\n/g, '\n');
const branchCommands = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'branchCommands.ts'), 'utf8').replace(/\r\n/g, '\n');
const gitService = fs.readFileSync(path.join(ROOT, 'src', 'services', 'gitService.ts'), 'utf8').replace(/\r\n/g, '\n');

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
    it('puts common branch actions before maintenance, greys unavailable ones and keeps favorites last', () => {
        const branches = between(
            'var menuItems = [',
            "\ndocument.getElementById('rows').addEventListener('click'"
        );
        ordered(
            branches,
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
        // Every item is a triple; the third slot is showMenu's disabled flag.
        assert.match(branches, /\['checkout', T\('menu\.checkout'\), isCurrent\]/);
        assert.match(branches, /\['merge', T\('menu\.merge'\), !mergesIntoCurrent\]/);
        assert.match(branches, /\['rebase', T\('menu\.rebase'\), !mergesIntoCurrent\]/);
        assert.match(branches, /\['deleteBranch', T\('menu\.deleteBranch'\), isRemote \|\| isCurrent\]/);
        assert.doesNotMatch(branches, /if \(isCurrent\) \{[\s\S]*?menuItems = \[\]/);
        assert.match(webview, /var hasRemote = state\.branchMenuStateLoaded && state\.hasRemote;/);
        assert.match(webview, /state\.branchMenuStateLoaded = true;/);
        assert.match(webview, /\['worktreeRemove', T\('menu\.worktreeRemove'\), worktreeRow\.classList\.contains\('main'\)\]/);
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
        // History rewriting is offered on every commit of the checked-out
        // branch, and greyed (not hidden) when the log shows another branch.
        assert.match(commit, /var onCurrentBranch = !!state\.current && state\.selectedBranch === state\.current;/);
        assert.match(commit, /var canRewrite = onCurrentBranch;/);
        assert.doesNotMatch(commit, /if \(isHead\) \{items\.push\(\['dropCommit'/);
        assert.match(commit, /\['dropCommit', T\('menu\.dropCommit'\), !canRewrite\]/);
        assert.match(multiCommit, /\['squashCommits', T\('menu\.squashCommits'\)[\s\S]*?!canRewrite\]/);
        assert.match(singleCommit, /\['editMessage', T\('menu\.editMessage'\), !headOnly\]/);
        assert.match(singleCommit, /\['pushTag', T\('menu\.pushTag'\)[\s\S]*?rowTags\.length === 0\]/);
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

describe('history rewriting stays on the checked-out branch', () => {
    it('guards every conflict-prone action at the host entry point', () => {
        const actions = ['revert', 'amend', 'reset', 'dropCommit', 'squashCommits', 'editMessage', 'interactiveRebase'];
        for (const action of actions) {
            const from = graphView.indexOf(`case '${action}'`);
            assert.ok(from >= 0, `missing action case: ${action}`);
            const slice = graphView.slice(from, from + 220);
            assert.match(slice, /_assertHistoryScope\(\)/, `${action} must verify the log scope`);
        }
        assert.match(graphView, /if \(!current \|\| this\._branch !== current\)/);
    });

    it('lets git decide whether a commit can be dropped, including the root', () => {
        const drop = commitCommands.slice(
            commitCommands.indexOf("registerCommand('idea-git.dropCommit'"),
            commitCommands.indexOf("registerCommand('idea-git.editCommitMessage'")
        );
        assert.doesNotMatch(drop, /isInitialCommit/);
        assert.match(drop, /parents\.length > 0 \? parents\[0\] : null/);
        assert.match(gitService, /dropCommitsWithRebase\(upstream: string \| null/);
        assert.match(gitService, /_runRebaseWithTodo\(upstream \?\? '--root'/);
    });

    it('carries uncommitted changes across a branch switch', () => {
        const checkout = branchCommands.slice(
            branchCommands.indexOf("registerCommand('idea-git.checkoutBranch'"),
            branchCommands.indexOf("registerCommand('idea-git.deleteBranch'")
        );
        assert.match(checkout, /carryLocalChanges = !\(await gitService\.isClean\(\)\)/);
        assert.match(checkout, /gitService\.checkout\(branchName, false, carryLocalChanges\)/);
        assert.match(gitService, /'checkout', \.\.\.\(carryLocalChanges \? \['-m'\] : \[\]\)/);
    });
});
