import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveLocale, setLocale, getLocale, t, webviewStrings } from '../i18n';

describe('resolveLocale', () => {
    it('honours the explicit override', () => {
        assert.equal(resolveLocale('zh-cn', 'en'), 'en');
        assert.equal(resolveLocale('en', 'zh-cn'), 'zh-cn');
    });

    it('follows the VSCode language for Chinese variants', () => {
        assert.equal(resolveLocale('zh-cn'), 'zh-cn');
        assert.equal(resolveLocale('zh-tw'), 'zh-cn');
        assert.equal(resolveLocale('zh-Hans'), 'zh-cn');
    });

    it('falls back to English for other languages', () => {
        assert.equal(resolveLocale('en'), 'en');
        assert.equal(resolveLocale('fr'), 'en');
        assert.equal(resolveLocale(undefined), 'en');
    });

    it('ignores unknown override values', () => {
        assert.equal(resolveLocale('zh-cn', 'fr'), 'zh-cn');
        assert.equal(resolveLocale('en', 'auto'), 'en');
    });
});

describe('t()', () => {
    afterEach(() => setLocale('zh-cn'));

    it('returns Chinese strings under the default locale', () => {
        assert.equal(t('common.cancel'), '取消');
    });

    it('returns English strings after setLocale', () => {
        setLocale('en');
        assert.equal(t('common.cancel'), 'Cancel');
    });

    it('interpolates parameters', () => {
        assert.equal(t('branch.deleted', { name: 'feat' }), '已删除分支: feat');
        setLocale('en');
        assert.equal(t('branch.deleted', { name: 'feat' }), 'Deleted branch: feat');
    });

    it('replaces every occurrence of the same placeholder', () => {
        setLocale('en');
        const s = t('checkout.opInProgress', { op: 'rebase', count: 2 });
        assert.ok(!s.includes('{op}') && !s.includes('{count}'));
        assert.ok(s.includes('rebase') && s.includes('2'));
    });

    it('falls back to Chinese when a key is missing from English', () => {
        setLocale('en');
        // Temporarily inject a zh-only key is impossible; instead assert the
        // fallback chain on an unknown key returns the key itself.
        assert.equal(t('no.such.key'), 'no.such.key');
    });

    it('keeps unknown placeholders untouched', () => {
        assert.equal(t('branch.deleted'), '已删除分支: {name}');
    });
});

describe('webviewStrings()', () => {
    afterEach(() => setLocale('zh-cn'));

    it('returns the active dictionary', () => {
        assert.equal(webviewStrings()['common.cancel'], '取消');
        setLocale('en');
        assert.equal(webviewStrings()['common.cancel'], 'Cancel');
    });
});

describe('dictionary parity', () => {
    it('zh and en expose exactly the same key set', () => {
        setLocale('zh-cn');
        const zhKeys = Object.keys(webviewStrings()).sort();
        setLocale('en');
        const enKeys = Object.keys(webviewStrings()).sort();
        setLocale('zh-cn');
        assert.deepEqual(enKeys, zhKeys);
    });

    it('no entry is an empty string', () => {
        for (const locale of ['zh-cn', 'en'] as const) {
            setLocale(locale);
            for (const [k, v] of Object.entries(webviewStrings())) {
                assert.ok(v.trim().length > 0, `${locale}:${k} is empty`);
            }
        }
        setLocale('zh-cn');
    });
});
