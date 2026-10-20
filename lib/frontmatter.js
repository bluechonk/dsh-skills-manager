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
