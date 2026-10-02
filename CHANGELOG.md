# 更新日志

所有重要更改都将记录在此文件中。

## [0.1.16] - 2026-09-30

### GitCharm 品牌更名

- **项目重命名**：从 "IDEA Git" 更名为 "GitCharm"，所有文档、日志前缀、UI 字符串同步更新
- **日志标识统一**：`[GitCharm]` 替代 `[IDEA Git]`，扩展状态栏显示 `$(repo) GitCharm`

### 冲突处理优化

- **移除自定义冲突对话框**：合并/变基操作不再显示自定义终止/取消按钮，改用 VSCode 原生 `showWarningMessage` + SCM 视图
- **移除交互式变基自动策略**：删除 ours/theirs 自动冲突解决选项，恢复逐提交变基流程（用户手动解决）
- **批量拣选冲突处理**：遇冲突时停止循环 → 打开 SCM 视图 → 显示清晰警告（含冲突哈希和剩余数量）

### 拣选恢复持久化

- **工作区缓存保存**：多提交拣选遇冲突时，将剩余哈希保存到 `workspaceState`（24h TTL 防死循环）
- **扩展重启后恢复**：重新打开 webview 时自动加载保存状态，验证 CHERRY_PICK_HEAD 存在性
- **按钮显示时机修正**：仅在 CHERRY_PICK_HEAD 消失后（冲突已解决）显示"继续挑拣"按钮
- **点击响应修复**：正确传递 remainingHashes 到扩展宿主，执行剩余提交拣选
- **切换分支清理**：selectBranch 时自动清除拣选恢复状态，避免跨分支污染

### 多提交拣选排序

- **时间升序执行**：批量拣选多个提交时，按 authorDate 升序排列（最早优先），确保依赖关系正确
- **Webview 多选支持**：Ctrl/Cmd+点击与 Shift 范围选择，右键菜单仅显示拣选/删除选项

### 技术改进

- **GitCommandRunner 统一**：所有 git 命令走 argv spawn（无 shell），LC_ALL=C 环境变量，并发上限 6
- **RefsReader 性能**：直接读 `.git/refs`（loose + packed-refs），5s TTL，避免数百分支卡死 UI
- **vscode.git API 边界**：热路径（push/compare）使用 API，冷路径走 fs refs + for-each-ref（activate 成本秒级）
- **持久化缓存校验**：version 字段 + schema 校验，加载失败自愈（丢弃坏数据/清洗引号污染）
- **Webview 消息类型化**：ExtToWebviewMessage/WebviewToExtMessage 判别联合，消除 as any
- **i18n 全量覆盖**：中英双语字典 ~175 key，dictionary parity 单测强制 key 集一致

### 验证结果

- TypeScript 编译通过（0 error）
- ESLint 检查通过（0 error）
- 70个单测全绿（含字典一致性校验）

## [0.1.15] - 2026-09-29

### 中英双语支持（i18n）

- **自定义 t() 方案**：新增 `src/i18n/index.ts` 纯模块，zh/en 平铺字典 ~175 key，支持 `{param}` 插值与回退链（active → zh → key）；不依赖 vscode import，可被单测直接 import
- **扩展宿主全量本地化**：所有命令提示、对话框、错误消息改走 `t()`；helpers.ts 冲突处理新增 `kind` 参数替代脆弱的中文匹配
- **webview 动态注入**：`window.I18N_STRINGS` + `T()` 助手，骨架/菜单/对话框/状态栏全量本地化；语言切换时 `relocalize()` 重建 html（视图状态自动恢复）
- **package.nls 贡献点**：package.json 命令标题/配置描述 `%key%` 化；新增 `package.nls.json`（en 默认）与 `package.nls.zh-cn.json`；新增 `idea-git.language` 配置项（auto/zh-cn/en）
- **对话框稳定性**：push/compare 对话框按钮用稳定 `data-action` 键（cancel/push/force/close），与本地化文案解耦；外部数据进 HTML 前统一 `esc()`
- **规范与测试**：AGENTS.md 新增「国际化硬性规定」章节；i18n 单测 13 例（resolveLocale/t 插值/回退/dictionary parity），70/70 全绿

### 构建产物清理

- **移除 .tsbuildinfo 版本控制**：纯 TypeScript 增量编译缓存，加入 `.gitignore`；每次 `npm run compile` 重新生成即可

## [0.1.14] - 2026-09-29

### 分支重命名修复

- **名字不再回退**：重命名本地分支（含当前分支）后，分支树不再短暂显示新名又回退为旧名。根因是 vscode.git 的 refs/HEAD 状态延迟，后台重载把陈旧列表推回界面
- **权威数据校准**：`_loadBranchDetails()` 用 `git for-each-ref refs/heads/` 校准本地分支名集合（丢弃已不存在的旧名、补上尚未同步的新名），保留 ahead/behind/upstream 数据
- **当前分支即时生效**：`getCurrentBranch()` 优先读 `.git/HEAD` 符号引用（`git branch -m` 同步更新），不再依赖延迟的 vscode.git `HEAD.name`
- **重命名后收敛**：成功后调用 `refreshBranchesOnly()` 从权威 git 数据刷新分支树，确保即使有在途陈旧消息也最终收敛到新名

### Git 命令参数引号修复

- **spawn 参数分词**：新增 `tokenizeCommand()` 按 shell 引号语义切分 argv，spawn 路径剥离字面引号；修复 `--format="..."` 导致分支名带 `"` 前缀的问题
- **连带修复**：`getUpstream` 返回带引号 upstream、divergence `trackMap` 键不匹配、含空格参数被错误拆分等潜在问题
- **污染缓存自愈**：持久化与内存分支缓存检测到带引号分支名时自动丢弃并重载，旧污染数据无需手动清理

### 分支树显示优化

- **子目录叶子简化**：文件夹内分支只显示最后一段路径（如 `316_feature/autopl_and_plx` 在目录下显示为 `autopl_and_plx`）；`data-branch` 与 tooltip 保留完整分支名，检出等操作仍用完整 ref
- **原生风格折叠箭头**：`>` / `v` ASCII 字符替换为内联 SVG chevron（`currentColor` 随主题变色），视觉对齐 VSCode 资源管理器，无字体依赖

### 图标更新

- **新扩展图标**：`resources/icon.png` 换为扁平 Git 分支符号（Git 橙圆角方块），512×512 超采样抗锯齿，体积 22KB（原 355KB）

## [0.1.13] - 2026-09-29

### 搜索与筛选修复

- **文本搜索修复**：提交消息搜索不再使用 `--fixed-strings`，支持关键词模糊匹配
- **Hash 搜索回退修复**：搜索回退路径正确传入 branch 参数，避免 `--all` 返回其他分支的多余提交
- **搜索结果数量准确**：修复搜索后提交列表显示多余提交的问题，结果数量通过 VSCode 原生提示展示
- **统一回车触发**：提交消息、作者、日期筛选均需按 Enter 触发搜索，符合 GitCharm 习惯
- **日期选择器联动**：选完开始日期自动聚焦结束日期，并强制结束日期不早于开始日期
- **日期格式兼容**：ISO 8601 的 `T` 分隔符自动转为空格格式，兼容 git `--since/--until` 参数

### 分支树与提交列表显示优化

- **divergence 箭头**：所有本地分支显示超前/落后箭头（▲▼），通过 `git for-each-ref` 批量获取，与 VSCode 原生格式一致
- **树形图标统一**：折叠图标统一为 `>` / `v` 字符，文件夹图标与缩进对齐 VSCode 资源管理器风格
- **作者时间显示**：提交时间使用作者时间（`%ai/%ar`）而非提交时间，与 GitCharm 一致
- **分支名称引号修复**：正确解析 `for-each-ref` 输出中带引号的分支名

### 拉取策略与冲突处理

- **拉取策略配置**：新增 `idea-git.pullStrategy` 设置，支持合并式（merge）和变基式（rebase）更新分支
- **更新非当前分支**：远程分支可直接快进时通过 `git update-ref` 安全更新本地分支；非快进时给出友好提示，不再报 `! [rejected] (non-fast-forward)` 原始错误
- **冲突统一检测**：合并、变基、拣选（cherry-pick）冲突统一检测，面板顶部显示黄色操作状态栏（合并进行中/变基进行中/拣选进行中），提供"继续/终止"按钮
- **首次进入即显示**：操作状态栏在首次打开面板时立即显示，不再需要切换页面后才出现
- **拣选终止修复**：cherry-pick 冲突终止时正确执行 `cherry-pick --abort`，不再误用 `merge --abort`
- **冲突后自动打开 SCM 视图**：拉取/合并/变基/拣选冲突时自动打开 VSCode 原生源代码管理视图解决冲突

### 技术改进

- `getInProgressOperation()` 通过 `.git` 文件系统标记（`rebase-merge`/`rebase-apply`/`CHERRY_PICK_HEAD`/`MERGE_HEAD`）检测进行中操作
- 操作状态栏按钮改为事件委托 + 固定 DOM 结构，消除按钮重复渲染问题
- webview 就绪（`ready` 消息）后再投递 `setInProgress`，避免首次加载时消息丢失

## [0.1.12] - 2026-09-28

### 交互优化

- **加载指示器**：分支操作（检出、创建、删除、重命名）和提交操作（删除、编辑消息）显示进度提示，使用 `vscode.window.withProgress` API
- **推送状态区分**：推送对话框支持三种状态——首次推送（远程无分支）、已是最新（无需推送）、有待推送提交（显示提交列表），通过 `isFirstPush` 参数控制文案
- **Tooltip 智能隐藏**：右键菜单出现时自动隐藏悬浮提示，避免与菜单重叠，通过全局代理 `window._hideTooltip` 实现
- **简洁确认对话框**：删除提交确认对话框仅显示标题和按钮，移除技术细节说明

### 性能与内存优化

- **缓存容量缩减**：`CACHE_MAX` 从 30 降至 20，`_commitIndex` 从 500 降至 200，预计节省 40-60MB
- **自动清理机制**：Git Graph 面板隐藏时自动清除易失性缓存，避免后台持续占用内存
- **TypeScript 编译优化**：启用增量编译（`incremental: true`），排除 `out/`、`media/` 目录监听，禁用声明文件生成
- **箭头实时刷新**：`_refreshDivergence()` 改用 `force=true` 强制获取最新分支详情，确保箭头始终反映当前 git 状态

### 分支操作优化

- **乐观更新策略**：重命名/删除分支成功后不刷新提交列表，失败才回滚 UI，响应更快
- **内部状态同步**：重命名/删除分支时同步更新 `_branch` 和 `state.selectedBranch`，避免 "unknown revision" 错误
- **删除分支智能切换**：若正在查看被删除分支的提交，自动切换到当前分支并重新加载提交
- **缓存完整清理**：删除/重命名分支后清除 refs 缓存、分支详情缓存和持久化缓存文件

### 技术改进

- 扩展 `showPushDialog()` 签名，新增 `isFirstPush` 参数区分推送状态
- 修改 `removeBranchOptimistically()` 异步获取当前分支并切换
- 在 `_loadBranchDetails()` 开头调用 `getCurrentBranch()` 实时获取当前分支，不依赖缓存
- `getBranchesWithDetails()` 即使命中缓存也用实时值覆盖 `current` 字段
- `CachedBranchData` 接口改为 `Omit<BranchDetails, 'current'>`，明确缓存不包含当前分支

## [0.1.11] - 2026-09-28

### 功能增强

- **Tag 标签展示**：在提交列表中显示 Git tag 标签，采用黄色徽章样式（类似 IDEA），支持轻量级 tag 和 annotated tag
- **智能 Tag 识别**：自动识别常见 tag 命名模式（v1.0.0、release-*、Version-* 等）
- **分支映射缓存**：为 `_readBranchRefs()` 和 `_readTagRefs()` 添加 5 秒 TTL 缓存，避免重复读取文件系统
- **缓存主动失效**：在创建/删除/重命名分支后自动失效 refs 缓存，确保数据一致性

### UI 体验升级

- **Tag 视觉区分**：tag 使用醒目的黄色背景 + 白色文字，悬停时加深并放大，带阴影效果
- **结构化 Tooltip**：提交消息悬浮提示采用分行布局，清晰展示作者、时间、本地分支、远程分支
- **Ref 类型标识**：自动区分 branch、remote、tag 三种 ref 类型，应用不同样式

### 性能优化

- **零开销刷新**：5 秒内多次刷新直接返回缓存，完全消除文件系统读取开销
- **事件驱动失效**：分支操作后立即失效缓存，下次加载时重新读取，平衡性能与准确性
- **并行读取优化**：同时读取 branches 和 tags，减少 I/O 次数

### 技术改进

- 新增 `_readTagRefs()` 方法读取 `.git/refs/tags/` 和 `packed-refs` 中的 tag 信息
- 新增 `_invalidateRefsCache()` 方法统一管理 refs 缓存失效
- 扩展 ref 解析逻辑，构建统一的 `hash -> [ref names]` 反向映射
- webview.js 新增 `isTagName()` 函数判断 tag 命名模式

## [0.1.10] - 2026-09-28

### 性能优化

- **文件系统读取分支映射**：直接从 `.git/refs` 和 `packed-refs` 文件读取分支指向的提交哈希，完全避免数百次 `git rev-parse` 子进程调用
- **秒开体验**：即使仓库有数百个分支，加载速度也从卡死状态提升到毫秒级响应
- **双向映射构建**：在 vscode.git API 和 git commands 两种路径中都应用相同的文件系统读取逻辑，确保一致性

### UI 体验升级

- **悬浮提示优化**：提交消息 tooltip 采用结构化布局，分行显示作者、时间、本地分支、远程分支
- **分支信息清晰**：本地分支和远程分支分开显示，远程分支自动去掉远端名前缀（如 origin/）
- **视觉层次分明**：使用标签标识（"作者:"、"时间:"、"本地分支:"、"远程分支:"），空行分隔不同信息块

### 技术改进

- 新增 `_readBranchRefs()` 方法递归读取 `.git/refs/heads/` 和 `.git/refs/remotes/` 目录
- 支持 packed-refs 文件格式解析，兼容 Git 的各种引用存储方式
- 构建 `hash -> [branchNames]` 反向映射，高效填充每个提交的 refs 数组

## [0.1.9] - 2026-09-28

### UI 体验升级

- **Canvas 图谱渲染**：Git 提交图从 SVG + HTML dot 混合布局改为纯 Canvas API 绘制，彻底消除圆点与连接线分离问题
- **像素级精确对齐**：线条和圆点在同一画布上渲染，坐标系完全一致，无亚像素错位
- **高 DPI 支持**：自动适配 Retina/4K 屏幕（devicePixelRatio 缩放），图谱清晰锐利无模糊
- **性能优化**：大量提交时图谱渲染更流畅，Canvas 比 SVG/DOM 高效数倍
- **视觉改进**：车道宽度从 10px 增加到 12px，HEAD 提交使用外圈描边 + 内圆填充效果

### 技术重构

- 新增 `drawGraphCanvas()` 函数，负责所有图谱绘制逻辑
- Canvas 绝对定位覆盖在 `.garea` 区域上方，保留 HTML 行结构的可交互性
- 移除 `.dot` CSS 类、SVG `<line>/<path>` 元素生成、`rowDot` 状态数组
- 代码减少约 60 行字符串拼接逻辑，可维护性提升

## [0.1.8] - 2026-09-28

### 安全与可靠性

- **变基前工作区检查**：`rebaseOnto` 和 `interactiveRebase` 命令执行前自动检测未提交更改，避免变基失败
- **新增 `isClean()` 方法**：优先使用 vscode.git API 检查工作区和暂存区状态，降级到 `git status --porcelain` 命令
- **友好错误提示**：工作区有未提交更改时显示清晰的中文提示，替代晦涩的 git 错误信息

### UI 体验优化

- **Blame 时间显示改进**：当天提交显示相对时间（"1分钟内"、"X 分钟前"、"X 小时前"），非当天仅显示日期（YYYY-MM-DD）
- **当前分支菜单精简**：移除不适用的操作（检出、合并、变基），保留适用操作（拉取、推送、新建分支、重命名）
- **搜索提示优化**：未找到提交时显示 12 位短哈希（原 7 位），提高辨识度和可读性

### Bug 修复

- **Blame 点击提交搜索失败**：vscode.git API 的 `search` 参数不支持 hash 匹配，改用 git 命令精确搜索
- **hash 搜索逻辑优化**：检测 hash-like 字符串时跳过 vscode.git API 路径，直接使用 `git log <hash>` 命令

### 技术改进

- `_loadGraphData` 增加 hash 检测逻辑，智能选择数据源
- 分支右键菜单根据分支类型（当前/其他本地/远程）动态生成不同操作项
- `fmtRelativeTimeFromEpoch` 重构为基于"同一天"判断而非"24 小时"判断

## [0.1.6] - 2026-09-24

### 性能优化

- **分支操作乐观更新**：新建、删除、重命名分支时先在 UI 上直接展示结果，后台异步执行 Git 命令，失败时自动回退
- **推送对话框分批加载**：提交列表从一次性渲染改为每次加载 20 条，通过"加载更多"按钮分批展示，避免大量 DOM 节点导致卡顿

### 用户体验

- **即时视觉反馈**：分支操作无需等待 Git 命令完成即可看到 UI 变化，响应速度提升 10 倍以上
- **流畅的推送体验**：即使有上百个待推送提交，对话框也能瞬间打开，用户可按需加载更多

### 技术改进

- 新增 `addBranchOptimistically()`、`removeBranchOptimistically()`、`renameBranchOptimistically()` 方法支持乐观更新
- webview.js 新增 `addBranchOptimistic`、`removeBranchOptimistic`、`renameBranchOptimistic` 消息处理器
- 推送对话框重构为分批渲染架构，支持动态插入新批次提交

## [0.1.5] - 2026-09-24

### 性能优化

- **三阶段渐进式加载**：实现骨架屏 → 分支 → 提交的渐进式加载流程，启动速度从 ~500ms 降到 <10ms，提升 50 倍
- **工作区持久化缓存**：将分支信息保存到文件，重启后立即可用，无需等待 Git 命令执行
- **智能编辑器检测**：多重检测策略（文件夹、appRoot、appName），自动识别 Qoder 或 VSCode
- **分支刷新隔离**：刷新分支树时不影响中间提交列表，保持用户查看位置
- **拉取分支智能刷新**：拉取当前显示分支时自动刷新提交列表，拉取其他分支时仅清除缓存

### 功能增强

- **推送对话框分页**：初始显示前 20 条待推送提交，通过"加载更多"按钮展示其余提交
- **变基/合并状态栏**：顶部显示进行中的操作，提供继续/终止按钮，操作完成后自动隐藏
- **缓存配置选项**：支持启用/禁用缓存（`idea-git.cache.enabled`）和设置有效期（`idea-git.cache.ttlMinutes`，1-60 分钟）
- **当前分支显示修复**：修复首次加载时当前分支不高亮的问题
- **格式化缓存 JSON**：缓存文件使用 2 空格缩进，方便人工查看和调试

### 用户体验

- **秒开体验**：无空白等待，始终有内容可看
- **缓存自动管理**：TTL 过期自动失效，Git 操作后自动清理
- **控制台调试日志**：输出编辑器检测结果、缓存加载状态等信息
- **双平台支持**：Qoder 使用 `.qoder/.idea-git-cache/`，VSCode 使用 `.vscode/.idea-git-cache/`

### 技术改进

- 新增 `_getSkeletonHtml()` 方法生成初始骨架屏
- 新增 `_loadAndDisplayBranches()` 异步加载分支
- 新增 `_loadAndDisplayCommits()` 异步加载提交
- 新增 `_isCacheEnabled()` 和 `_getCacheTTL()` 读取配置
- 新增 `_getCacheFilePath()` 智能选择缓存路径
- 新增 `setBranches`、`setInProgress`、`setHeadHash` 消息处理器
- LruCache 添加 `delete()` 方法支持删除指定缓存项

## [0.1.4] - 之前

- Git 仓库动态检测
- Blame 对齐修复
- Webview 拆分优化
- 单元测试覆盖

---

**版本格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。**
