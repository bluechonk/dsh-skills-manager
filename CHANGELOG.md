# 变更记录

本文件记录 dsh-skills-manager 的版本变更。

## 0.1.3

写操作后立即可见。

### 修复

- **新建与导入后没清扫描缓存**：新技能要等到全局扫描缓存过期才出现在面板里。现在这两条写操作路由
  都补 `invalidateSkillsCache()`，写完立刻可见。
- **全局扫描缓存 TTL 由 30s 降到 5s**：用户在磁盘上直接放的技能更快出现在面板（写操作仍然立即失效）。

### 验证

- 补回归单测：先热缓存再新建，紧接着读状态就必须能看到该技能。
- 桌面实例（0.1.3）端到端验收 30 项全通过：新建（name + desc + content 都落盘、热缓存后立即可见）、
  启停（写键/删键/面板状态往返一致、旧式调用键被顺手清掉）、导入（软链拒收不合规源、复制补齐 desc、
  导入后立即可见且无兼容性问题）。

## 0.1.2

三个功能补成「真能用」：描述、启停开关、导入外部 Agent 技能。

### 背景：DSH 的加载规则

宿主 `@deepseek-ai/dsh-skill-filesystem` 对 SKILL.md 有硬规则：

1. frontmatter 必须同时有 `name` 与 `description`，**缺一个就整个文件被忽略**；
2. 出现旧式调用键（`disableModelInvocation` / `modelInvocable` / `userInvocable`）直接判非法，**整个文件被忽略**；
3. `disable-model-invocation` / `user-invocable` 的取值必须是布尔。

也就是说：一个没有 description、或带着旧式调用键的技能，**在 DSH 里压根没被加载**——面板里看着在，模型却用不了，
「停用开关」对它也毫无意义。

### 新增

- **诊断**：`diagnoseFrontmatter` 按上面三条规则给每个技能出诊断项（`missing-name` / `missing-description` /
  `legacy-invocation-key` / `invalid-invocation-value`），扫描时随技能一起返回。
- **归一化**：`normalizeSkillFrontmatter` 补 `name` / `description`（没有就从正文派生一句）、删旧式调用键、
  保留其余键；`removeLegacyInvocationKeys` 只做旧键清理。
- **新建技能加「正文（可选）」**：「添加技能」现在是 名称 + 描述 + 内容三件套，正文写进 SKILL.md 正文。
- **导入弹窗重做**：来源可展开，逐个技能展示**名称 + 描述**并单独勾选；不合规的技能标「导入时自动修正」；
  来源为空 / 目录不存在都有明确说明。

### 调整

- **导入**：`copy` 模式落地后自动归一化 frontmatter（补 description、删旧键），导入结果回报 `normalized`；
  `link` 模式不改源文件，遇到不合规的源直接拒收并说明原因。
- **启停开关**：改写 `disable-model-invocation` 的同时清掉旧式调用键——否则 DSH 仍会忽略整个文件，开关等于没用。
- **列表行**：不合规的技能标「DSH 不加载」并把开关置灰（title 说明原因）；已停用的技能标「已停用」。

### 验证

- 导入归一化：缺 description 的外部技能复制导入后 `normalized: ["added-description"]`，落地文件有了描述；
  带旧键的外部技能 `normalized: ["removed-legacy-key"]`；两者导入后都能在面板里正常列出（issues 为空）。
- 软链导入不合规源：HTTP 400 并说明「软链不会修正源文件，请改用直接复制」。
- 开关清旧键：`toggle` 返回 `removedLegacyKeys: ["disableModelInvocation"]`，文件里只剩 `disable-model-invocation: true`。
- 单测新增 5 项（诊断 / 派生描述 / 归一化 / 无 frontmatter 补段 / 旧键清理），共 **66 项全绿**。

## 0.1.1

作用域语义修正 + 支持从 GitHub 链接安装。

### 新增

- 仓库自带插件市场索引 `market-index.json`（git 源，锁定 commit）：在 DSH「设置 → 插件」页粘贴
  `https://raw.githubusercontent.com/bluechonk/dsh-skills-manager/main/market-index.json`，
  Discover 标签里即可看到本插件并一键安装。
- 宿主安装规格解析器本就接受 GitHub 仓库 URL，可直接
  `plugin_manager install_bundle --target "https://github.com/bluechonk/dsh-skills-manager"` 安装。

### 调整

- 版本号与 CHANGELOG 对齐（此前 package.json 仍为 0.1.0）；去掉 `private` 标记，便于后续发到 npm。
- README 补齐三条安装路径（中英双份）：「插件」页「+ 添加插件」粘 GitHub 链接、插件市场索引、工具与命令行。

### 验证

- 工具安装：pnpm 从 codeload.github.com 拉取 tarball 装进 profile 的 `node_modules/@bluechonk/dsh-skills-manager`，
  宿主自动读取 `dsh.bundle.patch` 插入 loader 行，profile 记录
  `dependencies: { "@bluechonk/dsh-skills-manager": "github:bluechonk/dsh-skills-manager" }` 与对应 bundle 行，
  插件随即在设置页可用（`/dsh-skills-manager/state` 返回 36 个技能）。
- 界面安装：在「插件」页点「+ 添加插件」，弹窗提示「输入插件的包名、GitHub 仓库地址或本地目录路径」，
  粘贴仓库链接后界面识别为「Git 仓库」并进入「插件安装中…」，装完「已安装插件」列表出现本插件。
- 市场索引：`market-index.json` 用 DSH 自带的 `parseMarketIndex` 校验通过，
  解析出的安装目标为 `git+https://github.com/bluechonk/dsh-skills-manager.git#f0ffb1c`。

### 调整（作用域）

- **工作区作用域互斥**：选中某个工作区后，只显示该工作区的 `<工作路径>/.dsh/skills` 与 `<工作路径>/.agents/skills`；全局 `~/.dsh/skills`、用户级 `~/.agents/skills` 不再混入。
- **用户作用域**（用户 · 本机）只显示全局 `~/.dsh/skills`、用户级 `~/.agents/skills`、预设自定义目录与随包内置目录。
- 宿主注册表返回的是「全局 + 当前作用域」的合并视图，现在按来源裁剪；根清单也随之只列当前作用域的根。
- 切工作区仍只重扫该工作区（全局扫描结果缓存 30s，切回来直接复用）。

### 验证（作用域）

实测（桌面实例）：用户作用域 36 个技能（user-agents 24 + custom 4 + bundled 8）；工作区 modelmux 4 个（log-triage、mx-cli、reasonix-mx-test、repo-sync，仅来自该工作区的 `.agents/skills`），互不混入。回归单测同步更新，单测共 61 项全绿。

## 1.1.0

界面国际化：跟随 DSH 的语言设置自动切换中英文。

### 新增

- 客户端内置 zh/en 词典（100+ 条文案），覆盖分区标题、工具条、列表、分组标题、详情/导入/新建/删除弹窗、状态与错误提示。
- 宿主错误响应新增稳定 `code` 与 `params`，客户端按 code 取对应语言文案（无 code 时退回原文）。
- `README.en.md` 英文版文档；`README.md` 顶部加语言切换入口。

### 调整

- **改用宿主官方 i18n 机制**（与 dsh-usage-stats 一致）：`ctx.locale.register(ns, {zh, en})` 注册字典，分区注册项声明 `locale: ns`，宿主注入 `t` prop（引用随语言切换而变 → 自动重渲染）；`inject = ["slots", "locale"]`。
- 修掉「不跟随 DSH 语言设置」的问题：初版自己读浏览器语言（`document.documentElement.lang` / `navigator.language`），会被浏览器语言钉死；现在在「设置 → 通用设置 → 语言」里切换，**不刷新页面**本分区立即跟着变（中 ⇄ 英双向验证）。

### 验证

运行时双向切换实拍（`docs/images/07-英文界面.png`、`09-切回中文.png`）；英文详情弹窗 `docs/images/08-英文详情弹窗.png`；i18n 单测覆盖词典键一致、无空文案、占位符插值、兜底翻译器，**单测共 61 项全绿**。

## 1.0.3

作用域扫描优化。

### 调整

- 切换到工作区作用域时**只重扫该工作区**的 `<projectRoot>/.dsh/skills` 与 `<projectRoot>/.agents/skills`；
  全局根（`~/.dsh/skills`、`~/.agents/skills`、预设内置目录）的扫描结果跨作用域复用（缓存 30s，写操作后失效）。
- 同名技能按 rank 裁决：工作区那份优先于全局那份。
- 设置页「刷新」按钮改为携带 `refresh=1`，绕过两级缓存强制重扫磁盘。

### 实测

首次进入用户作用域 170ms；切到工作区 8ms（36 全局 + 4 工作区技能）；切回用户作用域 4ms。

## 1.0.2

设计对齐与功能增强。

### 新增

- 详情弹窗展示 **SKILL.md 正文**（frontmatter 剥离后的内容），按 Markdown 渲染成可滚动卡片，形态对齐 Codex 的技能页；标题右侧新增「Skill」徽章。
- 文档新增「ZCode 设计对齐」章节与 ZCode 实测取材（`docs/reference/`）。

### 调整

- 样式按 ZCode 实测参数重写：标题 30px/600、工具条 justify-between、作用域按钮 28px 胶囊、搜索框 36px/12px/256px、卡片 12px 无描边、行高 65px、图标块 36px、开关 32×18（开=前景色轨 + 背景色钮）。
- 分层底色改用 `color-mix(label-primary, %)`：DSH 浅色主题下 `bg-layer-1/layer-2` 都是纯白，直接用会让卡片与图标块消失。
- 弹窗遮罩与阴影按 ZCode 用固定黑色（两套主题一致）。

## 1.0.1

代码评审后的修复版本。

### 修复

- 宿主：删除根目录下平铺的 `skill.md` 不再连整个技能根一起删；非 UTF-8（GBK）的 SKILL.md 拒绝改写；跨根同名技能按 rank 裁决；块标量里的 `---` 不再截断 frontmatter；项目落点与 `cwd` 只认已登记工作区；写操作补真实路径二次校验与「禁删受管根本身」；非法 JSON 返回 400、超大请求体返回 413、405 带 `Allow` 头；技能清单加 TTL 缓存；日志轮转。
- 客户端：修复导致 client 模块加载失败的语法残留；导入弹窗的目标/已安装标记/逐条导入/复选框/选择键修正；作用域竞态修复；自定义目录不再被误判只读；弹窗焦点管理与 Escape 隔离；删除改为自绘确认框；样式全部改用 `--dsw-alias-*` 令牌；列表行支持键盘。

### 新增

- HTTP 层单测 10 项、客户端纯函数单测 8 项、回归用例若干（单测总计 52 项）。
- `.github/workflows/ci.yml`：Node 22 / 24 语法检查与单测。

## 0.1.0

首个正式版本。

### 新增

- 设置页新增「技能」分区（`settings.section`，`id: dsh-skills-manager`，`order: 11`），位置紧贴「模型」下方。
- 技能清单覆盖三类根：全局 `~/.dsh/skills`、全局 `~/.agents/skills`、项目/工作区 `<projectRoot>/.dsh|.agents/skills`，另含 preset 内置目录与运行时内置技能。
- 作用域下拉：「用户 · 本机」与各工作区切换，工作区清单取自宿主 `workspaceRegistry`。
- 搜索（名称 / 描述 / 路径）、技能总数与已安装数统计、内置技能按来源分组只读展示。
- 技能详情弹窗：描述按 Markdown 渲染、范围（个人 / 项目名 / 内置）、状态（已启用 / 已禁用）、文件路径（行内等宽路径 + 复制图标）。
- 写操作：启用 / 禁用（改写 `disable-model-invocation`）、新建、删除、从外部 Agent 技能目录导入（软链 / 直接复制，导入到全局或项目）、在文件管理器中打开技能目录。
- 「导入外部 Agent 技能」弹窗：外部目录发现（Codex CLI / Claude Code / Gemini CLI / Qwen Code）、全选与已选计数、软链与直接复制切换、导入目标切换。
- 宿主半注册同源只读/写入路由 `/dsh-skills-manager/*`，全部带回环 + 同源守卫。

### 标识

- npm 包名、loader 行 id、client 模块 id 统一为 `@bluechonk/dsh-skills-manager`。

### 安全

- 写操作目标由宿主反查，拒绝客户端传入的任意绝对路径。
- 删除仅限受管根；软链只删链接不删源；`node_modules` 内的官方包内置技能拒绝改写与删除。
- 启停写的是跨工具通用的 `disable-model-invocation` 键，界面上已注明。

### 验证

- 单测 21 项全绿；`node --check` 全通过。
- 独立 web 实例实机截图核对：设置页分区、详情弹窗、更多菜单、导入弹窗、作用域下拉。
- 写操作端到端自检：新建 → 禁用 → 启用 → 删除，全部通过且无残留。
