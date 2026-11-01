import { unknownOutcomes } from './log.js'

// A projection of one session log. It is derived on read and stored nowhere.

function sequenceGap(expected, received) {
  const error = new Error(`Trajectory sequence gap: expected ${expected}, received ${received}`)
  error.code = 'SESSION_SEQUENCE'
  return error
}

function assertContiguous(events) {
  if (!Array.isArray(events)) throw new Error('Trajectory events must be an array')
  for (let index = 0; index < events.length; index++) {
    const seq = events[index]?.seq
    if (seq !== index + 1) throw sequenceGap(index + 1, seq)
  }
}

function clip(value, max = 72) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function isErrorText(value) {
  return typeof value === 'string' && value.startsWith('Error:')
}

function spanDuration(start, end) {
  if (typeof start !== 'string' || typeof end !== 'string') return null
  const opened = Date.parse(start)
  const closed = Date.parse(end)
  if (Number.isNaN(opened) || Number.isNaN(closed)) return null
  return closed - opened
}

function kindOf(event) {
  if (event.type === 'model.request') return 'model'
  if (event.type === 'tool.started' || event.type === 'tool.finished') return 'tool'
  if (event.type === 'permission.decided') return 'permission'
  if (event.type !== 'message') return 'session'
  if (event.message.role === 'user') return 'input'
  if (event.message.role === 'tool') return 'result'
  return 'model'
}

function toolLabel(name, args) {
  const extra = typeof args?.path === 'string' ? args.path : typeof args?.command === 'string' ? args.command : ''
  return clip([name, extra].filter(Boolean).join(' '))
}

function summaryFor(event) {
  if (event.type === 'session.opened') return clip(event.workspace)
  if (event.type === 'model.request') return clip(event.provider)
  if (event.type === 'permission.decided') return clip(`${event.decision} ${event.name}`)
  if (event.type === 'tool.started') return toolLabel(event.name, event.arguments)
  if (event.type === 'tool.finished') return clip(event.result)
  if (event.type !== 'message') return event.type
  const message = event.message
  if (message.role === 'assistant' && !message.content && message.tool_calls?.length) {
    return clip(message.tool_calls.map((call) => call.function?.name).filter(Boolean).join(', '))
  }
  return clip(message.content)
}

function detailFor(event, unknown) {
  if (event.type === 'model.request') return { provider: event.provider, body: event.body }
    if (event.type === 'permission.decided') {
    return {
      callId: event.callId,
      name: event.name,
      arguments: event.arguments,
      workspace: event.workspace,
      decision: event.decision,
      ...(event.reason != null ? { reason: event.reason } : {}),
    }
  }
  if (event.type === 'tool.started') {
    return {
      callId: event.callId,
      name: event.name,
      arguments: event.arguments,
      workspace: event.workspace,
      ...(unknown.has(event.callId) ? { outcome: 'unknown' } : {}),
    }
  }
  if (event.type === 'tool.finished') {
    return {
      callId: event.callId,
      result: event.result,
      ...(isErrorText(event.result) ? { error: event.result } : {}),
    }
  }
  if (event.type === 'message') {
    const message = event.message
    if (message.role === 'tool' && isErrorText(message.content)) return { ...message, error: message.content }
    if (message.role === 'assistant' && message.tool_calls?.some((call) => unknown.has(call.id))) {
      return { ...message, outcome: 'unknown' }
    }
    return { ...message }
  }
  const { seq, time, type, ...rest } = event
  return rest
}

function statusOf(event, unknown) {
  if (event.type === 'tool.started') return unknown.has(event.callId) ? 'unknown' : 'ok'
  if (event.type === 'tool.finished') return isErrorText(event.result) ? 'error' : 'ok'
  if (event.type === 'permission.decided') return event.decision === 'deny' ? 'deny' : 'ok'
  if (event.type === 'message' && event.message.role === 'tool') return isErrorText(event.message.content) ? 'error' : 'ok'
  if (event.type === 'message' && event.message.role === 'assistant' && event.message.tool_calls?.some((call) => unknown.has(call.id))) {
    return 'unknown'
  }
  return 'ok'
}

function point(kind, event) {
  return {
    kind,
    seq: event.seq,
    endSeq: event.seq,
    time: event.time ?? null,
    endTime: event.time ?? null,
    durationMs: spanDuration(event.time, event.time),
    status: 'ok',
  }
}

// Spans follow the session sequence. An unfinished tool stays unknown and
// does not receive an invented end time.
function overviewOf(events, unknown) {
  const spans = []
  let model = null
  const tools = new Map()
  const closeModel = () => {
    if (!model) return
    spans.push(model)
    model = null
  }
  for (const event of events) {
    if (event.type === 'message' && event.message?.role === 'user') {
      closeModel()
      spans.push(point('input', event))
    } else if (event.type === 'model.request') {
      closeModel()
      model = {
        kind: 'model',
        provider: event.provider,
        seq: event.seq,
        endSeq: event.seq,
        time: event.time ?? null,
        endTime: null,
        durationMs: null,
        status: 'open',
      }
    } else if (event.type === 'message' && event.message?.role === 'assistant' && model) {
      model.endSeq = event.seq
      model.endTime = event.time ?? null
      model.durationMs = spanDuration(model.time, model.endTime)
      model.status = 'ok'
      closeModel()
    } else if (event.type === 'tool.started') {
      tools.set(event.callId, {
        kind: 'tool',
        name: event.name,
        callId: event.callId,
        seq: event.seq,
        endSeq: event.seq,
        time: event.time ?? null,
        endTime: null,
        durationMs: null,
        status: 'unknown',
      })
    } else if (event.type === 'tool.finished') {
      const span = tools.get(event.callId)
      if (!span) continue
      span.endSeq = event.seq
      span.endTime = event.time ?? null
      span.durationMs = spanDuration(span.time, span.endTime)
      span.status = isErrorText(event.result) ? 'error' : 'ok'
      spans.push(span)
      tools.delete(event.callId)
    }
  }
  closeModel()
  for (const span of tools.values()) {
    span.status = unknown.has(span.callId) ? 'unknown' : span.status
    spans.push(span)
  }
  spans.sort((a, b) => a.seq - b.seq || a.endSeq - b.endSeq)
  return spans
}

function group(rows) {
  const preamble = []
  const turns = []
  let turn = null
  for (const row of rows) {
    if (row.type === 'message' && row.detail?.role === 'user') {
      turn = { id: turns.length + 1, input: row.detail.content ?? '', rows: [row] }
      turns.push(turn)
    } else if (turn) turn.rows.push(row)
    else preamble.push(row)
  }
  return { preamble, turns }
}

export function project(events) {
  assertContiguous(events)
  const unknown = unknownOutcomes(events)
  const pending = new Set(unknown)
  const rows = events.map((event) => ({
    seq: event.seq,
    time: event.time ?? null,
    type: event.type,
    kind: kindOf(event),
    label: event.type === 'message' ? `message:${event.message.role}` : event.type,
    summary: summaryFor(event),
    status: statusOf(event, pending),
    detail: detailFor(event, pending),
  }))
  return {
    wordmark: 'mini-dsh',
    count: events.length,
    cursor: events.length ? events[events.length - 1].seq : 0,
    unknown,
    overview: overviewOf(events, pending),
    ...group(rows),
  }
}
