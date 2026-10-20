// client.test.mjs —— client/client.js 的 __pure 直测面（零 DOM、零 npm 依赖）。
//
// 物化手法：client.js 顶层就摸 window.__ModuleLoader__.load({id, factory})，factory 收一个
// require 并从 "react" 拉桩。这里伪造最小宿主全局把 factory 跑一遍，捕获返回的
// module.exports，再从 __pure 取纯函数直调。

import test from 'node:test'
import assert from 'node:assert/strict'

// —— 最小 React 桩：只按 client.js 实际摸到的面给 ——
const reactStub = {
  Component: class {},
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  createElement: (t, p, ...c) => ({ t, p, c }),
}
const stubRequire = (id) => {
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  throw new Error('client.test 桩未覆盖的 require：' + id)
}

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (def) => { captured = def.factory(stubRequire) },
  },
}
await import('../client/client.js')
delete globalThis.window
assert.ok(captured !== null && captured.__pure !== undefined, '桩物化失败：client.js 的 factory 未被宿主 load 调到')
const P = captured.__pure

test('__pure 导出面固定（防导出漂移）', () => {
  assert.deepEqual(Object.keys(P).sort(), ['fallbackT', 'interpolate', 'localeDict', 'localeNs', 'localizeError', 'parseInline', 'parseMarkdown', 'scopeTextOf', 'tr'])
  assert.ok(Object.isFrozen(P))
})

test('中英词典键完全一致（缺一即视为漏翻）', () => {
  const zh = Object.keys(P.localeDict.zh).sort()
  const en = Object.keys(P.localeDict.en).sort()
  assert.deepEqual(en, zh)
  assert.ok(zh.length > 60, `词典条目过少：${zh.length}`)
})

test('中英词典没有空文案', () => {
  for (const [locale, dict] of Object.entries(P.localeDict)) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${locale}.${key} 不是字符串`)
      assert.notEqual(value.trim(), '', `${locale}.${key} 为空`)
    }
  }
})

test('interpolate 填占位符，未命中的保留原样', () => {
  assert.equal(P.interpolate('共 {n} 个', { n: 3 }), '共 3 个')
  assert.equal(P.interpolate('共 {n} 个', { m: 3 }), '共 {n} 个')
  assert.equal(P.interpolate('无占位符'), '无占位符')
})

test('fallbackT 无宿主 t 时输出中文', () => {
  const t = P.fallbackT()
  assert.equal(t('section.title'), '技能')
  assert.equal(t('section.installed'), '已安装')
  assert.equal(t('not-exist-key'), 'not-exist-key')
})

test('tr 用传入的 t（宿主注入的翻译器）取文案', () => {
  const fake = (key, params) => 'EN:' + key + (params ? ':' + JSON.stringify(params) : '')
  assert.equal(P.tr(fake, 'section.title'), 'EN:section.title')
  assert.equal(P.tr(fake, 'import.selected', { n: 1, total: 2 }), 'EN:import.selected:{"n":1,"total":2}')
  // 没有 t 时退回中文兜底
  assert.equal(P.tr(null, 'section.title'), '技能')
})

test('localeNs 与宿主注册项一致', () => {
  assert.equal(P.localeNs, 'dsh-skills-manager')
})

test('localizeError 按 code 查本地化文案，无 code 退回原文', () => {
  // 未接宿主时用中文兜底
  assert.equal(P.localizeError({ code: 'skill-not-found', params: { name: 'demo' } }), '找不到技能：demo')
  // 没有 code 时退回原文
  assert.equal(P.localizeError({ message: 'raw message' }), 'raw message')
  assert.equal(P.localizeError(null).length > 0, true)
  // 未知 code 也退回原文
  assert.equal(P.localizeError({ code: 'no-such-code', message: 'raw' }), 'raw')
})

test('parseInline 识别行内代码/粗体/斜体/删除线', () => {
  assert.deepEqual(P.parseInline('a `code` b'), [
    { type: 'text', text: 'a ' },
    { type: 'code', text: 'code' },
    { type: 'text', text: ' b' },
  ])
  assert.deepEqual(P.parseInline('**粗**'), [{ type: 'strong', text: '粗' }])
  assert.deepEqual(P.parseInline('*斜*'), [{ type: 'em', text: '斜' }])
  assert.deepEqual(P.parseInline('~~删~~'), [{ type: 'del', text: '删' }])
})

test('parseInline 只放行白名单协议的链接', () => {
  assert.deepEqual(P.parseInline('[官网](https://example.com)'), [
    { type: 'link', text: '官网', href: 'https://example.com' },
  ])
  // javascript: / data: 必须降级为纯文本，绝不能生成可点链接。
  for (const source of ['[点我](javascript:alert(1))', '[x](data:text/html;base64,PHNjcmlwdD4=)']) {
    const nodes = P.parseInline(source)
    assert.equal(nodes.some((node) => node.type === 'link'), false)
    assert.equal(nodes.map((node) => node.text).join('').includes('javascript:') || nodes.map((node) => node.text).join('').includes('data:'), true)
  }
})

test('parseInline 不把乘法号当斜体', () => {
  const nodes = P.parseInline('2 * 3 * 4')
  assert.equal(nodes.every((node) => node.type === 'text'), true)
})

test('parseMarkdown 解析标题/段落/列表/代码块/引用/分隔线', () => {
  const blocks = P.parseMarkdown([
    '# 标题',
    '',
    '一段文字',
    '',
    '- 项目一',
    '- 项目二',
    '',
    '1. 第一',
    '2. 第二',
    '',
    '```bash',
    'npm test',
    '```',
    '',
    '> 引用',
    '',
    '---',
  ].join('\n'))
  const types = blocks.map((block) => block.type)
  assert.deepEqual(types, ['h', 'p', 'ul', 'ol', 'code', 'quote', 'hr'])
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[0].text, '标题')
  assert.deepEqual(blocks[2].items, ['项目一', '项目二'])
  assert.deepEqual(blocks[3].items, ['第一', '第二'])
  assert.equal(blocks[4].text, 'npm test')
  assert.equal(blocks[5].children[0].text, '引用')
})

test('parseMarkdown 对空输入与未闭合代码块都安全', () => {
  assert.deepEqual(P.parseMarkdown(''), [])
  assert.deepEqual(P.parseMarkdown(null), [])
  const unclosed = P.parseMarkdown('```\nstill code')
  assert.equal(unclosed.length, 1)
  assert.equal(unclosed[0].type, 'code')
  assert.equal(unclosed[0].text, 'still code')
})

test('parseMarkdown 的块标量里的 --- 不截断 frontmatter 正文', () => {
  const blocks = P.parseMarkdown(['段落', '---', '之后'].join('\n'))
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].type, 'p')
  assert.equal(blocks[1].type, 'hr')
  assert.equal(blocks[2].type, 'p')
})

test('scopeTextOf 按来源给出范围文案', () => {
  assert.equal(P.scopeTextOf({ source: 'user-agents' }), '个人')
  assert.equal(P.scopeTextOf({ source: 'user-dsh' }), '个人')
  assert.equal(P.scopeTextOf({ source: 'bundled' }), '内置')
  assert.equal(P.scopeTextOf({ source: 'runtime' }), '内置')
  assert.equal(
    P.scopeTextOf({ source: 'project-dsh', rootPath: 'C:/Users/x/Documents/resume-site/.dsh/skills' }),
    'resume-site',
  )
})
