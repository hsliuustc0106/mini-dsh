import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Service } from '@deepseek-ai/cordis'
import { project } from './trajectory.js'
import { installPlugin } from './install-plugin.js'
import { BUILTIN_PLUGIN_NAMES, loadProfileEntries, readPluginProfile, uninstallPlugin } from './live-plugins.js'
import { installedPlugins, updatePluginSettings, updatePluginToolPolicies } from './plugin-admin.js'
import { ClientHost, loadClientProfile } from './client-plugins.js'

const HOST = '127.0.0.1'
const MAX_BODY = 1024 * 1024

export function pluginInstallSpec(input) {
  if (typeof input !== 'string') throw new Error('Enter a GitHub repository URL or npm package')
  const value = input.trim()
  if (/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9][a-z0-9._-]*)?$/i.test(value)) return value
  // Local package paths are allowed on loopback so tests and trusted local tarballs can activate live.
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return value
  let url
  try { url = new URL(value) } catch { throw new Error('Enter a GitHub repository URL or npm package') }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password || url.search || !/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/.test(url.pathname) || (url.hash && !/^#[a-zA-Z0-9_.\/-]+$/.test(url.hash))) {
    throw new Error('Use an HTTPS GitHub repository URL, optionally followed by #ref')
  }
  return `git+https://github.com${url.pathname.replace(/\/$/, '')}${url.hash}`
}

export function webControlSettings(env = process.env) {
  const raw = env.MINI_WEB_PORT
  // Profiles can disable or replace this plugin without reading its port.
  return {
    get port() {
      if (raw == null || raw === '') return 7484
      if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error(`MINI_WEB_PORT is invalid: ${raw}`)
      return Number(raw)
    },
  }
}

function send(res, status, type, body) {
  const payload = Buffer.from(body)
  res.writeHead(status, {
    'content-type': type,
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  })
  res.end(payload)
}

function json(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

async function bodyOf(req) {
  let length = 0
  const chunks = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY) throw new Error('Request is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function cursorOf(req, url) {
  const raw = req.headers['last-event-id'] || url.searchParams.get('after') || '0'
  const cursor = Number(raw)
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(cursor)) throw new Error('Invalid event cursor')
  return cursor
}

// A web turn owns its approval channel. Disconnecting that channel never
// transfers an approval to a later connection, even for the same call id.
export class WebControl extends Service {
  static inject = ['agent', 'session', 'workspace', 'livePlugins', 'permissions', 'tools']

  constructor(ctx, config = {}) {
    super(ctx, 'webControl')
    if (config.host != null && config.host !== HOST) throw new Error('Web control listens on 127.0.0.1 only')
    this.port = config.port ?? 0
    this.pluginConfig = config.pluginConfig
    this.clientPlugins = config.clientPlugins
    this.client = null
    this.installing = false
    this.changing = false
    this.policyReleases = new Map()
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535) throw new Error('Web control port is invalid')
    this.clients = new Map()
    this.pending = null
    this.server = null
    this.url = null
    this.error = null
    this.closed = false
    this.lastState = ''
    this.ctx.effect(() => () => this.close(), 'web-control')
  }

  broadcastClient() {
    if (this.closed || !this.client || this.client.disposed) return
    const data = JSON.stringify(this.client.view())
    for (const res of this.clients.values()) this.emit(res, 'client-ui', data)
  }

  async [Service.init]() {
    this.client = new ClientHost()
    this.ctx.effect(() => () => this.client?.dispose(), 'client-plugins')
    await this.client.start()
    const entries = await loadClientProfile({
      pluginConfig: this.pluginConfig,
      workspace: this.ctx.workspace.root,
      clientPlugins: this.clientPlugins,
    })
    await this.client.mountAll(entries)
    this.ctx.effect(() => this.client.slots.subscribe(() => this.broadcastClient()), 'client-ui')
    const files = await Promise.all(['index.html', 'style.css', 'app.js'].map((name) => readFile(new URL(`./web/${name}`, import.meta.url))))
    this.files = new Map([
      ['/', ['text/html; charset=utf-8', files[0]]],
      ['/style.css', ['text/css; charset=utf-8', files[1]]],
      ['/app.js', ['text/javascript; charset=utf-8', files[2]]],
    ])
    if (this.closed) return
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.ctx.logger.error(error)
        if (!res.headersSent && !res.destroyed) send(res, 500, 'text/plain; charset=utf-8', 'Web control failed\n')
      })
    })
    server.requestTimeout = 0
    this.server = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, HOST, () => {
        server.off('error', reject)
        this.url = `http://${HOST}:${server.address().port}`
        resolve()
      })
    })
    // Terminal turns share the agent, so report their busy state too.
    this.timer = setInterval(() => this.broadcastState(), 250)
    this.timer.unref()
  }

  state() {
    return {
      busy: this.ctx.agent.busy,
      writable: this.ctx.session.writable,
      reason: this.ctx.session.readonlyReason,
      error: this.error,
    }
  }

  broadcastState() {
    if (this.closed) return
    const state = JSON.stringify(this.state())
    if (state === this.lastState) return
    this.lastState = state
    for (const res of this.clients.values()) this.emit(res, 'state', state)
  }

  emit(res, event, data, id) {
    if (res.destroyed || res.writableEnded) return
    res.write(`${id == null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${data}\n\n`)
    res.socket?.uncork()
  }

  trusted(req) {
    const host = req.headers.host ?? ''
    const forwarded = /^localhost:(\d{1,5})$/.exec(host)
    // The in-app browser forwards the loopback server to a localhost port.
    // Accept that address only when Origin still matches the browser's Host.
    if (host !== new URL(this.url).host && !(forwarded && Number(forwarded[1]) > 0 && Number(forwarded[1]) <= 65535)) return false
    const origin = req.headers.origin
    const expectedOrigin = `http://${host}`
    const site = req.headers['sec-fetch-site']
    if (origin && origin !== expectedOrigin) return false
    if (site && site !== 'same-origin' && !(req.method === 'GET' && site === 'none')) return false
    if (req.method === 'POST' && origin !== expectedOrigin) return false
    return true
  }

  async handle(req, res) {
    if (!this.trusted(req)) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden\n')
    const url = new URL(req.url ?? '/', this.url)
    if (req.method === 'GET' && this.files.has(url.pathname)) {
      const [type, body] = this.files.get(url.pathname)
      return send(res, 200, type, body)
    }
    if (req.method === 'GET' && url.pathname === '/trajectory') {
      // Recomputed from the session log on every read. An unfinished span is
      // marked open only while the agent is still busy.
      const projection = project(this.ctx.session.events)
      const overview = projection.overview.map(({ tokens, ...span }) => ({
        ...span,
        status: span.status === 'unknown' && !span.endTime && this.ctx.agent.busy && this.ctx.session.writable ? 'open' : span.status,
      }))
      return json(res, 200, { cursor: projection.cursor, overview })
    }
    if (req.method === 'GET' && url.pathname === '/events') return this.stream(req, res, url)
    if (req.method === 'GET' && url.pathname === '/plugins') return this.plugins(res)
    if (req.method === 'GET' && url.pathname === '/client-ui') {
      return json(res, 200, this.client.view())
    }
    if (req.method !== 'POST' || !['/turn', '/approval', '/plugins/install', '/plugins/uninstall', '/plugins/config', '/plugins/permissions'].includes(url.pathname)) {
      return send(res, 404, 'text/plain; charset=utf-8', 'Not found\n')
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'JSON required' })
    if (Number(req.headers['content-length']) > MAX_BODY) return json(res, 413, { error: 'Request is too large' })
    let data
    try { data = await bodyOf(req) }
    catch { return json(res, 400, { error: 'Invalid request body' }) }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json(res, 400, { error: 'Invalid request body' })
    if (url.pathname === '/turn') return this.startTurn(res, data)
    if (url.pathname === '/plugins/install') return this.install(res, data)
    if (url.pathname === '/plugins/uninstall') return this.uninstall(res, data)
    if (url.pathname === '/plugins/config') return this.configurePlugin(res, data)
    if (url.pathname === '/plugins/permissions') return this.permitTools(res, data)
    return this.answer(res, data)
  }

  async plugins(res) {
    try { return json(res, 200, await installedPlugins(this.ctx, this.pluginConfig)) }
    catch (error) { return json(res, 400, { error: error.message }) }
  }

  // User policies are effects on this fiber. Disposing the web control server
  // drops the override; the profile is what the next boot applies.
  applyPolicyOverlay(policies) {
    for (const [name, decision] of Object.entries(policies)) {
      this.policyReleases.get(name)?.()
      this.policyReleases.set(name, this.ctx.effect(() => this.ctx.permissions.overlay(name, decision), `tool-policy:${name}`))
    }
  }

  async configurePlugin(res, data) {
    if (typeof data.name !== 'string' || !data.name.trim()) return json(res, 400, { error: 'Plugin name is required' })
    if (!data.config || typeof data.config !== 'object' || Array.isArray(data.config)) return json(res, 400, { error: 'Plugin settings must be an object' })
    if (this.installing || this.changing || this.ctx.livePlugins.changing) return json(res, 409, { error: 'A plugin change is already in progress' })
    if (this.ctx.agent.busy) return json(res, 409, { error: 'Cannot change plugins while a turn is in progress' })
    this.changing = true
    try {
      const result = await updatePluginSettings(this.ctx, this.pluginConfig, data.name, data.config)
      return json(res, 200, result)
    } catch (error) {
      return json(res, error.status === 409 ? 409 : 400, { error: error.message, active: false, restored: Boolean(error.restoreProfile) })
    } finally { this.changing = false }
  }

  async permitTools(res, data) {
    if (typeof data.name !== 'string' || !data.name.trim()) return json(res, 400, { error: 'Plugin name is required' })
    if (!data.policies || typeof data.policies !== 'object' || Array.isArray(data.policies)) return json(res, 400, { error: 'Tool policies must be an object' })
    if (this.installing || this.changing || this.ctx.livePlugins.changing) return json(res, 409, { error: 'A plugin change is already in progress' })
    if (this.ctx.agent.busy) return json(res, 409, { error: 'Cannot change plugins while a turn is in progress' })
    this.changing = true
    try {
      const policies = await updatePluginToolPolicies(this.ctx, this.pluginConfig, data.name, data.policies)
      this.applyPolicyOverlay(policies)
      const summary = Object.entries(policies).map(([tool, decision]) => `${tool} is ${decision}`).join('; ')
      return json(res, 200, { name: data.name, active: true, policies, message: `Active now. ${summary}.` })
    } catch (error) {
      return json(res, 400, { error: error.message, active: false })
    } finally { this.changing = false }
  }

  async install(res, data) {
    let spec
    try { spec = pluginInstallSpec(data.spec) }
    catch (error) { return json(res, 400, { error: error.message }) }
    if (this.installing || this.changing) return json(res, 409, { error: 'A plugin change is already in progress' })
    let reservation
    try { reservation = this.ctx.livePlugins.beginChange() }
    catch (error) { return json(res, 409, { error: error.message }) }
    this.installing = true
    try {
      let result
      try {
        result = await installPlugin(spec, this.ctx.workspace.root, { configPath: this.pluginConfig, captureOutput: true })
      } catch (error) {
        return json(res, 400, { error: error.message, phase: 'package' })
      }
      try {
        const entries = await loadProfileEntries(result.configPath, result.names)
        const plugins = await this.ctx.livePlugins.mountAll(entries, reservation)
        return json(res, 200, {
          packageName: result.packageName,
          names: result.names,
          installedNames: result.installedNames,
          configPath: result.configPath,
          restartRequired: false,
          phase: result.names.length ? 'active' : 'installed',
          plugins,
        })
      } catch (error) {
        return json(res, 400, {
          error: error.message,
          phase: 'activation',
          packageName: result.packageName,
          names: result.names,
          installedNames: result.installedNames,
          configPath: result.configPath,
          restartRequired: true,
        })
      }
    } finally {
      this.installing = false
      this.ctx.livePlugins.endChange(reservation)
    }
  }

  async uninstall(res, data) {
    if (typeof data.name !== 'string' || !data.name.trim()) return json(res, 400, { error: 'Plugin name is required' })
    if (data.names !== undefined && (!Array.isArray(data.names) || data.names.some((name) => typeof name !== 'string'))) return json(res, 400, { error: 'Invalid removal list' })
    if (this.installing || this.changing) return json(res, 409, { error: 'A plugin change is already in progress' })
    this.changing = true
    try {
      try {
        if (data.preview === true) {
          const profile = await readPluginProfile(this.pluginConfig)
          const names = this.ctx.livePlugins.removalPlan(data.name)
          for (const name of names) if (!profile.plugins.some((entry) => entry.name === name)) throw new Error(`Plugin ${name} is not in the profile`)
          return json(res, 200, { name: data.name, names, phase: 'preview' })
        }
        const result = await uninstallPlugin(data.name, this.ctx.workspace.root, { configPath: this.pluginConfig, livePlugins: this.ctx.livePlugins, expectedNames: data.names })
        return json(res, 200, { name: result.name, names: result.names, configPath: result.configPath, restartRequired: false, phase: 'removed' })
      } catch (error) {
        return json(res, 400, { error: error.message, phase: error.code === 'PLUGIN_DEPENDENTS' ? 'dispose' : 'profile',
          ...(error.code === 'PLUGIN_DEPENDENTS' ? { code: error.code, dependents: error.dependents.map((item) => ({ ...item, removable: !BUILTIN_PLUGIN_NAMES.has(item.name) })) } : {}),
        })
      }
    } finally { this.changing = false }
  }

  stream(req, res, url) {
    let after
    try { after = cursorOf(req, url) }
    catch { return json(res, 400, { error: 'Invalid event cursor' }) }
    const tip = this.ctx.session.events.at(-1)?.seq ?? 0
    if (after > tip) return json(res, 409, { error: 'Event cursor is ahead of the session' })
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    })
    res.flushHeaders()
    res.socket?.setNoDelay(true)
    res.on('error', () => {})
    const connection = randomUUID()
    this.clients.set(connection, res)
    this.emit(res, 'hello', JSON.stringify({ connection, ...this.state() }))
    let stop
    try {
      stop = this.ctx.session.follow(after, (event) => this.emit(res, 'session', JSON.stringify(event), event.seq))
    } catch (error) {
      this.emit(res, 'gap', JSON.stringify({ error: error.message }))
      this.clients.delete(connection)
      res.end()
      return
    }
    res.on('close', () => {
      stop()
      this.clients.delete(connection)
      if (this.pending?.connection === connection) this.pending.finish(undefined)
    })
  }

  startTurn(res, data) {
    if (this.installing || this.changing) return json(res, 409, { error: 'A plugin change is already in progress' })
    if (!this.clients.has(data.connection)) return json(res, 409, { error: 'Connect to the session first' })
    if (typeof data.input !== 'string' || !data.input.trim()) return json(res, 400, { error: 'Prompt is required' })
    if (!this.ctx.session.writable) return json(res, 409, { error: this.ctx.session.readonlyReason })
    let turn
    try {
      turn = this.ctx.agent.turn(data.input, undefined, {
        approve: (detail, signal) => this.ask(data.connection, detail, signal),
      })
    } catch (error) {
      return json(res, error.code === 'BUSY' ? 409 : 400, { error: error.message })
    }
    this.error = null
    this.broadcastState()
    turn.then(
      () => this.broadcastState(),
      (error) => { this.error = error.message; this.broadcastState() },
    )
    return json(res, 202, { accepted: true })
  }

  ask(connection, detail, signal) {
    const res = this.clients.get(connection)
    if (!res || res.destroyed || signal?.aborted || this.pending) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const pending = {
        id: randomUUID(), connection, detail,
        finish: (answer) => {
          if (this.pending !== pending) return
          this.pending = null
          signal?.removeEventListener('abort', abort)
          this.emit(res, 'approval', JSON.stringify({ pending: null }))
          resolve(answer)
        },
      }
      const abort = () => pending.finish(undefined)
      this.pending = pending
      signal?.addEventListener('abort', abort, { once: true })
      this.emit(res, 'approval', JSON.stringify({ pending: { id: pending.id, ...detail } }))
    })
  }

  answer(res, data) {
    const pending = this.pending
    const client = this.clients.get(data.connection)
    if (pending?.connection === data.connection && (!client || client.destroyed || client.writableEnded)) pending.finish(undefined)
    if (!pending || this.pending !== pending || pending.id !== data.id || pending.connection !== data.connection || !client || client.destroyed || client.writableEnded) {
      return json(res, 409, { error: 'Approval is no longer available' })
    }
    if (data.decision !== 'allow' && data.decision !== 'deny') return json(res, 400, { error: 'Invalid decision' })
    pending.finish(data.decision === 'allow')
    return json(res, 200, { recorded: true })
  }

  close() {
    if (this.closing) return this.closing
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.pending?.finish(undefined)
    for (const res of this.clients.values()) res.end()
    this.clients.clear()
    const server = this.server
    this.server = null
    this.url = null
    if (!server) return Promise.resolve()
    this.closing = new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    return this.closing
  }
}
