/* eslint-disable */
/**
 * Stand-in for the extension host: implements the one API media/webview.js
 * needs (acquireVsCodeApi) and answers its messages with mock payloads.
 * Everything on screen is produced by the real webview code.
 */
(function () {
    var sendQueue = [];
    var ready = false;

    function send(msg) {
        if (!ready) { sendQueue.push(msg); return; }
        window.dispatchEvent(new MessageEvent('message', { data: msg }));
    }

    var P = window.__PREVIEW__;
    var s = P.scene();

    window.acquireVsCodeApi = function () {
        return {
            postMessage: function (msg) {
                window.__OUTBOX = window.__OUTBOX || [];
                window.__OUTBOX.push(msg);
                if (msg.command === 'ready') {
                    ready = true;
                    send({ command: 'setRepoState', state: 'ready', repositories: s.repositories, currentRepository: s.currentRepository });
                    send({ command: 'setDivergence', divergence: P.divergence });
                    send({ command: 'setStashes', stashes: P.stashes });
                    send({ command: 'setWorktrees', worktrees: P.worktrees || [] });
                    if (s.select) send({ command: 'revealCommit', hash: s.select });
                    runSteps(s.steps);
                    flush();
                } else if (msg.command === 'selectCommit') {
                    var d = P.details[msg.hash];
                    if (d) send({ command: 'setDetail', commit: d.commit, files: d.files });
                } else if (msg.command === 'selectCommits') {
                    // The panel asks for the selection with this one message, whether
                    // it holds one commit or five, so the stub answers both shapes.
                    var hashes = msg.hashes || [];
                    if (hashes.length === 1) {
                        var one = P.details[hashes[0]];
                        if (one) send({ command: 'setDetail', commit: one.commit, files: one.files });
                    } else {
                        send({
                            command: 'multiCommitsResponse',
                            commits: hashes.map(function (h) { return P.details[h] && P.details[h].commit; }).filter(Boolean),
                            files: P.multiFiles || []
                        });
                    }
                } else if (msg.command === 'selectStash') {
                    send({ command: 'setStashDetail', index: msg.index, files: P.stashFiles[msg.index] || [] });
                } else if (msg.command === 'saveViewState') {
                    /* persistence lives in the host; nothing to do in a preview */
                } else if (msg.command === 'filePreview') {
                    // The host answers with already-classified patch rows, so the
                    // stub hands over the same shape rather than a raw patch.
                    var pv = P.previews[msg.path] || P.previews.default;
                    send(Object.assign({ command: 'filePreviewResponse', hash: msg.hash, stash: msg.stash, path: msg.path }, pv));
                } else if (msg.command === 'getPushAllFiles') {
                    send({ command: 'pushFilesResponse', hash: '__all__', files: P.pushFiles['__all__'] });
                } else if (msg.command === 'getCommitFilesForPush') {
                    send({ command: 'pushFilesResponse', hash: msg.hash, files: P.pushFiles[msg.hash] || [] });
                }
            },
            getState: function () { return undefined; },
            setState: function () { }
        };
    };

    function flush() {
        var q = sendQueue.splice(0);
        q.forEach(send);
    }

    /** Scenes drive real UI state (selection, menus, dialogs) through real events
     *  instead of poking internals, so a captured frame is one a user can reach. */
    function runSteps(steps) {
        (steps || []).forEach(function (step, i) {
            setTimeout(function () {
                if (step.msg) { send(step.msg); return; }
                if (step.do === 'click') fire('click', step.sel, { ctrlKey: !!step.ctrl });
                if (step.do === 'menu') fire('contextmenu', step.sel, {});
            }, 80 * (i + 1));
        });
    }

    function fire(type, sel, opts) {
        var el = document.querySelector(sel);
        if (!el) { console.warn('[preview] missing element: ' + sel); return; }
        var r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent(type, Object.assign({
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: r.left + 24,
            clientY: r.top + r.height / 2
        }, opts)));
    }
})();
