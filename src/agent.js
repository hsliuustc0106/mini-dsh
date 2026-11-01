import { Service } from '@deepseek-ai/cordis'

const system = 'You are a coding assistant. Inspect relevant files, make focused changes, and run suitable checks. Use tools when needed. Explain results and failures honestly.'

export class Agent extends Service {
  static inject = ['model', 'tools', 'session']
  constructor(ctx) { super(ctx, 'agent') }
  async turn(input, report = () => {}) {
    const { session, model, tools } = this.ctx
    await session.append({ role: 'user', content: input })
    for (;;) {
      const response = await model.complete([{ role: 'system', content: system }, ...session.messages], tools.schemas())
      const calls = response.tool_calls || []
      if (!Array.isArray(calls) || calls.some((call) => !call?.id || !call.function || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string')) throw new Error('Model returned invalid tool calls')
      const message = { role: 'assistant', content: response.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) }
      if (response.reasoning_content != null) message.reasoning_content = response.reasoning_content
      await session.append(message)
      if (message.content) report({ type: 'assistant', content: message.content })
      if (!calls.length) return
      for (const call of calls) {
        report({ type: 'tool', content: `${call.function.name} ${call.function.arguments}` })
        let result
        try { result = await tools.run(call.function.name, JSON.parse(call.function.arguments)) }
        catch (error) { result = `Error: ${error.message}` }
        await session.append({ role: 'tool', tool_call_id: call.id, content: String(result) })
        report({ type: 'result', content: String(result) })
      }
    }
  }
}
