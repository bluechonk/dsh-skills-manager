# dsh-skills-manager

DeepSeek Harness 插件：在**设置页「模型」正下方**新增「技能」分区，集中展示并管理当前实际加载的全部 skill。

![设置页技能分区](docs/images/01-设置页技能分区.png)

## 能力

| 区域 | 说明 |
|---|---|
| 作用域下拉 | 「用户 · 本机」查看全局技能；「工作区」分组列出各工作区，切到某个工作区即查看该项目的技能根 |
| 技能计数 | 顶部「技能 N」为当前作用域可见的技能总数 |
| 搜索 | 按名称、描述、路径实时过滤 |
| 已安装列表 | 名称 + 描述 + 启用开关 + 删除按钮；开关写 `disable-model-invocation`（DSH 原生语义），删除只允许落在受管根之下 |
| 内置分组 | 运行时注册与随包内置的技能只读展示，按来源分组 |
| 详情弹窗 | 描述（frontmatter 的 description，按 **Markdown** 渲染，独立滚动区）、范围（个人/项目）、状态（已启用/已禁用）、文件路径（行内等宽路径 + 复制） |
| 导入 | 从外部 Agent 技能目录（Codex CLI / Claude Code / Gemini CLI / Qwen Code）以「软链」或「直接复制」装进全局或项目根 |

## 覆盖的技能根

| 来源 | 路径 | DSH 标签 | rank |
|---|---|---|---|
| 全局 DSH | `~/.dsh/skills` | `user-dsh` | 400 |
| 全局 Agents | `~/.agents/skills` | `user-agents` | 500 |
| 项目 DSH | `<projectRoot>/.dsh/skills` | `project-dsh` | 100 |
| 项目 Agents | `<projectRoot>/.agents/skills` | `project-agents` | 200 |
| 预设内置 | preset 挂载的自定义目录 | `custom` | 300 |
| 运行时 | 插件注册的内置技能 | `runtime`/`bundled` | — |

`<projectRoot>` 取含 `.git` 的最近祖先目录，没有则取当前工作目录——与官方提供方 `@deepseek-ai/dsh-skill-filesystem` 规则一致。

## 安装

插件以 bundle 形式安装（宿主负责解析依赖、写入 profile 的 `cordis.patch.yml`）：

```bash
plugin_manager install_bundle   # target = 本目录绝对路径
```

启用后刷新 DSH 页面，设置页导航里「技能」出现在「模型」下方。

## 目录结构

```
dsh-skills-manager/
├─ package.json          # dsh.bundle.patch + dsh.client{platform:web}
├─ cordis.patch.yml      # loader 插入行（id: dsh-skills-manager）
├─ lib/index.js          # host 半：根解析、扫描、路由、写操作
├─ lib/roots.js          # 根解析与项目根探测（纯函数）
├─ lib/frontmatter.js    # frontmatter 解析与 disable-model-invocation 改写（纯函数）
├─ client/client.js      # client 半：settings.section 面板 + 详情/导入/新建弹窗
├─ locale/{en,zh}.json   # 插件管理器元数据
├─ icon.svg              # 原创图标
├─ docs/                 # 设计与验证记录、实机截图
└─ test/                 # node:test 纯函数单测
```

## 数据通道

host 半在 `ctx.webServer` 上注册同源只读/写入路由（全部带回环 + 同源守卫，写操作另有方法与体积限制）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dsh-skills-manager/state` | 技能列表、根清单、工作区列表、统计 |
| POST | `/dsh-skills-manager/body` | 单个技能的 frontmatter、正文、文件清单 |
| POST | `/dsh-skills-manager/reveal` | 在系统文件管理器中打开技能目录 |
| POST | `/dsh-skills-manager/toggle` | 启用/禁用（改写 frontmatter） |
| POST | `/dsh-skills-manager/remove` | 删除受管根下的技能 |
| POST | `/dsh-skills-manager/create` | 新建技能目录 |
| POST | `/dsh-skills-manager/import` | 从外部目录导入（软链/复制） |
| GET | `/dsh-skills-manager/external` | 外部 Agent 技能目录扫描 |

路径安全：写操作的目标一律由宿主按「已扫描到的技能」反查得到，**不接受客户端传入的任意绝对路径**；删除仅限受管根，软链只删链接不删源；官方包内置技能（`node_modules` 内）拒绝改写与删除。

## 开发

```bash
npm test          # node:test 纯函数单测
npm run check     # 语法检查
```

## 致谢与许可

本插件的目录扫描、frontmatter 解析与整体形态参考了社区插件 [pengxiaozi/dsh-plugins](https://github.com/pengxiaozi/dsh-plugins) 的 `dsh-skill-panel`（MIT），并在其只读能力之上补齐了范围切换与写操作。

MIT License，见 [LICENSE](LICENSE)。
