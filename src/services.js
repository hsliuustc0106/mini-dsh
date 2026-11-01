import { Service } from '@deepseek-ai/cordis'
import { appendFile, mkdir, open, readFile, truncate } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { acquireWriter, lockPathFor } from './lock.js'
import { assertEvent, createEvent, readSession, unknownOutcomes, unknownReason, unknownStreams } from './log.js'

export function validateArguments(schema, value) {
  if (!schema || schema.type !== 'object') throw new Error('Tool schema must be an object')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be an object')
  const properties = schema.properties ?? {}
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(value, name) || value[name] == null) throw new Error(`${name} is required`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) throw new Error(`${key} is not allowed`)
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key) || !spec?.type) continue
    if (typeof value[key] !== spec.type) throw new Error(`${key} must be a ${spec.type}`)
  }
}

export class Tools extends Service {
  constructor(ctx) { super(ctx, 'tools'); this.items = new Map() }
  register(tool) {
    if (typeof tool?.name !== 'string' || !tool.name) throw new Error('Tool name is required')
    if (typeof tool.description !== 'string') throw new Error(`Tool ${tool.name} needs a description`)
    if (!tool.parameters || tool.parameters.type !== 'object') throw new Error(`Tool ${tool.name} needs an object schema`)
    if (typeof tool.execute !== 'function') throw new Error(`Tool ${tool.name} needs execute`)
    if (this.items.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
    this.items.set(tool.name, tool)
    return () => { if (this.items.get(tool.name) === tool) this.items.delete(tool.name) }
  }
  schemas() {
    return [...this.items.values()].map(({ name, description, parameters }) => ({
      type: 'function', function: { name, description, parameters },
    }))
  }
  async run(name, args) {
    const tool = this.items.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    validateArguments(tool.parameters, args)
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
    this.unknownStreams = []
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
    const streams = unknownStreams(first.events)
    if (unknown.length || streams.length || !this.wantWriter) {
      this.finishReadOnly(unknown, streams)
      return
    }
    await mkdir(dirname(this.path), { recursive: true })
    this.lock = await acquireWriter(lockPathFor(this.path))
    try {
      const parsed = await readSession(this.path)
      this.events = parsed.events
      this.incompleteTail = Buffer.from(parsed.incompleteTail)
      const unknownNow = unknownOutcomes(parsed.events)
      const streamsNow = unknownStreams(parsed.events)
      if (unknownNow.length || streamsNow.length) {
        this.finishReadOnly(unknownNow, streamsNow)
        await this.release()
        return
      }
      if (parsed.incompleteTail.length) await preserveTail(this.path, parsed)
      this.handle = await open(this.path, 'a', 0o600)
      this.unknown = []
      this.unknownStreams = []
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

  finishReadOnly(unknown, streams = []) {
    this.unknown = unknown
    this.unknownStreams = streams
    this.writable = false
    this.readonlyReason = unknown.length || streams.length ? unknownReason(unknown, streams) : 'Session opened read-only'
  }

  get messages() {
    return this.events.filter((event) => event.type === 'message').flatMap((event) => {
      const { skillInvocations, ...message } = event.message
      return [message, ...(skillInvocations ?? []).map(({ content }) => ({ role: 'user', content }))]
    })
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
    this.unknownStreams = unknownStreams(parsed.events)
    if (this.unknown.length || this.unknownStreams.length) this.readonlyReason = unknownReason(this.unknown, this.unknownStreams)
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
    const next = [...this.events, event]
    unknownOutcomes(next)
    unknownStreams(next)
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

// Providers register here. Each prepare() is one dispatch of a JSON body.
// The body is what gets recorded and sent. Credentials never belong in it.
// dispatch() yields that call's chunks once.
export class Model extends Service {
  constructor(ctx) { super(ctx, 'model'); this.providers = new Map() }
  register(provider) {
    if (typeof provider?.name !== 'string' || !provider.name) throw new Error('Provider name is required')
    if (typeof provider.prepare !== 'function' || typeof provider.dispatch !== 'function') throw new Error('Provider needs prepare and dispatch')
    if (this.providers.has(provider.name)) throw new Error(`Duplicate provider: ${provider.name}`)
    this.providers.set(provider.name, provider)
    return () => { if (this.providers.get(provider.name) === provider) this.providers.delete(provider.name) }
  }
  prepare(input) {
    if (this.providers.size !== 1) throw new Error('A single model provider is required')
    const provider = [...this.providers.values()][0]
    const body = structuredClone(provider.prepare(input))
    let used = false
    return {
      provider: provider.name,
      body,
      dispatch(signal) {
        if (used) throw new Error('Prepared model call was already used')
        used = true
        return provider.dispatch(structuredClone(body), signal)
      },
    }
  }
}
