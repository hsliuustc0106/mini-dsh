import { Service } from '@deepseek-ai/cordis'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import Ajv from 'ajv'
import { appendFile, mkdir, open, readFile, truncate } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { resolveAgainstWorkspace } from './workspace-path.js'
import { acquireWriter, lockPathFor } from './lock.js'
import { currentDelegationAgent } from './delegation.js'
import { assertEvent, createEvent, projectSessionMessages, readSession, unknownOutcomes, unknownReason, unknownStreams } from './log.js'
import {
  applyPostDecision, coerceExecuteResult, errorText, fuseSignals, markOutcome, normalizePreDecision, textBlocks,
} from './tool-pipeline.js'

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
  constructor(ctx) {
    super(ctx, 'tools')
    this.items = new Map()
    this.outputs = new Map()
    this.guards = []
  }
  register(tool, options) {
    if (typeof tool?.name !== 'string' || !tool.name) throw new Error('Tool name is required')
    if (tool.name === 'run_code') throw new Error('Tool run_code is reserved; Code Mode is not supported')
    if (typeof tool.description !== 'string') throw new Error(`Tool ${tool.name} needs a description`)
    if (!tool.parameters || tool.parameters.type !== 'object') throw new Error(`Tool ${tool.name} needs an object schema`)
    if (typeof tool.execute !== 'function') throw new Error(`Tool ${tool.name} needs execute`)
    if (options != null && Object.keys(options).length) throw new Error(`Tool ${tool.name}: registration options are not supported`)
    if (this.items.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
    // Execution-affecting DSH extensions fail closed. Presentation / concurrency
    // classifiers from defineTool are accepted and ignored (no UI; tools run sequentially).
    if (['projectContent', 'finalizeContent', 'deferLoading'].some((key) => tool[key] !== undefined)) {
      throw new Error(`Tool ${tool.name}: DSH execution extensions are not supported`)
    }
    const ignoredToolFields = new Set(['presentCall', 'presentResult', 'isConcurrencySafe'])
    const supportedToolFields = new Set(['name', 'description', 'parameters', 'execute', 'output', 'timeoutMs', ...ignoredToolFields])
    for (const key of Object.keys(tool)) {
      if (!supportedToolFields.has(key)) throw new Error(`Tool ${tool.name}: unsupported tool field '${key}'`)
    }
    for (const key of ignoredToolFields) {
      if (tool[key] !== undefined && typeof tool[key] !== 'function') {
        throw new Error(`Tool ${tool.name}: ${key} must be a function when provided`)
      }
    }
    if (tool.timeoutMs !== undefined && (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0 || tool.timeoutMs > 2147483647)) {
      throw new Error(`Tool ${tool.name}: timeoutMs must be positive and at most 2147483647`)
    }
    let output
    if (tool.output != null) {
      if (typeof tool.output !== 'object' || Array.isArray(tool.output)) {
        throw new Error(`Tool ${tool.name}: DSH output needs a schema and renderer`)
      }
      const ignoredOutputFields = new Set(['presentationMeta'])
      const supportedOutputFields = new Set(['schema', 'render', ...ignoredOutputFields])
      for (const key of Object.keys(tool.output)) {
        if (!supportedOutputFields.has(key)) throw new Error(`Tool ${tool.name}: unsupported output field '${key}'`)
      }
      if (tool.output.presentationMeta !== undefined && typeof tool.output.presentationMeta !== 'function') {
        throw new Error(`Tool ${tool.name}: presentationMeta must be a function when provided`)
      }
      const schema = tool.output.schema
      if (!schema || typeof schema !== 'object' || Array.isArray(schema) || typeof tool.output.render !== 'function') {
        throw new Error(`Tool ${tool.name}: DSH output needs a schema and renderer`)
      }
      let validate
      try {
        this.outputSchemas ??= new Ajv({ strict: true, addUsedSchema: false, ownProperties: true })
        validate = this.outputSchemas.compile(schema)
      }
      catch (error) { throw new Error(`Tool ${tool.name}: unsupported DSH output schema: ${error.message}`) }
      if (validate.$async) throw new Error(`Tool ${tool.name}: asynchronous DSH output schemas are not supported`)
      output = { schema, validate, render: tool.output.render.bind(tool.output) }
    }
    return this.ctx.effect(() => {
      this.items.set(tool.name, tool)
      if (output) this.outputs.set(tool.name, output)
      return () => {
        if (this.items.get(tool.name) !== tool) return
        this.items.delete(tool.name)
        this.outputs.delete(tool.name)
        if (output) this.outputSchemas.removeSchema(output.schema)
      }
    })
  }
  schemas() {
    return [...this.items.values()].map(({ name, description, parameters }) => ({
      type: 'function', function: { name, description, parameters },
    }))
  }
  // Process-wide presentation and per-agent masks are not this teaching slice.
  presentAs() {
    throw new Error('tools.presentAs is not supported')
  }
  restrict() {
    throw new Error('tools.restrict is not supported')
  }
  // Monotonic denial after tools/pre-execute. A returned string cannot be
  // turned back into permission by a later waterfall listener. The registration
  // leaves with the calling fiber.
  guard(guard) {
    if (typeof guard !== 'function') throw new Error('tools.guard requires a function')
    const entry = { guard }
    return this.ctx.effect(() => {
      this.guards.push(entry)
      return () => {
        const index = this.guards.indexOf(entry)
        if (index >= 0) this.guards.splice(index, 1)
      }
    })
  }
  // `parallel` only when the classifier returns exactly true. Omission, invalid
  // arguments, a throw, or any other return stays exclusive (an ordering barrier).
  executionMode(call) {
    const name = typeof call?.name === 'string' ? call.name : call?.function?.name
    const tool = typeof name === 'string' ? this.items.get(name) : undefined
    if (typeof tool?.isConcurrencySafe !== 'function') return { kind: 'exclusive' }
    let args = call.arguments ?? call.function?.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) }
      catch { return { kind: 'exclusive' } }
    }
    try { validateArguments(tool.parameters, args) }
    catch { return { kind: 'exclusive' } }
    try {
      return tool.isConcurrencySafe(args) === true ? { kind: 'parallel' } : { kind: 'exclusive' }
    } catch {
      return { kind: 'exclusive' }
    }
  }
  createExecution({ callId, name, args, tool }) {
    const snapshot = snapshotJsonValue(args)
    if (snapshot === undefined) throw new Error('Tool arguments must be lossless JSON')
    deepFreeze(snapshot)
    const caller = new AbortController()
    const view = {}
    Object.defineProperties(view, {
      callId: { value: callId, enumerable: true },
      name: { value: name, enumerable: true },
      arguments: { value: snapshot, enumerable: true },
      agent: { value: currentDelegationAgent(), enumerable: true },
      deferContext: { value() { throw new Error('deferContext is not supported') } },
    })
    let signal = caller.signal
    Object.defineProperty(view, 'signal', {
      enumerable: true,
      configurable: true,
      get() { return signal },
      set(value) {
        if (!value || typeof value.addEventListener !== 'function' || typeof value.aborted !== 'boolean') {
          throw new Error('tools/execute signal must be an AbortSignal')
        }
        signal = value
      },
    })
    return {
      callId, name, args: snapshot, tool, callerSignal: caller.signal, view,
      abort(reason) { if (!caller.signal.aborted) caller.abort(reason) },
    }
  }
  async preExecute(exec) {
    const decision = await this.ctx.waterfall('tools/pre-execute', exec.view, async () => ({ kind: 'allow' }))
    exec.view.signal = exec.callerSignal
    return normalizePreDecision(decision)
  }
  checkGuards(exec) {
    for (const entry of this.guards) {
      let reason
      try { reason = entry.guard(exec.view) }
      catch (error) { throw new Error(`tools.guard failed closed: ${error.message}`) }
      if (reason != null && typeof reason.then === 'function') throw new Error('tools.guard must be synchronous')
      if (reason === undefined) continue
      if (typeof reason !== 'string' || !reason) throw new Error('tools.guard must return a denial reason or undefined')
      return reason
    }
    return undefined
  }
  replaceValue(exec, value) {
    const output = this.outputs.get(exec.name)
    if (!output) throw new Error('post-execute value replacement requires an output schema')
    return this.renderOutput(exec.name, exec.args, value, output)
  }
  renderOutput(name, args, value, output) {
    let snapshot
    try { snapshot = snapshotJsonValue(value) }
    catch { /* A plugin result must be inspectable JSON. */ }
    if (snapshot === undefined) throw new Error(`Tool ${name}: expected a lossless JSON result`)
    if (!output.validate(snapshot)) throw new Error(`Tool ${name}: output does not match schema: ${this.outputSchemas.errorsText(output.validate.errors)}`)
    const blocks = output.render(args, deepFreeze(snapshot))
    const text = textBlocks(blocks, `Tool ${name}`)
    return { text, value: snapshot, content: blocks }
  }
  // Around-dispatch waterfall. Tool failures become outcomes so post-execute
  // still runs; they do not skip the body checkpoint the agent already wrote.
  async executeOnly(exec) {
    try {
      const returned = await this.ctx.waterfall('tools/execute', exec.view, async () => {
        const signal = fuseSignals(exec.callerSignal, exec.view.signal)
        return markOutcome(await this.invoke(exec.tool, exec.args, { callId: exec.callId, signal, agent: exec.view.agent }))
      })
      return coerceExecuteResult(returned, (value) => this.replaceValue(exec, value))
    } catch (error) {
      return { isError: true, text: errorText(error.message), content: [{ type: 'text', text: errorText(error.message) }], contexts: [] }
    }
  }
  async settle(exec, raw) {
    let final
    try {
      const decision = await this.ctx.waterfall(
        'tools/post-execute',
        exec.view,
        publishResult(raw),
        async () => ({ kind: 'accept' }),
      )
      final = applyPostDecision(decision, raw, (value) => this.replaceValue(exec, value))
    } catch (error) {
      final = {
        isError: true,
        text: errorText(error.message),
        content: [{ type: 'text', text: errorText(error.message) }],
        contexts: [],
      }
    }
    this.emitResult(exec, final)
    return {
      text: final.text,
      contexts: final.contexts.map((content) => ({ type: 'tools.context', callId: exec.callId, content })),
    }
  }
  emitResult(exec, final) {
    const payload = {
      callId: exec.callId,
      name: exec.name,
      isError: Boolean(final.isError),
      content: [{ type: 'text', text: final.text }],
      ...(final.isError ? { error: { message: final.text.replace(/^Error:\s?/, '') } } : {}),
      ...(final.value !== undefined && !final.isError ? { value: final.value } : {}),
    }
    let frozen = payload
    try {
      const snapshot = snapshotJsonValue(payload)
      if (snapshot !== undefined) frozen = deepFreeze(snapshot)
    } catch { /* observation still receives the plain payload */ }
    const identity = {
      callId: exec.callId,
      name: exec.name,
      arguments: exec.args,
      agent: { id: exec.view?.agent?.id ?? 'mini-dsh' },
    }
    try { this.ctx.emit('tools/result', identity, frozen) }
    catch { /* Listener failures are contained and do not change the recorded result. */ }
  }
  async run(name, args, options) {
    const tool = this.items.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    validateArguments(tool.parameters, args)
    const outcome = await this.invoke(tool, args, options)
    return outcome.passthrough ? outcome.raw : outcome.text
  }
  async invoke(tool, args, { callId, signal, agent } = {}) {
    const output = this.outputs.get(tool.name)
    const controller = new AbortController()
    let unlink = () => {}
    if (signal?.aborted) controller.abort(signal.reason)
    else if (signal) {
      const onAbort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      unlink = () => signal.removeEventListener('abort', onAbort)
    }
    const execution = {
      name: tool.name,
      callId,
      signal: controller.signal,
      agent,
      deferContext() { throw new Error('deferContext is not supported') },
    }
    let timedOut = false
    const timer = output && tool.timeoutMs !== undefined ? setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`tool call timed out after ${tool.timeoutMs}ms`))
    }, tool.timeoutMs) : undefined
    try {
      let result
      if (output) {
        try { result = await tool.execute(args, execution) }
        catch (error) { if (!timedOut) throw error }
        if (timedOut) throw new Error(`tool call timed out after ${tool.timeoutMs}ms`)
      } else result = await tool.execute(args, execution)
      if (!output) {
        return {
          isError: false,
          passthrough: true,
          raw: result,
          text: String(result),
          content: [{ type: 'text', text: String(result) }],
          contexts: [],
        }
      }
      const rendered = this.renderOutput(tool.name, args, result, output)
      return { isError: false, text: rendered.text, value: rendered.value, content: rendered.content, contexts: [] }
    } finally {
      clearTimeout(timer)
      unlink()
    }
  }
}

function publicResult(raw) {
  if (raw.isError) {
    return {
      isError: true,
      error: { message: String(raw.text ?? '').replace(/^Error:\s?/, '') },
      content: raw.content ?? [{ type: 'text', text: raw.text }],
    }
  }
  return {
    isError: false,
    content: raw.content ?? [{ type: 'text', text: raw.text }],
    ...(raw.value !== undefined ? { value: raw.value } : {}),
  }
}

function publishResult(raw) {
  const view = publicResult(raw)
  try {
    const snapshot = snapshotJsonValue(view)
    if (snapshot !== undefined) return deepFreeze(snapshot)
  } catch { /* listeners still receive a plain view; the recorded text comes from the decision */ }
  return view
}

export class Workspace extends Service {
  constructor(ctx, config) {
    super(ctx, 'workspace')
    if (typeof config?.root !== 'string' || !isAbsolute(config.root)) throw new Error('Workspace must be an absolute path')
    this.root = config.root
  }
  // Relative paths join this.root; absolute paths pass through. Never process.cwd().
  resolve(path, label = 'path') {
    return resolveAgainstWorkspace(this.root, path, label)
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

  // tools.context is hook output stored on the log. It is projected after the
  // tool batch and before the next non-tool message, and it is not recomputed
  // by re-running hooks when the session is reopened.
  get messages() {
    return projectSessionMessages(this.events)
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
