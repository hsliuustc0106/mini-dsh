import { Context, Service } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { Agent } from './agent.js'

// Run the DSH driver in a separate Cordis context: DSH's scoped `agent`
// accessor cannot share a context with mini-dsh's `agent` service. The mini
// session remains authoritative; the DSH session is an ephemeral driver state.
// This override does not dispatch mini-dsh agent/* hooks. Those stay on Agent.runTurn.
export class DshAgent extends Agent {
  constructor(ctx, config) {
    super(ctx)
    this.loopModule = config.loopModule
    this.loopPlugin = config.loopPlugin
    this.ctx.agents.useOfficialLoop()
    this.fibers = []
    this.pendingCalls = []
  }

  async [Service.init]() {
    const require = createRequire(this.loopModule)
    const load = async (name) => import(require.resolve(name))
    const [agents, sessions, llm, prompt, tools] = await Promise.all([
      load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-session'),
      load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
    ])
    const owner = this
    const scheduler = tools.TOOL_RUNTIME_SCHEDULER
    class BridgeTools extends Service {
      constructor(ctx) {
        super(ctx, 'tools')
        this[scheduler] = {
          prepare: async (exec) => ({ kind: 'dispatch', exec }),
          dispatch: async (exec) => {
            let text
            try {
              const call = owner.pendingCalls.find((item) => item.id === exec.callId && item.function.name === exec.name)
              if (!call) throw new Error(`DSH tool call ${exec.callId} does not match an observed call`)
              if (owner.stopping) await owner.denyUnstarted([call])
              else await owner.oneCall(call, (event) => { if (event.type === 'result') text = event.content; owner.report(event) }, owner.controller?.signal, owner.approve)
              owner.pendingCalls = owner.pendingCalls.filter((item) => item.id !== call.id)
              if (text === undefined) text = 'Error: approval unavailable'
              return { kind: 'final-result', result: { content: [{ type: 'text', text }], isError: text.startsWith('Error:') } }
            } catch (error) { owner.bridgeError ??= error; throw error }
          },
          finish: (_exec, result) => result,
          finalize: async (_exec, result) => result,
        }
      }
      executionMode() { return { kind: 'exclusive' } }
    }
    class Adapter extends llm.LlmAdapter {
      async resolveModel(provider, model) { return { provider, id: model, name: model } }
      async *stream() {
        let message
        try { message = await owner.complete(owner.controller?.signal) }
        catch (error) { owner.bridgeError ??= error; throw error }
        const calls = message.tool_calls ?? []
        owner.pendingCalls = calls.slice()
        if (message.content) owner.report({ type: 'assistant', content: message.content })
        let index = 0
        if (message.content) {
          yield { type: 'block-start', index, blockType: 'text' }
          yield { type: 'text-delta', index, text: message.content }
          yield { type: 'block-end', index, block: { type: 'text', text: message.content } }
          index++
        }
        for (const call of calls) {
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments } }
          index++
        }
        yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } }
      }
    }
    const native = new Context()
    this.native = native
    try {
      for (const [plugin, config] of [[agents.default], [sessions.default], [llm.default], [prompt.default], [BridgeTools], [this.loopPlugin, { agents: [], maxParallelToolCalls: 1 }]]) {
        const fiber = native.plugin(plugin, config)
        this.fibers.push(fiber)
        await fiber.await()
        if (fiber.state !== 2) throw fiber._error ?? new Error(`DSH service ${plugin.name} did not start`)
      }
      native.llm.registerAdapter(['mini'], new Adapter())
      this.nativeAgent = await native.agentLoop.create('mini-dsh', { provider: 'mini', model: 'mini' })
      this.createUserMessage = llm.createUserMessage
    } catch (error) {
      await this.disposeNative()
      throw error
    }
  }

  async runTurn(input, report, signal, approve) {
    this.report = report
    this.approve = approve
    this.bridgeError = null
    this.pendingCalls = []
    const skillInvocations = await this.ctx.prompt.resolveUserInput(input)
    await this.ctx.checkpoint.commit({ role: 'user', content: input, ...(skillInvocations.length ? { skillInvocations } : {}) })
    const abort = () => this.nativeAgent.cancel(new Error('Agent is shutting down'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) throw new Error('Agent is shutting down')
      this.nativeAgent.followup(this.createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }))
      await this.nativeAgent.whenIdle()
      if (this.pendingCalls.length && this.stopping && this.ctx.session.writable) {
        await this.denyUnstarted(this.pendingCalls)
        this.pendingCalls = []
      }
      if (this.bridgeError) throw this.bridgeError
      const end = this.nativeAgent.session.events.findLast((event) => event.type === 'turn/end')
      if (end?.data?.reason?.kind === 'error') throw new Error(end.data.reason.error?.message ?? 'DSH agent turn failed')
      if (signal.aborted) throw new Error('Agent is shutting down')
    } finally {
      signal.removeEventListener('abort', abort)
      this.report = undefined
      this.approve = undefined
    }
  }

  async disposeNative() {
    for (const fiber of this.fibers.splice(0).reverse()) await fiber.dispose()
  }

  async shutdown() {
    await super.shutdown()
    await this.disposeNative()
  }
}
