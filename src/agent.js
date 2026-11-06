import { Service } from '@deepseek-ai/cordis'
import { completeFinish, observeStream, unknownReason } from './log.js'
import { toPreStepMessages } from './agents.js'
import { assertRunCodeArguments, validateArguments } from './services.js'

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

function abortWith(signal, exec) {
  if (!signal || typeof exec?.abort !== 'function') return () => {}
  const abort = () => exec.abort(signal.reason)
  if (signal.aborted) {
    abort()
    return () => {}
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
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
    // The handle's session.snapshotEvents() reads this JSONL session.
    // Official-loop turns override runTurn and do not dispatch these hooks.
    this.ctx.effect(() => this.ctx.agents.bind(this.ctx.session))
  }

  turn(input, report = () => {}, { approve } = {}) {
    if (this.stopping) throw fail('Agent is shutting down', 'BUSY')
    if (this.busy) throw fail('Agent is busy', 'BUSY')
    if (this.ctx.reflect.get('livePlugins', false)?.changing) throw fail('A plugin change is already in progress', 'BUSY')
    if (typeof input !== 'string' || !input.trim()) throw new Error('Turn input is required')
    this.busy = true
    this.approve = approve
    const controller = new AbortController()
    this.controller = controller
    let run
    try {
      run = this.ctx.agents.withInitiator(this.ctx.agents.primary, () => this.runTurn(input, report, controller.signal, approve))
    } catch (error) {
      this.controller = null
      this.busy = false
      throw error
    }
    this.current = run
    return run.finally(() => {
      if (this.controller === controller) this.controller = null
      if (this.current === run) this.current = null
      if (this.approve === approve) this.approve = undefined
      this.busy = false
    })
  }

  // New turns stop. A pending approval is not a grant. A tool body already
  // running is drained so its real result can be recorded. A result that was
  // never observed is left unknown.
  async shutdown() {
    this.stopping = true
    this.controller?.abort()
    const jobs = this.ctx.get('jobs')
    jobs?.cancelAll()
    try { await this.current } catch { /* the turn caller observes the failure */ }
    try { await jobs?.settle() } catch { /* a failed job record stays in the log */ }
  }

  async runTurn(input, report, signal, approve) {
    const { checkpoint, prompt, agents } = this.ctx
    agents.ensureSessionStart()
    const skillInvocations = await prompt.resolveUserInput(input)
    await checkpoint.commit({ role: 'user', content: input, ...(skillInvocations.length ? { skillInvocations } : {}) })
    // One agent.turn() is one DSH-style turn; each model complete() is a step.
    const turn = this.ctx.session.events.filter((event) => event.type === 'turn/end').length + 1
    let step = 0
    try {
      agents.setStatus('running')
      while (!this.stopping) {
        step += 1
        const history = toPreStepMessages(this.ctx.session.messages)
        const decision = await agents.runPreStep({ turn, step, signal, messages: history })
        await checkpoint.commit({
          type: 'agent.pre-step',
          turn,
          step,
          kind: decision.kind,
          added: decision.recorded.length,
        })
        if (decision.kind === 'reject') return
        for (const message of decision.recorded) await checkpoint.commit(message)
        const message = await this.complete(signal)
        const calls = message.tool_calls ?? []
        if (message.content) report({ type: 'assistant', content: message.content })
        if (!calls.length) {
          if (this.stopping) return
          if (await agents.settleStop({ turn, signal }) && !this.stopping) continue
          return
        }
        const contexts = await this.dispatchCalls(calls, report, signal, approve)
        for (const event of contexts) await checkpoint.commit(event)
      }
    } catch (error) {
      agents.emitError({ turn, step, error })
      if (this.ctx.session.writable) {
        try {
          await checkpoint.commit({ type: 'agent.error', turn, step, message: error?.message ?? String(error) })
        } catch { /* the original failure stays the turn result */ }
      }
      throw error
    } finally {
      agents.setStatus('idle')
      // Durable turn/end for hooks such as dsh-message-datetime's idle-gap reading.
      // turn/end means the turn ended, not that it succeeded.
      if (this.ctx.session.writable) {
        await checkpoint.commit({ type: 'turn/end', turn, steps: step })
      }
    }
  }

  async complete(signal) {
    const { model, tools, session, checkpoint, prompt, agents } = this.ctx
    const snap = await prompt.snapshot()
    const prepared = model.prepare({
      instructions: snap.instructions,
      context: snap.context,
      messages: session.messages.map((message) => {
        if (!message || message.source == null) return message
        const copy = { ...message }
        delete copy.source
        return copy
      }),
      tools: tools.schemas(agents.currentInitiator() ?? agents.primary),
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

  // Model calls and nested run_code children share this grouping. A parallel
  // group is consecutive calls whose classifier returns exactly true. There
  // is no separate subcall pool and no maxParallelToolCalls cap.
  async dispatchCalls(calls, report, signal, approve, options) {
    const contexts = []
    let index = 0
    while (index < calls.length) {
      if (this.stopping) {
        await this.denyUnstarted(calls.slice(index), options)
        break
      }
      const group = [calls[index]]
      index += 1
      if (this.ctx.tools.executionMode(group[0]).kind === 'parallel') {
        while (index < calls.length && this.ctx.tools.executionMode(calls[index]).kind === 'parallel') {
          group.push(calls[index])
          index += 1
        }
      }
      const produced = group.length === 1
        ? await this.oneCall(group[0], report, signal, approve, options)
        : await this.parallelCalls(group, report, signal, approve, options)
      contexts.push(...produced)
      if (typeof options?.deferContext === 'function') {
        for (const event of produced) options.deferContext({ role: 'user', content: event.content })
      }
    }
    return contexts
  }

  // Admitted run_code only. The program text is already on tool.started.
  // Children use the same permission, hook, and JSONL path as model calls.
  async dispatchNested({ parentId, calls, signal, deferContext }) {
    if (typeof parentId !== 'string' || !parentId || !Array.isArray(calls)) {
      throw new Error('run_code nested dispatch requires an open run_code call')
    }
    const events = this.ctx.session.events
    const open = events.some((event) => event.type === 'tool.started' && event.callId === parentId && event.name === 'run_code')
      && !events.some((event) => event.type === 'tool.finished' && event.callId === parentId)
    if (!open) throw new Error('run_code nested dispatch requires an open run_code call')
    const shaped = calls.map((call, index) => ({
      id: `${parentId}:code:${index + 1}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }))
    await this.dispatchCalls(shaped, () => {}, signal, this.approve, { nested: true, parentId, deferContext })
    const rows = shaped.map((call) => {
      const message = this.ctx.session.events.find((event) => event.type === 'message'
        && event.message?.role === 'tool'
        && event.message.tool_call_id === call.id
        && event.message.parent === parentId)
      const result = message ? message.message.content : 'Error: nested dispatch did not finish'
      return { callId: call.id, name: call.function.name, result }
    })
    return JSON.stringify(rows)
  }

  async oneCall(call, report, signal, approve, options) {
    const admitted = await this.admit(call, report, signal, approve, options)
    if (!admitted) return []
    const { checkpoint, workspace } = this.ctx
    const unlink = abortWith(signal, admitted.exec)
    let raw
    try {
      const started = {
        type: 'tool.started', callId: admitted.id, name: admitted.name, arguments: structuredClone(admitted.args), workspace: workspace.root,
      }
      const parent = callParent(options)
      if (parent) started.parent = parent
      raw = await checkpoint.guard(started, () => this.ctx.tools.executeOnly(admitted.exec))
    } catch (error) {
      if (error.code === 'CHECKPOINT') throw error
      await this.recordResult(admitted.id, `Error: ${error.message}`, report, options)
      return []
    } finally {
      unlink()
    }
    const outcome = await this.ctx.tools.settle(admitted.exec, raw)
    await this.recordResult(admitted.id, outcome, report, options)
    return outcome.contexts
  }

  // Policy stays in model order. Bodies overlap only after each tool.started
  // is durable. Post-execute and tool.finished are written back in model order.
  async parallelCalls(calls, report, signal, approve, options) {
    const admitted = []
    let index = 0
    for (; index < calls.length; index++) {
      if (this.stopping) break
      const item = await this.admit(calls[index], report, signal, approve, options)
      if (item) admitted.push(item)
    }
    if (index < calls.length) await this.denyUnstarted(calls.slice(index), options)
    const { checkpoint, tools, workspace } = this.ctx
    const unlink = admitted.map((item) => abortWith(signal, item.exec))
    const parent = callParent(options)
    try {
      await Promise.all(admitted.map(async (item) => {
        const started = {
          type: 'tool.started', callId: item.id, name: item.name, arguments: structuredClone(item.args), workspace: workspace.root,
        }
        if (parent) started.parent = parent
        await checkpoint.commit(started)
        item.raw = await tools.executeOnly(item.exec)
      }))
    } finally {
      for (const release of unlink) release()
    }
    const contexts = []
    for (const item of admitted) {
      const outcome = await tools.settle(item.exec, item.raw)
      await this.recordResult(item.id, outcome, report, options)
      contexts.push(...outcome.contexts)
    }
    return contexts
  }

  async admit(call, report, signal, approve, options) {
    const { tools, checkpoint, permissions } = this.ctx
    const id = call.id
    const name = call.function.name
    report({ type: 'tool', content: `${name} ${call.function.arguments}` })
    let args
    try { args = JSON.parse(call.function.arguments) }
    catch {
      if (options?.nested === true) {
        await this.deny(id, name, null, 'invalid arguments', report, options)
        return null
      }
      await this.toolError(id, 'invalid arguments', report, options)
      return null
    }
    // Code mode's only direct call is reserved run_code. Other names are
    // unknown before policy. Nested children resolve registered tools instead.
    const agent = this.ctx.agents.currentInitiator() ?? this.ctx.agents.primary
    const nested = options?.nested === true
    const tool = nested ? tools.dispatchable(name, agent) : tools.callable(name, agent)
    if (!tool) {
      await this.deny(id, name, args, 'unknown tool', report, options)
      return null
    }
    try {
      validateArguments(tool.parameters, args)
      if (tool.name === 'run_code') assertRunCodeArguments(args)
    }
    catch (error) {
      if (nested) {
        await this.deny(id, name, args, error.message, report, options)
        return null
      }
      await this.toolError(id, error.message, report)
      return null
    }
    const decision = await permissions.decide({ callId: id, name, arguments: args }, signal, approve)
    const recorded = { type: 'permission.decided', ...decision }
    const parent = callParent(options)
    if (parent) recorded.parent = parent
    await checkpoint.commit(recorded)
    if (decision.decision !== 'allow') {
      await this.toolError(id, decision.reason, report, options)
      return null
    }
    const exec = tools.createExecution({ callId: id, name, args, tool })
    try {
      const pre = await tools.preExecute(exec)
      if (pre.kind === 'deny') {
        await this.toolError(id, pre.reason, report, options)
        return null
      }
      const guardReason = tools.checkGuards(exec)
      if (guardReason) {
        await this.toolError(id, guardReason, report, options)
        return null
      }
    } catch (error) {
      if (error.code === 'CHECKPOINT') throw error
      await this.toolError(id, error.message, report, options)
      return null
    }
    return { id, name, args: exec.args, exec }
  }

  async recordResult(id, outcome, report, options) {
    const text = typeof outcome === 'string' ? outcome : outcome.text
    const model = typeof outcome === 'string' ? outcome : (outcome.model ?? text)
    const finished = { type: 'tool.finished', callId: id, result: text }
    if (Array.isArray(model)) finished.content = model
    const parent = callParent(options)
    if (parent) finished.parent = parent
    await this.ctx.checkpoint.commit(finished)
    const message = { role: 'tool', tool_call_id: id, content: model }
    if (parent) message.parent = parent
    await this.ctx.checkpoint.commit(message)
    report?.({ type: 'result', content: text })
  }

  async deny(id, name, args, reason, report, options) {
    const recorded = {
      type: 'permission.decided',
      callId: id,
      name,
      arguments: args,
      workspace: this.ctx.workspace.root,
      decision: 'deny',
      reason,
    }
    const parent = callParent(options)
    if (parent) recorded.parent = parent
    await this.ctx.checkpoint.commit(recorded)
    await this.toolError(id, reason, report, options)
  }

  // Calls that have not started. This records a denial, not an execution result.
  async denyUnstarted(calls, options) {
    for (const call of calls) {
      let args = null
      try { args = JSON.parse(call.function.arguments) } catch { /* the id and name still identify the call */ }
      await this.deny(call.id, call.function.name, args, 'approval unavailable', undefined, options)
    }
  }

  async toolError(id, reason, report, options) {
    const content = `Error: ${reason}`
    const message = { role: 'tool', tool_call_id: id, content }
    const parent = callParent(options)
    if (parent) message.parent = parent
    await this.ctx.checkpoint.commit(message)
    report?.({ type: 'result', content })
  }
}

function callParent(options) {
  return typeof options?.parentId === 'string' && options.parentId ? options.parentId : undefined
}
