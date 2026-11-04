import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Service } from '@deepseek-ai/cordis'
import { project } from './trajectory.js'
import { installPlugin } from './install-plugin.js'
import { loadProfileEntries, uninstallPlugin } from './live-plugins.js'

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
  static inject = ['agent', 'session', 'workspace', 'livePlugins']

  constructor(ctx, config = {}) {
    super(ctx, 'webControl')
    if (config.host != null && config.host !== HOST) throw new Error('Web control listens on 127.0.0.1 only')
    this.port = config.port ?? 0
    this.pluginConfig = config.pluginConfig
    this.installing = false
    this.changing = false
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

  async [Service.init]() {
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
    if (req.method === 'GET' && url.pathname === '/plugins') {
      return json(res, 200, { plugins: this.ctx.livePlugins.list() })
    }
    if (req.method !== 'POST' || !['/turn', '/approval', '/plugins/install', '/plugins/uninstall'].includes(url.pathname)) {
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
    return this.answer(res, data)
  }

  async install(res, data) {
    let spec
    try { spec = pluginInstallSpec(data.spec) }
    catch (error) { return json(res, 400, { error: error.message }) }
    if (this.installing || this.changing) return json(res, 409, { error: 'A plugin change is already in progress' })
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
        const plugins = await this.ctx.livePlugins.mountAll(entries)
        return json(res, 200, {
          packageName: result.packageName,
          names: result.names,
          configPath: result.configPath,
          restartRequired: false,
          phase: 'active',
          plugins,
        })
      } catch (error) {
        return json(res, 400, {
          error: error.message,
          phase: 'activation',
          packageName: result.packageName,
          names: result.names,
          configPath: result.configPath,
          restartRequired: true,
        })
      }
    } finally { this.installing = false }
  }

  async uninstall(res, data) {
    if (typeof data.name !== 'string' || !data.name.trim()) return json(res, 400, { error: 'Plugin name is required' })
    if (this.installing || this.changing) return json(res, 409, { error: 'A plugin change is already in progress' })
    this.changing = true
    try {
      try { await this.ctx.livePlugins.unmount(data.name) }
      catch (error) {
        if (!/not mounted/.test(error.message)) return json(res, 400, { error: error.message, phase: 'dispose' })
      }
      try {
        const result = await uninstallPlugin(data.name, this.ctx.workspace.root, { configPath: this.pluginConfig })
        return json(res, 200, { name: result.name, configPath: result.configPath, restartRequired: false, phase: 'removed' })
      } catch (error) {
        return json(res, 400, { error: error.message, phase: 'profile' })
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
