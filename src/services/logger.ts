/**
 * Centralized logger. Debug output is silent unless enabled via the
 * "idea-git.debug" setting or the IDEA_GIT_DEBUG=1 env var (tests/CLI).
 * Deliberately free of the vscode import so pure services and unit tests
 * can use it too.
 */
class Logger {
    private _debugEnabled = typeof process !== 'undefined' && process.env?.IDEA_GIT_DEBUG === '1';

    setDebug(on: boolean): void {
        this._debugEnabled = on;
    }

    debug(...args: unknown[]): void {
        if (this._debugEnabled) {console.log(...args);}
    }

    info(...args: unknown[]): void {
        console.log(...args);
    }

    warn(...args: unknown[]): void {
        console.warn(...args);
    }

    error(...args: unknown[]): void {
        console.error(...args);
    }
}

export const logger = new Logger();
