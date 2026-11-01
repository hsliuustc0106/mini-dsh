const get = (id) => document.getElementById(id)
const chat = get('chat')
const eventsList = get('events')
const timeline = get('timeline')
const prompt = get('prompt')
const send = get('send')
const notice = get('notice')
const hint = get('hint')
// Followed session events, in order. transcript() rebuilds the chat from `log`.
// `pending` is the open ask on this connection. Allow once and Deny post that
// ask; the chat shows the decision only after `permission.decided` arrives.
const log = []
const timingDetails = new Map()
let cursor = 0
let connection = null
let pending = null
let submitting = false
let deciding = false
let status = { busy: false, writable: false }
let message = ''
let renderPending = false
let deltaGroup = null
let timelineTimer = null
let timelineCursor = -1
let timelineRequest = 0

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text != null) element.textContent = text
  return element
}

function transcript() {
  const scrollTop = chat.scrollTop
  const atBottom = chat.scrollHeight - scrollTop - chat.clientHeight < 80
  const items = []
  let stream = null
  for (const event of log) {
    if (event.type === 'stream.started') {
      stream = { type: 'assistant', id: event.seq, text: '' }
      items.push(stream)
    } else if (event.type === 'stream.delta' && stream?.id === event.stream && event.text) {
      stream.text += event.text
    } else if (event.type === 'message' && event.message.role === 'user') {
      items.push({ type: 'user', text: event.message.content })
    } else if (event.type === 'message' && event.message.role === 'assistant') {
      if (stream) stream.text = event.message.content ?? ''
      else items.push({ type: 'assistant', text: event.message.content ?? '' })
      stream = null
    } else if (event.type === 'permission.decided') {
      items.push({ type: 'progress', text: `${event.decision === 'allow' ? 'Allowed once' : 'Denied'} · ${event.name}` })
    } else if (event.type === 'tool.started') {
      items.push({ type: 'progress', text: `Running ${event.name}…` })
    } else if (event.type === 'tool.finished') {
      items.push({ type: 'progress', text: String(event.result) })
    }
  }
  chat.replaceChildren()
  for (const item of items) {
    if (!item.text) continue
    if (item.type === 'user') {
      const bubble = node('div', 'user')
      bubble.append(node('p', '', item.text))
      chat.append(bubble)
    } else chat.append(node('p', item.type, item.text))
  }
  if (!items.length && !pending) chat.append(node('p', 'progress', 'Ready when you are.'))
  if (pending) chat.append(approvalCard())
  chat.scrollTop = atBottom ? chat.scrollHeight : scrollTop
}

function approvalCard() {
  const card = node('section', 'approval')
  card.setAttribute('aria-label', 'Tool approval')
  card.append(node('div', 'approval-status', '●  Waiting for approval'))
  const body = node('div', 'approval-body')
  body.append(node('h2', '', 'Allow this tool call?'))
  const fields = node('dl')
  for (const [name, value] of [
    ['Tool', pending.name],
    ['Arguments', JSON.stringify(pending.arguments, null, 2)],
    ['Workspace', pending.workspace],
  ]) {
    const row = node('div')
    row.append(node('dt', '', name))
    const valueNode = node('dd')
    valueNode.append(node('pre', '', value))
    row.append(valueNode)
    fields.append(row)
  }
  body.append(fields)
  const actions = node('div', 'actions')
  const deny = node('button', '', 'Deny')
  const allow = node('button', 'allow', 'Allow once')
  for (const button of [deny, allow]) {
    button.type = 'button'
    button.disabled = deciding || !connection
  }
  deny.addEventListener('click', () => answer('deny'))
  allow.addEventListener('click', () => answer('allow'))
  actions.append(deny, allow)
  body.append(actions)
  card.append(body)
  return card
}

function summary(event) {
  if (event.type === 'message') return String(event.message.content ?? event.message.tool_calls?.map((call) => call.function.name).join(', ') ?? '')
  if (event.type === 'permission.decided') return `${event.decision} ${event.name}`
  if (event.type === 'tool.started') return event.name
  if (event.type === 'tool.finished') return String(event.result)
  return String(event.workspace ?? event.provider ?? event.finish ?? '')
}

function appendEvent(event) {
  if (event.type === 'stream.delta') return appendDelta(event)
  deltaGroup = null
  const item = node('li')
  item.id = `event-${event.seq}`
  const details = node('details')
  const title = node('summary')
  title.append(node('span', '', `#${event.seq}`))
  title.append(node('strong', '', event.type === 'message' ? `message:${event.message.role}` : event.type))
  title.append(node('span', '', summary(event)))
  details.append(title)
  if (event.type === 'model.request' || event.type === 'tool.started' || (event.type === 'message' && event.message.role === 'user')) {
    const timing = node('p', 'event-timing')
    timing.hidden = true
    timingDetails.set(event.seq, timing)
    details.append(timing)
  }
  details.append(node('pre', '', JSON.stringify(event, null, 2)))
  item.append(details)
  eventsList.append(item)
}

// Keep each recorded fragment inspectable, but show one row per stream.
function appendDelta(event) {
  if (!deltaGroup || deltaGroup.stream !== event.stream) {
    const item = node('li')
    item.id = `event-${event.seq}`
    const details = node('details')
    const title = node('summary')
    const seq = node('span')
    const label = node('strong')
    const preview = node('span')
    const body = node('pre')
    const group = { stream: event.stream, first: event.seq, fragments: [], text: '', details, seq, label, preview, body }
    title.append(seq, label, preview)
    details.append(title, body)
    details.addEventListener('toggle', () => {
      if (details.open) body.textContent = group.fragments.map((fragment) => JSON.stringify(fragment, null, 2)).join('\n\n')
    })
    item.append(details)
    eventsList.append(item)
    deltaGroup = group
  }
  const group = deltaGroup
  group.fragments.push(event)
  const part = event.text ?? event.reasoning ?? event.tool_call?.name ?? event.tool_call?.arguments ?? ''
  if (group.text.length <= 160) group.text = (group.text + part).slice(0, 161)
  const preview = group.text.slice(0, 160).replace(/\s+/g, ' ').trim()
  group.seq.textContent = group.first === event.seq ? `#${event.seq}` : `#${group.first}–#${event.seq}`
  group.label.textContent = `stream.delta · ${group.fragments.length}`
  group.preview.textContent = `${preview}${group.text.length > 160 ? '…' : ''}`
  if (group.details.open) group.body.append(document.createTextNode(`${group.fragments.length > 1 ? '\n\n' : ''}${JSON.stringify(event, null, 2)}`))
}

function recordedTime(value) {
  if (typeof value !== 'string') return null
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) return null
  return time.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  })
}

function timingOf(span) {
  const start = recordedTime(span.time)
  const end = recordedTime(span.endTime)
  const measured = Number.isFinite(span.durationMs) && span.durationMs >= 0
  const duration = measured ? `${Math.round(span.durationMs).toLocaleString()} ms` : null
  const point = span.kind === 'input'
  const label = point ? (start ? 'instant' : '—')
    : span.status === 'open' ? 'running'
      : duration ?? (span.status === 'unknown' ? 'unknown' : '—')
  const description = [
    start ? `${point ? 'At' : 'Started'}: ${start}` : 'Start time unavailable',
    !point && end ? `Finished: ${end}` : null,
    point ? null : `Duration: ${duration ?? (span.status === 'open' ? 'in progress' : 'unavailable')}`,
    span.status !== 'ok' ? `Status: ${span.status === 'open' ? 'running' : span.status}` : null,
  ].filter(Boolean).join(' · ')
  return { label, description }
}

function showTimeline(spans) {
  timeline.replaceChildren()
  if (!spans.length) return timeline.append(node('p', '', 'No timing spans yet.'))
  for (const span of spans) {
    const timing = timingOf(span)
    const bar = node('button', `bar ${span.kind}${span.status !== 'ok' ? ` ${span.status}` : ''}`)
    bar.append(node('span', 'bar-kind', span.kind), node('span', 'bar-time', timing.label))
    bar.type = 'button'
    const weight = Math.max(span.durationMs ?? 0, 1)
    bar.style.flex = `${weight} ${weight} 4.5rem`
    bar.title = [[span.kind, span.name, span.provider].filter(Boolean).join(' · '), timing.description].join('\n')
    bar.setAttribute('aria-label', bar.title)
    const detail = timingDetails.get(span.seq)
    if (detail) {
      detail.textContent = `Timing · ${timing.description}`
      detail.hidden = false
    }
    bar.addEventListener('click', () => {
      const item = get(`event-${span.seq}`)
      if (!item) return
      item.firstElementChild.open = true
      item.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    timeline.append(bar)
  }
}

function scheduleTimeline() {
  if (timelineTimer != null) return
  timelineTimer = setTimeout(async () => {
    timelineTimer = null
    const request = ++timelineRequest
    try {
      const response = await fetch('/trajectory')
      if (!response.ok) throw new Error('Timing unavailable')
      const data = await response.json()
      if (request !== timelineRequest || data.cursor < timelineCursor) return
      timelineCursor = data.cursor
      showTimeline(data.overview)
    } catch {
      if (request === timelineRequest && timelineCursor < 0) timeline.replaceChildren(node('p', '', 'Timing unavailable.'))
    }
  }, 50)
}

function render() {
  if (!chat.hidden) transcript()
  const disabled = !connection || !status.writable || status.busy || Boolean(pending) || submitting
  prompt.disabled = disabled
  send.disabled = disabled || !prompt.value.trim()
  notice.textContent = message || status.error || (!status.writable && connection ? status.reason : '') || ''
  hint.textContent = !connection ? 'Connecting…' : !status.writable ? 'Session is read-only' : pending ? 'Respond to the approval to continue' : status.busy ? 'Agent is working…' : 'Enter to send · Shift + Enter for a new line'
}

function scheduleRender() {
  if (renderPending) return
  renderPending = true
  requestAnimationFrame(() => { renderPending = false; render() })
}

function select(view) {
  for (const name of ['chat', 'trajectory']) {
    get(name).hidden = name !== view
    get(`${name}-tab`).setAttribute('aria-selected', String(name === view))
  }
  scheduleRender()
}
for (const name of ['chat', 'trajectory']) {
  const tab = get(`${name}-tab`)
  tab.addEventListener('click', () => select(name))
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const other = name === 'chat' ? 'trajectory' : 'chat'
    select(other)
    get(`${other}-tab`).focus()
  })
}

async function post(path, data) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Request failed')
  return result
}

async function submit() {
  if (submitting || !connection || !status.writable || status.busy || pending || !prompt.value.trim()) return
  const input = prompt.value
  submitting = true
  message = ''
  render()
  try {
    await post('/turn', { connection, input })
    prompt.value = ''
    select('chat')
  } catch (error) { message = error.message }
  finally { submitting = false; render() }
}

async function answer(decision) {
  if (!pending || deciding || !connection) return
  const id = pending.id
  deciding = true
  message = ''
  render()
  try { await post('/approval', { connection, id, decision }) }
  catch (error) { message = error.message }
  finally { deciding = false; render() }
}

prompt.addEventListener('input', scheduleRender)
prompt.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return
  event.preventDefault()
  submit()
})
send.addEventListener('click', submit)

const source = new EventSource('/events?after=0')
source.addEventListener('hello', (event) => {
  const data = JSON.parse(event.data)
  connection = data.connection
  pending = null
  status = data
  message = ''
  scheduleTimeline()
  scheduleRender()
})
source.addEventListener('state', (event) => { status = JSON.parse(event.data); scheduleTimeline(); scheduleRender() })
source.addEventListener('approval', (event) => { pending = JSON.parse(event.data).pending; scheduleRender() })
source.addEventListener('session', (event) => {
  const record = JSON.parse(event.data)
  if (record.seq !== cursor + 1) {
    message = `Session follow gap: expected ${cursor + 1}, received ${record.seq}`
    connection = null
    source.close()
  } else {
    cursor = record.seq
    log.push(record)
    if (record.type === 'session.opened') get('workspace').textContent = `Workspace · ${record.workspace}`
    appendEvent(record)
    if (['message', 'model.request', 'stream.started', 'stream.ended', 'tool.started', 'tool.finished'].includes(record.type)) scheduleTimeline()
  }
  scheduleRender()
})
source.addEventListener('gap', (event) => {
  message = JSON.parse(event.data).error || 'Session follow gap'
  connection = null
  source.close()
  scheduleRender()
})
source.onerror = () => { connection = null; pending = null; scheduleRender() }
render()
