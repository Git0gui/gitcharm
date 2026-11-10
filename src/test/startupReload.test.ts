import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'views', 'graphView.ts'), 'utf8');

function body(signature: string): string {
    const match = source.match(new RegExp(`${signature}[\\s\\S]*?\\n {4}\\}(?:\\r?\\n)`));
    assert.ok(match, `${signature} must exist in graphView.ts`);
    return match[0];
}

describe('startup history load does not trigger a duplicate visibility refresh', () => {
    const load = body('private async _loadAndDisplayCommits\\(\\): Promise<void> \\{');
    const shown = body('private async _onPanelShown\\(\\): Promise<void> \\{');

    it('records the displayed tip after the initial page is painted', () => {
        assert.match(load, /this\._initialCommitLoadInProgress = true/);
        assert.match(load, /this\._lastKnownTip = await this\._tipOfDisplayedRev\(\)/);
        assert.match(load, /this\._initialCommitLoadInProgress = false/);
    });

    it('does not start another reload while the initial history query is in flight', () => {
        const guard = shown.indexOf('if (this._initialCommitLoadInProgress)');
        const reload = shown.indexOf('void this._reload(');
        assert.ok(guard >= 0 && reload > guard);
        assert.match(shown.slice(guard, reload), /this\._startBranchCheck\(\);\s*return;/);
    });
});
