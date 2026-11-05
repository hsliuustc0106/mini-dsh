import { Service } from '@deepseek-ai/cordis'
import { completeFinish, observeStream, unknownReason } from './log.js'
import { flattenHookMessage, miniAgentHandle, toPreStepMessages } from './agents.js'
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
  static inject = ['model', 'tools', 'session', 'checkpoint', 'prompt', 'permissions', 'workspace', 'agents']
  constructor(ctx) {
    super(ctx, 'agent')
    this.busy = false
    this.stopping = false
    this.current = null
    this.controller = null
    this.ctx.effect(() => () => this.shutdown())
    // Expose a DSH-shaped handle so agent/pre-step listeners can read turn/end
    // facts from the mini-dsh JSONL session via session.snapshotEvents().
    this.ctx.effect(() => this.ctx.agents.bind(miniAgentHandle(this.ctx.session)))
  }

  turn(input, report = () => {}, { approve } = {}) {
    if (this.stopping) throw fail('Agent is shutting down', 'BUSY')
    if (this.busy) throw fail('Agent is busy', 'BUSY')
    if (this.ctx.reflect.get('livePlugins', false)?.changing) throw fail('A plugin change is already in progress', 'BUSY')
    if (typeof input !== 'string' || !input.trim()) throw new Error('Turn input is required')
    this.busy = true
    const controller = new AbortController()
    this.controller = controller
    const run = this.runTurn(input, report, controller.signal, approve)
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

  async runTurn(input, report, signal, approve) {
    const { checkpoint, prompt, agents } = this.ctx
    const skillInvocations = await prompt.resolveUserInput(input)
    await checkpoint.commit({ role: 'user', content: input, ...(skillInvocations.length ? { skillInvocations } : {}) })
    // One agent.turn() is one DSH-style turn; each model complete() is a step.
    const turn = this.ctx.session.events.filter((event) => event.type === 'turn/end').length + 1
    let step = 0
    try {
      while (!this.stopping) {
        step += 1
        const baseline = toPreStepMessages(this.ctx.session.messages)
        const decision = await agents.runPreStep({ turn, step, signal, messages: baseline })
        await checkpoint.commit({
          type: 'agent.pre-step',
          turn,
          step,
          kind: decision.kind,
          added: decision.kind === 'enter' ? decision.messages.length - baseline.length : 0,
        })
        if (decision.kind === 'reject') return
        for (const message of decision.messages.slice(baseline.length)) {
          await checkpoint.commit(flattenHookMessage(message))
        }
        const message = await this.complete(signal)
        const calls = message.tool_calls ?? []
        if (message.content) report({ type: 'assistant', content: message.content })
        if (!calls.length) return
        const contexts = []
        let index = 0
        while (index < calls.length) {
          if (this.stopping) {
            await this.denyUnstarted(calls.slice(index))
            break
          }
          // Consecutive calls whose classifier returns exactly true overlap
          // their bodies. Policy and JSONL results stay in model order.
          const group = [calls[index]]
          index += 1
          if (this.ctx.tools.executionMode(group[0]).kind === 'parallel') {
            while (index < calls.length && this.ctx.tools.executionMode(calls[index]).kind === 'parallel') {
              group.push(calls[index])
              index += 1
            }
          }
          const produced = group.length === 1
            ? await this.oneCall(group[0], report, signal, approve)
            : await this.parallelCalls(group, report, signal, approve)
          contexts.push(...produced)
        }
        for (const event of contexts) await checkpoint.commit(event)
      }
    } finally {
      // Durable turn/end for hooks such as dsh-message-datetime's idle-gap reading.
      if (this.ctx.session.writable) {
        await checkpoint.commit({ type: 'turn/end', turn, steps: step })
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

  async oneCall(call, report, signal, approve) {
    const admitted = await this.admit(call, report, signal, approve)
    if (!admitted) return []
    const { checkpoint, workspace } = this.ctx
    let raw
    try {
      raw = await checkpoint.guard(
        { type: 'tool.started', callId: admitted.id, name: admitted.name, arguments: structuredClone(admitted.args), workspace: workspace.root },
        () => this.ctx.tools.executeOnly(admitted.exec),
      )
    } catch (error) {
      if (error.code === 'CHECKPOINT') throw error
      await this.recordResult(admitted.id, `Error: ${error.message}`, report)
      return []
    }
    const outcome = await this.ctx.tools.settle(admitted.exec, raw)
    await this.recordResult(admitted.id, outcome.text, report)
    return outcome.contexts
  }

  // Policy stays in model order. Bodies overlap only after each tool.started
  // is durable. Post-execute and tool.finished are written back in model order.
  async parallelCalls(calls, report, signal, approve) {
    const admitted = []
    let index = 0
    for (; index < calls.length; index++) {
      if (this.stopping) break
      const item = await this.admit(calls[index], report, signal, approve)
      if (item) admitted.push(item)
    }
    if (index < calls.length) await this.denyUnstarted(calls.slice(index))
    const { checkpoint, tools, workspace } = this.ctx
    await Promise.all(admitted.map(async (item) => {
      await checkpoint.commit({
        type: 'tool.started', callId: item.id, name: item.name, arguments: structuredClone(item.args), workspace: workspace.root,
      })
      item.raw = await tools.executeOnly(item.exec)
    }))
    const contexts = []
    for (const item of admitted) {
      const outcome = await tools.settle(item.exec, item.raw)
      await this.recordResult(item.id, outcome.text, report)
      contexts.push(...outcome.contexts)
    }
    return contexts
  }

  async admit(call, report, signal, approve) {
    const { tools, checkpoint, permissions } = this.ctx
    const id = call.id
    const name = call.function.name
    report({ type: 'tool', content: `${name} ${call.function.arguments}` })
    let args
    try { args = JSON.parse(call.function.arguments) }
    catch {
      await this.toolError(id, 'invalid arguments', report)
      return null
    }
    if (!tools.items.has(name)) {
      await this.deny(id, name, args, 'unknown tool', report)
      return null
    }
    const tool = tools.items.get(name)
    try { validateArguments(tool.parameters, args) }
    catch (error) {
      await this.toolError(id, error.message, report)
      return null
    }
    const decision = await permissions.decide({ callId: id, name, arguments: args }, signal, approve)
    await checkpoint.commit({ type: 'permission.decided', ...decision })
    if (decision.decision !== 'allow') {
      await this.toolError(id, decision.reason, report)
      return null
    }
    const exec = tools.createExecution({ callId: id, name, args, tool })
    try {
      const pre = await tools.preExecute(exec)
      if (pre.kind === 'deny') {
        await this.toolError(id, pre.reason, report)
        return null
      }
      const guardReason = tools.checkGuards(exec)
      if (guardReason) {
        await this.toolError(id, guardReason, report)
        return null
      }
    } catch (error) {
      if (error.code === 'CHECKPOINT') throw error
      await this.toolError(id, error.message, report)
      return null
    }
    return { id, name, args: exec.args, exec }
  }

  async recordResult(id, text, report) {
    await this.ctx.checkpoint.commit({ type: 'tool.finished', callId: id, result: text })
    await this.ctx.checkpoint.commit({ role: 'tool', tool_call_id: id, content: text })
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
