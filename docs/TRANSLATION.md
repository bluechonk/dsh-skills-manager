# 技能详情机器翻译：核心实现与设计理念

技能正文与描述以英文为主，读起来慢。详情弹窗默认把 **description 与 SKILL.md 正文**译成中文，
技能 `name` 保持原样（它是标识符，翻译后就没法按名字调用了）。

本文只讲翻译这一块：谁负责什么、请求怎么走、状态怎么收敛，以及几条不能越过的取舍。
整体面板与其余功能的记录见 [DESIGN-AND-VERIFICATION.md](./DESIGN-AND-VERIFICATION.md)。

## 1. 一句结论

**翻译本身只是「把一段文本 POST 到一个 URL，把返回里的译文取出来」——一发普通 HTTP 请求。**

具体到默认通道（Bing）：

```
POST https://edge.microsoft.com/translate/translatetext?to=zh-Hans&isEnterpriseClient=false
content-type: application/json

["Hello, this is a test."]
→ [{"translations":[{"text":"你好，这是一个测试。"}]}]
```

不需要 API key、不需要账号、不消耗模型额度，就是个公开免费端点。
没有任何「模型在翻译」的成分：没调 LLM，没走 DeepSeek。

**这发请求不是本插件发的，是宿主的 `translator` 服务发的。**
宿主侧 `translator` 服务由 `dsh-experimental-cot-translation-bundle`
（`@deepseek-ai/dsh-experimental-translator`）提供，与「思考过程机器翻译」同一套
provider、端点、超时与限额配置。插件只做三件外围事：代发一次同源请求、把长文本切开、
把结果缓存起来。

这条分工决定了后面所有细节：插件里没有第二套 HTTP 客户端、没有第二份密钥、
没有第二个超时口径，也没有「插件自己该选哪个 provider」这种需要维护的判断。

## 2. 三层职责

| 层 | 位置 | 负责 | 不负责 |
|---|---|---|---|
| 宿主 `translator` 服务 | `@deepseek-ai/dsh-experimental-translator` | provider 选路、端点、超时、`maxTextChars` / `maxResponseBytes` 限额、错误码归一 | 什么时候译、译哪几段 |
| 插件主机半 | `lib/index.js:926-947` | 一条同源路由，把 `{text, targetLanguage}` 交给 `translator` | 选 provider、做缓存、做切块 |
| 插件客户端半 | `client/client.js:437-487` | 按宿主上限分块、结果缓存、串行调度、译文/原文切换 | 直接联网翻译 |

## 3. 主机半：只做转发适配

路由 `POST /dsh-skills-manager/translate`，注册点见 `lib/index.js:1193`。

请求 `{ text, targetLanguage }`，`targetLanguage` 缺省为 `zh`；空文本直接返回
`{ ok: true, text: '' }`，不打到上游 —— 空串走一趟翻译服务没有任何收益，只会把超时与
限额的风险白白摊上去。

拿到服务后的动作只有两步：

```
ctx.get('translator') → translator.resolve({ text, targetLanguage }) → translator.translate(spec)
```

`resolve()` 负责补 sourceLanguage 默认值（`auto`）与 provider 默认值，并在文本超过
`maxTextChars` 时先抛出 `TRANSLATION_TEXT_LIMIT` —— 所以超限失败发生在**任何网络请求之前**。
`translate()` 才真正发请求。

三种失败各有出口：

| 情形 | 返回 | 为什么 |
|---|---|---|
| 服务不存在（未启用该 bundle） | `503` + code `translator-unavailable` | 这是「能力没装」，不是「翻译坏了」；客户端据此提示并退回原文 |
| `TranslationError`（带稳定 `code`） | `502` + 原始 code | 错误码是宿主与插件之间的契约面，原样透传，本地化留给客户端 |
| 其他异常 | `502` + code `translation-failed` | 兜底，不吞掉 |

**插件不传 `provider`，也不传 `sessionId`。** 原因在宿主的选路规则里：匿名通道
（`bing` / `google`）不需要会话，而付费通道 `deepseek-account` / `deepseek-official`
的 `resolve()` 在没有 `sessionId` 时会直接抛 `TRANSLATION_SESSION_REQUIRED`。
详情弹窗不属于任何会话，硬塞一个会话 ID 只会把「翻译一个技能」绑到某次对话的生命周期上。
于是本插件固定走宿主配置里的默认 provider（默认 `bing`），把「用哪条通道」完整交回给
宿主的配置面。

### 3.1 底层一次请求长什么样

宿主内部把 `spec` 转成一次普通 HTTP POST。默认的 Bing 通道（`anonymousRecipe` 与
`requestFor` 的 `bing` 分支，见 `dsh-experimental-translator` 的 `lib/index.js:148-162`）：

```
POST https://edge.microsoft.com/translate/translatetext?to=zh-Hans&isEnterpriseClient=false
content-type: application/json

["要翻译的那段文本"]
```

响应是一个数组，译文在 `payload[0].translations[0].text`（取值逻辑见同一个文件
`:182-187`）。**没有 API key、没有鉴权头、没有 cookie**（抓取时显式 `credentials: "omit"`），
也不跟随重定向（`redirect: "error"`）—— 这就是「公开免费翻译端点」的全部。

实测（2026-11-05，直连该端点）：

```
POST https://edge.microsoft.com/translate/translatetext?to=zh-Hans&isEnterpriseClient=false
["Hello world, this is a test of the translation endpoint."]

→ 200
[{"detectedLanguage":{"language":"en","score":1.0},
  "translations":[{"text":"你好，这里是翻译端点的测试。","to":"zh-Hans",...}]}]
```

`srcSentLen` / `transSentLen` 是上游给的分句长度信息，本插件不用，只取 `text`。

换成 Google 通道则是另一套形状（`lib/index.js:129-147`）：

```
POST https://translate.googleapis.com/translate_a/single
content-type: application/x-www-form-urlencoded

client=gtx&sl=auto&tl=zh-CN&dt=t&q=要翻译的那段文本
```

响应同样是嵌套数组，`payload[0]` 是分句数组，把每段的第 0 项拼起来就是译文。

所以三层加起来的真实链路是：

```
详情弹窗 → POST /dsh-skills-manager/translate（本机同源路由）
        → translator.translate(spec)
        → POST https://edge.microsoft.com/translate/translatetext
        ← JSON → payload[0].translations[0].text
```

插件写的那条路由做的事，就是把「一次跨域 HTTPS POST」包装成一次同源调用：
浏览器的详情弹窗不直接打到微软的域名（跨域、被 CSP 拦、还暴露端点），
而是请本机的主机半代发。

所以「翻译功能」的复杂度不在翻译本身——那只是一发 POST——而在它外围的这些东西：
文本超 4000 字符要切开、切开的几段要拼回去、同一个技能反复开关弹窗不能反复请求、
外部免费端点会超时会返回非 200、没装机翻 bundle 时不能假装成功。这些才是第 4 节的内容。

## 4. 客户端：分块、缓存、状态机

### 4.1 分块

```
TRANSLATE_TARGET     = "zh"     // 技能正文以英文为主
TRANSLATE_CHUNK_CHARS = 3500    // 宿主 maxTextChars 默认 4000，留 500 字符余量
```

`translationChunks(text, limit)`（`client/client.js:448-470`）按**空行**切，
理由是 Markdown 的段落边界就是语义边界：在空行处切开，上游收到的仍是完整段落，
而不是被腰斩的半句。

- 段落累计到超过 `limit` 就先吐出上一块；
- 单段本身超长（比如一大段没有空行的代码块说明）做硬切，保证任何一块都不超限；
- 末尾过滤掉纯空白块 —— 空块发给上游只会换来一次无意义的往返。

切块是**不丢内容**的：把所有块拼回来与原文只差换行，单测里直接断言这一点
（`test/client.test.mjs:168-189`）。

### 4.2 缓存与调度

缓存 key 是 `目标语言 + "\n" + 原文`（`client/client.js:474`）。用原文而不是技能名做
key，是因为同一个技能名可能有多个字段要译（描述、正文），也因为它天然解决了
「技能内容改了一行、旧译文不该复用」的问题 —— 原文一变，key 就不命中。

命中就直接返回，`translateText()` 里逐块**串行**发请求再 `join("")`。串行不是保守，
而是刻意：宿主的匿名通道是外部免费端点，并发几块只会把限流风险放大，
而这个场景（打开一个弹窗）对延迟本来就不敏感。

缓存的载体是一个模块级 `Map`，生命周期等于页面会话：刷新即清空，不落盘、不写库。
译文是「看」的东西，不是要留档的数据。

### 4.3 何时翻、译什么

详情弹窗的 `useEffect`（`client/client.js:962-986`）在四种变化下重跑：
技能切换、工作区切换、翻译开关、`/body` 返回。描述与正文用 `Promise.all` 并行译——
两段互不依赖，串起来只会让「翻译中…」多停一倍时间。

`name` 不在翻译清单里。范围、状态、文件路径也不译：它们是界面语言的一部分，
跟着宿主语言走，不是技能内容。

### 4.4 展示状态机

`translateOn` 默认 `true`（`client/client.js:922`）。四种情况一律回落原文：

```
showTranslated = translateOn && !showOriginal && !translating && !translateError && hasTranslation
```

即**翻译中 / 失败 / 开关关掉 / 正在看原文**都不显示译文。这不是保守，是「原文永远可读」
的硬保证：任何一种中间态都不该让用户面对空白或半截译文。

同时在状态条上给出可见反馈（`client/client.js:1010-1022`）：「翻译中…」→「译文」+「看原文」
链接，或本地化错误文案。标题栏另有一个「翻译」开关整体关掉翻译。

失败时**整体回退原文，不做部分混排** —— 描述译好了、正文失败，绝不显示「中文描述 + 英文正文」
这种半成品：读者无法判断哪一半可信。

### 4.5 错误码到文案

宿主抛的是稳定 `code`（`TRANSLATION_TIMEOUT` / `TRANSLATION_TEXT_LIMIT` /
`TRANSLATION_HTTP_ERROR` / `TRANSLATION_INVALID_RESPONSE` / `TRANSLATION_REQUEST_FAILED`
等），客户端字典按 `"error." + code` 查本地化文案（`client/client.js:615-621`、
`localizeError` 见 `client/client.js:795-802`）。查不到才退回 `error.message`。

这样宿主新增错误码时插件不会显示裸英文，也不会静默 —— 最差是显示服务端给的诊断句。

## 5. 设计理念

### 5.1 复用，不自建

翻译是宿主已有的能力：端点、超时、限额、错误码、语言标签归一（`zh` → `zh-Hans` / `zh-CN`）
全在 `translator` 服务里。插件自建一条通道意味着自己维护端点 URL、自己处理各家的响应格式差异、
自己定义超时与失败语义，而且宿主改配置时两边会漂移。

复用之后有一个副作用是**好的**：技能翻译与思考过程机翻共用同一份 provider 配置，
用户在设置里调一次，两处一起变。

### 5.2 可选依赖：缺了就是降级，不是报错

`translator` 是 `ctx.get()` 拿的可选服务，不是 `inject` 的硬依赖。服务不在时插件**照常工作**
——列表、详情、启停、导入、删除全部正常，只有翻译退化为原文并给一句提示。

把可选能力做成硬依赖是这类插件最常见的自伤：用户只想管技能，凭什么必须装机翻 bundle？
反过来，硬依赖一旦缺失，整个面板会一起消失 —— 代价与收益完全不对称。

### 5.3 原文是唯一事实源

译文只活在内存里，**绝不回写 SKILL.md**。理由有三条：

1. SKILL.md 是模型读取的技能本体，机器翻译会破坏其中的触发词、路径、代码示例；
2. 写了就不可逆 —— 用户下次看到的「原文」其实是上一次的译文；
3. 译文质量依赖外部服务，把不可控的输出固化进磁盘文件是最差的持久化决策。

### 5.4 权限与限额都留在宿主

插件不上调 `maxTextChars`，不绕过 `maxResponseBytes`，不自己加超时。切块大小是
按宿主默认值减余量算出来的常量（3500 vs 4000），而不是猜出来的经验值 ——
超出限额的失败由宿主在**发请求前**抛出，插件只需保证自己切出来的块不越界。

### 5.5 失败必须可见

三条线同时成立才算合格：不吞异常（错误码原样上抛）、不静默（状态条有提示）、
不阻断（原文照常可读）。空 `catch` 在这个功能里没有任何位置。

### 5.6 不做的事

- **不翻 `name`**：标识符，翻了就不能按名字调用。
- **译不了就退回原文**，不给「部分译文」。
- **不缓存到磁盘**：刷新即失效，宁可不持久也不留陈旧译文。

## 6. 一次翻译的完整数据流

1. 点开技能行 → 客户端 `POST /body` 拿回 `frontmatter.description` 与正文
2. `translateOn` 默认 `true` → `Promise.all([translateText(desc), translateText(body)])`
3. `translateText()` 先查缓存；未命中则 `translationChunks()` 切块，逐块
   `POST /translate`
4. 主机半 `ctx.get('translator')` → `resolve()` → `translate()` → 译文回传
5. 客户端 `setTranslated()` → `showTranslated` 条件成立 → Markdown 渲染译文
6. 点「看原文」→ `showOriginal` 为真 → 渲染原文，链接变「看译文」

## 7. 已知边界

| 边界 | 说明 |
|---|---|
| 只译描述与正文 | 范围、状态、路径跟随界面语言，属于 UI 文案而非技能内容 |
| 缓存不落盘 | 刷新页面即失效，同一技能重新打开会再译一次 |
| 失败整体回退 | 不做部分混排，一段失败则两段都显示原文 |
| 付费通道未接入 | `deepseek-account` / `deepseek-official` 需要 `sessionId`，详情弹窗没有会话 |
| 未做术语表 | 专有名词按服务商的通用译法，插件不干预 |
| 未做流式 | 整段拿到再渲染；对「读一个技能」这个场景，分段闪现反而更乱 |

## 8. 验证

| 项 | 结果 |
|---|---|
| 端点直连实测 | 2026-11-05 直连 Bing 公开端点，POST 一句英文返回 `200` 与中文译文（报文见 3.1） |
| 分块单测 | 3 项：长文本按空行切且不丢内容、短文本/空文本安全、单段超长硬切（`test/client.test.mjs:168-189`） |
| 全量测试 | 70 项全绿（`npm test`） |
| 隔离实例实机 | `web` profile + patch 注入 translator / cot-translation / 本插件，1440×900 |
| 翻译效果 | 英文技能的描述与正文均译为中文，`name` 保持英文，Markdown 结构保留 |
| 对照开关 | 「看原文」切回英文，链接变「看译文」；标题栏「翻译」按钮可整体关闭 |
| 截图 | [docs/images/11-skill-detail-translation.png](images/11-skill-detail-translation.png) |

未复验：`translator-unavailable` 的降级路径需要在**未启用**该 bundle 的 profile 里跑，
验证实例显式注入了该 bundle。
