/**
 * Search probe — what one Enter in the search box costs.
 *
 * Run after `npm run compile`:
 *     node docs/perf/search.mjs [path-to-repo]
 *
 * It drives the *real* compiled provider through a stub webview, so the numbers
 * cover the whole round trip (message handler included), not just the service.
 * Three numbers are load-bearing and the script fails on them:
 *
 *   1. a search outside the graph cache spawns <= 1 git process — the `git log`
 *      that answers it. The branch tree, HEAD and arrows on screen are still
 *      true while a filter narrows the list, so re-reading them is waste.
 *   2. that one spawn carries no --topo-order: a filtered list is a result set,
 *      and buffering the whole walk defeats -n (measured 3-4x on 20k commits).
 *   3. the unfiltered first page still carries --topo-order: there the lane
 *      graph is the point, and its budget is pinned by coldstart.mjs.
 *
 * A repeated identical search must cost 0 spawns (the graph cache key covers
 * every filter field); that is reported and thresholded too.
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

const MAX_SEARCH_SPAWNS = 1;
const SETTLE_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------- vscode stub

function makeVscodeStub(repoPath) {
    const folder = { uri: { fsPath: repoPath, path: repoPath, scheme: 'file' }, name: path.basename(repoPath), index: 0 };
    const configuration = () => ({ get: (_key, fallback) => fallback, update: async () => undefined, has: () => false });
    const workspace = new Proxy({}, {
        get: (_t, key) => {
            if (key === 'workspaceFolders') {return [folder];}
            if (key === 'getConfiguration') {return configuration;}
            if (key === 'onDidChangeWorkspaceFolders') {return () => ({ dispose() {} });}
            if (key === 'createFileSystemWatcher') {return { onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} };}
            throw new Error(`search stub: vscode.workspace.${String(key)} is not stubbed`);
        }
    });
    const window = new Proxy({ activeTextEditor: undefined }, {
        get: (target, key) => {
            if (key in target) {return target[key];}
            if (key.startsWith('show')) {return async () => undefined;}
            if (key === 'setStatusBarMessage') {return () => ({ dispose() {} });}
            if (key === 'withProgress') {return async (_o, task) => task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) });}
            if (key === 'registerWebviewViewProvider' || key === 'createOutputChannel') {return () => ({ dispose() {} });}
            if (key === 'onDidChangeTextEditorVisibility' || key === 'onDidChangeActiveTextEditor') {return () => ({ dispose() {} });}
            throw new Error(`search stub: vscode.window.${String(key)} is not stubbed`);
        }
    });
    class Disposable { constructor(fn) { this._fn = fn; } dispose() { this._fn?.(); } static from() { return new Disposable(() => {}); } }
    class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
    return {
        workspace,
        window,
        commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
        extensions: { getExtension: () => undefined },
        env: { language: 'zh-cn', appName: 'search-probe' },
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

// --------------------------------------------------------------------- setup

const repoPath = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
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
const { GraphViewProvider } = require(path.join(OUT, 'views', 'graphView.js'));

const failures = [];
function check(label, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
    if (!ok) {failures.push(label);}
    return ok;
}

// A stub webview: everything the provider posts is recorded, and waiters are
// resolved by predicate so a phase ends when the panel actually answered.
const posted = [];
const waiters = [];
let onMessage = null;
const webview = {
    options: {},
    html: '',
    cspSource: 'https://stub.invalid',
    asWebviewUri: uri => uri,
    onDidReceiveMessage: cb => { onMessage = cb; return { dispose() {} }; },
    postMessage: async msg => {
        posted.push(msg);
        for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].pred(msg)) {
                const w = waiters.splice(i, 1)[0];
                w.resolve(msg);
            }
        }
        return true;
    }
};
const view = {
    webview,
    visible: true,
    show: () => {},
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} })
};
function waitFor(pred, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), SETTLE_TIMEOUT_MS);
        waiters.push({ pred, resolve: msg => { clearTimeout(timer); resolve(msg); } });
    });
}
const send = msg => onMessage(msg);

const service = new GitService(makeMemento({ 'idea-git.gitAvailable': true }));
service.selectRepository(repoPath);
const provider = new GraphViewProvider(service, vscodeStub.Uri.file(repoPath), makeMemento());

console.log(`\nRepository: ${repoPath}`);
const firstPaint = waitFor(m => m.command === 'setData' || m.command === 'setCommits', 'first paint');
await provider.resolveWebviewView(view);
send({ command: 'ready' });
// The first paint is not what this probe measures; let it finish so its spawns
// (and the divergence arrows behind it) are out of the search window.
await firstPaint;
await new Promise(resolve => setTimeout(resolve, 300));

// --------------------------------------------------------- 1. a cold search

const term = process.env.IDEA_GIT_PROBE_TERM || 'fix';
recording = true;
const from = runs.length;
const searchStart = process.hrtime.bigint();
const searchAnswer = waitFor(m => m.command === 'setCommits' && m.searchContext, `search results for "${term}"`);
send({ command: 'setFilters', text: term });
const answer = await searchAnswer;
const searchMs = Number(process.hrtime.bigint() - searchStart) / 1e6;
const searchRuns = runs.slice(from);
recording = false;

console.log(`\n1. Search "${term}" (outside the graph cache)`);
for (const run of searchRuns) {console.log(`      ${run.ms.toFixed(1).padStart(6)}ms  git ${run.args.slice(0, 96)}`);}
console.log(`      ${searchMs.toFixed(1)}ms round trip, ${answer.commits.length} rows`);
check('spawns per search', searchRuns.length <= MAX_SEARCH_SPAWNS, `${searchRuns.length} (limit ${MAX_SEARCH_SPAWNS})`);
// The runner prepends its own `-c` flags, so the subcommand is a token, not a prefix.
const isLog = run => run.args.split(' ').includes('log');
const logRun = searchRuns.find(isLog);
check('the search is one git log', !!logRun && searchRuns.length === 1, logRun ? 'yes' : 'no log spawn found');
check('filtered argv drops --topo-order', !!logRun && !logRun.args.includes('--topo-order'), logRun ? logRun.args.slice(0, 60) : '-');
check('filtered argv carries the grep', !!logRun && logRun.args.includes(`--grep=${term}`), '');

// -------------------------------------------------------- 2. the same again

recording = true;
const warmFrom = runs.length;
const warmStart = process.hrtime.bigint();
const warmAnswer = waitFor(m => m.command === 'setCommits' && m.searchContext, 'repeat search results');
send({ command: 'setFilters', text: term });
await warmAnswer;
const warmMs = Number(process.hrtime.bigint() - warmStart) / 1e6;
const warmSpawns = runs.length - warmFrom;
recording = false;

console.log('\n2. The same search again (graph cache)');
console.log(`      ${warmMs.toFixed(1)}ms round trip, ${warmSpawns} git spawn(s)`);
check('spawns per cached search', warmSpawns === 0, `${warmSpawns}`);

// --------------------------------------------- 3. clearing back to the graph

recording = true;
const clearFrom = runs.length;
const clearAnswer = waitFor(m => m.command === 'setCommits' && !m.searchContext, 'unfiltered first page');
send({ command: 'setFilters', text: '' });
await clearAnswer;
const clearRuns = runs.slice(clearFrom);
recording = false;

console.log('\n3. Clearing the filter (unfiltered first page keeps the graph order)');
for (const run of clearRuns) {console.log(`      ${run.ms.toFixed(1).padStart(6)}ms  git ${run.args.slice(0, 96)}`);}
check('clearing spawns at most one log', clearRuns.length <= MAX_SEARCH_SPAWNS, `${clearRuns.length}`);
// The clear usually replays the cached first page, so the order rule is checked
// on a forced walk of the same scope the panel would use.
recording = true;
const orderFrom = runs.length;
await service.getCommitGraphData({ limit: 20, filters: {}, force: true });
const orderRuns = runs.slice(orderFrom);
recording = false;
const clearLog = orderRuns.find(isLog);
check('unfiltered argv keeps --topo-order', !!clearLog && clearLog.args.includes('--topo-order'), clearLog ? clearLog.args.slice(0, 80) : 'no log spawn');

console.log('\nSummary');
console.log(`      cold search ${searchMs.toFixed(1)}ms / ${searchRuns.length} spawn(s), warm ${warmMs.toFixed(1)}ms / ${warmSpawns}`);
if (failures.length > 0) {
    console.error(`\nSearch thresholds broken: ${failures.join(', ')}`);
    process.exit(1);
}
console.log('\nSearch thresholds hold.');
process.exit(0);