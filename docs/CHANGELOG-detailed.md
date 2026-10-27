# 更新日志（详细版）

面向维护者：保留踩坑细节、实测数据与文件路径。随 VSIX 发布、市场页展示的简明版是 `CHANGELOG.md`；本文件位于 `docs/`，不进 VSIX。

## [0.1.7] - 2026-10-27

本版只做一件事：把"压缩提交"从"整段并块 + amend HEAD"改成"按相邻段就地折叠"。用户报的现象是压缩早期提交会覆盖到 HEAD 的记录，实测下来这条链上有三个独立缺陷（消息落点、未选提交被挪位、todo 少写一行等于删提交），外加共用排序原语的一处隐性失效，全部有验收用例钉住。

### 修复

- **压缩提交不得改动没选中的提交**（新增 `src/services/squash.ts`，服务层入口换成 `GitService.planSquash()` / `squashGroups()`，命令层 `src/commands/commitCommands.ts` 的 `idea-git.squashCommits`）。旧算法两步都错：① 把选中项从原位置摘出来拼成一个连续块（`others.splice(insertAt, 0, ...squashed)`），中间那些**没被选中**的提交被推到折叠结果之后——实测 4 行的 todo 跑 6 条提交的范围，留下 4 条且 git 不给任何警告；② 编辑好的消息用 `getHeadHash()` + `amendMessage()` 按在 **HEAD** 上，于是压缩 `y`、`z` 改的是最新那条提交的记录，这就是用户看到的"覆盖所有提交到 HEAD"。跨未选提交时更糟：被挪位的提交内容撞上冲突，仓库停在半路的 rebase 里。
- **新做法**：`planSquashGroups()` 先把选中项按历史顺序排好（`orderHistoryOldestFirst()`），切成"紧挨着的一段一段"（`splitContiguousGroups()` + `foldableGroups()`，长度为 1 的段不成组），每段一次 `rebase -i`：`buildGroupTodo()` 把这一段写成 `pick` + `squash`…，**其余一律留在原位继续 `pick`**（包括段之上到 HEAD 的全部尾巴——todo 不列就是删提交）。段从**新到旧**执行，因为一次 pass 会重写它之后的所有提交，先跑旧的段才能让还没跑的段的哈希继续有效；每段执行前重新读一遍范围（尾巴可能是上一次 pass 刚造出来的新哈希）。选中段起点是根提交时用 `rebase -i --root`（`parentOf()` 返回 null，`x~1` 是 fatal）。
- **每段一条消息**：`GIT_EDITOR="cp <该段的消息文件>"` —— 一次 pass 里只有那条 `squash` 会打开消息编辑器（纯 `pick` 复用提交自己的消息），所以"一个文件对一段"是成立的，不需要 `exec`（等于往 shell 里塞第二条命令面）也不需要 `edit` 停下再改（一个提交不能在 todo 里出现两次，停下时 HEAD 是**新哈希**，按 sha 对不回原来的段）。命令层**先把所有段的消息问齐再动历史**，中途取消等于没做过。编辑器路径一律走新增的 `shSingleQuote()`（`src/services/gitUtils.ts`）：git 是通过它自带的 sh 启动编辑器的，而本机 `os.tmpdir()` 是 `C:\Users\刘归\AppData\Local\Temp`——单引号让 `$`、反引号、反斜杠全部变成普通字符，POSIX 的 `'` 用 `'\''` 收尾再重开。
- **压缩消息对话框去掉 60s 墙钟超时**（`GraphViewProvider.showSquashMessageDialog`）。逐段提问之后，旧的回退会变成"用户写到第 61 秒，输入被静默丢掉、操作停在半路"；改成与推送对话框同一套生命周期结算（答案到达／面板隐藏／webview dispose）。
- **多选提交的早晚不看点击顺序**（`GitService.orderCommitsByHistory()` 现在委托 `orderHistoryOldestFirst()`，仍按文档返回新→旧，7 个调用点契约不变）。它原先依赖 `git rev-list --no-walk --topo-order`，而 `--no-walk` 把"要排的 walk"取消了，git 基本按传入顺序返回——实测线性历史上喂 `b z a y` 得 `b z a y`，喂 7 条得 `b c x y z w a`。也就是说 7 个调用点拿到的是点击顺序，压缩起点、回退顺序、多选差异的左右端点都可能取反。真走一遍 walk（`rev-list --topo-order -n K <roots>`，窗口 200 → 2000 → 不限）再按 wanted 集合筛，才是历史顺序；起点用选中提交本身而不是 HEAD，面板正在看别的分支时同样成立。

### 新增

- **验收测试套件** `src/test/squashAcceptance.test.ts`（node:test + 真实临时仓库，直接跑 `runGit`，无 vscode）。 golden 用例覆盖用户给的两个示例（`x y z w a b c` 里压 `y+z` 得 `x (y+z) w a b c`；跨未选 `w` 压 `y z a b` 得 `x (y+z) w (a+b) c`）、选中到 HEAD、从根提交开始、全选七条、倒着点四个、每段各自的消息（不给消息的段用 git 合并出来的消息）、三条拒绝路径（不相邻／少于两个／不在当前分支历史里），每条都额外断言"历史没被动过"。**还有一组用例专门留档旧算法的错误行为**（消息落在 tip、未选提交被挪到折叠之后、todo 少一行就丢提交），改坏了会立刻撞车。测试夹具按"一个提交一个文件"造历史——都改同一个文件时，被挪位的提交会撞冲突，反而把"顺序错了"这个现象盖住。


本版是中间那条筛选栏的对齐批次：搜索框长出 IDEA 自己的两个模式开关，窄列不再叠排而是把二级筛选搬进 `>` 浮层，另加"筛选删空"的出口与只读历史版本入口。选中态加强是同批里最先落地的一条，也先于这批改了工具栏的行内密度。

### 新增

- **搜索框内嵌 `.*` / `Cc` 两个模式开关**（`src/services/gitService.ts` 的 `LogFilters.regex` / `caseSensitive`，`_loadGraphData` 在 `--grep=` 前挂 `-E`/`-F` 并按需挂 `-i`；`views/graphView.ts` 的 `search-tb` 标记；`media/webview.js` 的 `searchMode` / `syncSearchModeButtons`；i18n `ui.searchRegex` / `ui.searchCase` / `ui.filterMore`）。此前固定挂 `--regexp-ignore-case`，用户打一个左括号就撞 `fatal: command line, '(优化': Unmatched ( or \(`（exit 128）——把语法错误当搜索词。默认改成 `-F`：**仍然是子串模糊匹配**，只是不再把 `( . *` 当语法，这一点必须写清，否则用户以为字面模式=精确匹配。`Cc` 打开时不再追加 `-i`。这几个旗标对整条 rev walk 生效，所以 `--author` 跟着变（它本来就忽略大小写，"区分大小写 + 提交人"因此是新的组合语义）。两个开关进 graph 缓存 key（`|${regex ? 'R' : '-'}${caseSensitive ? 'C' : '-'}`）：同一批词两种搜法是两份答案，不分家就会拿错列表。**开关是模式不是草稿**——`applyFilterMirror` 无条件赋值，框空着也保持点亮，否则下一次输入悄悄按另一种规则搜。
- **文件右键"打开历史版本（只读）"**（`src/services/blobFs.ts` 的 `GitBlobFileSystemProvider`，scheme `idea-git-blob`，URI 形如 `idea-git-blob:/<仓库相对路径>?ref=<rev>`，在 `extension.ts` 用 `registerFileSystemProvider` 注册；入口 `GraphViewProvider._openRevisionAtChange`）。这条**恒可用**，因为 `跳转到源` 是工作区语义、对工作区已删除的文件只能灰显——老代码从此有读的路径。被本次提交删掉的文件在 `hash` 上没有 blob，回退到 `getDiffBase(hash)` 的父版本并按**旧侧**行号定位（`preview.firstChangedOldLine`；存在时用 `firstChangedLine`）。二进制沿用 `openEditorDiff` 那一句拒绝，不把解不出来的字节塞进标签页。锚点行号取自补丁的第一个 hunk，`src/test/gitParsing.test.ts` 用 4 例守住（晚改动不落在第 1 行、hunk 一侧为空、无 hunk）。
- **筛选删空的出口 + 生效筛选的徽章**（`media/webview.js`：空态 `w.noMatch` 那行死文字换成"清除全部筛选"按钮，本地清空四个框再重查；`syncFilterBadges()` 在文本 / 提交人 / 路径 / 日期四个控件上点亮）。徽章读**已生效记录**而不是输入框草稿——没按回车的词不能让按钮亮，否则等于替用户承认了一次还没发生的搜索。

### 变更

- **选中态加强**（`media/webview.css`，提交行 / 分支与贮藏行 / 第三栏文件行 / 对话框提交行共用同一套）：有些主题的 `list-activeSelectionBackground` 与编辑器底色几乎同色，只靠填充等于看不出选了哪一行。现在底色上叠一层蓝色渐洗、阅读侧一条 3px 强调条（`--vscode-list-highlightForeground`）、标签加粗。阴影一律 `inset`——外投影会被列表边缘裁掉；`.sel.kcur` 保留键盘光标圈，两条线索叠在同一行时都在。
- **工具栏保持单行**：`#cbar` 从 `flex-wrap: wrap` 改 `nowrap`，`.tb` 从 `1 1 110px / min-width 96px` 改成 `1 1 0 / min-width 0`——窄列时先吃掉二级框，搜索框单独保留最大份额与唯一真实的下限（`min-width: 90px`）。原来 `wrap` 的结果是工具栏占掉两排高度、列表少一屏，而 IDEA 那条工具栏始终是单行。
- **窄列折叠进 `>` 浮层**（`COMPACT_CENTER_W = 500`、`buildFilterPopover` / `secondaryFilterBoxes` / `setFilterCompact` / `positionFilterPopover` / `initFilterOverflow`）：中列低于 500px 时把 `f-author` / `f-path` / `date-range` 三格的 `.tb` **原节点**搬进浮层，回来时按锚点 `#btn-reflog` 插回。搬的是同一批 DOM 而不是克隆：克隆会把 `applyFilterMirror` 的落点分成两处，值与监听各活一份。判断用 `#center.clientWidth` + `ResizeObserver`，**隐藏态量到 0 必须直接返回**（那不是窄列，把三格搬走等于让重新显示的面板少掉半截工具栏）。浮层 `position: fixed`、z-index 8500——日期日历是 9000，它从浮层内部打开，绝不能被压住。定位按"先摆再校"两趟：宿主可以开缩放，CSS px 与 `getBoundingClientRect()` 的 px 不是一个尺度，只按数值 clamp 的右边界会露出屏幕外。Escape 走**捕获阶段**且日历开着时不关这层——冒泡阶段日历已经报过"我关了"，两层会一起消失。
- **提交列最小宽度**：拖分栏时钳制 `#left` / `#right` 的最大宽度，中间列不低于 360px（折叠后单行仍要放得下搜索框与 `>`）；隐藏详情栏按 0 宽计入，只有布局真有宽度时才判定；恢复历史会话留下的过宽面板在载入后回拉一次。

### 文档

- AGENTS.md：§7 加"已生效的筛选条件只活在宿主"一节的收尾——中间栏只有一行、模式开关无条件回灌、500px 折叠搬同一批 DOM 节点、隐藏态量到 0 直接返回、浮层 z-index 8500；§8 改写文本搜索那条（默认 `-F`、`.*`→`-E`、`Cc`→去掉 `-i`，两个开关是筛选条件的一部分，必须进 `_filters` / `syncFilters` / 缓存 key，且这些旗标对整个 rev walk 生效）。

### 验证

- compile / lint（0 error，74 warning 与基线一致）/ test 全绿，306 例（较 0.1.5 增 7 例：`filterMirror.test.ts` 3 例守两个开关的回灌与缓存分家，`gitParsing.test.ts` 4 例守历史版本的锚点行号）。
- 真实浏览器（预览 harness，chrome-devtools）实测：`setFilters` 载荷 `{text:'', regex:true, caseSensitive:true}`、两个按钮都是 `mode-btn on`；中列 292px 时折叠成立，浮层 300×131 落在 (451, 38) 视口内，日期日历能从浮层内部打开；Escape 在日历开着时只关日历（`{calendar:false, pop:true}`）；展开后工具栏顺序回到 `f-search, btn-more-filters, f-author, f-path, date-range, btn-reflog, ...`。四种开关组合逐一与 git CLI 比对（`-F -i` / `-F` / `-E -i` / `-E`）。
- 预览场景 `searchModes`（开关点亮）、`narrowBar`（折叠后的单行）、`noMatch`（空态出口 + 徽章）。**折叠交互本身不能用 headless 场景验收**：`--virtual-time-budget` 把定时器跑到渲染帧之前，`ResizeObserver` 还没交付第一帧，步骤里的点击永远发生在折叠之前——曾加过一个 `foldedBar` 场景，两次 `--dump-dom` 结果都不一致，已删除，改由真实浏览器验证。
- 待复验（需要真实工作台）：本批全部（选中态、搜索框开关、折叠、只读历史版本、空态出口）＋ 0.1.5 遗留的两条（双击图片只给一句提示、隐藏再显示后输入框带着生效筛选词）。`media/` 改动后开发宿主跑旧代码，必须完全重启，必要时 bump 版本号让缓存失效。

## [0.1.5] - 2026-10-27

本版修两处都会被误判成"缓存没刷新"的错位：筛选条件只活在宿主、输入框随面板销毁而清空；二进制文件被当作文本交给编辑器对比，于是标签页永远转圈。另把差异左端从字面 `hash^` 换成真正解析出来的父提交。

### 修复

- **搜索框不再骗人：已生效的筛选条件回灌给面板**（`src/views/messages.ts` 新增 `syncFilters`；`views/graphView.ts` 的 `_postFilterMirror()` 在 `_collect` 与 `_loadAndDisplayCommits` 两条重绘路径各调一次；`media/webview.js` 的 `appliedFilters` / `recordAppliedFilters` / `fillFilterBox` / `applyFilterMirror`）。现象是"搜索过一次之后，框里没东西也刷不出别的"，刷新按钮看起来直接把空框当成了搜索词。两个成因：① `_filters` 在扩展宿主，输入框是 webview DOM，而 WebviewView 没有 `retainContextWhenHidden`——隐藏即销毁 DOM，重新显示后三个框全空、列表仍按上一次回车生效的词过滤；② 筛选只在回车时生效，手动把框删空后宿主还在按那个词筛。`syncFilters` 进了 `SCREEN_COMMANDS`，所以跟着 `ready` 握手一起重放，不会打进还没起跑的帧（与当年多仓库冷启动丢分支是同一个坑，反过来用）。webview **只在框为空时填**，既不覆盖也不清空已有文本——没按回车的草稿是用户还没说出口的话；日期区间同理只补空。**删空是唯一立刻生效的输入**：最后一个字符被删掉就 `pushFilters()`，因为这一步没有歧义（空 = 不过滤），✕ 按钮一直是这个行为。缓存这一侧核对过不用改：graph 缓存的键已含仓库路径 / branch / limit / skip 与全部筛选条件，筛与不筛不可能互相顶掉；换筛选走的 `_reload` 重置 `_loaded` 与 `_pendingCommits`，`_dataTicket` 作废在飞的旧页。
- **二进制文件不再开成转圈的对比页**（`src/commands/helpers.ts` 的 `openEditorDiff`，配 `GitService.isBinaryChange` + `gitUtils.isBinaryNumstat`；`views/graphView.ts` 的 `_openFileDiff` / `_openCommitGroupFileDiff` / `_openStashFileDiff` / `_openRefFileDiff` 与 `extension.ts` 的 `idea-git.openFileDiff` 全部改走它）。现象：第三栏双击某些文件，对比页一直转圈、没有数据。把仓库里 514KB 的 `docs/preview/out/main.png` 按 utf8 解码：487,260 个字符中 208,828 个是替换字符 `U+FFFD`（43% 根本没解出来），全文只有 1601 个换行、最长"一行" 6,903 字符——文本对比对这种文档既读不出内容也算不完。第三栏的行内预览早就靠 `preview.binary` 拒绝预览二进制，编辑器侧此前一道判断都没有。现在先跑一次 `git diff --numstat base..target -- path`，git 自己写 `-\t-\t<路径>` 就只给一句提示、不开标签页（分类实测 29ms；判不出来时不误伤——`.catch(() => false)` 照常打开，这道闸是用来阻止挂死的，不是给正常使用设卡）。白名单里允许直接 `vscode.diff` 的只应是一侧为工作区真实文件的场景（`fileCompareLocal`、与分支/HEAD 对比），由 `src/test/binaryDiffGuard.test.ts` 按调用点计数守住。
- **差异左端一律 `getDiffBase(hash)`，不再字面写 `hash^`**（`views/graphView.ts`、`extension.ts`）：`git show <root>^:path` 实测 exit 128 fatal，而虚拟文档 provider 把所有失败都 `catch → ''`，于是首个提交左半边的"空白"其实是一次被吞掉的读取失败，和"这一版确实是空的"完全分不清；换成空树 `EMPTY_TREE_HASH` 之后失败与真空在语义上分开，也和 `_postFilePreview` 注释里"两个界面共用同一对端点"这句话真正对齐（多选组同样走 `getDiffBase(oldest)`）。

### 文档

- README 中英：常用操作表把"看某文件在这次提交里的改动（第三栏双击）"与"与本地文件对比（右键）"拆成两行——此前同一行里把两个入口混为一谈；新增二进制文件不开文本对比的说明；使用方法列表加第 4 条说明筛选框显示的就是真正生效的条件。`docs/CSDN-GitCharm使用说明.md` 的三栏说明与操作表同步。
- AGENTS.md：§7 加"已生效的筛选条件只活在宿主，隐藏面板会销毁 DOM，每次重绘必须回灌 + 删空即生效"；§8 加"双击文件开编辑器对比一律走 `openEditorDiff`（含实测解码数据）"与"差异左端一律 `getDiffBase`，禁止字面 `hash^`"。

### 验证

- compile / lint（0 error，74 warning 与基线一致）/ test 全绿，299 例（新增 `src/test/filterMirror.test.ts` 4 例、`src/test/binaryDiffGuard.test.ts` 6 例）。
- 预览 harness（headless Chrome，`docs/preview/preview.html?scene=main`）实测筛选回灌：三个框与日期标签（`2026-10-01 → 2026-10-20`）全部回灌、草稿 `my-draft` 未被覆盖、清空框后发出的 `setFilters` 是 `text:""`、删到还剩字符不发请求、回车照旧。
- stub-vscode Node harness 跑真实 git：`isBinaryChange(png)=true`（29ms）、`isBinaryChange(README.md)=false`、`getDiffBase(root)=4b825dc642cb6eb9a060e54bf8d69288fbee4904`；`openEditorDiff` 对 PNG 只发一条 info 提示、不触发 `vscode.diff`，对根提交的 README 正常发出左右两端（`ref=4b825dc…` / `ref=567c1bff…`）；`git show <empty-tree>:README.md` 71ms 内 fatal 返回，左半边是快的空白而不是等待。
- 待复验（需要真实工作台）：重启开发宿主后双击一张图片应看到一句提示而非转圈标签页；隐藏再显示面板后输入框应仍带着上次生效的筛选词。

## [0.1.4] - 2026-10-25

本版是打磨批次：blame 定位后的提交列表改成上下各 10 条、两个方向都能翻；blame 注解在自动换行下改放行尾；推送/对比对话框的详情区可以收起；启动即预取首屏；"跳转到源"回到工作区语义。

### 新增

- **启动预取首屏**（`src/extension.ts` → `views/graphView.ts` 的 `prefetchFirstPage` / `_prefetchTask`）：激活后立刻按"能校验到 tip 的记忆分支，否则全部提交"跑一次首屏查询，真正打开面板时 `_firstPageRows` 直接 await 这份结果，省掉点开面板后那一次 `git log` 的等待。配置 `idea-git.prefetchOnStartup`（默认 `true`）可关闭，`package.nls.json` / `package.nls.zh-cn.json` 各一条说明。关闭时这些查询推迟到首次打开面板。
- **推送 / 对比对话框的详情区可折叠**（`media/webview.js` 的 `dialogSidePanelHtml` + `setDialogDetailCollapsed`）：详情区自带 26px 标题栏（左侧"详情"、右侧箭头），收起后只留这一条，文件区接收释放的高度。两个对话框共用模板，行为天然一致；收起状态进 `dialogLayout`（与拖动尺寸同一份），推送对话框切换远端重建后不回弹。折叠前先 `pinDialogBox`：推送框由内容撑开，不钉住会整体缩小并重新居中。收起时隐藏文件/详情之间的横向分隔条；`.collapsed` 用 `!important` 压住拖过分隔条留下的行内 `flex`。箭头放在标题栏而不是正文里——正文每次选中文件都被 `renderDialogDetail` 整体重写，放在里面会被冲掉。

### 变更

- **reveal 的 rooted 列表上下各 10 条、两向可加载**（`_firstPageRows` 的 `REVEAL_SIDE`、`loadMoreUp` / `prependCommits`）：向下是 root 那条提交起的历史，向上取同样 10 条子提交。向上翻页 `skip = after - above - limit`，插到列表头部时按 `ROW_H` 补 `scrollTop`；泳道是全表自顶向下算的，所以必须整表重画。首屏若列表填不满面板（没有滚动条就没有 scroll 事件，上方永远翻不动），`fillUpIfNoScroll` 在 `setData` / `prependCommits` 之后再要一页。并发上用 `_dataTicket` 实现"最新查询胜出"：聚焦视图自身会起跑一次按分支 tip 的加载，晚到不能盖掉 reveal 的结果；`_collect` 被顶替时连计数器、`_lastInProgress`、`_lastKnownTip`、`_revRoot.above/after` 一起不写。
- **"跳转到源"回到 IDEA 语义**（`views/graphView.ts` + `services/gitService.ts`）：只打开工作区的文件，不碰历史版本。提交的文件列表带 `existingPaths`（`fs.promises.access` 逐文件判定），工作区里没有的菜单项灰显且不可点；真点了才发现文件已被删（竞态）就提示"当前工作区中不存在该文件"。删掉 `file.notInCommit` / `deletedOpenedParent` / `openedAtRevision` 三条"打开历史版本"文案。
- **blame 注解按换行开关换位置**（`services/blameProvider.ts`）：内联 `before` 内容只参与第一段可视行的排版，续行一律从行首开始，扩展拿不到可视行、也没有给续行加缩进的 API——所以"左侧固定列 + 续行对齐"在装饰里做不到。现在 `editor.wordWrap` 不是 `off` 时（含 per-language 覆盖）改用 `after` 装饰把"日期 作者"挂在行尾，代码列与续行落在同一条左边线上；`off` 时没有续行，保持左侧固定列。两种装饰类型各建一个，`_apply` 只给当前模式的 `setDecorations`、另一个清空；`editor.wordWrap` 变更时重算，字体变更时两个都重建。未提交行（全零 hash）在行尾模式下直接不画，避免行尾留空色块。
- **"与当前分支比较"对话框加宽**：容器钉成 `min(1100px, 94vw)` / `min(760px, 88vh)`，提交列表收到 340px，文件区 `flex: 2`、详情 34%，选文件不再挤在一条窄缝里。
- **回退 blame 的块合并**（`bb004f3`）：撤回"同提交连续行只在块首行标注"的做法，恢复每行都写日期+作者——逐行确认"这行是谁的"才是标注的用处；超长行的错位另行用换行感知处理。

### 修复

- **收起详情后的空白条**（`media/webview.css`）：拖动过文件/详情分隔条后，`setDialogRowSplit` 给文件区留了行内 `flex: 0 1 <h>px`（grow 0）。再点收起，腾出的高度没人接手，折叠条上方留下一条死区。用只挂在 `.push-files-panel.detail-collapsed` 上的 `flex: 1 1 auto !important` 覆盖行内样式；展开后规则失效，拖动过的固定高度照旧还原。

### 文档

- README 中英同步：新增 `idea-git.prefetchOnStartup` 设置项、对话框详情折叠、blame 换行下的注解位置；"跳转到源"由"打开历史版本（只读）"改为工作区文件语义；推送对话框截图说明与"秒开"一条补上收起/预取。
- `docs/CSDN-GitCharm使用说明.md` 的设置表、Blame 一节与推送/对比对话框说明同步。

### 验证

- compile / lint（0 error，74 warning 与基线一致）/ test 全绿，289 例。
- 预览 harness 新增 `compareDialogCollapsed` 与 `compareDialogCollapsedSplit` 场景：后者先用受限的 `style` 步（只写单个属性，不走 eval）模拟拆分条留下的行内 flex，再点收起，复现空白条；修复后文件区一直铺到折叠条。`pushDialog` / `pushDialogFirstPush` 两张文档图随详情标题栏重拍。

## [0.1.3] - 2026-10-22

本版把"差异"与"操作记录"两个入口重做了一遍：提交差异换成原生多文件差异视图，差异两侧改按字节精确取内容，blame 的"查看提交"从"单独画一行"改成把整个提交列表改根到那条提交（上下都能滚）。另外新增一个编辑器右键命令，删掉三个重复入口。

### 新增

- **编辑器 / 资源管理器右键"查看差异"**（`idea-git.showWorkingDiff`，`src/extension.ts`）：当前文件与 HEAD 版本放进原生 `vscode.diff`，左侧走 `idea-git-diff` 虚拟文档，未提交的改动一眼可见。贡献点挂在 `editor/context` 与 `explorer/context` 的 `2_changes@1`，`when: resourceScheme == file`；`package.nls.json` / `package.nls.zh-cn.json` 各加一条 `cmd.showWorkingDiff`（en `Show Changes` / zh `查看差异`）。
- **提交"显示差异"改多文件差异视图**（`commands/commitCommands.ts` → `vscode.changes`）：一条提交改动的全部文件在同一个页签里依次列出，标题带短哈希与提交主题，与 SCM"打开更改"同形。文件清单仍由一次 `diff-tree` 取回，两侧内容通过虚拟文档按需加载——打开含 200 个文件的提交也只起一个进程。合并提交 `diff-tree` 为空时回退到与第一父的 name-status；根提交左侧靠空树哈希自然为空。重命名/复制的左侧要用**旧路径**，所以解析器只在 `R`/`C` 时填 `fromPath`（`services/gitUtils.ts`），`git diff --name-status` 同步补上这一列。行操作只传哈希，标题缺主题时用 `getCommitDetail` 补（详情已有缓存，不多起进程）。第一版曾先落地单文件原生双栏（`vscode.diff` 左父右子、多文件先选），随后被多文件视图取代，同时删掉已无调用方的 `GitService.getCommitDiff`。
- **blame 的"查看提交"把提交列表改根到那条提交**（`views/graphView.ts` 的 `_revRoot` / `_listRev()`）：第一行不再是"只有这一条"。列表读作 `[它的子提交] / [这条提交] / [它的祖先]`，选中行落在中间，`scrollIntoView({block:'center'})`，加载更多从祖先那条线继续往下翻。`revealCommit` 在**第一个 await 之前**同步写下 `_revRoot={rev,branch}`——聚焦视图会在同一个 tick 里按分支 tip 自己起跑一次加载，那一页晚到就把 reveal 盖掉。`_revRoot` 记着 rooting 时的分支，所以选别的分支、切仓库都让它自己失效；**任何 `_reload` 都必须清掉它**，否则新提交永远进不了这个列表。hash 查不到走 `_dropReveal`（清根 + 重刷 + 一句提示），不把面板留在只有骨架屏的半更新状态。
- **子提交段**（`countCommitsAfter` + `LogOptions.excludeAncestorsOf`，`services/gitService.ts`）：取区间 `<rev> --not <hash>` 的**尾段**而不是最新那几条——`git log -n` 从 tip 起算，而 `--reverse` 只颠倒输出、**不改计数**（实测某条提交之后有 61 条时 `--reverse -n 5` 仍给最新 5 条），所以先 `rev-list --count` 再 `skip = 数量 - 窗口`。取尾段让这一段最后一行正好是 rooted 提交的子提交，图线不断（实测 `091e77e` 之上第 50 行 `b31aa7d` 的父就是它）。区间写成两个 argv token（`--not`）而不是 `hash..rev`：`assertRef` 禁止 `..`。面板没有向上翻页，所以窗口封顶 `REVEAL_CHILD_WINDOW = 50`，否则定位到 5000 条之前的提交会一次画 5000 行。这一段**不套面板过滤器**——它是上下文，且过滤后的区间长度对不上未过滤的 count，skip 会算错。`_loaded`（下一页的 `--skip`）只数 rooted 页的行数，prepend 的行不计入。`getCommitGraphData` 的缓存键补上 `excludeAncestorsOf`，区间遍历期间禁用 hash 快路径。

### 变更

- **操作记录跟随提交列表所选分支**（`reflogCommands.ts` + webview）：点击工具栏时钟按钮时把 `state.selectedBranch` 发给宿主，没选中时宿主用 `getCurrentBranch()` 兜底，不再固定展示 `HEAD` 的检出历史——用户要读的是"这个分支怎么动"。对话框里的 `HEAD@{n}` 选择器列与对应样式（`media/webview.css`）一并删除。
- **"查看文件所有历史提交"改走原生时间线**（`commitCommands.ts`）：命令入口保留，实现换成 `files.openTimeline(uri)`，即资源管理器"打开时间线"跑的同一条命令，并把时间线钉在该文件上（`followActiveEditor` 为 false）；自绘的文件历史对话框实现保留但已不可达。
- **分支右键菜单顺序**（`media/webview.js`）：收藏切换原来钉在菜单第一项、把类型相关操作整体往下挤一行，现在改成操作在前、收藏收尾（实测三种行：当前分支 5+1、其他本地分支 11+1、远程分支 4+1）。"查看操作记录"从三种分支菜单里删掉，入口只剩工具栏那个时钟按钮——它已经跟随所选分支，分支行再放一份只是重复；`action: 'reflog'` 的宿主处理与对话框原样保留。`AGENTS.md` §7 里"本地分支 7 项"的旧计数换成顺序规则。
- **提交右键菜单去掉"复制提交消息"**：只删菜单项与对应 i18n key，处理分支保留，便于按需恢复。
- **`view.commitNotFound` 文案**改为"未找到提交"：探测跑的是 `git log -n 1 <hash>`，跟当前分支无关，原来那句"未在当前分支找到提交"是错的。

### 修复

- **差异文档改为字节精确**（`readBlob`，`services/gitService.ts`）：差异两侧原来走 `showBlob()`，它把 `git show` 的输出 `trim()` 了——工作区文件以换行结尾、HEAD 版本却被削掉最后一个 `\n`，于是右栏画出一条绿色的"新增空行"假差异；`trim` 同样会吃掉文件开头的空行与缩进。现在差异两侧与"跳转源码"统一走本来就是精确内容的 `readBlob()`，`showBlob` 与 `raw=1` 分支、`_gitSourceUri` 一并删除。实测：未改动的 `README.md` 与 `package.json` 对 HEAD 打开差异，两侧行号与末尾完全一致、无任何高亮行。
- **"重置到此提交"从命令面板执行只弹"未选择提交"**：该命令原来只吃行数据，从调色板直接调用没有参数。现在无参时列出最近 50 条提交让用户选，确认文案带上当前分支名（HEAD 可能不在面板展示的分支上），并给 reset 包 `withProgress`。
- **reveal 的两条首屏路径合一走 `_firstPageRows()`**（`_collect` 与 `_loadAndDisplayCommits`）：后者原来还自己起一次 `getCommitGraphData`，晚到的 `setCommits` 会把上面那段子提交抹掉、选中行跳回第一行。合并后 `_loadAndDisplayCommits` 不再重复查询（顺带少一个子进程和一条 unused-var 告警）。
- **`_reload` 的清根挪到 `_repoState` 判定之前**：引导页那条早退路径原来会留着 `_revRoot`，是 harness 里两条 FAIL 暴露出来的真实漏洞（fake provider 从未进入 `ready`），不是测试写错。

### 性能

- reveal 的代价是多两个子进程：实测 142 条历史的仓库 45ms → 90–107ms。另用合成线性历史单独测过 `git log <rev> --not <hash> --skip`：5 万条提交、无 commit-graph 时按深度 +51ms（第 500 条）到 +374ms（第 49 990 条），有 commit-graph 约 +45～82ms 且与深度基本无关（同一仓库既有首屏在无 commit-graph 时本身就要 ~175ms，有 graph 约 20ms）。深历史 + 无 commit-graph 是唯一能被感知的组合，后续若要再压成本，方向是提高窗口前先改成按需取子提交段。

### 文档

- `AGENTS.md`：§7 分支菜单计数改顺序规则、reflog 入口唯一化、文件历史走时间线；§8 把 reveal 改根拆成两条硬规则（同步写根 + 任何 `_reload` 清根 / `_dropReveal` 禁止半更新；首屏一律 `_firstPageRows()`、尾段 `countCommitsAfter` + `skip = 数量 - REVEAL_CHILD_WINDOW`、`--not` 而非 `..`、子提交段不套过滤器）。
- README：中英特性清单同步——`复制提交消息` 从英文清单补删（中文已在上一次改动删掉）、提交差异 / 操作记录 / 文件历史 / blame 跳转四处描述换成新行为、新增"当前文件 vs 最近提交"的右键入口，常用操作表同步；顺带修掉 0.1.1 遗留的过期描述（分支树不再有"收藏 / 最近"两个置顶分组，收藏改成工具栏那个筛选按钮）。中英两节 8 张截图改 jsDelivr CDN（`cdn.jsdelivr.net/gh/Git0gui/gitcharm@main/resources/screenshots/…`），市场页不再依赖仓库相对路径。`docs/CSDN-GitCharm使用说明.md` 的提交 / Reflog / 文件 / Blame 四节与常用操作表同样跟上。

### 验证

- reveal 的 rooted 列表：stub `vscode` 的 Node harness 19 项断言全过（深 / 浅 reveal、接缝与 `git log` 逐行一致且无重复、`_loaded` 只数 rooted 页、加载更多、tip 形状不变、刷新清根、未选分支走 `--all`、bogus hash 回落、两条首屏路径一致），并在隔离的 Extension Development Host 里实看：tip 带分支徽章停在第一行、选中行在其下方、上下都滚得动。
- compile / lint（0 error，74 warning 与基线一致）/ test 全绿，289 例。

## [0.1.2] - 2026-10-21

本版是界面批次（四个对话框的尺寸与排版）加一道安全加固。没有新增 git 子进程路径，首屏逻辑未动。

### 新增

- **四个对话框可拖拽调整**（`media/webview.js` 的 `attachDialogResize`）：整框右缘/下缘/右下角三个把手；推送与对比框另有提交列竖分隔条、文件/详情横分隔条。分隔条 7px 命中区用负 margin 压在原有 1px 边框上，不额外吃栏宽。尺寸存模块级 `dialogLayout`，**按对话框各存一份**（`push` / `compare` / `fileHistory` / `reflog`）——reflog 自然高度只有推送框三分之一，共用外框会把用户没拖的那个撑大。尺寸只活在本轮会话：面板隐藏即 DOM 销毁，对象随帧消失，不进 Memento、不发宿主；同一对话框重建（切换推送远端）与重新打开仍保留。
- **单栏对话框只给外框把手**：reflog 与文件历史没有文件侧栏，`attachDialogResize` 在 `!panel` 时提前返回，不插列分隔条、不套用提交列宽度。
- **外框拉高时按帧等比缩放分栏**：横分隔条拖过之后分栏已是固定高度，外框再放大时按 `startFiles * next.h / startH` 重算，否则新增高度会全部落进提交卡片。

### 修复

- **横分隔条拖动方向相反**，三个独立原因叠加：（1）`startDialogDrag` 按位置把 `(dx, dy)` 传给回调，横分隔条的回调只声明一个形参 `dy`，实际拿到横向距离——竖拖不动、横拖才动；改成具名 `{dx, dy}`，三个调用点各取所需轴。（2）钳位用绝对下限 `clamp(起点+位移, 下限, 空间-下限)`，而 `DETAIL_MIN_H`(110) 比详情栏实际高度(107) 还大，上限低于起点，第一次 `pointermove` 就把整栏顶回去；改为 `dragRange(起点, 能往回多少, 能往前多少)`，下限只在越界时生效，`DETAIL_MIN_H` 降到 96 与 `.push-detail-section` 的 `min-height` 对齐。（3）外框没有自己的高度、又被遮罩居中，压短一栏会整框变矮再重新居中，分隔条于是往光标反方向跳；内部分隔条按下前 `pinDialogBox` 冻住外框，量 `offsetWidth/offsetHeight` 而不是 `getBoundingClientRect`——入场动画是 transform，用 rect 会把动画缩放钉成真实尺寸。
- **推送对话框排版**（`graphView.ts` 模板 + `webview.css`）：宽度 700 → `min(980px, 92vw)`，提交列 380 → 440px 并加 56% 上限；单栏对话框补 `max-width: none`，否则继承上限后右侧留死白。表头从一整串扁平文本改成分段 flex：源分支、远端+路径、管理、状态各占一段，长分支名只省略号截断并保留 `data-title`，"管理"不再被挤成竖排，并归到右侧与提交数同组。

### 安全

- **CSP + nonce**（`graphView.ts`）：策略为 `default-src 'none'; script-src 'nonce-…'; img-src/font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'`——行内 `style=` 与运行时注入的 `@font-face` 依赖 `'unsafe-inline'`，不能省。nonce 由 `crypto.randomBytes(16)` 生成；注入的 `window.__INITIAL__` / `I18N_STRINGS` 已把 `<` 转义成 `\u003c`。预览 harness 显式传空策略，否则相对 `file://` 资源会被策略自己锁死。回归测试 `webviewHardening.test.ts` 扫模板守住策略、nonce 来源与两处 script 标签。
- **`esc()` 改为属性安全**（`media/webview.js`）：原实现走 `div.innerHTML`，只转义 `& < >`；引号在文本节点无需转义，于是原样保留，而几乎每个调用点都把结果拼进 `data-title="…"`。git 分支名允许双引号，提交消息完全由仓库控制，一个引号就能闭合属性注入标签；CSP 挡得住脚本执行，`style-src 'unsafe-inline'` 却允许注入 `<style>`，足以覆盖、伪装界面。改成一次字符串替换 `& < > " '`，顺带省掉每次转义都 `createElement` 的开销（列表每行要转义十来个字段）。tooltip 仍通过 `getAttribute` 读回、`textContent` 显示，实体在属性解析时还原；预览页实测转义串与读回值往返一致。加固测试新增两条静态断言：覆盖五种实体、不依赖 DOM。

### 性能

- **加载更多不再重画整张列表**（`media/webview.js` 的 `appendCommits` → `renderRows(true)`）：旧行节点原地保留，只把新页 `insertAdjacentHTML` 到尾部；新页撑开泳道（`graphW` 变化）才退回全量重画，两条路径都在真实 Chrome 里验过。同一轮渲染里逐行 `scrollWidth > clientWidth` 读后立刻写 class，会让一行一次同步 reflow；改为 `markRefsOverflow()` 先批量读宽度、再统一写 class。预览 harness 同帧实测：126 行时全量 18ms、追加一页 2–5ms；246 行时 32ms 对 3.8ms。

### 清理

- **BlameProvider 与 GitService 的监听归还**：BlameProvider 实现 `Disposable`，构造里注册的编辑器/文档/选区/配置/hover 监听与 decoration 类型收进 `_disposables`，实例随 `ctx.subscriptions` 释放；GitService 补收 `onDidChangeWorkspaceFolders` 返回值，并在 `extension.ts` 把服务本身 push 进 subscriptions。顺手去掉 `gitService.ts` 里遗留的 `require('vscode')`，typed 调用后暴露出 `config.get('pullStrategy', 'merge')` 被推断成字面量、与 `"rebase"` 比较触发 TS2367，补显式 `<string>`。
- **blame 宽度测量改纯字符估算**（`blameProvider.ts`）：extension host 是 Node，没有 `document`，原 `canvas.measureText` 每次都抛 ReferenceError 被 catch 吞掉、恒返回 0，标签宽度一直走固定兜底值。改为拉丁 0.6em / CJK 与全角 1em × `fontSize`；全项目唯一的 DOM 用法消失后，`tsconfig.json` 的 `lib` 从 `["ES2020","dom"]` 收回 `["ES2020"]`，宿主里误用 `window`/`document` 会直接编译失败。

### 文档

- `AGENTS.md`：CSP 与 `esc()` 写成两道缺一不可的 XSS 防线；删掉"appendCommits 全量 renderRows"的旧规则，改为增量追加 + 先读宽度再写 class 的硬要求。
- README 中英特性清单同步：四个对话框可拖拽调整大小、仅本次会话生效。

### 验证

- compile / lint（0 error）/ test 全绿，289 例。

## [0.1.1] - 2026-10-20

本版是 git 层的性能批次（10 个子进程层面的改动）加一次第一栏交互收敛。原则是**不得减缓启动**：首屏仍取 `PAGE_FIRST = 20` 条，新增的缓存全部是内存或 fs-stat 判定，没有任何一处给冷启动加子进程。

### 优化

- **所有 git 命令禁止签名校验**（`gitRunner.ts`）：全局配了 `log.showSignature=true` 的环境里，`git log` 会为每条提交去验 GPG，历史遍历直接变成秒级到十几秒。runner 统一加 `-c log.showSignature=false`，与既有的 `-c core.quotePath=false -c gc.auto=0` 同批基础参数。
- **日志一次带全字段，选中提交不再补一次 `git show`**（`gitService.ts` 的 log format）：原先 `%H %h %s %an` 之外还要在选中时单独 `show` 一次取作者/提交者/时间。现在 format 改为 `%H%x00%h%x00%s%x00%an%x00%ae%x00%ai%x00%cn%x00%ce%x00%ci%x00%P`，一行拿齐。分隔符从竖线换成 NUL 是因为提交消息里真的会出现 `|`，竖线解析会把消息截断错位；实测两种 format 成本一致（约 20.5 ms/op），属于纯赚。
- **`diff-tree` 一次取全状态与行数**（`getCommitFilesWithStats`）：单选提交原先跑两次 `diff-tree`（`--name-status` 一次、`--numstat` 一次），多选 N 个提交就是 3N 个进程。改成 `--raw --numstat -z` 单进程输出两段，按 NUL 边界解析；多选走 `--stdin` 把全部完整哈希交给一个进程，只有缩写哈希（`--stdin` 不认）才回退逐个查询。差异面板的两版本对比同样合并成一次 `git diff`。
- **tag 剥离结果记忆化**（`refsReader.ts` 的 `_peelCache`，上限 500）：annotated tag 每次 refs 读取（5s TTL 到期后）都要同步解压并扫描同一个 tag 对象。tag 对象的哈希即其内容，剥离结论永不变，因此按 40 位对象哈希缓存且**不随 `invalidate()` 清空**。只缓存"loose 文件确实读到"的结果——打包对象没有 loose 文件，缓存这个否定结论会在对象被 unpack 后读到旧值。
- **worktree 列表按目录签名缓存**（`getWorktrees` + `_worktreeSignature`）：每次显示面板、打开分支右键菜单都 spawn 一次 `git worktree list`。签名 = 主 worktree 的 HEAD mtime 加 `.git/worktrees/<name>` 下各注册项的 HEAD 与 `locked` 文件 mtime，签名未变直接复用；`addWorktree` / `removeWorktree` 成功后主动置空。
- **内联差异预览按哈希缓存**（`_previewCache`，上限 30）：文件列表里点来点去会把同一份 diff 反复 spawn。缓存键只接受两侧都是 40 位完整哈希的请求，这类对象内容不可变，所以不需要失效逻辑；分支名与 `stash@{N}` 会移动，一律不进缓存。为此贮藏差异先 `rev-parse` 成具体提交（`getStashDiffRefs`）——既让缓存可用，也避免执行期间 stash 索引重排导致左右版本对不上。面板隐藏时随 `releaseHeavyCaches()` 一并释放。
- **详情缓存放宽到 100 条**（`DETAIL_CACHE_MAX`）：多选与方向键浏览会在短时间内反复取同一批提交的文件与详情，原先 20 条的窗口刚填完就被挤出，下一次点击又走子进程；按提交哈希不可变，100 条的内存开销可忽略。同时补上 `_branchCache` 此前不随 `invalidateVolatile()` 失效的漏洞——外部提交后分支上的 ahead/behind 箭头会短暂停在旧值。
- **加载更多改为窗口预取**（`graphView.ts` 的 `LOAD_WINDOW = 50`）：每滚一页就 `git log --skip N`，而 `--skip` 每次都要从分支顶端重新走一遍历史，越往下翻越慢。现在一次取 50 条缓冲在宿主侧（`_pendingCommits`），仍按 `PAGE_MORE = 10` 追加给 webview（协议不变），缓冲耗尽才再起子进程；`_streamExhausted` 记历史是否已取尽，避免最后一段反复拿到短页。刷新、切分支、过滤器变化时缓冲一并清空。

### 变更

- **取消分支树的"收藏""最近切换"两个置顶分组**（`media/webview.js` 的 `renderTree`）：同一分支此前最多在树里出现三行（HEAD 分组、本地目录树、置顶分组），收藏被冲淡成一份重复清单；最近切换只是 reflog 回溯，日常用处不大。`flatSection` 与 `I_CLOCK` 随之删除。服务层 `RecentBranchReader`、消息协议里的 `recent` 字段与 `w.recentSection` / `w.favoritesSection` 文案原样保留，只撤这一处展示。
- **分支树工具栏新增"只看收藏的分支"按钮**（`#fav-filter`，与 `#stash-save` 同款）：点下去走的是分支文本筛选同一条 `narrowing` 路径——命中的分支才画、文件夹自动展开、键盘导航（`treeRowIsOpen`）跳过隐藏行、当前分支那一行同样受筛选约束（`cherry-pick` 恢复横幅是行动提示不是清单，保留）。生效时按钮填成主题强调色（`.col-refresh.on`），一个都没收藏时给一句"右键分支选择收藏分支"的提示（`w.noFavorites`）而不是留几行空表头；此时 `section()` / `stashSection()` 在 `narrowing && 命中数为 0` 直接不画表头。空判用 `item()` 自增的行计数器，不是嗅 `class="bitem"` 字符串——嗅字符串会被 HEAD 那行绕过。

### 修

- **预览截图脚本自带私有 profile**（`docs/preview/shot.mjs`）：原先用 `chrome.exe --version` 探测浏览器，又不给截图进程指定 `--user-data-dir`。Windows 上不带私有 profile 的 chrome 启动会把请求转交给已经在跑的那个实例然后不退出，于是你浏览器开着的时候整条脚本卡死在探测那一步、一张图也出不来。改成只判断可执行文件是否存在，每次运行给一个临时 profile（用完删掉），单次截图加 120s 上限。

## [0.1.0] - 2026-10-20

本版只发布分支树与第三栏交互相关的功能。提交文件的就地 diff 预览不在本版：完整实现拆到 `feat/third-column-diff-preview`（基于拆分前的 52e9b31），本分支只保留贮藏预览复用的差异带渲染与 `filePreview` 协议。

### 新增

- **三栏键盘导航**：`#btree` / `#scroll` / `#d-files` 是三个可聚焦容器（`initPaneFocus` 设 `tabIndex` 与 `data-pane`），Tab 在栏间循环，方向键只在拥有焦点的栏内生效。光标按身份记录——分支名、提交 hash、文件路径（`treeRowId`、`fileCursor`）——列表重绘后 `applyTreeCursor` / `applyFileCursor` 能落回同一行，而不是按行号跳走。提交列表的 Shift+方向键沿用 Shift 点选的锚点规则；`uiOverlayIsOpen()` 在菜单、对话框、日期浮层、仓库下拉打开时不抢按键；Escape 先关右键菜单。鼠标按下时把焦点钉在所属栏上（行本身没有 tabindex，否则每行一个 tab stop）。
- **分支树收藏与最近切换**：收藏在 `branchMarks.ts`（纯模块），按仓库存进 workspaceState 并做 schema 校验；重命名时 `withFavoriteRenamed` 把标记一起搬走，分支被删只是暂时不显示。最近切换由 `RecentBranchReader` 解析 `.git/logs/HEAD`，复用与 Reflog 相同的 `parseCheckoutTargets`；直接读 git 自己的检出日志，因此终端与内置 Git 界面里的 checkout 都算，面板自己记一份会漏掉一半用户的操作。日志增长才重读，缓存随文件大小失效；HEAD 所在分支永远排第一。收藏与最近是两个置顶分组，扁平展示（不折进目录树），空时不占位置。
- **贮藏单击预览**：贮藏行可选中，第三栏列出该贮藏包含的文件（含 `--include-untracked` 收进的新文件）。端点与实际应用一致：已跟踪文件取 `stash^1..stash`，未跟踪文件取空树..`stash^3`（`getStashDiffRefs`），所以预览、编辑器双栏对比与实际应用看到的是同一份改动。`stash@{n}` 是栈内位置而非身份：drop 或新贮藏入栈后索引会重排，视图把消息与时间跟索引一起记住，下一次 `setStashes` 发现该位置已换成别的贮藏就收起详情并清掉预览。预览请求带 `commit:` / `stash:` 前缀（`state.preview.key`），迟到的响应不会串到另一侧。服务层把 name-status 与 numstat 的合并抽成 `_mergeDiffFileStats`，提交文件列表复用同一段解析；`stashRef` 集中拼装 `stash@{n}` 并在进入命令行前拒绝非法索引。
- **工作树分组**：`git worktree list --porcelain -z` 由 `parseWorktreeList`（纯函数，5 例单测：换行/NUL 两种形状、带空格路径、bare/detached/locked/prunable、缺空行分隔）解析；`getWorktrees` 用 `repositoryKey` 标出当前面板所在的那个。分支树底部只在多于一个非 prunable 工作树时出现该分组；当前行只读，其余双击/Enter 走 `vscode.openFolder(..., true)` 新窗口打开。非当前本地分支的右键菜单新增"检出到新工作树…"（`worktreeCommands.ts`）：路径默认建议为仓库同级目录、分支斜杠拍平成 `-`，相对路径按仓库父目录解析，已存在则拒绝；分支已被别处检出时 `extractWorktreePath` 认出 git 的报错，直接提供"打开那个工作树"。移除前用 `getWorktrees()` 校验路径确为 git 登记的工作树（防止任意路径），并拒绝当前与主工作树；git 因未提交改动拒绝时二次确认后才 `--force`。命名/打开/移除都有中英文案，compile/lint/test 全绿。
- **第三栏文件右键跳转到源**：`_openFileAtRevision` 打开该提交留下的版本（`idea-git-diff` 虚拟文档加 `raw=1`，保留行首空白与末尾换行，只读）；提交删除了该文件则回退到父提交版本并提示打开的是哪一版；多选提交没有唯一版本，菜单项隐藏。打开后用 `setStatusBarMessage` 说明版本，失败走 `formatGitError`。

### 文档

- README 中英特性清单同步：三栏键盘导航、收藏/最近、贮藏预览、工作树、跳转到源
- 单测新增 `parseWorktreeList`、收藏存储与最近分支读取（`withFavoriteToggled` / `withFavoriteRenamed` / `parseCheckoutTargets` / `RecentBranchReader`）等用例，合计 276 例全绿

## [0.0.9] - 2026-10-19

### 新增

- **推送对话框可切换目标远端，提交预览随目标重算**：推送预览收进 `GitService.getPushPreview(branchName, preferredRemote?)`——提交列表、`baseRef`、ahead/behind、已配置远端列表都出自这一处，命令入口与对话框里切换远端共用同一数据源。`resolvePushTarget` 保证**显式选择的远端不回退到别的远端**：在 fork 上首次推送不会被误判成 origin 的普通推送；推送与 `--set-upstream` 判定都用用户最后确认的那个远端。消息协议新增 `remotes` / `pushDialogRemote`，切换时宿主重算并重绘对话框；`resolvePushTarget` 有单测覆盖
- **远端管理（新增 / 改地址 / 改名 / 删除）**：命令 `idea-git.manageRemotes`，推送对话框里可直接进入。远端名按 git 的保守形状校验（无空白、无 `..`、不以 `-` 开头，`assertRemoteName`），`git remote -v` 解析为每远端一条、fetch 行优先（`parseRemoteList`），列表里的 URL 展示前过 `redactUrlCredentials`。增删改名后刷新分支树；改地址后回到推送对话框即按新远端重算预览，不必再手改 `.git/config`
- **保护分支二次确认**：新增配置 `idea-git.protectedBranches`（默认 `["main", "master"]`，支持 `release/*` 这类 `*` 通配，`matchesBranchPattern` 纯函数、大小写敏感）。只拦住误操作、不阻断操作：强制推送与删除分支命中时多弹一次确认，确认后照常执行
- **贮藏可一并收走未跟踪文件**：`git stash push` 不带 `-u` 时，工作区只有未跟踪文件会报 "No local changes to save"，旧代码先用 `hasStashableChanges` 提前拒绝。现在改用 `getStatusEntries()` 分流：只有未跟踪文件时直接按含未跟踪处理；两类改动都有时让用户选"仅已跟踪 / 连未跟踪一并"；都没有才提示没有可贮藏的改动
- **完整 git 错误落到输出通道**：`logger` 增加可注入 sink，`extension.ts` 接到新建的 `GitCharm` OutputChannel——服务层仍不 import vscode。命令 `idea-git.showLog` 打开日志，push/pull/fetch/update 的失败原文经 `redactUrlCredentials` 清洗后写入完整 stderr，错误通知增加"显示日志"按钮；`formatGitError` 的 4 行／400 字截断只用于通知条，排障用的原文不再丢失

### 优化

- **启动与面板重显不再白付子进程**：三处。（1）git 可用性探测**跨会话持久化，且只存"可用"**（`idea-git.gitAvailable`）：命中时跳过 `git --version`，首屏数据命令直接起跑；真实命令遇到 ENOENT/EACCES/EPERM 时翻转标记并清掉缓存（`isMissingGitBinary` / `_noteMissingGit`），回落到无 git 引导页，而不是每次刷新都弹同一条无法处理的错误。（2）首屏与每次 `_collect` 的进行中操作判定改用纯 fs 的 `detectOperationFromFiles()`：空闲时不再为确认"没有操作"spawn `ls-files -u`，权威探测（`getInProgressOperation()`）只留给已知在进行中的 watcher 路径。（3）面板重新显示时先按展示 rev 的 tip 判断历史是否移动（纯文件读取）：没动就复用图缓存重放，动了才强制重查；`resolveWebviewView` 后 1s 内的 visibility 事件视为同一次显示（`SHOW_RELOAD_GRACE_MS`），避免同一次显示把同一查询跑两遍
- **分支菜单的"拉取"补上进度提示**：它走 `idea-git.updateBranch`（内部可能是 fetch + `update-ref`，也可能是 pull），此前只有结束后一句提示。按网络操作规则包 `withProgress`、`cancellable: false`——`_execNetwork` 刻意不设子进程超时，凭据又要等用户填，没有进度就等于界面卡死

### 修复

- **绑定远程时不再写死 origin，拉取也回到分支真正跟踪的那个远端**：`updateBranch` 推断 upstream 时只认 `origin/<branch>`，fork-only 检出直接报"没有可用的远端"；当前分支更新又固定 `git pull origin`，跟踪的是别的远程时拉的是 origin 的默认分支。两处都改成先看 upstream 所在远程，没有才退回 origin；推断流程复用 `matchRemoteBranch`（origin 优先、支持 `dev/x` 这类斜杠名），顺手删掉一个算出来没人用的变量
- **推送不再被"已是最新"拦在对话框外**：删掉 ahead=0 时的提前返回——对话框自己有三态（首次推送 / 已是最新 / 有待推送），用户点的是"查看并推送"，不是"后台替我判断"。推送前记录目标远端的 ahead/behind，成功提示按它判定，不能把 git 对"没有可推内容"返回的 exit 0 + `Everything up-to-date` 一律报成"已推送"
- **推送对话框久留后按钮失效、详情响应乱序、加载更多失败卡死**：消息监听不再按墙钟（60s/300s）释放——那会让对话框还在、按钮点什么都没反应——改为随动作返回／关闭／面板隐藏／webview 销毁释放；面板隐藏即 DOM 销毁，此时推送命令必须立即拿到 undefined 返回，否则永久挂住。`setDetail` 校验 `commit.hash === state.selectedHash`，`multiCommitsResponse` 校验提交集合与 `state.selectedHashes` 一致，快速连点时旧响应晚到不会盖住当前选中行；加载更多失败时宿主回 `loadMoreFailed`，webview 收起加载指示并保留 `hasMore`，下次滚动可重试
- **记住的分支已被外部删除时不再报 `unknown revision`**：持久化分支缓存与视图状态都只记名字、不校验 refs。载入前用 `getBranchTipHash`（纯 fs）校验，未命中先 `invalidateVolatile()` 再复读一次（避免把刚建的分支误判成删除）；确认消失就清空选择、按全部提交展示并强制刷新分支树。`setBranches` 在选中项不在新列表时清掉高亮，树里不再留下点了就报错的幽灵分支
- **从 Blame / 文件历史定位提交时，详情不再显示上一次多选的数据**：`revealCommit` 只改了 `selectedHash`，`selectedHashes` / `multiCommits` 仍停留在上一次多选上，而 `renderDetail()` 在单选时优先用 `multiCommits`。现在定位时同步清掉多选状态与 `lastClickedIndex`
- **无仓库引导页可以直接选仓库**：`#repo-state` 是 `position: fixed; inset: 0` 的全屏遮罩，底下的仓库切换器点不到，而 `listRepositories()` 明明已经找到了仓库。现在把发现到的仓库直接列进卡片（`data-repo-pick` → `selectRepository`），点一下即切换，避免只把"初始化仓库"推给一个本不该建仓库的父目录

### 文档

- **CHANGELOG 分两份**：`CHANGELOG.md` 面向用户（随 VSIX 发布、市场页展示），每个版本只留简短明确的几条；本文件 `docs/CHANGELOG-detailed.md` 面向维护者，保留当前详细程度（踩坑、实测数据、文件与函数名）。AGENTS.md 的合入红线同步写明两份都要更新
- 单测新增 `resolvePushTarget`、`assertRemoteName`、`matchesBranchPattern`、`parseRemoteList`、`isMissingGitBinary` 等纯函数用例，合计 241 例全绿

## [0.0.8] - 2026-10-15

本批不动运行时代码：全部是文档与文档配图链路，扩展行为与 0.0.7 一致（版本号按"合入 main 必 bump"的规则递增）。

### 新增

- **界面截图可以脱离 IDE 重出了**（`docs/preview/`）：过去每次界面改版，README 与市场页的截图就得手动重拍，实际状态是长期过期。现在 `build-preview.mjs` 从 `graphView.ts` 的 `_getHtmlForWebview` 模板里抽出**真实 DOM 骨架**，加载扩展自己的 `media/webview.css` 与 `webview.js`，只把 `acquireVsCodeApi()` 换成一个 shim，按 `src/views/messages.ts` 的真实消息协议喂进一份演示数据（提交哈希、提交消息、文件增删行数都取自本仓库真实历史）；右键菜单、推送与 Reflog 对话框、多选高亮都是派发真实 `MouseEvent` 走真实代码路径弹出来的，不是画出来的假界面。`shot.mjs` 用无头 Chrome 一次出 8 个状态，再从底部向上扫像素裁掉提交列表下面那片纯背景、量化成 128 色调色板（2800×1560/483KB → 2800×1193/177KB）。四个实测出来的坑记在文件里：无头截图把 CSS 入场动画冻在第 0 帧，而面板动画从 `opacity: 0` 起步，整页会拍成半透明（预览主题全局关掉 animation/transition）；`restoreViewState` 的 `expandedFolder` 并不会真的展开目录（改成点真实的 `.bfolder` 元素）；推送对话框默认选中 `__all__` 行，不响应 `getPushAllFiles` 就永远停在"加载文件…"；`revealCommit` 只设 `selectedHash` 不入 `selectedHashes`，所以多选场景必须先派发一次普通点击，否则菜单计数与高亮行数不一致。sharp 与 docx 都**不是**扩展依赖，脚本按 `NODE_PATH` 找临时安装目录（`require()` 认它，动态 `import()` 不认），找不到就跳过并提示一句
- **markdown 直出 Word 文档**（`scripts/build-docx.mjs`）：文章要发给别人时，带相对路径的 md 会掉图，而 CSDN 的编辑器会剥掉 `data:` URI，只能走它自己的图床。脚本把这篇重排成自包含的 `.docx`：9 张图缩到 1400px 宽、量化后嵌进 `word/media`，整包 0.9MB；中文微软雅黑（含 `eastAsia` 声明，否则 Word 会回退成宋体）、代码 Consolas 加浅底纹、表格带表头底纹与竖向分隔线、每个二级标题另起一页。产物 `docs/*.docx` 不进版本库——md 才是源头，改完重跑

### 文档

- **新增 CSDN 使用说明**（`docs/CSDN-GitCharm使用说明.md`）：八节，重点是"几个只有真用过才知道的设计"那一节——面板凭什么跟着终端里的 git 操作自己跟上、为什么彻底拆掉 `vscode.git`、失败提示为什么要去读一次 Windows 系统代理（以及为什么不能替 git 读）、一步改动变空时的三选一、多项目工作区的管理规则。每条都对着代码核过，包括边界：没有一键 fetch all／pull all，向下扫仓库有深度上限所以嵌得更深的看不见。两张真机截图（编辑器 Blame、真实工作区的仓库切换器）裁掉了活动栏、编辑器代码、状态栏邮箱与任务栏，进 `docs/images/` 与自动生成的 `docs/preview/out/` 分开存放，免得被下一轮重截覆盖

### 构建

- **`docs/` 与 `scripts/` 不进 VSIX**：`.vscodeignore` 新增两条排除。这不是洁癖——本批的截图共 1.4MB、Word 文档 0.9MB，全都会被 vsce 默认打进包里，而 README 里写着"VSIX 从 442KB 降到 156KB"。实测 0.0.8 包体与 0.0.7 一致
- **`.gitignore` 的 `out/` 锚到仓库根**（`/out/`）：不带斜杠的 `out/` 匹配任意层级，会把 `docs/preview/out/` 里那些被文章链接引用的截图一起吞掉（`git check-ignore` 实测命中）。同一条规则还顺手解释了为什么 `/.vscode-test/` 也该锚定

## [0.0.7] - 2026-10-15

### 优化

- **"我浏览器明明能上 GitHub，git 却连不上"现在被解释清楚，并给出能直接跑的那条命令**：0.0.6 里那条提示的形如"git 当前没有配置代理……`git config --global http.proxy http://127.0.0.1:<端口>`"，端口还得用户自己猜，而答案就写在他机器上。实测这台机器的形状：注册表里系统代理是开着的（`ProxyEnable=0x1`、`ProxyServer=127.0.0.1:7890`），环境变量里一个 proxy 都没有，git 也没配 `http.proxy`——浏览器读注册表所以"能访问"，git 不读注册表所以直连 443 超时 21s；同一条 `git ls-remote https://github.com/sveltejs/svelte` 加上 `-c http.proxy=http://127.0.0.1:7890` 不到 1s 就返回。现在 git 没配代理时会再读一次系统代理（`reg query` 走 argv、无 shell，非 win32 直接返回 undefined，且只在失败路径上跑一次），读到就把**具体地址**写进提示，用户复制的那一行可直接执行。`ProxyServer` 是自由格式，归一化由纯函数 `parseWindowsProxySettings` 负责并配 12 例单测：裸 `host:port`、完整 URL、`https=…;http=…` 的按协议列表（WinINET 的 `https=` 只说"哪类流量用它"，代理本身仍是 HTTP CONNECT，所以给 `http://`）、socks 条目保留 scheme（裸 `socks` → `socks5`，git 不认识 `socks://`）、`<-`／`<local>` 这类绕过标记不算代理。条目里的凭据选择**剥掉**而不是打码——WinINET 把代理密码存在另一个键里，而"粘上去就能跑"比展示原值更重要（git 自己配过的代理仍然照旧过 `redactUrlCredentials`）。至于"为什么不干脆像浏览器那样直接用系统的网"：这条边界不在插件，2026-10-15 核对上游 main，内置 Git 扩展的 `git.ts`／`main.ts`／`askpass.ts` 里 `proxy` 出现 **0 次**——它和我们要一样是 spawn git，只有 VS Code 自身的流量（走 Electron/Chromium）才吃系统代理。所以能做到的是把这件事说清楚，而不是替 git 假装它读得懂注册表。

## [0.0.6] - 2026-10-14

### 新增

- **回退（Revert）/ 修补提交（Amend）/ 复制提交消息 / 在远端网页打开提交与分支**：补齐 IDEA 右键菜单的四项。回退把 `REVERT_HEAD` 提升为第五种"进行中操作"——实测带冲突的 `git revert` 只写 `REVERT_HEAD`+`AUTO_MERGE`+`MERGE_MSG` 而不写 `MERGE_HEAD`，沿用 merge 判定的话，状态栏的"继续"执行完 `merge --continue` 会直接失败；多提交回退按历史顺序从新到旧逐个执行（git 按参数顺序反向打补丁，先回退旧提交必然被新提交挡住；判新旧见下面"一组提交的早晚不能按作者时间判"）。修补在无可并入内容时返回而不是硬跑 `amend -a`（实测后者照常重写哈希，用户看不到任何改动却拿到一个新 commit）。远端网页地址直接解析 `.git/config`（含 `commondir`，worktree 安全），scp-like、`ssh` 带端口、https 带凭据、GitLab 子群都归一成 https 基址；本地路径型远端返回明确提示而非静默失败
- **标签管理（新建轻量/附注、删除本地、推送到远端）**：附注标签的 `refs/tags` 存的是 tag 对象哈希而不是提交哈希，`_loadGraphData` 拿它匹配提交永远匹配不上——这类标签此前根本不显示徽章，"该提交的标签"也列不出来。现在 `RefsReader` 用 zlib 直接解开 loose object 取 header 的 `object` 行（零子进程，符合"能读文件就不启子进程"；对象被 gc 进 pack 时退回原哈希，不比改动前更差）。徽章判定不再用 `isTagName` 猜名字形状，改由 `GraphCommit.tags` 权威字段驱动，右键菜单用同一次判定决定"推送标签/删除标签"是否出现。标签名规则按 `git check-ref-format` 实测补齐（路径段不能以 `.` 开头、不能以 `.`／`.lock` 结尾等），并给出可本地化的具体原因，输入框 `validateInput` 即时反馈；附注标签消息走 `-F` 临时文件，留空即轻量标签。删除只动本地并在确认框里明说远端不会被删
- **贮藏（Stash）管理面板**：分支树第三分区列出 stash 栈，工具栏一个按钮新建贮藏，行上/右键可应用、弹出、删除（删除带确认）。顺带换掉一个会切坏数据的旧解析：`getStashes` 原先按 `%gd|%gs` 切竖线，而贮藏消息合法含竖线（实测 `On master: pipe|subject` 被截断），且 `git stash list` 不支持任何日期格式——改走 reflog `log -g stash --format=%gd%x00%gs%x00%aI` 以 NUL 分隔，解析抽成纯函数 `parseStashList` 并进单测。`refs/stash` 在公共目录（各 worktree 共享）且 git 永不 pack，所以"有没有贮藏、是否变化"只需读一个小文件：2s 轮询比对签名，真变了才 spawn 列表查询。`stash@{n}` 是栈内位置而非身份，故每次操作前都按当前 index 重新解析；stash 冲突不写状态文件，只能靠 stderr 判定后走既有的冲突处理路径
- **提交列表按路径过滤（对标 IDEA 日志工具栏的 File filter）**：工具栏新增路径输入框，回车触发（与消息/作者/日期框同一规则），支持逗号分隔多个路径与 git 原生 pathspec 通配；详情栏文件行右键多一项"按此文件过滤提交"，直接填入并重查。`parsePathFilter` 拆分并丢空段与控制字符，pathspec 一律追加在 `--` 之后——因此前导 `-` 不会被当成选项，无需再拒绝；图形缓存 key 加上 path，否则切回来会命中旧页。语义上带 pathspec 时 git 做的是按路径的历史简化，未触及这些路径的 merge 提交不再出现，这正是"哪些提交改了这个文件"的答案（已写进注释以免日后被当 bug 修掉）；零结果复用既有 `searchContext` 提示，不让用户对着空列表猜过滤是否生效
- **Reflog 查看器（误操作急救）**：工具栏按钮看 `HEAD` 的 reflog——只有 HEAD 记录 `checkout` 与 `reset`，正是把工作"藏起来"的两个操作；分支行右键同一项看该分支自己的 movements，远程跟踪分支也有 reflog，force-push 之后同样能查。面板内对话框列出选择器/短 hash/动作/消息/时间，双击=查看差异，右键菜单整份按"误操作急救"排列——先看这次改了什么／新建分支留住这一步／回退到这里（撤销这次误操作）／把这个提交捡回当前分支／复制 hash，全用 reflog 专用文案而不是主列表的通用菜单项，因为在这个对话框里每一行都意味着"曾经存在过的一个状态"。除复制 hash 外全部复用既有 `commitNode` 动作，因此命令本身只读、不需要任何刷新路径；空 reflog（新仓库或已被 gc）给提示而不是弹空框。数据源 `git log -g <rev> --format=%gd%x00%H%x00%gs%x00%aI`（plumbing 形式的 reflog show，可自选字段），subject 是自由文本所以按 NUL 分隔，动作按第一个 `': '` 切（`reset: moving to 1a2b` 仍算一个动作），取全量 `%H` 而非 `%h`——回退与检出的目标不能有歧义；rev 没有 reflog 时命令非零退出，按空列表处理。面板刚打开、webview 未 ready 时按 `revealCommit` 的同一套 pending/flush 挂起
- **可选的后台定时 fetch（`idea-git.autoFetchMinutes`，默认 0 关闭）**：面板可见时按设定间隔静默 fetch，只刷新分支树与 ahead/behind 箭头，不动中间提交列表（fetch 不改本地历史）。远端是否存在直接读 `.git/config`（fs，零子进程），没有远端就不 spawn；刻意绕开 `_execNetwork` 以不带 `GIT_ASKPASS`，并设 `GIT_TERMINAL_PROMPT=0` 与超时，离线／无凭据时快速失败且只记 debug 日志——不该花钱的时候不花钱，也不该每几分钟打扰一次用户。首个 tick 在面板打开 5s 后触发，改设置即时重挂定时器，面板隐藏即停
- **工作区里有多个仓库时的仓库切换器**：过去面板只显示它顺手发现的那一个仓库。现在分支树上方出现一个仓库下拉（IDEA 的 Git roots 位置），命令面板另有 `GitCharm: Switch Repository`；列表按每个工作区文件夹向上找根，**并在文件夹本身不是仓库时向下扫一层**——一个普通父目录并排十几个工程（内置 Git 能列全、我们看不见）从此也能切。探测纯 fs、按大小写规则去重，同一仓库的多个文件夹只出一条；向下扫描带深度上限、忽略依赖/构建目录、命中仓库就不再往里列，实测十几个仓库 5ms。只有一个仓库时切换器不出现，单根工作区零变化。面板与命令都走 `GraphViewProvider.switchRepository` 这一条路，保证切换时重置的是同一批状态（分支、选中提交、进行中操作、待落盘的视图快照）——git 允许不同项目重名分支与短哈希，借来的值在新仓库里会读成真的数据；而过滤条件是用户输入而非仓库状态，刻意保留，清掉只会让输入框和宿主的说法不一致。钉住的仓库写进 `workspaceState` 并在启动时校验（目录还在且还是仓库才认，否则自动发现接管），持久化视图快照新增 `repoPath` 由宿主盖章、不匹配即丢弃。`.git` 监视与 `git init` 回调改为覆盖全部文件夹，删除其中一个仓库不再把面板整体藏掉（只要还有别的仓库在）

### 优化

- **时间筛选改成"按住拖动圈选一段时间"的自绘日历**：原来工具栏里是两个原生 `input[type=date]`，日期弹层归操作系统管、主题变量够不到（和作者框当初弃用 `datalist` 是同一个原因），而且开始/结束是两个各填各的字段，选反了只能事后报错。现在是一个范围按钮（`2026-10-06 → 2026-10-12`）加自己的浮层：在网格上按住拖动即可圈选，反着拖会自动归正，跨月也一样（网格固定 6 周，相邻月的日子就在同一格里）；不喜欢拖的话先点起始日、再点结束日同样走通，提示语会跟着变。顶部有 今天／近 7 天／近 30 天／近 1 年 四个快捷区间，点标题切到 12 个月的年视图。端点在 webview 里就排好序，`w.endBeforeStart` 那条校验因此没有存在必要，一并删除；发给宿主的格式没变（`YYYY-MM-DDT00:00:00`／`T23:59:59`，git 侧仍把 `T` 换成空格）。三个实测出来的坑已写进注释：**拖动期间不能重建网格**——`innerHTML` 一重写，按下的那个格子当场脱离文档，浮层上"点到外面就关闭"的判定于是把这次按下读成"没点在浮层里"，拖动直接死在第一步（所以选中态是原地 toggle class，只有月份／年份／视图变了才重建）；**浮层要先摆再校**——宿主可以开缩放，CSS px 与 `getBoundingClientRect()` 的 px 不是一个尺度（实测 252px 宽的框量出来 239.4），只按数值算的右边界 clamp 会差出零点几像素，所以摆完再用真实渲染出的矩形挪两下；**松手只有落在日历内才算圈选完成**，落在外面（按下去之后把鼠标移出窗口松手）视为放弃——否则这次没走完的按下会在用户下一次点任何东西时提交成一个莫名其妙的区间。
- **一步"改动变空"不再甩出 git 的建议文本，而是问用户三选一**：解决冲突时保留了对面已有的内容，这一步的补丁就成了空的，git 会停下并打印整段 advice（`The previous cherry-pick is now empty… git commit --allow-empty … Otherwise, please use 'git rebase --skip'`）——那三行恰恰就是用户能做的三个选择，只是没人替他按。现在由纯函数 `isEmptyCommitStop`／`emptyCommitStopInfo` 认出这种停止并取出提交号，弹"跳过这个提交／保留这个空提交／终止"对话框，执行走 `rebase|cherry-pick|revert --skip`、`commit --allow-empty --no-edit`、以及原有的 abort；接入点是继续操作、cherry-pick、revert、交互式变基、变基到某分支、拉取/更新分支这些会撞见它的地方，且**必须排在冲突判定之前**（advice 里含 `Could not apply`，先判冲突会把用户赶去解决已经不存在的冲突）。实测（git 2.45.1.windows.1）三条：cherry-pick 与 rebase 打印 advice 块，`git revert --continue` 只打印状态头加 `nothing to commit, working tree clean`，所以判据两种形状都认；`.git/sequencer/todo` 不随执行消耗（进度记在别处），因此"保留空提交"后还要补一次 `--continue` 才会跑完剩下的队列（单条 pick 不留 sequencer 目录，多条才留）；`commit --allow-empty --no-edit` 会复用准备好的消息（revert 场景即 `Revert "m1"`）并结束当前步。若续跑队列时撞上下一步的真冲突，走既有冲突路径（打开文件 + 状态栏继续/终止），不再报"处理这一步失败"。顺带把 `cherry-pick --continue` 收进服务层并补 `GIT_EDITOR=true`——之前那条是唯一没设的，宿主里没有终端可交给交互式编辑器
- **git 失败提示不再把 `Error: fatal: …` 原样甩给用户**：新增纯函数 `formatGitError`（src/services/gitUtils.ts）并替换全部 45 处 `String(error)`——剥掉字符串化 Error 带来的 `Error: ` 包装和 git 自己的 `fatal:`/`error:` 前缀，去掉重复行（`GitCommandRunner` 把同一句 stderr 同时写进 `message` 与 `stderr`，一条 fetch 失败过去会在同一条提示里出现两遍），限 4 行／400 字符。网络类失败再由 `_explainNetworkFailure` 按类别补一句可执行建议：凭据（沿用原有提示）、证书、连不上。"连不上"先读 `git config --get http.proxy` 看 git 到底配没配代理——没配就说"在代理网络里就给它配代理"，配了就说"代理是 {proxy}，确认它还在跑"，代理 URL 里的账号密码经 `redactUrlCredentials` 抹掉后才展示；建议写在第一行，因为通知条截的是尾部。关键词判定（push 的 `non-fast-forward`／`[rejected]` 等）改读 `combineErrorText` 的原文，不受显示截断影响。用户报的这条已实测：本机 `git config` 里没有 `http.proxy`、`127.0.0.1:7890` 有代理在听，直连 github.com:443 超时 21s，而同一个 `ls-remote` 走代理 1.5s 出结果——新提示会直接把这件事讲出来

### 修复

- **对话框里的提交行超出对话框宽度，右边的"动作/时间"两列看不见**：`.push-dialog-body` 与 `.push-commits-list` 作为 flex 子项都用默认的 `min-width: auto`，而提交消息是 `white-space: nowrap`——nowrap 文本的 min-content 宽度就是整行宽度，于是列表按最宽那行撑开（实测 478px 的对话框里撑到 818px），把动作与时间两列顶到对话框外沿；外层 `.push-dialog-body` 的 `overflow: hidden` 把多出来的部分裁掉（不画滚动条），但 `overflow: hidden` 的元素仍然能被滚轮／触控板横向滚动，所以看起来就是"莫名能左右滑动、列又缺一个"。给这两处补 `min-width: 0` 后，消息列自己收缩成省略号（完整文本在行 tooltip 里），五列一律落在框内（实测 420/700/900px 三档：行宽=容器宽、日期列右沿距框 16px）。推送、对比、文件历史、Reflog 四个对话框共用这套类名，一处修好四个
- **多选提交后双击文件只看得到一个提交的改动**：第三栏的双击只把 `state.selectedHash`（最后点的那个）发给宿主，于是另一个提交改的行在对比里根本不出现——多选问的恰恰是"这一组提交把它改成了什么"。现在改成跨整组的双栏对比：左边取**最早**提交的父版本（`oldest^`），右边取**最晚**提交的版本，早/晚按**历史顺序**判定（`GitService.orderCommitsByHistory`），组里每个提交的改动都落在同一份 diff 里，标签页标题 `README.md (cfccce3^ ↔ 1a2b3c4)`。双栏只放得下两个版本，所以选中项之间那些没被选的提交也会出现在差异里——这正是要的"看这一组留下的结果"。曾按"逐提交补丁拼一份只读文档"（`idea-git-patch` 虚拟文档）实现过，被否掉：要的是一贯的左右对比，不是补丁文本
- **一组提交的早晚不能按作者时间判**：上一条最初用 `%ai` 排新旧，在真实仓库上正好排反——bouncePy 里 `cfccce3`（作者 13:39）其实是 `5f8c82d`（作者 14:48）的**子**提交（提交者时间 16:09），cherry-pick/rebase 会把原作者时间带过来、落地顺序却相反。后果不只是"左右两栏是同一个提交、差异恒空"（我第一次还把它解释成"改动互相抵消"，那是错的）：`cherryPick` 与 `squashCommits` 的参数顺序、`squashCommits` 用来起 rebase 的 `baseRef`（取"最早"那个提交的父提交）、`revertCommit` 的"从新到旧逐个回退"全都取错端点——尤其 `baseRef` 取错是在改历史。现在统一走新增的 `GitService.orderCommitsByHistory()`：一次 `git rev-list --no-walk --topo-order`，与点击顺序无关，git 排不出的（坏 rev）留在末尾而不是消失。修好后用户那组选择的差异是 `+2 -1`，与第三栏合并文件行显示的数字一致
- **多选提交的"合并文件"不可信**：三个叠在一起的毛病。宿主把每个提交的文件列表 `flatMap` 原样串起来，webview 再按路径去重时把**第一次碰到的状态**当成最终状态——而"第一次"取决于用户按什么顺序 Ctrl+点行，于是同一个选择里"旧提交新建、新提交继续改"的文件会显示成 `M`，行序也跟着点击顺序乱跳。现在合并搬到宿主：`mergeCommitFileStats` 收到的批次一律按**历史顺序**排成旧→新（`orderCommitsByHistory`，与提交消息列表同一份顺序，webview 不再 `reverse()` 猜），一行一个路径、行数累加、状态取净效果（选择内新建的保持 `A`，之后被删则成 `D`），并按路径排序。顺带守住一个隐性破坏点：条目一律复制后再累加，因为 `getCommitFilesWithStats` 返回的是 `_filesCache` 里的同一批对象，原地加行数会把缓存改掉（第二次多选就成了双倍行数）。多选提交的信息卡片也不再按点击顺序展示，改由宿主按历史顺序排
- **推送/拉取/取用没有任何进行中指示**：这三条网络操作是直接 `await gitService.push/pull/fetch`，漏了本项目对变更类操作强制要求的 `withProgress`——同文件的检出、删除、贮藏、标签全都有。而网络调用刻意不设 spawn 超时（大仓库推送不该被 30s 掐断），凭据又要等用户在自己的输入框里填，于是最长的那类操作恰恰是唯一看不见的：界面一片安静，像卡住了。现在三条都挂 Notification 进度（后台自动 fetch 照旧静默，绝不弹进度也不弹凭据框）
- **虚拟文档把文件名里的 `%` 读坏了**：`idea-git-diff` 的 provider 对 `uri.path` 又做了一次 `decodeURIComponent`，而 VSCode 的 `Uri` 各段本来就是解码值（`toString()` 才是编码的那一步，文档明说 `skipEncoding` "Do not percentage-encode the result"）。于是名字里含 `%` 的文件（`100%.md`）第二次解码直接抛 `URIError`，差异框变成一片空白；`%20` 这样的合法文件名也会被错读成空格。现在只剥前导斜杠、不再解码
- **多仓库工作区面板卡在骨架屏**：冷启动时分支走 `workspaceState` 缓存、提交走热索引，比 webview 脚本加载还快，`setBranches`/`setCommits` 在 `ready` 握手之前就发了出去——而握手之前的消息会被 webview 静默丢弃且没人重投，于是前两栏永远停在骨架条（看起来像"图标全没了"），第三栏却靠握手后的往返拿到了真实提交。现在 `_post` 把刷屏类消息按 command 暂存最新值，`ready` 时先 flush 再投递权威仓库状态；隐藏即 DOM 销毁，因此隐藏时把 `_webviewReady` 置回 `false` 并清空缓冲，避免把消息打进已经死掉的帧（同源问题：隐藏期间的 `setFileIconTheme` 过去会丢，重显示后文件图标退化成兜底图标）
- **对话框里的右键菜单"点了没反应"**：`.context-menu` 一直是 `z-index: 1000`，而所有面板内对话框（Reflog、文件历史、推送、对比）用的遮罩层是 `2000`——菜单确实弹出来了，只是画在遮罩底下，看起来就像右键失效。提到 `10001`（盖过全部遮罩与 `10000` 的自定义 tooltip），一处 CSS 修好所有对话框内的菜单，不用给每个弹层单独传层叠上下文

### 文档

- **AGENTS.md 再补三条本批约束**：切换仓库只准走 `GraphViewProvider.switchRepository`（否则各处重置的状态不一致，会把上一个项目的分支/选中项带进新仓库）；易失缓存与视图快照必须能识别自己属于哪个仓库（`repoPath` 不匹配即丢弃）；后台／定时任务不得走 `_execNetwork`（它会挂 `GIT_ASKPASS`，无人值守时弹出凭据框）
- **单测覆盖继续扩充**：`parseStashList`、`parsePathFilter`、`parseReflogList`、`parseGitConfigRemoteNames`、`pickFetchRemote`、`repositoryKey`、`collectRepositoryRoots`，以及本批后段的 `isEmptyCommitStop`／`emptyCommitStopInfo`、`mergeCommitFileStats`、`formatGitError`、`redactUrlCredentials` 全部是纯函数用例（不 import vscode），i18n 词典 zh/en key 集 parity 照常通过；合计 201 例全绿

## [0.0.5] - 2026-10-11

### 新增

- **自有凭据输入（`GIT_ASKPASS`）**：远端要账号/密码/令牌时由扩展弹出输入框，不再依赖内置 Git 的 askpass。git 直接执行 `media/askpass/git-askpass.sh`，脚本用宿主自带的 Node 把提示词 POST 回扩展宿主的本地一次性服务（只绑 `127.0.0.1`、URL 含随机 token、请求体上限 4KB、120s 超时），密码类提示走掩码输入框且不入日志；取消即 204 → git 退出 128，并补一句"配置凭据助手或改用 SSH"的可执行提示。`push/pull/fetch` 统一走新的 `_execNetwork`（带 askpass 环境、不设超时，避免大仓库推送被 30s 掐断）
- **工作区状态的完整解析与暂存服务层**：`parseStatusEntries` 解析 `status --porcelain -z` 的 XY 双状态（含 rename/copy 的源路径、六种冲突码、`!!` 忽略项），`GitService` 在其上提供 `add/stage/unstage/discard/getStatusEntries`，丢弃未跟踪文件前强制校验路径必须落在仓库内
- **冲突解决完，分支上方的"继续/终止"自动收起**：面板可见时在同一条 git 目录监听上分流状态文件（`MERGE_HEAD`/`CHERRY_PICK_HEAD`/`rebase-merge`/`rebase-apply`），2s 轮询常开作兜底。git 在操作真正结束时才删掉这些文件，所以判据取"状态文件消失"——在外部终端 commit、`--continue`、`--abort` 都能跟上；只 `git add` 还没 commit 时 `MERGE_HEAD` 仍在，状态栏保留才对（merge 还没结束）。空闲态只做四次 `existsSync`（零子进程），只有已知在进行中才走会 spawn `ls-files -u` 的权威检测
- **外部提交落地后提交列表自动跟上**：同一条轮询里比对"当前展示 rev 的 tip"——在分支树选了分支就读它的 ref，没选就读 `HEAD`，全是纯文件读取；tip 变了才带 force 重载一次，不做无条件刷新。自动刷新携带 `preserveSelection`，只在所选提交仍存在于新列表时保留选中项、第三栏详情、折叠态与滚动位置，用户在终端每提交一次面板就跳回顶部、详情被清空的情况不再出现

### 优化

- **彻底移除对内置 `vscode.git` 扩展的依赖**：分支列表、当前分支、upstream/ahead-behind、HEAD 哈希一律改由自有实现提供——refs（含 packed-refs）与 `HEAD` 直接读文件，track 信息用单条 `for-each-ref`，缓存失效改由 `fs.watch` git 目录驱动。`package.json` 不再声明 `extensionDependencies: ["vscode.git"]`，禁用内置 Git 扩展也能正常使用；面板首屏不再可能被内置扩展的仓库扫描（多子进程、大仓库秒级）拖慢
- **缓存失效改为事件驱动**：`GitService.watchRepositoryChanges()` 监听 `HEAD`/`index`/`packed-refs` 与 `refs` 目录（递归），250ms 防抖后丢弃易失缓存；订阅方按 token 归还 Disposable，最后一个释放时才真正关监听。外部终端里的 checkout/commit 不再需要等缓存过期或轮询
- **打包体积从 442KB 降到 156KB**：VSIX 内剔除 `resources/screenshots`（README 图片链接打包时会被 vsce 重写成 GitHub raw 绝对地址，市场不会请求包内副本）、`out/test`、`AGENTS.md`、`.tsbuildinfo`、`.eslintrc.json` 与上一版 `.vsix`；并删除冗余的 `onView` 激活事件（VS Code 会从 `contributes.views` 自动生成）
- **能读文件就不启子进程**：`hasAnyCommit` 先看 refs 上有没有指针（零提交仓库才回落 `rev-list`），`dropLastCommit` 的脏工作区检查复用同一次 `status --porcelain -z` 解析（不再额外 `status`），`getHeadHash` 直接由 `HEAD` + refs 得出哈希
- **冲突处理不再把用户踢走**：merge/rebase/cherry-pick 停在冲突时直接打开冲突文件（上限 10 个 tab），解决依旧用核心 merge-conflict 扩展的 Accept Current/Incoming 代码透镜；扩展只提供继续/终止入口和顶部持久化状态栏，不再 `executeCommand('workbench.view.scm')` 把人切进内置 Git 的源代码管理视图
- **最低可安装宿主降到 VSCode 1.66**：逐个版本拉 `@types/vscode` 编译 `src` 实测出的真实下限（唯一卡点是文件图标用的 `ColorThemeKind.HighContrastLight`，1.65 报错、1.66 起干净），同时把 `@types/vscode` 从 `^1.85.0` 钉成 `~1.66.0`——caret 会把它装成最新 1.x（实测 1.137），等于版本下限没有任何编译期校验

### 修复

- **在 VS Code 里切分支时面板感知弱**：外部切换的探测原先把 `fs.watch` 绑在 `HEAD` 文件本身——git 是用 `HEAD.lock` + rename 覆写它，Windows 上还能收到事件，macOS/Linux 的 inotify 绑 inode，第一次切换后就变成孤儿监听；而 2s 轮询又只在 watcher 报 `error` 时才启动，孤儿监听并不报错、只是从此静默无事件，于是"切一次还行、后面全不刷新"。现在监听 git 目录并按 `HEAD` 过滤，轮询与监听常开并存（读 `HEAD` 是纯文件读取，不启子进程），任何一路失效另一路仍会跟上
- **linked worktree 下 git 状态读不到**：worktree 的 `.git` 是 `gitdir:` 指针文件、refs 又共享在 `commondir` 指向的公共目录，旧代码拼 `repoPath/.git` 去读 `HEAD`、`MERGE_HEAD`、`rebase-merge`、`CHERRY_PICK_HEAD` 一律落空（冲突/变基状态栏不显示、分支与哈希退回子进程）。新增纯 fs 的 `resolveGitDir()` / `resolveCommonDir()`，所有状态文件读取统一走 worktree 感知路径
- **git log 的位置参数存在参数注入面**：无 shell 的 argv 执行下，旧代码靠静默剥离 `" \` $` 来"消毒"，既会篡改合法分支名又挡不住以 `-` 开头的输入被 git 当成选项（如 hash 搜索框填入 `--output=…`）。现在分支 rev 走 `assertRef`（新增拒绝前导 `-`，合法 ref 本就不允许）、hash 走 `assertHash`，`--grep/--author/--since/--until` 作为选项值原样传递

### 文档

- AGENTS.md 新增「禁止依赖 vscode.git」硬约束与数据替换对照表；README 中英特性清单同步（含"内置 Git 扩展可禁用"）
- 新增回归测试 `noVscodeGit.test.ts`：扫描 `src/**` 拦住重新引用内置 git API 的写法，并校验 `package.json` 不再有 `extensionDependencies`
- **AGENTS.md 三条新硬约束**：不再注册自有 SCM Provider（曾有的 `src/scm/sourceControlProvider.ts` 已整体移除，不要复活，但服务层的 `add/stage/unstage/discard/getStatusEntries` 与伪 ref `index`/`index:<stage>` 规则保留）；`engines.vscode` 不得低于 `@types/vscode` 声明下限否则 `vsce package` 直接报错且无 flag 可绕过；降宿主版本时 `package.json` engines、`package-lock.json` 根节点 engines、`@types/vscode`、README 中英环境要求四处必须同步
- **实测宿主下限的方法写进文档**：从 npmmirror 拉指定版本 `@types/vscode` 的 tarball，用临时 tsconfig 的 `paths` 把 `vscode` 指到该份 typings 编译 `src/**`，报错即下限；同时记录 npm caret 的坑——`^1.66.0` 会被装成最新 1.x（实测 1.137），只有 `~` 才真正钉住并使版本下限具备编译期校验
- **单测覆盖扩充**：`parseStatusEntries` 补 8 例（XY 双状态、rename/copy 源路径、六种冲突码、`!!` 忽略项、`-z` NUL 分隔），内置 git 解耦守卫 2 例；移除 SCM Provider 的 21 个 `scm.*` 双语 key 后，i18n 词典 zh/en key 集一致性（parity）用例照常通过。后又补 `operationFromStateFiles` 4 例（各状态文件对应操作、rebase 优先于 cherry-pick 优先于 merge）与 `isOperationStateFile` 2 例，合计 112 例全绿
- **AGENTS.md 补三条检测硬约束**：进行中操作复检以状态文件被清掉为准、空闲态禁止为"有没有 merge"起子进程；外部历史变更以展示 rev 的 tip 比对为准，且 `_collect` 必须用同一表达式同步基线（否则自己触发的刷新会被下一轮轮询误判成外部变化而重复跑 `git log`）；自动刷新必须带 `preserveSelection`

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
