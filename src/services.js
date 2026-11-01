import { Service } from '@deepseek-ai/cordis'
import { appendFile, readFile } from 'node:fs/promises'

export class Tools extends Service {
  constructor(ctx) { super(ctx, 'tools'); this.items = new Map() }
  register(tool) {
    if (this.items.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
    this.items.set(tool.name, tool)
    return () => this.items.delete(tool.name)
  }
  schemas() {
    return [...this.items.values()].map(({ name, description, parameters }) => ({
      type: 'function', function: { name, description, parameters },
    }))
  }
  async run(name, args) {
    const tool = this.items.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    return tool.execute(args)
  }
}

export class Session extends Service {
  constructor(ctx, config) { super(ctx, 'session'); this.path = config.path; this.messages = [] }
  async load() {
    let text
    try { text = await readFile(this.path, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (text && !text.endsWith('\n')) throw new Error('Session has an incomplete last line; inspect it before continuing')
    this.messages = text.trim() ? text.trimEnd().split('\n').map((line) => JSON.parse(line)) : []
    let pending = new Set()
    for (const message of this.messages) {
      if (!message || typeof message !== 'object' || !['user', 'assistant', 'tool'].includes(message.role)) throw new Error('Invalid session message')
      if (message.role === 'assistant' && message.tool_calls) {
        if (pending.size) throw new Error('Session has unresolved tool calls')
        pending = new Set(message.tool_calls.map((call) => call.id))
      } else if (message.role === 'tool') {
        if (!pending.delete(message.tool_call_id)) throw new Error('Session has an unexpected tool result')
      } else if (pending.size) throw new Error('Session has unresolved tool calls')
    }
    if (pending.size) throw new Error('Session has unresolved tool calls; inspect their outcomes before repairing the log')
  }
  async append(message) {
    await appendFile(this.path, JSON.stringify(message) + '\n', { mode: 0o600 })
    this.messages.push(message)
  }
}

export class Model extends Service {
  constructor(ctx, config) { super(ctx, 'model'); this.config = config }
  async complete(messages, tools) {
    const { key, baseURL, model } = this.config
    if (!key) throw new Error('Set DEEPSEEK_API_KEY before sending a message')
    const response = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, ...(tools.length ? { tools } : {}) }),
    })
    if (!response.ok) throw new Error(`Model HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`)
    const data = await response.json()
    const message = data.choices?.[0]?.message
    if (!message || message.role !== 'assistant') throw new Error('Model returned an invalid response')
    return message
  }
}
