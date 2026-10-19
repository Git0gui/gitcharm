import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    FAVORITES_VERSION,
    RecentBranchReader,
    checkoutTarget,
    favoritesOf,
    normalizeFavoriteStore,
    parseCheckoutTargets,
    withFavoriteRenamed,
    withFavoriteToggled
} from '../services/branchMarks';
import { repositoryKey } from '../services/gitUtils';

/** One reflog line as git writes it: `<old> <new> <committer> <ts> <tz>\t<subject>`. */
function logLine(subject: string, oldHash = 'a'.repeat(40), newHash = 'b'.repeat(40)): string {
    return `${oldHash} ${newHash} Liu Gui <liu@example.com> 1760000000 +0800\t${subject}`;
}

describe('checkoutTarget', () => {
    it('reads the branch the step landed on', () => {
        assert.equal(checkoutTarget('checkout: moving from main to dev/x'), 'dev/x');
        assert.equal(checkoutTarget('checkout: moving from (none) to main'), 'main');
    });

    it('still answers when the source side is a detached state', () => {
        // The source may contain spaces, which is why the target is taken from the
        // last " to " instead of the first one.
        assert.equal(checkoutTarget('checkout: moving from (detached from 1ab2c3d) to main'), 'main');
    });

    it('skips a step that landed on no branch', () => {
        assert.equal(checkoutTarget('checkout: moving from main to (detached from 1ab2c3d)'), undefined);
        assert.equal(checkoutTarget('checkout: moving from main to 1ab2c3d'), undefined);
    });

    it('ignores subjects that are not checkouts', () => {
        assert.equal(checkoutTarget('commit: add feature'), undefined);
        assert.equal(checkoutTarget('merge branch main: Fast-forward'), undefined);
        assert.equal(checkoutTarget('checkout: something else'), undefined);
    });
});

describe('parseCheckoutTargets', () => {
    it('returns newest first', () => {
        const text = [
            logLine('checkout: moving from main to one'),
            logLine('checkout: moving from one to two'),
            logLine('checkout: moving from two to three')
        ].join('\n');
        assert.deepEqual(parseCheckoutTargets(text), ['three', 'two', 'one']);
    });

    it('keeps the most recent spelling of a branch visited twice', () => {
        const text = [
            logLine('checkout: moving from main to one'),
            logLine('checkout: moving from one to main'),
            logLine('checkout: moving from main to one')
        ].join('\n');
        assert.deepEqual(parseCheckoutTargets(text), ['one', 'main']);
    });

    it('stops at the limit', () => {
        const text = ['a', 'b', 'c', 'd'].map(name => logLine(`checkout: moving from prev to ${name}`)).join('\n');
        assert.deepEqual(parseCheckoutTargets(text, 2), ['d', 'c']);
    });

    it('tolerates CRLF, blank and malformed lines', () => {
        const text = [
            '',
            'this is not a reflog line',
            logLine('commit: work'),
            logLine('checkout: moving from main to release') + '\r'
        ].join('\n');
        assert.deepEqual(parseCheckoutTargets(text), ['release']);
    });
});

describe('RecentBranchReader', () => {
    /** A plain clone: .git is a directory, so HEAD's log sits under it. */
    function repoWithLog(lines: string[]): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-recent-'));
        const gitDir = path.join(root, '.git');
        fs.mkdirSync(path.join(gitDir, 'logs'), { recursive: true });
        fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
        fs.writeFileSync(path.join(gitDir, 'logs', 'HEAD'), lines.join('\n') + '\n');
        return root;
    }

    it('leads with the branch HEAD is on', () => {
        const root = repoWithLog([
            logLine('checkout: moving from main to one'),
            logLine('checkout: moving from one to main')
        ]);
        const reader = new RecentBranchReader(() => root);
        assert.deepEqual(reader.read('main'), ['main', 'one']);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('re-reads once the log grows and keeps the cache while it does not', () => {
        const root = repoWithLog([logLine('checkout: moving from main to one')]);
        const reader = new RecentBranchReader(() => root);
        assert.deepEqual(reader.read(''), ['one']);

        const logPath = path.join(root, '.git', 'logs', 'HEAD');
        fs.appendFileSync(logPath, logLine('checkout: moving from one to two', 'b'.repeat(40), 'c'.repeat(40)) + '\n');
        assert.deepEqual(reader.read(''), ['two', 'one']);

        // Same content, same signature: the cached list is returned untouched even
        // though a caller asked again.
        reader.invalidate();
        assert.deepEqual(reader.read(''), ['two', 'one']);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('answers with the current branch when there is no log at all', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-nolog-'));
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        const reader = new RecentBranchReader(() => root);
        assert.deepEqual(reader.read('main'), ['main']);
        assert.deepEqual(reader.read(''), []);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('is empty for a workspace that is not a repository', () => {
        const reader = new RecentBranchReader(() => undefined);
        assert.deepEqual(reader.read('main'), ['main']);
    });
});

describe('normalizeFavoriteStore', () => {
    it('round-trips a valid store', () => {
        const store = { version: FAVORITES_VERSION, byRepository: { 'd:/repo': ['main', 'dev/x'] } };
        assert.deepEqual(normalizeFavoriteStore(store), store);
    });

    it('discards a payload of another version or a malformed shape', () => {
        assert.deepEqual(normalizeFavoriteStore({ version: 99, byRepository: {} }).byRepository, {});
        assert.deepEqual(normalizeFavoriteStore(undefined).byRepository, {});
        assert.deepEqual(normalizeFavoriteStore('main').byRepository, {});
        assert.deepEqual(normalizeFavoriteStore({ version: FAVORITES_VERSION, byRepository: [] }).byRepository, {});
    });

    it('drops poisoned entries instead of the whole repository', () => {
        const raw = {
            version: FAVORITES_VERSION,
            byRepository: {
                a: ['main', '"quoted"', '  spaced  ', 42, 'main'],
                b: [1, 2]
            }
        };
        const store = normalizeFavoriteStore(raw);
        assert.deepEqual(store.byRepository, { a: ['main', 'spaced'] });
    });
});

describe('withFavoriteToggled', () => {
    const empty = { version: FAVORITES_VERSION, byRepository: {} };

    it('marks and un-marks a branch', () => {
        const added = withFavoriteToggled(empty, 'D:/repo', 'main');
        assert.deepEqual(added.favorites, ['main']);
        const removed = withFavoriteToggled(added.store, 'D:/repo', 'main');
        assert.deepEqual(removed.favorites, []);
        // An emptied list drops the key entirely rather than storing [].
        assert.deepEqual(removed.store.byRepository, {});
    });

    it('keeps one repository\'s marks out of another\'s', () => {
        const added = withFavoriteToggled(empty, 'D:/projectA', 'main');
        assert.deepEqual(favoritesOf(added.store, 'D:/projectB'), []);
        assert.deepEqual(favoritesOf(added.store, 'D:/projectA'), ['main']);
    });

    it('treats two spellings of one root as the same repository', () => {
        const added = withFavoriteToggled(empty, 'D:\\projectA\\', 'main');
        assert.deepEqual(favoritesOf(added.store, 'D:/projectA'), ['main']);
    });

    it('leaves the store untouched without a repository', () => {
        const result = withFavoriteToggled(empty, undefined, 'main');
        assert.equal(result.store, empty);
        assert.deepEqual(result.favorites, []);
    });
});

describe('withFavoriteRenamed', () => {
    it('moves the mark and keeps its position', () => {
        // Key spelled exactly as repositoryKey() normalises this machine's path: the
        // store's own casing is what a lookup compares against, and case folding is
        // only enabled where the filesystem ignores case.
        const key = repositoryKey('D:/repo');
        const store = { version: FAVORITES_VERSION, byRepository: { [key]: ['one', 'main', 'two'] } };
        const renamed = withFavoriteRenamed(store, 'D:/repo', 'main', 'release');
        assert.deepEqual(renamed.favorites, ['one', 'release', 'two']);
        assert.deepEqual(favoritesOf(renamed.store, 'D:/repo'), ['one', 'release', 'two']);
    });

    it('is a no-op when the old name was never marked', () => {
        const store = { version: FAVORITES_VERSION, byRepository: { [repositoryKey('D:/repo')]: ['one'] } };
        const renamed = withFavoriteRenamed(store, 'D:/repo', 'main', 'release');
        assert.equal(renamed.store, store);
        assert.deepEqual(renamed.favorites, ['one']);
    });
});
