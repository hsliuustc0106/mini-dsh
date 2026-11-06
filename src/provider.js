import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { classifyModelContent } from './tool-pipeline.js'

// Prepared providers. prepare() returns the JSON body; dispatch() sends it once
// and yields text and tool-call chunks. The fake provider replays prepared
// replies as those chunks. DeepSeek posts that same body to chat completions
// with stream true. The API key is an Authorization header, never part of the body.

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
        async *dispatch(body, signal) {
          sent.push(structuredClone(body))
          if (!queue.length) throw new Error('Fake provider has no prepared reply')
          const reply = queue.shift()
          const value = typeof reply === 'function' ? await reply(body) : reply
          const chunks = chunksFrom(value)
          if (signal?.aborted) throw abortError()
          yield { start: true }
          for (const chunk of chunks) {
            if (signal?.aborted) throw abortError()
            yield chunk
          }
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

// The terminal's default provider is itself a plugin. Selection happens only
// when that plugin starts, so a profile can replace it without reading its
// credentials or replay file.
export function environmentProvider(env = process.env) {
  return {
    inject: ['model'],
    async apply(ctx) {
      const file = env.MINI_REPLIES
      let selected
      if (file) {
        const path = resolve(file)
        let replies
        try { replies = JSON.parse(await readFile(path, 'utf8')) }
        catch (error) {
          throw new Error(error instanceof SyntaxError ? `MINI_REPLIES is not JSON: ${path}` : `MINI_REPLIES could not be read: ${path}`)
        }
        if (!Array.isArray(replies)) throw new Error('MINI_REPLIES must be a JSON array')
        selected = providerForConfig({ replies })
      } else {
        selected = providerForConfig({
          apiKey: await readApiKey(env),
          baseUrl: env.DEEPSEEK_BASE_URL,
          model: env.DEEPSEEK_MODEL,
          toolChoice: env.DEEPSEEK_TOOL_CHOICE,
        })
      }
      selected.apply(ctx)
    },
  }
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
        async *dispatch(body, signal) {
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
              signal,
            })
          } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw abortError()
            throw new Error(redact(`DeepSeek request failed: ${error.message}`, apiKey))
          }
          if (!response.ok) {
            let parsed = {}
            const text = await response.text()
            if (text) {
              try { parsed = JSON.parse(text) }
              catch { parsed = { error: { message: text } } }
            }
            throw new Error(failureText(response.status, parsed, apiKey))
          }
          if (!response.body) throw new Error('DeepSeek returned an empty stream')
          yield { start: true }
          let finish = null
          let done = false
          try {
            for await (const data of readSse(response.body)) {
              if (signal?.aborted) throw abortError()
              if (data === '[DONE]') { done = true; break }
              const payload = parseChunk(data)
              for (const chunk of chunksFromPayload(payload)) {
                if (chunk.finish) finish = chunk.finish
                else yield publicChunk(chunk, apiKey)
              }
            }
          } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw abortError()
            throw new Error(redact(error.message, apiKey))
          }
          if (!done || typeof finish !== 'string' || !finish) throw new Error('DeepSeek stream ended before a finish')
          yield { finish }
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

function outgoingTools(tools) {
  return tools.map((tool) => {
    if (!tool || tool.type !== 'function' || !tool.function || typeof tool.function !== 'object' || Array.isArray(tool.function)) {
      return tool
    }
    const fn = { ...tool.function }
    if (fn.deferLoading === true) fn.defer_loading = true
    delete fn.deferLoading
    return { ...tool, function: fn }
  })
}

const TOOL_IMAGE_TEXT = 'Attached image(s) from tool result:'

function wireImage(block) {
  return { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } }
}

function wireParts(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) parts.push({ type: 'text', text: block.text })
    } else parts.push(wireImage(block))
  }
  return parts
}

function offeredContent(content) {
  if (typeof content === 'string') return { kind: 'text', text: content, images: [] }
  const facing = classifyModelContent(content)
  if (!facing.ok) throw new Error(`DeepSeek cannot represent content block ${facing.type}`)
  if (facing.kind === 'text') return { kind: 'text', text: facing.text, images: [] }
  return {
    kind: 'blocks',
    text: facing.text,
    images: facing.blocks.filter((block) => block.type === 'image'),
    parts: wireParts(facing.blocks),
  }
}

// Tool messages stay strings. Their images are returned so the caller can
// attach them once after the consecutive tool results. User images stay on
// that user message, in block order.
function outgoingMessage(message) {
  if (!message || typeof message.role !== 'string') throw new Error('Model message is invalid')
  if (message.role === 'system') {
    if (message.content != null && typeof message.content !== 'string') throw new Error('DeepSeek cannot represent content block invalid')
    return { wire: { role: message.role, content: message.content ?? '' }, images: [] }
  }
  if (message.role === 'user') {
    if (message.content == null || typeof message.content === 'string') {
      return { wire: { role: 'user', content: message.content ?? '' }, images: [] }
    }
    const offered = offeredContent(message.content)
    if (offered.kind === 'text') return { wire: { role: 'user', content: offered.text }, images: [] }
    return { wire: { role: 'user', content: offered.parts }, images: [] }
  }
  if (message.role === 'tool') {
    if (message.content == null || typeof message.content === 'string') {
      return { wire: { role: 'tool', tool_call_id: message.tool_call_id, content: message.content ?? '' }, images: [] }
    }
    const offered = offeredContent(message.content)
    const text = offered.kind === 'text' ? offered.text : (offered.text || '(no output)')
    return { wire: { role: 'tool', tool_call_id: message.tool_call_id, content: text }, images: offered.images }
  }
  if (message.role === 'assistant') {
    if (message.content != null && typeof message.content !== 'string') throw new Error('DeepSeek cannot represent assistant content blocks')
    const out = { role: 'assistant', content: message.content ?? null }
    if (message.tool_calls?.length) out.tool_calls = message.tool_calls.map(outgoingCall)
    return { wire: out, images: [] }
  }
  throw new Error(`Model message role is invalid: ${message.role}`)
}

// The object returned here is the body that is recorded and posted.
// Thinking stays off so a named tool choice is accepted. stream is true, so
// the response is server-sent events rather than one JSON document.
function chatBody(input, model, toolChoice) {
  const messages = []
  const system = systemText(input)
  if (system) messages.push({ role: 'system', content: system })
  const pendingImages = []
  const flushImages = () => {
    if (!pendingImages.length) return
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: TOOL_IMAGE_TEXT },
        ...pendingImages.splice(0, pendingImages.length).map(wireImage),
      ],
    })
  }
  for (const message of input.messages ?? []) {
    if (message?.role !== 'tool') flushImages()
    const projected = outgoingMessage(message)
    messages.push(projected.wire)
    if (projected.images.length) pendingImages.push(...projected.images)
  }
  flushImages()
  const body = { model, messages, stream: true, thinking: { type: 'disabled' } }
  if (input.tools?.length) {
    const tools = outgoingTools(input.tools)
    if (tools.every((tool) => tool?.function?.defer_loading === true)) {
      throw new Error('DeepSeek rejects an all-deferred tool list; at least one offered tool must load immediately')
    }
    body.tools = tools
    const followUp = messages.some((message) => message.role === 'tool')
    if (toolChoice && !followUp) {
      const chosen = tools.find((tool) => tool?.function?.name === toolChoice)
      if (!chosen) throw new Error(`DEEPSEEK_TOOL_CHOICE is not a registered tool: ${toolChoice}`)
      if (chosen.function.defer_loading === true) {
        throw new Error(`DEEPSEEK_TOOL_CHOICE cannot name a deferred tool: ${toolChoice}`)
      }
      body.tool_choice = { type: 'function', function: { name: toolChoice } }
    }
  }
  return body
}

function textContent(content) {
  if (content == null) return null
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function abortError() {
  const error = new Error('Model stream aborted')
  error.name = 'AbortError'
  return error
}

// One complete reply becomes incremental chunks. An explicit stream is yielded
// as given. The finish is part of the reply; it is not added when missing.
function chunksFrom(value) {
  if (value && Array.isArray(value.stream)) return normalizeChunks(value.stream)
  if (!value || value.role !== 'assistant') throw new Error('Model returned an invalid response')
  const chunks = []
  if (typeof value.reasoning_content === 'string' && value.reasoning_content) {
    for (const part of splitIncremental(value.reasoning_content)) chunks.push({ reasoning: part })
  }
  if (typeof value.content === 'string' && value.content) {
    for (const part of splitIncremental(value.content)) chunks.push({ text: part })
  } else if (value.content != null && typeof value.content !== 'string') throw new Error('Model returned an invalid response')
  const calls = value.tool_calls ?? []
  if (!Array.isArray(calls)) throw new Error('Model returned invalid tool calls')
  calls.forEach((call, index) => {
    if (!call?.id || !call.function || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') {
      throw new Error('Model returned invalid tool calls')
    }
    const piece = { index, id: call.id, name: call.function.name }
    if (call.type) piece.type = call.type
    chunks.push({ tool_call: piece })
    for (const part of splitIncremental(call.function.arguments)) chunks.push({ tool_call: { index, arguments: part } })
  })
  chunks.push({ finish: calls.length ? 'tool_calls' : 'stop' })
  return chunks
}

function normalizeChunks(stream) {
  const chunks = []
  let finish = null
  for (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') throw new Error('Model returned an invalid response')
    if (chunk.finish != null) {
      if (finish) throw new Error('Model stream already finished')
      if (typeof chunk.finish !== 'string' || !chunk.finish) throw new Error('Model returned an invalid response')
      finish = chunk.finish
      chunks.push({ finish: chunk.finish })
      continue
    }
    if (finish) throw new Error('Model stream already finished')
    const next = {}
    if (typeof chunk.text === 'string' && chunk.text) next.text = chunk.text
    if (typeof chunk.reasoning === 'string' && chunk.reasoning) next.reasoning = chunk.reasoning
    if (chunk.tool_call) next.tool_call = normalizePiece(chunk.tool_call)
    if (!next.text && !next.reasoning && !next.tool_call) throw new Error('Model returned an invalid response')
    chunks.push(next)
  }
  if (!finish) throw new Error('Model stream has no finish')
  return chunks
}

function normalizePiece(piece) {
  if (!piece || typeof piece !== 'object' || !Number.isInteger(piece.index) || piece.index < 0) {
    throw new Error('Model returned invalid tool calls')
  }
  const next = { index: piece.index }
  if (piece.id != null) next.id = piece.id
  if (piece.type != null) next.type = piece.type
  if (piece.name != null) next.name = piece.name
  if (piece.arguments != null) next.arguments = piece.arguments
  if (next.id == null && next.name == null && next.arguments == null) throw new Error('Model returned invalid tool calls')
  return next
}

function splitIncremental(text) {
  if (typeof text !== 'string' || !text) return []
  const mid = Math.ceil(text.length / 2)
  return [text.slice(0, mid), text.slice(mid)].filter((part) => part)
}

function parseChunk(data) {
  try { return JSON.parse(data) }
  catch { throw new Error('DeepSeek stream returned invalid JSON') }
}

function chunksFromPayload(payload) {
  const choice = payload?.choices?.[0]
  if (!choice) return []
  const delta = choice.delta ?? {}
  const chunks = []
  if (typeof delta.content === 'string' && delta.content) chunks.push({ text: delta.content })
  else if (delta.content != null && typeof delta.content !== 'string') chunks.push({ text: textContent(delta.content) })
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) chunks.push({ reasoning: delta.reasoning_content })
  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      if (!Number.isInteger(call?.index) || call.index < 0) throw new Error('DeepSeek stream tool call is missing an index')
      const piece = { index: call.index }
      if (call.id) piece.id = call.id
      if (call.type) piece.type = call.type
      if (call.function?.name) piece.name = call.function.name
      if (typeof call.function?.arguments === 'string' && call.function.arguments) piece.arguments = call.function.arguments
      if (piece.id || piece.name || piece.arguments) chunks.push({ tool_call: piece })
    }
  }
  if (typeof choice.finish_reason === 'string' && choice.finish_reason) chunks.push({ finish: choice.finish_reason })
  return chunks
}

function publicChunk(chunk, apiKey) {
  const next = {}
  if (chunk.text) next.text = redact(chunk.text, apiKey)
  if (chunk.reasoning) next.reasoning = redact(chunk.reasoning, apiKey)
  if (chunk.tool_call) {
    const piece = { index: chunk.tool_call.index }
    if (chunk.tool_call.id) piece.id = redact(chunk.tool_call.id, apiKey)
    if (chunk.tool_call.type) piece.type = chunk.tool_call.type
    if (chunk.tool_call.name) piece.name = redact(chunk.tool_call.name, apiKey)
    if (chunk.tool_call.arguments) piece.arguments = redact(chunk.tool_call.arguments, apiKey)
    next.tool_call = piece
  }
  return next
}

async function* readSse(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let split
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = sseData(block)
        if (data != null) yield data
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* the consumer already left the stream */ }
    try { reader.releaseLock() } catch { /* cancel already dropped the reader */ }
  }
}

function sseData(block) {
  const lines = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
  }
  if (!lines.length) return null
  return lines.join('\n')
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
