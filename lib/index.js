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

import { appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, cpSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { invocationOf, isLosslessUtf8, isValidSkillName, parseFrontmatter, setDisableModelInvocation } from './frontmatter.js'
import {
  globalRootsFor,
  isManagedRoot,
  normalizeCwd,
  projectRootOf,
  projectRootsFor,
  realPathOf,
  realWithinRoot,
  ROOT_LABELS,
  rootKindOf,
  withinRoot,
} from './roots.js'

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

function sendJson(response, status, value, headers) {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  if (headers) {
    for (const [key, headerValue] of Object.entries(headers)) response.setHeader(key, headerValue)
  }
  response.end(body)
}

/**
 * 错误响应。code 是稳定的机器可读标识（客户端据此取对应语言的文案），
 * params 是文案里的动态部分（如技能名）。
 */
function sendError(response, status, message, headers, code, params) {
  const body = { ok: false, error: String(message) }
  if (code) body.code = code
  if (params) body.params = params
  sendJson(response, status, body, headers)
}

/** 把内部异常映射成合适的 HTTP 状态码。 */
function errorStatusOf(error) {
  if (error && error.name === 'BodyTooLargeError') return 413
  if (error && error.name === 'BadRequestError') return 400
  return 500
}

class BodyTooLargeError extends Error {
  constructor() {
    super('请求体超过 1MB 上限')
    this.name = 'BodyTooLargeError'
  }
}

class BadRequestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadRequestError'
  }
}

function readBody(request) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let total = 0
    let rejected = false
    request.on('data', (chunk) => {
      if (rejected) return
      total += chunk.length
      if (total > BODY_LIMIT_BYTES) {
        rejected = true
        // 不 destroy 连接：客户端要能收到 413 的响应体，而不是连接被重置。
        request.resume()
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!rejected) resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
  })
}

async function readJsonBody(request) {
  const raw = await readBody(request)
  if (raw.trim() === '') return {}
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new BadRequestError('请求体不是合法 JSON')
  }
  // JSON 的 null / 数组 / 数字都不是对象载荷：统一按 400 处理，避免后续取字段抛 TypeError。
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BadRequestError('请求体必须是 JSON 对象')
  }
  return payload
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
function walk(baseDir, relDir, collected, limits) {
  let names
  try {
    names = readdirSync(baseDir)
  } catch {
    return
  }
  names.sort()
  for (const entry of names) {
    if (collected.files.length >= limits.maxFiles || collected.bytes >= limits.maxBytes) {
      collected.truncated = true
      return
    }
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(baseDir, entry)
    const rel = relDir === '' ? entry : relDir + '/' + entry
    let st
    try {
      // 用 lstat：符号链接不跟随，避免把技能目录外的文件算进清单（也不误跟随到别处）。
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      collected.files.push({ rel, abs, size: 0, link: true })
      continue
    }
    if (st.isDirectory()) {
      walk(abs, rel, collected, limits)
      continue
    }
    if (!st.isFile()) continue
    if (collected.bytes + st.size > limits.maxBytes) {
      collected.truncated = true
      return
    }
    collected.files.push({ rel, abs, size: st.size })
    collected.bytes += st.size
  }
}

/**
 * 收集一个技能在磁盘上占用的文件。
 *
 * isBundle 必须由调用方按「该项是不是目录」给出：靠文件名猜会把根目录下平铺的
 * skill.md 当成目录 bundle，删除时连整个技能根一起删掉。
 * @param {string} skillPath SKILL.md 或平铺 .md 的绝对路径
 * @param {boolean} isBundle 该项是否为目录 bundle
 */
export function collectSkillFiles(skillPath, isBundle = false) {
  if (typeof skillPath !== 'string' || skillPath === '' || !existsSync(skillPath)) return null
  let st
  try {
    st = lstatSync(skillPath)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  if (!isBundle) {
    return { dir: null, isBundle: false, files: [{ rel: basename(skillPath), abs: skillPath, size: st.size }], bytes: st.size, truncated: false }
  }
  const baseDir = dirname(skillPath)
  const collected = { files: [], bytes: 0, truncated: false }
  walk(baseDir, '', collected, { maxFiles: 600, maxBytes: 40 * 1024 * 1024 })
  return { dir: baseDir, isBundle: true, files: collected.files, bytes: collected.bytes, truncated: collected.truncated }
}

/**
 * 扫描一个技能根：仅一层 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md`（与官方提供方同规则）。
 * @param {Array<{ label: string, path: string, rank: number }>} roots
 */
export function discoverLocalSkills(roots) {
  const out = []
  const seen = new Set()
  // 按 rank 升序扫描：rank 越小优先级越高（项目根优先于用户根），与 DSH 注册表的裁决顺序一致。
  // 否则同名技能会显示成低优先级那份，面板停用的文件与 DSH 实际加载的文件不是同一个。
  const ordered = [...roots].sort((a, b) => (a.rank || 0) - (b.rank || 0))
  for (const root of ordered) {
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
        st = lstatSync(abs)
      } catch {
        continue
      }
      let mdPath = null
      let isBundle = false
      if (st.isSymbolicLink()) {
        // 链接目录：内容照读（DSH 也会跟随），但标记出来，写操作另有真实路径校验。
        let target
        try {
          target = statSync(abs)
        } catch {
          continue
        }
        if (!target.isDirectory()) continue
        const candidate = join(abs, 'SKILL.md')
        if (!existsSync(candidate)) continue
        mdPath = candidate
        isBundle = true
      } else if (st.isDirectory()) {
        const candidate = join(abs, 'SKILL.md')
        if (!existsSync(candidate)) continue
        mdPath = candidate
        isBundle = true
      } else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
        mdPath = abs
        isBundle = false
      } else {
        continue
      }
      const text = readTextHead(mdPath, 65536)
      if (text === null) continue
      const frontmatter = parseFrontmatter(text)
      if (!frontmatter) continue
      const name = frontmatter.data.name
      if (!isValidSkillName(name)) continue
      const description = typeof frontmatter.data.description === 'string' ? frontmatter.data.description : ''
      if (description === '') continue
      if (seen.has(name)) continue
      seen.add(name)
      const info = collectSkillFiles(mdPath, isBundle)
      out.push({
        name,
        description,
        whenToUse: typeof frontmatter.data.whenToUse === 'string' ? frontmatter.data.whenToUse : undefined,
        provider: 'filesystem',
        source: root.label,
        rank: root.rank,
        path: mdPath,
        // bundle 的目录是技能自己的目录；平铺 .md 没有独立目录（dir 留给宿主在删除时判定）。
        dir: isBundle ? abs : dirname(mdPath),
        isFlat: !isBundle,
        root: root.label,
        rootPath: root.path,
        invocation: invocationOf(frontmatter),
        fileCount: info ? info.files.length : 0,
        bytes: info ? info.bytes : 0,
        isBundle,
        truncated: info ? info.truncated : false,
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

/** 只读取文件头部若干字节：超大 SKILL.md 不必整file读进内存。 */
function readTextHead(path, limit) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(limit)
    const read = readSync(fd, buffer, 0, limit, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

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
        st = lstatSync(abs)
      } catch {
        continue
      }
      const isBundle = st.isDirectory()
      const mdPath = isBundle ? join(abs, 'SKILL.md') : st.isFile() && entry.toLowerCase().endsWith('.md') ? abs : null
      if (!mdPath || !existsSync(mdPath)) continue
      const text = readTextHead(mdPath, 65536)
      if (text === null) continue
      const frontmatter = parseFrontmatter(text)
      if (!frontmatter || !isValidSkillName(frontmatter.data.name)) continue
      skills.push({
        name: frontmatter.data.name,
        description: typeof frontmatter.data.description === 'string' ? frontmatter.data.description : '',
        path: mdPath,
        // 技能自己的目录：导入时用它做链接/复制目标。
        // 平铺 .md 的 dirname 是整个外部根，用它会把整个外部目录装进来。
        dir: isBundle ? abs : dirname(abs),
        isBundle,
        isFlat: !isBundle,
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
      const file = join(profileDir, 'skills-manager.log')
      // 日志轮转：超过 1MB 换新文件，避免长期运行把磁盘写满。
      try {
        const st = statSync(file)
        if (st.size > 1024 * 1024) renameSync(file, file + '.1')
      } catch {
        /* 文件不存在或不可读：忽略 */
      }
      appendFileSync(file, new Date().toISOString() + ' ' + message + '\n')
    } catch {
      /* 仅诊断信息 */
    }
  }

  // 技能清单缓存：面板每次刷新都全量重扫目录与文件，开销大；写操作后立即失效。
  const SKILLS_CACHE_TTL_MS = 1000
  // 全局根与作用域无关：切工作区时复用这份结果，只重扫该工作区的项目根。
  const GLOBAL_SCAN_TTL_MS = 30000
  // 项目级来源：工作区作用域只看这些，用户作用域不看。
  const PROJECT_SOURCES = new Set(['project-dsh', 'project-agents'])
  const skillsCache = new Map()
  let globalScanCache = null
  const invalidateSkillsCache = () => {
    skillsCache.clear()
    globalScanCache = null
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

  /**
   * 全局技能根：用户 DSH 根、用户 Agents 根、预设自定义目录、随包内置目录。
   * 这些根与作用域无关，切换工作区时不需要重扫（结果走缓存）。
   */
  const globalRoots = () => {
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
    return roots
  }

  /** 当前工作区的项目技能根：<projectRoot>/.dsh/skills 与 <projectRoot>/.agents/skills。 */
  const projectRootsForScope = (cwd) => (typeof cwd === 'string' && cwd !== '' ? projectRootsFor(cwd) : [])

  /**
   * 各 agent preset 的作用域（按 preset 列表签名缓存，整个插件生命周期内复用）。
   *
   * acquireScope 会把 preset 的常驻组合挂起来，每次请求都重新 acquire 既浪费又会反复
   * 触发挂载；这里只在 preset 列表变化时重新获取，卸载时统一释放。
   */
  const presetScopeLeases = []
  let presetScopeCache = null
  let presetScopeSignature = ''
  const acquirePresetScopes = async () => {
    const presets = ctx.get('agentPresets')
    const presetList = presets && typeof presets.list === 'function' ? await presets.list() : []
    const signature = presetList
      .map((preset) => (typeof preset === 'string' ? preset : preset && (preset.id || preset.name)) || '')
      .join(',')
    if (presetScopeCache && signature === presetScopeSignature) return presetScopeCache
    // preset 列表变了：释放旧租约并重新获取，否则新增/删除 preset 后面板永远看不到。
    for (const lease of presetScopeLeases) {
      try {
        if (lease && typeof lease[Symbol.asyncDispose] === 'function') lease[Symbol.asyncDispose]()
      } catch {
        /* ignore */
      }
    }
    presetScopeLeases.length = 0
    const scopes = []
    try {
      if (presets && typeof presets.acquireScope === 'function') {
        for (const preset of presetList) {
          const id = typeof preset === 'string' ? preset : preset && (preset.id || preset.name)
          if (typeof id !== 'string' || id === '') continue
          try {
            const lease = await presets.acquireScope(id)
            presetScopeLeases.push(lease)
            scopes.push({ label: 'preset:' + id, scope: lease.key })
          } catch (error) {
            log('acquireScope failed for ' + id + ': ' + error)
          }
        }
      }
    } catch (error) {
      log('preset scope acquisition failed: ' + error)
    }
    presetScopeCache = scopes
    presetScopeSignature = signature
    return scopes
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
      try {
        const presetScopes = await acquirePresetScopes()
        for (const entry of presetScopes) scopes.push(entry)
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
      } catch (error) {
        log('preset scope read failed: ' + error)
      }
    } catch (error) {
      diagnostics.error = String(error && error.message ? error.message : error)
      log('registry read failed: ' + error)
    }
    return { summaries, diagnostics }
  }

  /** 合并「本地根扫描」与「注册表」，得到当前加载到的技能全景。 */
  const listSkills = async (cwd) => {
    // 短 TTL 缓存：面板每次刷新都全量重扫目录与文件，开销大；写操作后立即失效。
    const cached = skillsCache.get(cwd)
    if (cached && Date.now() - cached.at < SKILLS_CACHE_TTL_MS) return cached.value

    const projectRoots = projectRootsForScope(cwd)
    // 作用域互斥：选了工作区就只看该工作区；没选（用户 · 本机）就看全局 + 用户级 + 预设内置。
    const projectScope = projectRoots.length > 0
    const byName = new Map()
    let roots
    if (projectScope) {
      roots = projectRoots
      for (const local of discoverLocalSkills(projectRoots)) byName.set(local.name, local)
    } else {
      roots = globalRoots()
      // 全局根复用缓存（切工作区回来时不必重扫）。
      if (globalScanCache && Date.now() - globalScanCache.at < GLOBAL_SCAN_TTL_MS) {
        for (const local of globalScanCache.skills) byName.set(local.name, local)
      } else {
        const globalSkills = discoverLocalSkills(roots)
        globalScanCache = { at: Date.now(), skills: globalSkills }
        for (const local of globalSkills) byName.set(local.name, local)
      }
    }

    let registryError = null
    const { summaries, diagnostics } = await registrySummaries(cwd)
    if (diagnostics && diagnostics.error) registryError = diagnostics.error
    for (const summary of summaries) {
      // 注册表给的是「全局 + 当前作用域」的合并视图，这里按作用域裁剪：
      // 工作区作用域只保留项目来源，用户作用域只保留非项目来源。
      const isProjectSource = PROJECT_SOURCES.has(summary.source)
      if (isProjectSource !== projectScope) continue
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
    const value = { roots: rootMeta, skills: merged, registryError, diagnostics }
    skillsCache.set(cwd, { at: Date.now(), value })
    return value
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

  /** 路径比较：Windows 大小写不敏感，统一分隔符与结尾斜杠。 */
  const samePath = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
    const norm = (value) => {
      const unified = value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
      return process.platform === 'win32' ? unified.toLowerCase() : unified
    }
    return norm(a) === norm(b)
  }

  /**
   * 客户端传来的 cwd 只接受「已登记工作区」的路径：
   * 否则本机任意调用方都能让面板去扫任意绝对路径下的 .dsh/skills 并读到技能全文。
   */
  const resolveCwd = (value) => {
    const cwd = normalizeCwd(value)
    if (cwd === '') return ''
    const workspaces = listWorkspaces()
    if (workspaces.length === 0) return ''
    const hit = workspaces.find((workspace) => samePath(workspace.path, cwd))
    return hit ? hit.path : ''
  }

  /** 写操作的落点根：全局根固定；项目根必须来自已登记工作区。 */
  const writeTargetRoot = (target, cwd) => {
    const configured = filesystemConfig()
    const dshHome = typeof configured.dshHome === 'string' ? configured.dshHome : process.env.DSH_HOME || join(homedir(), '.dsh')
    if (target !== 'project') return join(dshHome, 'skills')
    const projectRoot = projectRootsFor(cwd).find((root) => root.label === 'project-dsh')
    if (!projectRoot || cwd === '') return null
    return projectRoot.path
  }

  /** 依赖包目录内的技能（预设内置）不可写——改坏会连累官方包。 */
  const insideNodeModules = (target) => {
    if (typeof target !== 'string') return false
    // 用真实路径判定：用户自建的同名目录不算官方包，经符号链接进入官方包才算。
    const real = realPathOf(target) || resolve(target)
    return real.split(/[\\/]+/).includes('node_modules')
  }

  /* ------------------------------ 路由 ------------------------------ */

  const stateRoute = async (request, response, params) => {
    // 显式刷新：绕过两级缓存，重新扫描磁盘。
    if (params.get('refresh') === '1') invalidateSkillsCache()
    const cwd = resolveCwd(params.get('cwd') || '')
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
    const { skills } = await listSkills(resolveCwd(payload.cwd))
    const skill = findSkill(skills, name)
    if (!skill) return sendError(response, 404, '找不到技能：' + name, undefined, 'skill-not-found', { name })
    let content = ''
    let truncated = false
    if (skill.path && existsSync(skill.path)) {
      // 只读头部：超大 SKILL.md 不必整file读进内存。
      content = readTextHead(skill.path, CONTENT_PREVIEW_BYTES) || ''
      truncated = Buffer.byteLength(content, 'utf8') >= CONTENT_PREVIEW_BYTES
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
    const { skills } = await listSkills(resolveCwd(payload.cwd))
    const skill = findSkill(skills, name)
    if (!skill || !skill.dir || !skill.exists) return sendError(response, 404, '该技能没有可打开的本地目录', undefined, 'no-local-dir')
    const dir = resolve(skill.dir)
    if (skill.rootPath && (!withinRoot(dir, skill.rootPath) || !realWithinRoot(dir, skill.rootPath))) {
      return sendError(response, 403, '拒绝打开技能目录之外的路径', undefined, 'outside-root')
    }
    if (!existsSync(dir)) return sendError(response, 404, '目录不存在：' + dir, undefined, 'dir-missing', { path: dir })
    const { spawn } = await import('node:child_process')
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    // 平铺 .md 技能没有独立目录：打开文件本身（资源管理器会定位到该文件）。
    const target = skill.isFlat ? resolve(skill.path) : dir
    const child = spawn(command, [target], { detached: true, stdio: 'ignore' })
    child.unlink()
    log('opened directory: ' + target)
    sendJson(response, 200, { ok: true, opened: dir })
  }

  /** 启停：改写 frontmatter 的 disable-model-invocation（DSH 原生语义）。 */
  const toggleRoute = async (request, response) => {
    const payload = await readJsonBody(request)
    const name = typeof payload.name === 'string' ? payload.name : ''
    const disabled = payload.disabled === true
    const { skills } = await listSkills(resolveCwd(payload.cwd))
    const skill = findSkill(skills, name)
    if (!skill) return sendError(response, 404, '找不到技能：' + name, undefined, 'skill-not-found', { name })
    if (!skill.path || !existsSync(skill.path)) return sendError(response, 400, '该技能没有可改写的 SKILL.md', undefined, 'skill-not-writable')
    if (!isManagedRoot(skill.source)) return sendError(response, 400, '内置或运行时技能不可改写', undefined, 'skill-readonly')
    if (insideNodeModules(skill.path)) return sendError(response, 400, '官方包内置技能不可改写', undefined, 'skill-readonly')
    if (!skill.rootPath || !withinRoot(skill.path, skill.rootPath) || !realWithinRoot(skill.path, skill.rootPath)) {
      return sendError(response, 403, '拒绝改写技能根之外的路径', undefined, 'outside-root')
    }
    let raw
    try {
      raw = readFileSync(skill.path)
    } catch (error) {
      return sendError(response, 500, '读取 SKILL.md 失败：' + String(error && error.message ? error.message : error))
    }
    const text = raw.toString('utf8')
    // 非 UTF-8（如 GBK）文件一旦按 UTF-8 读写，中文会变成 U+FFFD 且不可逆——直接拒绝改写。
    if (!isLosslessUtf8(raw)) {
      return sendError(response, 400, 'SKILL.md 不是 UTF-8 编码，已拒绝改写以免损坏内容', undefined, 'not-utf8')
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
      // 写前再确认目标不是链接：扫描与写入之间可能被换成 junction。
      const st = lstatSync(skill.path)
      if (st.isSymbolicLink()) return sendError(response, 403, '目标已被替换为链接，拒绝改写', undefined, 'outside-root')
      // 先写临时文件再原子替换：中途失败不会把用户的 SKILL.md 写成半截。
      const temp = skill.path + '.dsm-tmp'
      writeFileUtf8(temp, next)
      renameSync(temp, skill.path)
    } catch (error) {
      try {
        rmSync(skill.path + '.dsm-tmp', { force: true })
      } catch {
        /* 临时文件清理失败不影响主流程 */
      }
      return sendError(response, 500, '写入 SKILL.md 失败：' + String(error && error.message ? error.message : error))
    }
    invalidateSkillsCache()
    log((disabled ? 'disabled ' : 'enabled ') + name + ' (' + skill.path + ')')
    sendJson(response, 200, { ok: true, changed: true, name, disabled })
  }

  /** 删除：只允许受管根下的技能；软链只删链接。 */
  const removeRoute = async (request, response) => {
    const payload = await readJsonBody(request)
    const name = typeof payload.name === 'string' ? payload.name : ''
    const { skills } = await listSkills(resolveCwd(payload.cwd))
    const skill = findSkill(skills, name)
    if (!skill) return sendError(response, 404, '找不到技能：' + name, undefined, 'skill-not-found', { name })
    if (!skill.path || !existsSync(skill.path)) return sendError(response, 400, '该技能没有可删除的本地文件', undefined, 'skill-not-writable')
    if (!isManagedRoot(skill.source)) return sendError(response, 400, '内置或运行时技能不可删除', undefined, 'skill-readonly')
    if (insideNodeModules(skill.path)) return sendError(response, 400, '官方包内置技能不可删除', undefined, 'skill-readonly')
    if (!skill.rootPath || !withinRoot(skill.path, skill.rootPath) || !realWithinRoot(skill.path, skill.rootPath)) {
      return sendError(response, 403, '拒绝删除技能根之外的路径', undefined, 'outside-root')
    }
    const target = resolve(skill.path)
    try {
      const st = lstatSync(target)
      if (st.isSymbolicLink()) {
        unlinkSync(target)
      } else if (skill.isBundle) {
        const dir = dirname(target)
        // 技能目录本身是符号链接时只删链接，绝不递归删除链接指向的真实目录。
        const dirStat = lstatSync(dir)
        if (dirStat.isSymbolicLink()) {
          unlinkSync(dir)
        } else {
          // 硬防线：技能目录绝不能等于受管根本身，否则一次删除会抹掉整个根目录。
          if (samePath(dir, skill.rootPath)) {
            return sendError(response, 400, '拒绝删除技能根目录本身', undefined, 'delete-root-refused')
          }
          // 先改名再删：缩小「校验通过 → 实际删除」之间的时序窗口。
          const trash = dir + '.dsm-trash-' + Date.now()
          renameSync(dir, trash)
          rmSync(trash, { recursive: true, force: true })
        }
      } else {
        rmSync(target, { force: true })
      }
    } catch (error) {
      return sendError(response, 500, '删除失败：' + String(error && error.message ? error.message : error))
    }
    invalidateSkillsCache()
    log('removed ' + name + ' (' + target + ')')
    sendJson(response, 200, { ok: true, removed: name })
  }

  /** 新建：生成一个最小可用的技能目录。 */
  const createRoute = async (request, response) => {
    const payload = await readJsonBody(request)
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    const description = typeof payload.description === 'string' ? payload.description.trim() : ''
    if (!isValidSkillName(name)) return sendError(response, 400, '技能名必须是 kebab-case（仅小写字母、数字与连字符）', undefined, 'invalid-name')
    if (description === '') return sendError(response, 400, '描述不能为空', undefined, 'empty-description')
    if (description.length > 500) return sendError(response, 400, '描述过长（上限 500 字）', undefined, 'description-too-long')
    const cwd = resolveCwd(payload.cwd)
    const targetRoot = writeTargetRoot(payload.target, cwd)
    if (!targetRoot) return sendError(response, 400, '目标根不可用（项目落点必须来自已登记的工作区）', undefined, 'target-root-unavailable')
    const dir = join(targetRoot, name)
    if (!withinRoot(dir, targetRoot)) return sendError(response, 400, '非法的技能名', undefined, 'invalid-name')
    if (existsSync(dir)) return sendError(response, 409, '技能已存在：' + name, undefined, 'skill-exists', { name })
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
    if (!isValidSkillName(name)) return sendError(response, 400, '非法的技能名', undefined, 'invalid-name')
    const external = scanExternalRoots(externalAgentRoots()).find((root) => root.id === sourceId)
    if (!external) return sendError(response, 400, '未知的外部来源：' + sourceId, undefined, 'unknown-source', { source: sourceId })
    const candidate = external.skills.find((skill) => skill.name === name)
    if (!candidate) return sendError(response, 404, '外部目录里找不到技能：' + name, undefined, 'external-skill-not-found', { name })

    const cwd = resolveCwd(payload.cwd)
    const targetRoot = writeTargetRoot(payload.target, cwd)
    if (!targetRoot) return sendError(response, 400, '目标根不可用（项目落点必须来自已登记的工作区）', undefined, 'target-root-unavailable')
    const sourceDir = candidate.dir || dirname(candidate.path)
    // 平铺 .md 技能没有自己的目录：落点用同名 .md 文件（DSH 也按平铺文件识别）。
    const dest = candidate.isFlat ? join(targetRoot, name + '.md') : join(targetRoot, name)
    if (!withinRoot(dest, targetRoot)) return sendError(response, 400, '非法的目标路径', undefined, 'invalid-name')
    if (existsSync(dest)) return sendError(response, 409, '目标已存在同名技能：' + name, undefined, 'target-exists', { name })
    try {
      mkdirSync(targetRoot, { recursive: true })
      if (candidate.isFlat) {
        if (mode === 'link') symlinkSync(candidate.path, dest, 'file')
        else copyFileSync(candidate.path, dest)
      } else if (mode === 'link') {
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
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return sendError(response, 405, 'method not allowed: ' + (request.method || ''), { allow: 'GET, HEAD' })
      }
      const params = new URL(request.url || '/', 'http://loopback').searchParams
      stateRoute(request, response, params).catch((error) => {
        log('state failed: ' + (error && error.stack ? error.stack : error))
        sendError(response, errorStatusOf(error), 'internal error')
      })
    })

    const post = (path, handler) => {
      register(path, (request, response) => {
        if (!isLoopbackRequest(request)) return sendError(response, 403, 'loopback requests only')
        if (request.method !== 'POST') {
          return sendError(response, 405, 'method not allowed: ' + (request.method || ''), { allow: 'POST' })
        }
        handler(request, response).catch((error) => {
          const status = errorStatusOf(error)
          if (status === 500) {
            log(path + ' failed: ' + (error && error.stack ? error.stack : error))
            sendError(response, 500, 'internal error', undefined, 'internal-error')
            return
          }
          sendError(response, status, String(error && error.message ? error.message : error), undefined, error && error.name === 'BadRequestError' ? 'bad-json' : error && error.name === 'BodyTooLargeError' ? 'body-too-large' : undefined)
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
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return sendError(response, 405, 'method not allowed: ' + (request.method || ''), { allow: 'GET, HEAD' })
      }
      externalRoute(request, response).catch((error) => sendError(response, errorStatusOf(error), 'internal error'))
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
      // 释放缓存的 preset 作用域租约，避免插件卸载后仍占着常驻组合。
      for (const lease of presetScopeLeases) {
        try {
          if (lease && typeof lease[Symbol.asyncDispose] === 'function') lease[Symbol.asyncDispose]()
        } catch {
          /* ignore */
        }
      }
      presetScopeLeases.length = 0
      presetScopeCache = null
    }, 'dsh-skills-manager routes')
  })
}

/** 写文本（UTF-8）。 */
function writeFileUtf8(path, content) {
  writeFileSync(path, content, 'utf8')
}
