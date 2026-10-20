import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { globalRootsFor, isManagedRoot, normalizeCwd, projectRootOf, projectRootsFor, realWithinRoot, rootKindOf, withinRoot } from '../lib/roots.js'
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
    const info = collectSkillFiles(join(dir, 'SKILL.md'), true)
    assert.equal(info.files.length, 2)
    assert.equal(info.bytes, 3)
    assert.equal(info.dir, dir)
    // 文件清单保留目录层级
    assert.deepEqual(info.files.map((file) => file.rel).sort(), ['SKILL.md', 'ref.md'])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('collectSkillFiles 平铺文件不会被当成目录 bundle', () => {
  const base = tempDir()
  try {
    const root = join(base, 'skills')
    mkdirSync(root, { recursive: true })
    const file = join(root, 'skill.md')
    writeFileSync(file, 'x', 'utf8')
    // 即使文件名是 skill.md，只要不是目录 bundle，就不能去遍历目录、更不能删目录。
    const info = collectSkillFiles(file, false)
    assert.equal(info.isBundle, false)
    assert.equal(info.files.length, 1)
    assert.equal(info.dir, null)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('discoverLocalSkills 平铺 skill.md 不被当成目录 bundle', () => {
  const base = tempDir()
  try {
    const root = join(base, 'skills')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'skill.md'), '---\nname: root-skill\ndescription: 平铺在根下\n---\n', 'utf8')
    mkdirSync(join(root, 'other-skill'), { recursive: true })
    writeFileSync(join(root, 'other-skill', 'SKILL.md'), '---\nname: other-skill\ndescription: 目录技能\n---\n', 'utf8')
    const found = discoverLocalSkills([{ label: 'user-dsh', path: root, rank: 400 }])
    const flat = found.find((skill) => skill.name === 'root-skill')
    assert.equal(flat.isBundle, false)
    assert.equal(flat.isFlat, true)
    // 关键：平铺技能不能被当成目录 bundle——否则删除它会连整个根目录一起删掉。
    assert.equal(found.length, 2)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('discoverLocalSkills 按 rank 升序裁决同名技能（项目根优先）', () => {
  const base = tempDir()
  try {
    const userRoot = join(base, 'user')
    const projectRoot = join(base, 'project')
    mkdirSync(join(userRoot, 'demo'), { recursive: true })
    writeFileSync(join(userRoot, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 用户根的\n---\n', 'utf8')
    mkdirSync(join(projectRoot, 'demo'), { recursive: true })
    writeFileSync(join(projectRoot, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 项目根的\n---\n', 'utf8')
    const found = discoverLocalSkills([
      { label: 'user-dsh', path: userRoot, rank: 400 },
      { label: 'project-dsh', path: projectRoot, rank: 100 },
    ])
    assert.equal(found.length, 1)
    assert.equal(found[0].description, '项目根的')
    assert.equal(found[0].source, 'project-dsh')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('scanExternalRoots 给出技能自己的目录（平铺文件不是整个外部根）', () => {
  const base = tempDir()
  try {
    const ext = join(base, 'skills')
    mkdirSync(ext, { recursive: true })
    writeFileSync(join(ext, 'flat.md'), '---\nname: flat-skill\ndescription: 平铺\n---\n', 'utf8')
    const scanned = scanExternalRoots([{ id: 'codex', label: 'Codex CLI', path: ext }])
    const skill = scanned[0].skills[0]
    assert.equal(skill.isBundle, false)
    assert.equal(skill.isFlat, true)
    // 平铺技能的目录仍是外部根（它本就没有自己的目录），
    // 但导入时必须单独处理文件，不能把整个根当技能目录。
    assert.equal(skill.dir, ext)
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

test('withinRoot 只认根目录之内', () => {
  const root = join('C:', 'skills')
  assert.equal(withinRoot(join(root, 'demo', 'SKILL.md'), root), true)
  assert.equal(withinRoot(root, root), true)
  assert.equal(withinRoot(join('C:', 'other', 'x.md'), root), false)
  assert.equal(withinRoot(join(root, '..', 'escape.md'), root), false)
  assert.equal(withinRoot(join(root, 'x'), ''), false)
})

test('realWithinRoot 拦住指向根外的符号链接', () => {
  const base = tempDir()
  try {
    const root = join(base, 'skills')
    const outside = join(base, 'outside')
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: evil\ndescription: 越界\n---\n', 'utf8')
    // 根内的 evil 目录是指向根外的链接
    symlinkSync(outside, join(root, 'evil'), 'junction')
    const escaped = join(root, 'evil', 'SKILL.md')
    // 字符串层面看着在根内，真实路径却在根外
    assert.equal(withinRoot(escaped, root), true)
    assert.equal(realWithinRoot(escaped, root), false)
    // 根内的正常目录应通过
    const inside = join(root, 'good')
    mkdirSync(inside, { recursive: true })
    writeFileSync(join(inside, 'SKILL.md'), 'x', 'utf8')
    assert.equal(realWithinRoot(join(inside, 'SKILL.md'), root), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('normalizeCwd 只接受绝对路径且限制长度', () => {
  // 绝对路径的判定跟随平台：Windows 是盘符路径，其它平台是根路径。
  const absolute = process.platform === 'win32' ? 'C:/Users/x/project' : '/home/x/project'
  assert.equal(normalizeCwd(absolute), absolute)
  assert.equal(normalizeCwd('  ' + absolute + '  '), absolute)
  assert.equal(normalizeCwd('relative/path'), '')
  assert.equal(normalizeCwd(''), '')
  assert.equal(normalizeCwd(undefined), '')
  assert.equal(normalizeCwd(absolute + '/' + 'x'.repeat(2000)), '')
})
