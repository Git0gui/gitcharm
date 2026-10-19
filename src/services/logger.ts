/**
 * Centralized logger. Debug output is silent unless enabled via the
 * "idea-git.debug" setting or the IDEA_GIT_DEBUG=1 env var (tests/CLI).
 * Deliberately free of the vscode import so pure services and unit tests
 * can use it too.
 */
import { format } from 'util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (level: LogLevel, message: string) => void;

class Logger {
    private _debugEnabled = typeof process !== 'undefined' && process.env?.IDEA_GIT_DEBUG === '1';
    private _sink?: LogSink;

    setDebug(on: boolean): void {
        this._debugEnabled = on;
    }

    /**
     * Where user-visible diagnostics go (the extension wires this to an
     * OutputChannel). Failures in the sink itself must never break logging.
     */
    setSink(sink: LogSink | undefined): void {
        this._sink = sink;
    }

    private _emit(level: LogLevel, args: unknown[]): void {
        if (!this._sink) {return;}
        try {
            this._sink(level, format(...args));
        } catch { /* ignore a broken sink */ }
    }

    debug(...args: unknown[]): void {
        if (!this._debugEnabled) {return;}
        console.log(...args);
        this._emit('debug', args);
    }

    info(...args: unknown[]): void {
        console.log(...args);
        this._emit('info', args);
    }

    warn(...args: unknown[]): void {
        console.warn(...args);
        this._emit('warn', args);
    }

    error(...args: unknown[]): void {
        console.error(...args);
        this._emit('error', args);
    }
}

export const logger = new Logger();
