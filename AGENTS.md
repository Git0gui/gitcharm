# GitCharm — 代码规范（AI 生成代码必须遵循）

在 VSCode 中复刻 IntelliJ IDEA 的 Git UI 与工作流。本文档是本项目唯一的代码规范来源，任何 AI 或人工提交的代码都必须遵守。规则均来自实际踩坑记录，违反会导致已知 bug 复现。

## 1. 构建与验证

```bash
npm run compile   # tsc -p ./
npm run lint      # eslint src --ext ts，必须 0 error
npm test          # node --test "out/test/*.test.js"（pretest 自动 compile）
npm run package   # vsce package --no-yarn --allow-missing-repository
```

- 每次改动后必须依次通过 compile、lint（0 error）、test（全绿），然后才允许提交。
- Windows 本机 PowerShell 为 Constrained Language Mode：在 PowerShell 里必须调用 `npm.cmd`（`npm.ps1` 会报 MethodInvocationNotSupported）；Git Bash 里直接用 `npm` 即可。
- 改了 `out/` 或 `media/` 后调试宿主（Extension Development Host）跑的是旧代码，必须完全重启宿主再验证，必要时 bump 版本号使缓存失效——避免"改了还是一样"的误判。
- `engines.vscode` 不得低于 `@types/vscode` 的声明下限，否则 `vsce package` 直接报 `ERROR @types/vscode ... greater than engines.vscode ...` 且无 flag 可绕过。本仓库**实测代码下限是 1.66**（唯一卡点是 `src/services/fileIcons.ts` 用的 `ColorThemeKind.HighContrastLight`，1.65 typings 编译报 1 错、1.66 起 0 错；webview 视图与 `new RelativePattern(uri, …)` 在更早的 typings 里就有，不是卡点），所以 `engines.vscode` 与 `@types/vscode` 一起定为 `1.66`。
- `@types/vscode` 必须写 `~x.y`（现在是 `~1.66.0`）不能写 `^`：`^1.85.0` 会被 npm 装成最新 1.x（实测 1.137.0），tsc 于是完全不校验版本下限，将来能静默引入不兼容 API 并发出去。想知道真实下限就把对应版本 `@types/vscode` 的 `index.d.ts` 拉下来，用 tsconfig `paths` 把 `'vscode'` 指过去跑 `tsc --noEmit` 数错误。
- 降/改版本下限要四处同步：`package.json` 的 engines、`package-lock.json` 根节点 engines、`@types/vscode`（package.json + lock）、README 的"环境要求/Requirements"中英两处。

## 2. 架构分层

```
src/
  extension.ts          激活入口：组装依赖、注册命令/视图、dispose 链
  commands/             命令层，按域拆分（branch/commit/operation），只做交互与编排
  services/             服务层：gitRunner / gitService / refsReader / persistedBranchCache / blameProvider / logger
  views/                graphView.ts（WebviewViewProvider）+ messages.ts（消息协议类型）
  test/                 node:test 单测（gitRunner/gitParsing/gitService）
media/                  webview 前端（webview.js / graph.css / codicons）
```

- 依赖方向：`commands → services ← views`，服务层不依赖命令层。
- `gitService` 已按域拆分过，新增能力优先挂到对应域模块，不要把 `gitService.ts` 再堆回巨石。

## 3. Git 命令执行（硬性规定）

- **所有 git 命令必须走 `GitCommandRunner`（src/services/gitRunner.ts）**：argv 数组 `spawn`，**无 shell**。`execAsync` 回退已删除，禁止重新引入。
- Runner 已内置：`LC_ALL=C`、并发上限 6、超时、基础参数 `-c core.quotePath=false -c gc.auto=0`。
- 调用方传 argv 数组，参数**不要带字面引号**（无 shell，引号会进入参数值——历史 bug：分支名带引号导致 divergence 解析失败）。
- 命令输出是 `Buffer`，必须显式 `toString('utf8')`，避免 StringDecoder 拼接错误。
- 查询优先用 plumbing 并带机器友好格式：`status -z`、`blame --porcelain`、`ls-files -u`、`for-each-ref --format=...`，解析 `-z` 输出按 NUL 分隔。
- 写提交消息类内容用 `-F`（文件）或 stdin，**禁止拼进命令行**（注入风险 + 编码问题）。
- **pathspec（路径过滤）一律追加在 `--` 之后**：`… -- <path>…`。有 `--` 兜底，前导 `-` 不可能被 git 当选项，所以不必再拒绝这类字符（那是仓库内真实存在的文件名）；把 pathspec 混在选项区里则等于开注入面。注意带 pathspec 的 `git log` 会做**按路径的历史简化**，未触及这些路径的 merge 提交不再出现，这是预期语义不是 bug。
- rebase/squash 等需要编辑器的操作：用 `env` + `cp` 作为 GIT_EDITOR/GIT_SEQUENCE_EDITOR，不要依赖交互式编辑器。

### 禁止依赖 vscode.git（已彻底移除）

- **不得再调用内置 git 扩展的任何 API**：`extensions.getExtension('vscode.git')`、`gitExt.activate()`、`getAPI(1)`、`repo.state` / `repo.getRefs()` / `repo.log()`，全部禁止；`package.json` 也不再有 `extensionDependencies`。回归测试 `src/test/noVscodeGit.test.ts` 会扫 `src/**` 拦住这类用法。
- **原因**：激活 vscode.git 是多 spawn 的仓库扫描（大仓库秒级），且它的 refs/HEAD 缓存滞后于真实变更；`repo.log(branch)` 忽略分支参数、`Commit.parents` 类型不稳定，踩坑成本高于收益。
- **原本从 vscode.git 拿的数据一律走本地实现**：分支名 → `RefsReader`（读 refs 文件）；upstream/ahead/behind → `_getBranchTrackInfo()`（单条 `for-each-ref`）；当前分支 → 读 `HEAD`；工作区是否干净 → `getWorkingTreeSummary()`（`status --porcelain -z`）；缓存失效 → `GitService.watchRepositoryChanges()`（`fs.watch` git 目录）。
- **不再注册自有 SCM Provider**：源代码管理面板完全交回内置 Git 扩展，GitCharm 不在那里出现（曾实现过 `src/scm/sourceControlProvider.ts`，已按用户要求整体移除，不要复活）。暂存/取消暂存/丢弃/状态条目只作为**服务层能力**保留：`GitService.add/stage/unstage/discard/getStatusEntries`（`src/services/gitService.ts`），由冲突处理等命令层调用。差异基线一律走 `idea-git-diff` 虚拟文档：索引内容用伪 ref `index` / `index:<stage>`（`_objectSpec` 翻译成 git 的 `:path` / `:1:path`）——**不要写 `0:path`**，实测 `git show 0:path` 直接 invalid object name，索引语法的前导冒号不能省。
- **凭据提示由自有 `GIT_ASKPASS` 承担**（`src/services/askpass.ts` + `media/askpass/`）：git 直接 exec 那个 sh 脚本（实测 Git for Windows 会按 shebang 执行并把 prompt 作为 argv[1]），脚本用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑 `askpass-main.js`，把 prompt POST 回扩展宿主的 **127.0.0.1 + 随机 token** 一次性服务，答案来自 `showInputBox`。新增走远端的命令（push/pull/fetch 之外的一切网络调用）必须走 `GitService._execNetwork`，否则既没有 askpass 也没有 `timeoutMs: 0`。用户取消 → 204 → git 退出 128，`_explainAuthFailure` 负责补一句"配置凭据助手/改用 SSH"，不要把 `GIT_TERMINAL_PROMPT=0` 改成 1（会把提示词丢进不可见的宿主终端）。
- git 目录一律用 `resolveGitDir()` / `resolveCommonDir()`（src/services/gitPaths.ts）定位：linked worktree 的 `.git` 是 `gitdir:` 指针文件，refs 还可能在 `commondir` 指向的公共目录，直接拼 `.git/refs` 会读空。

## 4. 缓存体系（性能的生命线）

- **分支/tag 映射走 `RefsReader`**：直接读 git 目录下的 refs（`resolveGitDir()` + `commondir`，loose + packed-refs），5s TTL；ref 变更操作后必须 `invalidate()`。禁止为取分支列表 spawn `git branch`。
- **外部变更靠 `watchRepositoryChanges()`**：`fs.watch` git 目录（HEAD/index/packed-refs + refs 递归），250ms 防抖后 `invalidateVolatile()`。这是 vscode.git `onDidChangeState` 删除后的唯一事件驱动失效来源；订阅者用 `Disposable` 归还，最后一个 token 释放时才真正关监听。
- **ahead/behind 走 `_getBranchTrackInfo()`**：单次 `for-each-ref refs/heads/ --format=%(refname:short)|%(upstream:short)|%(upstream:track)`，3s TTL + in-flight Promise 去重；格式化的 track 字符串要剥字面引号。
- **divergence 箭头展示必须实时**：`_refreshDivergence` 用 `force=true` 绕过 TTL。
- **持久化一律用 `ExtensionContext.workspaceState`（Memento）**，禁止往工作区写缓存文件（`.vscode/.qoder` 下的旧缓存文件机制已删除，`PersistedBranchCache` 负责一次性迁移）。
- 持久化结构必须带 `version` 字段 + schema 校验，加载失败要自愈（丢弃坏数据），历史污染数据（如带引号的分支名）在加载时清洗。
- **易失缓存生命周期**：分支切换/push/pull/fetch 等操作后调 `invalidateVolatile()`（清 trackInfo、refs、提交相关缓存）并按需 `refresh(true)`。
- **webview 隐藏时调 `releaseHeavyCaches()`**：清 `_filesCache` / `_detailCache`，保留 `_commitIndex`（LRU 200）与图缓存。
- **切换分支后必须创建全新的 GraphCommit 对象**，禁止复用任何缓存引用（vscode.git 共享引用曾导致跨分支污染）。
- 视图状态（分支/选中 hash/滚动位置/折叠态/详情可见性）由 webview 防抖 400ms 上报，扩展侧再防抖 400ms 写 Memento；隐藏/dispose 时必须 flush。

## 5. 服务层与测试

- **可被单测 import 的模块禁止 `import vscode`**（node:test 纯 node 运行，无 stub）。因此 `logger.ts` 包的是 `console` 而非 `OutputChannel`。
- 日志统一走 `logger`（src/services/logger.ts）：`logger.debug` 默认静默（`IDEA_GIT_DEBUG=1` 或配置 `idea-git.debug` 开启），`info/warn/error` 常显。禁止散落 `console.*`。
- 测试用 node:test 写纯函数级用例，输出到 `out/test/`，命名 `*.test.ts`。

## 6. Webview 规范

- **消息协议必须类型化**：所有扩展↔webview 消息在 `src/views/messages.ts` 定义为判别联合（`command` 字段），禁止 `as any`。
- **扩展→webview 首屏消息必须等 `ready` 握手**再投递（html 设置后立即 postMessage 会丢失）；等待期间缓冲，ready 时 flush。缓冲集中在 `GraphViewProvider._post`：刷屏类消息（`SCREEN_COMMANDS` 列出的那些）按 command 只留最新值，`case 'ready'` 里先 `_flushScreen()` 再 `_postRepoState()`。**隐藏视图即 DOM 销毁，`onDidChangeVisibility` 必须把 `_webviewReady` 置回 false 并清空缓冲**，否则消息打进已死的帧——多仓库冷启动走缓存快路径就会赢下这条竞态，分支与提交全丢、面板永卡骨架屏（第三栏反而有数据，因为它走的是握手后的往返）。
- **内联 JS 在 TS 模板串里要双重转义**：`\n` 等序列会静默杀死整段内联脚本。
- **XSS 防线**：所有插入 HTML 的动态文本走统一的 `esc()`（webview.js 内集中实现），禁止字符串拼接原始数据。
- **tooltip 用 `data-title` + 自定义浮层**，不用原生 `title`（白色原生 tooltip 会与主题浮层重叠）；多行内容 CSS 需 `white-space: pre-wrap`；`contextmenu` 时调 `window._hideTooltip()` 避免与右键菜单叠层。
- **浮动层层级是固定序**：对话框遮罩 `.push-dialog-overlay` = 2000，tooltip = 10000，`.context-menu` = 10001（必须盖过前两者）。菜单/浮层一律 append 到 `document.body`，任何"右键没反应/菜单不见了"先查层级再查逻辑——对话框内弹菜单曾因 1000 < 2000 画在遮罩底下。新增遮罩不得高于 10001，除非同时抬高菜单。
- **主题**：对话框、下拉等全部使用 VSCode 主题变量（`var(--vscode-*)`），不用原生 API 弹窗；HTML5 `datalist` 已弃用（暗色主题不可控），作者筛选用自定义下拉组件。
- **渲染性能**：行选中用 `applyRowSelection()` 原地切 class，只有 setData/setCommits/appendCommits 才全量 `renderRows()`。
- WebviewView 无 `retainContextWhenHidden`——隐藏即销毁 DOM，靠视图状态持久化恢复。

## 7. UI/UX 约定（对标 IDEA）

- 交互视觉：圆角 6–12px、`cubic-bezier` 过渡、悬停微动效、入场动画。
- 提交列表只显示消息**第一行**，完整信息放 tooltip；tooltip 结构化分行（作者/时间/本地/远程分支）。
- **所有搜索输入框（提交消息/作者/日期）回车触发**，不用 input 实时搜索；搜索结果用 `setStatusBarMessage`/`showInformationMessage` 系统提示，不做自定义 hint UI。
- 日期选择器联动：选完开始日期自动聚焦结束日期，强制 end ≥ start。
- 树节点：文件夹单击展开、分支双击切换；折叠指示器用内联 SVG chevron（`currentColor`），不用 ASCII；分支叶子只显示最后一段路径（`data-branch`/tooltip 保留全名，操作用完整 ref）。
- 右键菜单按类型区分：本地分支 7 项、远程分支 4 项精简。
- tag 显示为 IDEA 风格黄色徽章。
- 提交时间：<24h 显示相对时间，≥24h 显示 `YYYY-MM-DD HH:mm:ss`；**git log 一律用作者时间（%ai/%ar）**，不用 %ci/%cr；committer≠author 时详情额外显示"合入"行。
- 确认对话框保持简洁（标题+按钮），不堆技术细节。

## 8. Git 操作行为约定

- **变更类操作（检出/删除/重命名/新建/提交操作）必须包 `withProgress` 加载指示**。
- **删除/重命名分支成功后不刷新**：乐观更新 + 失败回滚 + `pauseBranchCheck(5000)`；重命名成功后只做 `refreshBranchesOnly()` 权威刷新（防止乐观结果被过期快照盖掉）；删除时若正在查看该分支的提交则切回当前分支。
- 重命名/删除后必须同步内部状态（`_branch`、`selectedBranch`），否则后续命令报 `unknown revision`。
- push 允许无 upstream 分支：`getUpstream` 包 try-catch；无 upstream 时用 `git log remote..local` 取待推送提交；推送对话框提交列表与箭头共用 `getBranchesWithDetails` 同一数据源，区分首次推送/已最新/有待推送三态，提交分页（首屏 20 条 + 加载更多）。
- `updateBranch`：远程存在同名分支时自动建立跟踪。
- **冲突处理（merge/rebase/cherry-pick）直接打开冲突文件**（`openConflictFiles`，上限 10 个 tab），解决靠核心 merge-conflict 扩展的 Accept Current/Incoming 代码透镜——它不依赖 vscode.git；插件只提供继续/终止入口和顶部持久化状态栏，**不再 `executeCommand('workbench.view.scm')` 把用户踢去内置 Git 的 SCM 视图**。冲突检测合并 stderr+stdout，扫 `unmerged files`、cherry-pick failed 等关键词，`isConflictError` 入参必须是字符串。
- 分支刷新按钮只刷分支树，不动中间提交列表；拉取其他分支时不触发 `_reload()`。
- 外部分支变更检测：**`fs.watch` 监听 git 目录本身**（用 `resolveGitDir()` 定位）并按 `filename === 'HEAD'` 过滤 + 300ms 防抖，**不要监听 HEAD 文件本身**——git 以 `HEAD.lock` + rename 覆写 HEAD，Windows 上文件级 watcher 仍可靠（实测三次 checkout 都收到事件），但 macOS/Linux 的 inotify 绑的是 inode，rename 覆盖后就成了孤儿监听，不可移植。轮询（2s，读 HEAD 零子进程）**常开**作兜底，不能只在 watcher `error` 时启用（孤儿监听不会报错，只是从此静默无事件）。仅 webview 可见时启用；`pauseBranchCheck` 冷却语义保留。
- 同一目录级 watcher 上还须按 `isOperationStateFile()` 分流到**进行中操作复检**（`MERGE_HEAD`/`CHERRY_PICK_HEAD`/`rebase-merge`/`rebase-apply`），否则外部解决冲突后分支上方的"继续/终止"不会自动收起。判定以**状态文件被清掉**为准：`git add` 全部解决但还没 commit 时 `MERGE_HEAD` 仍在，状态栏必须保留；`rebase-*` 优先级高于 `CHERRY_PICK_HEAD` 高于 `MERGE_HEAD`（rebase 内部就是 cherry-pick）。空闲态只准用 `detectOperationFromFiles()`（纯 `fs.existsSync`，零子进程），只有"已知在进行中"才调 `getInProgressOperation()`——它会 spawn `ls-files -u` 兜住无状态文件的未合并索引。任何走 `setData` 的刷新都要把 `_lastInProgress` 与新算出的值同步，否则复检会把刚投递下去的状态当成"变化"再发一次。
- 外部**历史**变更检测：在同一条 2s 轮询里比较"当前展示 rev 的 tip"——选中了分支就走 `getBranchTipHash()`（RefsReader，纯 fs），没选中就走 `getHeadHash()`；tip 变了才 `_reload(true, true)`，禁止无条件刷新（一次 `git log` 不便宜）。`_collect` 取完数据必须用**同一表达式**同步 `_lastKnownTip`，否则自己触发的刷新会被下一轮轮询误判成外部变化、再刷一次。RefsReader 有 5s TTL，外部提交的可见性靠 `.git` 目录监听触发 `invalidateVolatile()`（实测不 invalidate 时读到的是旧 tip），最坏 5s 后自愈。
- 自动刷新必须带 `preserveSelection`：webview 只在所选提交仍存在于新列表时保留选中项、详情、折叠态与滚动位置，否则退回全量重置——不带这个标志，用户在终端每提交一次面板就跳回顶部、第三栏清空。
- 日期筛选：git 的 `--since/--until` 不认 ISO 8601 的 `T`，转换为空格分隔格式。
- 文本搜索不用 `--fixed-strings`（要模糊匹配）；hash 搜索回退必须传 `branch` 参数（避免 `--all` 带出全分支提交）。
- **切换仓库只准走 `GraphViewProvider.switchRepository`**：面板切换器与 `idea-git.selectRepository` 命令共用这一条路径，保证重置的是同一批状态（`_branch`、选中提交、`_lastInProgress`、待落盘的视图快照，并按新 git 目录重新挂 watcher / auto-fetch）。git 允许不同项目重名分支与相同短哈希，任何一处"自己换个 root 就完事"都会把上一个项目的状态带进新仓库。文本过滤器是用户输入而非仓库状态，切换时**必须保留**，否则输入框与宿主过滤条件不一致。
- **仓库发现是"向上 + 向下"两条路**：`_findGitRoot` 的向上探测解决"文件夹在仓库里面"，但真实工作区更常见的是**一个普通父目录并排十几个独立仓库**——向上探不到，切换器就会数出 1 个仓库、干脆不出现。向下扫（`discoverRepositoryRoots`）必须带三条护栏：命中仓库即停（不再往里 list，这是成本的主要来源）、跳过点目录与依赖/构建树、深度与目录预算上限；结果缓存在 `_discoveredRoots`，只在 `_resetRootDiscovery()`（文件夹增减、`git init`、克隆出现/消失）时失效。实测十几个仓库 5ms。
- **缓存与快照必须能识别自己属于哪个仓库**：钉住的仓库写在 `workspaceState`（`idea-git.selectedRepository`），启动时用 `_hasGitDir` 校验，目录搬走就交给自动发现；持久化视图快照由宿主盖 `repoPath`，与当前仓库不匹配即丢弃（同 `PersistedBranchCache` 的 repoPath 校验思路）。
- **后台 / 定时任务禁止走 `_execNetwork`**：它会挂 `GIT_ASKPASS`，无人值守时弹出凭据框。自动 fetch 用 `fetchSilent()`（绕开 askpass + `GIT_TERMINAL_PROMPT=0` + 有限超时 + 失败只记 `logger.debug`），且先用 fs 读 `.git/config` 判断有没有远端——没远端一个子进程都不 spawn。这类任务还要绑"面板可见"条件，与分支 watcher 同起同停。

## 9. Git 工作流约束（AI 协作红线）

- **改动验证通过后直接本地提交**：compile/lint/test 全绿即 commit，不用先征求确认；提交信息沿用中文阶段式摘要（写清"为什么"）。
- **禁止自动合入主分支**：未经用户明确指示不执行任何 merge。
- **合入 main 前必须 bump 版本号 + 更新 CHANGELOG**：任何一次合入 main（包括文档类改动），先把 `package.json` 版本号递增、CHANGELOG 新增对应条目（概括本次合入的功能/修复/文档变更），与改动一起提交后再合并；版本号须与 Marketplace 发布版本一致。
- **禁止自动切换分支**：不主动 checkout。
- **禁止 push**，除非用户明确要求；用户说"提交并推送"时才一次性执行 add/commit/push。
- **发布流程触发词："项目升级"**：提交当前改动 → 按上条规则 bump 版本号并更新 CHANGELOG/README → `--no-ff` 合 main；不推送（除非用户要求）。发布由用户在自己终端执行（agent shell 无 VSCE_PAT），合入后提醒重新 `vsce publish`。

## 10. 环境杂项

- Windows Git Bash 重定向路径含反斜杠会被当转义吞掉，生成畸形文件名——脚本里统一用正斜杠。
- 打印含 Unicode 的文本到 Windows 控制台注意 GBK 编码错误。
- BasedPyright 枚举缓慢：已通过 `pyrightconfig.json` 排除规则 + 工作区设置解决，勿还原。

## 11. 国际化（i18n）硬性规定

- **所有面向用户的字符串必须双语**：在 `src/i18n/index.ts` 的 zh 与 en 两个字典中同时新增同名 key（单测 `dictionary parity` 会校验 key 集一致）。禁止在源码里直接写中/英文字面量。
- 扩展侧用 `t('key', { param })`；webview 侧用 `T('key', params)`（数据来自注入的 `window.I18N_STRINGS`）；package.json 贡献点用 `%key%`（值在 package.nls.json 默认 en / package.nls.zh-cn.json）。
- `src/i18n/index.ts` 是纯模块（不 import vscode），`setLocale()` 在激活时由 extension.ts 根据 `vscode.env.language` + `idea-git.language` 配置解析一次；语言切换时调 `graphView.relocalize()` 重设 webview html（ready 握手 + 视图状态持久化会自动恢复界面）。
- 对话框按钮等**程序化比较的值禁止用本地化文本**：webview 对话框用稳定的 `data-action` 键（如 cancel/push/force/close），宿主比较这些键；必须比较按钮文本的场景两侧都用 `t(key)`。
- 拼接进 HTML 的本地化字符串若含外部数据（分支名等），外部数据须先 `esc()`。
