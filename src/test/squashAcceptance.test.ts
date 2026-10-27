import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { t } from '../i18n';
import { runGit } from '../services/gitRunner';
import { shSingleQuote } from '../services/gitUtils';
import {
    buildGroupTodo,
    executeSquashGroups,
    foldableGroups,
    orderHistoryOldestFirst,
    planSquashGroups,
    readTodo,
    splitContiguousGroups,
    SquashFiles,
    SquashRun
} from '../services/squash';

/**
 * Acceptance suite for 压缩提交 (squash).
 *
 * The contract, from the report that started this: for history `x y z w a b c`,
 * selecting `y z` must give `x (y+z) w a b c` — six commits, the edited message on
 * the folded one, and `w a b c` exactly as they were. Selecting `y z a b` across
 * the unselected `w` must give `x (y+z) w (a+b) c` — two groups, each folded on its
 * own. Nothing else may change, least of all the newest commit's message.
 *
 * The last two suites reproduce what the previous algorithm actually did, so the
 * shape of the bug stays measurable instead of turning into folklore. They drive
 * git directly rather than the shipped code, on purpose: they describe the old
 * algorithm, not the current one.
 */

const GIT_PRESENT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/**
 * Every commit writes its own file, so replaying commits in the wrong order still
 * applies cleanly. That is deliberate: a defect suite that fails with a conflict
 * proves nothing about the history shape the algorithm produced.
 */
const IDENTITY = [
    '-c', 'user.name=GitCharm Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false',
    '-c', 'init.defaultBranch=main'
];

const NAMES = ['x', 'y', 'z', 'w', 'a', 'b', 'c'] as const;

function gitIn(cwd: string): SquashRun {
    return (args, env) => runGit([...IDENTITY, ...args], { cwd, env, timeoutMs: 60_000 });
}

const tempFiles: SquashFiles = {
    write(prefix, text) {
        const file = path.join(
            os.tmpdir(),
            `${prefix}-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
        );
        fs.writeFileSync(file, text, 'utf8');
        return file;
    },
    dispose(file) {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
};

/** git makes pack/object files read-only; Windows rm then refuses the whole tree. */
function removeRepo(dir: string): void {
    const unlock = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                unlock(full);
            } else {
                try { fs.chmodSync(full, 0o666); } catch { /* best effort */ }
            }
        }
        try { fs.chmodSync(current, 0o777); } catch { /* best effort */ }
    };
    try {
        unlock(dir);
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    } catch { /* the temp directory is not the assertion */ }
}

interface Fixture {
    dir: string;
    run: SquashRun;
    hash: Record<string, string>;
    /** Subjects oldest → newest. */
    subjects(): Promise<string[]>;
    /** Tree of HEAD — the whole content of the branch, file by file. */
    tree(): Promise<string>;
}

async function makeHistory(): Promise<Fixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-squash-'));
    const run = gitIn(dir);
    const hash: Record<string, string> = {};
    await run(['init', '-q', '.']);
    for (const name of NAMES) {
        fs.writeFileSync(path.join(dir, `${name}.txt`), `content of ${name}\n`, 'utf8');
        await run(['add', '-A']);
        await run(['commit', '-qm', `C-${name}`]);
        hash[name] = (await run(['rev-parse', 'HEAD'])).trim();
    }
    const subjects = async () => (await run(['log', '--reverse', '--format=%s'])).trim().split('\n').filter(Boolean);
    const tree = async () => (await run(['rev-parse', 'HEAD^{tree}'])).trim();
    return { dir, run, hash, subjects, tree };
}

const ALL_FILES = NAMES.map(name => `${name}.txt`).sort();

async function trackedFiles(run: SquashRun): Promise<string[]> {
    return (await run(['ls-tree', '-r', '--name-only', 'HEAD'])).trim().split('\n').filter(Boolean).sort();
}

/**
 * The previous algorithm, replayed by hand: one block for the whole selection,
 * then `commit --amend` on whatever HEAD happens to be.
 */
async function squashTheOldWay(
    run: SquashRun,
    baseRef: string,
    todo: string[],
    message: string
): Promise<void> {
    const todoFile = tempFiles.write('idea-git-todo', todo.join('\n') + '\n');
    const messageFile = tempFiles.write('idea-git-msg', message);
    try {
        await run(['rebase', '-i', baseRef], {
            GIT_SEQUENCE_EDITOR: `cp ${shSingleQuote(todoFile)}`,
            GIT_EDITOR: 'true'
        });
        await run(['commit', '--amend', '-F', messageFile]);
    } finally {
        tempFiles.dispose(todoFile);
        tempFiles.dispose(messageFile);
    }
}

describe('squash acceptance', { skip: GIT_PRESENT ? false : 'git is not available' }, () => {

    it('示例1：折叠连续两个提交，后面的提交一条都不许动', async () => {
        const repo = await makeHistory();
        try {
            const original = await repo.tree();
            // Click order is deliberately newest-first: grouping follows history, not clicks.
            const plan = await planSquashGroups([repo.hash.z, repo.hash.y], repo.run);

            assert.equal(plan.length, 1, 'y and z are adjacent, so they are one group');
            assert.deepEqual(plan[0].hashes, [repo.hash.y, repo.hash.z]);
            assert.equal(plan[0].baseRef, repo.hash.x);

            await executeSquashGroups(plan, ['SQUASHED y+z'], repo.run, tempFiles);

            assert.deepEqual(await repo.subjects(), [
                'C-x', 'SQUASHED y+z', 'C-w', 'C-a', 'C-b', 'C-c'
            ]);
            assert.deepEqual(await trackedFiles(repo.run), ALL_FILES, 'no change may be lost');
            assert.equal(await repo.tree(), original, 'the branch must end in the same content');
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('示例2：跨过未选提交的选择拆成两组，各自折叠', async () => {
        const repo = await makeHistory();
        try {
            const original = await repo.tree();
            const plan = await planSquashGroups(
                [repo.hash.b, repo.hash.y, repo.hash.a, repo.hash.z], repo.run);

            assert.equal(plan.length, 2, 'w is not selected, so y+z and a+b are separate groups');
            assert.deepEqual(plan[0].hashes, [repo.hash.y, repo.hash.z]);
            assert.deepEqual(plan[1].hashes, [repo.hash.a, repo.hash.b]);

            await executeSquashGroups(plan, ['GROUP 1 y+z', 'GROUP 2 a+b'], repo.run, tempFiles);

            assert.deepEqual(await repo.subjects(), [
                'C-x', 'GROUP 1 y+z', 'C-w', 'GROUP 2 a+b', 'C-c'
            ]);
            assert.equal(await repo.tree(), original);
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('选中到 HEAD：只折这三个，前面的四条原样保留', async () => {
        const repo = await makeHistory();
        try {
            const plan = await planSquashGroups(
                [repo.hash.a, repo.hash.b, repo.hash.c], repo.run);

            assert.equal(plan.length, 1);
            assert.equal(plan[0].baseRef, repo.hash.w);

            await executeSquashGroups(plan, ['TAIL a+b+c'], repo.run, tempFiles);

            assert.deepEqual(await repo.subjects(), [
                'C-x', 'C-y', 'C-z', 'C-w', 'TAIL a+b+c'
            ]);
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('从根提交开始：没有父提交也要折得动', async () => {
        const repo = await makeHistory();
        try {
            const plan = await planSquashGroups([repo.hash.x, repo.hash.y], repo.run);

            assert.equal(plan.length, 1);
            assert.equal(plan[0].baseRef, null, 'the initial commit has no parent to start from');

            await executeSquashGroups(plan, ['ROOT x+y'], repo.run, tempFiles);

            assert.deepEqual(await repo.subjects(), [
                'ROOT x+y', 'C-z', 'C-w', 'C-a', 'C-b', 'C-c'
            ]);
            assert.equal((await repo.run(['rev-list', '--count', 'HEAD'])).trim(), '6');
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('全选：七条压成一条', async () => {
        const repo = await makeHistory();
        try {
            const original = await repo.tree();
            const plan = await planSquashGroups(NAMES.map(name => repo.hash[name]), repo.run);

            assert.equal(plan.length, 1);
            await executeSquashGroups(plan, ['ALL OF IT'], repo.run, tempFiles);

            assert.deepEqual(await repo.subjects(), ['ALL OF IT']);
            assert.deepEqual(await trackedFiles(repo.run), ALL_FILES);
            assert.equal(await repo.tree(), original);
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('顺序看历史，不看点击：倒着点的四个提交照样按落地顺序折叠', async () => {
        const repo = await makeHistory();
        try {
            // git rev-list --no-walk --topo-order would hand these back untouched,
            // so grouping would take the wrong end of the selection as its base.
            const ordered = await orderHistoryOldestFirst(repo.run, [
                repo.hash.b, repo.hash.y, repo.hash.a, repo.hash.z
            ]);
            assert.deepEqual(ordered, [
                repo.hash.y, repo.hash.z, repo.hash.a, repo.hash.b
            ]);
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('选中的提交互不相邻：一句明白话，不动历史', async () => {
        const repo = await makeHistory();
        try {
            await assert.rejects(
                () => planSquashGroups([repo.hash.y, repo.hash.a], repo.run),
                error => (error as Error).message === t('err.squashNoAdjacent')
            );
            assert.deepEqual(await repo.subjects(), NAMES.map(name => `C-${name}`));
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('少于两个提交：不动历史', async () => {
        const repo = await makeHistory();
        try {
            await assert.rejects(
                () => planSquashGroups([repo.hash.y], repo.run),
                error => (error as Error).message === t('err.squashNeedTwo')
            );
            assert.deepEqual(await repo.subjects(), NAMES.map(name => `C-${name}`));
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('所选提交不在当前分支的历史里：拒绝，不动历史', async () => {
        const repo = await makeHistory();
        try {
            await repo.run(['checkout', '-q', '-b', 'side']);
            fs.writeFileSync(path.join(repo.dir, 'o.txt'), 'content of o\n', 'utf8');
            await repo.run(['add', '-A']);
            await repo.run(['commit', '-qm', 'C-o']);
            const sideHash = (await repo.run(['rev-parse', 'HEAD'])).trim();
            await repo.run(['checkout', '-q', 'main']);

            await assert.rejects(
                () => planSquashGroups([sideHash, repo.hash.c], repo.run),
                error => (error as Error).message === t('err.squashNotInRange')
            );
            assert.deepEqual(await repo.subjects(), NAMES.map(name => `C-${name}`));
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('每条消息跟着自己那一组：不给消息的组用 git 合并出来的消息', async () => {
        const repo = await makeHistory();
        try {
            const plan = await planSquashGroups(
                [repo.hash.y, repo.hash.z, repo.hash.a, repo.hash.b], repo.run);

            // Only the first group is named; the second keeps git's own combination.
            await executeSquashGroups(plan, ['NAMED GROUP', undefined], repo.run, tempFiles);

            const list = await repo.subjects();
            assert.equal(list.length, 5);
            assert.equal(list[1], 'NAMED GROUP');
            assert.equal(list[2], 'C-w', 'the unselected commit between the groups stays put');
            assert.ok(/^C-a$/.test(list[3]), `expected git to combine a+b, got ${list[3]}`);
            assert.equal(list[4], 'C-c');
        } finally {
            removeRepo(repo.dir);
        }
    });
});

describe('squash: what the previous algorithm did', { skip: GIT_PRESENT ? false : 'git is not available' }, () => {

    it('连续两个提交：消息落到了最后一条提交上，而不是折叠出来的那条', async () => {
        const repo = await makeHistory();
        try {
            await squashTheOldWay(repo.run, repo.hash.x, [
                `pick ${repo.hash.y}`, `squash ${repo.hash.z}`,
                `pick ${repo.hash.w}`, `pick ${repo.hash.a}`,
                `pick ${repo.hash.b}`, `pick ${repo.hash.c}`
            ], 'COMBINED-MESSAGE');

            const list = await repo.subjects();
            assert.deepEqual(list, ['C-x', 'C-y', 'C-w', 'C-a', 'C-b', 'COMBINED-MESSAGE']);
            // The report in one line: the user squashed y+z and the message landed on c.
            assert.notEqual(list[1], 'COMBINED-MESSAGE');
            assert.equal(list[list.length - 1], 'COMBINED-MESSAGE');
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('跨未选提交：未选的提交被挪到折叠之后，选中的四组并成一条', async () => {
        const repo = await makeHistory();
        try {
            // y z a b are not adjacent, so folding them into one block moves w.
            await squashTheOldWay(repo.run, repo.hash.x, [
                `pick ${repo.hash.y}`, `squash ${repo.hash.z}`,
                `squash ${repo.hash.a}`, `squash ${repo.hash.b}`,
                `pick ${repo.hash.w}`, `pick ${repo.hash.c}`
            ], 'COMBINED-MESSAGE');

            const list = await repo.subjects();
            assert.equal(list.length, 4, 'four selected commits became one, not two');
            assert.ok(list.indexOf('C-w') > 1, `w must have been replayed after the fold: ${list}`);
            assert.ok(!list.includes('C-a'), 'a lost its own commit entirely');
        } finally {
            removeRepo(repo.dir);
        }
    });

    it('todo 少写一行就是删提交：尾巴不列进去会被静默丢弃', async () => {
        const repo = await makeHistory();
        try {
            const todoFile = tempFiles.write('idea-git-todo', [
                `pick ${repo.hash.y}`, `squash ${repo.hash.z}`,
                `pick ${repo.hash.w}`, `pick ${repo.hash.a}`
            ].join('\n') + '\n');
            try {
                await repo.run(['rebase', '-i', repo.hash.x], {
                    GIT_SEQUENCE_EDITOR: `cp ${shSingleQuote(todoFile)}`,
                    GIT_EDITOR: 'true'
                });
            } finally {
                tempFiles.dispose(todoFile);
            }
            assert.deepEqual(await repo.subjects(), ['C-x', 'C-y', 'C-w', 'C-a']);
        } finally {
            removeRepo(repo.dir);
        }
    });
});

describe('squash planning (pure)', () => {

    const H = NAMES.map(name => `h-${name}`);

    it('按历史顺序分组，与点击顺序无关', () => {
        assert.deepEqual(
            splitContiguousGroups(H, [H[1], H[2], H[4], H[5]]),
            [[H[1], H[2]], [H[4], H[5]]]
        );
    });

    it('选中到末尾与整段选中都只有一组', () => {
        assert.deepEqual(splitContiguousGroups(H, [H[4], H[5], H[6]]), [[H[4], H[5], H[6]]]);
        assert.deepEqual(splitContiguousGroups(H, H), [H]);
    });

    it('孤立的提交成不了组', () => {
        assert.deepEqual(foldableGroups(splitContiguousGroups(H, [H[1], H[3]])), []);
        assert.deepEqual(foldableGroups([[H[1]], [H[2], H[3]]]), [[H[2], H[3]]]);
    });

    it('分组返回的是副本，改不动调用方传进来的数组', () => {
        const groups = [[H[0], H[1]]];
        const foldable = foldableGroups(groups);
        foldable[0].push('injected');
        assert.deepEqual(groups[0], [H[0], H[1]]);
    });

    it('组折叠，其余原样 pick —— 包括组后面那些', () => {
        const entries = H.map(hash => ({ hash, subject: `S-${hash}` }));
        assert.deepEqual(buildGroupTodo(entries, [H[1], H[2]]), [
            `pick ${H[0]}`, `pick ${H[1]}`, `squash ${H[2]}`,
            `pick ${H[3]}`, `pick ${H[4]}`, `pick ${H[5]}`, `pick ${H[6]}`
        ]);
    });

    it('一组只产出一条 squash 链，未选提交的行不会混进组里', () => {
        const entries = H.map(hash => ({ hash, subject: `S-${hash}` }));
        const todo = buildGroupTodo(entries, [H[4], H[5], H[6]]);
        assert.equal(todo.filter(line => line.startsWith('squash')).length, 2);
        assert.equal(todo[todo.length - 1], `squash ${H[6]}`);
    });

    it('读到的范围以 | 只切一次：提交消息里可以有竖线', async () => {
        const run: SquashRun = async () => `${H[0]}|fix|pipe|thing\n${H[1]}|second\n`;
        const entries = await readTodo(run, H[0]);
        assert.deepEqual(entries, [
            { hash: H[0], subject: 'fix|pipe|thing' },
            { hash: H[1], subject: 'second' }
        ]);
    });

    it('编辑器路径过单引号：$ 与反引号都只是普通字符', () => {
        assert.equal(shSingleQuote('C:/Users/AA$B/AppData/Local/Temp/a.txt'), "'C:/Users/AA$B/AppData/Local/Temp/a.txt'");
        assert.equal(shSingleQuote("it's here"), "'it'\\''s here'");
    });
});
