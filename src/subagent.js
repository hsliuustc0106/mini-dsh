import { Service } from '@deepseek-ai/cordis'
import { delegationStore } from './delegation.js'
import { completeFinish } from './log.js'
import { validateArguments } from './services.js'

/** Official package this loop can host. Newer tool contracts fail at load. */
export const SUBAGENT_TOOL_VERSION = '0.1.0-rc.6'

/**
 * Absolute delegation cap. Root is depth 0. The official tool's default
 * maxDepth is 3, which allows children at depths 1, 2, and 3. A larger
 * configured cap fails closed. `provider-managed` is not a cap this loop honors.
 */
export const MAX_SUBAGENT_DEPTH = 3

/** One-shot children are not resumed. This bounds a child that keeps calling tools. */
export const CHILD_STEP_LIMIT = 8

const SPAWN = Object.freeze({
  name: 'spawn',
  inheritsParentContext: false,
  capabilities: Object.freeze({ depthLimit: true }),
})

function depthOf(agent) {
  if (!agent || typeof agent !== 'object') throw new Error('subagent start requires a parent agent')
  const runtime = agent.options?.subagentDepth
  if (runtime !== undefined && (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))) {
    throw new Error('agent subagentDepth must be a non-negative safe integer')
  }
  const header = agent.session?.header?.delegationDepth
  const persisted = header === undefined ? 0 : header
  if (!Number.isSafeInteger(persisted) || persisted < 0 || Object.is(persisted, -0)) {
    throw new Error('agent delegationDepth must be a non-negative safe integer')
  }
  return Math.max(persisted, runtime ?? 0)
}

function childAgent(id, depth) {
  return {
    id,
    depth,
    options: { subagentDepth: depth },
    session: { header: { delegationDepth: depth } },
  }
}

function promptText(prompt) {
  if (!Array.isArray(prompt) || !prompt.length) throw new Error('subagent prompt must be text')
  const parts = []
  for (const block of prompt) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string' || !block.text) {
      throw new Error('subagent prompt must be text')
    }
    parts.push(block.text)
  }
  return parts.join('\n')
}

function textOutput(text) {
  return typeof text === 'string' && text ? [{ type: 'text', text }] : []
}

function rejectUnsupported(request) {
  if (!request || typeof request !== 'object') throw new Error('subagent start requires a request')
  if (request.persona !== undefined) throw new Error('subagent persona is not supported on the mini-dsh loop')
  if (request.toolFilter !== undefined) throw new Error('subagent toolFilter is not supported on the mini-dsh loop')
  if (request.agentOptions !== undefined) throw new Error('subagent agentOptions are not supported on the mini-dsh loop')
  if (request.outputSchema !== undefined) throw new Error('subagent outputSchema is not supported on the mini-dsh loop')
  if (request.maxDepth === undefined) {
    throw new Error('provider-managed subagent depth is not supported; set a numeric maxDepth')
  }
  if (typeof request.maxDepth !== 'number' || !Number.isSafeInteger(request.maxDepth) || request.maxDepth < 0 || Object.is(request.maxDepth, -0)) {
    throw new Error('subagent maxDepth must be a non-negative safe integer')
  }
  if (request.maxDepth > MAX_SUBAGENT_DEPTH) {
    throw new Error(`subagent maxDepth ${request.maxDepth} exceeds the mini-dsh limit of ${MAX_SUBAGENT_DEPTH}`)
  }
}

function linkSignal(parent) {
  const controller = new AbortController()
  if (parent?.aborted) controller.abort(parent.reason)
  else if (parent) parent.addEventListener('abort', () => controller.abort(parent.reason), { once: true })
  return controller
}

function deltaFrom(chunk) {
  if (!chunk || typeof chunk !== 'object') return null
  const delta = {}
  if (typeof chunk.text === 'string' && chunk.text) delta.text = chunk.text
  if (typeof chunk.reasoning === 'string' && chunk.reasoning) delta.reasoning = chunk.reasoning
  if (chunk.tool_call) delta.tool_call = chunk.tool_call
  return delta.text || delta.reasoning || delta.tool_call ? delta : null
}

function addTool(tools, piece) {
  if (!piece || typeof piece !== 'object' || !Number.isInteger(piece.index) || piece.index < 0) {
    throw new Error('invalid tool call index')
  }
  const current = tools.get(piece.index) ?? { id: undefined, type: 'function', name: '', arguments: '' }
  if (piece.id != null) {
    if (typeof piece.id !== 'string' || !piece.id) throw new Error('invalid tool call id')
    if (current.id && current.id !== piece.id) throw new Error('tool call id changed')
    current.id = piece.id
  }
  if (piece.name != null) {
    if (typeof piece.name !== 'string' || !piece.name) throw new Error('invalid tool call name')
    if (current.name && current.name !== piece.name) throw new Error('tool call name changed')
    current.name = piece.name
  }
  if (piece.type != null) {
    if (typeof piece.type !== 'string' || !piece.type) throw new Error('invalid tool call type')
    current.type = piece.type
  }
  if (piece.arguments != null) {
    if (typeof piece.arguments !== 'string') throw new Error('invalid tool call arguments')
    current.arguments += piece.arguments
  }
  tools.set(piece.index, current)
}

function callsFrom(tools) {
  return [...tools.keys()].sort((a, b) => a - b).map((index) => {
    const call = tools.get(index)
    if (!call.id || !call.name) throw new Error('Model returned invalid tool calls')
    return { id: call.id, type: call.type || 'function', function: { name: call.name, arguments: call.arguments } }
  })
}

/** Child transcript from the JSONL. This does not rerun the child. */
export function projectChildMessages(events, agentId) {
  if (typeof agentId !== 'string' || !agentId) throw new Error('child id is required')
  if (!Array.isArray(events)) throw new Error('events must be an array')
  return events.filter((event) => event?.type === 'subagent.message' && event.agent === agentId).map((event) => event.message)
}

/**
 * Spawn provider and one-shot child loop for the official subagent tool.
 * Children use this process's model, tools, permissions, and JSONL session.
 * They do not enter the DSH agent loop or the parent's agent/pre-step hooks.
 */
export class Subagents extends Service {
  static inject = ['checkpoint', 'model', 'tools', 'permissions', 'prompt']

  constructor(ctx) {
    super(ctx, 'subagents')
    this.providers = new Map([[SPAWN.name, SPAWN]])
    this.childSeq = 0
    this.live = new Set()
    this.ctx.effect(() => () => {
      for (const controller of this.live) controller.abort(new Error('subagents disposed'))
      if (this.providers.delete(SPAWN.name)) this.ctx.emit('subagent/provider-removed', SPAWN.name)
    })
  }

  getProvider(name) {
    return this.providers.get(name)
  }

  list() {
    return [...this.providers.keys()]
  }

  startContinuable() {
    throw new Error('continuable subagents are not supported on the mini-dsh loop')
  }

  followup() {
    throw new Error('subagent followup is not supported on the mini-dsh loop')
  }

  /**
   * Publish one fresh-context child. The returned run settles on its own;
   * foreground callers await `result`, background jobs do not.
   */
  async start(name, request) {
    const provider = this.providers.get(name)
    if (!provider) throw new Error(`no subagent provider registered for "${name}"`)
    if (provider.inheritsParentContext) {
      throw new Error(`subagent provider "${name}" inherits parent context, which is not supported`)
    }
    if (request?.maxDepth !== undefined && !provider.capabilities?.depthLimit) {
      throw new Error(`subagent provider "${name}" cannot enforce maxDepth`)
    }
    rejectUnsupported(request)
    const parentDepth = depthOf(request.parent)
    const depth = parentDepth + 1
    if (depth > request.maxDepth) {
      throw new Error(`subagent depth ${depth} exceeds maxDepth ${request.maxDepth}`)
    }
    if (request.signal?.aborted) throw new Error('subagent start was cancelled')
    const prompt = promptText(request.prompt)
    const child = childAgent(`agent-${++this.childSeq}`, depth)
    const ask = this.ctx.get('agent')?.approve ?? this.ctx.permissions.ask
    const parentId = typeof request.parent.id === 'string' && request.parent.id ? request.parent.id : 'mini-dsh'
    const controller = linkSignal(request.signal)
    this.live.add(controller)
    await this.record({
      type: 'subagent.opened',
      agent: child.id,
      parent: parentId,
      depth,
      label: typeof request.label === 'string' ? request.label : '',
      prompt,
      provider: provider.name,
      maxDepth: request.maxDepth,
    })
    const task = delegationStore.run({ agent: child }, () => this.drive(child, parentId, prompt, controller, ask))
    const run = {
      id: child.id,
      result: task,
      async dispose() {
        if (run.disposed) return
        run.disposed = true
        try { await task } catch { /* result already reports the failure */ }
      },
      disposed: false,
    }
    task.finally(() => this.live.delete(controller)).catch(() => {})
    return run
  }

  record(event) {
    return this.ctx.checkpoint.commit(event)
  }

  async drive(child, parentId, prompt, controller, ask) {
    const signal = controller.signal
    let outcome = { stopReason: 'error', output: [] }
    try {
      outcome = await this.loop(child, prompt, signal, ask)
      return outcome
    } catch (error) {
      outcome = {
        stopReason: signal.aborted ? 'aborted' : 'error',
        output: textOutput(signal.aborted ? '' : error.message),
      }
      return outcome
    } finally {
      try {
        await this.record({
          type: 'subagent.settled',
          agent: child.id,
          parent: parentId,
          depth: child.depth,
          stopReason: outcome.stopReason,
          output: outcome.output,
        })
      } catch { /* a failed checkpoint is already blocking later writes */ }
    }
  }

  async loop(child, prompt, signal, ask) {
    const messages = [{ role: 'user', content: prompt }]
    await this.record({ type: 'subagent.message', agent: child.id, message: messages[0] })
    let last = ''
    for (let step = 1; step <= CHILD_STEP_LIMIT; step++) {
      if (signal.aborted) return { stopReason: 'aborted', output: textOutput(last) }
      const turn = await this.complete(child, messages, signal)
      messages.push(turn.message)
      await this.record({ type: 'subagent.message', agent: child.id, message: turn.message })
      if (typeof turn.message.content === 'string') last = turn.message.content
      if (turn.finish === 'length') return { stopReason: 'max-tokens', output: textOutput(last) }
      if (turn.finish === 'content_filter') return { stopReason: 'refusal', output: textOutput(last) }
      if (turn.finish !== 'stop' && turn.finish !== 'tool_calls') {
        return { stopReason: 'error', output: textOutput(last || `child model finish ${turn.finish}`) }
      }
      const calls = turn.message.tool_calls ?? []
      if (!calls.length) return { stopReason: 'completed', output: textOutput(turn.message.content ?? '') }
      for (const call of calls) {
        const content = await this.oneTool(child, call, signal, ask)
        const toolMessage = { role: 'tool', tool_call_id: call.id, content }
        messages.push(toolMessage)
        await this.record({ type: 'subagent.message', agent: child.id, message: toolMessage })
        if (signal.aborted) return { stopReason: 'aborted', output: textOutput(last) }
      }
    }
    return { stopReason: 'error', output: textOutput(`child exceeded ${CHILD_STEP_LIMIT} steps`) }
  }

  async complete(child, messages, signal) {
    const snap = await this.ctx.prompt.snapshot()
    const prepared = this.ctx.model.prepare({
      instructions: snap.instructions,
      context: snap.context,
      messages: messages.map((message) => {
        if (message.source == null) return message
        const copy = { ...message }
        delete copy.source
        return copy
      }),
      tools: this.ctx.tools.schemas(),
    })
    await this.record({ type: 'subagent.model.request', agent: child.id, provider: prepared.provider, body: prepared.body })
    const started = await this.record({ type: 'subagent.stream.started', agent: child.id })
    let text = ''
    let reasoning = ''
    const tools = new Map()
    let finish = null
    let sawStart = false
    try {
      for await (const chunk of prepared.dispatch(signal)) {
        if (signal.aborted) throw new Error('child model aborted')
        if (chunk?.start) {
          if (sawStart) throw new Error('Model stream already started')
          sawStart = true
          continue
        }
        if (!sawStart) throw new Error('Model stream chunk before start')
        if (chunk?.finish) {
          if (finish) throw new Error('Model stream already finished')
          finish = chunk.finish
          continue
        }
        const delta = deltaFrom(chunk)
        if (!delta) continue
        if (delta.text) text += delta.text
        if (delta.reasoning) reasoning += delta.reasoning
        if (delta.tool_call) addTool(tools, delta.tool_call)
        await this.record({ type: 'subagent.stream.delta', agent: child.id, stream: started.seq, ...delta })
      }
    } catch (error) {
      if (signal.aborted) throw new Error('child model aborted')
      throw error
    }
    if (!finish) throw new Error('Model stream ended incomplete')
    await this.record({ type: 'subagent.stream.ended', agent: child.id, stream: started.seq, finish })
    if (!completeFinish(finish)) throw new Error(`Model stream ended incomplete: ${finish}`)
    const calls = callsFrom(tools)
    const message = { role: 'assistant', content: text ? text : null, ...(calls.length ? { tool_calls: calls } : {}) }
    if (reasoning) message.reasoning_content = reasoning
    return { message, finish }
  }

  async oneTool(child, call, signal, ask) {
    const id = call.id
    const name = call.function?.name
    let args
    try { args = JSON.parse(call.function.arguments) }
    catch {
      return 'Error: invalid arguments'
    }
    const tool = typeof name === 'string' ? this.ctx.tools.items.get(name) : undefined
    if (!tool) {
      const decision = await this.ctx.permissions.decide(
        { callId: id, name, arguments: args },
        signal,
        (detail, sig) => (typeof ask === 'function' ? ask({ ...detail, agent: child.id }, sig) : undefined),
      )
      await this.record({ type: 'subagent.permission', agent: child.id, ...decision })
      return `Error: ${decision.reason}`
    }
    try { validateArguments(tool.parameters, args) }
    catch (error) { return `Error: ${error.message}` }
    const decision = await this.ctx.permissions.decide(
      { callId: id, name, arguments: args },
      signal,
      (detail, sig) => (typeof ask === 'function' ? ask({ ...detail, agent: child.id }, sig) : undefined),
    )
    await this.record({ type: 'subagent.permission', agent: child.id, ...decision })
    if (decision.decision !== 'allow') return `Error: ${decision.reason}`
    const exec = this.ctx.tools.createExecution({ callId: id, name, args, tool })
    const abort = () => exec.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    try {
      await this.record({
        type: 'subagent.tool.started', agent: child.id, callId: id, name, arguments: exec.args,
      })
      const raw = await this.ctx.tools.executeOnly(exec)
      const outcome = await this.ctx.tools.settle(exec, raw)
      const model = outcome.model ?? outcome.text
      const finished = { type: 'subagent.tool.finished', agent: child.id, callId: id, name, result: outcome.text }
      if (Array.isArray(model)) finished.content = model
      await this.record(finished)
      return model
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}

function noticeText(jobId, outcome) {
  if (outcome.status === 'completed') return `background subagent job ${jobId} completed: ${outcome.output ?? ''}`
  if (outcome.status === 'killed') return `background subagent job ${jobId} killed`
  return `background subagent job ${jobId} failed${outcome.detail ? `: ${outcome.detail}` : ''}`
}

/**
 * One-shot background registry the official tool calls through `ctx.get('jobs')`.
 * Continuable children and the official job_output / job_kill tools are not this service.
 */
export class Jobs extends Service {
  static inject = ['checkpoint']

  constructor(ctx) {
    super(ctx, 'jobs')
    this.jobs = new Map()
    this.seq = 0
  }

  start(spec) {
    if (!spec || typeof spec.run !== 'function') throw new Error('jobs.start requires a run')
    const handle = spec.run()
    if (!handle || typeof handle.cancel !== 'function' || typeof handle.done?.then !== 'function') {
      throw new Error('jobs.start run must return cancel and done')
    }
    const jobId = `job-${++this.seq}`
    const agent = typeof spec.owner?.id === 'string' && spec.owner.id ? spec.owner.id : 'mini-dsh'
    const job = { id: jobId, status: 'running', agent, handle, done: false }
    this.jobs.set(jobId, job)
    job.finished = this.finish(job, handle.done.then(
      (outcome) => outcome,
      (error) => ({ status: 'failed', detail: String(error) }),
    ))
    this.record({
      type: 'subagent.job', jobId, status: 'running', kind: spec.kind ?? 'subagent', label: spec.label ?? '', agent,
    }).catch((error) => handle.cancel(error.message))
    return jobId
  }

  cancel(id, reason) {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'running') return false
    job.handle.cancel(reason ?? 'background subagent task killed')
    return true
  }

  cancelAll(reason = 'agent shutting down') {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.handle.cancel(reason)
    }
  }

  settle() {
    return Promise.all([...this.jobs.values()].map((job) => job.finished ?? Promise.resolve()))
  }

  record(event) {
    return this.ctx.checkpoint.commit(event)
  }

  async finish(job, outcomePromise) {
    const outcome = await outcomePromise
    if (job.done) return
    job.done = true
    job.status = outcome?.status ?? 'failed'
    const text = noticeText(job.id, { status: job.status, output: outcome?.output, detail: outcome?.detail })
    try {
      await this.record({
        type: 'subagent.job',
        jobId: job.id,
        status: job.status,
        agent: job.agent,
        ...(outcome?.output !== undefined ? { output: outcome.output } : {}),
        ...(outcome?.detail !== undefined ? { detail: outcome.detail } : {}),
      })
      await this.record({
        type: 'subagent.notice',
        jobId: job.id,
        agent: job.agent,
        content: text,
        source: { kind: 'subagent', form: 'notice', jobId: job.id },
      })
    } catch { /* the checkpoint failure is already durable as a read-only session */ }
  }
}

/** Present so the official tool can inject `systemPrompt`. Continuable guidance is refused. */
export class SystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
  }

  section() {
    throw new Error('continuable subagent prompts are not supported on the mini-dsh loop')
  }
}
