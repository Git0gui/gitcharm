import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * GitCharm must stay independent of the built-in git extension: activating it
 * triggers a multi-spawn repository scan on cold paths, and its cached refs and
 * HEAD lag behind real mutations. These guards keep that coupling from creeping
 * back into production code.
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/** Patterns that would reintroduce a dependency on vscode.git. */
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

describe('independence from vscode.git', () => {
    it('no production source touches the built-in git extension API', () => {
        const offenders: string[] = [];
        for (const file of collectSourceFiles(SRC)) {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, index) => {
                const hit = FORBIDDEN.find(pattern => line.includes(pattern));
                // Documenting why the dependency is gone is allowed; using it is not.
                if (hit && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
                    offenders.push(`${path.relative(ROOT, file)}:${index + 1} ${hit}`);
                }
            });
        }
        assert.deepEqual(offenders, []);
    });

    it('package.json declares no extension dependency on vscode.git', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        assert.equal(manifest.extensionDependencies, undefined);
    });
});
