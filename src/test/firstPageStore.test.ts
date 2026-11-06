import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    FIRST_PAGE_TTL_MS,
    FIRST_PAGE_VERSION,
    parseFirstPage,
    serializeFirstPage
} from '../services/firstPageStore';

function row(index: number) {
    const sha = index.toString(16).padStart(40, '0');
    return {
        hash: sha,
        shortHash: sha.slice(0, 7),
        message: `commit ${index}`,
        author: '归 刘',
        authorEmail: 'me@example.com',
        date: '2026-11-06 10:00:00 +0800',
        committer: '归 刘',
        committerEmail: 'me@example.com',
        committerDate: '2026-11-06 10:00:00 +0800',
        parents: index === 0 ? [] : [ (index - 1).toString(16).padStart(40, '0') ],
        refs: ['refs/heads/main'],
        tags: [] as string[],
        isMerge: false
    };
}

const BASE = {
    repoPath: 'D:/gitProject/GitCharm',
    tip: '1'.repeat(40),
    commits: [row(0), row(1)],
    hasMore: true,
    savedAt: 1_700_000_000_000
};

describe('serializeFirstPage', () => {
    it('round-trips a plain page', () => {
        const text = serializeFirstPage(BASE);
        assert.ok(text);
        const back = parseFirstPage(text!, BASE.savedAt);
        assert.ok(back);
        assert.equal(back.version, FIRST_PAGE_VERSION);
        assert.equal(back.repoPath, BASE.repoPath);
        assert.equal(back.tip, BASE.tip);
        assert.equal(back.hasMore, true);
        assert.deepEqual(back.commits.map(c => c.hash), BASE.commits.map(c => c.hash));
    });

    it('keeps the all-branches scope distinguishable from a branch', () => {
        const back = parseFirstPage(serializeFirstPage({ ...BASE, branch: undefined })!, BASE.savedAt);
        assert.equal(back?.branch, undefined);

        const onBranch = parseFirstPage(serializeFirstPage({ ...BASE, branch: 'feat/x' })!, BASE.savedAt);
        assert.equal(onBranch?.branch, 'feat/x');
    });

    it('refuses to remember a page it could not revalidate', () => {
        assert.equal(serializeFirstPage({ ...BASE, repoPath: '' }), undefined);
        assert.equal(serializeFirstPage({ ...BASE, tip: '' }), undefined);
        assert.equal(serializeFirstPage({ ...BASE, tip: 'not-a-hash' }), undefined);
        assert.equal(serializeFirstPage({ ...BASE, commits: [] }), undefined);
    });

    it('refuses a page whose branch name is one of the quoted legacy values', () => {
        assert.equal(serializeFirstPage({ ...BASE, branch: '"main"' }), undefined);
    });

    it('refuses rows that are not rows, and pages larger than a page', () => {
        const broken = { ...row(0), author: 42 } as unknown as ReturnType<typeof row>;
        assert.equal(serializeFirstPage({ ...BASE, commits: [broken] }), undefined);

        const many = Array.from({ length: 61 }, (_, i) => row(i));
        assert.equal(serializeFirstPage({ ...BASE, commits: many }), undefined);
    });

    it('refuses a payload too large for a Memento', () => {
        const longMessage = { ...row(0), message: 'x'.repeat(128 * 1024) };
        assert.equal(serializeFirstPage({ ...BASE, commits: [longMessage] }), undefined);
    });
});

describe('parseFirstPage', () => {
    it('discards anything unparseable instead of throwing', () => {
        for (const junk of ['', 'not json', '[]', 'null', '{}']) {
            assert.equal(parseFirstPage(junk), undefined, junk);
        }
    });

    it('discards a payload written by an older schema', () => {
        const text = serializeFirstPage(BASE)!;
        const bumped = JSON.stringify({ ...JSON.parse(text), version: FIRST_PAGE_VERSION + 1 });
        assert.equal(parseFirstPage(bumped), undefined);
    });

    it('discards a page belonging to a different repository', () => {
        const text = JSON.stringify({ ...JSON.parse(serializeFirstPage(BASE)!), repoPath: 'D:/other' });
        const back = parseFirstPage(text, BASE.savedAt);
        assert.ok(back, 'it is a well-formed page…');
        assert.notEqual(back.repoPath, BASE.repoPath);
    });

    it('discards a page older than the session window', () => {
        const back = parseFirstPage(serializeFirstPage(BASE)!, BASE.savedAt + FIRST_PAGE_TTL_MS + 1);
        assert.equal(back, undefined);
    });

    it('accepts a page one millisecond inside the window', () => {
        const back = parseFirstPage(serializeFirstPage(BASE)!, BASE.savedAt + FIRST_PAGE_TTL_MS);
        assert.ok(back);
    });

    it('discards a page where a single row has lost a field', () => {
        const text = JSON.stringify({
            ...JSON.parse(serializeFirstPage(BASE)!),
            commits: [row(0), { ...row(1), parents: 'nope' }]
        });
        assert.equal(parseFirstPage(text, BASE.savedAt), undefined);
    });
});
