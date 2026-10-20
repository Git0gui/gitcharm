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
