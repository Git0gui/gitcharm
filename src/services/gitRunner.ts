import { spawn } from 'child_process';

/**
 * Central git process runner. Single execution path for every git invocation:
 * always spawn() with an argv array (never a shell), fixed C locale so error
 * output is parseable, optional locks disabled so read commands never block
 * the user's own git operations, and a concurrency cap so refresh storms
 * cannot flood the machine with processes.
 */

export interface GitRunOptions {
    cwd: string;
    /** Milliseconds before the process is killed. 0 disables. Default 120s. */
    timeoutMs?: number;
    /** Extra environment variables (merged over the fixed base env). */
    env?: Record<string, string>;
    /** Data written to stdin. */
    input?: string;
    /** Max stdout bytes before the process is killed. Default 64MB. */
    maxBuffer?: number;
    /** Abort only read-only queries when the user cancels their progress notification. */
    signal?: AbortSignal;
}

export interface GitError extends Error {
    code: number | null;
    stderr: string;
    stdout: string;
    gitArgs: string[];
    timedOut?: boolean;
    cancelled?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_CONCURRENT = 6;

/** Fixed environment: stable English messages, no prompts, no pager, no locks. */
const BASE_ENV: Record<string, string> = {
    LC_ALL: 'C',
    LANG: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    EDITOR: 'true'
};

/**
 * Fixed leading git flags: quoted paths stay readable, queries never trigger
 * gc, and history walks never verify commit signatures. A user-level
 * `log.showSignature=true` makes `git log`/`git show` GPG-verify every commit,
 * which can turn a millisecond query into a multi-second one; the graph never
 * renders signatures, so the setting has no value here.
 */
const BASE_ARGS = [
    '-c', 'core.quotePath=false',
    '-c', 'gc.auto=0',
    '-c', 'log.showSignature=false'
];

let _active = 0;
interface Waiter {
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
    args: string[];
}
const _waiters: Waiter[] = [];

export class GitCommandCancelledError extends Error {
    readonly cancelled = true;

    constructor(args: string[]) {
        super(`git ${args[0]} was cancelled`);
        this.name = 'GitCommandCancelledError';
    }
}

export function isGitCommandCancelled(error: unknown): boolean {
    return error instanceof GitCommandCancelledError
        || (!!error && typeof error === 'object' && 'cancelled' in error && error.cancelled === true);
}

export function isCancellableGitQuery(args: readonly string[]): boolean {
    const command = args[0];
    if (['log', 'rev-list', 'diff-tree', 'show', 'for-each-ref', 'symbolic-ref',
        'merge-base', 'cat-file', 'ls-files', 'diff', 'rev-parse', 'status'].includes(command)) {
        return true;
    }
    if (command === 'remote') {return args[1] === '-v';}
    if (command === 'worktree') {return args[1] === 'list';}
    if (command === 'config') {return args[1] === '--get' || args[1] === '--get-all';}
    if (command === 'branch') {return args.includes('--contains') || args.includes('--list');}
    return false;
}

async function _acquire(signal: AbortSignal | undefined, args: string[]): Promise<void> {
    if (signal?.aborted) {throw new GitCommandCancelledError(args);}
    if (_active < MAX_CONCURRENT) {
        _active++;
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject, signal, args };
        if (signal) {
            waiter.onAbort = () => {
                const index = _waiters.indexOf(waiter);
                if (index >= 0) {_waiters.splice(index, 1);}
                reject(new GitCommandCancelledError(args));
            };
            signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
        _waiters.push(waiter);
    });
}

function _release(): void {
    while (_waiters.length > 0) {
        const next = _waiters.shift()!;
        if (next.signal?.aborted) {
            if (next.signal && next.onAbort) {next.signal.removeEventListener('abort', next.onAbort);}
            next.reject(new GitCommandCancelledError(next.args));
            continue;
        }
        if (next.signal && next.onAbort) {next.signal.removeEventListener('abort', next.onAbort);}
        next.resolve();
        return;
    }
    _active--;
}

/**
 * Split a command line into argv tokens, honoring double/single quotes.
 * Retained for legacy string-based call sites; new code should pass argv
 * arrays directly to runGit().
 */
export function tokenizeCommand(cmd: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: string | null = null;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === ' ') {
            if (current) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += ch;
        }
    }
    if (current) {tokens.push(current);}
    return tokens;
}

/** Pure construction of the spawn spec, exported for tests. */
export function buildSpawnSpec(args: string[], opts: GitRunOptions): {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
} {
    return {
        command: 'git',
        args: [...BASE_ARGS, ...args],
        env: { ...process.env, ...BASE_ENV, ...opts.env }
    };
}

/**
 * Run git with the given argv and resolve with raw stdout (untrimmed).
 * Rejects with a GitError carrying stderr/stdout/exit code on failure.
 */
export async function runGit(args: string[], opts: GitRunOptions): Promise<string> {
    await _acquire(opts.signal, args);
    try {
        return await _spawnGit(args, opts);
    } finally {
        _release();
    }
}

function _spawnGit(args: string[], opts: GitRunOptions): Promise<string> {
    return new Promise((resolve, reject) => {
        const spec = buildSpawnSpec(args, opts);
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
        const signal = opts.signal;
        if (signal?.aborted) {reject(new GitCommandCancelledError(args)); return;}

        const child = spawn(spec.command, spec.args, {
            cwd: opts.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: spec.env
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let killed = false;
        let killReason: 'timeout' | 'maxBuffer' | 'cancelled' | null = null;
        let timer: NodeJS.Timeout | null = null;
        const onAbort = signal ? () => {
            if (killReason) {return;}
            killed = true;
            killReason = 'cancelled';
            child.kill();
        } : undefined;
        const cleanup = () => {
            if (timer) {clearTimeout(timer);}
            if (signal && onAbort) {signal.removeEventListener('abort', onAbort);}
        };
        if (signal && onAbort) {signal.addEventListener('abort', onAbort, { once: true });}

        timer = timeoutMs > 0
            ? setTimeout(() => {
                killed = true;
                killReason = 'timeout';
                child.kill();
            }, timeoutMs)
            : null;

        child.stdout.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxBuffer) {
                killed = true;
                killReason = 'maxBuffer';
                child.kill();
                return;
            }
            stdoutChunks.push(chunk);
        });

        child.stderr.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk);
        });

        if (opts.input !== undefined) {
            child.stdin.write(opts.input);
        }
        child.stdin.end();

        child.on('close', (code) => {
            cleanup();
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8');
            if (code === 0 && !killed) {
                resolve(stdout);
                return;
            }
            const message = killed
                ? (killReason === 'timeout'
                    ? `git ${args[0]} timed out after ${timeoutMs}ms`
                    : killReason === 'cancelled'
                        ? `git ${args[0]} was cancelled`
                        : `git ${args[0]} exceeded max output buffer (${maxBuffer} bytes)`)
                : (stderr.trim() || `git ${args[0]} exited with code ${code}`);
            const err = new Error(message) as GitError;
            err.code = code;
            err.stderr = stderr;
            err.stdout = stdout;
            err.gitArgs = args;
            err.timedOut = killReason === 'timeout';
            err.cancelled = killReason === 'cancelled';
            if (err.cancelled) {err.name = 'GitCommandCancelledError';}
            reject(err);
        });

        child.on('error', (e) => {
            cleanup();
            reject(e);
        });
    });
}

/** Split NUL-terminated command output into entries (drops trailing empty). */
export function splitNul(output: string): string[] {
    if (!output) {return [];}
    const parts = output.split('\0');
    if (parts.length && parts[parts.length - 1] === '') {parts.pop();}
    return parts;
}
