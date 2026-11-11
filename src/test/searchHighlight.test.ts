import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'node:vm';

/**
 * The search term is marked inside each subject. Two promises are pinned here:
 * the marking is built from the raw text and escaped per segment (a term with
 * & < > " ' in it must still match, and a message must never reach the frame
 * unescaped), and it describes the rows actually on screen — the filter rides
 * with setCommits/setData, not with the search box, and a rooted page pauses it.
 *
 * The behavioural half runs the real webview functions: they are sliced out of
 * media/webview.js together with the production esc(), so a change to either is
 * what these cases measure, not a copy of them.
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');
const messages = fs.readFileSync(path.join(ROOT, 'src', 'views', 'messages.ts'), 'utf8');
const webview = fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8');
const sheet = fs.readFileSync(path.join(ROOT, 'media', 'webview.css'), 'utf8');

function body(text: string, signature: RegExp): string {
    const match = text.match(signature);
    assert.ok(match, `${signature.source} must exist`);
    return match[0];
}

interface Mark { text: string; regex: boolean; caseSensitive: boolean }
interface MarkApi {
    subjectHtml(message: string): string;
    subjectMarkRanges(line: string, mark: Mark): Array<[number, number]>;
}

const escSrc = body(webview, /var ESC_MAP = [\s\S]*?\nfunction esc\(t\) \{[\s\S]*?\n\}/);
const markStart = webview.indexOf('function subjectMarkRanges(');
const markEnd = webview.indexOf('function renderRows(');
assert.ok(markStart >= 0 && markEnd > markStart, 'the marking helpers must sit above renderRows');
const markSrc = webview.slice(markStart, markEnd);

const state: { subjectMark: Mark | null } = { subjectMark: null };
// The compiled text is this repository's own webview source, sliced between two
// fixed markers — no external input reaches it. It runs in a fresh VM context
// whose only global is `state`, so the helpers cannot see the test process.
interface Sandbox { state: { subjectMark: Mark | null }; api?: MarkApi }
const sandbox: Sandbox = { state };
vm.runInNewContext(
    `${escSrc}\n${markSrc}\nglobalThis.api = { subjectHtml: subjectHtml, subjectMarkRanges: subjectMarkRanges };`,
    sandbox
);
assert.ok(sandbox.api, 'the sliced helpers must evaluate');
const api: MarkApi = sandbox.api;

function mark(text: string, extra?: Partial<Mark>): Mark {
    return { text, regex: false, caseSensitive: false, ...extra };
}
function html(message: string, m: Mark | null): string {
    state.subjectMark = m;
    return api.subjectHtml(message);
}

describe('the subject marking is escaped per segment', () => {
    it('no filter means plain escaped text', () => {
        assert.equal(html('修复：a & b', null), '修复：a &amp; b');
        assert.equal(html('修复：a & b', mark('')), '修复：a &amp; b');
    });

    it('a hit in the middle of a subject is wrapped, the rest stays text', () => {
        assert.equal(
            html('修复：一组提交的早晚', mark('提交')),
            '修复：一组<mark class="hit">提交</mark>的早晚'
        );
    });

    it('literal mode folds case by default and honours Cc', () => {
        assert.equal(html('Reflog menu', mark('reflog')), '<mark class="hit">Reflog</mark> menu');
        assert.equal(html('Reflog menu', mark('reflog', { caseSensitive: true })), 'Reflog menu');
        assert.equal(html('Reflog menu', mark('Reflog', { caseSensitive: true })), '<mark class="hit">Reflog</mark> menu');
    });

    it('a literal term keeps its regex characters literal', () => {
        assert.equal(html('a+b (c)', mark('a+b')), '<mark class="hit">a+b</mark> (c)');
        assert.equal(html('axb', mark('a+b')), 'axb');
    });

    it('a message with markup never reaches the frame raw', () => {
        const out = html('<img src=x> & "q"', mark('img'));
        assert.equal(out, '&lt;<mark class="hit">img</mark> src=x&gt; &amp; &quot;q&quot;');
        assert.ok(!out.includes('<img'), 'the tag must stay escaped even inside a mark');
    });

    it('a term with markup matches the raw text and is escaped inside the mark', () => {
        assert.equal(html('a<b>c', mark('<b')), 'a<mark class="hit">&lt;b</mark>&gt;c');
    });

    it('regex mode marks every alternative', () => {
        assert.equal(
            html('修复：新增东西', mark('修复|新增', { regex: true })),
            '<mark class="hit">修复</mark>：<mark class="hit">新增</mark>东西'
        );
    });

    it('a pattern JS cannot compile marks nothing instead of throwing', () => {
        assert.equal(html('anything', mark('(', { regex: true })), 'anything');
    });

    it('a zero-width pattern terminates and marks nothing', () => {
        assert.equal(html('bbb', mark('a*', { regex: true })), 'bbb');
        assert.equal(html('abc', mark('^', { regex: true })), 'abc');
    });

    it('only the first line is shown, so only it is marked', () => {
        const out = html('first 提交\nsecond 提交', mark('提交'));
        assert.equal(out, 'first <mark class="hit">提交</mark>');
    });

    it('one row cannot become thousands of elements', () => {
        const out = html('a'.repeat(250), mark('a'));
        assert.equal((out.match(/<mark/g) || []).length, 100);
    });
});

describe('the marking describes the rows on screen', () => {
    it('the host reads it off the filters the rows were listed with', () => {
        const fn = body(source, /private _subjectHighlight\(\)[\s\S]*?\n {4}\}/);
        assert.ok(/this\._pageFilters\(\)/.test(fn), 'a rooted page pauses the filters, so it must not highlight either');
        assert.ok(/f\.text\?\.trim\(\)/.test(fn), 'the mark must be the term git received, whitespace included no more');
        assert.ok(/return text \? \{ text, regex: !!f\.regex, caseSensitive: !!f\.caseSensitive \} : undefined/.test(fn), 'both switches travel with the term');
    });

    it('every path that delivers rows carries it', () => {
        const collect = body(source, /private async _collect\([\s\S]*?\n {4}\}/);
        assert.ok(/highlight: this\._subjectHighlight\(\)/.test(collect), 'setData spreads this payload');
        const rows = body(source, /private async _reloadRows\([\s\S]*?\n {4}\}/);
        assert.ok(/highlight: this\._subjectHighlight\(\)/.test(rows), 'the search path paints rows too');
        const first = body(source, /private async _loadAndDisplayCommits\([\s\S]*?\n {4}\}/);
        assert.ok(/highlight: this\._subjectHighlight\(\)/.test(first), 'a repo-state reload can land while a filter is active');
    });

    it('the remembered first page cannot highlight: it is unfiltered by construction', () => {
        const paint = body(source, /private async _paintPersistedFirstPage\([\s\S]*?\n {4}\}/);
        assert.ok(/command: 'setCommits', commits: snap\.commits/.test(paint));
        assert.ok(!/highlight/.test(paint), 'a snapshot is only stored for an unfiltered page');
    });

    it('the protocol declares it on both row messages', () => {
        const setData = body(messages, /command: 'setData';[\s\S]*?\n {4}\}/);
        const setCommits = body(messages, /command: 'setCommits';[\s\S]*?\n {4}\}/);
        assert.ok(/highlight\?: SubjectHighlight;/.test(setData));
        assert.ok(/highlight\?: SubjectHighlight;/.test(setCommits));
    });

    it('the panel takes it from the rows, not from the search box', () => {
        const setData = body(webview, /m\.command === 'setData'\) \{[\s\S]*?\n {4}\} else if/);
        const setCommits = body(webview, /m\.command === 'setCommits'\) \{[\s\S]*?\n {4}\} else if/);
        assert.ok(/state\.subjectMark = m\.highlight \|\| null/.test(setData), 'a re-show paints rows before the mirror lands');
        assert.ok(/state\.subjectMark = m\.highlight \|\| null/.test(setCommits));
        assert.ok(/var displayMessage = subjectHtml\(c\.message\)/.test(webview), 'the row subject is the marked one');
        assert.ok(!/var displayMessage = esc\(c\.message\)/.test(webview), 'escaping first would hide a term with & < > in it');
    });

    it('the mark wears the theme, not the browser default yellow', () => {
        const rule = body(sheet, /\.msg mark\.hit \{[\s\S]*?\}/);
        assert.ok(/var\(--vscode-editor-findMatchHighlightBackground/.test(rule));
        assert.ok(/color: inherit/.test(rule), 'black text on a dark theme is unreadable');
    });
});

describe('the scope row leads the branch column', () => {
    it('all branches is painted above the HEAD section', () => {
        const tree = body(webview, /function renderTree\(\) \{[\s\S]*?\n\}/);
        assert.ok(/var allItem = '<div class="allitem'/.test(tree), 'the scope row keeps its own class');
        assert.ok(/'<div id="btree-inner">' \+ allItem \+ head/.test(tree), 'it must come before HEAD, not under it');
    });

    it('keyboard order is DOM order, so the move needs no nav change', () => {
        const list = body(webview, /function treeRowList\(\) \{[\s\S]*?\n\}/);
        assert.ok(/querySelectorAll\('#btree \.allitem, /.test(list), 'one query returns document order');
    });
});
