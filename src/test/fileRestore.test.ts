import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Hiding the panel destroys the webview frame, and the third column is the part
 * that hurts: the commit selection came back, but the file the user was reading
 * did not. The file row cannot be restored with the commits — it belongs to a
 * commit's detail, which is one round-trip away — so it waits in its own one-shot
 * slot. These tests pin the two halves of that: the state that leaves, and the
 * narrow set of moments allowed to put it back.
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const webview = fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8');
const host = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');

function body(name: string): string {
    const match = webview.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(match, `webview.js must define ${name}()`);
    return match[0];
}

describe('the file the user was reading is part of the snapshot', () => {
    it('the saved state carries the file row and its own scroll', () => {
        const post = body('_postViewState');
        assert.match(
            post,
            /fileCursor: state\.fileCursor \|\| ''/,
            'without the row, a re-show restores the commit and an empty third column — which is the complaint this exists for'
        );
        assert.match(
            post,
            /filesScrollTop: document\.getElementById\('d-files'\)\.scrollTop \|\| 0/,
            "the file list scrolls on its own, so the commit list's scrollTop says nothing about where in it the user was"
        );
    });

    it('scrolling and clicking a file row both report it', () => {
        assert.match(
            webview,
            /getElementById\('d-files'\)\.addEventListener\('scroll', saveViewState\)/,
            "a remembered scroll position is only as good as the last save — and 'I scrolled down to find it' is a state worth saving on its own"
        );
        const pick = webview.match(/function selectFileRow\(row\) \{[\s\S]*?\n\}/);
        assert.ok(pick, 'the click path and the keyboard path must share one file-selection function');
        assert.match(pick[0], /saveViewState\(\)/, 'a click that only moves the file cursor still has to reach the snapshot');
        assert.match(
            webview,
            /if \(file\) \{selectFileRow\(file\);\}/,
            'the row click must go through selectFileRow, otherwise the two paths drift and one of them stops saving'
        );
    });

    it('the pending save survives the frame being hidden', () => {
        const flush = webview.match(/addEventListener\('visibilitychange'[\s\S]*?\n\}\);/);
        assert.ok(flush, 'hiding the panel destroys this frame, and the 400ms timer dies with it');
        assert.match(flush[0], /document\.hidden/, 'only the way out is worth flushing — a visible panel can keep debouncing');
        assert.match(flush[0], /_postViewState\(\)/, 'it must hand over the pending state, not start another timer');
    });

    it('the snapshot still arrives through the TTL-gated read', () => {
        const posts = host.match(/command: 'restoreViewState'/g) ?? [];
        assert.equal(posts.length, 1, 'the persisted snapshot has exactly one entry point');
        const gate = host.match(/const saved = this\._restorableState\(\);[\s\S]*?restoreViewState', state: saved/);
        assert.ok(
            gate,
            'the file row rides the same session-limited snapshot as the selection: a reopen after a long absence must not resurrect a file the user left days ago'
        );
    });
});

describe('the remembered row is put back once, and only where it belongs', () => {
    it('a file row needs the commit it belonged to', () => {
        const restore = webview.match(/else if \(m\.command === 'restoreViewState'\) \{[\s\S]*?\n {4}\}/);
        assert.ok(restore, "the 'restoreViewState' handler must exist");
        assert.match(
            restore[0],
            /vs\.selectedHash && vs\.fileCursor/,
            'a snapshot with no restored selection has no file list to put a row into; keeping the slot alive would mark a row of some later commit'
        );
        assert.match(restore[0], /state\._pendingFileRestore = \(vs\.selectedHash[\s\S]*? : null;/, 'the slot is rewritten, never accumulated');
    });

    it('the slot is spent the first time it is looked at', () => {
        const apply = body('applyPendingFileRestore');
        assert.match(
            apply,
            /if \(!pending\) \{return;\}\r?\n {4}state\._pendingFileRestore = null;/,
            'consume-once: a path that is no longer in the list is gone, not something to keep hunting for across commits'
        );
        assert.doesNotMatch(
            apply,
            /scrollIntoView\(/,
            'scrollIntoView would also move the commit list, undoing the scroll position restored with it'
        );
    });

    it('only the detail answers may put it back', () => {
        const calls = webview.match(/applyPendingFileRestore\(\);/g) ?? [];
        assert.equal(calls.length, 2, 'setDetail and multiCommitsResponse are the two moments the file list genuinely exists');
        const tagSync = webview.match(/if \(m\.origin === 'tagSync'\) \{[\s\S]*?\n {8}\}/);
        assert.ok(tagSync, "the tagSync branch of setDetail must stay separate");
        assert.doesNotMatch(tagSync[0], /applyPendingFileRestore/, 'a commit opened from the tag dialog is not the panel selection');
    });

    it('a newer intent cancels the remembered row', () => {
        const clear = body('clearFileCursor');
        assert.match(clear, /state\._pendingFileRestore = null;/, 'cancelling the mark without cancelling the wait would re-apply it later');
        const sites = webview.match(/clearFileCursor\(\);/g) ?? [];
        assert.equal(sites.length, 3, 'every path that replaces the commit selection — keyboard, stash, row click — must cancel the wait');
        const setDetail = webview.match(/state\.detail = \{\r?\n {12}commit: m\.commit,[\s\S]*?selectRevealedFile\(\);/);
        assert.ok(setDetail, 'setDetail renders then selects a file');
        assert.ok(
            setDetail[0].indexOf('applyPendingFileRestore()') < setDetail[0].indexOf('selectRevealedFile()'),
            'a blame reveal carried by the same answer is the newer intent and must win over the remembered row'
        );
    });
});
