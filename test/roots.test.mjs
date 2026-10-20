import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { globalRootsFor, isManagedRoot, projectRootOf, projectRootsFor, rootKindOf } from '../lib/roots.js'
import { collectSkillFiles, discoverLocalSkills, externalAgentRoots, scanExternalRoots } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsm-test-'))
}

test('projectRootOf 向上找到含 .git 的目录', () => {
  const base = tempDir()
  try {
    const root = join(base, 'repo')
    const nested = join(root, 'packages', 'app')
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    assert.equal(projectRootOf(nested), root)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('projectRootOf 没有 .git 时退回 cwd', () => {
  const base = tempDir()
  try {
    assert.equal(projectRootOf(base), base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('projectRootsFor 产出 DSH 的项目根标签与 rank', () => {
  const roots = projectRootsFor(process.cwd())
  assert.deepEqual(roots.map((root) => root.label), ['project-dsh', 'project-agents'])
  assert.deepEqual(roots.map((root) => root.rank), [100, 200])
})

test('globalRootsFor 默认给出用户 DSH 与用户 Agents 根', () => {
  const roots = globalRootsFor({ dshHome: 'C:/home/.dsh', agentsHome: 'C:/home/.agents' })
  assert.deepEqual(roots.map((root) => root.label), ['user-dsh', 'user-agents'])
  assert.equal(roots[0].path, join('C:/home/.dsh', 'skills'))
  assert.equal(roots[1].rank, 500)
})

test('globalRootsFor 支持自定义根与内置根', () => {
  const roots = globalRootsFor({ customSkillDirs: ['C:/custom'], bundledSkillDir: 'C:/bundled' })
  assert.deepEqual(roots.map((root) => root.label), ['user-dsh', 'user-agents', 'custom', 'bundled'])
  assert.equal(roots[3].rank, 600)
})

test('rootKindOf 与 isManagedRoot 覆盖来源分类', () => {
  assert.equal(rootKindOf('user-dsh'), 'global')
  assert.equal(rootKindOf('project-agents'), 'project')
  assert.equal(isManagedRoot('user-agents'), true)
  assert.equal(isManagedRoot('bundled'), false)
  assert.equal(isManagedRoot('runtime'), false)
})

test('discoverLocalSkills 只发现一层目录 bundle 与平铺 md', () => {
  const base = tempDir()
  try {
    const root = join(base, 'skills')
    mkdirSync(join(root, 'demo-skill'), { recursive: true })
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: 演示技能\n---\n\n正文\n', 'utf8')
    writeFileSync(join(root, 'flat-skill.md'), '---\nname: flat-skill\ndescription: 平铺技能\n---\n', 'utf8')
    mkdirSync(join(root, 'nested', 'deep-skill'), { recursive: true })
    writeFileSync(join(root, 'nested', 'deep-skill', 'SKILL.md'), '---\nname: deep-skill\ndescription: 嵌套技能\n---\n', 'utf8')
    writeFileSync(join(root, 'broken.md'), '没有 frontmatter\n', 'utf8')

    const found = discoverLocalSkills([{ label: 'user-agents', path: root, rank: 500 }])
    const names = found.map((skill) => skill.name)
    assert.deepEqual(names, ['demo-skill', 'flat-skill'])
    const demo = found.find((skill) => skill.name === 'demo-skill')
    assert.equal(demo.description, '演示技能')
    assert.equal(demo.source, 'user-agents')
    assert.equal(demo.invocation.modelInvocable, true)
    assert.equal(demo.isBundle, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('discoverLocalSkills 识别禁用的模型调用标记', () => {
  const base = tempDir()
  try {
    const root = join(base, 'skills')
    mkdirSync(join(root, 'off-skill'), { recursive: true })
    writeFileSync(join(root, 'off-skill', 'SKILL.md'), '---\nname: off-skill\ndescription: 已禁用\ndisable-model-invocation: true\n---\n', 'utf8')
    const found = discoverLocalSkills([{ label: 'user-dsh', path: root, rank: 400 }])
    assert.equal(found[0].invocation.modelInvocable, false)
    assert.equal(found[0].invocation.userInvocable, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('collectSkillFiles 统计技能目录文件', () => {
  const base = tempDir()
  try {
    const dir = join(base, 'demo-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), 'x', 'utf8')
    writeFileSync(join(dir, 'ref.md'), 'yy', 'utf8')
    const info = collectSkillFiles(join(dir, 'SKILL.md'))
    assert.equal(info.files.length, 2)
    assert.equal(info.bytes, 3)
    assert.equal(info.dir, dir)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('scanExternalRoots 列出外部目录并标记不存在的目录', () => {
  const base = tempDir()
  try {
    const codex = join(base, '.codex', 'skills')
    mkdirSync(join(codex, 'ext-skill'), { recursive: true })
    writeFileSync(join(codex, 'ext-skill', 'SKILL.md'), '---\nname: ext-skill\ndescription: 外部技能\n---\n', 'utf8')
    const scanned = scanExternalRoots([{ id: 'codex', label: 'Codex CLI', path: codex }, { id: 'claude', label: 'Claude Code', path: join(base, '.claude', 'skills') }])
    assert.equal(scanned[0].count, 1)
    assert.equal(scanned[0].skills[0].name, 'ext-skill')
    assert.equal(scanned[1].exists, false)
    assert.equal(scanned[1].count, 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('externalAgentRoots 覆盖 Codex CLI 等常见目录', () => {
  const roots = externalAgentRoots('C:/home')
  const ids = roots.map((root) => root.id)
  assert.ok(ids.includes('codex'))
  assert.ok(ids.includes('claude'))
  assert.equal(roots.find((root) => root.id === 'codex').path, join('C:/home', '.codex', 'skills'))
})
