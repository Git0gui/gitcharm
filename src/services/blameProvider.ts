import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import type { RevealOptions } from '../views/messages';
import { t } from '../i18n';

export interface BlameInfo {
    hash: string;
    /** Repository-relative path of the blamed file; the panel selects it. */
    file: string;
    /** Absolute repository path blamed at compute time — the panel may be on another one. */
    repo: string;
    author: string;
    time: number;
    summary: string;
}

const ZERO_HASH = /^0+$/;

function fmtDay(epoch: number): string {
    const d = new Date(epoch * 1000);
    const p = (n: number) => (n < 10 ? '0' + n : '' + n);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtRelativeTimeFromEpoch(epoch: number): string {
    if (!epoch || epoch === 0) {return '';}
    try {
        const now = new Date();
        const commitDate = new Date(epoch * 1000);
        
        // Check if it's the same day (compare year, month, day)
        const isSameDay = 
            now.getFullYear() === commitDate.getFullYear() &&
            now.getMonth() === commitDate.getMonth() &&
            now.getDate() === commitDate.getDate();
        
        if (isSameDay) {
            // Same day: show relative time
            const diffSec = Math.floor((now.getTime() - commitDate.getTime()) / 1000);
            const diffMin = Math.floor(diffSec / 60);
            const diffHour = Math.floor(diffMin / 60);
            
            if (diffSec < 60) {return t('time.withinOneMinute');}
            if (diffMin < 60) {return t('time.minutesAgo', { n: diffMin });}
            return t('time.hoursAgo', { n: diffHour });
        }
        
        // Different day: show full date (YYYY-MM-DD)
        const year = commitDate.getFullYear();
        const month = String(commitDate.getMonth() + 1).padStart(2, '0');
        const day = String(commitDate.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    } catch (e) {
        return fmtDay(epoch);
    }
}

/**
 * Approximate rendered width. The extension host is Node — there is no document —
 * so a canvas measurement can only throw and fall back to a constant. The editor's
 * monospace font averages ~0.6em per Latin glyph; CJK and full-width glyphs ~1em.
 */
function measureTextPixels(text: string, fontSize: number): number {
    let em = 0;
    for (const ch of text) {
        em += /[\u1100-\u115f\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 1 : 0.6;
    }
    return em * fontSize;
}

/**
 * One blame pass over a document. Two arrays share the editor's line numbering:
 * the commit behind each line, and that line's number inside the blamed
 * commit's own version of the file — the coordinate the commit's diff preview
 * uses, so a jump from the gutter can land on the right row.
 */
interface BlameEntry {
    lines: BlameInfo[];
    origins: number[];
}

export class BlameProvider implements vscode.Disposable {
    private _decoration: vscode.TextEditorDecorationType;
    private _endDecoration: vscode.TextEditorDecorationType;
    private readonly _cache = new Map<string, BlameEntry>();
    private readonly _active = new Set<string>();
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _git: GitService,
        private readonly _onReveal: (hash: string, file: string, opts: RevealOptions) => void
    ) {
        this._decoration = this._createDecorationType();
        this._endDecoration = this._createEndDecorationType();

        this._disposables.push(vscode.window.onDidChangeVisibleTextEditors(editors => {
            for (const ed of editors) {
                if (this._active.has(ed.document.uri.toString())) {this._apply(ed);}
            }
        }));

        this._disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
            const key = e.document.uri.toString();
            this._cache.delete(key);
            for (const ed of vscode.window.visibleTextEditors) {
                if (ed.document === e.document && this._active.has(key)) {this._apply(ed);}
            }
        }));

        this._disposables.push(vscode.window.onDidChangeTextEditorSelection(e => {
            const key = e.textEditor.document.uri.toString();
            if (!this._active.has(key)) {return;}
            if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {return;}
            const sel = e.selections[0];
            if (!sel || sel.active.character !== 0) {return;}
            const entry = this._cache.get(key);
            const info = entry?.lines[sel.active.line];
            if (info && !ZERO_HASH.test(info.hash)) {
                this._onReveal(info.hash, info.file, this._revealOpts(entry!, info, sel.active.line));
            }
        }));

        this._disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
            const fontChanged = e.affectsConfiguration('editor.fontFamily') ||
                e.affectsConfiguration('editor.fontSize') ||
                e.affectsConfiguration('editor.letterSpacing');
            if (!fontChanged && !e.affectsConfiguration('editor.wordWrap')) {return;}
            if (fontChanged) {
                this._decoration.dispose();
                this._endDecoration.dispose();
                this._decoration = this._createDecorationType();
                this._endDecoration = this._createEndDecorationType();
            }
            for (const key of this._active) {
                const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === key);
                if (editor) {this._apply(editor);}
            }
        }));

        this._disposables.push(vscode.languages.registerHoverProvider({ scheme: 'file' }, {
            provideHover: (doc, pos) => {
                const key = doc.uri.toString();
                if (!this._active.has(key)) {return undefined;}
                const entry = this._cache.get(key);
                const info = entry?.lines[pos.line];
                if (!info) {return undefined;}

                const md = new vscode.MarkdownString();
                md.isTrusted = true;
                if (ZERO_HASH.test(info.hash)) {
                    md.appendMarkdown(`**${t('blame.uncommitted')}**\n\n${t('blame.uncommittedDetail')}`);
                    return new vscode.Hover(md);
                }
                md.appendMarkdown('**');
                md.appendText(info.summary);
                md.appendMarkdown('**\n\n');
                md.appendText(info.author);
                md.appendMarkdown(` · ${fmtRelativeTimeFromEpoch(info.time)} <small>(${fmtDay(info.time)})</small>\n\n`);
                md.appendMarkdown(`\`${info.hash.substring(0, 8)}\`\n\n`);
                const args = encodeURIComponent(JSON.stringify([info.hash, info.file, this._revealOpts(entry!, info, pos.line)]));
                md.appendMarkdown(`[${t('blame.viewInIdeaGit')}](command:idea-git.revealCommit?${args})`);
                return new vscode.Hover(md);
            }
        }));
    }

    /** The listeners and the decoration type were created for us, so they have to
     *  be handed back — nothing else in the extension owns them. */
    dispose(): void {
        for (const d of this._disposables) {d.dispose();}
        this._disposables.length = 0;
        this._decoration.dispose();
        this._endDecoration.dispose();
    }

    /**
     * What a jump into the panel needs beyond the hash: which repository the
     * annotation came from (the panel may be showing another one) and which
     * lines to land on. One commit annotates a run of consecutive lines, and
     * that run is what the user was pointing at; the numbers sent along are the
     * run's positions inside the commit's file, not the editor's.
     */
    private _revealOpts(entry: BlameEntry, info: BlameInfo, index: number): RevealOptions {
        let start = index;
        let end = index;
        while (start > 0 && entry.lines[start - 1]?.hash === info.hash) {start--;}
        while (end + 1 < entry.lines.length && entry.lines[end + 1]?.hash === info.hash) {end++;}
        const numbers = entry.origins.slice(start, end + 1).filter(n => n >= 1);
        return {
            repoPath: info.repo,
            startLine: numbers.length ? Math.min(...numbers) : undefined,
            endLine: numbers.length ? Math.max(...numbers) : undefined
        };
    }

    private _createDecorationType(): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            before: { margin: '0 10px 0 0' },
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        });
    }

    private _createEndDecorationType(): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            after: { margin: '0 0 0 16px' },
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
        });
    }

    async toggle(editor?: vscode.TextEditor): Promise<void> {
        const ed = editor ?? vscode.window.activeTextEditor;
        if (!ed) {return;}
        const key = ed.document.uri.toString();

        if (this._active.has(key)) {
            this._active.delete(key);
            ed.setDecorations(this._decoration, []);
            ed.setDecorations(this._endDecoration, []);
            return;
        }

        if (!this._cache.has(key)) {
            const entry = await this._compute(ed.document);
            if (!entry) {
                vscode.window.showWarningMessage(t('blame.noInfo'));
                return;
            }
            this._cache.set(key, entry);
        }
        this._active.add(key);
        this._apply(ed);
    }

    private async _compute(doc: vscode.TextDocument): Promise<BlameEntry | undefined> {
        const repo = this._git.repositoryPath;
        if (!repo) {return undefined;}
        const rel = path.relative(repo, doc.uri.fsPath).replace(/\\/g, '/');
        if (rel.startsWith('..')) {return undefined;}

        let out: string;
        try {
            out = await this._git.executeGitArgs(['blame', '--porcelain', '--', rel]);
        } catch {
            return undefined;
        }
        if (!out) {return undefined;}

        const meta = new Map<string, BlameInfo>();
        const lines: BlameInfo[] = [];
        const origins: number[] = [];
        let cur: { hash: string; orig: number; final: number } | undefined;

        for (const ln of out.split('\n')) {
            const head = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(ln);
            if (head) {
                // The header carries the line's position in the blamed commit
                // first and in the blamed file second; only the latter is where
                // the annotation goes, the former is what a jump lands on.
                cur = { hash: head[1], orig: parseInt(head[2], 10), final: parseInt(head[3], 10) };
                if (!meta.has(cur.hash)) {meta.set(cur.hash, { hash: cur.hash, file: rel, repo, author: '', time: 0, summary: '' });}
                continue;
            }
            if (ln.startsWith('\t')) {
                if (cur) {
                    lines[cur.final - 1] = meta.get(cur.hash)!;
                    origins[cur.final - 1] = cur.orig;
                }
                cur = undefined;
                continue;
            }
            if (cur) {
                const e = meta.get(cur.hash)!;
                if (ln.startsWith('author ')) {e.author = ln.substring(7);}
                else if (ln.startsWith('author-time ')) {e.time = parseInt(ln.substring(12), 10) || 0;}
                else if (ln.startsWith('summary ')) {e.summary = ln.substring(8);}
            }
        }
        return { lines, origins };
    }

    private _apply(editor: vscode.TextEditor): void {
        const blame = this._cache.get(editor.document.uri.toString())?.lines;
        if (!blame) {return;}

        const fontSize = vscode.workspace.getConfiguration('editor').get<number>('fontSize', 14);
        const lineCount = editor.document.lineCount;

        let min = Infinity, max = -Infinity;
        for (let i = 0; i < lineCount; i++) {
            const b = blame[i];
            if (!b || ZERO_HASH.test(b.hash)) {continue;}
            if (b.time < min) {min = b.time;}
            if (b.time > max) {max = b.time;}
        }
        const span = max > min ? max - min : 1;

        const texts: string[] = new Array(lineCount);
        const styles: Array<{ bg: string; fg: string } | undefined> = new Array(lineCount);

        for (let i = 0; i < lineCount; i++) {
            const b = blame[i];
            if (!b) {continue;}

            let bg: string, fg: string;
            if (ZERO_HASH.test(b.hash)) {
                bg = 'rgba(128,128,128,0.35)'; fg = '#bbb';
            } else {
                const t = (b.time - min) / span;
                const light = Math.round(78 - 43 * t);
                bg = `hsl(210, 55%, ${light}%)`;
                fg = light < 55 ? '#fff' : '#16202a';
            }
            texts[i] = `${fmtRelativeTimeFromEpoch(b.time)} ${b.author}`;
            styles[i] = { bg, fg };
        }

        let maxPixelWidth = 0;
        for (let i = 0; i < lineCount; i++) {
            if (!styles[i]) {continue;}
            const w = measureTextPixels(` ${texts[i]} `, fontSize);
            if (w > maxPixelWidth) {maxPixelWidth = w;}
        }
        if (maxPixelWidth === 0) {
            maxPixelWidth = 20 * Math.ceil(fontSize * 0.6);
        }
        const fixedWidth = `${Math.ceil(maxPixelWidth) + 4}px`;

        // VS Code lays inline `before` content out on the first visual row only:
        // every wrapped continuation row starts at the line's left edge, so the
        // first row's code sits right of the annotation while the rest of the
        // same logical line sits left of it. The API offers no way to indent
        // those rows, so as soon as word wrap is on the annotation moves to the
        // end of the line — nothing injected before the code, nothing to
        // misalign. With wrap off the IDEA-style left column takes no space from
        // the text and stays.
        const wrap = vscode.workspace.getConfiguration('editor', editor.document.uri)
            .get<string | boolean>('wordWrap', 'off');
        const atLineEnd = wrap !== 'off' && wrap !== false;

        const ranges: vscode.DecorationOptions[] = [];
        for (let i = 0; i < lineCount; i++) {
            const st = styles[i];
            if (!st) {continue;}
            if (atLineEnd) {
                const label = texts[i].trim();
                // Nothing useful to show for an uncommitted line at the end of
                // the text; an empty pill there would just be noise.
                if (!label) {continue;}
                const len = editor.document.lineAt(i).text.length;
                ranges.push({
                    range: new vscode.Range(i, len, i, len),
                    renderOptions: {
                        after: {
                            contentText: ` ${label} `,
                            backgroundColor: st.bg,
                            color: st.fg
                        }
                    }
                });
            } else {
                ranges.push({
                    range: new vscode.Range(i, 0, i, 0),
                    renderOptions: {
                        before: {
                            contentText: ` ${texts[i]} `,
                            backgroundColor: st.bg,
                            color: st.fg,
                            width: fixedWidth
                        }
                    }
                });
            }
        }
        editor.setDecorations(this._decoration, atLineEnd ? [] : ranges);
        editor.setDecorations(this._endDecoration, atLineEnd ? ranges : []);
    }
}
