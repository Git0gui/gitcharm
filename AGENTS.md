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
- **用户可见的 git 失败文案一律走 `formatGitError`（src/services/gitUtils.ts）**，不要 `String(error)`：那会带上 `Error: ` 包装，而 `GitCommandRunner` 把同一句 stderr 同时写进 `message` 与 `stderr`，直接拼就是"Error: fatal: …"重复两遍。显示文本有 4 行／400 字上限，所以**按关键词判定失败类型时用 `combineErrorText`（或 `error.message`）的原文**，只把 `formatGitError` 的结果交给用户——判在截断后的文本上，将来任何一条长 dump 都会让判定悄悄失效。
- **网络类失败由 `GitService._explainNetworkFailure` 分类补一句可执行提示**（凭据／证书／连不上）。"连不上"要先读 `git config --get http.proxy`（键不存在时 git 非零退出，按未配置处理）再决定提示：配了 → 让它检查代理是否还活着；没配 → 再读一次 **Windows 系统代理**（`systemProxy.readWindowsSystemProxy()`：`reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`，argv 数组无 shell，非 win32 直接返回 undefined，只在失败路径上跑一次），读到了就把**具体地址**写进提示——这一步是"我浏览器明明能上"的那半句答案：git 只认 `http.proxy` 和它自己的环境变量，注册表里的代理它天生看不见，所以光说"去配代理、端口自己填"等于没帮上忙。`ProxyServer` 是自由格式（裸 `host:port`、完整 URL、`https=…;http=…` 的按协议列表、`<-` 这类绕过标记），`parseWindowsProxySettings` 归一化成可直接粘贴执行的 URL：WinINET 的 `https=` 只表示"哪类流量用它"，代理本身仍是 HTTP CONNECT 所以给 `http://`；`socks` 是另一种协议要保留 scheme（裸 `socks` → `socks5`，git 没有 `socks://`）。凭据一律剥掉而不是打码——WinINET 把代理密码存在另一个键里，而粘上去就能跑比什么都重要。git 自己配过的代理展示前必须过 `redactUrlCredentials`。提示写在**第一行**——通知条截的是尾部，能行动的半句不能被截掉。**不要试图"替 git 读系统代理再自动配上"**：内置 Git 扩展同样不管这件事（2026-10-15 核对上游 main，`extensions/git/src/` 的 `git.ts`/`main.ts`/`askpass.ts` 里 `proxy` 出现 0 次，因为它 spawn git 而不是自己发请求），而 VS Code 自身的流量走 Electron/Chromium，那才有系统代理。"浏览器能上、面板连不上"因此是 git 的边界而非我们的实现差异。

- **写操作撞上"锁文件还在"时先问再删，只删仓库 git 目录里的那一个**：检出过程中关掉编辑器（或 git 进程被强杀）会留下 `index.lock` / `<ref>.lock`，之后每次写都是同一条 `fatal: Unable to create '<path>': File exists.`，用户只能自己去清。`_execMutate` / `_execMutateWithEnv` / `_execNetwork` 一律经 `_execWithLockRecovery`：`findStaleLock`（src/services/gitUtils.ts，纯函数）只认 `Unable to create '<path>':` 这一种形状，`_lockFileFromError` 再把路径解析进 `resolveGitDir()` / `commonDir` 之内、且确实是个已存在的 `.lock` 文件，才弹一个写明"删除会重试、真有进程在跑就别删"的模态框；同意后 `unlink` 并把**原命令重试一次**，删不掉就把原错误抛回去。**禁止静默删除**；`cannot lock ref '…': is at … but expected …` 是并发更新不是死锁，不要对它动手。后台 `fetchSilent` 故意走 `executeGitArgs` 裸路径，无人值守时不会弹框。

### 禁止依赖 vscode.git（已彻底移除）

- **不得再调用内置 git 扩展的任何 API**：`extensions.getExtension('vscode.git')`、`gitExt.activate()`、`getAPI(1)`、`repo.state` / `repo.getRefs()` / `repo.log()`，全部禁止；`package.json` 也不再有 `extensionDependencies`。回归测试 `src/test/noVscodeGit.test.ts` 会扫 `src/**` 拦住这类用法。
- **原因**：激活 vscode.git 是多 spawn 的仓库扫描（大仓库秒级），且它的 refs/HEAD 缓存滞后于真实变更；`repo.log(branch)` 忽略分支参数、`Commit.parents` 类型不稳定，踩坑成本高于收益。
- **原本从 vscode.git 拿的数据一律走本地实现**：分支名 → `RefsReader`（读 refs 文件）；upstream/ahead/behind → `_getBranchTrackInfo()`（单条 `for-each-ref`）；当前分支 → 读 `HEAD`；工作区是否干净 → `getWorkingTreeSummary()`（`status --porcelain -z`）；缓存失效 → `GitService.watchRepositoryChanges()`（`fs.watch` git 目录）。
- **不再注册自有 SCM Provider**：源代码管理面板完全交回内置 Git 扩展，GitCharm 不在那里出现（曾实现过 `src/scm/sourceControlProvider.ts`，已按用户要求整体移除，不要复活）。暂存/取消暂存/丢弃/状态条目只作为**服务层能力**保留：`GitService.add/stage/unstage/discard/getStatusEntries`（`src/services/gitService.ts`），由冲突处理等命令层调用。差异基线一律走 `idea-git-diff` 虚拟文档：索引内容用伪 ref `index` / `index:<stage>`（`_objectSpec` 翻译成 git 的 `:path` / `:1:path`）——**不要写 `0:path`**，实测 `git show 0:path` 直接 invalid object name，索引语法的前导冒号不能省。虚拟文档 provider 里**不要对 `uri.path` 再 `decodeURIComponent`**：`Uri` 的各段本来就是解码值（`toString()` 才是编码那一步），二次解码会把文件名里的 `%20` 读成空格，遇到真名含 `%` 的文件（`100%.md`）更是直接抛 `URIError`、差异框一片空白。
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
- **XSS 防线是 `esc()` + CSP 两道，缺一不可**：所有插入 HTML 的动态文本走统一的 `esc()`（webview.js 内集中实现），禁止字符串拼接原始数据；面板文档还必须带 `<meta http-equiv="Content-Security-Policy">`（`default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-…'`，nonce 由 `crypto.randomBytes` 生成）。**没有策略时 nonce 根本不参与校验**，只是装饰；而这些 HTML 全部由仓库内容（提交消息／作者／分支名／文件名）拼出来，一处漏 `esc()` 就落在一个能发 `postMessage` 触发检出/推送的帧里。新增内联 `<script>` 必须带同一个 nonce；新增外部资源只能走 `asWebviewUri`（字体型图标主题的 `@font-face` 就是这么来的），跨源地址会被策略吃掉；`style-src` 里的 `'unsafe-inline'` 不能省（行内 `style=` 与运行时注入的 `@font-face` 都靠它）。回归测试 `src/test/webviewHardening.test.ts` 扫模板守住这几条。`docs/preview/build-preview.mjs` 故意传 `csp = ''`：预览页用相对 file:// 路径加载 `media/`，严格策略会把它自己锁死。
- **tooltip 用 `data-title` + 自定义浮层**，不用原生 `title`（白色原生 tooltip 会与主题浮层重叠）；多行内容 CSS 需 `white-space: pre-wrap`；`contextmenu` 时调 `window._hideTooltip()` 避免与右键菜单叠层。
- **浮动层层级是固定序**：对话框遮罩 `.push-dialog-overlay` = 2000，tooltip = 10000，`.context-menu` = 10001（必须盖过前两者）。菜单/浮层一律 append 到 `document.body`，任何"右键没反应/菜单不见了"先查层级再查逻辑——对话框内弹菜单曾因 1000 < 2000 画在遮罩底下。新增遮罩不得高于 10001，除非同时抬高菜单。日期浮层用 9000（在对话框遮罩之上、tooltip 之下）。
- **浮层定位要"先摆再校"，不能只信算出来的边界**：宿主可以开缩放（`window.zoomLevel`／鼠标缩放），此时 CSS px 与 `getBoundingClientRect()` 的 px 不是一个尺度（实测 `width: 252px` 的框量出来 239.4），按数值 clamp 的右边界会差出零点几像素、刚好露出屏幕外。写法是先按估算位置摆好，再用真实渲染出的矩形对 `innerWidth/innerHeight` 复核并回挪（两趟足够）。
- **主题**：对话框、下拉等全部使用 VSCode 主题变量（`var(--vscode-*)`），不用原生 API 弹窗；HTML5 `datalist` 已弃用（暗色主题不可控），作者筛选用自定义下拉组件。原生 `input[type=date]` 同理已弃用——它的日历弹层归操作系统管，主题变量够不到，日期筛选现在是自绘的月历浮层（见 §7）。
- **渲染性能**：行选中用 `applyRowSelection()` 原地切 class；**`appendCommits` 走 `renderRows(true)`，只把新增那一页 append 进 `#rows`**，已画过的行保留原节点（列宽 `graphW` 烘在每个行的 `.garea` 里，所以泳道数一变会自动退回全量重画，这是对的）。实测（预览 harness，同一个 webview 帧内）：126 行时全量重画 18ms、追加一页 2–5ms；246 行时 32ms 对 3.8ms——全量重画随列表变长线性上涨，增量不涨。`.refs` 溢出淡出的测量**必须先一次性读完 `scrollWidth` 再写 class**（`markRefsOverflow()`）：读一个写一个会让浏览器每一行都强制一次同步布局。setData/setCommits 仍旧全量 `renderRows()`。**拖动/悬停类浮层同一条规则，而且这是功能性的**：日历网格在按住拖动期间只能原地 toggle class，绝不能重写 `innerHTML`——按下那个元素一旦脱离文档，浮层上"按在外部就关闭"的 `contains()` 判定就把这次按下读成"没点在浮层里"，拖动当场中断（现象是"根本拖不动"，静态读代码看不出来）。
- WebviewView 无 `retainContextWhenHidden`——隐藏即销毁 DOM，靠视图状态持久化恢复。

## 7. UI/UX 约定（对标 IDEA）

- 交互视觉：圆角 6–12px、`cubic-bezier` 过渡、悬停微动效、入场动画。
- 提交列表只显示消息**第一行**，完整信息放 tooltip；tooltip 结构化分行（作者/时间），**分支与标签不写进消息 tooltip**。
- **提交行是"消息在前、徽章在后"**（IDEA Log 的顺序）：`.msgline` 里 `.msg` 保持自然宽度，徽章列 `flex: none`，行窄时只让消息出省略号，徽章不被长消息挤掉。**一个提交只出一个徽章**：`refChipHtml` 取 `refs[0]`（宿主已把标签排在分支前），其余折叠成徽章内的 `+N`（`.chip-more`）——标签与它所在的分支因此合成一个折叠徽章，而不是并排占掉大半个行。**徽章悬浮弹完整列表**（`.refs-popover`，`position: fixed`、z-index 9500）：每个分支/标签一行、各带图标（标签 I_TAG 黄、远程 I_CLOUD 紫、本地分支 I_BRANCH 蓝、当前分支 I_BRANCH_CURRENT），名称先 `esc()` 再拼；定位是"先摆再校"（先按徽章列的 left/bottom+4 摆，再用渲染后的矩形对 `innerWidth/innerHeight` 复核，底部不够就翻到上方）。滚动、按下、行重建（`renderRows`）、鼠标离开都要收起——重建后锚点节点已不在文档里，不收起就会浮在旧位置。**远程判定只能看远程名**（`isRemoteRefName`，拿 `state.remote` 的首段比对；`remotes/` 前缀兜底），**不能见到 `/` 就当远程**——`feat/x` 是本地的。**不要再把分支/标签塞回消息 tooltip**：两处重复且挤占消息。
- **所有搜索输入框（提交消息/作者/日期）回车触发**，不用 input 实时搜索；搜索结果用 `setStatusBarMessage`/`showInformationMessage` 系统提示，不做自定义 hint UI。**唯一的例外是"删空"**：input 里最后一个字符被删掉时立刻 `pushFilters()`，因为这一步没有歧义（空 = 不过滤），而等回车会让列表继续按一个框里看不见的词过滤——现象就是"搜索过一次之后，框里没东西也刷不出别的"。
- **已生效的筛选条件只活在宿主（`_filters`），输入框是 DOM，而隐藏面板会销毁 DOM**：所以每次重绘提交列表都必须回灌（`_postFilterMirror()` → `syncFilters`，它是 `SCREEN_COMMANDS` 成员，跟着 `ready` 握手重放）。漏掉这条 = 重新显示面板后框是空的、列表却还在按上次的词筛，刷新按钮看起来直接把空框当搜索词用。webview 侧只在**框为空时**填，绝不覆盖或清空已有文本——没按回车的草稿是用户还没说出口的话。新增任何筛选输入框都要走这一条，别只改宿主。回归测试 `src/test/filterMirror.test.ts` 守这几个点。
- **中间筛选栏只有一行，形态跟 IDEA 一致**：搜索框内嵌 `.*`（正则）与 `Cc`（区分大小写）两个开关——它们是**模式不是草稿**，回灌时无条件跟着宿主设（`applyFilterMirror` 直接赋值），空框也保持点亮，因为下一次输入就按这个模式搜。列宽低于 `COMPACT_CENTER_W`（500px）时，用户／路径／时间三个框整体搬进 `>` 浮层：搬的是**同一批 DOM 节点**而不是克隆，值、监听、作者下拉状态跟着走；折叠后 `>` 上的强调边表示"有看不见的筛选还在生效"，否则行变短了却没有原因。宽度判断用 `#center.clientWidth` + `ResizeObserver`，**隐藏态量到 0 必须直接返回**（那不是窄列，把三个框搬走会让重新显示的面板少掉一半工具栏）。浮层 z-index 8500：日期日历（9000）是从它内部打开的，绝不能被压在下面。
- **日期筛选是一个范围按钮 + 自绘月历**（`#date-trigger` → `.date-popover`）：按住拖动圈选一段时间，反着拖自动归正；不想拖就先点起始日再点结束日（`datePick.pending`，提示语跟着变）。网格固定 6 周，所以跨月拖动落在同一格里、浮层高度不会中途跳动。端点在 webview 内就排好序再发出，**宿主收到的格式不变**（`YYYY-MM-DDT00:00:00` / `T23:59:59`，git 侧仍按 §8 把 `T` 换成空格）；因为结构性选不反，原先的 `w.endBeforeStart` 校验已删。快捷区间 今天／近 7 天／近 30 天／近 1 年，点标题切年视图。**松手只有落在日历内才算完成**：`mouseup` 在浮层外一律视为放弃，否则按下去之后把鼠标移出窗口松手留下的 `dragging`，会在用户下一次点任何东西时提交成一个莫名其妙的区间。
- 树节点：文件夹单击展开、分支双击切换；折叠指示器用内联 SVG chevron（`currentColor`），不用 ASCII；分支叶子只显示最后一段路径（`data-branch`/tooltip 保留全名，操作用完整 ref）。
- 分支右键菜单按类型区分（远程精简、当前分支只给适用项），**收藏切换固定排在最后一项**，类型相关操作在前。操作记录（reflog）只从工具栏那个时钟按钮进入——它跟随提交列表所选分支，分支行菜单不再重复这一项（`action: 'reflog'` 的宿主分支与对话框都保留，别连带删掉）。
- tag 显示为 IDEA 风格黄色徽章。
- 提交时间：<24h 显示相对时间，≥24h 显示 `YYYY-MM-DD HH:mm:ss`；**git log 一律用作者时间（%ai/%ar）**，不用 %ci/%cr（这只管**显示**哪一天；判一组提交谁先谁后见 §8 的 `orderCommitsByHistory`）；committer≠author 时详情额外显示"合入"行。
- 确认对话框保持简洁（标题+按钮），不堆技术细节。

## 8. Git 操作行为约定

- **变更类操作（检出/删除/重命名/新建/提交操作）必须包 `withProgress` 加载指示**。**网络类（push/pull/手动 fetch／分支菜单的"拉取"）尤其：`_execNetwork` 刻意不设子进程超时（大仓库不能被 30s 掐断），凭据又要等用户在自己的输入框里填，没有进度指示就等于"界面卡死"**；进度一律 `cancellable: false`（git 子进程没有取消通道，别给假按钮）。面板的"拉取"走 `idea-git.updateBranch`（内部可能是 fetch + `update-ref`，也可能是 pull），同样要包；漏掉时界面只剩结束后的一句提示。
- **作者时间不能用来判一组提交的早晚**：cherry-pick / rebase / amend 会保留原作者时间、落地顺序却相反——实测 bouncePy 里 `cfccce3`（author 13:39）是 `5f8c82d`（author 14:48）的**子**提交（committer 16:09）。按 `%ai` 排会把"最早^ ↔ 最晚"算成同一个提交跟自己比（差异恒空，看着就像视图坏了），回退/挑拣/压缩的参数顺序与 squash 的 `baseRef` 也会取错端点。判早晚统一走 `GitService.orderCommitsByHistory`（委托 `squash.ts` 的 `orderHistoryOldestFirst`：一次真走一遍的 `rev-list --topo-order -n K <选中提交>`，窗口 200→2000→不限，与点击顺序无关；起点用选中提交而不是 HEAD，面板在看别的分支时才对）；面板列表本身的顺序就是 git log 的顺序，两者一致。**不要用 `rev-list --no-walk --topo-order`**——`--no-walk` 把要排序的那次遍历本身取消了，git 基本按传入顺序返回（实测线性历史喂 `b z a y` 得 `b z a y`，喂 7 条得 `b c x y z w a`），那正是这里曾经写过的错法，等于把点击顺序当历史顺序。
- **压缩提交只折叠"紧挨着的那几段"，且消息落在自己那段上**（`src/services/squash.ts` + `GitService.planSquash/squashGroups`）。选中项按历史顺序切成相邻段，每段一次 `rebase -i`：段写成 `pick`+`squash`…，**段外提交一律留在原位 `pick`**——todo 里不列就是删提交（实测 4 行 todo 跑 6 条范围，剩 4 条且无警告），所以尾巴必须整段列出来。段从**新到旧**执行（一次 pass 会重写它之后的所有提交，先跑旧段才能让未跑段的哈希继续有效），每段执行前重读一次范围。起点是根提交时用 `--root`（`x~1` 是 fatal）。**禁止回到"并成一个块 + amend HEAD"**：那是原版把编辑好的消息按到 HEAD 上（压早期提交改的是最新那条的记录），跨未选提交时还把未选提交挪到折叠之后、撞上冲突停在半路 rebase 里。每段一条消息走 `GIT_EDITOR="cp <消息文件>"`——一次 pass 里只有那条 `squash` 会开消息编辑器（纯 `pick` 复用自身消息），"一个文件对一段"成立；不要用 `exec`（第二条 shell 面）也不要 `edit` 停下再改（一个提交不能在 todo 出现两次，且停下时 HEAD 是新哈希、按 sha 对不回原段）。命令层**先把所有段的消息问齐再动历史**，中途取消 = 没做过。段的数量 > 1 时逐段提问，所以对话框不得按墙钟超时释放（旧 60s 回退会静默吞掉用户正在写的文本）。回归测试 `src/test/squashAcceptance.test.ts`：golden 用例钉住两个示例与全选/根提交/倒着点/拒绝路径，另有一组用例专门留档旧算法的错误行为。
- **多选提交的合并文件列表必须在宿主合并**（`mergeCommitFileStats`，`src/services/gitUtils.ts`），webview 只渲染。两条不变量：批次必须按**历史顺序旧→新**排好再进去（`orderCommitsByHistory`，**不是作者时间**，见上一条）（状态取净效果：选择内新建的保持 `A`、之后被删则 `D`；点击顺序进来的话同一个文件会一会儿 `A` 一会儿 `M`）；条目必须**复制后再累加行数**——`getCommitFilesWithStats` 返回 `_filesCache` 里的同一批对象，原地加数字会让下一次多选变成双倍。
- **多选提交里双击文件 = 跨这一组提交的双栏对比**：左边取**最早**提交的父版本（`getDiffBase(oldest)`，见下条），右边取**最晚**提交的版本，组里每个提交的改动才会都落在同一份 diff 里（只带最后点选的 `selectedHash` 就只看得到一个提交）。早/晚由 `orderCommitsByHistory` 按**历史顺序**判定（作者时间在这组数据里正好是反的，见上一条）。双栏只能放两个版本，选中项之间那些没被选的提交会一起出现在差异里——这是用户要的效果。**不要改成"逐提交补丁拼一份只读文档"**（已实现并被否掉，见 commit `6b098bf`）：用户要的一直是熟悉的左右对比，不是补丁文本。修好顺序后，用户那组选择的差异是 `+2 -1`，与第三栏合并文件行显示的数字一致。
- **双击文件开编辑器对比一律走 `openEditorDiff`（`src/commands/helpers.ts`）**：先问 git 自己这次算不算文本差异——`GitService.isBinaryChange` 跑 `git diff --numstat base..target -- path`，`isBinaryNumstat` 认那一行 `-\t-\t<路径>`；是二进制就**只给一句提示，绝不把原始字节交给文本 diff**。实测把仓库里 514KB 的 `docs/preview/out/main.png` 按 utf8 解码：487,260 个字符里 208,828 个是替换字符 `U+FFFD`（43% 根本没解出来），全文只有 1601 个换行、最长"一行" 6,903 字符——这种文档文本对比既读不出内容也算不完，用户看到的就是"双击图片后对比页一直转圈、没有数据"。第三栏的行内预览早就拒绝预览二进制（`preview.binary`），编辑器必须给同一个答案，而不是开一个永远不结果的标签页。**新增 `vscode.diff` 调用点要显式登记进 `src/test/binaryDiffGuard.test.ts` 的白名单**——唯一合理的例外是"一侧是工作区里的真实文件"（与本地文件对比、与分支/HEAD 对比），那种场景编辑器对那一侧本来就有自己的处理。
- **差异左端一律 `getDiffBase(hash)`，禁止字面写 `hash^`**：`git show <root>^:path` 是 fatal（实测 exit 128），而虚拟文档 provider 把所有失败都答成空串，于是首个提交的左半边无声消失、和"这一版确实是空的"完全分不清——空树（`EMPTY_TREE_HASH`）才是那个语义正确的左端。行内预览与编辑器现在共用同一对端点（多选组同理走 `getDiffBase(oldest)`）。
- **行历史（`Alt+H` / 右键"选中行历史"）是一个独立 WebviewPanel，不是 mainView 的第四栏**（`src/services/lineHistory.ts` + `src/views/lineHistoryPanel.ts` + `media/lineHistory.*`）。四条硬规定：① **blame 必须跑在编辑器缓冲区上**（`git blame --porcelain --contents - -L a,b -- <rel>` + stdin = `doc.getText()`），否则未保存的修改会导致行号错位，旧设计"把脏行从集合剔除"是错的——用户改了一行再看历史，会看到自己那行的上一版被标成别人的提交；② **排序用 `committerTime` 降序、hash 兜底**，作者时间被 rebase/amend 保留、落地顺序却相反（同本文件 §8 第一条），按 `authorTime` 排会让列表把最新提交排到最后；③ **renames 靠 porcelain 每个提交的 `filename` 字段**，那是该提交时文件的名字，diff 与原生对比都必须用 `commit.path`——用当前路径去 diff 更早的提交，git 只会回一句"没有这个文件"，卡片无声空白；④ **下方 diff 默认只显示"选中行的改动"**（用户明确要求），不是整文件：porcelain 头部 `<sha> <orig> <final>` 的 **orig 行号**才是这些行在该提交里的位置（final 是今天缓冲区的行号，拿去 diff 会指错行），据此 `parseUnifiedDiff` 只保留新侧区间覆盖这些行的 hunk，再按 ±3 行裁剪（`trimToHits`，缺口画 `⋯`）——初始导入是一个覆盖全文的 hunk，不裁剪的话"只选一行"仍然会画出整文件 2000 行。头部按钮可切"整文件"，两种口径各自进缓存 key（`_diffKey`）。diff 端点照旧 `getDiffBase(hash)` + `openEditorDiff`（二进制闸门也照旧）。面板单例：同文件再触发 = 换目标 + 清 diff 缓存 + 重载（不新开 tab），`_current` 在 `onDidDispose` 里清空；`retainContextWhenHidden` 开着，因为切回编辑器再回来不该重跑 blame。webview 侧 `requestId` 逐次自增，宿主回的 `lh.diff` 只认当前选中 + 当前 requestId（快速连点会乱序）。分页在 webview 内做（`PAGE = 10` + "加载更多"按钮），宿主一次给全量提交集合——每页 10 条写进 git log 会让"还有没有更多"变成一次往返。
- **文件历史复用行历史面板，走 `mode: 'file'`**（`LineHistoryTarget.mode`）：列表来自一次 `git log --follow --name-status`，`parseFileLog`（`src/services/fileHistory.ts`）取每个提交**当时**的文件名（重命名取 `Rxxx old new` 的新名，diff 必须用它），所以列表没有行号范围、diff 恒为整文件，webview 按 `mode` 隐藏范围标签与"整文件"开关。面板单例按模式各一个（`_current` 是 `Map<mode, panel>`），行历史与文件历史互不覆盖。`idea-git.viewFileHistory` 按配置 `idea-git.fileHistory`（默认 `custom`）分流：`native` 调 `files.openTimeline`，`custom` 打开该面板；菜单名就叫「文件历史」，不带"原生"。
- **删除/重命名分支成功后不刷新**：乐观更新 + 失败回滚 + `pauseBranchCheck(5000)`；重命名成功后只做 `refreshBranchesOnly()` 权威刷新（防止乐观结果被过期快照盖掉）；删除时若正在查看该分支的提交则切回当前分支。
- 重命名/删除后必须同步内部状态（`_branch`、`selectedBranch`），否则后续命令报 `unknown revision`。
- push 允许无 upstream 分支：`getUpstream` 包 try-catch；无 upstream 时用 `git log remote..local` 取待推送提交；推送对话框提交列表与箭头共用 `getBranchesWithDetails` 同一数据源，区分首次推送/已最新/有待推送三态，提交分页（首屏 20 条 + 加载更多）。
- `updateBranch`：远程存在同名分支时自动建立跟踪。
- **冲突处理（merge/rebase/cherry-pick）直接打开冲突文件**（`openConflictFiles`，上限 10 个 tab），解决靠核心 merge-conflict 扩展的 Accept Current/Incoming 代码透镜——它不依赖 vscode.git；插件只提供继续/终止入口和顶部持久化状态栏，**不再 `executeCommand('workbench.view.scm')` 把用户踢去内置 Git 的 SCM 视图**。冲突检测合并 stderr+stdout，扫 `unmerged files`、cherry-pick failed 等关键词，`isConflictError` 入参必须是字符串。
- **一步"改动变空"必须先于冲突判定处理**（`isEmptyCommitStop`/`emptyCommitStopInfo` + `tryHandleEmptyCommitStop`）：解决冲突时保留对面已有内容会让这一步补丁变空，git 停下打印整段 advice，那三行就是用户能做的三个选择——改为弹"跳过这个提交／保留这个空提交／终止"。接入点（继续操作、cherry-pick、revert、交互式变基、变基到某分支、拉取/更新分支）**一律排在 `isConflictError` 之前**：advice 含 `Could not apply`，先判冲突会把用户赶去解决已经不存在的冲突。实测（git 2.45.1.windows.1）：cherry-pick 与 rebase 打印 advice 块，`git revert --continue` 只打印状态头 + `nothing to commit, working tree clean`，判据两种形状都要认；`.git/sequencer/todo` 不随执行消耗（进度记在别处），所以"保留空提交"（`commit --allow-empty --no-edit`，会复用准备好的消息）之后必须再 `--continue` 才跑得完剩余队列——单条 pick 不留 `sequencer` 目录，多条才留，用 `hasPendingSequencerSteps()` 分辨；续跑时撞上下一步的真冲突要走既有冲突路径，不能报"处理这一步失败"。所有 `--continue` 都要带 `GIT_EDITOR=true`（宿主没有终端可交给交互式编辑器）。
- 分支刷新按钮只刷分支树，不动中间提交列表；拉取其他分支时不触发 `_reload()`。
- 外部分支变更检测：**`fs.watch` 监听 git 目录本身**（用 `resolveGitDir()` 定位）并按 `filename === 'HEAD'` 过滤 + 300ms 防抖，**不要监听 HEAD 文件本身**——git 以 `HEAD.lock` + rename 覆写 HEAD，Windows 上文件级 watcher 仍可靠（实测三次 checkout 都收到事件），但 macOS/Linux 的 inotify 绑的是 inode，rename 覆盖后就成了孤儿监听，不可移植。轮询（2s，读 HEAD 零子进程）**常开**作兜底，不能只在 watcher `error` 时启用（孤儿监听不会报错，只是从此静默无事件）。仅 webview 可见时启用；`pauseBranchCheck` 冷却语义保留。
- 同一目录级 watcher 上还须按 `isOperationStateFile()` 分流到**进行中操作复检**（`MERGE_HEAD`/`CHERRY_PICK_HEAD`/`rebase-merge`/`rebase-apply`），否则外部解决冲突后分支上方的"继续/终止"不会自动收起。判定以**状态文件被清掉**为准：`git add` 全部解决但还没 commit 时 `MERGE_HEAD` 仍在，状态栏必须保留；`rebase-*` 优先级高于 `CHERRY_PICK_HEAD` 高于 `MERGE_HEAD`（rebase 内部就是 cherry-pick）。空闲态只准用 `detectOperationFromFiles()`（纯 `fs.existsSync`，零子进程），只有"已知在进行中"才调 `getInProgressOperation()`——它会 spawn `ls-files -u` 兜住无状态文件的未合并索引。**首屏 `resolveWebviewView` 与每次 `_collect` 也属于空闲态**，同样只走 `detectOperationFromFiles()`，别在每次刷新前白付一个子进程。任何走 `setData` 的刷新都要把 `_lastInProgress` 与新算出的值同步，否则复检会把刚投递下去的状态当成"变化"再发一次。
- **记住的分支可能已经不存在**：视图状态与持久化分支缓存都不校验 refs，外部删分支后重开面板会把死名字直接交给 `git log`，报 `ambiguous argument 'x': unknown revision`。载入前用 `getBranchTipHash`（纯 fs）校验；未命中先 `invalidateVolatile()` 再复读一次（RefsReader 有 5s TTL，别把刚建的分支误判成删除），确认消失就清空选择、按全部提交展示并强制刷新分支树。`setBranches` 也要在选中项不在新列表里时清掉高亮，否则树里会留下一行点了就报错的幽灵分支。
- 外部**历史**变更检测：在同一条 2s 轮询里比较"当前展示 rev 的 tip"——选中了分支就走 `getBranchTipHash()`（RefsReader，纯 fs），没选中就走 `getHeadHash()`；tip 变了才 `_reload(true, true)`，禁止无条件刷新（一次 `git log` 不便宜）。`_collect` 取完数据必须用**同一表达式**同步 `_lastKnownTip`，否则自己触发的刷新会被下一轮轮询误判成外部变化、再刷一次。RefsReader 有 5s TTL，外部提交的可见性靠 `.git` 目录监听触发 `invalidateVolatile()`（实测不 invalidate 时读到的是旧 tip），最坏 5s 后自愈。
- **面板重新显示时不做无条件强制刷新**：隐藏会销毁 webview，数据必须重发，但 `_onPanelShown` 先用同一 tip 表达式比一次（纯 fs）：没变就 `_reload(false)` 复用图缓存，变了（包括落在 watcher 250ms 防抖窗口里的新提交）才强制重查；`resolveWebviewView` 后 1s 内的 visibility 事件属于同一次显示，直接跳过，避免同一查询跑两遍。
- **git 可用性探测只持久化"可用"**（`idea-git.gitAvailable`，workspaceState）：命中时跳过 `git --version`，让首屏数据命令直接起跑。它只是捷径不是结论——任何真实命令的 ENOENT/EACCES/EPERM 会经 `_noteMissingGit` 把内存与持久化标记一起翻掉，`_recoverMissingGit` 随即切到无 git 引导页。**不要持久化"不可用"**：git 可能已经被装上，负面结果会让引导页停在错误结论。
- 自动刷新必须带 `preserveSelection`：webview 只在所选提交仍存在于新列表时保留选中项、详情、折叠态与滚动位置，否则退回全量重置——不带这个标志，用户在终端每提交一次面板就跳回顶部、第三栏清空。
- 日期筛选：git 的 `--since/--until` 不认 ISO 8601 的 `T`，转换为空格分隔格式。
- 文本搜索默认 `-F`（字面子串——仍然是"模糊匹配"，只是不再把 `( . *` 当语法），面板搜索框内嵌的 `.*` 开关切到 `-E` 扩展正则、`Cc` 开关去掉 `-i`。这两个开关**是筛选条件的一部分**：一起进 `_filters`、跟着 `syncFilters` 回灌、并进图缓存 key（同一批词两种搜法是两份答案，缓存不分家就会拿错列表）。注意 git 的这些标志对整个 rev walk 生效，`--author` 也跟着变（它本来就是大小写不敏感的）。hash 搜索回退必须传 `branch` 参数（避免 `--all` 带出全分支提交）。
- **切换仓库只准走 `GraphViewProvider.switchRepository`**：面板切换器与 `idea-git.selectRepository` 命令共用这一条路径，保证重置的是同一批状态（`_branch`、选中提交、`_lastInProgress`、待落盘的视图快照，并按新 git 目录重新挂 watcher / auto-fetch）。git 允许不同项目重名分支与相同短哈希，任何一处"自己换个 root 就完事"都会把上一个项目的状态带进新仓库。文本过滤器是用户输入而非仓库状态，切换时**必须保留**，否则输入框与宿主过滤条件不一致。
- **仓库发现是"向上 + 向下"两条路**：`_findGitRoot` 的向上探测解决"文件夹在仓库里面"，但真实工作区更常见的是**一个普通父目录并排十几个独立仓库**——向上探不到，切换器就会数出 1 个仓库、干脆不出现。向下扫（`discoverRepositoryRoots`）必须带三条护栏：命中仓库即停（不再往里 list，这是成本的主要来源）、跳过点目录与依赖/构建树、深度与目录预算上限；结果缓存在 `_discoveredRoots`，只在 `_resetRootDiscovery()`（文件夹增减、`git init`、克隆出现/消失）时失效。实测十几个仓库 5ms。
- **推送不因"已是最新"提前返回**：ahead=0 也要打开推送对话框（对话框自己有首次推送/已是最新/待推送三态），用户点的是"查看并推送"，不是"后台替我判断"。推送预览只有一个数据源 `GitService.getPushPreview(branchName, preferredRemote?)`（提交列表、baseRef、ahead/behind、远端列表都在里面），命令入口与对话框里切换远端共用它。目标选择走 `resolvePushTarget`：**显式选择的远端不得回退到别的远端**——在 fork 上首次推送不能被误判成 origin 的普通推送；没有显式选择时才按 upstream 远程 → 同名远程分支（origin 优先，能处理 `dev/x` 带斜杠的分支）→ origin。首次推送带 `--set-upstream` 建立跟踪，否则推完也没有 ahead/behind，下一次又显示成首次推送。git 对"没有可推内容"是 exit 0 + stderr `Everything up-to-date`，成功提示要按**用户最后确认的那个远端**的 ahead/behind 判定，不能一律报"已推送"。
- **对话框的消息监听不得按墙钟超时释放**：推送对话框可能被用户放很久，60s/300s 后 dispose 监听会让 DOM 里的按钮全部失效（对话框还在，但点什么都没反应）。监听随"动作返回 / 关闭 / 面板隐藏 / webview 销毁"释放；面板隐藏会销毁 DOM，此时推送命令必须立即拿到 undefined 返回，否则永久挂住。
- **异步响应必须对得上当前选中**：webview 收到 `setDetail` 要校验 `commit.hash === state.selectedHash`，收到 `multiCommitsResponse` 要校验提交集合与 `state.selectedHashes` 一致——快速连点时旧请求晚到会把上一个提交的详情盖到当前选中行。加载更多失败时宿主必须回 `loadMoreFailed`：webview 的 `state.loadingMore` 只有 `appendCommits`/`setLoader(false)` 能清，不清就永远不再发请求。
- **blame 浮层的"在 GitCharm 中查看提交"是把提交列表改根到那条提交，不是单独显示它**：`GraphViewProvider.revealCommit` 先同步写下 `_revRoot = {rev, branch}` 再碰任何 await（聚焦视图会在同一 tick 里自己起跑一次加载，那页是按分支 tip 查的，晚到就把 reveal 盖掉），随后所有历史查询一律走 `_listRev()`，于是那条提交落在列表中间：上面是它的子提交，下面是它的祖先，两个方向都能滚。**`_revRoot` 记着 rooting 时的分支**，所以选别的分支、切仓库都会让它自己失效；**任何 `_reload` 都必须清掉它**（清根写在 `_repoState` 判定之前，引导页那条早退路径也不能留），否则新提交永远进不了这个列表。hash 查不到时走 `_dropReveal`：清根 + 重刷 + 一句提示，禁止把面板留在"只有骨架屏"的半更新状态。
- **首屏一律走 `_firstPageRows()`，子提交段只在 rooted 时多花两个子进程**：`countCommitsAfter`（`rev-list --count <rev> --not <hash>`）先算出这条提交之后有多少提交，再用 `skip = 数量 - REVEAL_CHILD_WINDOW` 取区间**尾段**——`git log -n` 是从 tip 数起的，`--reverse` 只颠倒输出、不改计数（实测 61 条之后 `--reverse -n 5` 仍给最新那 5 条），不这么算就会在尾段和 rooted 行之间留一段空洞。面板没有向上翻页，所以这段封顶 50 行；`_loaded`（下一页的 `--skip`）只数 rooted 页，`_loadedHashes` 数两段。`getCommitGraphData({excludeAncestorsOf})` 走 `--not <hash>` 而不是 `hash..rev`，因为 `assertRef` 禁止 `..`。子提交段**不套面板过滤器**：它是"这条提交之后发生了什么"的上下文，而且过滤后的区间长度对不上未过滤的 count，skip 会算错。
- **"当前文件夹不是仓库"的引导页必须列出已发现的仓库**：`#repo-state` 是 `position: fixed; inset: 0` 的全屏遮罩，底下的仓库切换器点不到，所以当 `listRepositories()` 已经找到仓库时要把它们作为按钮直接画进卡片（`data-repo-pick` → `selectRepository`）；只给"初始化仓库"会把用户引到一个本不该建仓库的父目录。这一状态在"一个普通父目录并排若干独立仓库"的工作区里是常态——向上探测当然找不到仓库。
- **缓存与快照必须能识别自己属于哪个仓库**：钉住的仓库写在 `workspaceState`（`idea-git.selectedRepository`），启动时用 `_hasGitDir` 校验，目录搬走就交给自动发现；持久化视图快照由宿主盖 `repoPath`，与当前仓库不匹配即丢弃（同 `PersistedBranchCache` 的 repoPath 校验思路）。
- **后台 / 定时任务禁止走 `_execNetwork`**：它会挂 `GIT_ASKPASS`，无人值守时弹出凭据框。自动 fetch 用 `fetchSilent()`（绕开 askpass + `GIT_TERMINAL_PROMPT=0` + 有限超时 + 失败只记 `logger.debug`），且先用 fs 读 `.git/config` 判断有没有远端——没远端一个子进程都不 spawn。这类任务还要绑"面板可见"条件，与分支 watcher 同起同停。
- **删除标签让用户选目的地**：确认框的答案是「删除本地」「删除本地和远端」「取消」三选一（没有远端时只剩本地/取消，文案同时说明"此仓库没有配置远端，只能删除本地标签"），命令标题因此叫「删除标签」而不是「删除本地标签」。选"本地和远端"时**先删远端再删本地**——网络那一半失败（凭据、保护规则）不能把用户同样要求的本地清理一起中止；远端根本没这个标签（`remote ref does not exist`）不算失败，那是"本来就没得删"。**推送标签前先确认有远端**（`ensureRemote`）：本地仓库没有远端时提示"标签只能保存在本地"并给「管理远端」入口，不要让 `git push origin` 抛出一句看起来像仓库损坏的 fatal。
- **工具栏标签菜单是「推送标签… / 删除标签… / 远端标签差异…」**：「推送全部标签」已从菜单撤掉（命令 `idea-git.pushAllTags` 只留在命令面板）。「删除标签…」（`idea-git.deleteTags`）先选标签、确认框明说本地与远端一起删，**只有每个远端删除都成功才动本地**——任何远端失败（凭据、保护规则）就整体中止并提示重试，不留下"远端删了、本地还在"的半截状态。这与徽章右键的三选一有意不同：那里是用户逐个决定，这里用户点的是"两边一起清掉"。
- **完整 stderr 必须落到输出通道**：通知条按 `formatGitError` 截断（4 行/400 字），排障需要的原文在 `GitCharm` OutputChannel 里。`logger` 的 sink 由 `extension.ts` 注入（服务层不 import vscode），命令 `idea-git.showLog` 打开；push/pull/fetch/update 的 catch 用 `logger.error` 记录**经 `redactUrlCredentials` 清洗**的原文，错误通知带"显示日志"按钮。

## 9. Git 工作流约束（AI 协作红线）

- **改动验证通过后直接本地提交**：compile/lint/test 全绿即 commit，不用先征求确认；提交信息沿用中文阶段式摘要（写清"为什么"）。
- **禁止自动合入主分支**：未经用户明确指示不执行任何 merge。
- **合入 main 前必须 bump 版本号 + 更新 CHANGELOG**：任何一次合入 main（包括文档类改动），先把 `package.json` 版本号递增、CHANGELOG 新增对应条目（概括本次合入的功能/修复/文档变更），与改动一起提交后再合并；版本号须与 Marketplace 发布版本一致。
- **CHANGELOG 分两份，每次发布两份都要写**：根目录 `CHANGELOG.md` 面向用户，随 VSIX 发布并在市场页展示——每个版本只留简短明确的几条，只说用户能感知的变化，不写文件名、函数名、实测数据；`docs/CHANGELOG-detailed.md` 面向维护者，保持详细程度（踩坑原因、实测数据、涉及的函数与文件），`docs/` 不进 VSIX。新增条目一律写在两份文件的最上方，版本号与日期保持一致。
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
