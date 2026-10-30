/* Line history tab: commit list on top, the selected commit's diff below.
 *
 * The host owns every git call; this file only renders what it is handed and
 * pages the list locally (10 at a time — a line with dozens of commits should
 * not turn into a wall of rows). All interpolated text goes through esc(): the
 * strings come from commit messages, author names and file contents.
 */
(function () {
    'use strict';

    var vscode = acquireVsCodeApi();
    var DICT = window.I18N_STRINGS || {};
    var PAGE = 10;

    function T(key, params) {
        var text = DICT[key] !== undefined ? DICT[key] : key;
        if (params) {
            for (var k in params) {
                if (Object.prototype.hasOwnProperty.call(params, k)) {
                    text = text.split('{' + k + '}').join(String(params[k]));
                }
            }
        }
        return text;
    }

    var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    function esc(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; });
    }

    var state = {
        /* 'lines' (Alt+H) or 'file' (whole-file history): the two tabs share
         * this renderer, and the mode decides which head/list/diff bits exist. */
        mode: 'lines',
        file: '',
        startLine: 0,
        endLine: 0,
        commits: [],
        skipped: 0,
        scanned: 0,
        error: undefined,
        loading: true,
        selected: null,
        shown: PAGE,
        diff: null,
        diffRequest: 0,
        /* false: only the hunks that touch the selected lines (the default —
         * this tab exists to explain *those* lines). true: the whole file. */
        full: false,
        /* The `-L` chain arrived: the list now reaches past the blamed commits. */
        chain: false
    };

    var listEl = document.getElementById('lh-list');
    var diffBodyEl = document.getElementById('lh-diff-body');
    var diffTitleEl = document.getElementById('lh-diff-title');
    var subEl = document.getElementById('lh-sub');
    var fileEl = document.getElementById('lh-file');
    var statsEl = document.getElementById('lh-diff-stats');
    var revealBtn = document.getElementById('lh-reveal');
    var nativeBtn = document.getElementById('lh-native');
    var scopeBtn = document.getElementById('lh-scope');

    function pad(n) {
        return n < 10 ? '0' + n : '' + n;
    }

    /* Same rule as the log list: within the day show a relative age, older
     * than that the absolute timestamp. */
    function fmtTime(seconds) {
        if (!seconds) { return ''; }
        var d = new Date(seconds * 1000);
        var now = new Date();
        var sameDay = d.getFullYear() === now.getFullYear() &&
            d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
        if (sameDay) {
            var diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
            if (diffSec < 60) { return T('time.withinOneMinute'); }
            if (diffSec < 3600) { return T('time.minutesAgo', { n: Math.floor(diffSec / 60) }); }
            return T('time.hoursAgo', { n: Math.floor(diffSec / 3600) });
        }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function rangeLabel() {
        if (state.startLine === state.endLine) {
            return T('lineHistory.singleLine', { line: state.startLine + 1 });
        }
        return T('lineHistory.range', { start: state.startLine + 1, end: state.endLine + 1 });
    }

    /* The worktree row is not a revision, so it never counts as one. */
    function revisionCount() {
        var count = 0;
        for (var i = 0; i < state.commits.length; i++) {
            if (!state.commits[i].dirty) { count++; }
        }
        return count;
    }

    function isFileMode() {
        return state.mode === 'file';
    }

    function renderHead() {
        fileEl.textContent = state.file;
        var parts = [];
        if (!state.loading) {
            if (isFileMode()) {
                if (!state.error) {
                    parts.push(T('fileHistory.summary', { count: revisionCount() }));
                }
            } else {
                parts.push(rangeLabel());
                if (!state.error) {
                    parts.push(T(state.chain ? 'lineHistory.revisions' : 'lineHistory.summary', {
                        count: revisionCount()
                    }));
                }
                if (state.skipped > 0) { parts.push(T('lineHistory.skipped', { count: state.skipped })); }
            }
        }
        subEl.textContent = parts.join(' · ');
        document.title = state.file;
    }

    function renderList() {
        var scrollTop = listEl.scrollTop;
        var loadingText = T(isFileMode() ? 'fileHistory.loading' : 'lineHistory.loading');
        if (state.loading) {
            listEl.innerHTML = '<div class="lh-note"><span class="lh-spin"></span>' + esc(loadingText) + '</div>';
            return;
        }
        if (state.error) {
            listEl.innerHTML = '<div class="lh-note lh-note-error">' + esc(state.error) + '</div>';
            return;
        }
        if (state.commits.length === 0) {
            listEl.innerHTML = '<div class="lh-note">' +
                esc(T(isFileMode() ? 'fileHistory.noCommits' : 'lineHistory.noCommits')) + '</div>';
            return;
        }

        var limit = Math.min(state.shown, state.commits.length);
        /* "2 行来自此提交" only means something when more than one line was
         * selected; on a single line every row would just say 1. A file-history
         * row is a whole-file change, so that count has no meaning there. */
        var showLines = !isFileMode() && state.scanned > 1;
        var html = [];
        for (var i = 0; i < limit; i++) {
            var c = state.commits[i];
            var meta = c.dirty
                ? '<span class="lh-author">' + esc(T('lineHistory.you')) + '</span>' +
                    '<span class="lh-time">' + esc(T('lineHistory.justNow')) + '</span>'
                : '<span class="lh-hash">' + esc(c.hash.substring(0, 8)) + '</span>' +
                    '<span class="lh-author">' + esc(c.author) + '</span>' +
                    '<span class="lh-time">' + esc(fmtTime(c.authorTime)) + '</span>' +
                    (showLines && c.lines > 0
                        ? '<span class="lh-lines">' + esc(T('lineHistory.linesCount', { count: c.lines })) + '</span>'
                        : '');
            var content = c.content && c.content.length
                ? '<span class="lh-row-content">' + esc(c.content[0]) +
                    (c.content.length > 1 ? ' …' : '') + '</span>'
                : '';
            html.push(
                '<button class="lh-row' + (c.dirty ? ' lh-row-dirty' : '') +
                    (c.hash === state.selected ? ' sel' : '') + '" type="button" data-hash="' + esc(c.hash) + '">' +
                    '<span class="lh-row-top">' +
                        '<span class="lh-summary">' +
                            (c.dirty ? '<span class="lh-dirty-dot"></span>' : '') +
                            esc(c.dirty ? T('lineHistory.uncommitted') : (c.summary || T('lineHistory.noSummary'))) +
                        '</span>' +
                    '</span>' +
                    '<span class="lh-row-bottom">' + meta + '</span>' +
                    content +
                '</button>'
            );
        }
        if (limit < state.commits.length) {
            html.push(
                '<button class="lh-more" id="lh-more" type="button">' +
                esc(T('lineHistory.loadMore', { count: state.commits.length - limit })) + '</button>'
            );
        }
        listEl.innerHTML = html.join('');
        listEl.scrollTop = scrollTop;
    }

    /* Selection is a class flip, not a redraw: replacing the list would throw
     * away the scroll position on every click. */
    function markSelected() {
        var rows = listEl.querySelectorAll('.lh-row');
        for (var i = 0; i < rows.length; i++) {
            rows[i].classList.toggle('sel', rows[i].getAttribute('data-hash') === state.selected);
        }
    }

    function currentCommit() {
        for (var i = 0; i < state.commits.length; i++) {
            if (state.commits[i].hash === state.selected) { return state.commits[i]; }
        }
        return null;
    }

    function selectCommit(hash) {
        if (state.selected === hash && state.diff && !state.diff.loading && state.diff.hash === hash) { return; }
        state.selected = hash;
        markSelected();
        requestDiff(hash);
    }

    function requestDiff(hash) {
        /* A file-history row explains the whole file change — there is no
         * selection to narrow it to. */
        var full = isFileMode() || state.full;
        state.diffRequest++;
        state.diff = { hash: hash, loading: true, requestId: state.diffRequest, full: full };
        renderDiff();
        vscode.postMessage({
            command: 'selectCommit', hash: hash, requestId: state.diffRequest, full: full
        });
    }

    /* The button names the other scope, i.e. what clicking it does: in line
     * scope it offers "whole file", and vice versa. */
    function renderScope() {
        var label = state.full ? T('lineHistory.scopeLines') : T('lineHistory.scopeFile');
        scopeBtn.textContent = label;
        scopeBtn.title = label;
        scopeBtn.classList.toggle('on', state.full);
    }

    function diffHeaderText() {
        var c = currentCommit();
        if (!c) { return ''; }
        if (c.dirty) { return T('lineHistory.uncommitted') + '  ·  ' + T('lineHistory.vsHead'); }
        return c.hash.substring(0, 8) + '  ' + (c.summary || T('lineHistory.noSummary'));
    }

    function renderDiff() {
        var commit = currentCommit();
        var hasCommit = !!commit;
        /* Uncommitted work is in no commit, so there is nothing to open or
         * compare natively — only the working-tree diff git can produce. */
        var isCommit = hasCommit && !commit.dirty;
        diffTitleEl.textContent = hasCommit ? diffHeaderText() : '';
        revealBtn.style.display = isCommit ? '' : 'none';
        nativeBtn.style.display = isCommit ? '' : 'none';
        scopeBtn.style.display = hasCommit && !isFileMode() ? '' : 'none';
        renderScope();
        diffBodyEl.innerHTML = hasCommit ? diffBodyHtml(state.diff) : '';
        renderDiffStats();
    }

    function noteHtml(text, extraClass) {
        return '<div class="lh-note' + (extraClass || '') + '">' + esc(text) + '</div>';
    }

    function loadingHtml() {
        return '<div class="lh-note"><span class="lh-spin"></span>' + esc(T('lineHistory.diffLoading')) + '</div>';
    }

    function diffBodyHtml(d) {
        if (!d || d.hash !== state.selected) { return loadingHtml(); }
        if (d.loading) { return loadingHtml(); }
        if (d.error) { return noteHtml(T('lineHistory.diffFailed', { error: d.error }), ' lh-note-error'); }
        if (d.binary) { return noteHtml(T('lineHistory.binary')); }
        if (!d.rows || d.rows.length === 0) {
            return noteHtml(T(d.full ? 'lineHistory.emptyDiff' : 'lineHistory.noLineChange'));
        }

        var html = ['<div class="lh-diff-table">'];
        for (var i = 0; i < d.rows.length; i++) {
            var row = d.rows[i];
            if (row.type === 'hunk') {
                html.push('<div class="lh-dl lh-dl-hunk"><span class="lh-hunk-text">' +
                    esc(row.text) + '</span></div>');
                continue;
            }
            var cls = row.type === 'add' ? ' lh-dl-add' : row.type === 'del' ? ' lh-dl-del' : '';
            if (row.hit) { cls += ' lh-dl-hit'; }
            var sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
            html.push('<div class="lh-dl' + cls + '">' +
                '<span class="lh-ln">' + (row.oldLine === undefined ? '' : row.oldLine) + '</span>' +
                '<span class="lh-ln">' + (row.newLine === undefined ? '' : row.newLine) + '</span>' +
                '<span class="lh-sign">' + sign + '</span>' +
                '<span class="lh-code">' + (esc(row.text) || '&nbsp;') + '</span>' +
                '</div>');
        }
        html.push('</div>');
        if (d.truncated) {
            html.push('<div class="lh-note">' + esc(T('lineHistory.truncated', { rows: d.rows.length })) + '</div>');
        }
        return html.join('');
    }

    /* The line counts belong to the patch, not to the row: they only exist once
     * that commit's diff has been read, so they live in the diff header. Rows
     * carrying a number that appears only after a click would look broken. */
    function renderDiffStats() {
        var d = state.diff;
        if (!d || d.loading || d.error || d.binary || !d.rows) {
            statsEl.innerHTML = '';
            return;
        }
        var adds = 0, dels = 0;
        for (var i = 0; i < d.rows.length; i++) {
            if (d.rows[i].type === 'add') { adds++; }
            else if (d.rows[i].type === 'del') { dels++; }
        }
        statsEl.innerHTML = (adds ? '<span class="lh-add">+' + adds + '</span>' : '') +
            (dels ? '<span class="lh-del">−' + dels + '</span>' : '');
    }

    listEl.addEventListener('click', function (e) {
        var more = e.target.closest('#lh-more');
        if (more) {
            state.shown += PAGE;
            renderList();
            return;
        }
        var row = e.target.closest('.lh-row');
        if (row) { selectCommit(row.getAttribute('data-hash')); }
    });

    listEl.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') { return; }
        var rows = Array.prototype.slice.call(listEl.querySelectorAll('.lh-row'));
        var index = rows.indexOf(document.activeElement);
        if (index < 0) { return; }
        var next = e.key === 'ArrowDown' ? index + 1 : index - 1;
        if (next < 0 || next >= rows.length) { return; }
        e.preventDefault();
        rows[next].focus();
        selectCommit(rows[next].getAttribute('data-hash'));
    });

    document.getElementById('lh-refresh').addEventListener('click', function () {
        state.loading = true;
        renderHead();
        renderList();
        vscode.postMessage({ command: 'refresh' });
    });

    nativeBtn.addEventListener('click', function () {
        if (state.selected) { vscode.postMessage({ command: 'openNativeDiff', hash: state.selected }); }
    });

    scopeBtn.addEventListener('click', function () {
        state.full = !state.full;
        if (state.selected) { requestDiff(state.selected); } else { renderScope(); }
    });

    revealBtn.addEventListener('click', function () {
        if (state.selected) { vscode.postMessage({ command: 'revealCommit', hash: state.selected }); }
    });

    window.addEventListener('message', function (event) {
        var message = event.data;
        if (!message || !message.command) { return; }

        if (message.command === 'lh.loading') {
            state.mode = message.mode || state.mode;
            state.loading = true;
            renderHead();
            renderList();
            return;
        }

        if (message.command === 'lh.data') {
            var keep = state.selected;
            state.loading = false;
            state.mode = message.mode || 'lines';
            state.file = message.file;
            state.startLine = message.startLine;
            state.endLine = message.endLine;
            state.commits = message.commits || [];
            state.skipped = message.skipped || 0;
            state.scanned = message.scanned || 0;
            state.error = message.error;
            state.chain = false;
            state.shown = Math.min(Math.max(PAGE, state.shown), Math.max(PAGE, state.commits.length));

            var stillThere = null;
            for (var i = 0; i < state.commits.length; i++) {
                if (state.commits[i].hash === keep) { stillThere = keep; break; }
            }
            state.selected = stillThere;
            state.diff = null;
            renderHead();
            renderList();
            if (state.selected) {
                selectCommit(state.selected);
            } else if (state.commits.length > 0) {
                selectCommit(state.commits[0].hash);
            } else {
                state.selected = null;
                renderDiff();
            }
            return;
        }

        if (message.command === 'lh.chain') {
            /* Same rows, plus the rewrites blame cannot see. Selection and page
             * size survive: the diff below is already about a commit that is
             * still in the list. */
            var keepSelected = state.selected;
            state.chain = true;
            state.commits = message.commits || [];
            state.shown = Math.min(Math.max(PAGE, state.shown), Math.max(PAGE, state.commits.length));
            var present = false;
            for (var j = 0; j < state.commits.length; j++) {
                if (state.commits[j].hash === keepSelected) { present = true; break; }
            }
            if (!present) {
                state.selected = state.commits.length > 0 ? state.commits[0].hash : null;
            }
            renderHead();
            renderList();
            if (!present && state.selected) { selectCommit(state.selected); }
            return;
        }

        if (message.command === 'lh.diff') {
            // Only the newest request may paint: list clicks outrun git.
            if (message.requestId !== state.diffRequest) { return; }
            if (message.hash !== state.selected) { return; }
            state.diff = {
                hash: message.hash,
                full: !!message.full,
                rows: message.rows || [],
                truncated: !!message.truncated,
                binary: !!message.binary,
                error: message.error
            };
            renderDiff();
            return;
        }
    });

    vscode.postMessage({ command: 'ready' });
})();
