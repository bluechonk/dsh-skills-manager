// 技能根目录解析：全局根、项目根、预设内置根。
//
// 根与 rank 的语义来自官方提供方 @deepseek-ai/dsh-skill-filesystem：
//   100 project-dsh     <projectRoot>/.dsh/skills
//   200 project-agents  <projectRoot>/.agents/skills
//   300 custom          配置的自定义目录
//   400 user-dsh        <dshHome>/skills
//   500 user-agents     <agentsHome>/skills
//   600 bundled         随包提供的内置目录
// 项目根 = 含 .git 的最近祖先目录；不存在时退回 cwd。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 求项目根：自 cwd 向上找第一个含 .git 的目录；找不到则返回 cwd 本身。
 * @param {string | undefined} cwd
 * @returns {string}
 */
export function projectRootOf(cwd) {
  const start = resolve(typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd())
  let current = start
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      if (existsSync(join(current, '.git'))) return current
    } catch {
      /* 忽略不可读目录 */
    }
    const parent = join(current, '..')
    if (parent === current) break
    current = parent
  }
  return start
}

/**
 * 求某个 cwd 下的项目级技能根。
 * @param {string | undefined} cwd
 * @returns {Array<{ label: string, path: string, rank: number, kind: string }>}
 */
export function projectRootsFor(cwd) {
  const root = projectRootOf(cwd)
  return [
    { label: 'project-dsh', path: join(root, '.dsh', 'skills'), rank: 100, kind: 'project' },
    { label: 'project-agents', path: join(root, '.agents', 'skills'), rank: 200, kind: 'project' },
  ]
}

/**
 * 用户级与自定义根。
 * @param {{ dshHome?: string, agentsHome?: string, customSkillDirs?: string[], bundledSkillDir?: string, includeDefaultRoots?: boolean }} options
 * @returns {Array<{ label: string, path: string, rank: number, kind: string }>}
 */
export function globalRootsFor(options = {}) {
  const dshHome = options.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const agentsHome = options.agentsHome || process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
  const roots = []
  if (options.includeDefaultRoots !== false) {
    roots.push({ label: 'user-dsh', path: join(dshHome, 'skills'), rank: 400, kind: 'global' })
    roots.push({ label: 'user-agents', path: join(agentsHome, 'skills'), rank: 500, kind: 'global' })
  }
  if (Array.isArray(options.customSkillDirs)) {
    for (const dir of options.customSkillDirs) {
      if (typeof dir === 'string' && dir !== '') roots.push({ label: 'custom', path: dir, rank: 300, kind: 'custom' })
    }
  }
  if (typeof options.bundledSkillDir === 'string' && options.bundledSkillDir !== '') {
    roots.push({ label: 'bundled', path: options.bundledSkillDir, rank: 600, kind: 'bundled' })
  }
  return roots
}

/** 根标签 → 展示名。 */
export const ROOT_LABELS = {
  'user-dsh': '全局 DSH',
  'user-agents': '全局 Agents',
  'project-dsh': '项目 DSH',
  'project-agents': '项目 Agents',
  custom: '自定义目录',
  bundled: '内置目录',
  runtime: '运行时',
}

/** 根标签 → 作用域分类。 */
export function rootKindOf(label) {
  if (label === 'user-dsh' || label === 'user-agents') return 'global'
  if (label === 'project-dsh' || label === 'project-agents') return 'project'
  if (label === 'bundled') return 'bundled'
  if (label === 'runtime') return 'runtime'
  return 'custom'
}

/** 该根下的技能是否允许写操作（启停/删除）。 */
export function isManagedRoot(label) {
  return label === 'user-dsh' || label === 'user-agents' || label === 'project-dsh' || label === 'project-agents' || label === 'custom'
}
