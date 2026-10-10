# 更新日志

所有重要更改都将记录在此文件中。

## [0.0.5] - 2026-10-11

### 优化

- **彻底移除对内置 `vscode.git` 扩展的依赖**：分支列表、当前分支、upstream/ahead-behind、HEAD 哈希一律改由自有实现提供——refs（含 packed-refs）与 `HEAD` 直接读文件，track 信息用单条 `for-each-ref`，缓存失效改由 `fs.watch` git 目录驱动。`package.json` 不再声明 `extensionDependencies: ["vscode.git"]`，禁用内置 Git 扩展也能正常使用；面板首屏不再可能被内置扩展的仓库扫描（多子进程、大仓库秒级）拖慢
- **缓存失效改为事件驱动**：`GitService.watchRepositoryChanges()` 监听 `HEAD`/`index`/`packed-refs` 与 `refs` 目录（递归），250ms 防抖后丢弃易失缓存；订阅方按 token 归还 Disposable，最后一个释放时才真正关监听。外部终端里的 checkout/commit 不再需要等缓存过期或轮询
- **打包体积从 442KB 降到 156KB**：VSIX 内剔除 `resources/screenshots`（README 图片链接打包时会被 vsce 重写成 GitHub raw 绝对地址，市场不会请求包内副本）、`out/test`、`AGENTS.md`、`.tsbuildinfo`、`.eslintrc.json` 与上一版 `.vsix`；并删除冗余的 `onView` 激活事件（VS Code 会从 `contributes.views` 自动生成）
- **能读文件就不启子进程**：`hasAnyCommit` 先看 refs 上有没有指针（零提交仓库才回落 `rev-list`），`dropLastCommit` 的脏工作区检查复用同一次 `status --porcelain -z` 解析（不再额外 `status`），`getHeadHash` 直接由 `HEAD` + refs 得出哈希

### 修复

- **linked worktree 下 git 状态读不到**：worktree 的 `.git` 是 `gitdir:` 指针文件、refs 又共享在 `commondir` 指向的公共目录，旧代码拼 `repoPath/.git` 去读 `HEAD`、`MERGE_HEAD`、`rebase-merge`、`CHERRY_PICK_HEAD` 一律落空（冲突/变基状态栏不显示、分支与哈希退回子进程）。新增纯 fs 的 `resolveGitDir()` / `resolveCommonDir()`，所有状态文件读取统一走 worktree 感知路径
- **git log 的位置参数存在参数注入面**：无 shell 的 argv 执行下，旧代码靠静默剥离 `" \` $` 来"消毒"，既会篡改合法分支名又挡不住以 `-` 开头的输入被 git 当成选项（如 hash 搜索框填入 `--output=…`）。现在分支 rev 走 `assertRef`（新增拒绝前导 `-`，合法 ref 本就不允许）、hash 走 `assertHash`，`--grep/--author/--since/--until` 作为选项值原样传递

### 文档

- AGENTS.md 新增「禁止依赖 vscode.git」硬约束与数据替换对照表；README 中英特性清单同步（含"内置 Git 扩展可禁用"）
- 新增回归测试 `noVscodeGit.test.ts`：扫描 `src/**` 拦住重新引用内置 git API 的写法，并校验 `package.json` 不再有 `extensionDependencies`

## [0.0.4] - 2026-10-11

### 新增

- **变更文件图标跟随当前文件图标主题**：扩展侧定位 `workbench.iconTheme` 对应的主题（已安装的图标主题插件优先，内置 vs-seti 兜底），编译成精简图标包发给 webview，字体型主题（woff + `fontCharacter`）与 SVG/PNG 型主题统一处理，并按资源管理器的优先级匹配（精确文件名 → 最长后缀 → 默认文件图标）。其中关键一步是 vs-seti 这类主题把 `.ts`、`package.json` 等常见文件放在 `languageIds` 而不是 `fileExtensions`，直接用主题 JSON 会全部退化成默认图标——因此用内置扩展的 `contributes.languages` 把语言反推回扩展名/文件名再合并（显式规则始终优先）。切换主题或配色、以及本会话内新装主题都会即时重解析
- **无 Git 仓库时的一键 `git init`**：面板与状态栏入口常驻，没有 `.git` 的文件夹给出引导页（区分「找不到 git 可执行文件」「有 git 但当前文件夹不是仓库」「仓库还没有提交」三态），可直接初始化仓库并热重解析仓库路径，零提交时另给「打开 SCM 视图完成首次提交」的引导
- **提交图可整体隐藏**：图列宽度封顶 24 列，并提供隐藏开关（持久化到视图状态）——分支很多的仓库不再把提交信息挤出可视区

### 优化

- **当前分支图标特殊化**：分支树里当前分支（HEAD 区与本地目录下的同一条）改用节点实心的分支图标并跟随强调色，与其余空心描边分支一眼可分
- **文件夹图标重绘**：文件夹不参与主题匹配（内置主题根本没有 folder 规则），改为圆角双色 SVG，并区分展开/收起两种形态，与面板内描边式 chevron 保持同一视觉语言
- **第三栏文件列表表头双向吸附**：表头（文件数 + 平铺/目录切换按钮）在长路径横向滚动时也不再跑出可视区

### 修复

- **初始提交的文件列表恒为空**：`git diff-tree` 是对第一父提交做差，没有父提交的仓库首个提交自然一个文件都不显示（新建仓库提交完看到「0 个文件」）。两条 diff-tree 查询补上 `--root`
- **无仓库文件夹里面板图标不出现**：同 ID 同版本时已安装清单会抢占开发宿主的 `contributes`，`when: idea-git.hasGitRepo` 又把视图本身藏了起来——版本号递增绕开抢占，并补显式 `onView` 激活事件、去掉视图可见性条件
- **切换/新装文件图标主题可能让面板卡在加载态**：图标解析原先插在 ready 握手的数据消息之间，且每次都会重写 `webview.options`（`localResourceRoots` 变化会重建资源加载白名单），撞上时首屏数据投递失败、只剩骨架屏且只能重开窗口。现在图标解析挪到握手最后并用 `setTimeout` 让路，`options` 只在主题目录真的变化时才重写，整段包 `try/catch`——读不到主题只降级为内置图标并记日志

### 文档

- **README 中英特性清单与使用方法对齐 0.0.4**：补入文件图标跟随主题、无仓库引导与 `git init`、提交图隐藏、表头吸附

## [0.0.3] - 2026-10-09

### 新增

- **查看文件全部历史提交**：编辑器右键 GitCharm 父菜单与 `idea-git.viewFileHistory` 命令跨分支列出该文件的提交（首屏 20 条 + 加载更多），双击任一条即打开该文件在此提交的改动
- **第三栏文件右键操作**：提交详情的变更文件列表右键新增「与当前本地文件对比」「挑选文件（cherry-pick）」；文件对比由单击改为双击触发（文件夹仍单击展开）
- **会话状态持久化**：短时间内重新打开面板自动恢复上次所选分支、提交及其关联文件列表。快照带 `savedAt` + 2 小时 TTL（长期离开则全新开始），恢复命中提交时重新请求详情与文件列表并高亮，无需重复点击
- **文件列表平铺 / 目录树切换**：第三栏提交详情与推送、对比对话框的变更文件列表统一支持两种展示——按目录结构折叠浏览、平铺显示完整路径，表头右侧图标按钮切换；第三栏的选择随会话状态持久化（`PersistedViewState.fileViewMode`）。原先第三栏与多选详情各自内联的树构建代码合并为共享渲染器 `buildFileRows`

### 优化

- **推送 / 对比对话框重排**：提交行去掉 hash 列（hash 移入悬浮提示与下方信息卡）；悬停提交行显示完整信息（提交信息 + 作者 · 绝对与相对时间 + 完整 hash）；右侧改为「上=变更文件、下=提交信息」两块，各自支持横向与纵向滚动，选中提交时同步刷新；首次推送无提交时也渲染面板骨架与切换按钮
- **落后远程仍可强制推送**：`behind > 0` 不再被误判为「已是最新」，推送对话框照常展示待推送提交并提供强制推送
- **推送错误提示可读化**：non-fast-forward / permission denied / auth failed 等给出简短友好提示，不再甩出 git 原始长输出
- **编辑器右键整合为 GitCharm 父菜单**：与其他分支对比、查看文件历史收进同一子菜单；行号右键保持在原位
- **第二栏提交右键菜单精简**：移除「交互式变基」入口（`idea-git.interactiveRebase` 命令与底层实现保留，仅去掉菜单项）
- **文件历史查询去掉 N+1**：不再为每个提交 spawn 一次 `branch --contains`，改为单次 `git log` + 数量上限；查询与对比统一使用仓库相对路径（绝对路径作 pathspec 是隐患）

### 修复

- **未配置 upstream 的分支不再丢失超前/落后箭头**：箭头此前只读 `%(upstream:track)`，push 时没带 `-u`（无 upstream）但远程存在同名分支的本地分支永远不显示 ▲▼。现在这类分支回退用 `git rev-list --left-right --count` 对同名远程跟踪分支实算，且只对「远程有同名分支且首提交不同」的分支发起子进程（上限 50，其余走免子进程的 refs 比对）；不伪造 upstream，推送与 `updateBranch` 行为不变。同时 `invalidateVolatile()` 一并失效 `RefsReader`（AGENTS.md 规定的易失缓存范围本就含 refs），避免提交后哈希缓存导致箭头延迟出现
- **「查看文件所有历史提交」此前静默无响应**：扩展侧已发送 `showFileHistory` 消息，但 webview 端从未实现对应处理函数；本次补齐对话框（单列提交列表 + 双击开 diff，事件委托避免「加载更多」后重复注册导致开两个 diff）
- **Marketplace / 扩展详情页 README 截图不显示**：真正原因不是打包遗漏——市场页会把 README 里的相对路径图片改写成 `https://github.com/<owner>/<repo>/raw/HEAD/<path>`（取自 `package.json.repository.url`），仓库为 private 时匿名请求 404，市场网页与编辑器内扩展详情标签同时裂图。因此必须把 GitHub 仓库设为 public（撤销 `.vscodeignore` 对 `resources/screenshots/**` 的排除让截图随 VSIX 发布，本身是必要的，但并不能显示图片——先前把它当作根因是误判，已更正）。仓库公开后 8 张截图匿名访问均返回 200

### 文档

- **README 新增中英「界面截图 / Screenshots」图集**：提交右键菜单（单选 + 多选）、分支右键菜单、推送对话框、编辑器右键菜单、行号 Blame、冲突处理共 8 张，逐图配说明
- **截图压缩与重命名**：源图经 sharp 调色板量化 + 限宽 1000px，8 张合计约 755KB → 250KB（约 33%）且保持清晰；统一 ASCII 文件名放入 `resources/screenshots/`，顶部 hero 由 `main-view.png` 取代旧的 `git-log-view.png`
- **README 特性与操作表对齐 0.0.3 实际行为**：移除已下线的交互式变基菜单描述，补入会话恢复、文件历史、第三栏文件对比/挑选与强制推送
- **README 补入文件列表两种视图与对话框新布局**：中英特性清单与截图说明同步；`push-dialog.png` 截图仍是改造前的界面（含 hash 列），待重新截图替换
- **市场页「Report Issue」按钮指向明确**：`package.json` 补 `bugs.url` 指向 GitHub Issues，不再依赖市场从 `repository.url` 的回退推导（仓库转 public 前该按钮点了会 404）

## [0.0.2] - 2026-10-03

### 文档

- **README 彻底重写并中英双语**：英文在前便于 Marketplace 展示，中文完整对照；新增三栏界面截图（`resources/screenshots/git-log-view.png`）逐区说明
- **修正过时描述**：移除不存在的 `idea-git.cache.ttlMinutes` 配置与已废弃的工作区缓存文件路径（现用 workspaceState/Memento）；安装/搜索名对齐市场实际（*GitCharm — IDEA Git Log & Graph* / `liugui.git-charm`）；常用操作与设置项表按实际贡献点重写
- **打包瘦身**：`.vscodeignore` 排除 `resources/screenshots/**`，文档截图不进 VSIX

### 流程规范

- **AGENTS.md 新增合入红线**：任何合入 main 前必须递增版本号并更新 CHANGELOG；发布流程明确由用户在本地终端执行 `vsce publish`（agent shell 无 PAT）

## [0.0.1] - 2026-10-02

首个正式发布版本。GitCharm 在 VSCode / Qoder 中复刻 IntelliJ IDEA 的 Git UI 与工作流：三栏式 Git 日志面板、Canvas 提交图谱、完整分支与提交操作、Blame 注解、中英双语，并针对大仓库做了深度性能优化。

### 核心功能

- **三栏式 Git 日志面板**：左侧分支树 / 中间提交列表（含消息、作者、日期筛选）/ 右侧提交详情
- **分支管理**：新建、检出、重命名、删除、合并、变基、推送、拉取、获取、更新非当前分支（可快进时安全 `update-ref`）
- **提交操作**：查看差异、Cherry-Pick（含批量拣选 + 冲突持久化恢复）、交互式变基、压缩提交、删除提交、编辑提交信息、重置到指定提交
- **Blame 注解**：行内显示每行最后修改者与日期，悬停查看完整提交信息，点击跳转对应提交
- **文件对比**：右键文件与其他分支对比，或查看单次提交引入的差异
- **Tag 展示**：提交列表显示 IDEA 风格黄色 tag 徽章，自动识别常见命名模式

### 性能优化

- **秒开体验**：三阶段渐进式加载（骨架屏 → 分支 → 提交），启动 <10ms
- **文件系统直读 refs**：`RefsReader` 直接读 `.git/refs`（loose + packed-refs），5s TTL，数百分支不再卡死 UI，避免大量 `git rev-parse` 子进程
- **ahead/behind 单次批量**：`for-each-ref` 一次取全部分支 track 信息，3s TTL + in-flight 去重；divergence 箭头实时刷新
- **工作区持久化缓存**：分支信息存 `workspaceState`（Memento），重启后立即可用；带 `version` + schema 校验，坏数据自愈
- **内存管理**：面板隐藏时释放重缓存，保留提交索引 LRU，缩减缓存容量
- **Canvas 图谱**：提交图改用 Canvas API 像素级绘制，高 DPI 自适应，比 SVG/DOM 高效数倍

### 可靠性与安全

- **无 shell 命令执行**：所有 git 命令走 `GitCommandRunner` argv `spawn`，内置 `LC_ALL=C`、并发上限、超时、基础参数；杜绝参数注入
- **变基前检查**：自动检测工作区未提交更改，避免变基失败
- **冲突统一处理**：合并/变基/拣选冲突统一检测，顶部持久化状态栏提供"继续/终止"，冲突自动交原生 SCM 视图解决
- **乐观更新**：重命名/删除分支成功后不刷新，失败回滚，响应更快；操作后同步内部状态避免 `unknown revision`

### 国际化

- **中英双语**：所有面向用户字符串双语覆盖，`idea-git.language` 配置（auto/zh-cn/en）；扩展侧 `t()`、webview 侧 `T()`、贡献点 `%key%`；dictionary parity 单测强制 key 集一致
- **对话框稳定性**：按钮比较用稳定 `data-action` 键，与本地化文案解耦

### UI/UX（对标 IDEA）

- 圆角 6–12px、`cubic-bezier` 过渡、悬停微动效、入场动画
- 提交列表只显示消息首行，完整信息进结构化 tooltip
- 所有搜索框回车触发；日期选择器联动强制 end ≥ start
- 分支树文件夹单击展开、分支双击切换，内联 SVG chevron，叶子只显示末段路径
- 提交时间 <24h 相对时间、≥24h 完整日期，一律用作者时间

### 验证结果

- TypeScript 编译通过（0 error）
- ESLint 检查通过（0 error）
- 70 个单测全绿（含字典一致性校验）
