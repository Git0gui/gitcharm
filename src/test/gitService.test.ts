import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    assertRef,
    assertHash,
    assertShellSafe,
    findStaleLock,
    parseLogLine,
    parseGraphLine,
    parseLsRemoteTags,
    diffTagRefs,
    refsTagsFirst,
    LruCache,
    stashRef
} from '../services/gitUtils';

describe('assertShellSafe', () => {
    it('accepts normal strings', () => {
        assert.equal(assertShellSafe('hello', 'test'), 'hello');
        assert.equal(assertShellSafe('feature/my-branch', 'test'), 'feature/my-branch');
    });

    it('accepts strings with spaces (handled by quoting)', () => {
        assert.equal(assertShellSafe('hello world', 'test'), 'hello world');
    });

    it('rejects strings with double quotes', () => {
        assert.throws(() => assertShellSafe('hello"world', 'test'), /不支持的字符/);
    });

    it('rejects strings with percent sign', () => {
        assert.throws(() => assertShellSafe('100%', 'test'), /不支持的字符/);
    });

    it('rejects empty strings', () => {
        assert.throws(() => assertShellSafe('', 'test'), /不支持的字符/);
    });
});

describe('assertRef', () => {
    it('accepts valid branch names', () => {
        assert.equal(assertRef('main'), 'main');
        assert.equal(assertRef('feature/my-branch'), 'feature/my-branch');
        assert.equal(assertRef('origin/main'), 'origin/main');
    });

    it('rejects names with ..', () => {
        assert.throws(() => assertRef('a..b'), /不合法/);
    });

    it('rejects names with @{', () => {
        assert.throws(() => assertRef('master@{0}'), /不合法/);
    });

    it('rejects names starting with /', () => {
        assert.throws(() => assertRef('/leading'), /不合法/);
    });

    it('rejects names ending with /', () => {
        assert.throws(() => assertRef('trailing/'), /不合法/);
    });

    it('rejects names starting with - so they cannot be read as options', () => {
        assert.throws(() => assertRef('--output=/tmp/x'), /不合法/);
    });
});

describe('assertHash', () => {
    it('accepts valid hex hashes', () => {
        assert.equal(assertHash('abc123'), 'abc123');
        assert.equal(assertHash('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'), 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
    });

    it('rejects non-hex characters', () => {
        assert.throws(() => assertHash('xyz123'), /不合法/);
    });

    it('rejects too-short hashes', () => {
        assert.throws(() => assertHash('abc'), /不合法/);
    });

    it('rejects empty strings', () => {
        assert.throws(() => assertHash(''), /不合法/);
    });
});

describe('stashRef', () => {
    it('spells a stack position the way git does', () => {
        assert.equal(stashRef(0), 'stash@{0}');
        assert.equal(stashRef(12), 'stash@{12}');
    });

    it('rejects positions that cannot come from the stack', () => {
        assert.throws(() => stashRef(-1), /invalid stash index/);
        assert.throws(() => stashRef(1.5), /invalid stash index/);
        assert.throws(() => stashRef(Number.NaN), /invalid stash index/);
    });
});

describe('LruCache', () => {
    it('stores and retrieves values', () => {
        const cache = new LruCache<string>(3);
        cache.set('a', 'alpha');
        cache.set('b', 'beta');
        assert.equal(cache.get('a'), 'alpha');
        assert.equal(cache.get('b'), 'beta');
        assert.equal(cache.get('c'), undefined);
    });

    it('evicts oldest entry when full', () => {
        const cache = new LruCache<string>(2);
        cache.set('a', '1');
        cache.set('b', '2');
        cache.set('c', '3');
        assert.equal(cache.get('a'), undefined);
        assert.equal(cache.get('b'), '2');
        assert.equal(cache.get('c'), '3');
    });

    it('accessing an entry makes it recently used', () => {
        const cache = new LruCache<string>(2);
        cache.set('a', '1');
        cache.set('b', '2');
        cache.get('a');
        cache.set('c', '3');
        assert.equal(cache.get('a'), '1');
        assert.equal(cache.get('b'), undefined);
        assert.equal(cache.get('c'), '3');
    });

    it('reports correct size', () => {
        const cache = new LruCache<number>(5);
        assert.equal(cache.size, 0);
        cache.set('x', 1);
        assert.equal(cache.size, 1);
        cache.set('y', 2);
        assert.equal(cache.size, 2);
    });

    it('clear removes all entries', () => {
        const cache = new LruCache<number>(5);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.clear();
        assert.equal(cache.size, 0);
        assert.equal(cache.get('a'), undefined);
    });

    it('updating existing key does not increase size', () => {
        const cache = new LruCache<string>(2);
        cache.set('a', '1');
        cache.set('a', '2');
        assert.equal(cache.size, 1);
        assert.equal(cache.get('a'), '2');
    });
});

describe('parseLogLine', () => {
    it('parses a valid log line', () => {
        const line = 'abc123def456|abc123d|John Doe|john@example.com|2024-01-15 10:30:00 +0800|2 hours ago|Fix bug|parent1 parent2';
        const result = parseLogLine(line);
        assert.notEqual(result, null);
        assert.equal(result!.hash, 'abc123def456');
        assert.equal(result!.shortHash, 'abc123d');
        assert.equal(result!.author, 'John Doe');
        assert.equal(result!.authorEmail, 'john@example.com');
        assert.equal(result!.message, 'Fix bug');
        assert.deepEqual(result!.parentHashes, ['parent1', 'parent2']);
    });

    it('handles commit with no parents', () => {
        const line = 'abc123|abc12|Author|a@b.com|2024-01-15 10:00:00|1h|Initial commit|';
        const result = parseLogLine(line);
        assert.notEqual(result, null);
        assert.deepEqual(result!.parentHashes, []);
    });

    it('returns null for lines with too few fields', () => {
        assert.equal(parseLogLine('abc|def'), null);
        assert.equal(parseLogLine(''), null);
    });

    it('handles message containing pipe characters', () => {
        const line = 'hash1|short1|Author|a@b|2024-01-01|1d|msg with | pipe|parent';
        const result = parseLogLine(line);
        assert.notEqual(result, null);
        assert.equal(result!.hash, 'hash1');
    });
});

describe('parseGraphLine', () => {
    const fields = [
        'abc123', 'abc12', 'Merge branch', 'Author', 'a@b.c', '2024-01-15 10:00:00',
        'Committer', 'c@d.e', '2024-01-15 11:00:00', 'p1 p2'
    ];

    it('parses a valid graph line', () => {
        const result = parseGraphLine(fields.join('\0'));
        assert.notEqual(result, null);
        assert.equal(result!.hash, 'abc123');
        assert.equal(result!.shortHash, 'abc12');
        assert.equal(result!.message, 'Merge branch');
        assert.equal(result!.author, 'Author');
        assert.equal(result!.authorEmail, 'a@b.c');
        assert.equal(result!.date, '2024-01-15 10:00:00');
        assert.equal(result!.committer, 'Committer');
        assert.equal(result!.committerEmail, 'c@d.e');
        assert.equal(result!.committerDate, '2024-01-15 11:00:00');
        assert.deepEqual(result!.parents, ['p1', 'p2']);
    });

    it('keeps a subject containing a pipe intact', () => {
        const line = [...fields];
        line[2] = 'fix | parser | edge';
        const result = parseGraphLine(line.join('\0'));
        assert.equal(result!.message, 'fix | parser | edge');
        assert.equal(result!.author, 'Author');
        assert.deepEqual(result!.parents, ['p1', 'p2']);
    });

    it('handles single parent', () => {
        const line = [...fields];
        line[9] = 'parent1';
        const result = parseGraphLine(line.join('\0'));
        assert.notEqual(result, null);
        assert.deepEqual(result!.parents, ['parent1']);
    });

    it('returns null for short lines', () => {
        assert.equal(parseGraphLine('a\0b\0c'), null);
    });
});

describe('findStaleLock', () => {
    it('names the file in the shape a dead checkout leaves behind', () => {
        const stderr = [
            "fatal: Unable to create 'D:/repo/.git/index.lock': File exists.",
            '',
            'Another git process seems to be running in this repository, e.g.',
            'an editor opened by \'git commit\'. Please make sure all processes',
            'are terminated then try again.'
        ].join('\n');
        assert.equal(findStaleLock(stderr), 'D:/repo/.git/index.lock');
    });

    it('finds it behind a ref-lock error as well', () => {
        assert.equal(
            findStaleLock("error: cannot lock ref 'refs/heads/main': Unable to create 'D:/repo/.git/refs/heads/main.lock': File exists."),
            'D:/repo/.git/refs/heads/main.lock'
        );
    });

    it('keeps the whole path when the directory name holds a quote', () => {
        // Greedy up to the last "': on the line: cutting at the first would hand
        // the service a truncated path that then fails its containment check.
        assert.equal(
            findStaleLock("fatal: Unable to create 'D:/a b'c/.git/index.lock': File exists."),
            "D:/a b'c/.git/index.lock"
        );
    });

    it('reports nothing for failures that name no lock file', () => {
        assert.equal(findStaleLock('fatal: not a git repository (or any of the parent directories): .git'), undefined);
        assert.equal(findStaleLock("fatal: cannot lock ref 'refs/heads/main': is at 111 but expected 222"), undefined);
        assert.equal(findStaleLock(''), undefined);
        assert.equal(findStaleLock(undefined), undefined);
    });
});

describe('refsTagsFirst', () => {
    it('moves tags in front of branch chips', () => {
        assert.deepEqual(
            refsTagsFirst(['main', 'v1.0.0', 'origin/main', 'release/v1'], ['v1.0.0']),
            ['v1.0.0', 'main', 'origin/main', 'release/v1']
        );
    });

    it('keeps the original order inside each group', () => {
        assert.deepEqual(
            refsTagsFirst(['main', 'v2', 'dev', 'v1'], ['v1', 'v2']),
            ['v2', 'v1', 'main', 'dev']
        );
    });

    it('leaves untagged commits and untouched arrays alone', () => {
        assert.deepEqual(refsTagsFirst(['main'], ['v1']), ['main']);
        assert.deepEqual(refsTagsFirst([], ['v1']), []);
        assert.deepEqual(refsTagsFirst(['main', 'dev'], []), ['main', 'dev']);
    });

    it('does not reuse the input array', () => {
        const refs = ['main', 'v1'];
        const out = refsTagsFirst(refs, ['v1']);
        assert.notEqual(out, refs);
        assert.deepEqual(refs, ['main', 'v1']);
    });
});

describe('parseLsRemoteTags', () => {
    const light = 'a'.repeat(40);
    const tagObject = 'b'.repeat(40);
    const commit = 'c'.repeat(40);

    it('reads lightweight tags as their commit', () => {
        assert.deepEqual(
            parseLsRemoteTags(`${light}\trefs/tags/v1.0.0\n`),
            [{ name: 'v1.0.0', commit: light }]
        );
    });

    it('peels annotated tags so the result matches the local ref reader', () => {
        assert.deepEqual(
            parseLsRemoteTags([
                `${tagObject}\trefs/tags/v2.0.0`,
                `${commit}\trefs/tags/v2.0.0^{}`,
                ''
            ].join('\n')),
            [{ name: 'v2.0.0', commit }]
        );
    });

    it('sorts tags and ignores non-tag refs', () => {
        assert.deepEqual(
            parseLsRemoteTags([
                `${light}\trefs/tags/v2`,
                `${commit}\trefs/heads/main`,
                `${commit}\trefs/tags/v1`,
                ''
            ].join('\n')),
            [
                { name: 'v1', commit },
                { name: 'v2', commit: light }
            ]
        );
    });

    it('ignores malformed and empty output', () => {
        assert.deepEqual(parseLsRemoteTags(''), []);
        assert.deepEqual(parseLsRemoteTags('HEAD\tnot-a-hash\n'), []);
        assert.deepEqual(parseLsRemoteTags('garbage'), []);
    });
});

describe('diffTagRefs', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const c = 'c'.repeat(40);

    it('splits the three kinds of difference', () => {
        const diff = diffTagRefs(
            new Map([['shared', a], ['moved', b], ['localOnly', c]]),
            [
                { name: 'shared', commit: a },
                { name: 'moved', commit: c },
                { name: 'remoteOnly', commit: a }
            ]
        );
        assert.deepEqual(diff.remoteOnly, ['remoteOnly']);
        assert.deepEqual(diff.localOnly, ['localOnly']);
        assert.deepEqual(diff.different, ['moved']);
    });

    it('reports nothing when both sides agree', () => {
        const diff = diffTagRefs(new Map([['v1', a]]), [{ name: 'v1', commit: a }]);
        assert.deepEqual(diff, { remoteOnly: [], localOnly: [], different: [] });
    });

    it('treats an empty local side as everything being remote-only', () => {
        const diff = diffTagRefs(new Map(), [{ name: 'v2', commit: a }]);
        assert.deepEqual(diff, { remoteOnly: ['v2'], localOnly: [], different: [] });
    });
});
