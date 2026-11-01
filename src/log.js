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
  if (event.time != null && typeof event.time !== 'string') throw corrupt('time must be a string')
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

export function unknownReason(callIds) {
  return `Session is read-only: unknown tool outcome for ${callIds.join(', ')}. Inspect the workspace and start a new session.`
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
  return { events, incompleteTail: Buffer.from(incompleteTail), size: buffer.length }
}

export async function readSession(path) {
  try { return parseSession(await readFile(path)) }
  catch (error) {
    if (error.code === 'ENOENT') return { events: [], incompleteTail: Buffer.alloc(0), size: 0 }
    throw error
  }
}
