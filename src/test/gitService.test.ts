import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    assertRef,
    assertHash,
    assertShellSafe,
    parseLogLine,
    parseGraphLine,
    LruCache
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
    it('parses a valid graph line', () => {
        const line = 'abc123|abc12|Merge branch|Author|2024-01-15 10:00:00|p1 p2';
        const result = parseGraphLine(line);
        assert.notEqual(result, null);
        assert.equal(result!.hash, 'abc123');
        assert.equal(result!.shortHash, 'abc12');
        assert.equal(result!.message, 'Merge branch');
        assert.equal(result!.author, 'Author');
        assert.deepEqual(result!.parents, ['p1', 'p2']);
    });

    it('handles single parent', () => {
        const line = 'hash|short|msg|auth|date|parent1';
        const result = parseGraphLine(line);
        assert.notEqual(result, null);
        assert.deepEqual(result!.parents, ['parent1']);
    });

    it('returns null for short lines', () => {
        assert.equal(parseGraphLine('a|b|c'), null);
    });
});
