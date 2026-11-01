import { Service } from '@deepseek-ai/cordis'
import { completeFinish, observeStream, unknownReason } from './log.js'
import { validateArguments } from './services.js'

function fail(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function toolCalls(response) {
  if (!response || response.role !== 'assistant') throw new Error('Model returned an invalid response')
  const calls = response.tool_calls ?? []
  if (!Array.isArray(calls) || calls.some((call) => !call?.id || !call.function || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string')) {
    throw new Error('Model returned invalid tool calls')
  }
  return calls
}

function deltaFrom(stream, chunk) {
  if (!chunk || typeof chunk !== 'object') return null
  const event = { type: 'stream.delta', stream }
  if (typeof chunk.text === 'string' && chunk.text) event.text = chunk.text
  if (typeof chunk.reasoning === 'string' && chunk.reasoning) event.reasoning = chunk.reasoning
  if (chunk.tool_call) event.tool_call = chunk.tool_call
  if (!event.text && !event.reasoning && !event.tool_call) return null
  return event
}

function assistantMessage(response, calls) {
  const message = { role: 'assistant', content: response.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) }
  if (response.reasoning_content != null) message.reasoning_content = response.reasoning_content
  return message
}

export class Agent extends Service {
  static inject = ['model', 'tools', 'session', 'checkpoint', 'prompt', 'permissions', 'workspace']
  constructor(ctx) {
    super(ctx, 'agent')
    this.busy = false
    this.stopping = false
    this.current = null
    this.controller = null
    this.ctx.effect(() => () => this.shutdown())
  }

  turn(input, report = () => {}) {
    if (this.stopping) throw fail('Agent is shutting down', 'BUSY')
    if (this.busy) throw fail('Agent is busy', 'BUSY')
    if (typeof input !== 'string' || !input.trim()) throw new Error('Turn input is required')
    this.busy = true
    const controller = new AbortController()
    this.controller = controller
    const run = this.runTurn(input, report, controller.signal)
    this.current = run
    return run.finally(() => {
      if (this.controller === controller) this.controller = null
      if (this.current === run) this.current = null
      this.busy = false
    })
  }

  // New turns stop. A pending approval is not a grant. A tool body already
  // running is drained so its real result can be recorded. A result that was
  // never observed is left unknown.
  async shutdown() {
    this.stopping = true
    this.controller?.abort()
    try { await this.current } catch { /* the turn caller observes the failure */ }
  }

  async runTurn(input, report, signal) {
    const { checkpoint, prompt } = this.ctx
    const skillInvocations = await prompt.resolveUserInput(input)
    await checkpoint.commit({ role: 'user', content: input, ...(skillInvocations.length ? { skillInvocations } : {}) })
    while (!this.stopping) {
      const message = await this.complete(signal)
      const calls = message.tool_calls ?? []
      if (message.content) report({ type: 'assistant', content: message.content })
      if (!calls.length) return
      for (let index = 0; index < calls.length; index++) {
        if (this.stopping) {
          await this.denyUnstarted(calls.slice(index))
          return
        }
        await this.oneCall(calls[index], report, signal)
      }
    }
  }

  async complete(signal) {
    const { model, tools, session, checkpoint, prompt } = this.ctx
    const snap = await prompt.snapshot()
    const prepared = model.prepare({
      instructions: snap.instructions,
      context: snap.context,
      messages: session.messages,
      tools: tools.schemas(),
    })
    await checkpoint.commit({ type: 'model.request', provider: prepared.provider, body: prepared.body })
    let started = null
    let recorded = false
    try {
      let finish = null
      for await (const chunk of prepared.dispatch(signal)) {
        if (chunk?.start) {
          if (started) throw new Error('Model stream already started')
          started = await checkpoint.commit({ type: 'stream.started' })
        } else if (!started) {
          throw new Error('Model stream chunk before start')
        } else if (chunk?.finish) {
          if (finish) throw new Error('Model stream already finished')
          finish = chunk.finish
        } else {
          const delta = deltaFrom(started.seq, chunk)
          if (delta) await checkpoint.commit(delta)
        }
        if (signal?.aborted || this.stopping) throw fail('Agent is shutting down', 'BUSY')
      }
      if (!started || typeof finish !== 'string' || !finish) throw new Error('Model stream ended incomplete')
      await checkpoint.commit({ type: 'stream.ended', stream: started.seq, finish })
      if (!completeFinish(finish)) throw new Error(`Model stream ended incomplete: ${finish}`)
      const observed = observeStream(session.events, started.seq)
      const calls = toolCalls({ role: 'assistant', tool_calls: observed.tool_calls })
      const message = assistantMessage({
        content: observed.text ? observed.text : null,
        reasoning_content: observed.reasoning || undefined,
      }, calls)
      if ((message.content ?? '') !== observed.text) throw new Error('Assistant text was not observed')
      await checkpoint.commit(message)
      recorded = true
      return message
    } catch (error) {
      if (started && !recorded) this.freezeStream(started.seq)
      throw error
    }
  }

  // The assistant message was not committed. Later commits in this process
  // stop, and a new process does not complete the stream.
  freezeStream(seq) {
    const session = this.ctx.session
    if (!session.writable) return
    session.unknownStreams = [seq]
    session.writable = false
    session.readonlyReason = unknownReason([], [seq])
  }

  async oneCall(call, report, signal) {
    const { tools, checkpoint, permissions, workspace } = this.ctx
    const id = call.id
    const name = call.function.name
    report({ type: 'tool', content: `${name} ${call.function.arguments}` })
    let args
    try { args = JSON.parse(call.function.arguments) }
    catch {
      await this.toolError(id, 'invalid arguments', report)
      return
    }
    if (!tools.items.has(name)) {
      await this.deny(id, name, args, 'unknown tool', report)
      return
    }
    try { validateArguments(tools.items.get(name).parameters, args) }
    catch (error) {
      await this.toolError(id, error.message, report)
      return
    }
    const decision = await permissions.decide({ callId: id, name, arguments: args }, signal)
    await checkpoint.commit({ type: 'permission.decided', ...decision })
    if (decision.decision !== 'allow') {
      await this.toolError(id, decision.reason, report)
      return
    }
    let result
    try {
      result = await checkpoint.guard(
        { type: 'tool.started', callId: id, name, arguments: structuredClone(args), workspace: workspace.root },
        () => tools.run(name, args),
      )
    } catch (error) {
      if (error.code === 'CHECKPOINT') throw error
      const text = `Error: ${error.message}`
      await checkpoint.commit({ type: 'tool.finished', callId: id, result: text })
      await checkpoint.commit({ role: 'tool', tool_call_id: id, content: text })
      report({ type: 'result', content: text })
      return
    }
    const text = String(result)
    await checkpoint.commit({ type: 'tool.finished', callId: id, result: text })
    await checkpoint.commit({ role: 'tool', tool_call_id: id, content: text })
    report({ type: 'result', content: text })
  }

  async deny(id, name, args, reason, report) {
    await this.ctx.checkpoint.commit({
      type: 'permission.decided',
      callId: id,
      name,
      arguments: args,
      workspace: this.ctx.workspace.root,
      decision: 'deny',
      reason,
    })
    await this.toolError(id, reason, report)
  }

  // Calls that have not started. This records a denial, not an execution result.
  async denyUnstarted(calls) {
    for (const call of calls) {
      let args = null
      try { args = JSON.parse(call.function.arguments) } catch { /* the id and name still identify the call */ }
      await this.deny(call.id, call.function.name, args, 'approval unavailable')
    }
  }

  async toolError(id, reason, report) {
    const content = `Error: ${reason}`
    await this.ctx.checkpoint.commit({ role: 'tool', tool_call_id: id, content })
    report?.({ type: 'result', content })
  }
}
