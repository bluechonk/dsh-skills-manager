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

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

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

/**
 * 字符串层面的包含判断：目标是否在根目录之下。
 * Windows 上路径大小写不敏感，比较时统一小写；真实边界以 realWithinRoot 为准。
 * @param {string} target
 * @param {string} rootPath
 */
export function withinRoot(target, rootPath) {
  if (!rootPath || typeof target !== 'string' || target === '') return false
  const norm = (value) => {
    const unified = resolve(value).replace(/[\\/]+/g, '/').replace(/\/$/, '')
    return process.platform === 'win32' ? unified.toLowerCase() : unified
  }
  const resolvedTarget = norm(target)
  const resolvedRoot = norm(rootPath)
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + '/')
}

/** 解析真实路径（跟随符号链接）；失败返回 null。 */
export function realPathOf(target) {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

/**
 * 写操作前的最终防线：真实路径必须仍在真实根之内。
 * 字符串层面的判断挡不住「根内的目录项是指向别处的符号链接」——
 * 例如 <root>/evil -> C:\Users\x\重要目录，改写就会落到根外。
 * @param {string} target
 * @param {string} rootPath
 */
export function realWithinRoot(target, rootPath) {
  if (!rootPath) return false
  const realTarget = realPathOf(target)
  const realRoot = realPathOf(rootPath)
  if (!realTarget || !realRoot) return false
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep)
}

/**
 * 客户端传来的 cwd 只接受绝对路径且长度受限，避免把任意相对路径当成项目根。
 * @param {unknown} value
 * @returns {string} 合法则返回绝对路径，否则空串
 */
export function normalizeCwd(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 1024) return ''
  return isAbsolute(trimmed) ? trimmed : ''
}
