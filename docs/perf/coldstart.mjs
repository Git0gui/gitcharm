/**
 * Cold-start probe — what the panel pays for before it can show a first page.
 *
 * Run after `npm run compile`:
 *     node docs/perf/coldstart.mjs [path-to-repo]
 *
 * It drives the *real* compiled service layer against a real repository with the
 * same call sequence the first paint makes, with every git spawn instrumented.
 * Two numbers are load-bearing and the script fails on them:
 *
 *   1. spawns on the paint path <= 2 — one `git log` for the page is the floor;
 *      everything else on that path must be a filesystem read. The refs snapshot
 *      (for-each-ref) and `git worktree list` are deliberately excluded: arrows
 *      arrive through setDivergence and worktrees are posted after the page.
 *   2. painting the remembered page < 10ms with 0 spawns — this is what turns
 *      "opening a window" into "seeing history", so it must not touch git at all.
 *
 * Everything else is reported without a threshold, because it is the evidence for
 * the two above rather than a promise of its own.
 */

import cp from 'node:child_process';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'out');
const require = createRequire(path.join(ROOT, 'package.json'));

const MAX_PAINT_SPAWNS = 2;
const MAX_SNAPSHOT_PAINT_MS = 10;
const PAGE_FIRST = 20;

// ---------------------------------------------------------------- vscode stub

/**
 * The service layer is exercised without a workbench, so `vscode` is replaced by
 * just enough of itself. Unknown members throw with their own name: a probe that
 * silently answers `undefined` would measure the wrong code path.
 */
function makeVscodeStub(repoPath) {
    const folder = { uri: { fsPath: repoPath, path: repoPath, scheme: 'file' }, name: path.basename(repoPath), index: 0 };
    const configuration = () => ({ get: (_key, fallback) => fallback, update: async () => undefined, has: () => false });
    const named = new Proxy({}, {
        get: (_t, key) => {
            if (key === 'workspaceFolders') {return [folder];}
            if (key === 'getConfiguration') {return configuration;}
            if (key === 'onDidChangeWorkspaceFolders') {return () => ({ dispose() {} });}
            if (key === 'createFileSystemWatcher') {return { onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} };}
            throw new Error(`coldstart stub: vscode.workspace.${String(key)} is not stubbed`);
        }
    });
    const window = new Proxy({ activeTextEditor: undefined }, {
        get: (target, key) => {
            if (key in target) {return target[key];}
            if (key.startsWith('show')) {return async () => undefined;}
            if (key === 'withProgress') {return async (_o, task) => task({ report() {} }, {});}
            if (key === 'registerWebviewViewProvider' || key === 'createOutputChannel') {return () => ({ dispose() {} });}
            if (key === 'onDidChangeTextEditorVisibility' || key === 'onDidChangeActiveTextEditor') {return () => ({ dispose() {} });}
            throw new Error(`coldstart stub: vscode.window.${String(key)} is not stubbed`);
        }
    });
    class Disposable { constructor(fn) { this._fn = fn; } dispose() { this._fn?.(); } static from() { return new Disposable(() => {}); } }
    class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
    const vscode = {
        workspace: named,
        window,
        commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
        extensions: { getExtension: () => undefined },
        env: { language: 'zh-cn', appName: 'coldstart' },
        Uri: {
            file: p => ({ fsPath: p, path: p.replace(/\\/g, '/'), scheme: 'file', with() { return this; }, toString() { return `file://${this.path}`; } }),
            parse: u => ({ fsPath: u, path: u, scheme: 'file', with() { return this; }, toString() { return u; } }),
            joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), path: path.join(base.path, ...parts), scheme: 'file' })
        },
        Disposable,
        EventEmitter,
        ViewColumn: { One: 1 },
        ProgressLocation: { SourceControl: 1, Notification: 15, Window: 10 },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        RelativePattern: class { constructor(_folder, _glob) {} },
        ThemeIcon: class { constructor(id) { this.id = id; } },
        TreeItem: class {},
        Event: { Disposable }
    };
    return vscode;
}

function makeMemento(seed = {}) {
    const store = new Map(Object.entries(seed));
    return {
        get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        update: async (key, value) => {
            if (value === undefined) {store.delete(key);} else {store.set(key, value);}
        },
        keys: () => [...store.keys()]
    };
}

// ------------------------------------------------------------- spawn capture

const runs = [];
let recording = false;
const realSpawn = cp.spawn;
cp.spawn = function patched(command, args, options) {
    const started = process.hrtime.bigint();
    const child = realSpawn.call(this, command, args, options);
    if (recording && command === 'git') {
        const entry = { args: (Array.isArray(args) ? args : []).join(' '), ms: 0 };
        runs.push(entry);
        child.on('close', () => {
            entry.ms = Number(process.hrtime.bigint() - started) / 1e6;
        });
    }
    return child;
};

function phase(name, from) {
    return runs.slice(from).map(run => ({ ...run, ms: run.ms || 0 })).map(run => `      ${run.ms.toFixed(1).padStart(6)}ms  git ${run.args.slice(0, 96)}`).join('\n');
}

// --------------------------------------------------------------------- setup

const repoPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : ROOT;
if (!fs.existsSync(path.join(repoPath, '.git'))) {
    console.error(`Not a git repository: ${repoPath}`);
    process.exit(2);
}

const vscodeStub = makeVscodeStub(repoPath);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {return vscodeStub;}
    return originalLoad.call(this, request, parent, isMain);
};

const { GitService } = require(path.join(OUT, 'services', 'gitService.js'));
const { serializeFirstPage, parseFirstPage } = require(path.join(OUT, 'services', 'firstPageStore.js'));

function freshService(seed) {
    const service = new GitService(makeMemento(seed));
    service.selectRepository(repoPath);
    return service;
}

const failures = [];
function check(label, actual, limit, unit) {
    const ok = actual <= limit;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${unit} (limit ${limit}${unit})`);
    if (!ok) {failures.push(label);}
    return ok;
}

// ------------------------------------------------------- 1. cold first paint

console.log(`\nRepository: ${repoPath}`);

// A machine that ran the extension before has the git probe remembered, so the
// first paint starts without `git --version`; that is the case the threshold is
// written for.
const service = freshService({ 'idea-git.gitAvailable': true });
// Which scope the panel restores comes from the view snapshot; the probe takes it
// from the environment so the same run can be repeated against a branch.
const rememberedBranch = process.env.IDEA_GIT_PROBE_BRANCH || '';
const scope = rememberedBranch && service.getBranchTipHash(rememberedBranch) ? rememberedBranch : undefined;

recording = true;
const paintStart = process.hrtime.bigint();
const probeFrom = runs.length;
await service.isGitAvailable(false);
const [page, names, headHash] = await Promise.all([
    service.getCommitGraphData({ limit: PAGE_FIRST, branch: scope, filters: {} }),
    service.getBranchesWithDetails(false, false),
    service.getHeadHash()
]);
const tip = (scope ? service.getBranchTipHash(scope) : undefined) || headHash;
const paintMs = Number(process.hrtime.bigint() - paintStart) / 1e6;
const paintSpawns = runs.length - probeFrom;
recording = false;

console.log('\n1. Cold first paint (rows + branch names + tip)');
console.log(phase('paint', probeFrom));
console.log(`      ${paintMs.toFixed(1)}ms wall, ${paintSpawns} git spawn(s), ${page.commits.length} rows, ${names.local.length} local branch(es)`);
check('spawns on the paint path', paintSpawns, MAX_PAINT_SPAWNS, '');

// --------------------------------------------------- 2. what the paint avoids

recording = true;
const afterFrom = runs.length;
const divergenceStart = process.hrtime.bigint();
await service.getDivergenceInfo();
const divergenceMs = Number(process.hrtime.bigint() - divergenceStart) / 1e6;
const divergenceSpawns = runs.length - afterFrom;
const worktreeStart = process.hrtime.bigint();
await service.getWorktrees();
const worktreeMs = Number(process.hrtime.bigint() - worktreeStart) / 1e6;
recording = false;

console.log('\n2. Off the paint path (reported, not thresholded)');
console.log(`      ${divergenceMs.toFixed(1)}ms arrows (${divergenceSpawns} spawn) — arrives via setDivergence`);
console.log(`      ${worktreeMs.toFixed(1)}ms worktree list — posted after the page`);

// ------------------------------------------- 3. painting the remembered page

const payload = serializeFirstPage({
    repoPath: service.repositoryPath,
    branch: scope,
    tip,
    commits: page.commits,
    hasMore: page.commits.length >= PAGE_FIRST
});
if (!payload) {
    console.error('\nNo snapshot to measure: the page could not be serialised (empty repository?).');
    process.exit(2);
}

const snapshotService = freshService({ 'idea-git.gitAvailable': true });
recording = true;
const snapFrom = runs.length;
const snapStart = process.hrtime.bigint();
const snap = parseFirstPage(payload);
// The revalidation the host does before showing it: one filesystem read.
const liveTip = (snap.branch ? snapshotService.getBranchTipHash(snap.branch) : undefined) || await snapshotService.getHeadHash();
const snapMs = Number(process.hrtime.bigint() - snapStart) / 1e6;
const snapSpawns = runs.length - snapFrom;
recording = false;

console.log('\n3. Painting the remembered page (0.1.9 behaviour would be step 1 again)');
console.log(`      ${(snapMs * 1000).toFixed(0)}µs, ${snapSpawns} git spawn(s), ${snap.commits.length} rows, tip ${liveTip === snap.tip ? 'matches' : 'MOVED — snapshot correctly refused'}`);
check('snapshot paint', snapMs, MAX_SNAPSHOT_PAINT_MS, 'ms');
check('snapshot paint spawns', snapSpawns, 0, '');

// -------------------------------------------------------------- 4. the margin

console.log('\nSummary');
console.log(`      cold paint      ${paintMs.toFixed(1)}ms`);
console.log(`      snapshot paint  ${snapMs.toFixed(2)}ms`);
console.log(`      rows on screen earlier by ~${(paintMs - snapMs).toFixed(0)}ms of git time and ${paintSpawns - snapSpawns} spawn(s)`);

if (failures.length > 0) {
    console.error(`\nCold-start thresholds broken: ${failures.join(', ')}`);
    process.exit(1);
}
console.log('\nCold-start thresholds hold.');
