import { Service } from '@deepseek-ai/cordis'
import { appendFile, mkdir, open, readFile, truncate } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { acquireWriter, lockPathFor } from './lock.js'
import { assertEvent, createEvent, readSession, unknownOutcomes, unknownReason } from './log.js'

export class Tools extends Service {
  constructor(ctx) { super(ctx, 'tools'); this.items = new Map() }
  register(tool) {
    if (this.items.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
    this.items.set(tool.name, tool)
    return () => this.items.delete(tool.name)
  }
  schemas() {
    return [...this.items.values()].map(({ name, description, parameters }) => ({
      type: 'function', function: { name, description, parameters },
    }))
  }
  async run(name, args) {
    const tool = this.items.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.execute(args)
  }
}

export class Workspace extends Service {
  constructor(ctx, config) {
    super(ctx, 'workspace')
    if (typeof config?.root !== 'string' || !isAbsolute(config.root)) throw new Error('Workspace must be an absolute path')
    this.root = config.root
  }
}

export class Session extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'session')
    if (typeof config.path !== 'string' || !isAbsolute(config.path)) throw new Error('Session path must be absolute')
    this.config = config
    this.path = config.path
    this.workspace = config.workspace
    this.wantWriter = config.writable !== false
    this.clock = config.clock ?? (() => new Date().toISOString())
    this.events = []
    this.incompleteTail = Buffer.alloc(0)
    this.unknown = []
    this.writable = false
    this.readonlyReason = 'Session is not open'
    this.listeners = new Set()
    this.queue = Promise.resolve()
    this.ctx.effect(() => () => this.release())
  }

  async [Service.init]() {
    await this.load()
  }

  load() {
    this.opening ??= this.open()
    return this.opening
  }

  async open() {
    const first = await readSession(this.path)
    this.events = first.events
    this.incompleteTail = Buffer.from(first.incompleteTail)
    const unknown = unknownOutcomes(first.events)
    if (unknown.length || !this.wantWriter) {
      this.finishReadOnly(unknown)
      return
    }
    await mkdir(dirname(this.path), { recursive: true })
    this.lock = await acquireWriter(lockPathFor(this.path))
    try {
      const parsed = await readSession(this.path)
      this.events = parsed.events
      this.incompleteTail = Buffer.from(parsed.incompleteTail)
      const unknownNow = unknownOutcomes(parsed.events)
      if (unknownNow.length) {
        this.finishReadOnly(unknownNow)
        await this.release()
        return
      }
      if (parsed.incompleteTail.length) await preserveTail(this.path, parsed)
      this.handle = await open(this.path, 'a', 0o600)
      this.unknown = []
      this.writable = true
      this.readonlyReason = undefined
      if (!this.events.length && this.workspace) await this._append({ type: 'session.opened', workspace: this.workspace })
    } catch (error) {
      await this.release()
      this.writable = false
      if (!this.readonlyReason || this.readonlyReason === 'Session is not open') this.readonlyReason = error.message
      throw error
    }
  }

  finishReadOnly(unknown) {
    this.unknown = unknown
    this.writable = false
    this.readonlyReason = unknown.length ? unknownReason(unknown) : 'Session opened read-only'
  }

  get messages() {
    return this.events.filter((event) => event.type === 'message').map((event) => event.message)
  }

  history(after = 0) {
    assertCursor(after, 'history')
    return this.events.filter((event) => event.seq > after)
  }

  // Subscribe before copying history so a publish during the copy is queued
  // and delivered once, after the prefix, with no sequence gap.
  follow(after = 0, listener) {
    if (typeof listener !== 'function') throw new Error('follow requires a listener')
    assertCursor(after, 'follow')
    let cursor = after
    const queued = []
    let queueing = true
    const onLive = (event) => { if (queueing) queued.push(event); else emit(event) }
    this.listeners.add(onLive)
    try {
      for (const event of this.history(after)) emit(event)
      queueing = false
      for (const event of queued) emit(event)
    } catch (error) {
      this.listeners.delete(onLive)
      throw error
    }
    return () => this.listeners.delete(onLive)

    function emit(event) {
      if (event.seq <= cursor) return
      if (event.seq !== cursor + 1) throw new Error(`Session follow gap: expected sequence ${cursor + 1}, received ${event.seq}`)
      cursor = event.seq
      listener(event)
    }
  }

  async refresh() {
    if (this.writable) return []
    const parsed = await readSession(this.path)
    if (parsed.events.length < this.events.length) throw new Error('Session log shrank')
    for (let index = 0; index < this.events.length; index++) {
      if (parsed.events[index].seq !== this.events[index].seq) throw new Error('Session log diverged')
    }
    const fresh = parsed.events.slice(this.events.length)
    this.incompleteTail = Buffer.from(parsed.incompleteTail)
    this.unknown = unknownOutcomes(parsed.events)
    if (this.unknown.length) this.readonlyReason = unknownReason(this.unknown)
    else if (!this.wantWriter) this.readonlyReason = 'Session opened read-only'
    for (const event of fresh) {
      this.events.push(event)
      this.publish(event)
    }
    return fresh
  }

  append(input) {
    const run = this.queue.then(() => this._append(input))
    this.queue = run.then(() => {}, () => {})
    return run
  }

  async _append(input) {
    if (!this.writable) {
      const error = new Error(this.readonlyReason || 'Session is read-only')
      error.code = 'READONLY'
      throw error
    }
    const event = createEvent(input, this.events.length + 1, this.clock)
    assertEvent(event, event.seq)
    unknownOutcomes([...this.events, event])
    const line = JSON.stringify(event) + '\n'
    try { await this.writeLine(line) }
    catch (error) {
      this.writable = false
      this.readonlyReason = `Session write failed: ${error.message}`
      const wrapped = new Error(this.readonlyReason)
      wrapped.code = 'CHECKPOINT'
      wrapped.cause = error
      throw wrapped
    }
    this.events.push(event)
    this.publish(event)
    return event
  }

  async writeLine(line) {
    if (this.config.write) return this.config.write(line)
    const buffer = Buffer.from(line)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesWritten } = await this.handle.write(buffer.subarray(offset))
      if (!bytesWritten) throw new Error('incomplete log write')
      offset += bytesWritten
    }
  }

  publish(event) {
    for (const listener of [...this.listeners]) {
      try { listener(event) }
      catch (error) { this.ctx.logger.error(error) }
    }
  }

  async release() {
    const handle = this.handle
    const lock = this.lock
    this.handle = undefined
    this.lock = undefined
    this.writable = false
    try { if (handle) await handle.close() }
    finally { lock?.release() }
  }
}

async function preserveTail(sessionPath, parsed) {
  const sidecar = `${sessionPath}.incomplete`
  const tail = parsed.incompleteTail
  let previous = Buffer.alloc(0)
  try { previous = await readFile(sidecar) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const already = previous.length >= tail.length && previous.subarray(-tail.length).equals(tail)
  if (!already) await appendFile(sidecar, tail, { mode: 0o600 })
  await truncate(sessionPath, parsed.size - tail.length)
}

function assertCursor(after, name) {
  if (!Number.isInteger(after) || after < 0) throw new Error(`${name} after must be a non-negative integer`)
}

// A failed log write blocks later model and tool work. Process crash is the
// durability target: the write syscall completing is the checkpoint. This does
// not promise durability across power loss or a kernel crash.
export class Checkpoint extends Service {
  static inject = ['session']
  constructor(ctx) {
    super(ctx, 'checkpoint')
    this.blocked = null
  }

  async commit(event) {
    if (this.blocked) {
      const error = new Error(`Checkpoint failed; dependent work is blocked: ${this.blocked}`)
      error.code = 'CHECKPOINT'
      throw error
    }
    try { return await this.ctx.session.append(event) }
    catch (error) {
      if (error.code === 'CHECKPOINT') this.blocked = error.message
      throw error
    }
  }

  async guard(event, work) {
    await this.commit(event)
    return work()
  }
}

export class Model extends Service {
  constructor(ctx, config) { super(ctx, 'model'); this.config = config }
  async complete(messages, tools) {
    const { key, baseURL, model } = this.config
    if (!key) throw new Error('Set DEEPSEEK_API_KEY before sending a message')
    const response = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, ...(tools.length ? { tools } : {}) }),
    })
    if (!response.ok) throw new Error(`Model HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`)
    const data = await response.json()
    const message = data.choices?.[0]?.message
    if (!message || message.role !== 'assistant') throw new Error('Model returned an invalid response')
    return message
  }
}
