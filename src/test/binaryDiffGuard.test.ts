import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { isBinaryNumstat } from '../services/gitUtils';

/**
 * An editor diff is a text document. Handing it a binary file makes the tab spin
 * without ever answering (git's own numstat is what says "this has no textual
 * diff"), so every ref-to-ref comparison has to pass through the one guard in
 * src/commands/helpers.ts. These tests hold that line: the pure classification,
 * and the surface coverage that keeps a new diff entry point from skipping it.
 */

// out/test -> repository root
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'test') {continue;}
            files.push(...sourceFiles(full));
        } else if (entry.name.endsWith('.ts')) {
            files.push(full);
        }
    }
    return files;
}

function countNeedle(file: string, needle: string): number {
    return fs.readFileSync(file, 'utf8').split(needle).length - 1;
}

describe('git-level binary classification', () => {
    it('reads git\'s own marker for a file it refused to diff as text', () => {
        assert.equal(isBinaryNumstat('-\t-\tdocs/preview/out/main.png\n'), true);
        assert.equal(isBinaryNumstat('3\t1\tsrc/a.ts\n-\t-\tlib/x.jar\n5\t0\tsrc/b.ts'), true);
    });

    it('treats a normal line count, an empty answer and a rename as textual', () => {
        assert.equal(isBinaryNumstat('12\t3\tsrc/services/gitService.ts\n'), false);
        assert.equal(isBinaryNumstat('0\t0\tnew.txt\n'), false);
        assert.equal(isBinaryNumstat(''), false);
    });

    it('only matches the marker at the start of a line', () => {
        // A file whose name contains "- -" is legal, and its numstat line still
        // starts with the real counts.
        assert.equal(isBinaryNumstat('1\t1\tweird - -\t-\tname\n'), false);
    });
});

describe('every editor diff surface is guarded', () => {
    /**
     * Sites allowed to call `vscode.diff` directly, because one side is a real
     * worktree file rather than a git blob (the workbench then applies its own
     * handling to that side):
     * - src/commands/helpers.ts — the guard itself
     * - src/extension.ts — compare a file with a branch / with HEAD
     * - src/views/graphView.ts — the third column's "compare with local file"
     */
    const ALLOWED = new Map<string, number>([
        [path.join('src', 'commands', 'helpers.ts'), 1],
        [path.join('src', 'extension.ts'), 2],
        [path.join('src', 'views', 'graphView.ts'), 1]
    ]);

    it('opens ref-to-ref diffs only through the shared guard', () => {
        const found = new Map<string, number>();
        for (const file of sourceFiles(SRC)) {
            const count = countNeedle(file, "'vscode.diff'");
            if (count > 0) {
                found.set(path.relative(ROOT, file), count);
            }
        }
        assert.deepEqual([...found.entries()].sort(), [...ALLOWED.entries()].sort());
    });

    it('routes the panel, commit group, stash, ref and palette diffs through it', () => {
        assert.equal(countNeedle(path.join(SRC, 'views', 'graphView.ts'), 'openEditorDiff('), 4);
        assert.equal(countNeedle(path.join(SRC, 'extension.ts'), 'openEditorDiff('), 1);
    });

    it('takes a commit diff\'s left side from the resolved parent, not from "^"', () => {
        // `git show <root>^:path` is a fatal error, and the content provider
        // answers an error with an empty document: the initial commit's diff would
        // lose its left half with nothing said about why.
        const graphView = fs.readFileSync(path.join(SRC, 'views', 'graphView.ts'), 'utf8');
        const extension = fs.readFileSync(path.join(SRC, 'extension.ts'), 'utf8');
        assert.equal(/_gitBlobUri\(\s*hash \+ '\^'/.test(graphView), false);
        assert.equal(/gitBlobUri\(\s*`\$\{commitHash\}\^`/.test(extension), false);
    });
});
