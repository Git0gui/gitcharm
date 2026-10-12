import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseBranchCache, serializeBranchCache, BRANCH_CACHE_VERSION } from '../services/branchCacheStore';
import { parseTrackInfo, parseSymbolicRef, parseRefPath, parseWorkingTreeSummary, parseStatusEntries, operationFromStateFiles, isOperationStateFile, remoteUrlToWebBase, commitWebUrl, branchWebUrl, parseGitConfigRemoteUrl, parseGitConfigRemoteNames, pickFetchRemote, repositoryKey, collectRepositoryRoots, discoverRepositoryRoots, tagNameProblem, peeledCommitFromTagObject, parseStashList, parsePathFilter, parseReflogList } from '../services/gitUtils';
import { t } from '../i18n';

describe('parseTrackInfo', () => {
    it('parses ahead and behind counts', () => {
        assert.deepEqual(parseTrackInfo('[ahead 2, behind 1]'), { ahead: 2, behind: 1 });
    });

    it('parses ahead-only', () => {
        assert.deepEqual(parseTrackInfo('[ahead 3]'), { ahead: 3, behind: 0 });
    });

    it('parses behind-only', () => {
        assert.deepEqual(parseTrackInfo('[behind 5]'), { ahead: 0, behind: 5 });
    });

    it('returns zeros for empty or missing track info', () => {
        assert.deepEqual(parseTrackInfo(''), { ahead: 0, behind: 0 });
        assert.deepEqual(parseTrackInfo(undefined), { ahead: 0, behind: 0 });
    });

    it('returns zeros for gone upstream', () => {
        assert.deepEqual(parseTrackInfo('[gone]'), { ahead: 0, behind: 0 });
    });
});

describe('parseSymbolicRef', () => {
    it('parses a branch ref', () => {
        assert.equal(parseSymbolicRef('ref: refs/heads/main'), 'main');
    });

    it('parses nested branch names and trailing newline', () => {
        assert.equal(parseSymbolicRef('ref: refs/heads/feature/my-branch\n'), 'feature/my-branch');
    });

    it('returns undefined for detached HEAD', () => {
        assert.equal(parseSymbolicRef('8e9cf03f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'), undefined);
    });

    it('returns undefined for non-branch refs', () => {
        assert.equal(parseSymbolicRef('ref: refs/remotes/origin/main'), undefined);
    });
});

describe('parseRefPath', () => {
    it('accepts both HEAD and head-name spellings', () => {
        assert.equal(parseRefPath('ref: refs/heads/main'), 'main');
        assert.equal(parseRefPath('refs/heads/feature_x\n'), 'feature_x');
    });

    it('keeps nested branch paths', () => {
        assert.equal(parseRefPath('refs/heads/v0.0.5/no-vscode-git'), 'v0.0.5/no-vscode-git');
    });

    it('returns undefined for SHAs and non-branch refs', () => {
        assert.equal(parseRefPath('8e9cf03f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'), undefined);
        assert.equal(parseRefPath('refs/tags/v1.0.0'), undefined);
    });
});

describe('branchCacheStore', () => {
    const sample = {
        local: [{ name: 'main', upstream: 'origin/main', ahead: 1, behind: 2 }],
        remote: [{ name: 'origin/main' }]
    };

    it('round-trips through serialize/parse', () => {
        const text = serializeBranchCache('/repo', sample);
        const parsed = parseBranchCache(text);
        assert.ok(parsed);
        assert.equal(parsed.version, BRANCH_CACHE_VERSION);
        assert.equal(parsed.repoPath, '/repo');
        assert.deepEqual(parsed.branches, sample);
        assert.equal(typeof parsed.timestamp, 'number');
    });

    it('rejects cache without a version field (legacy format)', () => {
        const legacy = JSON.stringify({ timestamp: Date.now(), repoPath: '/repo', branches: sample });
        assert.equal(parseBranchCache(legacy), undefined);
    });

    it('rejects cache with a stale version', () => {
        const stale = JSON.stringify({ version: BRANCH_CACHE_VERSION + 1, timestamp: 1, repoPath: '/repo', branches: sample });
        assert.equal(parseBranchCache(stale), undefined);
    });

    it('rejects malformed JSON', () => {
        assert.equal(parseBranchCache('{not json'), undefined);
        assert.equal(parseBranchCache(''), undefined);
    });

    it('rejects quoted branch names (poisoned by the old spawn quoting bug)', () => {
        const poisoned = JSON.stringify({
            version: BRANCH_CACHE_VERSION,
            timestamp: 1,
            repoPath: '/repo',
            branches: { local: [{ name: '"main', ahead: 0, behind: 0 }], remote: [] }
        });
        assert.equal(parseBranchCache(poisoned), undefined);
    });

    it('rejects entries with wrong field types', () => {
        const bad = JSON.stringify({
            version: BRANCH_CACHE_VERSION,
            timestamp: 1,
            repoPath: '/repo',
            branches: { local: [{ name: 'main', ahead: 'many', behind: 0 }], remote: [] }
        });
        assert.equal(parseBranchCache(bad), undefined);
    });

    it('rejects missing branches arrays', () => {
        const bad = JSON.stringify({ version: BRANCH_CACHE_VERSION, timestamp: 1, repoPath: '/repo', branches: {} });
        assert.equal(parseBranchCache(bad), undefined);
    });
});

describe('parseWorkingTreeSummary', () => {
    it('returns zero files for a clean working tree', () => {
        assert.deepEqual(parseWorkingTreeSummary(''), { files: 0, untracked: 0 });
    });

    it('counts untracked entries', () => {
        const raw = '?? a.txt\0?? dir/b.txt\0';
        assert.deepEqual(parseWorkingTreeSummary(raw), { files: 2, untracked: 2 });
    });

    it('counts staged and unstaged changes as files', () => {
        const raw = 'M  a.txt\0 D b.txt\0?? c.txt\0';
        assert.deepEqual(parseWorkingTreeSummary(raw), { files: 3, untracked: 1 });
    });

    it('does not double-count the rename source field', () => {
        const raw = 'R  renamed_a.txt\0a.txt\0?? new.txt\0';
        assert.deepEqual(parseWorkingTreeSummary(raw), { files: 2, untracked: 1 });
    });
});

describe('parseStatusEntries', () => {
    it('returns no entries for a clean working tree', () => {
        assert.deepEqual(parseStatusEntries(''), []);
        assert.deepEqual(parseStatusEntries('\0'), []);
    });

    it('splits index and worktree status letters', () => {
        const [staged, modified] = parseStatusEntries('M  a.txt\0 M b.txt\0');
        assert.equal(staged.path, 'a.txt');
        assert.equal(staged.indexStatus, 'M');
        assert.equal(staged.worktreeStatus, ' ');
        assert.equal(modified.path, 'b.txt');
        assert.equal(modified.indexStatus, ' ');
        assert.equal(modified.worktreeStatus, 'M');
    });

    it('keeps both stages for an MM entry', () => {
        const [entry] = parseStatusEntries('MM c.txt\0');
        assert.equal(entry.indexStatus, 'M');
        assert.equal(entry.worktreeStatus, 'M');
        assert.equal(entry.conflicted, false);
    });

    it('marks untracked entries', () => {
        const [entry] = parseStatusEntries('?? new/dir.txt\0');
        assert.equal(entry.untracked, true);
        assert.equal(entry.conflicted, false);
    });

    it('consumes the rename source field as fromPath', () => {
        const entries = parseStatusEntries('R  b.txt\0a.txt\0?? c.txt\0');
        assert.equal(entries.length, 2);
        assert.equal(entries[0].path, 'b.txt');
        assert.equal(entries[0].fromPath, 'a.txt');
        assert.equal(entries[1].path, 'c.txt');
    });

    it('flags every unmerged status code as conflicted', () => {
        const entries = parseStatusEntries('AA a\0DD b\0AU c\0UA d\0DU e\0UD f\0');
        assert.equal(entries.length, 6);
        for (const entry of entries) {
            assert.equal(entry.conflicted, true);
        }
    });

    it('flags ignored entries', () => {
        const [entry] = parseStatusEntries('!! build/out.js\0');
        assert.equal(entry.ignored, true);
    });

    it('keeps quoted-looking and unicode paths verbatim (no shell involved)', () => {
        const [entry] = parseStatusEntries(' M 中文 "quoted".txt\0');
        assert.equal(entry.path, '中文 "quoted".txt');
    });
});

describe('operationFromStateFiles', () => {
    const present = (...names: string[]) => (name: string) => names.includes(name);

    it('reports undefined when no state file exists', () => {
        assert.equal(operationFromStateFiles(present()), undefined);
    });

    it('maps each state file to its operation', () => {
        assert.equal(operationFromStateFiles(present('MERGE_HEAD')), 'merge');
        assert.equal(operationFromStateFiles(present('CHERRY_PICK_HEAD')), 'cherry-pick');
        assert.equal(operationFromStateFiles(present('REVERT_HEAD')), 'revert');
        assert.equal(operationFromStateFiles(present('rebase-merge')), 'rebase');
        assert.equal(operationFromStateFiles(present('rebase-apply')), 'rebase');
    });

    it('lets rebase win — a rebase drives cherry-pick internally and leaves its own head file', () => {
        assert.equal(
            operationFromStateFiles(present('CHERRY_PICK_HEAD', 'MERGE_HEAD', 'rebase-merge')),
            'rebase'
        );
    });

    it('lets cherry-pick win over merge', () => {
        assert.equal(operationFromStateFiles(present('CHERRY_PICK_HEAD', 'MERGE_HEAD')), 'cherry-pick');
    });

    it('reads a conflicted revert as revert, not merge', () => {
        // Empirically a conflicted revert writes REVERT_HEAD (+ MERGE_MSG,
        // AUTO_MERGE) but never MERGE_HEAD; a revert inside a rebase is a rebase.
        assert.equal(operationFromStateFiles(present('REVERT_HEAD', 'MERGE_HEAD')), 'revert');
        assert.equal(operationFromStateFiles(present('REVERT_HEAD', 'rebase-apply')), 'rebase');
    });
});

describe('isOperationStateFile', () => {
    it('accepts exactly the files git removes when an operation settles', () => {
        for (const name of ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_HEAD']) {
            assert.equal(isOperationStateFile(name), true, name);
        }
    });

    it('rejects ordinary git directory entries', () => {
        for (const name of ['HEAD', 'index', 'packed-refs', 'ORIG_HEAD', 'COMMIT_EDITMSG']) {
            assert.equal(isOperationStateFile(name), false, name);
        }
    });

    it('rejects the byproduct files an operation leaves next to the head files', () => {
        // These outlive the operation (or appear without one), so treating them as
        // state would keep the in-progress bar up forever.
        for (const name of ['MERGE_MSG', 'AUTO_MERGE', 'SQUASH_MSG', 'sequencer']) {
            assert.equal(isOperationStateFile(name), false, name);
        }
    });
});

describe('remoteUrlToWebBase', () => {
    it('handles the scp-like form GitHub uses', () => {
        assert.equal(remoteUrlToWebBase('git@github.com:Git0gui/gitcharm.git'), 'https://github.com/Git0gui/gitcharm');
    });

    it('handles ssh URLs with a user and port, and a trailing slash', () => {
        assert.equal(remoteUrlToWebBase('ssh://git@github.com:22/Git0gui/gitcharm/'), 'https://github.com/Git0gui/gitcharm');
    });

    it('handles https URLs with credentials and a port', () => {
        assert.equal(remoteUrlToWebBase('https://user@gitea.example.com:8443/team/repo.git'), 'https://gitea.example.com/team/repo');
    });

    it('keeps GitLab subgroups intact', () => {
        assert.equal(remoteUrlToWebBase('git@gitlab.com:group/sub/project.git'), 'https://gitlab.com/group/sub/project');
    });

    it('returns undefined for local paths — there is no web UI to open', () => {
        for (const url of ['/srv/git/repo.git', 'C:/Users/me/repo', '\\\\server\\share\\repo', '', '   ']) {
            assert.equal(remoteUrlToWebBase(url), undefined, url);
        }
    });
});

describe('commitWebUrl / branchWebUrl', () => {
    it('append the commit and tree routes', () => {
        assert.equal(commitWebUrl('https://github.com/o/r', 'abc123'), 'https://github.com/o/r/commit/abc123');
        assert.equal(branchWebUrl('https://github.com/o/r', 'main'), 'https://github.com/o/r/tree/main');
    });

    it('stay undefined when the remote has no web base', () => {
        assert.equal(commitWebUrl(undefined, 'abc123'), undefined);
        assert.equal(branchWebUrl(undefined, 'main'), undefined);
    });
});

describe('parseGitConfigRemoteUrl', () => {
    it('prefers the requested remote over the first one listed', () => {
        const raw = [
            '[core]',
            ' repositoryformatversion = 0',
            '[remote "up"]',
            '\turl = git@github.com:other/up.git',
            '\tfetch = +refs/heads/*:refs/remotes/up/*',
            '[remote "origin"]',
            '\turl = git@github.com:Git0gui/gitcharm.git',
        ].join('\n');
        assert.equal(parseGitConfigRemoteUrl(raw), 'git@github.com:Git0gui/gitcharm.git');
        assert.equal(parseGitConfigRemoteUrl(raw, 'up'), 'git@github.com:other/up.git');
    });

    it('falls back to the first remote when the preferred one is absent', () => {
        const raw = '[remote "fork"]\nurl = https://github.com/me/repo.git\n';
        assert.equal(parseGitConfigRemoteUrl(raw), 'https://github.com/me/repo.git');
    });

    it('accepts an unquoted section name and a bare url value', () => {
        assert.equal(parseGitConfigRemoteUrl('[remote origin]\n  url=git@github.com:o/r.git'), 'git@github.com:o/r.git');
    });

    it('ignores urls outside remote sections and keeps the first url of a section', () => {
        const raw = ['[branch "main"]', ' remote = origin', '[remote "origin"]', 'url = a', 'url = b'].join('\n');
        assert.equal(parseGitConfigRemoteUrl(raw), 'a');
    });

    it('returns undefined when the repo has no remote', () => {
        assert.equal(parseGitConfigRemoteUrl('[core]\n\tbare = false\n'), undefined);
    });
});

describe('tagNameProblem', () => {
    it('accepts names git accepts, ignoring surrounding spaces', () => {
        for (const name of ['v1.0.0', '1.0', 'release/2026-10', 'a.b.c', '释放v1', '  v1.0  ']) {
            assert.equal(tagNameProblem(name), undefined, name);
        }
    });

    it('rejects an empty name', () => {
        assert.equal(tagNameProblem(''), t('tag.nameEmpty'));
        assert.equal(tagNameProblem('   '), t('tag.nameEmpty'));
    });

    it('rejects ref-illegal punctuation and leading dashes', () => {
        for (const name of ['a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', '..ref', 'user@{0}', '-tag']) {
            assert.equal(tagNameProblem(name), t('tag.nameChars'), name);
        }
    });

    it('rejects a trailing dot and dot-prefixed path components', () => {
        // Probed against `git check-ref-format refs/tags/…`; the trailing dot of
        // "a./b" is fine, only a component that *starts* with a dot is not.
        assert.equal(tagNameProblem('end.'), t('tag.nameDot'));
        assert.equal(tagNameProblem('.hidden'), t('tag.nameDot'));
        assert.equal(tagNameProblem('a/.hidden'), t('tag.nameDot'));
        assert.equal(tagNameProblem('a./b'), undefined);
    });

    it('rejects a .lock suffix', () => {
        assert.equal(tagNameProblem('v1.lock'), t('tag.nameLock'));
    });

    it('rejects a name that is already taken', () => {
        assert.equal(tagNameProblem('v1', ['v1', 'v2']), t('tag.nameExists', { name: 'v1' }));
        assert.equal(tagNameProblem(' v1 ', ['v1']), t('tag.nameExists', { name: 'v1' }));
        assert.equal(tagNameProblem('v3', ['v1']), undefined);
    });
});

describe('peeledCommitFromTagObject', () => {
    const commit = 'ba88db9f8714fa62ef566f6655e5775276d8616c';
    // Layout verified against a real loose tag object: `tag <size>` NUL, header
    // lines, a blank line, then the message.
    const tagObject = `tag 112\u0000object ${commit}\ntype commit\ntag v1.0.0\ntagger A <a@a> 1700000000 +0800\n\nrelease notes\n`;

    it('returns the tagged commit of an annotated tag', () => {
        assert.equal(peeledCommitFromTagObject(tagObject), commit);
    });

    it('ignores a body that mentions another object', () => {
        // Only the header counts: the message is cut at its leading blank line.
        const forged = `tag 200\u0000object ${commit}\ntype commit\n\nobject 0000000000000000000000000000000000000000\n`;
        assert.equal(peeledCommitFromTagObject(forged), commit);
    });

    it('returns undefined for commit objects and malformed input', () => {
        assert.equal(peeledCommitFromTagObject(`commit 200\u0000tree ${commit}\nparent ${commit}\n`), undefined);
        assert.equal(peeledCommitFromTagObject(`tag 100\u0000type commit\n\u0000`), undefined);
        assert.equal(peeledCommitFromTagObject(`tag 100\u0000object zzz\n\u0000`), undefined);
        assert.equal(peeledCommitFromTagObject(`object ${commit}\n`), undefined);
        assert.equal(peeledCommitFromTagObject(''), undefined);
    });
});

describe('parseStashList', () => {
    const nul = '\0';
    const row = (ref: string, subject: string, date: string) => [ref, subject, date].join(nul);

    it('parses index, subject and date', () => {
        const out = parseStashList(row('stash@{0}', 'On main: reworking login', '2026-10-12T23:20:07+08:00') + '\n');
        assert.deepEqual(out, [{ index: 0, message: 'On main: reworking login', date: '2026-10-12T23:20:07+08:00' }]);
    });

    it('keeps a pipe inside the subject intact', () => {
        // The fields are NUL-separated precisely because git subjects carry pipes.
        const out = parseStashList(row('stash@{1}', 'WIP on main: 1a2b3c4 fix a|b', '2026-10-01T10:00:00+08:00'));
        assert.equal(out[0].message, 'WIP on main: 1a2b3c4 fix a|b');
        assert.equal(out[0].index, 1);
    });

    it('reads every entry, newest first, and skips CRLF noise', () => {
        const raw = [
            row('stash@{0}', 'newest', '2026-10-12T00:00:00+08:00'),
            row('stash@{2}', 'oldest', '2026-10-01T00:00:00+08:00')
        ].join('\r\n');
        const out = parseStashList(raw);
        assert.deepEqual(out.map(e => e.index), [0, 2]);
        assert.deepEqual(out.map(e => e.message), ['newest', 'oldest']);
    });

    it('tolerates missing trailing fields', () => {
        const out = parseStashList('stash@{0}');
        assert.deepEqual(out, [{ index: 0, message: '', date: '' }]);
    });

    it('returns no entries for empty output or a line without a stash refname', () => {
        assert.deepEqual(parseStashList(''), []);
        assert.deepEqual(parseStashList('\n  \n'), []);
        assert.deepEqual(parseStashList([
            row('HEAD@{3}', 'not a stash line', '2026-10-01T00:00:00+08:00'),
            row('stash@{1}', 'kept', '2026-10-02T00:00:00+08:00')
        ].join('\n')), [{ index: 1, message: 'kept', date: '2026-10-02T00:00:00+08:00' }]);
    });
});

describe('parsePathFilter', () => {
    it('splits comma-separated pathspecs and trims each', () => {
        assert.deepEqual(parsePathFilter(' src/a.ts, media , x '), ['src/a.ts', 'media', 'x']);
    });

    it('passes globs and repo-relative paths through untouched', () => {
        assert.deepEqual(parsePathFilter('src/*.ts, media/webview.js'), ['src/*.ts', 'media/webview.js']);
    });

    it('returns nothing for empty input', () => {
        assert.deepEqual(parsePathFilter(undefined), []);
        assert.deepEqual(parsePathFilter(''), []);
        assert.deepEqual(parsePathFilter(' , , '), []);
    });

    it('drops segments containing control characters', () => {
        assert.deepEqual(parsePathFilter('ok.ts, bad\u0000.ts'), ['ok.ts']);
    });

    it('keeps a leading dash: the caller appends these only after a -- separator', () => {
        assert.deepEqual(parsePathFilter('--not-an-option'), ['--not-an-option']);
    });
});

describe('parseReflogList', () => {
    const nul = '\0';
    const row = (ref: string, hash: string, subject: string, date: string) => [ref, hash, subject, date].join(nul);

    it('splits the action off the first colon only', () => {
        const out = parseReflogList(row('HEAD@{1}', '6e3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f', 'commit: fix: keep a colon in the message', '2026-10-12T10:00:00+08:00'));
        assert.equal(out.length, 1);
        assert.equal(out[0].ref, 'HEAD@{1}');
        assert.equal(out[0].action, 'commit');
        assert.equal(out[0].message, 'fix: keep a colon in the message');
        assert.equal(out[0].shortHash, '6e3f2a1');
    });

    it('keeps a parenthesised action as one action', () => {
        const out = parseReflogList(row('HEAD@{0}', 'aaaaaaaabbbbbbbb', 'commit (amend): 重写消息', '2026-10-12T10:00:00+08:00'));
        assert.deepEqual([out[0].action, out[0].message], ['commit (amend)', '重写消息']);
    });

    it('leaves the message empty when the subject has no colon', () => {
        const out = parseReflogList(row('main@{2}', 'bbbbbbbbcccccccc', ' Branch created', '2026-10-10T08:00:00+08:00'));
        assert.deepEqual([out[0].action, out[0].message], ['Branch created', '']);
        assert.equal(out[0].date, '2026-10-10T08:00:00+08:00');
    });

    it('handles checkout and reset subjects, CRLF and blank lines', () => {
        const raw = [
            row('HEAD@{0}', '1111111122222222', 'checkout: moving from main to feat/x', '2026-10-12T09:00:00+08:00'),
            '',
            row('HEAD@{1}', '3333333344444444', 'reset: moving to HEAD~1', '2026-10-11T09:00:00+08:00')
        ].join('\r\n');
        const out = parseReflogList(raw);
        assert.deepEqual(out.map(e => e.action), ['checkout', 'reset']);
        assert.deepEqual(out.map(e => e.message), ['moving from main to feat/x', 'moving to HEAD~1']);
    });

    it('returns nothing for empty output or a line without a hash', () => {
        assert.deepEqual(parseReflogList(''), []);
        assert.deepEqual(parseReflogList('\n   \n'), []);
        assert.deepEqual(parseReflogList('HEAD@{0}'), []);
        assert.deepEqual(parseReflogList(row('HEAD@{0}', '', 'commit: x', '2026-10-12T09:00:00+08:00')), []);
    });
});

describe('parseGitConfigRemoteNames', () => {
    it('collects every remote section in file order', () => {
        const raw = [
            '[core]',
            '\trepositoryformatversion = 0',
            '[remote "origin"]',
            '\turl = git@github.com:Git0gui/gitcharm.git',
            '[branch "main"]',
            '\tremote = origin',
            '[remote "fork"]',
            '\turl = https://github.com/me/repo.git',
        ].join('\n');
        assert.deepEqual(parseGitConfigRemoteNames(raw), ['origin', 'fork']);
    });

    it('accepts an unquoted section name and de-duplicates repeats', () => {
        const raw = '[remote upstream]\nurl = a\n[remote "upstream"]\nurl = b';
        assert.deepEqual(parseGitConfigRemoteNames(raw), ['upstream']);
    });

    it('ignores comments, blanks and non-remote sections', () => {
        const raw = ['# [remote "x"]', '', '  ; [remote "y"]', '[submodule "vendor"]', '[remote "z"]'].join('\n');
        assert.deepEqual(parseGitConfigRemoteNames(raw), ['z']);
    });

    it('returns an empty list when the repo has no remote', () => {
        assert.deepEqual(parseGitConfigRemoteNames('[core]\n\tbare = false\n'), []);
        assert.deepEqual(parseGitConfigRemoteNames(''), []);
    });
});

describe('pickFetchRemote', () => {
    it('prefers origin wherever it appears', () => {
        assert.equal(pickFetchRemote(['fork', 'origin']), 'origin');
    });

    it('falls back to the first remote without origin', () => {
        assert.equal(pickFetchRemote(['upstream', 'fork']), 'upstream');
    });

    it('returns an empty string for no remotes', () => {
        assert.equal(pickFetchRemote([]), '');
    });
});

describe('repositoryKey', () => {
    it('unifies separators and drops trailing ones', () => {
        assert.equal(repositoryKey('D:\\Work\\repo\\', false), 'D:/Work/repo');
        assert.equal(repositoryKey('/home/me/repo/', false), '/home/me/repo');
    });

    it('folds case only for a case-insensitive filesystem', () => {
        assert.equal(repositoryKey('D:/Work/Repo', true), 'd:/work/repo');
        assert.equal(repositoryKey('/home/Me/Repo', false), '/home/Me/Repo');
    });

    it('treats two spellings of one root as the same repository', () => {
        assert.equal(repositoryKey('D:/Work/GitCharm', true), repositoryKey('d:\\work\\gitcharm\\', true));
    });
});

describe('collectRepositoryRoots', () => {
    const roots: Record<string, string | undefined> = {
        'D:/Work/app': 'D:/Work/app',
        'D:/Work/app/src': 'D:/Work/app',
        'D:/Work/lib': 'D:/Work/lib',
        'D:/Notes': undefined          // not a repository
    };
    const probe = (dir: string): string | undefined => roots[dir];

    it('keeps workspace order and skips folders that are not repositories', () => {
        assert.deepEqual(collectRepositoryRoots(['D:/Work/lib', 'D:/Notes', 'D:/Work/app'], probe, false),
            ['D:/Work/lib', 'D:/Work/app']);
    });

    it('collapses several folders of one repository into a single entry', () => {
        assert.deepEqual(collectRepositoryRoots(['D:/Work/app', 'D:/Work/app/src'], probe, false), ['D:/Work/app']);
    });

    it('dedupes case-insensitively only when the filesystem is', () => {
        const mixed = ['D:/Work/app', 'd:/work/APP'];
        assert.deepEqual(collectRepositoryRoots(mixed, dir => dir, true).length, 1);
        assert.deepEqual(collectRepositoryRoots(mixed, dir => dir, false).length, 2);
    });

    it('returns nothing for an empty workspace', () => {
        assert.deepEqual(collectRepositoryRoots([], probe, false), []);
    });
});

describe('discoverRepositoryRoots', () => {
    const join = (dir: string, child: string) => `${dir}/${child}`;

    /**
     * Drive the scan over a fake tree: `dirs` maps a directory to its child
     * names, `repos` lists the ones that hold a `.git`. `visited` collects every
     * directory whose children were listed, which is what costs real I/O.
     */
    function scan(
        startDirs: string[],
        dirs: Record<string, string[]>,
        repos: string[],
        options?: { maxDepth?: number; budget?: number },
        visited?: string[]
    ): string[] {
        const known = new Set(repos);
        return discoverRepositoryRoots(startDirs, join, dir => known.has(dir), dir => {
            visited?.push(dir);
            return dirs[dir] ?? [];
        }, options, false);
    }

    it('finds the sibling repositories below a plain parent folder', () => {
        assert.deepEqual(scan(['D:/Work'], {
            'D:/Work': ['app', 'lib', 'Notes'],
            'D:/Work/Notes': ['scratch']
        }, ['D:/Work/lib', 'D:/Work/app']), ['D:/Work/app', 'D:/Work/lib']);
    });

    it('never lists inside a repository it already found', () => {
        const visited: string[] = [];
        scan(['D:/Work'], {
            'D:/Work': ['app'],
            'D:/Work/app': ['deep', 'nested', 'src', 'test', 'docs']
        }, ['D:/Work/app'], undefined, visited);
        assert.deepEqual(visited, ['D:/Work']);
    });

    it('skips dependency, build and hidden directories', () => {
        assert.deepEqual(scan(['D:/Work'], {
            'D:/Work': ['node_modules', '.cache', 'dist', 'real']
        }, ['D:/Work/node_modules/left-pad', 'D:/Work/.cache/probe', 'D:/Work/dist/x', 'D:/Work/real']),
        ['D:/Work/real']);
    });

    it('respects the depth limit', () => {
        const dirs = {
            'D:/Work': ['team'],
            'D:/Work/team': ['sandbox'],
            'D:/Work/team/sandbox': ['repo']
        };
        const repos = ['D:/Work/team/sandbox/repo'];
        assert.deepEqual(scan(['D:/Work'], dirs, repos, { maxDepth: 2 }), []);
        assert.deepEqual(scan(['D:/Work'], dirs, repos, { maxDepth: 3 }), repos);
    });

    it('reports the start directory itself when it is a repository', () => {
        const visited: string[] = [];
        assert.deepEqual(scan(['D:/Work/app'], { 'D:/Work/app': ['src'] }, ['D:/Work/app'], undefined, visited),
            ['D:/Work/app']);
        assert.deepEqual(visited, []);
    });

    it('dedupes a repository reachable from two start directories', () => {
        assert.deepEqual(scan(['D:/Work', 'D:/Work/team'], {
            'D:/Work': ['team'],
            'D:/Work/team': ['app']
        }, ['D:/Work/team/app']), ['D:/Work/team/app']);
    });

    it('stops listing once the budget is spent', () => {
        assert.deepEqual(scan(['D:/Work'], { 'D:/Work': ['app'] }, ['D:/Work/app'], { budget: 0 }), []);
    });
});
