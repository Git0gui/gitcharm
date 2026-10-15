/* eslint-disable */
/**
 * Mock repository data for the standalone webview preview.
 * Hashes, messages, timestamps and branch tips are this repository's REAL
 * history (captured 2026-10-15); only the working set is trimmed to one screen.
 * Scene is chosen with ?scene=<name> (default: main).
 */
(function () {
    var A = '归 刘';
    var E = '1960698795@qq.com';

    function c(hash, message, date, parents, refs, tags, isMerge) {
        return {
            hash: hash,
            shortHash: hash.slice(0, 7),
            message: message,
            author: A,
            date: date,
            parents: parents || [],
            refs: refs || [],
            tags: tags || [],
            isMerge: !!isMerge
        };
    }

    var commits = [
        c('153fcf858610d56a4daf93ef269427a52809913e', '发布准备：版本号升到 0.0.7，系统代理那条从 0.0.6 拆出来单独成段', '2026-10-15T22:55:45+08:00', ['bd864ce52328c724b8506009414e9b70bf436ff4'], ['HEAD', 'main', 'origin/main']),
        c('bd864ce52328c724b8506009414e9b70bf436ff4', '修复：连不上远端时把系统代理的具体地址说出口，不再让用户猜端口', '2026-10-15T22:07:31+08:00', ['cff8bedb854e73b3edc6db0b1fab04a16da9af97'], ['feat/system-proxy-hint']),
        c('cff8bedb854e73b3edc6db0b1fab04a16da9af97', '合入 0.0.6：IDEA 对标功能批次（时间范围拖动圈选、Reflog 误操作急救、失败提示友好化、多选提交对比修正等）', '2026-10-14T00:49:49+08:00', ['84e33e1', 'b31aa7ddfd162a5a839df6d82f746274406c2568'], ['feat/idea-parity-followup'], [], true),
        c('b31aa7ddfd162a5a839df6d82f746274406c2568', '发布准备：版本号升到 0.0.6，CHANGELOG 把本批条目拆成对应版本段', '2026-10-14T00:49:38+08:00', ['091e77ed2a299884c744ed094c735b7e71702521'], ['feat/idea-parity-batch']),
        c('091e77ed2a299884c744ed094c735b7e71702521', '新增：时间筛选换成自绘月历，可以按住拖动圈选一段时间', '2026-10-14T00:44:15+08:00', ['d26ad6f27eb2904788a0fbf9ece78047cdf65cb9']),
        c('d26ad6f27eb2904788a0fbf9ece78047cdf65cb9', '改动：Reflog 右键菜单整套换成误操作急救的动作', '2026-10-14T00:06:25+08:00', ['a985c5a9ea76f5de3bfa37df8f1eb200eb427281']),
        c('a985c5a9ea76f5de3bfa37df8f1eb200eb427281', '修复：对话框里的提交行撑破宽度，动作/时间两列跑到框外', '2026-10-13T23:24:02+08:00', ['fd5b4209cd1061100e0ff581121ffc5b71b34355']),
        c('fd5b4209cd1061100e0ff581121ffc5b71b34355', '新增：一步的改动变空时，弹"跳过／保留空提交／终止"三选一', '2026-10-13T23:18:45+08:00', ['fbfe9120dc23dc6551c86c2dba77232dd79d8dbc']),
        c('fbfe9120dc23dc6551c86c2dba77232dd79d8dbc', '修复：差异框的失败提示仍把 Error: 前缀甩给用户', '2026-10-13T23:18:44+08:00', ['a28201bcf0a32e84fa7b5e6b55c7ad7300c229f0']),
        c('a28201bcf0a32e84fa7b5e6b55c7ad7300c229f0', '补交：上一条漏掉的三个提示文案（err.tlsHint / unreachableNoProxy / unreachableWithProxy）', '2026-10-13T22:50:47+08:00', ['75efa3ce7047ea528e8b383a1293591d3ff07bf0']),
        c('75efa3ce7047ea528e8b383a1293591d3ff07bf0', '改动：git 失败提示去掉 Error:/fatal: 包装，连不上的时候说清代理', '2026-10-13T22:50:33+08:00', ['032e7112bc9a7fb97c1b52a475a80f57a593f6aa']),
        c('032e7112bc9a7fb97c1b52a475a80f57a593f6aa', '修复：一组提交的早晚不能按作者时间判', '2026-10-13T22:07:26+08:00', ['83a1ce69448922cff269da9a24fbd505e3121e0f']),
        c('83a1ce69448922cff269da9a24fbd505e3121e0f', '文档：记下多选提交文件对比的最终语义（保留净对比，净差异为空不是 bug）', '2026-10-13T21:50:27+08:00', ['3d771d4f892a4c659d896496450e1cfca53c5a9f']),
        c('3d771d4f892a4c659d896496450e1cfca53c5a9f', '改动：多选提交双击文件改为跨整组的双栏对比，撤掉补丁文本方案', '2026-10-13T21:43:09+08:00', ['6b098bf7c6da0800ceb6f983c73d37c921813742']),
        c('6b098bf7c6da0800ceb6f983c73d37c921813742', '新增：多选提交里双击文件，逐提交补丁拼成一份只读文档', '2026-10-13T21:30:33+08:00', ['9ddc097']),
        c('84e33e1', '合入：test/conflict-auto-clear 外部解决冲突后状态栏自动收起 + 提交列表跟随外部历史（0.0.5）', '2026-10-11T16:14:31+08:00', ['4d94deb'], ['test/conflict-auto-clear'], [], true)
    ];

    var local = [
        'main',
        'feat/system-proxy-hint',
        'feat/idea-parity-batch',
        'feat/idea-parity-followup',
        'test/conflict-auto-clear',
        'test/no-vscode-git',
        'docs/rewrite-readme',
        'v0.0.3/optimizations',
        'v0.0.4/optimizations'
    ];
    var remote = [
        'origin/main',
        'origin/docs/rewrite-readme',
        'origin/test/no-vscode-git',
        'origin/v0.0.3/optimizations',
        'origin/v0.0.4/optimizations'
    ];

    // Real tip for test/no-vscode-git differs from its remote twin (f6ae10c vs 8d6771f).
    var divergence = {
        'feat/system-proxy-hint': { ahead: 1, behind: 0 },
        'test/no-vscode-git': { ahead: 3, behind: 2, upstream: 'origin/test/no-vscode-git' },
        'v0.0.3/optimizations': { ahead: 0, behind: 1, upstream: 'origin/v0.0.3/optimizations' }
    };

    var stashes = [
        { index: 0, message: 'On main: 预览工程先记一笔，回头补 scene 截图', date: '2026-10-15T21:12:06+08:00' },
        { index: 1, message: 'WIP on feat/system-proxy-hint: bd864ce 修复：连不上远端时把系统代理的具体地址说出口', date: '2026-10-15T19:40:22+08:00' }
    ];

    // Real `git show --numstat bd864ce`.
    var filesOfBd864ce = [
        { status: 'M', path: 'AGENTS.md', added: 1, deleted: 1 },
        { status: 'M', path: 'CHANGELOG.md', added: 1, deleted: 0 },
        { status: 'M', path: 'src/i18n/index.ts', added: 2, deleted: 0 },
        { status: 'M', path: 'src/services/gitService.ts', added: 14, deleted: 6 },
        { status: 'M', path: 'src/services/gitUtils.ts', added: 57, deleted: 0 },
        { status: 'A', path: 'src/services/systemProxy.ts', added: 36, deleted: 0 },
        { status: 'M', path: 'src/test/gitParsing.test.ts', added: 98, deleted: 1 }
    ];

    function det(hash, shortHash, message, date, files) {
        return {
            commit: {
                hash: hash,
                shortHash: shortHash,
                message: message,
                author: A,
                authorEmail: E,
                authorDate: date,
                committer: A,
                committerEmail: E,
                committerDate: date
            },
            files: files
        };
    }

    var details = {};
    details['bd864ce52328c724b8506009414e9b70bf436ff4'] = det(
        'bd864ce52328c724b8506009414e9b70bf436ff4', 'bd864ce',
        '修复：连不上远端时把系统代理的具体地址说出口，不再让用户猜端口\n\n0.0.6 那条提示让用户自己填代理端口，而答案就写在他机器的注册表里。现在 git 没配 http.proxy 时再读一次系统代理，把具体地址写进提示，那一行复制下来就能执行。',
        '2026-10-15T22:07:31+08:00', filesOfBd864ce
    );
    details['091e77ed2a299884c744ed094c735b7e71702521'] = det(
        '091e77ed2a299884c744ed094c735b7e71702521', '091e77e',
        '新增：时间筛选换成自绘月历，可以按住拖动圈选一段时间',
        '2026-10-14T00:44:15+08:00',
        [
            { status: 'M', path: 'media/webview.js', added: 214, deleted: 38 },
            { status: 'M', path: 'media/webview.css', added: 96, deleted: 4 },
            { status: 'M', path: 'src/views/messages.ts', added: 3, deleted: 1 },
            { status: 'M', path: 'src/i18n/index.ts', added: 10, deleted: 2 }
        ]
    );
    details['d26ad6f27eb2904788a0fbf9ece78047cdf65cb9'] = det(
        'd26ad6f27eb2904788a0fbf9ece78047cdf65cb9', 'd26ad6f',
        '改动：Reflog 右键菜单整套换成误操作急救的动作',
        '2026-10-14T00:06:25+08:00',
        [
            { status: 'M', path: 'media/webview.js', added: 41, deleted: 12 },
            { status: 'M', path: 'src/i18n/index.ts', added: 12, deleted: 0 }
        ]
    );
    details['a985c5a9ea76f5de3bfa37df8f1eb200eb427281'] = det(
        'a985c5a9ea76f5de3bfa37df8f1eb200eb427281', 'a985c5a',
        '修复：对话框里的提交行撑破宽度，动作/时间两列跑到框外',
        '2026-10-13T23:24:02+08:00',
        [
            { status: 'M', path: 'media/webview.css', added: 2, deleted: 0 }
        ]
    );

    var base = {
        commits: commits,
        local: local,
        remote: remote,
        currentBranch: 'main',
        selectedBranch: 'main',
        repoName: 'GitCharm',
        hasMore: true,
        headHash: '153fcf858610d56a4daf93ef269427a52809913e',
        select: 'bd864ce52328c724b8506009414e9b70bf436ff4'
    };

    var scenes = {
        main: base,
        /** Operation status bar above the branch tree (rebase in progress). */
        conflict: Object.assign({}, base, { inProgress: 'rebase' }),
        /** Multi-repository workspace: the switcher only appears with >1 root. */
        multiRepo: Object.assign({}, base, {
            repositories: [
                { path: 'D:/gitProject/GitCharm', name: 'GitCharm' },
                { path: 'D:/gitProject/basepyright', name: 'basepyright' },
                { path: 'D:/gitProject/site-builder', name: 'site-builder' }
            ],
            currentRepository: 'D:/gitProject/GitCharm'
        }),
        /** Commit row context menu, single selection. */
        commitMenu: Object.assign({}, base, {
            select: '091e77ed2a299884c744ed094c735b7e71702521',
            steps: [{ do: 'menu', sel: row('091e77ed2a299884c744ed094c735b7e71702521') }]
        }),
        /** Commit row context menu, three rows ctrl-clicked first. */
        commitMenuMulti: Object.assign({}, base, {
            steps: [
                { do: 'click', sel: row('091e77ed2a299884c744ed094c735b7e71702521') },
                { do: 'click', sel: row('d26ad6f27eb2904788a0fbf9ece78047cdf65cb9'), ctrl: true },
                { do: 'click', sel: row('a985c5a9ea76f5de3bfa37df8f1eb200eb427281'), ctrl: true },
                {
                    msg: {
                        command: 'multiCommitsResponse',
                        commits: [
                            details['091e77ed2a299884c744ed094c735b7e71702521'].commit,
                            details['d26ad6f27eb2904788a0fbf9ece78047cdf65cb9'].commit,
                            details['a985c5a9ea76f5de3bfa37df8f1eb200eb427281'].commit
                        ],
                        files: [
                            { status: 'M', path: 'media/webview.js', added: 255, deleted: 50 },
                            { status: 'M', path: 'media/webview.css', added: 98, deleted: 4 },
                            { status: 'M', path: 'src/i18n/index.ts', added: 22, deleted: 2 },
                            { status: 'M', path: 'src/views/messages.ts', added: 3, deleted: 1 }
                        ]
                    }
                },
                { do: 'menu', sel: row('a985c5a9ea76f5de3bfa37df8f1eb200eb427281') }
            ]
        }),
        /** Local branch context menu (7 items): expand feat/, then right-click it. */
        branchMenu: Object.assign({}, base, {
            steps: [
                { do: 'click', sel: '.bfolder[data-folder="feat"]' },
                { do: 'menu', sel: '.bitem[data-branch="feat/system-proxy-hint"]' }
            ]
        }),
        /** Push dialog: outgoing commits on top, their files below. */
        pushDialog: Object.assign({}, base, {
            steps: [
                {
                    msg: {
                        command: 'showPushDialog',
                        branchName: 'feat/system-proxy-hint',
                        remoteExists: true,
                        isFirstPush: false,
                        commits: [
                            { hash: 'bd864ce52328c724b8506009414e9b70bf436ff4', shortHash: 'bd864ce', message: '修复：连不上远端时把系统代理的具体地址说出口，不再让用户猜端口', author: A, date: '2026-10-15 22:07:31 +0800' },
                            { hash: 'cff8bedb854e73b3edc6db0b1fab04a16da9af97', shortHash: 'cff8bed', message: '合入 0.0.6：IDEA 对标功能批次（时间范围拖动圈选、Reflog 误操作急救、失败提示友好化、多选提交对比修正等）', author: A, date: '2026-10-14 00:49:49 +0800' }
                        ]
                    }
                }
            ]
        }),
        /** Reflog dialog — the mist操作 rescue view. */
        reflog: Object.assign({}, base, {
            steps: [{
                msg: {
                    command: 'showReflog',
                    scope: 'HEAD（含切换分支的记录）',
                    entries: [
                        { ref: 'HEAD@{0}', hash: '153fcf858610d56a4daf93ef269427a52809913e', shortHash: '153fcf8', action: 'commit', message: '发布准备：版本号升到 0.0.7，系统代理那条从 0.0.6 拆出来单独成段', date: '2026-10-15T22:55:45+08:00' },
                        { ref: 'HEAD@{1}', hash: 'bd864ce52328c724b8506009414e9b70bf436ff4', shortHash: 'bd864ce', action: 'checkout', message: 'moving from main to feat/system-proxy-hint', date: '2026-10-15T22:10:02+08:00' },
                        { ref: 'HEAD@{2}', hash: 'cff8bedb854e73b3edc6db0b1fab04a16da9af97', shortHash: 'cff8bed', action: 'reset', message: 'moving to HEAD~1（误操作，从这里可以捞回来）', date: '2026-10-15T21:58:40+08:00' },
                        { ref: 'HEAD@{3}', hash: 'b31aa7ddfd162a5a839df6d82f746274406c2568', shortHash: 'b31aa7d', action: 'merge', message: 'refs/heads/feat/idea-parity-batch: Merge made by the ort strategy', date: '2026-10-14T00:49:49+08:00' },
                        { ref: 'HEAD@{4}', hash: '091e77ed2a299884c744ed094c735b7e71702521', shortHash: '091e77e', action: 'commit', message: '新增：时间筛选换成自绘月历，可以按住拖动圈选一段时间', date: '2026-10-14T00:44:15+08:00' }
                    ]
                }
            }]
        })
    };

    function row(hash) { return '.row[data-hash="' + hash + '"]'; }

    function scene() {
        var m = /[?&]scene=([\w-]+)/.exec(location.search);
        return (m && scenes[m[1]]) || base;
    }

    // Push dialog file lists, keyed by commit hash; '__all__' is the aggregate
    // row the host answers with for getPushAllFiles.
    var pushFiles = {
        '__all__': filesOfBd864ce.map(function (f) { return { path: f.path, status: f.status }; }).concat([
            { path: 'media/webview.js', status: 'M' },
            { path: 'media/webview.css', status: 'M' },
            { path: 'src/views/graphView.ts', status: 'M' },
            { path: 'src/views/messages.ts', status: 'M' },
            { path: 'src/test/noVscodeGit.test.ts', status: 'A' }
        ]),
        'bd864ce52328c724b8506009414e9b70bf436ff4': filesOfBd864ce.map(function (f) { return { path: f.path, status: f.status }; }),
        'cff8bedb854e73b3edc6db0b1fab04a16da9af97': [
            { path: 'media/webview.js', status: 'M' },
            { path: 'media/webview.css', status: 'M' },
            { path: 'src/views/graphView.ts', status: 'M' },
            { path: 'src/views/messages.ts', status: 'M' },
            { path: 'src/services/gitUtils.ts', status: 'M' }
        ]
    };

    window.__PREVIEW__ = {
        initial: function () {
            var s = scene();
            return {
                commits: s.commits,
                local: s.local,
                remote: s.remote,
                currentBranch: s.currentBranch,
                selectedBranch: s.selectedBranch,
                repoName: s.repoName,
                hasMore: s.hasMore,
                headHash: s.headHash,
                inProgress: s.inProgress
            };
        },
        scene: scene,
        divergence: divergence,
        stashes: stashes,
        details: details,
        pushFiles: pushFiles
    };
})();
