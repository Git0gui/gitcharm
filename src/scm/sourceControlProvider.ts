import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../services/gitService';
import { StatusEntry } from '../services/gitUtils';
import { gitBlobUri } from '../commands/helpers';
import { logger } from '../services/logger';
import { t } from '../i18n';

/** Source control id; also the `scmProvider` context key used by menu when-clauses. */
export const SCM_PROVIDER_ID = 'idea-git';

const GROUP_STAGED = 'gitcharm-staged';
const GROUP_WORKING = 'gitcharm-workingTree';
const GROUP_UNMERGED = 'gitcharm-unmerged';

/** Pseudo-ref for the staged version of a file, resolved by GitService.showBlob. */
const INDEX_REF = 'index';

/** A merge stage inside the index (`git show :1:path`), 1 = common ancestor. */
function indexStage(stage: number): string {
    return `${INDEX_REF}:${stage}`;
}

/** Blob to compare a file against: which ref, and which path under that ref. */
interface BlobRef {
    readonly ref: string;
    readonly rel: string;
}

interface ChangeItem extends vscode.SourceControlResourceState {
    readonly groupId: string;
    readonly relativePath: string;
    readonly fromPath?: string;
}

/**
 * Our own SCM provider: staging tree, commit input box and gutter quick-diff,
 * built only on the stable `vscode.scm` API and GitCommandRunner plumbing, so
 * the panel works with the built-in Git extension disabled.
 */
export class GitSourceControlProvider implements vscode.Disposable {
    private _scm: vscode.SourceControl | undefined;
    private _groups: Map<string, vscode.SourceControlResourceGroup> | undefined;
    /** file system path -> the version the gutter diff compares against. */
    private _originalRefs = new Map<string, BlobRef>();
    private _entries: StatusEntry[] = [];
    private _refreshTimer: NodeJS.Timeout | undefined;
    private _refreshing: Promise<void> | undefined;
    private readonly _disposables: vscode.Disposable[] = [];
    private _enabled = true;

    constructor(
        private readonly _git: GitService,
        private readonly _onCommitted: () => void
    ) {
        this._enabled = vscode.workspace.getConfiguration('idea-git').get<boolean>('scm.enabled', true);

        this._disposables.push(
            vscode.commands.registerCommand('idea-git.scmStage', (item: ChangeItem) => this._stage(item)),
            vscode.commands.registerCommand('idea-git.scmUnstage', (item: ChangeItem) => this._unstage(item)),
            vscode.commands.registerCommand('idea-git.scmDiscard', (item: ChangeItem) => this._discard(item)),
            vscode.commands.registerCommand('idea-git.scmStageAll', () => this._stageAll()),
            vscode.commands.registerCommand('idea-git.scmUnstageAll', () => this._unstageAll()),
            vscode.commands.registerCommand('idea-git.scmDiscardAll', () => this._discardAll()),
            vscode.commands.registerCommand('idea-git.scmRefresh', () => this.refresh()),
            vscode.commands.registerCommand('idea-git.scmCommit', () => this._commit()),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (!e.affectsConfiguration('idea-git.scm.enabled')) {return;}
                this._enabled = vscode.workspace.getConfiguration('idea-git').get<boolean>('scm.enabled', true);
                if (this._enabled) {
                    void this.refresh();
                } else {
                    this._clearGroups();
                }
            }),
            // Any cache invalidation means git state moved (our own mutation or an
            // external write caught by the repository watcher).
            this._git.onDidChangeState(() => this.scheduleRefresh()),
            this._git.watchRepositoryChanges()
        );

        void this.refresh();
    }

    /** Refresh at most once per burst of git writes (status costs a subprocess). */
    scheduleRefresh(delayMs = 250): void {
        if (this._refreshTimer) {clearTimeout(this._refreshTimer);}
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = undefined;
            void this.refresh();
        }, delayMs);
    }

    async refresh(): Promise<void> {
        if (!this._enabled) {return;}
        if (this._refreshing) {
            // Collapse concurrent refreshes: a fresh read right after one in flight
            // would spawn a second `git status` for the same answer.
            await this._refreshing;
        }
        this._refreshing = this._refreshNow().finally(() => { this._refreshing = undefined; });
        return this._refreshing;
    }

    private async _refreshNow(): Promise<void> {
        const root = this._git.repositoryPath;
        if (!root) {
            this._disposeSourceControl();
            return;
        }
        this._ensureSourceControl(root);

        let entries: StatusEntry[] = [];
        try {
            entries = await this._git.getStatusEntries();
        } catch (error) {
            logger.warn('[GitCharm] SCM status failed:', error);
        }
        this._entries = entries.filter(entry => !entry.ignored);
        this._render(root);
    }

    private _ensureSourceControl(root: string): void {
        if (this._scm) {
            if (this._scm.rootUri?.fsPath !== root) {
                // Repository created/moved (git init, workspace change): rebuild.
                this._disposeSourceControl();
            } else {
                return;
            }
        }

        const scm = vscode.scm.createSourceControl(SCM_PROVIDER_ID, t('scm.providerLabel'), vscode.Uri.file(root));
        scm.acceptInputCommand = { command: 'idea-git.scmCommit', title: t('scm.commitButton') };
        scm.inputBox.placeholder = t('scm.inputPlaceholder');
        scm.quickDiffProvider = {
            provideOriginalResource: uri => this._provideOriginalResource(uri)
        };

        const groups = new Map<string, vscode.SourceControlResourceGroup>();
        for (const [id, label] of [
            [GROUP_STAGED, t('scm.groupStaged')],
            [GROUP_WORKING, t('scm.groupWorking')],
            [GROUP_UNMERGED, t('scm.groupUnmerged')]
        ] as Array<[string, string]>) {
            groups.set(id, scm.createResourceGroup(id, label));
        }

        this._scm = scm;
        this._groups = groups;
    }

    private _provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
        if (uri.scheme !== 'file') {return undefined;}
        const base = this._originalRefs.get(uri.fsPath);
        if (!base) {return undefined;}
        return gitBlobUri(base.ref, base.rel);
    }

    /**
     * Version a file is compared against: worktree changes diff with the index,
     * staged changes with HEAD (a staged rename with its pre-rename path),
     * conflicts with the merge base. Untracked files have no stored version.
     */
    private _baseFor(groupId: string, entry: StatusEntry): BlobRef | undefined {
        if (groupId === GROUP_UNMERGED) {return { ref: indexStage(1), rel: entry.path };}
        if (groupId === GROUP_WORKING && !entry.untracked) {return { ref: INDEX_REF, rel: entry.path };}
        if (groupId === GROUP_STAGED) {return { ref: 'HEAD', rel: entry.fromPath ?? entry.path };}
        return undefined;
    }

    private _render(root: string): void {
        const staged: ChangeItem[] = [];
        const working: ChangeItem[] = [];
        const unmerged: ChangeItem[] = [];
        const originals = new Map<string, BlobRef>();

        for (const entry of this._entries) {
            const filePath = absolutePath(root, entry.path);
            if (entry.conflicted) {
                unmerged.push(this._item(GROUP_UNMERGED, entry, root));
                originals.set(filePath, { ref: indexStage(1), rel: entry.path });
                continue;
            }
            // An entry can be staged and further modified in the worktree (MM);
            // it belongs to both groups. The gutter diff follows the file itself,
            // so an unstaged change always compares against the index.
            if (entry.indexStatus !== ' ') {
                staged.push(this._item(GROUP_STAGED, entry, root));
            }
            if (entry.worktreeStatus !== ' ' || entry.untracked) {
                working.push(this._item(GROUP_WORKING, entry, root));
                if (!entry.untracked) {
                    originals.set(filePath, { ref: INDEX_REF, rel: entry.path });
                }
            } else if (entry.indexStatus !== ' ') {
                originals.set(filePath, { ref: 'HEAD', rel: entry.fromPath ?? entry.path });
            }
        }

        this._originalRefs = originals;
        this._fill(GROUP_STAGED, staged);
        this._fill(GROUP_WORKING, working);
        this._fill(GROUP_UNMERGED, unmerged);
        if (this._scm) {
            this._scm.count = staged.length + working.length + unmerged.length;
        }
    }

    private _fill(groupId: string, items: ChangeItem[]): void {
        const group = this._groups?.get(groupId);
        if (!group) {return;}
        group.resourceStates = items;
    }

    private _clearGroups(): void {
        for (const group of this._groups?.values() ?? []) {
            group.resourceStates = [];
        }
        if (this._scm) {this._scm.count = 0;}
        this._originalRefs = new Map();
    }

    private _item(groupId: string, entry: StatusEntry, root: string): ChangeItem {
        const fileUri = vscode.Uri.file(absolutePath(root, entry.path));
        const rel = entry.path;
        const label = entry.untracked
            ? t('scm.labelUntracked')
            : entry.conflicted
                ? t('scm.labelConflict')
                : entry.indexStatus === 'R' || entry.worktreeStatus === 'R'
                    ? t('scm.labelRenamed')
                    : entry.worktreeStatus === 'D' || entry.indexStatus === 'D'
                        ? t('scm.labelDeleted')
                        : entry.indexStatus === 'A'
                            ? t('scm.labelAdded')
                            : t('scm.labelModified');
        const tooltip = entry.fromPath
            ? `${entry.fromPath} → ${rel} · ${label}`
            : `${rel} · ${label}`;

        return {
            groupId,
            relativePath: rel,
            fromPath: entry.fromPath,
            resourceUri: fileUri,
            decorations: {
                iconPath: new vscode.ThemeIcon(iconFor(groupId, entry)),
                strikeThrough: entry.worktreeStatus === 'D' || entry.indexStatus === 'D',
                tooltip
            },
            command: {
                title: t('scm.openChange'),
                command: 'vscode.diff',
                arguments: [this._diffBase(groupId, entry), fileUri, tooltip]
            }
        };
    }

    /**
     * Left side of the diff opened on click. Untracked files have no stored
     * version: an empty ref renders as an empty document, so the whole file
     * reads as added.
     */
    private _diffBase(groupId: string, entry: StatusEntry): vscode.Uri {
        const base = this._baseFor(groupId, entry);
        return base ? gitBlobUri(base.ref, base.rel) : gitBlobUri('', entry.path);
    }

    private _pathsOf(items: ChangeItem[]): string[] {
        const paths: string[] = [];
        for (const item of items) {
            // A rename occupies two index entries; staging one stages both.
            if (item.fromPath) {paths.push(item.fromPath);}
            paths.push(item.relativePath);
        }
        return paths;
    }

    private async _run(label: string, work: () => Promise<void>): Promise<void> {
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.SourceControl, title: label },
                async () => { await work(); }
            );
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(reason);
            // A failed mutation may still have touched the index; re-read state.
            void this.refresh();
        }
        // Success is handled by GitService.onDidChangeState -> scheduleRefresh.
    }

    private async _stage(item?: ChangeItem): Promise<void> {
        if (!item) {return;}
        const paths = this._pathsOf([item]);
        await this._run(t('scm.staging'), () => this._git.stage(paths));
    }

    private async _unstage(item?: ChangeItem): Promise<void> {
        if (!item) {return;}
        const paths = this._pathsOf([item]);
        await this._run(t('scm.unstaging'), () => this._git.unstage(paths));
    }

    private async _discard(item?: ChangeItem): Promise<void> {
        if (!item) {return;}
        const entry = this._entries.find(e => e.path === item.relativePath);
        if (!entry) {return;}
        if (!(await this._confirmDiscard(1))) {return;}
        await this._run(t('scm.discarding'), () => this._git.discard([entry]));
    }

    private async _stageAll(): Promise<void> {
        const items = this._groups?.get(GROUP_WORKING)?.resourceStates as ChangeItem[] | undefined;
        if (!items || items.length === 0) {return;}
        const paths = this._pathsOf(items);
        await this._run(t('scm.staging'), () => this._git.stage(paths));
    }

    private async _unstageAll(): Promise<void> {
        const items = this._groups?.get(GROUP_STAGED)?.resourceStates as ChangeItem[] | undefined;
        if (!items || items.length === 0) {return;}
        const paths = this._pathsOf(items);
        await this._run(t('scm.unstaging'), () => this._git.unstage(paths));
    }

    private async _discardAll(): Promise<void> {
        const items = this._groups?.get(GROUP_WORKING)?.resourceStates as ChangeItem[] | undefined;
        if (!items || items.length === 0) {return;}
        if (!(await this._confirmDiscard(items.length))) {return;}
        const wanted = new Set(items.map(item => item.relativePath));
        const entries = this._entries.filter(entry => wanted.has(entry.path));
        await this._run(t('scm.discarding'), () => this._git.discard(entries));
    }

    /** Discarding untracked files deletes them, so ask first. */
    private async _confirmDiscard(count: number): Promise<boolean> {
        const pick = await vscode.window.showWarningMessage(
            t('scm.discardConfirm', { count }),
            { modal: true },
            t('scm.discardBtn')
        );
        return pick === t('scm.discardBtn');
    }

    private async _commit(): Promise<void> {
        const scm = this._scm;
        if (!scm) {return;}
        const message = scm.inputBox.value.trim();
        if (!message) {
            vscode.window.showWarningMessage(t('scm.messageRequired'));
            return;
        }
        if (this._entries.some(entry => entry.conflicted)) {
            vscode.window.showWarningMessage(t('scm.resolveConflictsFirst'));
            return;
        }
        try {
            const out = await this._git.commit(message);
            scm.inputBox.value = '';
            const first = (out || '').split('\n')[0];
            vscode.window.showInformationMessage(t('commit.success', { detail: first ? `: ${first}` : '' }));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(t('scm.commitFailed', { error: reason }));
        }
        await this.refresh();
        this._onCommitted();
    }

    private _disposeSourceControl(): void {
        this._scm?.dispose();
        this._scm = undefined;
        this._groups = undefined;
        this._originalRefs = new Map();
    }

    dispose(): void {
        if (this._refreshTimer) {clearTimeout(this._refreshTimer);}
        for (const d of this._disposables) {d.dispose();}
        this._disposeSourceControl();
    }
}

function iconFor(groupId: string, entry: StatusEntry): string {
    if (groupId === GROUP_UNMERGED) {return 'error';}
    if (entry.untracked) {return 'diff-added';}
    const code = entry.indexStatus !== ' ' ? entry.indexStatus : entry.worktreeStatus;
    switch (code) {
        case 'A': return 'diff-added';
        case 'D': return 'diff-removed';
        case 'R': return 'diff-renamed';
        case 'C': return 'diff-renamed';
        default: return 'diff-modified';
    }
}

function absolutePath(root: string, rel: string): string {
    return path.join(root, rel.split('/').join(path.sep));
}
