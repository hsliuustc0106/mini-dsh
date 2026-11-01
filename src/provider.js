import { readFile } from 'node:fs/promises'

// Prepared providers. prepare() returns the JSON body; dispatch() sends it once.
// The fake provider replays prepared replies. DeepSeek posts that same body to
// chat completions. The API key is an Authorization header, never part of the body.

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_MODEL = 'deepseek-flash'

export function fakeProvider(replies = []) {
  const queue = [...replies]
  const sent = []
  const plugin = {
    inject: ['model'],
    apply(ctx) {
      ctx.effect(() => ctx.model.register({
        name: 'fake',
        prepare(input) {
          return {
            model: 'fake',
            instructions: input.instructions,
            context: input.context,
            messages: input.messages,
            tools: input.tools,
          }
        },
        dispatch(body) {
          sent.push(structuredClone(body))
          if (!queue.length) throw new Error('Fake provider has no prepared reply')
          const reply = queue.shift()
          return typeof reply === 'function' ? reply(body) : reply
        },
      }))
    },
  }
  plugin.sent = sent
  return plugin
}

// A non-empty DEEPSEEK_API_KEY wins. Otherwise one trimmed line from
// DEEPSEEK_API_KEY_FILE. Blank means no credential. The value is not logged.
export async function readApiKey(env = process.env, read = readFile) {
  const direct = env.DEEPSEEK_API_KEY
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const file = typeof env.DEEPSEEK_API_KEY_FILE === 'string' ? env.DEEPSEEK_API_KEY_FILE.trim() : ''
  if (!file) return undefined
  let text
  try { text = await read(file, 'utf8') }
  catch (error) {
    const code = error?.code ? ` (${error.code})` : ''
    throw new Error(`DEEPSEEK_API_KEY_FILE could not be read: ${file}${code}`)
  }
  const key = text.trim()
  if (!key) throw new Error(`DEEPSEEK_API_KEY_FILE is empty: ${file}`)
  return key
}

// Prepared replies always select the fake provider, including when a key is
// present. A key with no replies selects DeepSeek. Neither selects an empty fake.
export function providerForConfig({ replies, apiKey, baseUrl, model, toolChoice, fetch } = {}) {
  if (Array.isArray(replies)) return fakeProvider(replies)
  if (typeof apiKey === 'string' && apiKey.trim()) {
    return deepseekProvider({ apiKey: apiKey.trim(), baseUrl, model, toolChoice, fetch })
  }
  return fakeProvider()
}

export function deepseekProvider(options = {}) {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required')
  const baseUrl = String(options.baseUrl || DEEPSEEK_BASE_URL).replace(/\/+$/, '')
  const model = (typeof options.model === 'string' && options.model.trim()) || DEEPSEEK_MODEL
  const toolChoice = validToolChoice(options.toolChoice)
  const fetchImpl = options.fetch ?? globalThis.fetch
  return {
    inject: ['model'],
    apply(ctx) {
      ctx.effect(() => ctx.model.register({
        name: 'deepseek',
        prepare(input) {
          return chatBody(input, model, toolChoice)
        },
        async dispatch(body) {
          const url = `${baseUrl}/chat/completions`
          let response
          try {
            response = await fetchImpl(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(body),
            })
          } catch (error) {
            throw new Error(redact(`DeepSeek request failed: ${error.message}`, apiKey))
          }
          let parsed = {}
          const text = await response.text()
          if (text) {
            try { parsed = JSON.parse(text) }
            catch { parsed = { error: { message: text } } }
          }
          if (!response.ok) throw new Error(failureText(response.status, parsed, apiKey))
          try { return assistantFrom(parsed) }
          catch (error) { throw new Error(redact(error.message, apiKey)) }
        },
      }))
    },
  }
}

function validToolChoice(value) {
  if (value == null || value === '') return undefined
  const name = String(value).trim()
  if (!name) return undefined
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('DEEPSEEK_TOOL_CHOICE must be a tool name')
  return name
}

function systemText(input) {
  const parts = []
  for (const text of input.instructions ?? []) {
    if (typeof text === 'string' && text) parts.push(text)
  }
  if (Array.isArray(input.context) && input.context.length) parts.push(`Runtime context:\n${JSON.stringify(input.context)}`)
  return parts.join('\n\n')
}

function outgoingCall(call) {
  const args = call?.function?.arguments
  return {
    id: call.id,
    type: call.type || 'function',
    function: {
      name: call.function?.name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    },
  }
}

function outgoingMessage(message) {
  if (!message || typeof message.role !== 'string') throw new Error('Model message is invalid')
  if (message.role === 'system' || message.role === 'user') return { role: message.role, content: message.content ?? '' }
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content ?? '' }
  if (message.role === 'assistant') {
    const out = { role: 'assistant', content: message.content ?? null }
    if (message.tool_calls?.length) out.tool_calls = message.tool_calls.map(outgoingCall)
    return out
  }
  throw new Error(`Model message role is invalid: ${message.role}`)
}

// The object returned here is the body that is recorded and posted.
// Thinking stays off so a named tool choice is accepted and the response is one JSON document.
function chatBody(input, model, toolChoice) {
  const messages = []
  const system = systemText(input)
  if (system) messages.push({ role: 'system', content: system })
  for (const message of input.messages ?? []) messages.push(outgoingMessage(message))
  const body = { model, messages, stream: false, thinking: { type: 'disabled' } }
  if (input.tools?.length) {
    body.tools = input.tools
    const followUp = messages.some((message) => message.role === 'tool')
    if (toolChoice && !followUp) {
      const known = input.tools.some((tool) => tool?.function?.name === toolChoice)
      if (!known) throw new Error(`DEEPSEEK_TOOL_CHOICE is not a registered tool: ${toolChoice}`)
      body.tool_choice = { type: 'function', function: { name: toolChoice } }
    }
  }
  return body
}

function textContent(content) {
  if (content == null) return null
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function assistantFrom(payload) {
  const message = payload?.choices?.[0]?.message
  if (!message || message.role !== 'assistant') throw new Error('DeepSeek returned an invalid response')
  const result = { role: 'assistant', content: textContent(message.content) }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    result.tool_calls = message.tool_calls.map(outgoingCall)
  }
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    result.reasoning_content = message.reasoning_content
  }
  return result
}

function failureText(status, payload, apiKey) {
  const raw = payload?.error?.message || payload?.message || ''
  const detail = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : ''
  const text = `DeepSeek request failed (${status})${detail ? `: ${detail}` : ''}`
  return redact(text, apiKey).slice(0, 500)
}

function redact(text, secret) {
  if (typeof text !== 'string') return ''
  if (typeof secret !== 'string' || !secret) return text
  return text.split(secret).join('[redacted]')
}
