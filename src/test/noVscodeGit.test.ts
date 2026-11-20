import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * GitCharm is independent of the built-in git extension by default: the host
 * never activates it (that used to trigger a multi-spawn cold-start scan) and
 * every capability still has a complete local implementation.
 *
 * Version 0.3.0 adds a CONTROLLED, OPTIONAL opt-in to the *public stable* API
 * v1. These guards make sure that opt-in cannot spread:
 *  - exactly one production file may name `vscode.git` / call `getExtension` /
 *    `getAPI`, and that file is constrained to `getAPI(1)` with no activation,
 *    no registration points and no module import;
 *  - no dependency is declared in the manifest;
 *  - the pure API modules stay free of `vscode` imports so node:test can load
 *    them (AGENTS.md §5).
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const HOST = path.join(SRC, 'services', 'gitApiHost.ts');
const PURE_MODULES = ['gitApiTypes.ts', 'gitApiProbe.ts', 'gitApiBackend.ts'];

/** Patterns that would spread a dependency on vscode.git beyond the host layer. */
const FORBIDDEN = ['vscode.git', 'getExtension(', 'getAPI(', 'registerVscodeGitEventListeners'];

function collectSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'test') {continue;} // this guard's own vocabulary
            files.push(...collectSourceFiles(full));
        } else if (entry.name.endsWith('.ts')) {
            files.push(full);
        }
    }
    return files;
}

/** Non-comment source lines only; documenting the constraint is always allowed. */
function codeOnly(source: string): string {
    return source.split('\n')
        .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
}

describe('controlled opt-in to the built-in Git public API', () => {
    it('only the single host layer may touch the built-in extension API', () => {
        const offenders: string[] = [];
        for (const file of collectSourceFiles(SRC)) {
            if (file === HOST) {continue;}
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, index) => {
                const hit = FORBIDDEN.find(pattern => line.includes(pattern));
                if (hit && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
                    offenders.push(`${path.relative(ROOT, file)}:${index + 1} ${hit}`);
                }
            });
        }
        assert.deepEqual(offenders, [], 'the optional API must stay confined to gitApiHost.ts');
    });

    it('the host layer uses ONLY stable public API v1', () => {
        const source = fs.readFileSync(HOST, 'utf8');
        const code = codeOnly(source);
        assert.match(code, /const GIT_API_VERSION = 1 as const;/, 'only API version 1 is public/stable');
        assert.match(code, /getAPI\(GIT_API_VERSION\)/, 'every call must go through the pinned version');
        assert.doesNotMatch(code, /getAPI\(\s*(?:2|[3-9]|\d{2,})\s*\)/, 'no v2 / proposed API');
        assert.equal((code.match(/getAPI\(/g) ?? []).length, 2, 'exactly two discovery calls');
        assert.doesNotMatch(code, /\.activate\(/, 'never activate the built-in extension ourselves');
        assert.doesNotMatch(code, /\bregister[A-Z]\w*\(/, 'no registration / extension points');
        assert.doesNotMatch(code, /from\s+['"]vscode\.git['"]/, 'no module import of the git API');
        assert.match(code, /getExtension<GitApiExtension>\(GIT_EXTENSION_ID\)/);
        assert.match(code, /const GIT_EXTENSION_ID = 'vscode\.git';/);
    });

    it('package.json declares no dependency on vscode.git', () => {
        const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
        const manifest = JSON.parse(raw);
        assert.equal(manifest.extensionDependencies, undefined);
        assert.doesNotMatch(raw, /vscode\.git/, 'no manifest mention of the built-in extension');
        const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
        for (const name of Object.keys(deps)) {
            assert.doesNotMatch(name, /vscode\.git|git[-_.]?api/i, `unexpected git API dependency: ${name}`);
        }
    });

    it('the pure API modules never import vscode', () => {
        for (const name of PURE_MODULES) {
            const source = fs.readFileSync(path.join(SRC, 'services', name), 'utf8');
            assert.doesNotMatch(source, /from\s+['"]vscode['"]/, `${name} must stay node:test importable`);
            assert.doesNotMatch(source, /import\s+\*\s+as\s+vscode/, `${name} must stay node:test importable`);
        }
    });
});
