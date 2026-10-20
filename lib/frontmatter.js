// SKILL.md 的 YAML frontmatter 解析与「模型可调用」开关改写。
//
// 只做最小必要：解析顶层标量键（含引号、折叠/字面量块），以及在不动其余内容的前提下
// 增删 `disable-model-invocation` 一行。DSH 对该键采用严格布尔语法，禁用写 true 即可。

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

/**
 * 解析 SKILL.md 的 frontmatter。
 * @param {string} text
 * @returns {{ data: Record<string, string>, body: string, hasFrontmatter: boolean } | null}
 */
export function parseFrontmatter(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') return null
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) return null
  const data = {}
  let i = 1
  while (i < end) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!match) {
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
 * @param {string} text 原始 SKILL.md 文本
 * @param {boolean} disabled 是否禁用模型调用
 * @returns {string} 改写后的文本
 */
export function setDisableModelInvocation(text, disabled) {
  const normalized = String(text).replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') {
    throw new Error('SKILL.md 缺少 YAML frontmatter')
  }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('SKILL.md 的 frontmatter 没有闭合')

  const keyLine = /^([A-Za-z0-9_-]+):/.exec(lines[1] ?? '')
  void keyLine
  const index = (() => {
    for (let i = 1; i < end; i += 1) {
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
      if (match && match[1] === 'disable-model-invocation') return i
    }
    return -1
  })()

  if (!disabled) {
    if (index < 0) return normalized
    lines.splice(index, 1)
    return lines.join('\n')
  }
  if (index >= 0) {
    lines[index] = 'disable-model-invocation: true'
    return lines.join('\n')
  }
  lines.splice(end, 0, 'disable-model-invocation: true')
  return lines.join('\n')
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

/** 技能名必须是 kebab-case。 */
export function isValidSkillName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name)
}
