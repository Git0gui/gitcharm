import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { t } from '../i18n';

export interface BlameInfo {
    hash: string;
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

function measureTextPixels(text: string, fontFamily: string, fontSize: number): number {
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {return 0;}
        ctx.font = `${fontSize}px ${fontFamily}`;
        return ctx.measureText(text).width;
    } catch {
        return 0;
    }
}

function readEditorFontFamily(): string {
    const cfg = vscode.workspace.getConfiguration('editor');
    const raw = cfg.get<string>('fontFamily', '');
    return raw || "'Consolas', 'Courier New', monospace";
}

export class BlameProvider {
    private _decoration: vscode.TextEditorDecorationType;
    private readonly _cache = new Map<string, BlameInfo[]>();
    private readonly _active = new Set<string>();

    constructor(
        private readonly _git: GitService,
        private readonly _onReveal: (hash: string) => void
    ) {
        this._decoration = this._createDecorationType();

        vscode.window.onDidChangeVisibleTextEditors(editors => {
            for (const ed of editors) {
                if (this._active.has(ed.document.uri.toString())) {this._apply(ed);}
            }
        });

        vscode.workspace.onDidChangeTextDocument(e => {
            const key = e.document.uri.toString();
            this._cache.delete(key);
            for (const ed of vscode.window.visibleTextEditors) {
                if (ed.document === e.document && this._active.has(key)) {this._apply(ed);}
            }
        });

        vscode.window.onDidChangeTextEditorSelection(e => {
            const key = e.textEditor.document.uri.toString();
            if (!this._active.has(key)) {return;}
            if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {return;}
            const sel = e.selections[0];
            if (!sel || sel.active.character !== 0) {return;}
            const info = this._cache.get(key)?.[sel.active.line];
            if (info && !ZERO_HASH.test(info.hash)) {this._onReveal(info.hash);}
        });

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('editor.fontFamily') ||
                e.affectsConfiguration('editor.fontSize') ||
                e.affectsConfiguration('editor.letterSpacing')) {
                this._decoration.dispose();
                this._decoration = this._createDecorationType();
                for (const key of this._active) {
                    const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === key);
                    if (editor) {this._apply(editor);}
                }
            }
        });

        vscode.languages.registerHoverProvider({ scheme: 'file' }, {
            provideHover: (doc, pos) => {
                const key = doc.uri.toString();
                if (!this._active.has(key)) {return undefined;}
                const info = this._cache.get(key)?.[pos.line];
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
                md.appendMarkdown(`[${t('blame.viewInIdeaGit')}](command:idea-git.revealCommit?${encodeURIComponent(JSON.stringify([info.hash]))})`);
                return new vscode.Hover(md);
            }
        });
    }

    private _createDecorationType(): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            before: { margin: '0 10px 0 0' },
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
            return;
        }

        if (!this._cache.has(key)) {
            const blame = await this._compute(ed.document);
            if (!blame) {
                vscode.window.showWarningMessage(t('blame.noInfo'));
                return;
            }
            this._cache.set(key, blame);
        }
        this._active.add(key);
        this._apply(ed);
    }

    private async _compute(doc: vscode.TextDocument): Promise<BlameInfo[] | undefined> {
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
        const result: BlameInfo[] = [];
        let cur: { hash: string; line: number } | undefined;

        for (const ln of out.split('\n')) {
            const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(ln);
            if (head) {
                cur = { hash: head[1], line: parseInt(head[2], 10) };
                if (!meta.has(cur.hash)) {meta.set(cur.hash, { hash: cur.hash, author: '', time: 0, summary: '' });}
                continue;
            }
            if (ln.startsWith('\t')) {
                if (cur) {result[cur.line - 1] = meta.get(cur.hash)!;}
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
        return result;
    }

    private _apply(editor: vscode.TextEditor): void {
        const blame = this._cache.get(editor.document.uri.toString());
        if (!blame) {return;}

        const fontFamily = readEditorFontFamily();
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
            const w = measureTextPixels(` ${texts[i]} `, fontFamily, fontSize);
            if (w > maxPixelWidth) {maxPixelWidth = w;}
        }
        if (maxPixelWidth === 0) {
            maxPixelWidth = 20 * Math.ceil(fontSize * 0.6);
        }
        const fixedWidth = `${Math.ceil(maxPixelWidth) + 4}px`;

        const ranges: vscode.DecorationOptions[] = [];
        for (let i = 0; i < lineCount; i++) {
            const st = styles[i];
            if (!st) {continue;}
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
        editor.setDecorations(this._decoration, ranges);
    }
}
