import { Service } from '@deepseek-ai/cordis'


/** Project mini-dsh JSONL turn/end events for DSH-style idle-gap readers. */
export function snapshotTurnEnds(events) {
  return events.flatMap((event) => {
    if (event.type !== 'turn/end') return []
    const time = Date.parse(event.time)
    return Number.isFinite(time) ? [{ type: 'turn/end', time }] : []
  })
}

/** Hook names mini-dsh dispatches on its own agent loop. */
export const SUPPORTED_HOOKS = Object.freeze(['agent/pre-step'])

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
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
  const content = textFromContent(message.content)
  if (!content) throw new Error('pre-step message has no text content')
  return { role: 'user', content }
}

function samePrefix(baseline, messages) {
  if (!Array.isArray(messages) || messages.length < baseline.length) return false
  for (let index = 0; index < baseline.length; index++) {
    if (messages[index] !== baseline[index]) return false
  }
  return true
}

/** DSH-shaped handle whose session.snapshotEvents reads mini-dsh JSONL turn/end facts. */
export function miniAgentHandle(session, id = 'mini-dsh') {
  return {
    id,
    get session() {
      return {
        snapshotEvents: () => snapshotTurnEnds(session.events),
      }
    },
  }
}

/**
 * Lean DSH-compatible `agents` service over mini-dsh's own loop and JSONL session.
 * Plugins inject this service and may register `agent/pre-step` via Cordis `ctx.on`
 * (or `agents.on`). Other agent/* hooks and factory APIs fail explicitly.
 */
export class Agents extends Service {
  static inject = ['session']

  constructor(ctx) {
    super(ctx, 'agents')
    this._handle = null
  }

  /** Bind the live mini-dsh agent handle used as the pre-step subject. */
  bind(handle) {
    this._handle = handle
    return () => {
      if (this._handle === handle) this._handle = null
    }
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
    throw new Error('Agent factory is not supported on mini-dsh agents; install the DSH agent-loop bridge instead')
  }

  create() {
    return Promise.reject(new Error('agents.create is not supported on mini-dsh agents; install the DSH agent-loop bridge instead'))
  }

  resume() {
    return Promise.reject(new Error('agents.resume is not supported on mini-dsh agents; install the DSH agent-loop bridge instead'))
  }

  /**
   * Teaching helper that only accepts supported hooks. Unmodified plugins may
   * also call `ctx.on('agent/pre-step', ...)` directly; Cordis disposes those
   * listeners with the registering fiber (including LivePlugins unmount).
   */
  on(name, listener, options) {
    if (!SUPPORTED_HOOKS.includes(name)) {
      throw new Error(`Unsupported agent hook: ${name}. Supported: ${SUPPORTED_HOOKS.join(', ')}`)
    }
    return this.ctx.on(name, listener, options)
  }

  /**
   * Run the cooperative `agent/pre-step` waterfall for one proposed model step.
   * Default enter keeps the baseline messages; listeners may append user messages
   * or return `{ kind: 'reject' }`. Replacing or shortening the baseline fails.
   */
  async runPreStep({ turn, step, signal, messages } = {}) {
    const baseline = messages ?? toPreStepMessages(this.ctx.session.messages)
    const decision = await this.ctx.waterfall(
      'agent/pre-step',
      { agent: this.primary, messages: baseline, turn, step, signal },
      async () => ({ kind: 'enter', messages: baseline }),
    )
    if (!decision || (decision.kind !== 'enter' && decision.kind !== 'reject')) {
      throw new Error(`Unsupported pre-step decision: ${decision?.kind ?? String(decision)}`)
    }
    if (decision.kind === 'reject') return decision
    if (!samePrefix(baseline, decision.messages)) {
      throw new Error('Unsupported pre-step mutation: messages must keep the baseline prefix and only append')
    }
    return decision
  }
}
