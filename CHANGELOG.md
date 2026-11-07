# 变更记录

本文件记录 dsh-skills-manager 的版本变更。

## 0.1.0

首个版本。侧边栏「技能」独立面板，集中管理当前加载的全部技能。

### 面板与入口

- 侧边栏导航行「技能」（`sidebar.panellist`，order 30）+ 主面板（`main` keyed，key `skills-manager`），
  与「插件」「自动化任务」「使用统计」同级。主面板自带页骨架：内容列 896px 居中、内层滚动。
- 侧边栏图标为 16px 自绘书本图形，随主题着色；插件 manifest 声明顶层 `icon` 与 `exports["./icon"]`。
- 界面国际化跟随宿主语言：`ctx.locale.register` 注册 zh/en 字典，宿主注入 `t`，切换语言不刷新页面即时生效。

### 技能清单与作用域

- 覆盖三类根：全局 `~/.dsh/skills`、用户级 `~/.agents/skills`、工作区 `<projectRoot>/.dsh|.agents/skills`，
  另含预设自定义目录与随包内置目录。
- 作用域下拉「用户 · 本机」与各工作区；工作区作用域与用户作用域互斥，不混入彼此的技能。
- 同名技能按 rank 裁决，工作区那份优先。
- 切工作区只重扫该工作区；全局扫描结果跨作用域复用（TTL 5 秒）。
- 搜索（名称 / 描述 / 路径）、技能总数与已安装数统计、内置技能按来源分组只读展示。

### 技能详情

- 弹窗展示描述与 SKILL.md 正文（frontmatter 剥离后按 Markdown 渲染），形态与样式对齐 ZCode 技能页。
- 范围（个人 / 项目名 / 内置）、状态（已启用 / 已禁用）、文件路径（行内等宽 + 复制图标）。
- 描述与正文机器翻译，默认开启；技能名作为标识符不翻译，Markdown 结构与代码块原样保留。
  复用宿主 `translator` 服务（由 `dsh-experimental-cot-translation-bundle` 提供），未启用时提示并退回原文。
  长正文按空行分块（单块 ≤ 3500 字符，避开宿主 `maxTextChars=4000` 上限），结果按原文缓存。

### 写操作

- 启停开关：同时写 `disable-model-invocation` 与 `user-invocable`，并清掉旧式调用键
  （`disableModelInvocation` / `modelInvocable` / `userInvocable`）。只写一个键时另一条入口仍然放行，
  技能内容照样被注入，开关形同虚设。
- 从外部 Agent 技能目录导入（Codex CLI / Claude Code / Gemini CLI / Qwen Code / ZCode），
  软链或直接复制，导入到全局或项目；源不合规时复制模式自动归一化，软链模式拒收并说明原因。
- 删除（自绘确认框）、在文件管理器中打开技能目录。
- 写操作后立即清扫描缓存，结果立即可见。

### DSH 加载规则（诊断与归一化）

宿主对 SKILL.md 有硬规则：frontmatter 必须同时有 `name` 与 `description`，缺一个整个文件被忽略；
出现旧式调用键直接判非法；调用键取值必须是布尔。面板按此给每个技能出诊断项
（`missing-name` / `missing-description` / `legacy-invocation-key` / `invalid-invocation-value`），
不合规的技能标「DSH 不加载」并把开关置灰。

### 安全

- 写操作目标由宿主反查，拒绝客户端传入的任意绝对路径；跨站来源与非常规来源地址被拒。
- 删除仅限受管根；软链只删链接不删源；`node_modules` 内的官方包内置技能拒绝改写与删除。
- 非 UTF-8（GBK）的 SKILL.md 拒绝改写；非法 JSON 返回 400、超大请求体返回 413、405 带 `Allow` 头。

### 安装

- 包名 / loader 行 id / client 模块 id 统一为 `@bluechonk/dsh-skills-manager`。
- 仓库自带插件市场索引 `market-index.json`（git 源，锁定 commit）。
- 宿主安装规格解析器接受 GitHub 仓库 URL，装完读 `dsh.bundle.patch` 自动插入 loader 行。

### 验证

- `npm test` 70 项全绿，`npm run check` 语法检查通过。
- 独立验证实例实机核对面板、详情、导入、作用域与写操作全链路，截图见 `docs/images/`。
