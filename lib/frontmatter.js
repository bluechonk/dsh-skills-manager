// SKILL.md 的 YAML frontmatter 解析与「模型可调用」开关改写。
//
// 只做最小必要：解析顶层标量键（含引号、折叠/字面量块），以及在不动其余内容的前提下
// 增删 `disable-model-invocation` 一行。DSH 对该键采用严格布尔语法，禁用写 true 即可。
//
// 两条硬约束（都是踩过的坑）：
//  1. frontmatter 的结束标记必须是行首的 `---`；块标量里缩进的 `---` 是内容，不是结束标记。
//  2. 写回必须保真：保留 BOM 与原换行风格（CRLF / LF），否则一次开关就会把用户整份
//     SKILL.md 的行尾改掉（Windows 上尤其刺眼）。

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 判断是否为 DSH 认可的「禁用模型调用」布尔写法。 */
export function isDisabledFlag(value) {
  if (value === undefined || value === null) return false
  const text = String(value).trim().toLowerCase()
  return text === 'true' || text === 'yes' || text === 'on' || text === '1'
}

/**
 * 解析布尔字面量；无法识别时返回 undefined（交由调用方取缺省语义）。
 * @param {string | undefined} value
 * @returns {boolean | undefined}
 */
export function parseBoolean(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim().toLowerCase()
  if (text === '') return undefined
  if (text === 'true' || text === 'yes' || text === 'on' || text === '1') return true
  if (text === 'false' || text === 'no' || text === 'off' || text === '0') return false
  return undefined
}

/** 去引号并还原转义。 */
function parseScalar(value) {
  let text = value.trim()
  if (text === '') return ''
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const quote = text[0]
    text = text.slice(1, -1)
    if (quote === '"') text = text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    return text
  }
  return text
}

/** 按行拆分（不改动行尾内容，换行风格另行判定）。 */
function splitLines(text) {
  return String(text).replace(/\r\n/g, '\n').split('\n')
}

/**
 * 找出 frontmatter 的结束行下标；找不到返回 -1。
 *
 * 结束标记必须是行首的 `---`（不允许前导空白）：块标量（`key: |`）里的 `---` 是缩进的内容，
 * 早先按 trim() 比较会把缩进的 `---` 当成结束标记，导致 description 被截断、
 * 开关键被插进 description 块里（技能开关静默失效且 YAML 被写坏）。
 * @param {string[]} lines
 */
export function findFrontmatterEnd(lines) {
  if (lines.length === 0 || lines[0].trim() !== '---') return -1
  for (let i = 1; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i])) return i
  }
  return -1
}

/**
 * 解析 SKILL.md 的 frontmatter。
 * @param {string} text
 * @returns {{ data: Record<string, string>, body: string, hasFrontmatter: boolean } | null}
 */
export function parseFrontmatter(text) {
  const lines = splitLines(text)
  const end = findFrontmatterEnd(lines)
  if (end < 0) return null
  const data = {}
  let i = 1
  while (i < end) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!match || /^\s/.test(lines[i])) {
      i += 1
      continue
    }
    const key = match[1]
    const rest = match[2]
    i += 1
    if (/^[>|][+-]?$/.test(rest.trim())) {
      const folded = rest.trim().startsWith('>')
      const block = []
      while (i < end && (lines[i].startsWith(' ') || lines[i].startsWith('\t') || lines[i].trim() === '')) {
        block.push(lines[i])
        i += 1
      }
      const nonEmpty = block.filter((line) => line.trim() !== '')
      const indent = nonEmpty.length > 0 ? Math.min(...nonEmpty.map((line) => (line.match(/^\s*/) || [''])[0].length)) : 0
      const stripped = block.map((line) => line.slice(Math.min(indent, (line.match(/^\s*/) || [''])[0].length)))
      data[key] = folded ? stripped.join(' ').replace(/\s+/g, ' ').trim() : stripped.join('\n').trim()
      continue
    }
    data[key] = parseScalar(rest)
  }
  const body = lines.slice(end + 1).join('\n')
  return { data, body, hasFrontmatter: true }
}

/**
 * 设置或移除 `disable-model-invocation`，其余内容逐字保留。
 * 禁用时写 `disable-model-invocation: true`；启用时整行删除（缺省即允许）。
 *
 * 写回必须保真：保留原文件的 BOM 与换行风格（CRLF / LF），否则一次开关就会把
 * 用户整份 SKILL.md 的行尾改掉（Windows 上尤其刺眼）。
 * @param {string} text 原始 SKILL.md 文本
 * @param {boolean} disabled 是否禁用模型调用
 * @returns {string} 改写后的文本
 */
export function setDisableModelInvocation(text, disabled) {
  const source = String(text)
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = bom ? source.slice(1) : source
  const eol = dominantEol(body)
  const lines = body.split(/\r\n|\n/)
  const end = findFrontmatterEnd(lines)
  if (end < 0) throw new Error('SKILL.md 缺少 YAML frontmatter')

  let index = -1
  for (let i = 1; i < end; i += 1) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (match && match[1] === 'disable-model-invocation') {
      index = i
      break
    }
  }

  if (!disabled) {
    if (index < 0) return source
    lines.splice(index, 1)
    return bom + lines.join(eol)
  }
  if (index >= 0) {
    lines[index] = 'disable-model-invocation: true'
    return bom + lines.join(eol)
  }
  lines.splice(end, 0, 'disable-model-invocation: true')
  return bom + lines.join(eol)
}

/**
 * 判定主导换行风格：出现次数多的那种胜出；没有换行时按 LF。
 * （混合换行的文件不该被整体归一化到另一种风格。）
 * @param {string} text
 * @returns {"\r\n" | "\n"}
 */
export function dominantEol(text) {
  const source = String(text)
  const crlf = (source.match(/\r\n/g) || []).length
  const lf = (source.match(/(?<!\r)\n/g) || []).length
  return crlf > lf ? '\r\n' : '\n'
}

/** 从 frontmatter 派生技能的调用策略（与 DSH 的解析语义一致）。 */
export function invocationOf(frontmatter) {
  const data = frontmatter && typeof frontmatter.data === 'object' ? frontmatter.data : {}
  // disable-model-invocation: true 才禁用模型调用；user-invocable: false 才禁掉用户调用。
  const modelDisabled = parseBoolean(data['disable-model-invocation']) === true
  const userDisabled = parseBoolean(data['user-invocable']) === false
  return {
    modelInvocable: !modelDisabled,
    userInvocable: !userDisabled,
  }
}

/** 技能名必须是 kebab-case，且长度受限（避免 ENAMETOOLONG）。 */
export function isValidSkillName(name) {
  return typeof name === 'string' && name.length <= 64 && NAME_PATTERN.test(name)
}

/**
 * 判断一段字节是否是「可无损按 UTF-8 解码」的文本。
 * 非 UTF-8（如 GBK）的 SKILL.md 一旦按 UTF-8 读写，中文会变成 U+FFFD 且不可逆，
 * 因此改写前必须先过这一关。
 * @param {Buffer} buffer
 */
export function isLosslessUtf8(buffer) {
  if (!Buffer.isBuffer(buffer)) return false
  return Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer)
}

/* ------------------------------------------------------------------ */
/* DSH 兼容性：DSH 认哪些键、拒哪些键                                  */
/* ------------------------------------------------------------------ */

/**
 * DSH 不认的旧式调用键。宿主的 skill-filesystem 见到其中任意一个就**整个文件忽略**
 * （legacy key 直接抛错），于是技能「看起来在、其实没被加载」。
 */
export const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']

/** DSH 认的调用策略键（布尔值必须是 true / false）。 */
const CANONICAL_INVOCATION_KEYS = ['disable-model-invocation', 'user-invocable']

/**
 * 诊断一个 frontmatter 是否能被 DSH 加载。
 *
 * DSH 的硬规则（见 @deepseek-ai/dsh-skill-filesystem）：
 *  1. frontmatter 必须同时有 `name` 与 `description`，否则整个文件被忽略；
 *  2. 出现旧式调用键（disableModelInvocation / modelInvocable / userInvocable）直接判为非法；
 *  3. `disable-model-invocation` / `user-invocable` 的取值必须是布尔。
 * @param {{ data?: Record<string, string> } | null} frontmatter
 * @returns {{ issues: string[], legacyKeys: string[], invalidBooleans: string[], loadable: boolean }}
 */
export function diagnoseFrontmatter(frontmatter) {
  const data = frontmatter && typeof frontmatter.data === 'object' ? frontmatter.data : {}
  const legacyKeys = LEGACY_INVOCATION_KEYS.filter((key) => Object.hasOwn(data, key))
  const invalidBooleans = CANONICAL_INVOCATION_KEYS.filter(
    (key) => Object.hasOwn(data, key) && parseBoolean(data[key]) === undefined,
  )
  const missingName = typeof data.name !== 'string' || data.name.trim() === ''
  const missingDescription = typeof data.description !== 'string' || data.description.trim() === ''
  const issues = []
  if (missingName) issues.push('missing-name')
  if (missingDescription) issues.push('missing-description')
  if (legacyKeys.length > 0) issues.push('legacy-invocation-key')
  if (invalidBooleans.length > 0) issues.push('invalid-invocation-value')
  return { issues, legacyKeys, invalidBooleans, missingName, missingDescription, loadable: issues.length === 0 }
}

/**
 * 从正文派生一句描述：DSH 要求技能必须有 description，外部技能常常没有。
 * 取第一个标题（去掉 # 标记）或第一段非空文字，截到 200 字。
 * @param {string} body 正文
 * @param {string} fallback 派生不出来时用的兜底文案
 * @returns {string}
 */
export function deriveDescription(body, fallback) {
  const lines = String(body || '').split(/\r\n|\n/)
  const paragraph = []
  for (const line of lines) {
    const text = line.trim()
    if (text === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (text.startsWith('#')) {
      const heading = text.replace(/^#+\s*/, '').trim()
      if (heading !== '') return heading.slice(0, 200)
      continue
    }
    if (text.startsWith('```') || text.startsWith('|') || text.startsWith('---')) continue
    paragraph.push(text)
  }
  if (paragraph.length > 0) return paragraph.join(' ').replace(/\s+/g, ' ').slice(0, 200)
  return String(fallback || '').slice(0, 200)
}

/**
 * 序列化 frontmatter 的一行：含 YAML 特殊字符时用 JSON 字符串（DSH 的 YAML 解析器认）。
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function frontmatterLine(key, value) {
  const text = String(value)
  const needsQuote = text === ''
    || /^[\s>|*&!%@`?:-]/.test(text)
    || /:\s/.test(text)
    || /\s#/.test(text)
    || /["'{}[\],&]/.test(text)
    || /\n/.test(text)
    || /^(true|false|null|~|yes|no|on|off)$/i.test(text)
    || /^-?\d+(\.\d+)?$/.test(text)
  return needsQuote ? key + ': ' + JSON.stringify(text) : key + ': ' + text
}

/**
 * 归一化一份 SKILL.md 的 frontmatter，让 DSH 能加载它：
 *  - 缺 `name` → 用给定名字补上；
 *  - 缺 `description` → 用给定描述，或从正文派生一句；
 *  - 移除 DSH 不认的旧式调用键（留着会让整个文件被忽略）；
 *  - 其余键原样保留，顺序不变。
 *
 * 正文逐字保留；BOM 与换行风格保持原样。
 * @param {string} text 原始 SKILL.md 文本
 * @param {{ name?: string, description?: string }} options
 * @returns {{ text: string, changes: string[], description: string }}
 */
export function normalizeSkillFrontmatter(text, options = {}) {
  const source = String(text)
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = bom ? source.slice(1) : source
  const eol = dominantEol(body)
  const lines = body.split(/\r\n|\n/)
  const end = findFrontmatterEnd(lines)
  const changes = []
  if (end < 0) {
    // 完全没有 frontmatter：整段补一个。
    const name = String(options.name || '').trim()
    const description = String(options.description || '').trim() || deriveDescription(body, name + ' 技能')
    const rebuilt = ['---', frontmatterLine('name', name), frontmatterLine('description', description), '---', '']
    return { text: bom + rebuilt.join(eol) + body, changes: ['added-frontmatter', 'added-name', 'added-description'], description }
  }

  const parsed = parseFrontmatter(body)
  const data = parsed ? parsed.data : {}
  const kept = []
  for (const [key, value] of Object.entries(data)) {
    if (LEGACY_INVOCATION_KEYS.includes(key)) continue
    if (key === 'name' || key === 'description') continue
    kept.push([key, value])
  }
  let name = typeof data.name === 'string' ? data.name.trim() : ''
  if (name === '') {
    name = String(options.name || '').trim()
    if (name !== '') changes.push('added-name')
  }
  let description = typeof data.description === 'string' ? data.description.trim() : ''
  if (description === '') {
    // 只从正文派生：frontmatter 里的行不算正文，否则会派生出 "name: demo" 这种废话。
    description = String(options.description || '').trim() || deriveDescription(lines.slice(end + 1).join(eol), name + ' 技能')
    changes.push('added-description')
  }
  for (const key of LEGACY_INVOCATION_KEYS) {
    if (Object.hasOwn(data, key)) changes.push('removed-legacy-key')
  }
  const rebuilt = ['---', frontmatterLine('name', name), frontmatterLine('description', description)]
  for (const [key, value] of kept) rebuilt.push(frontmatterLine(key, value))
  rebuilt.push('---')
  const rest = lines.slice(end + 1)
  return { text: bom + rebuilt.concat(rest).join(eol), changes: [...new Set(changes)], description }
}

/**
 * 移除 DSH 不认的旧式调用键（逐行删除，其余内容逐字保留）。
 * 开关操作顺手做这件事：留着旧键的技能，DSH 会整个忽略，开关就等于没用。
 * @param {string} text 原始 SKILL.md 文本
 * @returns {{ text: string, removed: string[] }}
 */
export function removeLegacyInvocationKeys(text) {
  const source = String(text)
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = bom ? source.slice(1) : source
  const eol = dominantEol(body)
  const lines = body.split(/\r\n|\n/)
  const end = findFrontmatterEnd(lines)
  if (end < 0) return { text: source, removed: [] }
  const removed = []
  const kept = []
  for (let i = 0; i <= end; i += 1) {
    const line = lines[i]
    if (i > 0 && i < end) {
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
      if (match && LEGACY_INVOCATION_KEYS.includes(match[1])) {
        removed.push(match[1])
        continue
      }
    }
    kept.push(line)
  }
  // frontmatter 之后的正文必须原样留下。
  for (let i = end + 1; i < lines.length; i += 1) kept.push(lines[i])
  if (removed.length === 0) return { text: source, removed: [] }
  return { text: bom + kept.join(eol), removed }
}
