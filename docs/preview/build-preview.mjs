import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Generate preview.html from the extension's OWN webview template, so the
 * standalone preview can never drift from the real DOM skeleton.
 * Usage: node docs/preview/build-preview.mjs [--en]
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);

const locale = process.argv.includes('--en') ? 'en' : 'zh-cn';
const i18n = require(path.join(root, 'out/i18n/index.js'));
i18n.setLocale(locale);

const ts = readFileSync(path.join(root, 'src/views/graphView.ts'), 'utf8');
const marker = 'return `<!DOCTYPE html>';
const start = ts.indexOf(marker);
if (start < 0) throw new Error('webview template not found in graphView.ts');
const open = ts.indexOf('`', start); // the template's opening backtick
const body = ts.slice(open + 1);

// Find the template's closing backtick, stepping over ${...} interpolations.
let end = -1;
let depth = 0;
for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '$' && body[i + 1] === '{') { depth++; i++; continue; }
    if (depth > 0 && ch === '}') { depth--; continue; }
    if (ch === '`' && depth === 0) { end = i; break; }
}
if (end < 0) throw new Error('unterminated webview template literal');

// Any new ${...} in the template must be added to this signature as well,
// otherwise the generated function throws ReferenceError at build time.
const render = new Function(
    'cssUri', 'jsUri', 'nonce', 'payloadJson', 'i18nJson', 'htmlLang', 't', 'csp',
    'return `' + body.slice(0, end) + '`'
);

const html = render(
    '../../media/webview.css',
    '../../media/webview.js',
    'preview',
    // Interpolated literally into `window.__INITIAL__=...`, so this may be an
    // expression: the scene is chosen at load time by mock.js.
    '(window.__PREVIEW__&&window.__PREVIEW__.initial())||{}',
    JSON.stringify(i18n.webviewStrings()).replace(/</g, '\\u003c'),
    locale === 'zh-cn' ? 'zh-CN' : 'en',
    i18n.t,
    // No Content-Security-Policy here: this page loads media/ over relative file
    // URLs, which a strict policy would block. The real webview gets the policy.
    ''
);

const out = html
    .replace('<link rel="stylesheet" href="../../media/webview.css">',
        '<link rel="stylesheet" href="../../media/webview.css">\n    <link rel="stylesheet" href="./theme-dark.css">')
    .replace('<script nonce="preview">window.__INITIAL__=',
        '<script src="./mock.js"></script>\n    <script nonce="preview">window.__INITIAL__=')
    .replace('<script nonce="preview" src="../../media/webview.js"></script>',
        '<script src="./harness.js"></script>\n    <script nonce="preview" src="../../media/webview.js"></script>');

writeFileSync(path.join(root, 'docs/preview/preview.html'), out);
console.log('wrote docs/preview/preview.html', locale, out.length, 'bytes');
