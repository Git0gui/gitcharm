import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { compileIconTheme, fontCharacterToGlyph } from '../services/fileIconTheme';

const ALL = (abs: string): string => 'vscode://' + abs.replace(/\\/g, '/');
const NONE = (): string | undefined => undefined;
const BS = String.fromCharCode(92);
const GLYPH_E001 = String.fromCodePoint(0xE001);
const GLYPH_E002 = String.fromCodePoint(0xE002);
const GLYPH_E003 = String.fromCodePoint(0xE003);
const GLYPH_E099 = String.fromCodePoint(0xE099);

describe('fontCharacterToGlyph', () => {
    it('decodes CSS-style hex escapes', () => {
        assert.equal(fontCharacterToGlyph(BS + 'E001'), GLYPH_E001);
        assert.equal(fontCharacterToGlyph('E001'), GLYPH_E001);
        assert.equal(fontCharacterToGlyph('uE001'), GLYPH_E001);
    });

    it('rejects malformed or out-of-range values', () => {
        assert.equal(fontCharacterToGlyph(undefined), undefined);
        assert.equal(fontCharacterToGlyph(''), undefined);
        assert.equal(fontCharacterToGlyph('xyz'), undefined);
        assert.equal(fontCharacterToGlyph(BS + '1'), undefined);
    });
});

describe('compileIconTheme', () => {
    it('returns undefined without icon definitions', () => {
        assert.equal(compileIconTheme({}, 'C:/theme', { light: false, toUrl: ALL }), undefined);
        assert.equal(compileIconTheme(null, 'C:/theme', { light: false, toUrl: ALL }), undefined);
    });

    it('resolves svg definitions and drops rules pointing at missing files', () => {
        const raw = {
            iconDefinitions: {
                _ts: { iconPath: './icons/ts.svg' },
                _gone: { iconPath: './icons/missing.svg' }
            },
            file: '_ts',
            fileExtensions: { ts: '_ts', foo: '_gone' }
        };
        const seen: string[] = [];
        const pack = compileIconTheme(raw, 'C:/theme', {
            light: false,
            toUrl: p => (p.includes('missing') ? undefined : (seen.push(p), ALL(p)))
        });
        assert.ok(pack);
        assert.deepEqual(Object.keys(pack.defs), ['_ts']);
        assert.equal(pack.fileExtensions.ts, '_ts');
        assert.equal(pack.fileExtensions.foo, undefined);
        assert.equal(pack.file, '_ts');
        assert.equal(seen[0], 'C:/theme/icons/ts.svg');
    });

    it('normalises glyph definitions and keeps their colour', () => {
        const raw = {
            iconDefinitions: { _ts: { fontCharacter: BS + 'E099', fontColor: '#519aba' } },
            fileExtensions: { TS: '_ts' }
        };
        const pack = compileIconTheme(raw, '/theme', { light: false, toUrl: NONE });
        assert.ok(pack);
        assert.deepEqual(pack.defs._ts, { glyph: GLYPH_E099, color: '#519aba' });
        assert.equal(pack.fileExtensions.ts, '_ts');
    });

    it('merges light overrides over the dark rules', () => {
        const raw = {
            iconDefinitions: { _ts: { fontCharacter: BS + 'E001' }, _ts_l: { fontCharacter: BS + 'E002' } },
            fileExtensions: { ts: '_ts' },
            light: { fileExtensions: { ts: '_ts_l' }, file: '_ts_l' },
            file: '_ts'
        };
        const dark = compileIconTheme(raw, '/theme', { light: false, toUrl: NONE });
        const light = compileIconTheme(raw, '/theme', { light: true, toUrl: NONE });
        assert.equal(dark?.fileExtensions.ts, '_ts');
        assert.equal(light?.fileExtensions.ts, '_ts_l');
        assert.equal(dark?.file, '_ts');
        assert.equal(light?.file, '_ts_l');
    });

    it('registers the icon font for glyph themes', () => {
        const raw = {
            fonts: [{ id: 'seti', src: [{ path: './seti.woff', format: 'woff' }] }],
            iconDefinitions: { _default: { fontCharacter: BS + 'E001' } },
            file: '_default'
        };
        const pack = compileIconTheme(raw, 'C:\\theme\\icons', { light: false, toUrl: ALL });
        assert.ok(pack);
        assert.equal(pack.file, '_default');
        assert.deepEqual(pack.font, { family: 'gitcharm-seti', url: 'vscode://C:/theme/icons/seti.woff' });
    });

    it('expands languageIds into the file names and extensions that language owns', () => {
        const raw = {
            iconDefinitions: {
                _ts: { fontCharacter: BS + 'E001' },
                _json: { fontCharacter: BS + 'E002' },
                _vue: { fontCharacter: BS + 'E003' }
            },
            fileExtensions: { ts: '_vue' },
            languageIds: { typescript: '_ts', json: '_json' }
        };
        const languages = {
            extensions: { typescript: ['ts', 'cts', 'mts'], json: ['json', 'jsonc'] },
            fileNames: { json: ['package.json', 'tsconfig.json'] }
        };
        const pack = compileIconTheme(raw, '/theme', { light: false, toUrl: NONE, languages });
        assert.ok(pack);
        // An explicit extension rule wins over the language-derived one.
        assert.equal(pack.fileExtensions.ts, '_vue');
        assert.equal(pack.fileExtensions.cts, '_ts');
        assert.equal(pack.fileExtensions.mts, '_ts');
        assert.equal(pack.fileExtensions.jsonc, '_json');
        assert.equal(pack.fileNames['package.json'], '_json');
        assert.equal(pack.fileNames['tsconfig.json'], '_json');
        assert.equal(pack.defs._vue.glyph, GLYPH_E003);
    });

    it('keeps only the definitions a rule actually reaches', () => {
        const raw = {
            iconDefinitions: {
                _ts: { fontCharacter: BS + 'E001' },
                _unused: { fontCharacter: BS + 'E003' }
            },
            languageIds: { typescript: '_ts' }
        };
        const withoutMap = compileIconTheme(raw, '/theme', { light: false, toUrl: NONE });
        assert.equal(withoutMap, undefined, 'languageIds alone are unusable without a language map');
        const pack = compileIconTheme(raw, '/theme', {
            light: false,
            toUrl: NONE,
            languages: { extensions: { typescript: ['ts'] }, fileNames: {} }
        });
        assert.deepEqual(Object.keys(pack?.defs || {}), ['_ts']);
    });

    it('returns undefined when every definition is unresolvable', () => {
        const raw = {
            iconDefinitions: { _ts: { iconPath: './a.svg' } },
            fileExtensions: { ts: '_ts' }
        };
        assert.equal(compileIconTheme(raw, '/theme', { light: false, toUrl: NONE }), undefined);
    });
});
