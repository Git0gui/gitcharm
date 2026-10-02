import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { tokenizeCommand, splitNul, buildSpawnSpec } from '../services/gitRunner';

describe('tokenizeCommand', () => {
    it('splits plain commands on spaces', () => {
        assert.deepEqual(tokenizeCommand('branch --show-current'), ['branch', '--show-current']);
    });

    it('strips double quotes and keeps quoted content as one token', () => {
        assert.deepEqual(
            tokenizeCommand('for-each-ref refs/heads/ --format="%(refname:short)"'),
            ['for-each-ref', 'refs/heads/', '--format=%(refname:short)']
        );
    });

    it('strips single quotes', () => {
        assert.deepEqual(tokenizeCommand("log --grep='fix bug'"), ['log', '--grep=fix bug']);
    });

    it('collapses multiple spaces', () => {
        assert.deepEqual(tokenizeCommand('add  --   a.txt'), ['add', '--', 'a.txt']);
    });

    it('keeps spaces inside quotes', () => {
        assert.deepEqual(tokenizeCommand('commit -m "hello world"'), ['commit', '-m', 'hello world']);
    });

    it('does not leak quote characters into tokens (regression: quoted branch names)', () => {
        const tokens = tokenizeCommand('branch --format="%(refname:short)"');
        for (const t of tokens) {
            assert.ok(!t.includes('"'), `token must not contain a quote: ${t}`);
        }
    });
});

describe('splitNul', () => {
    it('splits NUL-terminated output', () => {
        assert.deepEqual(splitNul('a\0b\0'), ['a', 'b']);
    });

    it('handles missing trailing NUL', () => {
        assert.deepEqual(splitNul('a\0b'), ['a', 'b']);
    });

    it('returns empty array for empty output', () => {
        assert.deepEqual(splitNul(''), []);
    });

    it('preserves entries containing newlines', () => {
        assert.deepEqual(splitNul('we\nird.txt\0'), ['we\nird.txt']);
    });
});

describe('buildSpawnSpec', () => {
    it('always injects base args before command args', () => {
        const spec = buildSpawnSpec(['status'], { cwd: '/repo' });
        assert.deepEqual(spec.args.slice(0, 4), ['-c', 'core.quotePath=false', '-c', 'gc.auto=0']);
        assert.deepEqual(spec.args.slice(4), ['status']);
    });

    it('forces C locale so error messages stay parseable', () => {
        const spec = buildSpawnSpec(['merge', 'x'], { cwd: '/repo' });
        assert.equal(spec.env.LC_ALL, 'C');
        assert.equal(spec.env.LANG, 'C');
    });

    it('disables optional locks, pager, prompts and editor', () => {
        const spec = buildSpawnSpec(['fetch'], { cwd: '/repo' });
        assert.equal(spec.env.GIT_OPTIONAL_LOCKS, '0');
        assert.equal(spec.env.GIT_PAGER, 'cat');
        assert.equal(spec.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(spec.env.GIT_EDITOR, 'true');
    });

    it('lets caller env override the base env (GIT_SEQUENCE_EDITOR)', () => {
        const spec = buildSpawnSpec(['rebase', '-i', 'main'], {
            cwd: '/repo',
            env: { GIT_SEQUENCE_EDITOR: 'cp /tmp/todo' }
        });
        assert.equal(spec.env.GIT_SEQUENCE_EDITOR, 'cp /tmp/todo');
        assert.equal(spec.env.LC_ALL, 'C');
    });
});
