# GitCharm

**English** | [简体中文](#简体中文)

> Bring the IntelliJ IDEA Git UI and workflow to VSCode / Qoder.

![GitCharm three-panel git log UI](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/main-view.png)

GitCharm provides a three-panel Git log view:

- **Left · Branch tree** — hierarchical tree grouped by `HEAD / Favorites / Recent / Local / Remote`, plus a worktree section at the bottom, with ahead/behind arrows (▲▼) and commit-count badges
- **Center · Commit list** — Canvas-rendered commit graph showing message first line, author avatar and relative time, with message / author / path / date-range filters
- **Right · Commit details** — full commit info, changed file list (added/deleted line counts) and diff entry

## Screenshots

**Commit context menu (single)** — right-click a commit row for Show Diff / Cherry-Pick / Reset / New Branch, plus Amend message & Drop on HEAD

![Commit context menu](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/commit-context-menu.png)

**Commit context menu (multi-select)** — select several commits then right-click for batch Cherry-Pick / Drop / Squash

![Commit context menu multi-select](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/commit-context-menu-multi.png)

**Branch context menu** — right-click a branch node for Checkout / Rename / Delete / Merge / Rebase / Push / Pull

![Branch context menu](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/branch-context-menu.png)

**Push dialog** — review outgoing commits and their changed files before pushing: files on top, commit info below, both scrollable; switch flat / tree view in the header (force-push available when behind). All four dialogs (push, compare, reflog, file history) can be resized by dragging their edges, and the push / compare dialogs have draggable splitters between panes; sizes last for the current session only

![Push dialog](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/push-dialog.png)

**Editor context menu** — GitCharm actions available from the code editor right-click

![Editor context menu](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/editor-context-menu.png)

**Blame gutter** — click a line number to reveal the last commit that touched it, with a jump-to-commit link

![Blame gutter](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/editor-blame-commit-message.png)

**Conflict handling** — merge / rebase / cherry-pick conflicts surface in a persistent status bar with Continue / Abort

![Conflict handling](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/conflict-resolution.png)

## Features

### Git Operations

- **Branches**: create, checkout, rename, delete, merge into current, rebase onto, push (force push offered when behind the remote), pull, fetch, update (safe fast-forward for non-current branches)
- **Remotes**: add a remote, edit its URL, rename or delete it right from the push dialog; switching the target remote recomputes the commit preview, and pushes / pulls use the branch's actual tracking remote instead of a hard-coded `origin`
- **Protected branches**: force-pushing or deleting a branch that matches `idea-git.protectedBranches` (default `main` / `master`, `*` wildcards supported) asks for one more confirmation
- **Commits**: show diff, cherry-pick (multi-select batch + conflict-resumable), squash, drop commit, amend message, revert commit (single or several, newest first), reset to commit, copy the commit message, open the commit or a branch on the remote web page
- **Reflog**: one click for HEAD's reflog (the only place `checkout` and `reset` are recorded), or a branch row's own movements — a dialog where any row can be diffed, branched from or reset to, so work a `reset --hard` hid is recoverable
- **Tags**: create lightweight or annotated tags on a commit, delete local tags, push a tag to the remote; annotated tags now resolve through the tag object, so their badges show up on the right commit
- **Stashes**: a third section in the branch tree listing the stack, a toolbar button to stash the current changes (optionally including untracked files), and apply / pop / drop per row — changes made with `git stash` in a terminal are picked up automatically; click a stash to list its files (untracked included) in the right pane and preview any file's diff before applying
- **Worktrees**: every checkout of the repository is listed at the bottom of the branch tree — double-click one to open it in a new window, right-click to remove it, and check out any non-current local branch in a new worktree; removal is validated against git's registry and asks once more before force-deleting uncommitted changes
- **Files**: compare file with another branch, compare with the local working copy, pick a single file from a commit, jump to source at the commit's version (read-only), view every commit that touched a file (cross-branch), view diff introduced by a single commit
- **Blame**: inline annotation of last author & date per line, full commit info on hover, click to jump to the commit

### Performance

- **Instant open**: three-phase progressive loading (skeleton → branches → commits), startup < 10ms
- **Filesystem refs**: resolves the git directory (plain clones, linked worktrees, shared `commondir`) and parses its refs (loose + packed-refs) directly — hundreds of branches stay smooth, no flood of `git rev-parse` subprocesses
- **No built-in git extension needed**: GitCharm never activates or reads `vscode.git`; branch lists, the current branch and ahead/behind counts all come from our own refs reader and a single `for-each-ref`, so the panel works even with the built-in Git extension disabled
- **Smart cache**: branch info persisted to workspace state (Memento), instantly available after restart; a filesystem watch on the git directory drops stale caches when you commit, fetch or switch branches elsewhere
- **No idle subprocesses**: git availability is remembered across sessions, in-progress operations are detected by reading `.git` state files, and a re-shown panel replays its cached graph unless the displayed tip actually moved
- **Canvas graph**: pixel-precise commit graph rendered on Canvas with high-DPI support, several times faster than SVG/DOM

### Experience & Reliability

- **Bilingual UI**: fully localized interface, follows editor language or set manually
- **Session restore**: reopening the panel within a couple of hours brings back the last selected branch, commit and its file list
- **Keyboard navigation**: Tab moves between the branch tree, commit list and file pane; arrows walk rows, Home / End / PageUp / PageDown jump, Enter opens the diff, and Shift+arrows extend a commit range
- **Favorites & recent**: mark branches to pin them above the tree; a Recent group is built from git's own HEAD log, so checkouts made in a terminal or another Git UI show up too
- **Ahead/behind arrows**: shown for branches that differ from their remote twin, including those without a configured upstream
- **Two file list views**: changed files as a directory tree or as a flat full-path list, switchable in the detail panel and in the push / compare dialogs; the header (count + switch) stays pinned while scrolling in any direction
- **Theme-aware file icons**: changed files borrow the icons of the active file-icon theme — installed themes as well as the built-in one, font-based and SVG-based alike; folders use a matching two-tone glyph, and the checked-out branch gets a filled branch icon
- **Never squeezed out**: the graph column is capped and can be hidden entirely (persisted), so repositories with many branches still show full commit messages
- **Works without a repository**: the panel and the status bar entry are always present; a folder without `.git` gets a guided page that can run `git init` for you
- **IDEA-style visuals**: 6–12px radii, smooth transitions, hover micro-animations, yellow tag badges
- **Pre-rebase check**: detects uncommitted changes before rebasing to avoid failures
- **Unified conflict handling**: merge / rebase / cherry-pick conflicts are detected in one place, a persistent top status bar offers Continue / Abort, and the conflicted files are opened directly in the editor (up to 10 tabs) so the built-in merge-conflict code lenses can be used — the panel never switches you into another view
- **The panel follows real git state**: resolve the conflicts and commit in your own terminal and the operation bar retracts on its own once git's state files are gone, while the commit list reloads as soon as the displayed branch tip moves — keeping your selection, detail panel, folds and scroll position instead of jumping back to the top
- **Shell-free execution**: every git command runs via argv `spawn`, eliminating argument injection
- **Own credential prompts**: when a remote asks for a username, password or token, the extension shows its own input box (masked for secrets) instead of relying on the built-in Git extension — cancelling is reported as a clear outcome, with a hint to configure a credential helper or switch to SSH
- **Full error detail on demand**: the error notification stays short, while the complete git output (credentials redacted) goes to the GitCharm output channel, reachable from a Show Log button on the notification
- **Optional background fetch**: set `idea-git.autoFetchMinutes` and the panel fetches from the remote every N minutes while it is open, refreshing the branch tree and the ahead/behind arrows. Silent by design — no credential prompt, no error toast, and no subprocess at all when the repository has no remote
- **Several repositories in one workspace**: whether they come from several workspace folders or from a plain parent directory holding a dozen sibling projects, GitCharm discovers them all and puts a repository switcher above the branch tree (and `GitCharm: Switch Repository` in the command palette); the choice is remembered per workspace, and switching clears what belonged to the other repository instead of reusing branch names and hashes that only look valid

## Requirements

- **VSCode** ≥ 1.66.0, or **Qoder** latest
- **Git** ≥ 2.0.0
- No dependency on the built-in **vscode.git** extension — it may be disabled

## Installation

### From the Marketplace (recommended)

Search **GitCharm** in the extensions panel (full name *GitCharm — IDEA Git Log & Graph*, publisher `liugui`) and install.

### From a VSIX file

1. Download `git-charm-<version>.vsix`
2. Run **Extensions: Install from VSIX…** from the command palette
3. Pick the file and reload the window

## Usage

1. Open a workspace containing a Git repository — a folder without one still opens the panel and offers `git init`
2. Click the **GitCharm** tab in the bottom panel to reveal the three-panel log view
3. Tree nodes: single-click folders to expand, **double-click a branch to switch**; right-click a node or commit row for context actions

### Common Actions

| Action | Entry |
|--------|-------|
| Switch branch | Double-click branch in tree, or right-click → Checkout |
| View commit details | Click a commit row |
| Show commit diff | Right-click commit → Show Diff |
| Merge / Rebase | Right-click branch → Merge into Current / Rebase onto |
| Push / Pull | Right-click branch → Push / Pull |
| Cherry-pick | Multi-select commits → right-click → Cherry-Pick |
| Squash | Multi-select commits → right-click → Squash |
| Drop / Amend commit | Right-click commit row (only near HEAD) |
| Compare file with branch | Editor / Explorer right-click → GitCharm → Compare with Branch |
| Compare file with local copy | Commit detail (third panel) → double-click a file, or right-click → Compare with Local File |
| Pick a file from a commit | Commit detail (third panel) → right-click a file → Cherry-Pick File |
| View file history | Editor / Explorer right-click → GitCharm → View File History |
| Toggle blame | Editor right-click → Toggle Blame, or click the line-number area |

## Settings

Search `idea-git` in settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `idea-git.cache.enabled` | Cache branch info for faster startup (persisted; refreshed on repo changes or Git operations) | `true` |
| `idea-git.pullStrategy` | Update strategy when pulling: `merge` or `rebase` | `merge` |
| `idea-git.language` | UI language: `auto` / `zh-cn` / `en` | `auto` |
| `idea-git.debug` | Enable debug logging to the extension host console | `false` |
| `idea-git.autoFetchMinutes` | Fetch from the remote every N minutes while the panel is open (silent; `0` disables) | `0` |
| `idea-git.protectedBranches` | Branch patterns that get an extra confirmation before force-push or delete (`*` wildcards supported) | `["main", "master"]` |

## Development

```bash
npm install        # install dependencies (includes @vscode/vsce)
npm run compile    # compile TypeScript to out/
npm run lint       # ESLint
npm test           # node:test unit tests
npm run package    # build VSIX
```

Press **F5** in VSCode / Qoder to launch the Extension Development Host (config in `.vscode/launch.json`).

> Note: after changing `out/` or `media/`, fully restart the development host — it runs the previously loaded code.

## Tech Stack

TypeScript · VSCode Extension API · Git CLI · Webview (Canvas rendering)

## License

[MIT](LICENSE) · Full history in [CHANGELOG.md](CHANGELOG.md)

---

# 简体中文

> 在 VSCode / Qoder 中复刻 IntelliJ IDEA 的 Git UI 与工作流。

![GitCharm 三栏式提交图谱界面](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/main-view.png)

GitCharm 提供一个三栏式的 Git 日志面板：

- **左栏 · 分支树**：按 `HEAD / 收藏 / 最近 / 本地 / 远程` 分组的层级树，底部另列工作树，带超前/落后箭头（▲▼）与提交数徽标
- **中栏 · 提交列表**：Canvas 绘制的提交图谱，含消息首行、作者头像、相对时间，支持消息 / 提交人 / 路径 / 日期区间筛选
- **右栏 · 提交详情**：选中提交的完整信息、变更文件列表（增删行数）与差异入口

## 界面截图

**提交右键菜单（单选）**：提交行右键呼出 显示差异 / 精选提交 / 重置 / 新建分支，HEAD 附近另有 编辑提交信息 与 删除提交

![提交右键菜单](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/commit-context-menu.png)

**提交右键菜单（多选）**：多选提交后右键，批量 精选提交 / 删除提交 / 合并提交

![提交右键菜单多选](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/commit-context-menu-multi.png)

**分支右键菜单**：分支节点右键呼出 检出 / 重命名 / 删除 / 合并 / 变基 / 推送 / 拉取

![分支右键菜单](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/branch-context-menu.png)

**推送对话框**：推送前查看待推送提交及其变更文件——上为文件列表、下为提交信息，两块均可上下左右滚动，表头可切换平铺/目录结构（落后远程时可强制推送）。推送、对比、Reflog 与文件历史对话框都可以拖拽边框或内部分隔条调整大小，尺寸只在本次会话生效

![推送对话框](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/push-dialog.png)

**编辑器右键菜单**：代码编辑器右键可用的 GitCharm 操作

![编辑器右键菜单](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/editor-context-menu.png)

**行号 Blame**：点击行号查看该行的最后一次提交，并提供跳转到提交的链接

![行号 Blame](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/editor-blame-commit-message.png)

**冲突处理**：合并 / 变基 / 精选冲突统一在顶部持久状态栏提示，提供 继续 / 终止

![冲突处理](https://cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/conflict-resolution.png)

## 特性一览

### Git 操作

- **分支**：新建、检出、重命名、删除、合并到当前分支、变基到…、推送（落后远程时提供强制推送）、拉取、获取、更新（非当前分支可快进时安全更新）
- **远端**：在推送对话框里新增远端、修改地址、重命名或删除；切换目标远端会立即重算提交预览，推送与拉取都使用分支真正跟踪的远端，不再写死 `origin`
- **保护分支**：强制推送或删除命中 `idea-git.protectedBranches` 的分支（默认 `main` / `master`，支持 `*` 通配）时多一次确认
- **提交**：显示差异、精选提交（Cherry-Pick，支持多选批量 + 冲突持久化恢复）、压缩提交、删除提交、编辑提交信息、回退提交（可多选，按时间从新到旧逐个回退）、修补最近提交、重置到此提交、在远端网页打开该提交 / 该分支
- **Reflog（操作记录）**：工具栏一键看 `HEAD` 的操作记录（只有 `HEAD` 记录 `checkout` 与 `reset`，正是把工作"藏起来"的两个操作），分支行右键则看该分支自己的 movements；对话框里任意一行都能查看差异、新建分支或回退过去——被 `reset --hard` 藏掉的提交还能捞回来
- **标签**：在提交上新建轻量或附注标签、删除本地标签、推送标签到远端；附注标签会穿过 tag 对象解析到真正的提交，徽章不再贴错位置
- **贮藏（Stash）**：分支树第三分区列出贮藏栈，工具栏一键贮藏当前改动（可选择一并收走未跟踪文件），行上可应用 / 弹出 / 删除；在终端里 `git stash` 也会自动跟上；单击贮藏即可在第三栏列出其文件（含未跟踪文件），应用或弹出前先预览差异
- **工作树（Worktree）**：分支树底部列出同一仓库的所有检出，双击在新窗口打开、右键移除；非当前本地分支可一键检出到新工作树。移除前按 git 登记校验，工作树含未提交改动时需再次确认才强制删除
- **文件**：与其他分支对比此文件、与当前本地文件对比、从提交中挑选单个文件、按该提交的版本跳转到源（只读打开）、跨分支查看该文件的全部历史提交、查看单次提交引入的差异
- **Blame**：行内注解每行的最后修改者与日期，悬停查看完整提交信息，点击跳转到对应提交

### 性能

- **秒开**：三阶段渐进式加载（骨架屏 → 分支 → 提交），启动 < 10ms
- **直读 refs**：先定位 git 目录（普通克隆、linked worktree、共享 `commondir` 都能解析），再直接读 refs（loose + packed-refs），数百分支也不卡死，避免大量 `git rev-parse` 子进程
- **不依赖内置 git 扩展**：全程不激活、不读取 `vscode.git`；分支列表、当前分支、超前/落后全部来自自研 refs 读取器 + 单条 `for-each-ref`，禁用内置 Git 扩展也能正常用
- **智能缓存**：分支信息持久化到工作区状态（Memento），重启后立即可用；对 git 目录做文件监听，在别处提交 / 拉取 / 切分支时自动失效
- **空闲时不启子进程**：git 可用性跨会话记忆，进行中操作靠读 `.git` 状态文件判断，面板重新显示时只要展示的 tip 没动就直接复用缓存
- **Canvas 图谱**：提交图用 Canvas 像素级绘制，高 DPI 自适应，比 SVG/DOM 高效数倍

### 体验与可靠性

- **中英双语**：界面全量本地化，跟随编辑器语言或手动指定
- **会话恢复**：短时间内重新打开面板自动恢复上次所选分支、提交及其文件列表（2 小时窗口）
- **三栏键盘导航**：Tab 在分支树、提交列表与文件列表之间切换；方向键选行，Home / End / PageUp / PageDown 跳转，Enter 打开差异，Shift+方向键扩展提交范围
- **收藏与最近**：给分支打星即置顶到树上方；"最近"分组直接读 git 自己的 HEAD 日志，在终端或其他 Git 界面里切的分支也会出现
- **超前/落后箭头**：与远程同名分支有差异即显示，未配置 upstream 的分支同样计算
- **文件列表两种视图**：变更文件可按目录结构折叠浏览，也可平铺显示完整路径，第三栏与推送/对比对话框表头均可切换；表头（数量 + 切换按钮）在任意方向滚动时保持吸附
- **文件图标跟随主题**：变更文件直接使用当前文件图标主题的图标（已安装主题与内置主题通用，字体型与 SVG 型都支持），文件夹用配套的双色图标，当前分支则显示实心分支图标
- **不再挤压信息列**：提交图列宽封顶且可整体隐藏（持久化），分支再多的仓库也能看全提交信息
- **无仓库也能用**：面板与状态栏入口常驻，没有 `.git` 的文件夹会给出引导页，并可一键执行 `git init`
- **IDEA 风格视觉**：圆角 6–12px、平滑过渡、悬停微动效、tag 黄色徽章
- **变基前检查**：自动检测未提交更改，避免变基失败
- **冲突统一处理**：合并 / 变基 / 精选冲突统一检测，顶部常驻状态栏提供"继续 / 终止"，冲突文件直接在编辑器打开（上限 10 个 tab）用内置 merge-conflict 代码透镜解决，面板不会把用户切去其他视图
- **面板跟着真实 git 状态走**：在自己终端里解决冲突并提交，操作状态栏会在 git 状态文件清掉后自动收起；提交列表也在所选分支 tip 移动时自动重载，并保留当前选中项、第三栏详情、折叠状态与滚动位置，不再跳回顶部
- **无 shell 命令执行**：所有 git 命令走 argv `spawn`，杜绝参数注入
- **自有凭据输入**：远端要账号 / 密码 / 令牌时由扩展弹出输入框（机密项掩码、不写日志），不再依赖内置 Git 的凭据提示；取消会明确回报，并提示配置凭据助手或改用 SSH
- **完整错误随时可查**：错误通知保持简短，完整的 git 输出（凭据已脱敏）写入 GitCharm 输出通道，通知条上的"显示日志"按钮可直接打开
- **可选的后台定时 fetch**：设置 `idea-git.autoFetchMinutes` 后，面板打开期间每隔 N 分钟静默 fetch 一次，只更新分支树与超前/落后箭头。刻意保持安静：不弹凭据输入、不弹错误提示，仓库没有远端时一个子进程也不 spawn
- **一个工作区里有多个仓库**：不管它们来自多个工作区文件夹，还是一个普通父目录下并排的十几个工程，都会被一并发现，分支树上方出现仓库切换器（命令面板另有 `GitCharm: 切换仓库`），选择按工作区记忆；切换会清掉属于另一个仓库的状态，而不是拿"看着像真的"的同名分支与短哈希继续用。只有一个仓库时这个控件不出现

## 环境要求

- **VSCode** ≥ 1.66.0，或 **Qoder** 最新版
- **Git** ≥ 2.0.0
- 不依赖内置 **vscode.git** 扩展，禁用它也能正常使用

## 安装

### 方式一：扩展市场（推荐）

在 VSCode / Qoder 扩展面板搜索 **GitCharm**（完整名 *GitCharm — IDEA Git Log & Graph*，发布者 `liugui`）并安装。

### 方式二：VSIX 离线安装

1. 下载 `git-charm-<版本>.vsix`
2. 命令面板执行 **Extensions: Install from VSIX…**
3. 选择文件，重新加载窗口

## 使用方法

1. 打开一个 Git 仓库工作区——没有 `.git` 的文件夹同样能打开面板，并会提供一键 `git init` 引导
2. 在底部面板点击 **GitCharm** 标签，即可看到三栏日志视图
3. 树节点：文件夹单击展开、分支**双击切换**；右键节点或提交行呼出对应操作菜单

### 常用操作

| 操作 | 入口 |
|------|------|
| 切换分支 | 分支树双击分支，或右键 → 检出 |
| 查看提交详情 | 单击中栏提交行 |
| 查看提交差异 | 提交行右键 → 显示差异 |
| 合并 / 变基 | 分支右键 → 合并到当前分支 / 变基到… |
| 推送 / 拉取 | 分支右键 → 推送 / 拉取 |
| 精选提交 | 多选提交 → 右键 → 精选提交 |
| 压缩提交 | 多选提交 → 右键 → 压缩提交 |
| 删除 / 改提交信息 | 提交行右键（仅 HEAD 附近可用） |
| 与其他分支对比文件 | 编辑器 / 资源管理器右键 → GitCharm → 与其他分支对比此文件 |
| 与本地文件对比 | 第三栏变更文件双击，或右键 → 与当前本地文件对比 |
| 挑选提交中的单个文件 | 第三栏变更文件右键 → 挑选文件 |
| 查看文件所有历史提交 | 编辑器 / 资源管理器右键 → GitCharm → 查看文件所有历史提交 |
| 显示 Blame | 编辑器右键 → 显示提交信息，或点击行号区域 |

## 设置项

在设置中搜索 `idea-git` 可调整：

| 配置 | 说明 | 默认 |
|------|------|------|
| `idea-git.cache.enabled` | 启用分支信息缓存以提高启动速度（缓存持久保存，仅在仓库变化或执行 Git 操作时更新） | `true` |
| `idea-git.pullStrategy` | 拉取远程分支的更新策略：`merge`（合并式）或 `rebase`（变基式） | `merge` |
| `idea-git.language` | 界面显示语言：`auto` / `zh-cn` / `en` | `auto` |
| `idea-git.debug` | 启用调试日志（输出到扩展宿主控制台） | `false` |
| `idea-git.autoFetchMinutes` | 面板打开期间每隔 N 分钟静默 fetch 一次远端（`0` 表示关闭） | `0` |
| `idea-git.protectedBranches` | 强制推送或删除前需要二次确认的分支模式（支持 `*` 通配） | `["main", "master"]` |

## 开发

```bash
npm install        # 安装依赖（含 @vscode/vsce）
npm run compile    # TypeScript 编译到 out/
npm run lint       # ESLint 检查
npm test           # node:test 单元测试
npm run package    # 打包 VSIX
```

在 VSCode / Qoder 中按 **F5** 启动"扩展开发宿主"进行调试（配置见 `.vscode/launch.json`）。

> 提示：改动 `out/` 或 `media/` 后，开发宿主跑的是旧代码，需完全重启宿主再验证。

## 技术栈

TypeScript · VSCode Extension API · Git CLI · Webview（Canvas 渲染）

## 许可证

[MIT](LICENSE)

完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。
