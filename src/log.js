import { readFile } from 'node:fs/promises'

// Append-only session records. A complete record is one JSON object per line.
// Bytes after the final newline are an incomplete tail, not a record.

export function corrupt(detail) {
  const error = new Error(detail ? `Session record is corrupt: ${detail}` : 'Session record is corrupt')
  error.code = 'SESSION_CORRUPT'
  return error
}

export function invalidSequence(detail) {
  const error = new Error(detail ? `Session sequence is invalid: ${detail}` : 'Session sequence is invalid')
  error.code = 'SESSION_SEQUENCE'
  return error
}

function assertMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw corrupt('message must be an object')
  if (!['user', 'assistant', 'tool'].includes(message.role)) throw corrupt('invalid message role')
  if (message.role === 'assistant' && message.tool_calls != null) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.some((call) => !call || typeof call.id !== 'string' || !call.id)) {
      throw corrupt('invalid tool calls')
    }
  }
  if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id)) {
    throw corrupt('tool result requires tool_call_id')
  }
}

export function assertEvent(event, seq) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw corrupt('record must be an object')
  if (!Number.isInteger(event.seq) || event.seq !== seq) throw invalidSequence(`expected ${seq}, received ${event.seq}`)
  if (typeof event.type !== 'string' || !event.type) throw corrupt('event type is required')
  if (event.type === 'message') assertMessage(event.message)
  if ((event.type === 'tool.started' || event.type === 'tool.finished') && (typeof event.callId !== 'string' || !event.callId)) {
    throw corrupt('tool event requires callId')
  }
  if ((event.type === 'stream.delta' || event.type === 'stream.ended') && (!Number.isInteger(event.stream) || event.stream < 1)) {
    throw corrupt('stream event requires stream')
  }
  if (event.type === 'stream.delta' && !deltaPayload(event)) throw corrupt('stream delta is empty')
  if (event.type === 'stream.delta' && event.tool_call != null && !toolPiece(event.tool_call)) throw corrupt('invalid tool call')
  if (event.type === 'stream.ended' && (typeof event.finish !== 'string' || !event.finish)) throw corrupt('stream end requires finish')
  if (event.time != null && typeof event.time !== 'string') throw corrupt('time must be a string')
}

function deltaPayload(event) {
  if (typeof event.text === 'string' && event.text) return true
  if (typeof event.reasoning === 'string' && event.reasoning) return true
  return event.tool_call != null
}

function toolPiece(piece) {
  return piece && typeof piece === 'object' && !Array.isArray(piece)
}

// A finish the provider completed. aborted and insufficient_system_resource
// were observed, but the generation did not finish.
const COMPLETE_FINISH = new Set(['stop', 'length', 'tool_calls', 'content_filter'])

export function completeFinish(finish) {
  return COMPLETE_FINISH.has(finish)
}

// A model tool call is open from the assistant message until its tool result.
// An execution is open from tool.started until tool.finished. Either one still
// open is an unknown outcome. This does not invent the missing record.
export function unknownOutcomes(events) {
  const conversation = new Set()
  const execution = new Set()
  for (const event of events) {
    if (event.type === 'tool.started') {
      if (execution.has(event.callId)) throw corrupt(`tool already started (${event.callId})`)
      execution.add(event.callId)
    } else if (event.type === 'tool.finished') {
      if (!execution.delete(event.callId)) throw corrupt(`tool result without a start (${event.callId})`)
    } else if (event.type === 'message') {
      const message = event.message
      if (message.role === 'assistant' && message.tool_calls?.length) {
        if (conversation.size || execution.size) throw corrupt('unresolved tool calls')
        for (const call of message.tool_calls) {
          if (conversation.has(call.id)) throw corrupt('duplicate tool call')
          conversation.add(call.id)
        }
      } else if (message.role === 'tool') {
        if (!conversation.delete(message.tool_call_id)) throw corrupt('unexpected tool result')
      } else if (conversation.size || execution.size) throw corrupt('unresolved tool calls')
    }
  }
  return [...new Set([...conversation, ...execution])]
}

function applyTool(tools, piece) {
  if (!toolPiece(piece) || !Number.isInteger(piece.index) || piece.index < 0) throw corrupt('invalid tool call index')
  const current = tools.get(piece.index) ?? { id: undefined, type: 'function', name: '', arguments: '' }
  if (piece.id != null) {
    if (typeof piece.id !== 'string' || !piece.id) throw corrupt('invalid tool call id')
    if (current.id && current.id !== piece.id) throw corrupt('tool call id changed')
    current.id = piece.id
  }
  if (piece.name != null) {
    if (typeof piece.name !== 'string' || !piece.name) throw corrupt('invalid tool call name')
    if (current.name && current.name !== piece.name) throw corrupt('tool call name changed')
    current.name = piece.name
  }
  if (piece.type != null) {
    if (typeof piece.type !== 'string' || !piece.type) throw corrupt('invalid tool call type')
    current.type = piece.type
  }
  if (piece.arguments != null) {
    if (typeof piece.arguments !== 'string') throw corrupt('invalid tool call arguments')
    current.arguments += piece.arguments
  }
  tools.set(piece.index, current)
}

// Text and tool calls reconstructed from committed deltas. This does not fill
// in a fragment that was never written.
export function observeStream(events, stream) {
  let text = ''
  let reasoning = ''
  const tools = new Map()
  let finish = null
  for (const event of events) {
    if (event.type === 'stream.delta' && event.stream === stream) {
      if (typeof event.text === 'string') text += event.text
      if (typeof event.reasoning === 'string') reasoning += event.reasoning
      if (event.tool_call) applyTool(tools, event.tool_call)
    } else if (event.type === 'stream.ended' && event.stream === stream) finish = event.finish
  }
  const tool_calls = [...tools.keys()].sort((a, b) => a - b).map((index) => {
    const call = tools.get(index)
    return { id: call.id, type: call.type || 'function', function: { name: call.name, arguments: call.arguments } }
  })
  return { text, reasoning, finish, tool_calls, complete: completeFinish(finish) }
}

// stream.started is open until a complete stream.ended and the assistant
// message that follows it. An incomplete finish stays open. Nothing here
// synthesizes the missing message.
export function unknownStreams(events) {
  let open = null
  let sawEnd = false
  let awaiting = null
  const tools = new Map()
  for (const event of events) {
    if (event.type === 'stream.started') {
      if (open != null || awaiting != null) throw corrupt('stream already open')
      open = event.seq
      sawEnd = false
      tools.clear()
    } else if (event.type === 'stream.delta') {
      if (open == null || sawEnd || event.stream !== open) throw corrupt(`stream delta without a start (${event.stream})`)
      if (event.tool_call) applyTool(tools, event.tool_call)
    } else if (event.type === 'stream.ended') {
      if (open == null || sawEnd || event.stream !== open) throw corrupt(`stream end without a start (${event.stream})`)
      sawEnd = true
      if (completeFinish(event.finish)) {
        awaiting = open
        open = null
      }
    } else if (awaiting != null) {
      if (event.type === 'message' && event.message?.role === 'assistant') awaiting = null
      else throw corrupt('stream ended without an assistant message')
    }
  }
  const unknown = []
  if (open != null) unknown.push(open)
  if (awaiting != null) unknown.push(awaiting)
  return unknown
}

export function unknownReason(callIds, streams = []) {
  const parts = []
  if (callIds?.length) parts.push(`unknown tool outcome for ${callIds.join(', ')}`)
  if (streams?.length) parts.push(`unknown stream outcome for ${streams.join(', ')}`)
  if (!parts.length) parts.push('unknown outcome')
  return `Session is read-only: ${parts.join('; ')}. Inspect the workspace and start a new session.`
}

export function createEvent(input, seq, clock) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Session event must be an object')
  const source = typeof input.role === 'string' && input.type == null ? { type: 'message', message: input } : { ...input }
  delete source.seq
  if (!Object.hasOwn(source, 'time')) source.time = clock()
  const { time, type, ...rest } = source
  return { seq, time, type, ...rest }
}

export function parseSession(buffer) {
  const newline = buffer.lastIndexOf(0x0a)
  const complete = newline === -1 ? Buffer.alloc(0) : buffer.subarray(0, newline + 1)
  const incompleteTail = newline === buffer.length - 1 ? Buffer.alloc(0) : buffer.subarray(newline + 1)
  const events = []
  if (complete.length) {
    const lines = complete.toString('utf8').split('\n')
    lines.pop()
    for (const line of lines) {
      let record
      try { record = JSON.parse(line) }
      catch { throw corrupt('complete record is not JSON') }
      assertEvent(record, events.length + 1)
      events.push(record)
    }
  }
  unknownOutcomes(events)
  unknownStreams(events)
  return { events, incompleteTail: Buffer.from(incompleteTail), size: buffer.length }
}

export async function readSession(path) {
  try { return parseSession(await readFile(path)) }
  catch (error) {
    if (error.code === 'ENOENT') return { events: [], incompleteTail: Buffer.alloc(0), size: 0 }
    throw error
  }
}
