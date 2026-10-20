# 变更记录

本文件记录 dsh-skills-manager 的版本变更。

## 1.0.0

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
