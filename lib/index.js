// dsh-skills-manager —— host 半。
//
// 职责：
//  - 扫描技能根目录（全局 ~/.dsh/skills、~/.agents/skills、项目 <root>/.dsh|.agents/skills、
//    预设内置目录），与 ctx.skills.list() 的注册表结果合并，得到「当前实际加载」的技能全景；
//  - 通过同源 HTTP 路由把列表、详情、启停、导入、删除能力交给设置页的「技能」面板。
//
// 路径安全：所有写操作的目标都由宿主按「已扫描到的技能」反查得到，绝不接受客户端传入的
// 任意绝对路径；删除只允许落在受管根之下，软链只删链接不删源。
//
// 派生自 pengxiaozi/dsh-plugins 的 dsh-skill-panel（MIT），此处在其只读能力之上补齐
// 范围切换与写操作，并重写为独立实现。

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, cpSync, unlinkSync, lstatSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

import { invocationOf, isValidSkillName, parseFrontmatter, setDisableModelInvocation } from './frontmatter.js'
import { globalRootsFor, isManagedRoot, projectRootOf, projectRootsFor, ROOT_LABELS, rootKindOf } from './roots.js'

export const name = '@bluechonk/dsh-skills-manager'

const API_BASE = '/dsh-skills-manager'
const BODY_LIMIT_BYTES = 1024 * 1024
const CONTENT_PREVIEW_BYTES = 400 * 1024
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.svn'])

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 同源 + 回环守卫：只接受本机同源请求。 */
export function isLoopbackRequest(request) {
  const address = request.socket && request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

function sendError(response, status, message) {
  sendJson(response, status, { ok: false, error: String(message) })
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let total = 0
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > BODY_LIMIT_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function readJsonBody(request) {
  const raw = await readBody(request)
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/* ------------------------------------------------------------------ */
/* 目录扫描                                                            */
/* ------------------------------------------------------------------ */

/**
 * 递归统计技能目录占用的文件（跳过 .git / node_modules 等）。
 * @param {string} baseDir
 * @param {Array<{ rel: string, abs: string, size: number }>} collected
 * @param {{ maxFiles: number, maxBytes: number }} limits
 */
function walk(baseDir, collected, limits) {
  let names
  try {
    names = readdirSync(baseDir)
  } catch {
    return
  }
  names.sort()
  for (const entry of names) {
    if (collected.length >= limits.maxFiles) return
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(baseDir, entry)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(abs, collected, limits)
    else if (st.isFile()) {
      collected.push({ rel: entry, abs, size: st.size })
    }
  }
}

/**
 * 收集一个技能在磁盘上占用的文件。
 * @param {string} skillPath SKILL.md 或平铺 .md 的绝对路径
 */
export function collectSkillFiles(skillPath) {
  if (typeof skillPath !== 'string' || skillPath === '' || !existsSync(skillPath)) return null
  let st
  try {
    st = statSync(skillPath)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  const isBundle = basename(skillPath).toLowerCase() === 'skill.md'
  if (!isBundle) {
    return { dir: null, isBundle: false, files: [{ rel: basename(skillPath), abs: skillPath, size: st.size }], bytes: st.size }
  }
  const baseDir = dirname(skillPath)
  const files = []
  walk(baseDir, files, { maxFiles: 600, maxBytes: 40 * 1024 * 1024 })
  const bytes = files.reduce((sum, file) => sum + file.size, 0)
  return { dir: baseDir, isBundle: true, files, bytes }
}

/**
 * 扫描一个技能根：仅一层 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md`（与官方提供方同规则）。
 * @param {Array<{ label: string, path: string, rank: number }>} roots
 */
export function discoverLocalSkills(roots) {
  const out = []
  const seen = new Set()
  for (const root of roots) {
    let names
    try {
      names = readdirSync(root.path)
    } catch {
      continue
    }
    names.sort()
    for (const entry of names) {
      if (entry.startsWith('.')) continue
      if (SKIP_DIRS.has(entry)) continue
      const abs = join(root.path, entry)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      let mdPath = null
      if (st.isDirectory()) {
        const candidate = join(abs, 'SKILL.md')
        if (!existsSync(candidate)) continue
        mdPath = candidate
      } else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
        mdPath = abs
      } else {
        continue
      }
      let text
      try {
        text = readFileSync(mdPath, 'utf8').slice(0, 65536)
      } catch {
        continue
      }
      const frontmatter = parseFrontmatter(text)
      if (!frontmatter) continue
      const name = frontmatter.data.name
      if (!isValidSkillName(name)) continue
      const description = typeof frontmatter.data.description === 'string' ? frontmatter.data.description : ''
      if (description === '') continue
      if (seen.has(name)) continue
      seen.add(name)
      const info = collectSkillFiles(mdPath)
      out.push({
        name,
        description,
        whenToUse: typeof frontmatter.data.whenToUse === 'string' ? frontmatter.data.whenToUse : undefined,
        provider: 'filesystem',
        source: root.label,
        rank: root.rank,
        path: mdPath,
        dir: info && info.dir ? info.dir : dirname(mdPath),
        root: root.label,
        rootPath: root.path,
        invocation: invocationOf(frontmatter),
        fileCount: info ? info.files.length : 0,
        bytes: info ? info.bytes : 0,
        isBundle: info ? info.isBundle : false,
        exists: info !== null,
        inRegistry: false,
        embedded: false,
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 外部 Agent 技能目录                                                */
/* ------------------------------------------------------------------ */

/** 已知的外部 Agent 技能目录（用于「导入外部 Agent 技能」）。 */
export function externalAgentRoots(home = homedir()) {
  return [
    { id: 'codex', label: 'Codex CLI', path: join(home, '.codex', 'skills') },
    { id: 'claude', label: 'Claude Code', path: join(home, '.claude', 'skills') },
    { id: 'gemini', label: 'Gemini CLI', path: join(home, '.gemini', 'skills') },
    { id: 'qwen', label: 'Qwen Code', path: join(home, '.qwen', 'skills') },
  ]
}

/** 扫描外部目录，返回可导入的技能清单。 */
export function scanExternalRoots(roots) {
  const out = []
  for (const root of roots) {
    let names
    try {
      names = readdirSync(root.path)
    } catch {
      out.push({ id: root.id, label: root.label, path: root.path, exists: false, count: 0, skills: [] })
      continue
    }
    names.sort()
    const skills = []
    for (const entry of names) {
      if (entry.startsWith('.')) continue
      const abs = join(root.path, entry)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      const mdPath = st.isDirectory() ? join(abs, 'SKILL.md') : st.isFile() && entry.toLowerCase().endsWith('.md') ? abs : null
      if (!mdPath || !existsSync(mdPath)) continue
      let text
      try {
        text = readFileSync(mdPath, 'utf8').slice(0, 65536)
      } catch {
        continue
      }
      const frontmatter = parseFrontmatter(text)
      if (!frontmatter || !isValidSkillName(frontmatter.data.name)) continue
      skills.push({
        name: frontmatter.data.name,
        description: typeof frontmatter.data.description === 'string' ? frontmatter.data.description : '',
        path: mdPath,
      })
    }
    out.push({ id: root.id, label: root.label, path: root.path, exists: true, count: skills.length, skills })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const profile = ctx.get('profileContext')
  const profileDir = profile && typeof profile.dir === 'string' ? profile.dir : process.cwd()

  const log = (message) => {
    try {
      mkdirSync(profileDir, { recursive: true })
      appendFileSync(join(profileDir, 'skills-manager.log'), new Date().toISOString() + ' ' + message + '\n')
    } catch {
      /* 仅诊断信息 */
    }
  }

  // profile 重载后刷新已服务的 client 产物，让界面改动无需重启宿主即可生效。
  // 客户端图条目以 npm 包名为 id（见 clientModules.graph().entries[].id）。
  try {
    const clientModules = ctx.get('clientModules')
    if (clientModules && typeof clientModules.rebuilt === 'function') {
      clientModules.rebuilt('@bluechonk/dsh-skills-manager')
    }
  } catch (error) {
    log('clientModules.rebuilt failed: ' + error)
  }

  /** 从 agent preset 的组合里找出 skill-filesystem 行（桌面端的本地发现就挂在这里）。 */
  const presetSkillConfig = () => {
    const found = { config: null, customSkillDirs: [] }
    try {
      const presets = ctx.get('agentPresets')
      if (!presets || typeof presets.inspectCompositions !== 'function') return found
      const inspection = presets.inspectCompositions(ctx)
      const visit = (node) => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) {
          for (const item of node) visit(item)
          return
        }
        const name = typeof node.name === 'string' ? node.name : node.options && typeof node.options.name === 'string' ? node.options.name : null
        if (name && name.includes('dsh-skill-filesystem')) {
          const config = node.config && typeof node.config === 'object'
            ? node.config
            : node.options && node.options.config && typeof node.options.config === 'object' ? node.options.config : null
          if (config) {
            if (!found.config) found.config = config
            if (Array.isArray(config.customSkillDirs)) {
              for (const dir of config.customSkillDirs) if (typeof dir === 'string' && dir !== '') found.customSkillDirs.push(dir)
            }
            if (typeof config.bundledSkillDir === 'string' && config.bundledSkillDir !== '') found.customSkillDirs.push(config.bundledSkillDir)
          }
        }
        for (const value of Object.values(node)) visit(value)
      }
      visit(inspection)
    } catch (error) {
      log('agentPresets.inspectCompositions failed: ' + error)
    }
    return found
  }

  /** 从 loader 里读 dsh-skill-filesystem 的配置，得到真实的用户根与自定义根。 */
  const filesystemConfig = () => {
    let loaded = {}
    try {
      const loader = ctx.get('loader')
      if (loader && typeof loader.entries === 'function') {
        for (const entry of loader.entries()) {
          const options = entry && entry.options ? entry.options : null
          if (options && typeof options.name === 'string' && options.name.includes('dsh-skill-filesystem')) {
            loaded = options.config && typeof options.config === 'object' ? options.config : {}
            break
          }
        }
      }
    } catch {
      loaded = {}
    }
    const preset = presetSkillConfig()
    const config = Object.assign({}, loaded)
    if (preset.config) {
      if (typeof preset.config.dshHome === 'string') config.dshHome = preset.config.dshHome
      if (typeof preset.config.agentsHome === 'string') config.agentsHome = preset.config.agentsHome
      if (preset.config.includeDefaultRoots === false) config.includeDefaultRoots = false
    }
    const customSkillDirs = []
    if (Array.isArray(config.customSkillDirs)) for (const dir of config.customSkillDirs) customSkillDirs.push(dir)
    for (const dir of preset.customSkillDirs) if (!customSkillDirs.includes(dir)) customSkillDirs.push(dir)
    config.customSkillDirs = customSkillDirs
    return config
  }

  /** 预设内置技能目录（dsh-agent-preset/skills），DSH 以 customSkillDirs 形式挂载。 */
  const presetSkillDir = () => {
    const configured = filesystemConfig()
    if (Array.isArray(configured.customSkillDirs)) {
      for (const dir of configured.customSkillDirs) {
        if (typeof dir === 'string' && dir.includes('dsh-agent-preset')) return dir
      }
    }
    return null
  }

  /** 当前范围下的全部技能根。 */
  const rootsFor = (cwd) => {
    const configured = filesystemConfig()
    const roots = globalRootsFor({
      dshHome: typeof configured.dshHome === 'string' ? configured.dshHome : undefined,
      agentsHome: typeof configured.agentsHome === 'string' ? configured.agentsHome : undefined,
      customSkillDirs: Array.isArray(configured.customSkillDirs) ? configured.customSkillDirs : [],
      bundledSkillDir: typeof configured.bundledSkillDir === 'string' ? configured.bundledSkillDir : undefined,
      includeDefaultRoots: configured.includeDefaultRoots !== false,
    })
    const presetDir = presetSkillDir()
    if (presetDir && !roots.some((root) => root.path === presetDir)) {
      roots.push({ label: 'custom', path: presetDir, rank: 300, kind: 'custom' })
    }
    if (typeof cwd === 'string' && cwd !== '') {
      roots.push(...projectRootsFor(cwd))
    }
    return roots
  }

  /**
   * 读注册表：按「查看者作用域」取当前实际加载的技能。
   *
   * 桌面端把宿主面的 skill-filesystem 关掉了：文件系统技能注册在各 agent preset 的层里，
   * 只有带着 preset（或活跃 agent）的 scope 去读，才能看到 preset 挂的自定义目录与项目根。
   * 因此这里把「活跃 agent 作用域」与「各 preset 作用域」的结果并起来。
   */
  const registrySummaries = async (cwd) => {
    const registry = ctx.get('skills')
    if (!registry || typeof registry.list !== 'function') return { summaries: [], diagnostics: { registry: false } }
    const diagnostics = { registry: true, agents: 0, agentId: null, scopes: [] }
    const summaries = []
    const seen = new Set()
    const scopes = []
    try {
      const agents = ctx.get('agents')
      const live = agents && typeof agents.list === 'function' ? agents.list()[0] : undefined
      if (agents && typeof agents.list === 'function') diagnostics.agents = agents.list().length
      if (live) {
        diagnostics.agentId = live.id || null
        scopes.push({ label: 'live-agent', scope: live })
      }
      const presets = ctx.get('agentPresets')
      const leases = []
      try {
        if (presets && typeof presets.list === 'function' && typeof presets.acquireScope === 'function') {
          const presetList = await presets.list()
          for (const preset of presetList) {
            const id = typeof preset === 'string' ? preset : preset && (preset.id || preset.name)
            if (typeof id !== 'string' || id === '') continue
            try {
              const lease = await presets.acquireScope(id)
              leases.push(lease)
              scopes.push({ label: 'preset:' + id, scope: lease.key })
            } catch (error) {
              log('acquireScope failed for ' + id + ': ' + error)
            }
          }
        }
        for (const entry of scopes) {
          try {
            const list = await registry.list({ cwd, scope: entry.scope })
            diagnostics.scopes.push({ label: entry.label, count: list.length })
            for (const summary of list) {
              if (seen.has(summary.name)) continue
              seen.add(summary.name)
              summaries.push(summary)
            }
          } catch (error) {
            log('registry.list failed for ' + entry.label + ': ' + error)
          }
        }
        if (scopes.length === 0) {
          const list = await registry.list(cwd ? { cwd } : {})
          diagnostics.scopes.push({ label: 'global', count: list.length })
          for (const summary of list) {
            if (seen.has(summary.name)) continue
            seen.add(summary.name)
            summaries.push(summary)
          }
        }
      } finally {
        for (const lease of leases) {
          try {
            if (lease && typeof lease[Symbol.asyncDispose] === 'function') await lease[Symbol.asyncDispose]()
          } catch {
            /* 忽略释放异常 */
          }
        }
      }
    } catch (error) {
      diagnostics.error = String(error && error.message ? error.message : error)
      log('registry read failed: ' + error)
    }
    return { summaries, diagnostics }
  }

  /** 合并「本地根扫描」与「注册表」，得到当前加载到的技能全景。 */
  const listSkills = async (cwd) => {
    const roots = rootsFor(cwd)
    const byName = new Map()
    for (const local of discoverLocalSkills(roots)) byName.set(local.name, local)

    let registryError = null
    const { summaries, diagnostics } = await registrySummaries(cwd)
    if (diagnostics && diagnostics.error) registryError = diagnostics.error
    for (const summary of summaries) {
      const existing = byName.get(summary.name)
      if (existing) {
        if (typeof summary.description === 'string' && summary.description !== '') existing.description = summary.description
        if (typeof summary.provider === 'string') existing.provider = summary.provider
        // 本地刚解析的 frontmatter 是磁盘真值：注册表的目录有缓存（watcher 失效前是旧值），
        // 覆盖它会让「已禁用」在界面上回弹。只有本地没解析出调用策略时才用注册表的值。
        if (!existing.invocation && summary.invocation) existing.invocation = summary.invocation
        existing.inRegistry = true
        continue
      }
      byName.set(summary.name, {
        name: summary.name,
        description: summary.description,
        whenToUse: summary.whenToUse,
        provider: summary.provider,
        source: summary.source,
        rank: 900,
        path: summary.path || null,
        dir: summary.path ? dirname(summary.path) : null,
        root: summary.source,
        rootPath: null,
        invocation: summary.invocation || { modelInvocable: true, userInvocable: true },
        fileCount: 0,
        bytes: 0,
        isBundle: false,
        exists: Boolean(summary.path) && existsSync(summary.path),
        inRegistry: true,
        embedded: !summary.path,
      })
    }

    const merged = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    // 注册表里带路径但不在已知根内的技能（例如 preset 挂的自定义目录），按路径反推其根。
    for (const skill of merged) {
      if (skill.rootPath || !skill.path) continue
      const dir = dirname(skill.path)
      // 目录 bundle：<root>/<name>/SKILL.md → 根是上一级；平铺文件：<root>/<name>.md → 根就是所在目录。
      const isBundle = basename(dir) === skill.name
      skill.rootPath = isBundle ? dirname(dir) : dir
      skill.dir = skill.dir || dir
    }

    const rootMeta = []
    const pushRoot = (root) => {
      if (rootMeta.some((item) => item.label === root.label && item.path === root.path)) return
      rootMeta.push(root)
    }
    for (const root of roots) {
      let exists = false
      try {
        exists = existsSync(root.path)
      } catch {
        exists = false
      }
      pushRoot({
        label: root.label,
        title: ROOT_LABELS[root.label] || root.label,
        path: root.path,
        rank: root.rank,
        kind: rootKindOf(root.label),
        exists,
        count: merged.filter((skill) => skill.root === root.label && skill.rootPath === root.path).length,
      })
    }
    for (const skill of merged) {
      if (!skill.rootPath) continue
      pushRoot({
        label: skill.root,
        title: ROOT_LABELS[skill.root] || skill.root,
        path: skill.rootPath,
        rank: skill.rank,
        kind: rootKindOf(skill.root),
        exists: true,
        count: merged.filter((item) => item.root === skill.root && item.rootPath === skill.rootPath).length,
      })
    }
    rootMeta.sort((a, b) => a.rank - b.rank)
    return { roots: rootMeta, skills: merged, registryError, diagnostics }
  }

  /** 工作区列表（作用域下拉里的「工作区」分组）。 */
  const listWorkspaces = () => {
    const registry = ctx.get('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return []
    try {
      const workspaces = registry.list() || []
      return workspaces
        .map((workspace, index) => {
          const path = typeof workspace.path === 'string' ? workspace.path : typeof workspace.directory === 'string' ? workspace.directory : ''
          const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : path === '' ? '工作区' : basename(path)
          return { id: typeof workspace.id === 'string' ? workspace.id : String(index), title, path }
        })
        .filter((workspace) => workspace.path !== '')
    } catch (error) {
      log('workspaceRegistry.list failed: ' + error)
      return []
    }
  }

  /** 按名字反查技能（只认本轮扫描到的条目）。 */
  const findSkill = (skills, name) => skills.find((skill) => skill.name === name)

  /** 判断目标路径是否位于受管根之下。 */
  const withinRoot = (target, rootPath) => {
    if (!rootPath) return false
    const resolvedTarget = resolve(target)
    const resolvedRoot = resolve(rootPath)
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep)
  }

  /** 依赖包目录内的技能（预设内置）不可写——改坏会连累官方包。 */
  const insideNodeModules = (target) => {
    if (typeof target !== 'string') return false
    return resolve(target).split(/[\\/]+/).includes('node_modules')
  }

  /* ------------------------------ 路由 ------------------------------ */

  const stateRoute = async (request, response, params) => {
    const cwd = params.get('cwd') || ''
    const { roots, skills, registryError, diagnostics } = await listSkills(cwd)
    const installed = skills.filter((skill) => skill.inRegistry || skill.source !== 'runtime')
    const totals = {
      skills: skills.length,
      installed: installed.length,
      modelInvocable: skills.filter((skill) => !skill.invocation || skill.invocation.modelInvocable !== false).length,
      userInvocable: skills.filter((skill) => !skill.invocation || skill.invocation.userInvocable !== false).length,
      missing: skills.filter((skill) => !skill.exists && !skill.embedded).length,
    }
    let clientBundlePath = null
    let clientDiagnostics = null
    try {
      const clientModules = ctx.get('clientModules')
      if (clientModules && typeof clientModules.clientPath === 'function') {
        // 客户端图条目以 npm 包名为 id。
        clientBundlePath = clientModules.clientPath('@bluechonk/dsh-skills-manager') || null
        if (typeof clientModules.graph === 'function') {
          const graph = clientModules.graph()
          const text = JSON.stringify(graph)
          clientDiagnostics = { ids: (graph && (graph.clients || graph.entries || graph.modules)) || undefined, sample: text.slice(0, 1200) }
        }
      }
    } catch {
      clientBundlePath = null
    }
    sendJson(response, 200, {
      ok: true,
      roots,
      skills,
      totals,
      workspaces: listWorkspaces(),
      projectRoot: cwd === '' ? null : projectRootOf(cwd),
      registryError,
      diagnostics,
      clientBundlePath,
      clientDiagnostics,
    })
  }

  const bodyRoute = async (request, response) => {
    const payload = await readJsonBody(request)
    const name = typeof payload.name === 'string' ? payload.name : ''
    const { skills } = await listSkills(typeof payload.cwd === 'string' ? payload.cwd : '')
    const skill = findSkill(skills, name)
    if (!skill) return sendError(response, 404, '找不到技能：' + name)
    let content = ''
    let truncated = false
    if (skill.path && existsSync(skill.path)) {
      const buffer = readFileSync(skill.path)
      if (buffer.length > CONTENT_PREVIEW_BYTES) {
        content = buffer.subarray(0, CONTENT_PREVIEW_BYTES).toString('utf8')
        truncated = true
      } else {
        content = buffer.toString('utf8')
      }
    }
    const info = skill.path ? collectSkillFiles(skill.path) : null
    const frontmatter = skill.path ? parseFrontmatter(content) : null
    sendJson(response, 200, {
      ok: true,
      skill,
      content,
      body: frontmatter ? frontmatter.body : content,
      frontmatter: frontmatter ? frontmatter.data : null,
      contentTruncated: truncated,
      files: info ? info.files.map((file) => ({ rel: file.rel, size: file.size })) : [],
    })
  }

  const revealRoute = async (request, response) => {
    const payload = await readJsonBody(request)
    const name = typeof payload.name === 'string' ? payload.name : ''
    const { skills } = await listSkills(typeof payload.cwd === 'string' ? payload.cwd : '')
    const skill = findSkill(skills, name)
    if (!skill || !skill.dir || !skill.exists) return sendError(response, 404, '该技能没有可打开的本地目录')
    const dir = resolve(skill.dir)
    if (skill.rootPath && !withinRoot(dir, skill.rootPath)) return sendError(response, 403, '拒绝打开技能目录之外的路径')
    if (!existsSync(dir)) return sendError(response, 404, '目录不存在：' + dir)
    const { spawn } = await import('node:child_process')
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [dir], { detached: true, stdio: 'ignore' })
    child.unlink()
    log('opened directory: ' + dir)
    sendJson(response, 200, { ok: true, opened: dir })
  }

  /** 启停：改写 frontmatter 的 disable-model-invocation（DSH 原生语义）。 */
  const toggleRoute = async (request, response) => {
    const payload = await readJsonBody(request)
    const name = typeof payload.name === 'string' ? payload.name : ''
    const disabled = payload.disabled === true
    const { skills } = await listSkills(typeof payload.cwd === 'string' ? payload.cwd : '')
    const skill = findSkill(skills, name)
    if (!skill) return sendError(response, 404, '找不到技能：' + name)
    if (!skill.path || !existsSync(skill.path)) return sendError(response, 400, '该技能没有可改写的 SKILL.md')
    if (!isManagedRoot(skill.source)) return sendError(response, 400, '内置或运行时技能不可改写')
    if (insideNodeModules(skill.path)) return sendError(response, 400, '官方包内置技能不可改写')
    let text
    try {
      text = readFileSync(skill.path, 'utf8')
    } catch (error) {
      return sendError(response, 500, '读取 SKILL.md 失败：' + String(error && error.message ? error.message : error))
    }
    let next
    try {
      next = setDisableModelInvocation(text, disabled)
    } catch (error) {
      return sendError(response, 400, String(error && error.message ? error.message : error))
    }
    if (next === text) {
      return sendJson(response, 200, { ok: true, changed: false, name, disabled })
    }
    try {
      mkdirSync(dirname(skill.path), { recursive: true })
      writeFileUtf8(skill.path, next)
    } catch (error) {
      return sendError(response, 500, '写入 SKILL.md 失败：' + String(error && error.message ? error.message : error))
    }
    log((disabled ? 'disabled ' : 'enabled ') + name + ' (' + skill.path + ')')
    sendJson(response, 200, { ok: true, changed: true, name, disabled })
  }

  /** 删除：只允许受管根下的技能；软链只删链接。 */
  const removeRoute = async (request, response) => {
    const payload = await readJsonBody(request)
    const name = typeof payload.name === 'string' ? payload.name : ''
    const { skills } = await listSkills(typeof payload.cwd === 'string' ? payload.cwd : '')
    const skill = findSkill(skills, name)
    if (!skill) return sendError(response, 404, '找不到技能：' + name)
    if (!skill.path || !existsSync(skill.path)) return sendError(response, 400, '该技能没有可删除的本地文件')
    if (!isManagedRoot(skill.source)) return sendError(response, 400, '内置或运行时技能不可删除')
    if (insideNodeModules(skill.path)) return sendError(response, 400, '官方包内置技能不可删除')
    if (!skill.rootPath || !withinRoot(skill.path, skill.rootPath)) return sendError(response, 403, '拒绝删除技能根之外的路径')
    const target = resolve(skill.path)
    try {
      const st = lstatSync(target)
      if (st.isSymbolicLink()) {
        unlinkSync(target)
      } else if (skill.isBundle) {
        rmSync(dirname(target), { recursive: true, force: true })
      } else {
        rmSync(target, { force: true })
      }
    } catch (error) {
      return sendError(response, 500, '删除失败：' + String(error && error.message ? error.message : error))
    }
    log('removed ' + name + ' (' + target + ')')
    sendJson(response, 200, { ok: true, removed: name })
  }

  /** 新建：生成一个最小可用的技能目录。 */
  const createRoute = async (request, response) => {
    const payload = await readJsonBody(request)
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    const description = typeof payload.description === 'string' ? payload.description.trim() : ''
    if (!isValidSkillName(name)) return sendError(response, 400, '技能名必须是 kebab-case（仅小写字母、数字与连字符）')
    if (description === '') return sendError(response, 400, '描述不能为空')
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
    const configured = filesystemConfig()
    const dshHome = typeof configured.dshHome === 'string' ? configured.dshHome : process.env.DSH_HOME || join(homedir(), '.dsh')
    const targetRoot = payload.target === 'project' && cwd !== '' ? join(projectRootOf(cwd), '.dsh', 'skills') : join(dshHome, 'skills')
    const dir = join(targetRoot, name)
    if (existsSync(dir)) return sendError(response, 409, '技能已存在：' + name)
    const content = [
      '---',
      'name: ' + name,
      'description: ' + JSON.stringify(description),
      '---',
      '',
      '# ' + name,
      '',
      '在这里写这个技能的说明。',
      '',
    ].join('\n')
    try {
      mkdirSync(dir, { recursive: true })
      writeFileUtf8(join(dir, 'SKILL.md'), content)
    } catch (error) {
      return sendError(response, 500, '创建失败：' + String(error && error.message ? error.message : error))
    }
    log('created ' + name + ' (' + dir + ')')
    sendJson(response, 200, { ok: true, created: name, dir })
  }

  /** 导入：把外部 Agent 的技能以软链或复制的方式装进受管根。 */
  const importRoute = async (request, response) => {
    const payload = await readJsonBody(request)
    const sourceId = typeof payload.source === 'string' ? payload.source : ''
    const name = typeof payload.name === 'string' ? payload.name : ''
    const mode = payload.mode === 'copy' ? 'copy' : 'link'
    const external = scanExternalRoots(externalAgentRoots()).find((root) => root.id === sourceId)
    if (!external) return sendError(response, 400, '未知的外部来源：' + sourceId)
    const candidate = external.skills.find((skill) => skill.name === name)
    if (!candidate) return sendError(response, 404, '外部目录里找不到技能：' + name)

    const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
    const configured = filesystemConfig()
    const dshHome = typeof configured.dshHome === 'string' ? configured.dshHome : process.env.DSH_HOME || join(homedir(), '.dsh')
    const targetRoot = payload.target === 'project' && cwd !== '' ? join(projectRootOf(cwd), '.dsh', 'skills') : join(dshHome, 'skills')
    const sourceDir = dirname(candidate.path)
    const dest = join(targetRoot, name)
    if (existsSync(dest)) return sendError(response, 409, '目标已存在同名技能：' + name)
    try {
      mkdirSync(targetRoot, { recursive: true })
      if (mode === 'link') {
        // Windows 目录软链用 junction，免管理员权限。
        symlinkSync(sourceDir, dest, process.platform === 'win32' ? 'junction' : 'dir')
      } else {
        cpSync(sourceDir, dest, { recursive: true })
      }
    } catch (error) {
      return sendError(response, 500, '导入失败：' + String(error && error.message ? error.message : error))
    }
    log('imported ' + name + ' from ' + external.id + ' (' + mode + ') to ' + dest)
    sendJson(response, 200, { ok: true, imported: name, mode, path: dest })
  }

  const externalRoute = async (request, response) => {
    const roots = scanExternalRoots(externalAgentRoots())
    const { skills } = await listSkills('')
    const installed = new Set(skills.map((skill) => skill.name))
    const payload = roots.map((root) => ({
      ...root,
      skills: root.skills.map((skill) => ({ ...skill, installed: installed.has(skill.name) })),
      count: root.skills.length,
    }))
    sendJson(response, 200, { ok: true, sources: payload, total: payload.reduce((sum, root) => sum + root.count, 0) })
  }

  /* --------------------------- 挂载路由 --------------------------- */

  ctx.inject(['webServer', 'loader'], (host) => {
    const webServer = host.webServer || ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      log('webServer unavailable; routes not mounted')
      return
    }
    const disposers = []
    const register = (path, handler) => disposers.push(webServer.register({ kind: 'exact', path, handler }))

    register(`${API_BASE}/state`, (request, response) => {
      if (!isLoopbackRequest(request)) return sendError(response, 403, 'loopback requests only')
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendError(response, 405, 'method not allowed')
      const params = new URL(request.url || '/', 'http://loopback').searchParams
      stateRoute(request, response, params).catch((error) => {
        log('state failed: ' + (error && error.stack ? error.stack : error))
        sendError(response, 500, 'internal error')
      })
    })

    const post = (path, handler) => {
      register(path, (request, response) => {
        if (!isLoopbackRequest(request)) return sendError(response, 403, 'loopback requests only')
        if (request.method !== 'POST') return sendError(response, 405, 'method not allowed')
        handler(request, response).catch((error) => {
          log(path + ' failed: ' + (error && error.stack ? error.stack : error))
          sendError(response, 500, 'internal error')
        })
      })
    }

    post(`${API_BASE}/body`, bodyRoute)
    post(`${API_BASE}/reveal`, revealRoute)
    post(`${API_BASE}/toggle`, toggleRoute)
    post(`${API_BASE}/remove`, removeRoute)
    post(`${API_BASE}/create`, createRoute)
    post(`${API_BASE}/import`, importRoute)

    register(`${API_BASE}/external`, (request, response) => {
      if (!isLoopbackRequest(request)) return sendError(response, 403, 'loopback requests only')
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendError(response, 405, 'method not allowed')
      externalRoute(request, response).catch((error) => sendError(response, 500, 'internal error'))
    })

    log('routes mounted')
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }, 'dsh-skills-manager routes')
  })
}

/** 写文本（UTF-8）。 */
function writeFileUtf8(path, content) {
  writeFileSync(path, content, 'utf8')
}
