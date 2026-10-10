import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { compileIconTheme, FileIconPack, LanguageRules } from './fileIconTheme';
import { logger } from './logger';

/**
 * Locates the active file-icon theme (built-in or installed) and compiles it into
 * a pack the webview can match against. Themes that ship SVG/PNG files and themes
 * that ship an icon font (the default vs-seti) are both supported.
 */

interface ThemeLocation {
    dir: string;
    jsonPath: string;
    root: string;
}

let locationCache: { themeId: string; found: ThemeLocation | undefined } | undefined;
let jsonCache: { jsonPath: string; mtimeMs: number; raw: unknown } | undefined;
let languageCache: LanguageRules | undefined;

/** The configured theme id, or undefined when icons are disabled. */
function activeThemeId(): string | undefined {
    const id = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme');
    if (!id || id === 'none') {return undefined;}
    return id;
}

function isLightColorTheme(): boolean {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
}

function locateTheme(themeId: string): ThemeLocation | undefined {
    if (locationCache?.themeId === themeId) {return locationCache.found;}
    let found: ThemeLocation | undefined;
    for (const ext of vscode.extensions.all) {
        const themes: Array<{ id?: string; path?: string }> = ext.packageJSON?.contributes?.iconThemes ?? [];
        const entry = themes.find(t => t?.id === themeId);
        if (!entry?.path) {continue;}
        const root = ext.extensionUri.fsPath;
        const jsonPath = path.resolve(root, entry.path.replace(/^\.\//, ''));
        // A theme must not reach outside its own folder.
        if (!jsonPath.startsWith(root + path.sep) && jsonPath !== root) {continue;}
        found = { dir: path.dirname(jsonPath), jsonPath, root };
        break;
    }
    locationCache = { themeId, found };
    return found;
}

function readThemeJson(jsonPath: string): unknown | undefined {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(jsonPath);
    } catch (error) {
        logger.debug('[GitCharm] icon theme JSON not readable:', jsonPath, error);
        return undefined;
    }
    if (jsonCache?.jsonPath === jsonPath && jsonCache.mtimeMs === stat.mtimeMs) {
        return jsonCache.raw;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        jsonCache = { jsonPath, mtimeMs: stat.mtimeMs, raw };
        return raw;
    } catch (error) {
        logger.debug('[GitCharm] icon theme JSON is not valid:', jsonPath, error);
        return undefined;
    }
}

/** Folder that must be granted to the webview so theme assets can be loaded. */
export function iconThemeResourceRoot(): vscode.Uri | undefined {
    const themeId = activeThemeId();
    if (!themeId) {return undefined;}
    const located = locateTheme(themeId);
    return located ? vscode.Uri.file(located.root) : undefined;
}

/**
 * Maps every language id to the file names and extensions it owns, read from the
 * installed extensions' `contributes.languages` manifests. The manifests are already
 * loaded by the extension host, so this is one in-memory pass over the registry.
 */
function languageRules(): LanguageRules {
    if (languageCache) {return languageCache;}
    const extensions: Record<string, string[]> = {};
    const fileNames: Record<string, string[]> = {};
    const langs: Array<{ id?: string; extensions?: string[]; filenames?: string[] }> = [];
    for (const ext of vscode.extensions.all) {
        const contributed = ext.packageJSON?.contributes?.languages;
        if (Array.isArray(contributed)) {langs.push(...contributed);}
    }
    for (const lang of langs) {
        if (typeof lang?.id !== 'string') {continue;}
        const id = lang.id.toLowerCase();
        for (const raw of lang.extensions ?? []) {
            const ext = raw.replace(/^\./, '').toLowerCase();
            if (!ext || ext.includes('*') || ext.includes('?')) {continue;}
            (extensions[id] ??= []).push(ext);
        }
        for (const raw of lang.filenames ?? []) {
            const name = raw.toLowerCase();
            if (!name || name.includes('*') || name.includes('?')) {continue;}
            (fileNames[id] ??= []).push(name);
        }
    }
    languageCache = { extensions, fileNames };
    return languageCache;
}

/**
 * @param toUrl converts an absolute asset path into a webview-loadable URI
 *              (undefined when the webview may not load it)
 */
export function getFileIconPack(toUrl: (absolutePath: string) => string | undefined): FileIconPack | undefined {
    const themeId = activeThemeId();
    if (!themeId) {return undefined;}
    const located = locateTheme(themeId);
    if (!located) {
        logger.debug('[GitCharm] no extension contributes icon theme:', themeId);
        return undefined;
    }
    const raw = readThemeJson(located.jsonPath);
    if (!raw) {return undefined;}
    try {
        const pack = compileIconTheme(raw, located.dir, { light: isLightColorTheme(), toUrl, languages: languageRules() });
        logger.debug('[GitCharm] file icon theme compiled:', themeId, pack ? Object.keys(pack.defs).length : 0, 'definitions');
        return pack;
    } catch (error) {
        logger.debug('[GitCharm] failed to compile icon theme:', themeId, error);
        return undefined;
    }
}

/** Drop cached theme lookup and parsed JSON (theme or colour scheme changed). */
export function invalidateFileIconCache(): void {
    locationCache = undefined;
    jsonCache = undefined;
    languageCache = undefined;
}
