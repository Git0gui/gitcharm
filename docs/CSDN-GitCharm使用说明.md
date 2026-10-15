# 把 IntelliJ IDEA 的 Git 界面搬进 VSCode：GitCharm 使用说明

> 一款在 VSCode / Qoder 里复刻 IDEA Git Log 三栏面板与操作工作流的扩展。发布者 `liugui`，扩展 ID `liugui.git-charm`，当前版本 0.0.7，MIT 协议。

> **关于本文的配图**：界面截图都是**真实界面 + 演示数据**——渲染用的是扩展自己的 `webview.css` / `webview.js` 和仓库里真实的提交哈希、提交消息、文件增删行数，只有数据是预先准备好的样例（否则每发一版界面变了，截图就得全部重拍一遍）。所以图中的分支名、提交信息你可以当作示例读，交互和菜单项与真实扩展一致。编辑器内 Blame 属于编辑器装饰、不在这个面板里，无法这样重画，那部分只有文字描述。

---

## 一、为什么做这个插件

用惯了 IntelliJ IDEA 的人回到 VSCode 看 Git 历史，普遍会有个落差：

IDEA 的 Git log 是**三栏**的——左边分支树、中间提交图谱、右边这次提交改了哪些文件。想干什么都在这一屏里完成：右键一个分支能变基、右键几个提交能压缩、双击文件直接进对比。

VSCode 的情况是：源代码管理面板只看得到"未提交的改动"，要看历史得装 Git Graph / GitLens，而它们的交互逻辑和 IDEA 完全不是一套路子——分支操作藏在不同的面板，多选提交做不了 squash，推送前看不到待推送的提交列表。

GitCharm 的目标很单纯：**把 IDEA 那套三栏 Git 面板和操作习惯原样搬过来**，而不是再做一个 commit 图谱查看器。

---

## 二、界面长什么样

面板打开后是三栏布局（底部面板的 GitCharm 标签）：

![三栏主界面](preview/out/main.png)

*示意图（真实界面 + 演示数据）*

- **左栏 · 分支树**：按 `HEAD / 本地 / 远程` 分组的层级树，分支名后面带超前/落后箭头（▲▼）和提交数徽标；下面还有贮藏（stash）分区。
- **中栏 · 提交列表**：Canvas 绘制的提交图谱，每行是提交信息首行 + 作者 + 相对时间（24 小时内显示"3 分钟前"这种，超过则显示完整时间）。顶部工具栏是筛选区：消息、作者、路径、日期区间。
- **右栏 · 提交详情**：选中提交的完整信息（作者/提交者/时间/hash/所属分支与标签）+ 变更文件列表（每个文件的增删行数）+ 双击进差异对比。

几个高频界面长这样：

**提交行右键菜单（单选）** — 显示差异、精选、压缩、删除、改提交信息、回退、重置，以及"在远端网页打开此提交"：

![提交行右键菜单（单选）](preview/out/commitMenu.png)

*示意图（真实界面 + 演示数据）*

**提交行右键菜单（多选）** — Ctrl/Shift 点几个之后，精选/删除/压缩变成批量操作，右栏文件列表合并成净结果：

![提交行右键菜单（多选）](preview/out/commitMenuMulti.png)

*示意图（真实界面 + 演示数据）*

**分支节点右键菜单**：

![分支节点右键菜单](preview/out/branchMenu.png)

*示意图（真实界面 + 演示数据）*

**推送对话框** — 推之前看得见要推的提交和文件清单，落后远程时才会出现强制推送按钮：

![推送对话框](preview/out/pushDialog.png)

*示意图（真实界面 + 演示数据）*

**冲突处理顶部状态栏** — merge / rebase / cherry-pick 进行中时钉在面板顶部，给出"继续 / 终止"入口：

![冲突处理状态栏](preview/out/conflict.png)

*示意图（真实界面 + 演示数据）*

---

## 三、能做什么

### 分支

新建、检出、重命名、删除、合并到当前分支、变基到…、推送（落后远程时给强制推送）、拉取、获取、更新。

两个细节是照着 IDEA 的习惯来的：

- 树里**双击分支就切换**，文件夹单击展开；
- 删除/重命名分支后**不刷新界面**——先乐观更新，失败了再回滚。因为刷新一次要把三栏数据全重取，为了一个分支名变化让人等半秒不值得。

### 提交

显示差异、精选提交（Cherry-Pick）、压缩提交（Squash）、删除提交（Drop）、编辑提交信息（Amend）、回退提交（Revert）、重置到此提交（Reset）、复制提交消息、在远端网页打开这个提交/这个分支。

**多选**是重点：Ctrl/Shift 点几个提交之后，右键的精选/删除/压缩都变成批量操作，第三栏的文件列表也会**跨这组提交合并**成一个净结果。

这里踩过一个值得说的坑：**一组提交谁先谁后，不能按作者时间判**。cherry-pick / rebase / amend 会保留原作者时间，落地顺序却是反的。实测过一个仓库里 `cfccce3`（作者时间 13:39）其实是 `5f8c82d`（作者时间 14:48）的**子**提交。按作者时间排序，"最早的父"和"最晚的"会算到同一个提交头上，差异框恒空，看着就像界面坏了；更麻烦的是压缩提交取 rebase 起点也会取错端点——那是在改历史。现在统一走 `git rev-list --no-walk --topo-order` 让 git 自己排。

多选后双击文件 = 跨这组提交的双栏对比：左边取**最早**提交的父版本，右边取**最晚**提交的版本，组里每个提交的改动都落在同一份 diff 里。

### Reflog：误操作急救

工具栏一个按钮看 `HEAD` 的操作记录，分支行右键看该分支自己的 movements。

为什么单独强调这个：`checkout` 和 `reset` 只在 `HEAD` 的 reflog 里留痕，而这正是把工作"藏起来"的两个操作。一次 `reset --hard` 之后，被藏掉的提交在这个对话框里每一行都能查看差异、新建分支留住它、或者直接回退过去。

![Reflog 对话框](preview/out/reflog.png)

*示意图（真实界面 + 演示数据）*

### 标签 / 贮藏

- 标签：轻量或附注，删除本地，推送到远端。附注标签的 `refs/tags` 里存的是 tag 对象哈希而不是提交哈希，所以得穿过 tag 对象才能把徽章贴在对的提交上。
- 贮藏：分支树第三个分区列出整个栈，工具栏一键贮藏，行上可应用/弹出/删除。在终端里 `git stash` 也会自动跟上。

### 文件

与其他分支对比此文件、与当前本地文件对比、从提交里只挑一个文件、跨分支看这个文件的全部历史提交、看单次提交引入的差异。

### Blame

编辑器右键开启，行内注解每行的最后修改者与日期，悬停看完整提交信息，点击跳到那个提交。

（这一段没有配图：Blame 注解是编辑器里的行装饰，不在扩展自己的 webview 里，没法按上面那种方式重画。）

---

## 四、几个"只有真用过才知道"的设计

这部分是我觉得比功能列表更值得写的东西。

### 面板跟着真实 git 状态走

很多人习惯在终端里操作 git，界面就该跟上，而不是让人去点刷新：

- 在终端解决完冲突并提交，面板顶部那条"继续/终止"状态栏会**自己收起**。判据是 git 的状态文件（`MERGE_HEAD`、`CHERRY_PICK_HEAD`、`rebase-merge` 等）被清掉——只 `git add` 完还没 commit 时 `MERGE_HEAD` 还在，状态栏就必须留着，因为 merge 确实没结束。
- 在终端提交一次，中间的提交列表**自动重载**，并且保留你当前选中的提交、右栏详情、折叠状态和滚动位置。不带这个保留的话，用户每提交一次界面就跳回顶部、详情被清空。

实现上这些都是 `fs.watch` git 目录 + 2 秒轮询兜底，**全部是文件读取，不 spawn 子进程**。为什么还要留轮询：git 用 `HEAD.lock` + rename 覆写 `HEAD`，Windows 上文件级监听还能收到事件，但 macOS/Linux 的 inotify 绑的是 inode，rename 覆盖之后就变成一个从此静默无事件的孤儿监听——它不会报错，只是再也不通知你。

### 不依赖内置 Git 扩展

这是架构上最大的一次改动。早期版本是调 `vscode.git` 的 API 拿分支和提交历史的，后来全部拆掉了，原因有三条：

1. 激活内置扩展会触发一次多子进程的仓库扫描，大仓库秒级；
2. 它的 refs/HEAD 缓存滞后于真实变更；
3. `repo.log(branch)` 会忽略传进去的分支参数，`Commit.parents` 类型还不稳定。

现在分支列表和 `HEAD` 是**直接读 git 目录下的 refs 文件**（loose + packed-refs），超前/落后是单条 `git for-each-ref`。数百分支的仓库也不会卡。仓库位置统一由 `resolveGitDir()` 定位，因为 linked worktree 的 `.git` 是个 `gitdir:` 指针文件，refs 还在 `commondir` 指向的公共目录，直接拼 `.git/refs` 会读空。

代价是要自己处理凭据：远端要账号密码时，扩展自己挂 `GIT_ASKPASS` 弹输入框（机密项掩码），不再借内置 Git 的提示。

### 失败提示要能行动

原来 git 报错是直接 `String(error)` 甩出去，效果是：

```
Error: Error: fatal: unable to access ...
```

两遍 `Error:` 是因为命令执行器把同一句 stderr 同时写进了 `message` 和 `stderr`。现在统一走一个格式化函数，剥掉包装、去重、限制 4 行 400 字。

更值钱的是网络类失败会补一句**可以直接抄走执行的命令**。举个实测的例子：

> 我浏览器明明能上 GitHub，为什么插件推送连不上？

因为 git 不读注册表里的系统代理。这台机器的真实形状是：注册表 `ProxyEnable=0x1`、`ProxyServer=127.0.0.1:7890`，环境变量里一个 proxy 都没有，git 也没配 `http.proxy`——浏览器读注册表所以能上，git 直连 443 超时 21 秒。同一条 `git ls-remote` 加上 `-c http.proxy=http://127.0.0.1:7890` 不到 1 秒返回。

所以现在没配 `git config http.proxy` 时，会再去读一次 Windows 系统代理（`reg query`，argv 无 shell，非 Windows 直接返回 undefined，只在失败路径跑一次），读到就把**具体地址**写进提示，那一行复制下来就能执行。

顺带说清楚一件事：**为什么不干脆像浏览器那样自动用系统的网**？这条边界不在插件。核对过内置 Git 扩展上游源码，`git.ts`/`main.ts`/`askpass.ts` 里 `proxy` 出现 **0 次**——它同样是 spawn git，只有 VS Code 自己的流量（走 Electron/Chromium）才吃系统代理。所以"浏览器能上、面板连不上"是 git 的边界，不是实现差异。能做的是把这件事说清楚，而不是替 git 假装它读得懂注册表。

### 一步改动变空时，给用户三选一而不是 git 的建议文本

解决冲突时如果保留了对面已有的内容，这一步的补丁就成了空的，git 会停下打印一整段 advice：

```
The previous cherry-pick is now empty, possibly due to conflict resolution.
If you wish to commit it anyway, use:
    git commit --allow-empty
Otherwise, please use 'git rebase --skip'
```

那三行恰恰就是用户能做的三个选择，只是没人替他按。现在会认出这种停止，弹"跳过这个提交 / 保留这个空提交 / 终止"。

接入点必须排在**冲突判定之前**——那段 advice 里含 `Could not apply`，先判冲突会把用户赶去解决一批根本不存在的冲突。

### 一个工作区里多个仓库

一个普通父目录下并排十几个独立仓库，是很常见的工程组织方式。内置 Git 能列全，早期版本只显示它顺手发现的那一个。

现在分支树上方有个仓库切换器（命令面板另有 `GitCharm: Switch Repository`）。仓库发现是"向上 + 向下"两条路：向上探测解决"当前文件夹在仓库里面"，向下扫描解决"父目录本身不是仓库"。向下扫必须带护栏——命中仓库就不再往里 list、跳过点目录和依赖/构建树、深度与目录数有上限，实测十几个仓库 5ms。

![多仓库切换器](preview/out/multiRepo.png)

*示意图（真实界面 + 演示数据）*

切换仓库会清掉属于另一个仓库的状态。因为 git 允许不同项目有重名分支和相同的短哈希，"看着像真的"的旧值带进新仓库会读成真实数据。但**文本过滤器会保留**——那是用户输入而不是仓库状态，清掉只会让输入框和实际过滤条件不一致。

---

## 五、性能

- **秒开**：三阶段渐进加载（骨架屏 → 分支 → 提交），启动 < 10ms。
- **直读 refs**：不 spawn 子进程取分支列表。
- **智能缓存**：分支信息持久化到工作区状态（Memento），重启立即可用；对 git 目录做文件监听，在别处提交/拉取/切分支时自动失效。持久化结构带 `version` 字段 + schema 校验，读到坏数据自愈而不是崩。
- **Canvas 图谱**：提交图用 Canvas 像素级绘制，高 DPI 自适应，比 SVG/DOM 高效数倍。
- **打包体积**：VSIX 从 442KB 降到 156KB（剔除 README 截图、测试代码、文档等不参与运行的文件）。

---

## 六、安装与使用

### 环境要求

- VSCode ≥ 1.66.0，或 Qoder 最新版
- Git ≥ 2.0.0
- **不需要**内置 `vscode.git` 扩展，禁用它也能正常用

### 安装

**方式一（推荐）**：扩展面板搜索 `GitCharm`（完整名 *GitCharm — IDEA Git Log & Graph*，发布者 `liugui`）。

**方式二**：下载 `git-charm-<版本>.vsix` → 命令面板执行 `Extensions: Install from VSIX…` → 选文件、重载窗口。

### 上手

1. 打开一个 Git 仓库工作区。没有 `.git` 的文件夹同样能打开面板，会给引导页并可一键 `git init`。
2. 点底部面板的 **GitCharm** 标签。
3. 文件夹单击展开，分支**双击切换**，右键节点/提交行呼出操作菜单。

### 常用操作对照

| 想做什么 | 入口 |
|---|---|
| 切换分支 | 分支树双击，或右键 → 检出 |
| 查看提交详情 | 单击中栏提交行 |
| 查看提交差异 | 提交行右键 → 显示差异 |
| 合并 / 变基 | 分支右键 → 合并到当前分支 / 变基到… |
| 推送 / 拉取 | 分支右键 → 推送 / 拉取 |
| 精选提交 | 多选提交 → 右键 → 精选提交 |
| 压缩提交 | 多选提交 → 右键 → 压缩提交 |
| 删除 / 改提交信息 | 提交行右键（仅 HEAD 附近可用） |
| 与其他分支对比文件 | 编辑器 / 资源管理器右键 → GitCharm → 与其他分支对比此文件 |
| 与本地文件对比 | 右栏变更文件双击，或右键 → 与当前本地文件对比 |
| 挑选提交中的单个文件 | 右栏变更文件右键 → 挑选文件 |
| 查看文件所有历史提交 | 编辑器 / 资源管理器右键 → GitCharm → 查看文件所有历史提交 |
| 显示 Blame | 编辑器右键 → 显示提交信息，或点击行号区域 |
| 误操作急救 | 工具栏 Reflog 按钮（HEAD）/ 分支行右键（该分支） |

### 设置项

设置里搜 `idea-git`：

| 配置 | 说明 | 默认 |
|---|---|---|
| `idea-git.cache.enabled` | 缓存分支信息以加快启动（持久保存，仓库变化或执行 Git 操作时更新） | `true` |
| `idea-git.pullStrategy` | 拉取策略：`merge` 或 `rebase` | `merge` |
| `idea-git.language` | 界面语言：`auto` / `zh-cn` / `en` | `auto` |
| `idea-git.autoFetchMinutes` | 面板打开期间每 N 分钟静默 fetch 一次远端，只更新分支树与箭头；不弹凭据框、不弹错误，仓库没远端时一个子进程都不启（`0` 关闭） | `0` |
| `idea-git.debug` | 调试日志（输出到扩展宿主控制台） | `false` |

---

## 七、自己跑一遍 / 参与开发

```bash
npm install        # 装依赖（含 @vscode/vsce）
npm run compile    # TypeScript 编译到 out/
npm run lint       # ESLint，要求 0 error
npm test           # node:test 单元测试
npm run package    # 打包 VSIX
```

在 VSCode / Qoder 里按 **F5** 启动"扩展开发宿主"调试（配置见 `.vscode/launch.json`）。

> 一个坑先替你踩了：改完 `out/` 或 `media/` 后，开发宿主跑的仍是旧代码，必须**完全重启宿主**再验证，必要时递增版本号让缓存失效。

### 目录结构

```
src/
  extension.ts        激活入口：组装依赖、注册命令与视图
  commands/           命令层，按域拆分（branch / commit / operation）
  services/           服务层：gitRunner / gitService / refsReader /
                      persistedBranchCache / blameProvider / logger
  views/              graphView.ts（WebviewViewProvider）+ messages.ts（消息协议）
  test/               node:test 单测
media/                webview 前端（webview.js / graph.css / codicons）
```

依赖方向是 `commands → services ← views`，服务层不反向依赖命令层。

### 两条写代码前必须知道的规矩

**所有 git 命令必须走 `GitCommandRunner`**：argv 数组直接 `spawn`，**没有 shell**。早期版本有个 `execAsync` 回退分支，已经彻底删除，不允许加回来。参数不写字面引号（无 shell，引号会进入参数值——真实踩过分支名带引号导致解析失败）；提交消息类内容走 `-F` 文件或 stdin，不拼进命令行；路径过滤一律追加在 `--` 之后，有它兜底，前导 `-` 就不可能被 git 当成选项。

**能被单测 import 的模块禁止 `import vscode`**：测试是纯 node 跑的，没有 vscode 的 stub。所以连日志模块包的也是 `console` 而不是 `OutputChannel`。

### 本文的截图是怎么来的

界面截图不用开 IDE、也不用手动摆数据，仓库里有一条可复现的链路（`docs/preview/`）：

```bash
node docs/preview/build-preview.mjs          # 从 graphView.ts 的模板抽出真实 DOM 骨架，注入演示数据
node docs/preview/shot.mjs main branchMenu   # 无头 Chrome 截图；能解析到 sharp 就顺手量化压缩
```

关键是这套预览**加载的是扩展自己的 `media/webview.css` 和 `media/webview.js`**，只把 `acquireVsCodeApi()` 换成一个 shim，按 `src/views/messages.ts` 里的真实协议把演示数据喂进去（`setRepoState` / `setData` / `setDivergence` / `setDetail` / `showPushDialog` / `showReflog`）。菜单、对话框、多选高亮都是派发真实 `MouseEvent` 走真实代码路径弹出来的，不是画出来的假界面——所以界面改版后截图会跟着变，改一行演示数据就能重出一批。

两个已知缺口：文件图标没有注入图标包，走的是兜底样式；没有 IDE 外壳（活动栏、标签页）。还有一个坑值得记：无头截图会把 CSS 入场动画冻在第 0 帧，而面板的动画从 `opacity: 0` 起步，整页会拍成半透明——预览主题里全局关掉 animation/transition 才正常。

---

## 八、技术栈

TypeScript · VSCode Extension API · Git CLI · Webview（Canvas 渲染）

许可证：MIT。完整版本历史见仓库 `CHANGELOG.md`。

---

## 结语

这个插件最有价值的部分其实不是"复刻了 IDEA 界面"，而是**把 IDEA 里那些理所当然的交互补齐**：多选提交能压缩、推送前看得见要推什么、在终端里操作完界面会自己跟上、git 报错时给的那句话是能直接执行的。

如果你也是从 IDEA 切到 VSCode、每次看 Git 历史都要叹一口气的人，可以装上试试。有建议或者报 bug，欢迎在 CSDN 评论区或者 GitHub 上提。
