import test from 'node:test'
import assert from 'node:assert/strict'

import { invocationOf, isDisabledFlag, isValidSkillName, parseFrontmatter, setDisableModelInvocation } from '../lib/frontmatter.js'

test('parseFrontmatter 解析顶层标量与引号', () => {
  const text = ['---', 'name: demo-skill', 'description: "带引号的描述"', '---', '', '正文'].join('\n')
  const parsed = parseFrontmatter(text)
  assert.equal(parsed.data.name, 'demo-skill')
  assert.equal(parsed.data.description, '带引号的描述')
  assert.equal(parsed.body.trim(), '正文')
})

test('parseFrontmatter 支持折叠块并跳过非键行', () => {
  const text = ['---', 'name: demo', 'description: >-', '  第一段', '  第二段', 'whenToUse: 何时使用', '---', 'body'].join('\n')
  const parsed = parseFrontmatter(text)
  assert.equal(parsed.data.description, '第一段 第二段')
  assert.equal(parsed.data.whenToUse, '何时使用')
})

test('parseFrontmatter 缺少闭合或无 frontmatter 时返回 null', () => {
  assert.equal(parseFrontmatter('没有 frontmatter'), null)
  assert.equal(parseFrontmatter('---\nname: x\n'), null)
})

test('setDisableModelInvocation 新增禁用键且保留正文', () => {
  const text = ['---', 'name: demo', 'description: 描述', '---', '', '# 正文', '内容'].join('\n')
  const next = setDisableModelInvocation(text, true)
  assert.match(next, /disable-model-invocation: true/)
  assert.match(next, /name: demo/)
  assert.match(next, /# 正文/)
  assert.equal(next.split('\n').filter((line) => line === '---').length, 2)
})

test('setDisableModelInvocation 幂等且可移除', () => {
  const text = ['---', 'name: demo', 'description: 描述', '---', 'body'].join('\n')
  const disabled = setDisableModelInvocation(text, true)
  assert.equal(setDisableModelInvocation(disabled, true), disabled)
  const enabled = setDisableModelInvocation(disabled, false)
  assert.equal(enabled, text)
})

test('setDisableModelInvocation 改写既有键而不是追加', () => {
  const text = ['---', 'name: demo', 'disable-model-invocation: false', 'description: 描述', '---', 'body'].join('\n')
  const next = setDisableModelInvocation(text, true)
  assert.equal(next.match(/disable-model-invocation/g).length, 1)
  assert.match(next, /disable-model-invocation: true/)
})

test('setDisableModelInvocation 对缺 frontmatter 的文件报错', () => {
  assert.throws(() => setDisableModelInvocation('没有 frontmatter', true))
})

test('isDisabledFlag 接受 DSH 的布尔写法', () => {
  for (const value of ['true', 'TRUE', 'yes', 'on', '1']) assert.equal(isDisabledFlag(value), true)
  for (const value of ['false', 'no', 'off', '0', 'maybe', undefined]) assert.equal(isDisabledFlag(value), false)
})

test('invocationOf 派生模型/用户可调用标记', () => {
  assert.deepEqual(invocationOf({ data: { name: 'x' } }), { modelInvocable: true, userInvocable: true })
  assert.deepEqual(invocationOf({ data: { 'disable-model-invocation': 'true' } }), { modelInvocable: false, userInvocable: true })
  assert.deepEqual(invocationOf({ data: { 'user-invocable': 'false' } }), { modelInvocable: true, userInvocable: false })
})

test('isValidSkillName 只接受 kebab-case', () => {
  assert.equal(isValidSkillName('demo-skill'), true)
  assert.equal(isValidSkillName('Demo'), false)
  assert.equal(isValidSkillName('demo_skill'), false)
  assert.equal(isValidSkillName('-demo'), false)
})
