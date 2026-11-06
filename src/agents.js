import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, Service } from '@deepseek-ai/cordis'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { classifyModelContent } from './tool-pipeline.js'

/** Cordis context tag for listeners that should see only one agent. */
export const AGENT_SCOPE = Symbol('mini-dsh.agent-scope')

/** Hook names the mini-dsh loop dispatches. Other names fail closed via `agents.on`. */
export const SUPPORTED_HOOKS = Object.freeze([
  'agent/session-start',
  'agent/pre-step',
  'agent/turn-stopping',
  'agent/status',
  'agent/error',
])

const LOOP_GAP = 'install the DSH agent-loop bridge instead'

function unsupported(method) {
  return new Error(`${method} is not supported on the mini-dsh agent loop; ${LOOP_GAP}`)
}

function jsonData(value, label) {
  try {
    const encoded = JSON.stringify(value, function (key, item) {
      if (item === undefined && key) throw new Error(`${label} must be JSON`)
      if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        throw new Error(`${label} must be JSON`)
      }
      return item
    })
    if (typeof encoded !== 'string') throw new Error(`${label} must be JSON`)
    return JSON.parse(encoded)
  } catch (error) {
    if (error.message === `${label} must be JSON`) throw error
    throw new Error(`${label} must be JSON`)
  }
}

/** Project mini-dsh JSONL turn/end events for DSH-style idle-gap readers. */
export function snapshotTurnEnds(events) {
  return events.flatMap((event) => {
    if (event.type !== 'turn/end') return []
    const time = Date.parse(event.time)
    return Number.isFinite(time) ? [{ type: 'turn/end', time }] : []
  })
}

/**
 * Project durable JSONL facts a DSH session reader can use.
 * `turn/end` keeps the idle-gap shape. Hook user messages and recorded
 * agent errors are included so replay reads the log instead of re-running hooks.
 */
export function snapshotSessionEvents(events, after = 0) {
  if (!Number.isInteger(after) || after < 0) throw new Error('snapshotEvents after must be a non-negative integer')
  const projected = []
  for (const event of events) {
    if (!event || !(event.seq > after)) continue
    if (event.type === 'turn/end') {
      const time = Date.parse(event.time)
      if (Number.isFinite(time)) projected.push({ type: 'turn/end', time })
    } else if (event.type === 'agent.error') {
      const time = Date.parse(event.time)
      projected.push({
        type: 'agent/error',
        ...(Number.isFinite(time) ? { time } : {}),
        turn: event.turn,
        step: event.step,
        message: event.message,
      })
    } else if (event.type === 'message' && event.message?.role === 'user' && event.message.source) {
      const time = Date.parse(event.time)
      projected.push({
        type: 'user/message',
        ...(Number.isFinite(time) ? { time } : {}),
        source: event.message.source,
        content: event.message.content,
      })
    }
  }
  return projected
}

function textFromContent(content) {
  if (typeof content === 'string') {
    if (!content) throw new Error('pre-step message has no text content')
    return content
  }
  const facing = classifyModelContent(content)
  if (!facing.ok) throw new Error(`Unsupported hook message content: ${facing.type}`)
  if (facing.kind === 'text') {
    if (!facing.text) throw new Error('pre-step message has no text content')
    return facing.text
  }
  let blocks
  try { blocks = snapshotJsonValue(facing.blocks) }
  catch { blocks = undefined }
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('pre-step message has no text content')
  return blocks
}

function hookSource(source) {
  if (source == null) return { kind: 'mini-dsh', form: 'hook' }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('hook message source must be an object')
  }
  const copy = jsonData(source, 'hook message source')
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
    throw new Error('hook message source must be an object')
  }
  return copy
}

/** Present mini-dsh history as DSH-shaped messages so unmodified hooks can read source. */
export function toPreStepMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content,
    // browserTimeZone and similar readers probe source.kind; keep an object present.
    source: message.source ?? { kind: 'mini-dsh', form: 'history' },
  }))
}

/** Normalize a DSH-style or plain message into a mini-dsh user message. */
export function flattenHookMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('pre-step message must be an object')
  }
  const role = message.role ?? 'user'
  if (role !== 'user') throw new Error(`Unsupported pre-step message role: ${role}`)
  return { role: 'user', content: textFromContent(message.content), source: hookSource(message.source) }
}

function samePrefix(baseline, messages) {
  if (!Array.isArray(messages) || messages.length < baseline.length) return false
  for (let index = 0; index < baseline.length; index++) {
    if (messages[index] !== baseline[index]) return false
  }
  return true
}

function copyMessage(message) {
  return { role: message.role, content: message.content, source: hookSource(message.source) }
}

function enqueue(session, pending, kind, message) {
  if (!session.writable) {
    const error = new Error(session.readonlyReason || 'Session is read-only')
    error.code = 'READONLY'
    throw error
  }
  pending.push({ kind, message: flattenHookMessage(message) })
}

/** DSH-shaped handle whose session.snapshotEvents reads mini-dsh JSONL facts. */
export function miniAgentHandle(session, id = 'mini-dsh') {
  return {
    id,
    status: 'idle',
    get session() {
      return {
        id,
        snapshotEvents: (after) => snapshotSessionEvents(session.events, after ?? 0),
      }
    },
  }
}

function carrierFor(agent) {
  return {
    [Context.filter](listenerCtx) {
      const tag = listenerCtx?.[AGENT_SCOPE]
      if (tag == null) return true
      return tag === agent
    },
  }
}

/**
 * Lean DSH-compatible `agents` service over mini-dsh's own loop and JSONL session.
 * Plugins inject this service and register hooks with Cordis `ctx.on` (or `agents.on`).
 * Factory APIs and hook names this loop does not dispatch fail explicitly.
 */
export class Agents extends Service {
  static inject = ['session']

  constructor(ctx) {
    super(ctx, 'agents')
    this._handle = null
    this._pending = []
    this._carrier = null
    this._sessionStarted = false
    this._initiators = new AsyncLocalStorage()
    this._initiatorState = 'active'
    this.ctx.effect(() => () => { this._initiatorState = 'disposed' })
  }

  /**
   * Bind the live mini-dsh agent handle. The returned disposer clears it.
   * `agent.ctx` is a child context tagged with this handle so listeners
   * registered there receive only this agent's events.
   */
  bind(session) {
    const pending = []
    const handle = {
      id: 'mini-dsh',
      status: 'idle',
      options: Object.freeze({}),
      session: {
        id: 'mini-dsh',
        snapshotEvents: (after) => snapshotSessionEvents(session.events, after ?? 0),
      },
      inbox: {
        get nextStep() {
          return pending.map((item) => copyMessage(item.message))
        },
        nextTurn: Object.freeze([]),
      },
      inject: (message) => enqueue(session, pending, 'inject', message),
      steer: (message) => enqueue(session, pending, 'steer', message),
      followup() { throw unsupported('agent.followup') },
      send() { throw unsupported('agent.send') },
      cancel() { throw unsupported('agent.cancel') },
    }
    handle.ctx = this.ctx.extend({ [AGENT_SCOPE]: handle })
    this._handle = handle
    this._pending = pending
    this._carrier = carrierFor(handle)
    return () => {
      if (this._handle !== handle) return
      this._handle = null
      this._pending = []
      this._carrier = null
    }
  }

  /** The official loop does not claim this inbox. Entry methods fail closed. */
  useOfficialLoop() {
    const handle = this._handle
    if (!handle) return
    const reject = (method) => {
      throw new Error(`${method} is not consumed while the official DSH agent loop drives the turn; mini-dsh hooks stay on the mini-dsh loop`)
    }
    handle.inject = () => reject('agent.inject')
    handle.steer = () => reject('agent.steer')
  }

  get primary() {
    return this._handle ?? this.defaultHandle()
  }

  defaultHandle() {
    return miniAgentHandle(this.ctx.session)
  }

  list() {
    return [this.primary]
  }

  get(id) {
    return this.primary.id === id ? this.primary : undefined
  }

  roots() {
    return this.list()
  }

  setFactory() {
    throw new Error(`Agent factory is not supported on mini-dsh agents; ${LOOP_GAP}`)
  }

  create() {
    return Promise.reject(new Error(`agents.create is not supported on mini-dsh agents; ${LOOP_GAP}`))
  }

  resume() {
    return Promise.reject(new Error(`agents.resume is not supported on mini-dsh agents; ${LOOP_GAP}`))
  }

  currentInitiator() {
    if (this._initiatorState === 'disposed') throw new Error('agent initiator scope is disposed')
    return this._initiators.getStore()
  }

  requireInitiator() {
    const agent = this.currentInitiator()
    if (!agent) throw new Error('no initiating agent is active')
    return agent
  }

  withInitiator(agent, operation) {
    if (this._initiatorState !== 'active') throw new Error('agent initiator scope is disposed')
    if (!agent || typeof agent !== 'object') throw new Error('no initiating agent is active')
    return this._initiators.run(agent, operation)
  }

  withoutInitiator(operation) {
    if (this._initiatorState !== 'active') throw new Error('agent initiator scope is disposed')
    return this._initiators.run(undefined, operation)
  }

  /**
   * Teaching helper that only accepts supported hooks. Unmodified plugins may
   * also call `ctx.on` directly; Cordis disposes those listeners with the
   * registering fiber (including LivePlugins unmount).
   */
  on(name, listener, options) {
    if (!SUPPORTED_HOOKS.includes(name)) {
      throw new Error(`Unsupported agent hook: ${name}. Supported: ${SUPPORTED_HOOKS.join(', ')}`)
    }
    return this.ctx.on(name, listener, options)
  }

  /** One emit per writable process, on the first mini-dsh turn. Read-only replay does not emit. */
  ensureSessionStart() {
    if (this._sessionStarted || !this._handle) return
    if (!this.ctx.session.writable) return
    this._sessionStarted = true
    const prior = this.ctx.session.events.some((event) => event.type === 'turn/end' || event.type === 'message')
    this.emitContained('agent/session-start', { agent: this._handle, source: prior ? 'resume' : 'startup' })
  }

  setStatus(status) {
    const agent = this._handle
    if (!agent || agent.status === status) return
    agent.status = status
    this.emitContained('agent/status', { agent, status })
  }

  emitError(payload) {
    if (!this._handle) return
    this.emitContained('agent/error', { agent: this._handle, ...payload })
  }

  claimPending() {
    return this._pending.splice(0, this._pending.length).map((item) => item.message)
  }

  /**
   * Cooperative `agent/pre-step` waterfall for one proposed model step.
   * Committed history stays the prefix. The uncommitted inbox tail may be
   * replaced or extended with user text or a supported image. Other non-text
   * content fails closed and is not stored.
   */
  async runPreStep({ turn, step, signal, messages } = {}) {
    if (!this._handle || !this._carrier) throw new Error('mini-dsh agent is not bound')
    const history = messages ?? toPreStepMessages(this.ctx.session.messages)
    const claimed = this.claimPending()
    const proposed = [...history, ...claimed]
    const decision = await this.ctx.waterfall(
      this._carrier,
      'agent/pre-step',
      { agent: this._handle, messages: proposed, committed: history.length, turn, step, signal },
      async () => ({ kind: 'enter', messages: proposed }),
    )
    if (!decision || (decision.kind !== 'enter' && decision.kind !== 'reject')) {
      throw new Error(`Unsupported pre-step decision: ${decision?.kind ?? String(decision)}`)
    }
    if (decision.kind === 'reject') return { kind: 'reject', recorded: [] }
    if (decision.startsRequestSeries != null) {
      throw new Error('Unsupported pre-step field: startsRequestSeries')
    }
    if (!samePrefix(history, decision.messages)) {
      throw new Error('Unsupported pre-step mutation: committed history must stay the message prefix')
    }
    const recorded = decision.messages.slice(history.length).map((message) => flattenHookMessage(message))
    return { kind: 'enter', recorded }
  }

  /** Await every `agent/turn-stopping` listener. A queued steer continues the turn; inject does not. */
  async settleStop({ turn, signal } = {}) {
    if (!this._handle || !this._carrier) throw new Error('mini-dsh agent is not bound')
    await this.runListeners('agent/turn-stopping', { agent: this._handle, turn, signal })
    return this._pending.some((item) => item.kind === 'steer')
  }

  async runListeners(name, payload) {
    const args = [this._carrier, name, payload]
    const callbacks = this.ctx.events.dispatch('serial', args)
    for (const callback of callbacks) await callback(...args)
  }

  emitContained(name, payload) {
    if (!this._carrier) return
    const args = [this._carrier, name, payload]
    let callbacks = []
    try { callbacks = this.ctx.events.dispatch('emit', args) }
    catch (error) {
      this.ctx.logger.error(error)
      return
    }
    for (const callback of callbacks) {
      try { callback(...args) }
      catch (error) { this.ctx.logger.error(error) }
    }
  }
}
