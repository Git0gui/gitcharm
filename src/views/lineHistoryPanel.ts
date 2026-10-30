import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { GitService } from '../services/gitService';
import { formatGitError } from '../services/gitUtils';
import { logger } from '../services/logger';
import { getLocale, t, webviewStrings } from '../i18n';
import {
    commitsForLines,
    parseBlamePorcelain,
    parseUnifiedDiff,
    mapToHeadLines,
    parseLineLog,
    mergeChain,
    worktreeEntry,
    buildLineLogArgs,
    WORKTREE_COMMIT,
    MAX_DIFF_ROWS,
    LineHistoryCommit,
    ParsedPatch
} from '../services/lineHistory';
import { LineHistoryExtMessage, LineHistoryWebviewMessage } from './messages';
import { openEditorDiff } from '../commands/helpers';

export interface LineHistoryTarget {
    /** Root the blame walk belongs to; a different repository invalidates it. */
    repoPath: string;
    /** Repository-relative, '/'-separated. */
    file: string;
    /** 0-based, inclusive, normalized so start <= end. */
    startLine: number;
    endLine: number;
    /**
     * Buffer text at the time of the request. Blaming the buffer (not the file
     * on disk) is what makes an unsaved selection land on the right lines — the
     * document on screen is the one the user clicked in.
     */
    text: string;
}

/** Patches are cheap to recompute but not free; keep the last few around. */
const DIFF_CACHE_LIMIT = 30;

/**
 * The line-history tab: every commit behind the lines under the cursor, with the
 * selected commit's change to this file underneath.
 *
 * A single panel is reused — one tab per file would bury the editor in tabs for
 * something the user opens repeatedly while reading code. Data is computed here
 * and rendered by media/lineHistory.js; the panel never trusts the webview with
 * git arguments, only with hashes it already handed out.
 */
export class LineHistoryPanel {
    private static _current: LineHistoryPanel | undefined;

    public static show(
        git: GitService,
        extensionUri: vscode.Uri,
        target: LineHistoryTarget,
        onRevealCommit: (hash: string, file: string) => void
    ): LineHistoryPanel {
        if (LineHistoryPanel._current && !LineHistoryPanel._current._disposed) {
            const panel = LineHistoryPanel._current;
            panel._retarget(target);
            panel._panel.reveal(undefined, true);
            return panel;
        }
        const panel = new LineHistoryPanel(git, extensionUri, target, onRevealCommit);
        LineHistoryPanel._current = panel;
        return panel;
    }

    private readonly _panel: vscode.WebviewPanel;
    private readonly _diffCache = new Map<string, ParsedPatch>();
    private readonly _inFlight = new Map<string, Promise<ParsedPatch>>();
    private _target: LineHistoryTarget;
    private _commits: LineHistoryCommit[] = [];
    private _skipped = 0;
    private _scanned = 0;
    private _error: string | undefined;
    private _range = { startLine: 0, endLine: 0 };
    private _ready = false;
    private _ticket = 0;
    private _disposed = false;

    private constructor(
        private readonly _git: GitService,
        extensionUri: vscode.Uri,
        target: LineHistoryTarget,
        private readonly _onRevealCommit: (hash: string, file: string) => void
    ) {
        this._target = target;
        this._panel = vscode.window.createWebviewPanel(
            'idea-git.lineHistory',
            LineHistoryPanel._title(target.file),
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );
        this._panel.webview.html = this._html(extensionUri);

        this._panel.webview.onDidReceiveMessage(
            (message: LineHistoryWebviewMessage) => void this._onMessage(message),
            undefined
        );
        this._panel.onDidDispose(() => {
            this._disposed = true;
            if (LineHistoryPanel._current === this) {LineHistoryPanel._current = undefined;}
        });
    }

    private static _title(file: string): string {
        return `${path.posix.basename(file)} — ${t('lineHistory.title')}`;
    }

    /**
     * A second invocation — possibly on another range or another file — reuses
     * the tab and re-reads the buffer, so a stale range can never be shown as
     * if it were the current one.
     */
    private _retarget(target: LineHistoryTarget): void {
        this._target = target;
        this._panel.title = LineHistoryPanel._title(target.file);
        this._diffCache.clear();
        if (this._ready) {void this._load();}
    }

    private async _onMessage(message: LineHistoryWebviewMessage): Promise<void> {
        if (this._disposed) {return;}
        switch (message.command) {
            case 'ready':
                this._ready = true;
                await this._load();
                return;
            case 'selectCommit':
                void this._postDiff(message.hash, message.requestId, !!message.full);
                return;
            case 'openNativeDiff':
                await this._openNativeDiff(message.hash);
                return;
            case 'revealCommit':
                if (message.hash !== WORKTREE_COMMIT) {
                    this._onRevealCommit(message.hash, this._target.file);
                }
                return;
            case 'refresh':
                this._diffCache.clear();
                await this._load();
                return;
        }
    }

    private _post(message: LineHistoryExtMessage): void {
        if (this._disposed) {return;}
        void this._panel.webview.postMessage(message);
    }

    private _repositoryChanged(): boolean {
        const current = this._git.repositoryPath;
        return !current || path.resolve(current) !== path.resolve(this._target.repoPath);
    }

    private async _load(): Promise<void> {
        const ticket = ++this._ticket;
        this._post({ command: 'lh.loading' });

        if (this._repositoryChanged()) {
            this._commits = [];
            this._skipped = 0;
            this._scanned = this._target.endLine - this._target.startLine + 1;
            this._range = { startLine: this._target.startLine, endLine: this._target.endLine };
            this._error = t('lineHistory.repoChanged');
            this._post(this._dataMessage());
            return;
        }

        // `-L` is 1-based and refuses a range past EOF, which a stale range can
        // easily be after the user deletes lines and hits Reload.
        const lineCount = this._target.text.split('\n').length;
        const startLine = Math.max(0, Math.min(this._target.startLine, lineCount - 1));
        const endLine = Math.max(startLine, Math.min(this._target.endLine, lineCount - 1));
        this._range = { startLine, endLine };
        let blamed: LineHistoryCommit[] = [];

        try {
            const output = await this._blame(startLine, endLine);
            if (ticket !== this._ticket || this._disposed) {return;}
            const selection = commitsForLines(
                parseBlamePorcelain(output),
                startLine,
                endLine
            );
            this._commits = selection.skipped > 0
                ? [
                    worktreeEntry(
                        this._target.file,
                        selection.skipped,
                        this._target.text.split('\n').slice(startLine, endLine + 1)
                    ),
                    ...selection.commits
                ]
                : selection.commits;
            blamed = selection.commits;
            this._skipped = selection.skipped;
            this._scanned = selection.scanned;
            this._error = undefined;
        } catch (error) {
            if (ticket !== this._ticket || this._disposed) {return;}
            logger.debug('[GitCharm] Line history blame failed:', error);
            this._commits = [];
            this._skipped = 0;
            this._scanned = endLine - startLine + 1;
            this._error = LineHistoryPanel._isNoHistory(error) ? undefined : formatGitError(error);
        }
        this._post(this._dataMessage());
        void this._loadChain(blamed, ticket);
    }

    /**
     * Extend the list past what blame can see.
     *
     * Blame names the commit that owns the lines today; `-L` walks the same
     * lines backwards and finds the rewrites before it — plus what each revision
     * actually said.
     *
     * One `-L` range needs one start revision and one numbering. A single blamed
     * commit supplies both (its original-side numbers). A selection owned by
     * several commits has neither, but a clean buffer *is* HEAD's file, so today's
     * numbers are HEAD's numbers and the walk can start there. Uncommitted lines
     * are the remaining case: they have no commit to name, yet the user still
     * wants the history of the line they just edited, so the range is mapped to
     * the HEAD lines the edit replaced.
     *
     * It is an enrichment, not a prerequisite: the first paint never waits for
     * it, and a failure leaves the list exactly as blame delivered it.
     */
    private async _loadChain(blamed: readonly LineHistoryCommit[], ticket: number): Promise<void> {
        const range: number[] = [];
        for (let n = this._range.startLine + 1; n <= this._range.endLine + 1; n++) {range.push(n);}

        let anchor: Pick<LineHistoryCommit, 'hash' | 'path' | 'origLines'> | undefined;
        if (blamed.length === 1 && blamed[0].path && blamed[0].origLines.length > 0) {
            anchor = blamed[0];
        } else if (blamed.length === 0 && this._skipped > 0) {
            const mapped = await this._headLines(ticket);
            if (ticket !== this._ticket || this._disposed || mapped.length === 0) {return;}
            anchor = { hash: 'HEAD', path: this._target.file, origLines: mapped };
        } else if (this._skipped === 0 && !this._error) {
            anchor = { hash: 'HEAD', path: this._target.file, origLines: range };
        } else {
            return;
        }

        try {
            const output = await this._git.executeGitArgs(buildLineLogArgs(anchor), { timeoutMs: 30000 });
            if (ticket !== this._ticket || this._disposed) {return;}
            const revisions = parseLineLog(output);
            if (revisions.length === 0) {return;}
            this._commits = mergeChain(this._commits, revisions);
            this._post({ command: 'lh.chain', commits: this._commits });
        } catch (error) {
            logger.debug('[GitCharm] Line history chain failed:', error);
        }
    }

    /**
     * The HEAD-side counterparts of the selected buffer lines.
     *
     * Only meaningful for uncommitted lines: the buffer's numbering is today's,
     * and an edit moves everything below it. A `-U0` diff keeps one hunk per
     * changed block, which is exactly the pairing `mapToHeadLines` needs.
     */
    private async _headLines(ticket: number): Promise<number[]> {
        const lines: number[] = [];
        for (let n = this._range.startLine + 1; n <= this._range.endLine + 1; n++) {lines.push(n);}
        try {
            const patch = await this._git.executeGitArgs(
                ['diff', '--no-ext-diff', '--no-color', '--unified=0', 'HEAD', '--', this._target.file],
                { timeoutMs: 30000 }
            );
            if (ticket !== this._ticket || this._disposed) {return [];}
            return mapToHeadLines(parseUnifiedDiff(patch).rows, lines);
        } catch (error) {
            logger.debug('[GitCharm] Line history worktree mapping failed:', error);
            return [];
        }
    }

    private _dataMessage(): LineHistoryExtMessage {
        return {
            command: 'lh.data',
            file: this._target.file,
            startLine: this._range.startLine,
            endLine: this._range.endLine,
            commits: this._commits,
            skipped: this._skipped,
            scanned: this._scanned,
            error: this._error
        };
    }

    /** A file git has never seen is not a failure; it just has no history. */
    private static _isNoHistory(error: unknown): boolean {
        const text = error instanceof Error ? error.message : String(error);
        return /no such path|no such ref|does not have any commits|unknown revision|bad revision/i.test(text);
    }

    /**
     * Blame the buffer, not the file on disk: an unsaved edit shifts lines, and
     * the selection the user made is in the buffer's numbering.
     *
     * `--contents -` is the way to hand git that text through stdin. It is not
     * universal (git < 2.16 has no `--contents`), so a failure falls back to
     * blaming the worktree copy rather than leaving the panel empty.
     */
    private async _blame(startLine: number, endLine: number): Promise<string> {
        const args = [
            'blame', '--porcelain',
            '--contents', '-',
            '-L', `${startLine + 1},${endLine + 1}`,
            '--', this._target.file
        ];
        try {
            return await this._git.executeGitArgs(args, { input: this._target.text, timeoutMs: 30000 });
        } catch (error) {
            logger.debug('[GitCharm] blame --contents failed, retrying against the worktree copy:', error);
            return await this._git.executeGitArgs(
                ['blame', '--porcelain', '-L', `${startLine + 1},${endLine + 1}`, '--', this._target.file],
                { timeoutMs: 30000 }
            );
        }
    }

    private _commit(hash: string): LineHistoryCommit | undefined {
        return this._commits.find(c => c.hash === hash);
    }

    private async _postDiff(hash: string, requestId: number, full: boolean): Promise<void> {
        if (hash === WORKTREE_COMMIT) {
            await this._postWorktreeDiff(requestId, full);
            return;
        }
        const commit = this._commit(hash);
        if (!commit) {return;}
        const key = this._diffKey(commit, full);

        const cached = this._diffCache.get(key);
        if (cached) {
            // Refresh LRU position.
            this._diffCache.delete(key);
            this._diffCache.set(key, cached);
            this._post({ command: 'lh.diff', hash, requestId, full, ...cached });
            return;
        }

        try {
            const diff = await this._fetchDiff(commit, key, full);
            this._post({ command: 'lh.diff', hash, requestId, full, ...diff });
        } catch (error) {
            logger.debug('[GitCharm] Line history diff failed:', error);
            this._post({
                command: 'lh.diff',
                hash,
                requestId,
                full,
                rows: [],
                truncated: false,
                binary: false,
                error: formatGitError(error)
            });
        }
    }

    /**
     * Uncommitted work has no commit to diff against, so HEAD is the only
     * meaningful left side. git reads the file from disk here — it cannot read
     * the editor buffer — so a still-unsaved edit shows up only after a save.
     * No cache: HEAD moves under us, and one spawn per click is what an
     * uncached commit patch costs too.
     */
    private async _postWorktreeDiff(requestId: number, full: boolean): Promise<void> {
        try {
            const patch = await this._git.executeGitArgs([
                'diff', '--no-ext-diff', '--no-color', '--unified=3', 'HEAD', '--', this._target.file
            ]);
            const lines: number[] = [];
            for (let n = this._range.startLine + 1; n <= this._range.endLine + 1; n++) {
                lines.push(n);
            }
            const diff = parseUnifiedDiff(patch, MAX_DIFF_ROWS, { lines, restrict: !full });
            this._post({ command: 'lh.diff', hash: WORKTREE_COMMIT, requestId, full, ...diff });
        } catch (error) {
            logger.debug('[GitCharm] Worktree diff failed:', error);
            this._post({
                command: 'lh.diff',
                hash: WORKTREE_COMMIT,
                requestId,
                full,
                rows: [],
                truncated: false,
                binary: false,
                error: formatGitError(error)
            });
        }
    }

    /**
     * The scope is part of the key: the same commit asked for "only my lines"
     * and for the whole file is two different answer sets.
     */
    private _diffKey(commit: LineHistoryCommit, full: boolean): string {
        const scope = full ? 'all' : commit.origLines.join(',');
        return `${commit.hash}\0${commit.path}\0${scope}`;
    }

    /** In-flight requests are shared: the same commit asked twice is one spawn. */
    private _fetchDiff(commit: LineHistoryCommit, key: string, full: boolean): Promise<ParsedPatch> {
        const running = this._inFlight.get(key);
        if (running) {return running;}

        const task = (async (): Promise<ParsedPatch> => {
            const base = await this._git.getDiffBase(commit.hash);
            const patch = await this._git.executeGitArgs([
                'diff', '--no-ext-diff', '--no-color', '--unified=3', base, commit.hash, '--', commit.path
            ]);
            // Numbers in the patch are this commit's own, which is exactly what
            // blame's original-side line numbers refer to.
            return parseUnifiedDiff(patch, MAX_DIFF_ROWS, {
                lines: commit.origLines,
                restrict: !full
            });
        })().then(diff => {
            if (!this._disposed) {this._remember(key, diff);}
            return diff;
        }).finally(() => {
            this._inFlight.delete(key);
        });

        this._inFlight.set(key, task);
        return task;
    }

    private _remember(key: string, diff: ParsedPatch): void {
        this._diffCache.set(key, diff);
        while (this._diffCache.size > DIFF_CACHE_LIMIT) {
            const oldest = this._diffCache.keys().next();
            if (oldest.done) {break;}
            this._diffCache.delete(oldest.value);
        }
    }

    private async _openNativeDiff(hash: string): Promise<void> {
        const commit = this._commit(hash);
        if (!commit || commit.dirty) {return;}
        try {
            const base = await this._git.getDiffBase(commit.hash);
            const short = commit.hash.substring(0, 7);
            const name = path.posix.basename(commit.path);
            await openEditorDiff(
                this._git, base, commit.hash, commit.path,
                `${name} (${base.substring(0, 7)} ↔ ${short})`
            );
        } catch (error) {
            vscode.window.showErrorMessage(t('ext.openDiffFailed', { error: formatGitError(error) }));
        }
    }

    private _html(extensionUri: vscode.Uri): string {
        const webview = this._panel.webview;
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'lineHistory.css'));
        const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'lineHistory.js'));
        const nonce = crypto.randomBytes(16).toString('hex');
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
        const i18nJson = JSON.stringify(webviewStrings()).replace(/</g, '\\u003c');
        const htmlLang = getLocale() === 'zh-cn' ? 'zh-CN' : 'en';

        return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${csp}
    <title>${t('lineHistory.title')}</title>
    <link rel="stylesheet" href="${cssUri}">
</head>
<body>
    <div id="lh-app">
        <div id="lh-head">
            <div class="lh-title-row">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 2.5h6l4 4V13.5H3z"/><path d="M9 2.5v4h4"/></svg>
                <span id="lh-file"></span>
                <button id="lh-refresh" type="button" title="${t('lineHistory.refresh')}">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 1.5v3h-3"/></svg>
                </button>
            </div>
            <div id="lh-sub"></div>
        </div>
        <div id="lh-list"></div>
        <div id="lh-diff">
            <div id="lh-diff-head">
                <span id="lh-diff-title"></span>
                <span class="lh-stats" id="lh-diff-stats"></span>
                <span class="lh-spacer"></span>
                <button id="lh-scope" type="button"></button>
                <button id="lh-reveal" type="button" title="${t('lineHistory.reveal')}">${t('lineHistory.reveal')}</button>
                <button id="lh-native" type="button" title="${t('lineHistory.nativeDiff')}">${t('lineHistory.nativeDiff')}</button>
            </div>
            <div id="lh-diff-body"></div>
        </div>
    </div>
    <script nonce="${nonce}">window.I18N_STRINGS=${i18nJson};</script>
    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }
}
