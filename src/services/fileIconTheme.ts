/**
 * Compiles a VSCode file-icon-theme JSON into a small pack the webview can match
 * against by itself. Pure module (no vscode import) so it is unit-testable.
 *
 * Two icon flavours exist in the wild: SVG/PNG files (Material, vscode-icons,
 * Modern Icons) and icon fonts (the built-in default vs-seti uses seti.woff with
 * fontCharacter + fontColor per definition). Both are normalised to one shape.
 */

export interface FileIconDef {
    /** Absolute resource URI already converted for webview use. */
    url?: string;
    /** Glyph for font-based themes, as the character itself. */
    glyph?: string;
    /** Glyph colour for font-based themes. */
    color?: string;
}

export interface FileIconPack {
    /** Font face to register before glyph icons can render. */
    font?: { family: string; url: string };
    defs: Record<string, FileIconDef>;
    /** lowercased exact file name -> def id */
    fileNames: Record<string, string>;
    /** lowercased extension (may contain dots, e.g. "d.ts") -> def id */
    fileExtensions: Record<string, string>;
    /** fallback */
    file?: string;
}

/**
 * The explorer resolves a file icon through the file's language, so a theme's
 * `languageIds` block is only usable once each language id is expanded back into
 * the file names and extensions that language owns.
 */
export interface LanguageRules {
    /** lowercased language id -> extensions without the leading dot */
    extensions: Record<string, string[]>;
    /** lowercased language id -> exact file names */
    fileNames: Record<string, string[]>;
}

export interface CompileOptions {
    /** Merge the theme's "light" overrides (active colour theme is light). */
    light: boolean;
    /** Resolve a theme-relative icon file to a webview-loadable URI; undefined drops the def. */
    toUrl: (absolutePath: string) => string | undefined;
    /** Built-in language contributions used to expand `languageIds`. */
    languages?: LanguageRules;
}

type RawMap = Record<string, string> | undefined;

interface RawTheme {
    fonts?: Array<{ id?: string; src?: Array<{ path?: string; format?: string }> }>;
    iconDefinitions?: Record<string, { iconPath?: string; fontCharacter?: string; fontColor?: string } | undefined>;
    file?: string;
    fileNames?: RawMap;
    fileExtensions?: RawMap;
    languageIds?: RawMap;
    light?: {
        file?: string;
        fileNames?: RawMap;
        fileExtensions?: RawMap;
        languageIds?: RawMap;
    };
    highContrast?: unknown;
}

/** Turns a CSS-style escape ("\\E001", "E001") into the character it denotes. */
export function fontCharacterToGlyph(raw: string | undefined): string | undefined {
    if (!raw) {return undefined;}
    const hex = raw.replace(/^\\+/, '').replace(/^u/i, '');
    if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) {return undefined;}
    const code = parseInt(hex, 16);
    if (code < 0x20 || code > 0x10FFFF) {return undefined;}
    try {
        return String.fromCodePoint(code);
    } catch {
        return undefined;
    }
}

/** Lowercases keys and drops entries whose definition cannot be resolved. */
function addRules(target: Record<string, string>, source: RawMap, keep: (defId: string) => boolean): void {
    if (!source) {return;}
    for (const [key, defId] of Object.entries(source)) {
        if (typeof defId !== 'string' || !keep(defId)) {continue;}
        target[key.toLowerCase()] = defId;
    }
}

/**
 * @param raw parsed theme JSON
 * @param baseDir directory holding the theme JSON, used to resolve iconPath
 */
export function compileIconTheme(raw: unknown, baseDir: string, opts: CompileOptions): FileIconPack | undefined {
    const theme = raw as RawTheme;
    if (!theme || typeof theme !== 'object' || !theme.iconDefinitions) {return undefined;}

    const sep = baseDir.includes('\\') ? '\\' : '/';
    const join = (rel: string): string => {
        const clean = rel.replace(/^\.\//, '').replace(/^[\\/]/, '');
        return baseDir.endsWith(sep) ? baseDir + clean : baseDir + sep + clean;
    };

    const defs: Record<string, FileIconDef> = {};
    const keep = (defId: string): boolean => resolveDef(defId) !== undefined;

    function resolveDef(defId: string): FileIconDef | undefined {
        if (defs[defId]) {return defs[defId];}
        const entry = theme.iconDefinitions?.[defId];
        if (!entry) {return undefined;}
        const out: FileIconDef = {};
        if (typeof entry.iconPath === 'string' && entry.iconPath) {
            const url = opts.toUrl(join(entry.iconPath));
            if (!url) {return undefined;}
            out.url = url;
        } else {
            const glyph = fontCharacterToGlyph(entry.fontCharacter);
            if (!glyph) {return undefined;}
            out.glyph = glyph;
            if (typeof entry.fontColor === 'string' && entry.fontColor) {out.color = entry.fontColor;}
        }
        defs[defId] = out;
        return out;
    }

    const light = theme.light;
    const pick = <T>(main: T | undefined, lightValue: T | undefined): T | undefined =>
        opts.light && lightValue !== undefined ? lightValue : main;

    const pack: FileIconPack = {
        defs,
        fileNames: {},
        fileExtensions: {}
    };

    addRules(pack.fileNames, theme.fileNames, keep);
    addRules(pack.fileExtensions, theme.fileExtensions, keep);
    if (opts.light && light) {
        addRules(pack.fileNames, light.fileNames, keep);
        addRules(pack.fileExtensions, light.fileExtensions, keep);
    }
    // Only fills gaps: an explicit extension rule in the theme always beats a
    // language-derived one, which is how the explorer resolves them too.
    const langIds = pick(theme.languageIds, light?.languageIds);
    const langs = opts.languages;
    if (langIds && langs) {
        for (const [rawLang, defId] of Object.entries(langIds)) {
            if (typeof defId !== 'string' || !keep(defId)) {continue;}
            const lang = rawLang.toLowerCase();
            for (const ext of langs.extensions[lang] ?? []) {
                if (!pack.fileExtensions[ext]) {pack.fileExtensions[ext] = defId;}
            }
            for (const name of langs.fileNames[lang] ?? []) {
                if (!pack.fileNames[name]) {pack.fileNames[name] = defId;}
            }
        }
    }

    const fileDef = pick(theme.file, light?.file);
    if (fileDef && keep(fileDef)) {pack.file = fileDef;}

    const font = theme.fonts?.[0];
    const fontSrc = font?.src?.find(s => typeof s.path === 'string' && s.path)?.path;
    if (font?.id && fontSrc) {
        const url = opts.toUrl(join(fontSrc));
        if (url) {pack.font = { family: `gitcharm-${font.id}`, url };}
    }

    // A theme whose every definition failed to resolve is useless to the webview.
    if (Object.keys(defs).length === 0) {return undefined;}
    return pack;
}
