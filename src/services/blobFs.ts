import * as vscode from 'vscode';
import { GitService } from './gitService';
import { logger } from './logger';

/**
 * Read-only view of a file at a git revision, opened as a real editor tab.
 *
 * The `idea-git-diff` content provider feeds `vscode.diff` and cannot promise a
 * read-only document — a `TextDocumentContentProvider` tab is editable in
 * principle and saving it goes nowhere. Registering a file system provider with
 * `isReadonly: true` is the supported way to say "this text is history, do not
 * type into it", which is what a reader of a deleted or long-gone file needs.
 *
 * URI shape: `idea-git-blob:/<repo-relative path>?ref=<rev>`.
 */
export class GitBlobFileSystemProvider implements vscode.FileSystemProvider {
    private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._onDidChangeFile.event;

    /**
     * A revision's content can never change, so `stat` (which VS Code calls
     * before `readFile`) shares its bytes with the read instead of spawning
     * `git show` twice for one tab.
     */
    private readonly _cache = new Map<string, Uint8Array>();

    constructor(private readonly _gitService: GitService) {}

    static readonly scheme = 'idea-git-blob';

    static uri(ref: string, filePath: string): vscode.Uri {
        return vscode.Uri.from({
            scheme: GitBlobFileSystemProvider.scheme,
            path: '/' + filePath,
            query: 'ref=' + encodeURIComponent(ref)
        });
    }

    watch(): vscode.Disposable {
        // Nothing to watch: the bytes of a commit are fixed.
        return new vscode.Disposable(() => { /* no-op */ });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const content = await this._read(uri);
        return {
            type: vscode.FileType.File,
            ctime: 0,
            mtime: 0,
            size: content.byteLength,
            permissions: vscode.FilePermission.Readonly
        };
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        return await this._read(uri);
    }

    readDirectory(uri: vscode.Uri): never {
        throw vscode.FileSystemError.FileNotADirectory(uri);
    }

    createDirectory(uri: vscode.Uri): never {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    writeFile(uri: vscode.Uri): never {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    delete(uri: vscode.Uri): never {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    rename(oldUri: vscode.Uri): never {
        throw vscode.FileSystemError.NoPermissions(oldUri);
    }

    private async _read(uri: vscode.Uri): Promise<Uint8Array> {
        const { ref, filePath } = GitBlobFileSystemProvider._parse(uri);
        const key = `${ref}\u0000${filePath}`;
        const hit = this._cache.get(key);
        if (hit) {return hit;}
        let text: string;
        try {
            text = await this._gitService.readBlob(ref, filePath);
        } catch (err) {
            // Surfaces as the workbench's "file not found" page; the command that
            // opened the tab already told the user what went wrong.
            logger.debug(`blob read failed for ${ref}:${filePath}: ${(err as Error)?.message ?? err}`);
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        const bytes = Buffer.from(text, 'utf8');
        if (this._cache.size >= 64) {
            const oldest = this._cache.keys().next().value;
            if (oldest !== undefined) {this._cache.delete(oldest);}
        }
        this._cache.set(key, bytes);
        return bytes;
    }

    /**
     * `uri.path` is already decoded and `URLSearchParams` decodes the query, so
     * neither side may be run through `decodeURIComponent` again — a file really
     * named `100%.md` would throw and leave the tab blank.
     */
    private static _parse(uri: vscode.Uri): { ref: string; filePath: string } {
        const ref = new URLSearchParams(uri.query).get('ref') ?? '';
        const filePath = uri.path.replace(/^\/+/, '');
        return { ref, filePath };
    }

    dispose(): void {
        this._cache.clear();
        this._onDidChangeFile.dispose();
    }
}
