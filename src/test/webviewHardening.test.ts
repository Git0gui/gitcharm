import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The panel renders data that every contributor to a repository controls — commit
 * messages, author names, branch and file names — and its message handlers lead to
 * commands that write. A content security policy is what keeps one missed esc() in
 * that markup from becoming code execution inside the webview.
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = path.join(ROOT, 'src', 'views', 'graphView.ts');

const source = fs.readFileSync(TEMPLATE, 'utf8');

describe('webview content security policy', () => {
    it('the webview document declares a CSP meta', () => {
        assert.ok(
            /<meta http-equiv="Content-Security-Policy"/.test(source),
            'graphView.ts must emit a Content-Security-Policy meta in the webview head'
        );
    });

    it('the policy denies everything by default', () => {
        assert.ok(/default-src 'none'/.test(source), "the policy must start from default-src 'none'");
    });

    it('scripts are nonce-only, and every script tag carries the nonce', () => {
        assert.ok(/script-src 'nonce-\$\{nonce\}'/.test(source), 'script-src must be restricted to the nonce');
        assert.ok(/<script nonce="\$\{nonce\}">/.test(source), 'the inline bootstrap script needs the nonce');
        assert.ok(/<script nonce="\$\{nonce\}" src=/.test(source), 'the external script needs the nonce');
    });

    it('the nonce is not derived from Math.random', () => {
        const nonceFn = source.match(/private _nonce\(\): string \{[\s\S]*?\n {4}\}/);
        assert.ok(nonceFn, '_nonce() must exist');
        assert.ok(!/Math\.random/.test(nonceFn[0]), 'a predictable nonce is no nonce once inline script is allowed');
        assert.ok(/randomBytes/.test(nonceFn[0]), '_nonce() must read from a cryptographic source');
    });
});

describe('webview HTML escaping', () => {
    const webview = fs.readFileSync(path.join(ROOT, 'media', 'webview.js'), 'utf8');
    const escFn = webview.match(/function esc\(t\) \{[\s\S]*?\n\}/);
    // The entity table sits next to esc() at module scope, not inside it.
    const escBlock = webview.match(/var ESC_MAP = \{[^}]*\};[\s\S]*?function esc\(t\) \{[\s\S]*?\n\}/);

    it('esc() escapes quotes as well as angle brackets', () => {
        assert.ok(escBlock, 'webview.js must define the ESC_MAP table and esc()');
        for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) {
            assert.ok(
                escBlock[0].includes(entity),
                `esc() must emit ${entity}: its output is interpolated into quoted data-* attributes, where a raw quote closes the value`
            );
        }
    });

    it('esc() does not depend on the DOM', () => {
        assert.ok(escFn, 'webview.js must define esc()');
        assert.ok(!/document\./.test(escFn[0]), 'esc() must stay a pure string transform');
    });
});
