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
- rebase/squash 等需要编辑器的操作：用 `env` + `cp` 作为 GIT_EDITOR/GIT_SEQUENCE_EDITOR，不要依赖交互式编辑器。

### vscode.git API 使用边界

- **冷路径禁止 await vscode.git 激活**：`_loadGraphData` / `_loadBranchDetails` / `getDivergenceInfo` / `getHeadHash` 不得触发 `gitExt.activate()`（其内部仓库扫描是多 spawn，大仓库秒级）。
- **热路径可以用**：push / compareFileWithBranch 的分支存在性检查（`getBranchesFromVscodeGit()`），以及 `onDidChangeState` 事件驱动缓存失效。
- `repo.getRefs()` 替代已废弃的 `state.refs`（最低 VSCode 1.95.0）。
- **已知缺陷，禁止踩**：
  - `repo.log(branch)` 忽略分支参数、返回共享缓存的相同对象引用，且 `repo.log()` 忽略 since/until——提交日志一律走 git 命令。
  - `Commit.parents` 可能是 `string[]` 或 `object[].hash`，必须做类型归一化（`typeof p === 'string' ? p : p.hash`）。
  - vscode.git 的 refs/HEAD 变更事件有延迟：需要权威数据时读 `.git/HEAD` 文件 + `for-each-ref` 校准，不要信事件到达时的 state 快照。

## 4. 缓存体系（性能的生命线）

- **分支/tag 映射走 `RefsReader`**：直接读 `.git/refs`（loose + packed-refs），5s TTL；ref 变更操作后必须 `invalidate()`。禁止为取分支列表 spawn `git branch`。
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
- **扩展→webview 首屏消息必须等 `ready` 握手**再投递（html 设置后立即 postMessage 会丢失）；等待期间缓冲，ready 时 flush。
- **内联 JS 在 TS 模板串里要双重转义**：`\n` 等序列会静默杀死整段内联脚本。
- **XSS 防线**：所有插入 HTML 的动态文本走统一的 `esc()`（webview.js 内集中实现），禁止字符串拼接原始数据。
- **tooltip 用 `data-title` + 自定义浮层**，不用原生 `title`（白色原生 tooltip 会与主题浮层重叠）；多行内容 CSS 需 `white-space: pre-wrap`；`contextmenu` 时调 `window._hideTooltip()` 避免与右键菜单叠层。
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
- **删除/重命名分支成功后不刷新**：乐观更新 + 失败回滚 + `pauseBranchCheck(5000)`；重命名成功后只做 `refreshBranchesOnly()` 权威刷新（防 vscode.git 延迟覆盖）；删除时若正在查看该分支的提交则切回当前分支。
- 重命名/删除后必须同步内部状态（`_branch`、`selectedBranch`），否则后续命令报 `unknown revision`。
- push 允许无 upstream 分支：`getUpstream` 包 try-catch；无 upstream 时用 `git log remote..local` 取待推送提交；推送对话框提交列表与箭头共用 `getBranchesWithDetails` 同一数据源，区分首次推送/已最新/有待推送三态，提交分页（首屏 20 条 + 加载更多）。
- `updateBranch`：远程存在同名分支时自动建立跟踪。
- **冲突处理（merge/rebase/cherry-pick）一律交 VSCode 原生 SCM 视图**，插件只提供继续/终止入口和顶部持久化状态栏；冲突检测合并 stderr+stdout，扫 `unmerged files`、cherry-pick failed 等关键词，`isConflictError` 入参必须是字符串。
- 分支刷新按钮只刷分支树，不动中间提交列表；拉取其他分支时不触发 `_reload()`。
- 外部分支变更检测：`fs.watch` `.git/HEAD` + 300ms 防抖，仅 webview 可见时启用，轮询（2s）作兜底；`pauseBranchCheck` 冷却语义保留。
- 日期筛选：`--since/--until` 与 vscode.git 均不认 ISO 8601 的 `T`，转换为空格分隔格式。
- 文本搜索不用 `--fixed-strings`（要模糊匹配）；hash 搜索回退必须传 `branch` 参数（避免 `--all` 带出全分支提交）。

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
