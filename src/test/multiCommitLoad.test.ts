import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');

describe('multi-commit detail loading', () => {
    it('starts history ordering, commit details, and batched files in parallel', () => {
        const match = source.match(/case 'selectCommits':[\s\S]*?const \[ordered, detailEntries, filesByHash\] = await Promise\.all\(\[([\s\S]*?)\n\s*\]\);/);
        assert.ok(match, 'selectCommits should start the independent requests in one Promise.all');
        assert.match(match[1], /orderCommitsByHistory\(hashes\)/);
        assert.match(match[1], /getCommitDetail\(hash\)/);
        assert.match(match[1], /getCommitFilesWithStatsBatch\(hashes\)/);
    });

    it('uses the ordered hashes only when assembling commit and file results', () => {
        const match = source.match(/case 'selectCommits':[\s\S]*?const \[ordered, detailEntries, filesByHash\] = await Promise\.all\(\[[\s\S]*?\n\s*\]\);([\s\S]*?)this\._post\(\{\s*command: 'multiCommitsResponse'/);
        assert.ok(match, 'ordered results should be assembled after all independent queries resolve');
        assert.match(match[1], /ordered\.map\(hash => detailsByHash\.get\(hash\)!\)/);
        assert.match(match[1], /mergeCommitFileStats\(ordered\.map\(hash => filesByHash\.get\(hash\) \?\? \[\]\)\)/);
    });
});
