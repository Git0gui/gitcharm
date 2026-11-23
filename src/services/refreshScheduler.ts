/*
 * One channel, one refresh at a time.
 *
 * The panel has several independent triggers for the same answer: the action
 * handler reloads at the end of every mutation, the .git watcher notices the
 * same ref change a few hundred ms later, the 2s poll checks the tip, and the
 * visibility event may replay the screen. A generation ticket only discards a
 * *late result* — by then the duplicate `git log` / `for-each-ref` has already
 * been spawned. This module collapses the requests themselves.
 *
 * Rules, in order:
 *  - a call with the same key as the running one shares that run (no second
 *    spawn, no second post);
 *  - a call with a different key supersedes it: the generation moves on so the
 *    older result is dropped, and only the newest request is queued for one
 *    follow-up run after the current one settles;
 *  - for a short window after a run, the same key is answered by the screen
 *    that was just painted (this is what absorbs a watcher event 250-300ms
 *    after the action's own reload);
 *  - `isLatest` is the companion guard for callers that post from inside the
 *    run: only the newest generation may paint.
 *
 * Pure module: no vscode import, so node:test can load it directly.
 */

/** The host-side filter state; structurally compatible with LogFilters. */
export interface FilterState {
    text?: string;
    regex?: boolean;
    caseSensitive?: boolean;
    author?: string;
    from?: string;
    to?: string;
    path?: string;
}

/** U+001F cannot appear in a ref name, so joined fields cannot collide. */
const SEP = '\u001f';

export function filterSignature(f: FilterState | undefined): string {
    return [
        f?.text ?? '', f?.regex ? 'R' : '-', f?.caseSensitive ? 'C' : '-',
        f?.author ?? '', f?.from ?? '', f?.to ?? '', f?.path ?? ''
    ].join(SEP);
}

/** True when applying this filter again would ask for exactly the same rows. */
export function sameFilters(a: FilterState | undefined, b: FilterState | undefined): boolean {
    return filterSignature(a) === filterSignature(b);
}

export interface RefreshClaim<A> {
    generation: number;
    args: A;
}

export class RefreshScheduler<A> {
    private _running: { key: string; generation: number; args: A } | undefined;
    private _queued: { key: string; args: A } | undefined;
    private _generation = 0;
    private _lastKey: string | undefined;
    private _lastFinishedAt = 0;
    private readonly _reuseMs: number;
    private readonly _mergeQueued: ((prev: A, next: A) => A) | undefined;
    private readonly _needsOwnRun: ((running: A, next: A) => boolean) | undefined;

    /**
     * @param reuseMs how long a finished run keeps answering the same key.
     * @param mergeQueued how a superseding call combines with the call already
     * waiting. Default is "newest wins". A strength flag wants the opposite:
     * `force || force`, so a cached request arriving later cannot downgrade the
     * forced refresh that is still queued.
     * @param needsOwnRun a same-key call normally shares the running query.
     * Return true when it must get its own follow-up run instead: a caller
     * asking for fresh data cannot be answered by the cached query in flight.
     */
    constructor(reuseMs = 0, mergeQueued?: (prev: A, next: A) => A,
        needsOwnRun?: (running: A, next: A) => boolean) {
        this._reuseMs = reuseMs;
        this._mergeQueued = mergeQueued;
        this._needsOwnRun = needsOwnRun;
    }

    get busy(): boolean { return this._running !== undefined; }
    get generation(): number { return this._generation; }

    /**
     * Claim the channel. `undefined` means this call was folded into another
     * run: the caller must neither spawn nor post. Otherwise it owns the
     * channel until `end()`.
     */
    begin(key: string, args: A): RefreshClaim<A> | undefined {
        if (this._running) {
            if (this._running.key === key && !this._needsOwnRun?.(this._running.args, args)) {
                return undefined;
            }
            // A different scope — or a stronger request for the same scope —
            // wins. Its result is the one the panel needs, so the in-flight
            // answer must become stale and one follow-up is kept.
            this._generation++;
            this._queued = {
                key,
                args: this._queued && this._mergeQueued
                    ? this._mergeQueued(this._queued.args, args)
                    : args
            };
            return undefined;
        }
        if (this._reuseMs > 0 && this._lastKey === key
            && Date.now() - this._lastFinishedAt < this._reuseMs) {
            return undefined;
        }
        this._generation++;
        this._running = { key, generation: this._generation, args };
        return { generation: this._generation, args };
    }

    /** Release the channel and return the args of a queued follow-up, if any. */
    end(): A | undefined {
        const finished = this._running;
        this._running = undefined;
        if (finished) {
            this._lastKey = finished.key;
            this._lastFinishedAt = Date.now();
        }
        const queued = this._queued;
        this._queued = undefined;
        if (queued) {
            // The follow-up is a genuinely new answer: never let the short
            // reuse window swallow it.
            this._lastKey = undefined;
        }
        return queued?.args;
    }

    /** A result may paint only while its generation is still the newest. */
    isLatest(generation: number): boolean {
        return generation === this._generation && this._running?.generation === generation;
    }

    /**
     * Forget the last finished run. An external ref change must always get a
     * real query even when it lands inside the reuse window.
     */
    invalidateReuse(): void {
        this._lastKey = undefined;
        this._lastFinishedAt = 0;
    }
}
