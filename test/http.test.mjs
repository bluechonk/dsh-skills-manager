// http.test.mjs —— 宿主半 HTTP 层的直测面（零 DOM、零 npm 依赖）。
//
// 手法：伪造最小 ctx（webServer / loader / workspaceRegistry），调用 apply() 后拿到注册表，
// 用假的 req/res 打各条路由，断言状态码与副作用。

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

/** 假响应：收集状态码、响应头与响应体。 */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value },
    end(body) { if (body !== undefined) this.body = String(body) },
    json() { return JSON.parse(this.body || '{}') },
  }
}

/** 假请求：方法、头、来源地址与可选请求体。 */
function makeRequest(options = {}) {
  const body = options.body === undefined ? null : options.body
  return {
    method: options.method || 'GET',
    url: options.url || '/',
    headers: Object.assign({ host: '127.0.0.1:39180' }, options.headers || {}),
    socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
    on(event, handler) {
      if (event === 'data' && body !== null) handler(Buffer.from(body))
      if (event === 'end') handler()
    },
    resume() {},
    destroy() {},
  }
}

/** 搭一套宿主：临时技能根 + 可控的 loader/工作区。 */
function makeHost(options = {}) {
  const home = options.home || mkdtempSync(join(tmpdir(), 'dsm-http-'))
  const skillsRoot = options.skillsRoot || join(home, 'skills')
  mkdirSync(skillsRoot, { recursive: true })
  const workspaces = options.workspaces || []
  const routes = new Map()
  const services = {
    loader: {
      entries: () => [
        {
          options: {
            name: '@deepseek-ai/dsh-skill-filesystem',
            config: { dshHome: home, agentsHome: home },
          },
        },
      ],
    },
    workspaceRegistry: { list: () => workspaces },
    profileContext: { dir: home },
  }
  const ctx = {
    get: (name) => services[name],
    inject: (names, fn) => fn({ webServer: services.webServer, loader: services.loader }),
    effect: () => () => {},
  }
  services.webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  apply(ctx, {})
  return { home, skillsRoot, routes }
}

async function call(host, path, options = {}) {
  const route = host.routes.get(path)
  assert.ok(route, '路由未注册：' + path)
  const request = makeRequest(options)
  const response = makeResponse()
  route.handler(request, response)
  // 路由处理器是异步的：等一个微任务批次让 promise 链跑完。
  await new Promise((resolve) => setTimeout(resolve, 30))
  return response
}

test('GET /state 返回技能清单与统计', async () => {
  const host = makeHost()
  try {
    writeFileSync(join(host.skillsRoot, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\n', { encoding: 'utf8', flag: 'w' })
  } catch {
    /* 目录不存在时先建 */
  }
  try {
    mkdirSync(join(host.skillsRoot, 'demo'), { recursive: true })
    writeFileSync(join(host.skillsRoot, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\n', 'utf8')
    const response = await call(host, '/dsh-skills-manager/state')
    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.ok, true)
    assert.ok(payload.skills.some((skill) => skill.name === 'demo'))
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('方法不匹配返回 405 并带 Allow 头', async () => {
  const host = makeHost()
  try {
    const response = await call(host, '/dsh-skills-manager/state', { method: 'POST', body: '{}' })
    assert.equal(response.statusCode, 405)
    assert.equal(response.headers.allow, 'GET, HEAD')
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('跨站来源与非常规来源地址都被拒', async () => {
  const host = makeHost()
  try {
    const crossSite = await call(host, '/dsh-skills-manager/state', { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(crossSite.statusCode, 403)
    const badOrigin = await call(host, '/dsh-skills-manager/state', { headers: { origin: 'http://evil.example' } })
    assert.equal(badOrigin.statusCode, 403)
    const remote = await call(host, '/dsh-skills-manager/state', { remoteAddress: '10.0.0.5' })
    assert.equal(remote.statusCode, 403)
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('非法 JSON 与 null 载荷返回 400（不是 500）', async () => {
  const host = makeHost()
  try {
    const broken = await call(host, '/dsh-skills-manager/toggle', { method: 'POST', body: '{not json' })
    assert.equal(broken.statusCode, 400)
    const nullBody = await call(host, '/dsh-skills-manager/toggle', { method: 'POST', body: 'null' })
    assert.equal(nullBody.statusCode, 400)
    const arrayBody = await call(host, '/dsh-skills-manager/toggle', { method: 'POST', body: '[]' })
    assert.equal(arrayBody.statusCode, 400)
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('超大请求体返回 413', async () => {
  const host = makeHost()
  try {
    const big = 'x'.repeat(1024 * 1024 + 1024)
    const response = await call(host, '/dsh-skills-manager/toggle', { method: 'POST', body: JSON.stringify({ name: 'demo', description: big }) })
    assert.equal(response.statusCode, 413)
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('写操作全链路：新建 → 禁用 → 启用 → 删除', async () => {
  const host = makeHost()
  try {
    const created = await call(host, '/dsh-skills-manager/create', {
      method: 'POST',
      body: JSON.stringify({ name: 'demo-skill', description: '自检技能' }),
    })
    assert.equal(created.statusCode, 200)
    const file = join(host.skillsRoot, 'demo-skill', 'SKILL.md')
    assert.ok(readFileSync(file, 'utf8').includes('name: demo-skill'))

    const disabled = await call(host, '/dsh-skills-manager/toggle', {
      method: 'POST',
      body: JSON.stringify({ name: 'demo-skill', disabled: true }),
    })
    assert.equal(disabled.statusCode, 200)
    assert.match(readFileSync(file, 'utf8'), /disable-model-invocation: true/)

    const enabled = await call(host, '/dsh-skills-manager/toggle', {
      method: 'POST',
      body: JSON.stringify({ name: 'demo-skill', disabled: false }),
    })
    assert.equal(enabled.statusCode, 200)
    assert.doesNotMatch(readFileSync(file, 'utf8'), /disable-model-invocation/)

    const removed = await call(host, '/dsh-skills-manager/remove', {
      method: 'POST',
      body: JSON.stringify({ name: 'demo-skill' }),
    })
    assert.equal(removed.statusCode, 200)
    // 技能目录应已被删除
    assert.equal(existsSync(join(host.skillsRoot, 'demo-skill')), false)
    const state = await call(host, '/dsh-skills-manager/state')
    assert.equal(state.json().skills.some((skill) => skill.name === 'demo-skill'), false)
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('删除根目录下平铺的 skill.md 不会抹掉整个根', async () => {
  const host = makeHost()
  try {
    writeFileSync(join(host.skillsRoot, 'skill.md'), '---\nname: root-skill\ndescription: 平铺\n---\n', 'utf8')
    mkdirSync(join(host.skillsRoot, 'other-skill'), { recursive: true })
    writeFileSync(join(host.skillsRoot, 'other-skill', 'SKILL.md'), '---\nname: other-skill\ndescription: 目录技能\n---\n', 'utf8')

    const removed = await call(host, '/dsh-skills-manager/remove', {
      method: 'POST',
      body: JSON.stringify({ name: 'root-skill' }),
    })
    assert.equal(removed.statusCode, 200)
    // 根目录与其它技能必须还在
    assert.ok(readFileSync(join(host.skillsRoot, 'other-skill', 'SKILL.md'), 'utf8').includes('other-skill'))
    const state = await call(host, '/dsh-skills-manager/state')
    assert.ok(state.json().skills.some((skill) => skill.name === 'other-skill'))
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('非 UTF-8 的 SKILL.md 拒绝改写且字节不变', async () => {
  const host = makeHost()
  try {
    const dir = join(host.skillsRoot, 'gbk-skill')
    mkdirSync(dir, { recursive: true })
    // GBK 的「你好」
    const gbk = Buffer.concat([
      Buffer.from('---\nname: gbk-skill\ndescription: ', 'latin1'),
      Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
      Buffer.from('\n---\n', 'latin1'),
    ])
    writeFileSync(join(dir, 'SKILL.md'), gbk)
    const before = readFileSync(join(dir, 'SKILL.md'))

    const response = await call(host, '/dsh-skills-manager/toggle', {
      method: 'POST',
      body: JSON.stringify({ name: 'gbk-skill', disabled: true }),
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(readFileSync(join(dir, 'SKILL.md')), before)
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('未登记的技能返回 404，非法来源返回 400', async () => {
  const host = makeHost()
  try {
    const missing = await call(host, '/dsh-skills-manager/remove', {
      method: 'POST',
      body: JSON.stringify({ name: 'not-exist' }),
    })
    assert.equal(missing.statusCode, 404)
    const badImport = await call(host, '/dsh-skills-manager/import', {
      method: 'POST',
      body: JSON.stringify({ source: 'nope', name: 'x', mode: 'copy' }),
    })
    assert.equal(badImport.statusCode, 400)
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('未登记工作区的 cwd 不会成为项目落点', async () => {
  const host = makeHost({ workspaces: [] })
  try {
    const created = await call(host, '/dsh-skills-manager/create', {
      method: 'POST',
      body: JSON.stringify({ name: 'proj-skill', description: '项目技能', cwd: 'C:/Windows/Temp', target: 'project' }),
    })
    assert.equal(created.statusCode, 400)
  } finally {
    rmSync(host.home, { recursive: true, force: true })
  }
})

test('切到工作区作用域：只读该工作区的 .dsh/skills 与 .agents/skills，全局技能仍在', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsm-scope-'))
  try {
    // 全局根放一个技能
    const globalRoot = join(home, 'skills')
    mkdirSync(join(globalRoot, 'global-skill'), { recursive: true })
    writeFileSync(join(globalRoot, 'global-skill', 'SKILL.md'), '---\nname: global-skill\ndescription: 全局技能\n---\n', 'utf8')
    // 工作区放两个技能：.dsh/skills 与 .agents/skills
    const workspace = join(home, 'project')
    mkdirSync(join(workspace, '.dsh', 'skills', 'proj-skill'), { recursive: true })
    writeFileSync(join(workspace, '.dsh', 'skills', 'proj-skill', 'SKILL.md'), '---\nname: proj-skill\ndescription: 项目技能\n---\n', 'utf8')
    mkdirSync(join(workspace, '.agents', 'skills', 'agent-skill'), { recursive: true })
    writeFileSync(join(workspace, '.agents', 'skills', 'agent-skill', 'SKILL.md'), '---\nname: agent-skill\ndescription: 工作区 agents 技能\n---\n', 'utf8')

    const host = makeHost({ home, skillsRoot: globalRoot, workspaces: [{ id: 'w1', title: 'project', path: workspace }] })
    // 全局作用域：只有全局技能
    const globalState = (await call(host, '/dsh-skills-manager/state')).json()
    assert.equal(globalState.skills.some((skill) => skill.name === 'global-skill'), true)
    assert.equal(globalState.skills.some((skill) => skill.name === 'proj-skill'), false)
    assert.equal(globalState.skills.some((skill) => skill.name === 'agent-skill'), false)

    // 工作区作用域：全局技能 + 该工作区的两个技能
    const scoped = (await call(host, '/dsh-skills-manager/state', { url: '/dsh-skills-manager/state?cwd=' + encodeURIComponent(workspace) })).json()
    const names = scoped.skills.map((skill) => skill.name)
    assert.equal(names.includes('global-skill'), true)
    assert.equal(names.includes('proj-skill'), true)
    assert.equal(names.includes('agent-skill'), true)
    // 项目技能标注正确的来源根
    assert.equal(scoped.skills.find((skill) => skill.name === 'proj-skill').source, 'project-dsh')
    assert.equal(scoped.skills.find((skill) => skill.name === 'agent-skill').source, 'project-agents')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('同名技能以工作区那份为准（rank 更低者优先）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsm-dup-'))
  try {
    const globalRoot = join(home, 'skills')
    mkdirSync(join(globalRoot, 'dup'), { recursive: true })
    writeFileSync(join(globalRoot, 'dup', 'SKILL.md'), '---\nname: dup\ndescription: 全局那份\n---\n', 'utf8')
    const workspace = join(home, 'project')
    mkdirSync(join(workspace, '.dsh', 'skills', 'dup'), { recursive: true })
    writeFileSync(join(workspace, '.dsh', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: 项目那份\n---\n', 'utf8')

    const host = makeHost({ home, skillsRoot: globalRoot, workspaces: [{ id: 'w1', title: 'project', path: workspace }] })
    const scoped = (await call(host, '/dsh-skills-manager/state', { url: '/dsh-skills-manager/state?cwd=' + encodeURIComponent(workspace) })).json()
    const dup = scoped.skills.filter((skill) => skill.name === 'dup')
    assert.equal(dup.length, 1)
    assert.equal(dup[0].description, '项目那份')
    assert.equal(dup[0].source, 'project-dsh')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
