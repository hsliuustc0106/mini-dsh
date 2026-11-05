const get = (id) => document.getElementById(id)
const chat = get('chat')
const eventsList = get('events')
const timeline = get('timeline')
const prompt = get('prompt')
const send = get('send')
const notice = get('notice')
const hint = get('hint')
const pluginPanel = get('plugins-panel')
const pluginToggle = get('plugins-toggle')
const pluginForm = get('plugins-form')
const pluginSpec = get('plugin-spec')
const pluginInstall = get('plugin-install')
const pluginResult = get('plugin-result')
const pluginList = get('plugin-list')

async function refreshPlugins() {
  if (!pluginList) return
  try {
    const response = await fetch('/plugins')
    if (!response.ok) throw new Error('Plugin list unavailable')
    const data = await response.json()
    pluginList.replaceChildren()
    if (!data.plugins?.length) {
      pluginList.append(node('li', 'plugin-empty', 'No plugins installed.'))
      return
    }
    for (const plugin of data.plugins) {
      const row = node('li', `plugin-row ${plugin.state}`)
      const label = node('span', '', `${plugin.name} · ${plugin.state}${plugin.error ? ` · ${plugin.error}` : ''}`)
      const remove = node('button', '', 'Uninstall')
      remove.type = 'button'
      remove.addEventListener('click', () => uninstallPlugin(plugin.name))
      row.append(label, remove)
      pluginList.append(row)
    }
  } catch (error) {
    pluginList.replaceChildren(node('li', 'plugin-empty', error.message || 'Plugin list unavailable'))
  }
}

async function uninstallPlugin(name) {
  pluginResult.textContent = `Uninstalling ${name}…`
  try {
    const response = await fetch('/plugins/uninstall', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    })
    const result = await response.json()
    if (!response.ok) {
      if (result.code === 'PLUGIN_DEPENDENTS' && Array.isArray(result.dependents)) {
        const affected = result.dependents.map((item) => `${item.name} (${item.services.join(', ')})`).join('; ')
        pluginResult.textContent = `Cannot uninstall ${name}. Required by: ${affected}. Remove the dependent plugins first, then retry.`
        for (const item of result.dependents) {
          if (!item.removable) continue
          const button = node('button', '', `Uninstall ${item.name}`)
          button.type = 'button'
          button.addEventListener('click', () => uninstallPlugin(item.name))
          pluginResult.append(button)
        }
        if (result.dependents.every((item) => item.removable)) {
          const preview = node('button', '', 'Preview removing dependents')
          preview.type = 'button'
          preview.addEventListener('click', () => previewRemoval(name))
          pluginResult.append(preview)
        }
        return
      }
      throw new Error(result.error || 'Uninstall failed')
    }
    pluginResult.textContent = `Uninstalled ${result.name}.`
    await refreshPlugins()
  } catch (error) { pluginResult.textContent = error.message || 'Uninstall failed' }
}

async function previewRemoval(name) {
  try {
    const response = await fetch('/plugins/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, preview: true }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Preview failed')
    pluginResult.textContent = `Will uninstall: ${result.names.join(', ')}. `
    const confirm = node('button', '', 'Confirm uninstall')
    confirm.type = 'button'
    confirm.addEventListener('click', async () => {
      try {
        const reply = await fetch('/plugins/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, names: result.names }) })
        const outcome = await reply.json()
        if (!reply.ok) throw new Error(outcome.error || 'Uninstall failed')
        pluginResult.textContent = `Uninstalled ${outcome.names.join(', ')}.`
        await refreshPlugins()
      } catch (error) { pluginResult.textContent = error.message || 'Uninstall failed' }
    })
    pluginResult.append(confirm)
  } catch (error) { pluginResult.textContent = error.message || 'Preview failed' }
}

pluginToggle.addEventListener('click', () => {
  pluginPanel.hidden = !pluginPanel.hidden
  pluginToggle.setAttribute('aria-expanded', String(!pluginPanel.hidden))
  if (!pluginPanel.hidden) refreshPlugins()
})
pluginForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (pluginInstall.disabled) return
  pluginInstall.disabled = true
  pluginResult.textContent = 'Installing…'
  try {
    const response = await fetch('/plugins/install', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: pluginSpec.value }),
    })
    const result = await response.json()
    if (!response.ok) {
      const phase = result.phase === 'activation' ? 'Package installed, but activation failed: ' : ''
      throw new Error(`${phase}${result.error || 'Installation failed'}`)
    }
    if (result.restartRequired) {
      pluginResult.textContent = `Installed ${result.packageName} (${result.names.join(', ')}). Restart mini-dsh to load it. New tools are denied until a permission policy is configured.`
    } else if (!result.names.length) {
      pluginResult.textContent = `Installed ${result.packageName}; all entries are disabled.`
    } else {
      pluginResult.textContent = `Installed and activated ${result.packageName} (${result.names.join(', ')}). New tools are denied until a permission policy is configured.`
      if (result.installedNames?.length > result.names.length) pluginResult.textContent += ' Other entries are disabled.'
    }
    await refreshPlugins()
  } catch (error) { pluginResult.textContent = error.message || 'Installation failed' }
  finally { pluginInstall.disabled = false }
})
// Followed session events, in order. transcript() rebuilds the chat from `log`.
// `pending` is the open ask on this connection. Allow once and Deny post that
// ask; the chat shows the decision only after `permission.decided` arrives.
// Activity rows are a projection of those events. `activityView` remembers only
// whether a row is open and where its detail scroller sits.
const log = []
const timingDetails = new Map()
const activityView = new Map()
// Same complete finishes as log.js. The browser script cannot import that module.
const COMPLETE_FINISH = new Set(['stop', 'length', 'tool_calls', 'content_filter'])
let cursor = 0
let connection = null
let pending = null
let submitting = false
let deciding = false
let status = { busy: false, writable: false }
let message = ''
let renderPending = false
let renderedSignature = ''
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

function completeFinish(finish) {
  return COMPLETE_FINISH.has(finish)
}

function isErrorText(value) {
  // Agent failures are prefixed with Error:. The shell tool records its own
  // failure as Command failed: and still returns that text as the result.
  return typeof value === 'string' && (value.startsWith('Error:') || value.startsWith('Command failed:'))
}

function clip(value, max = 72) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function isTag(element, tag) {
  return String(element?.tagName || element?.tag || '').toLowerCase() === tag
}

function classTokens(element) {
  return String(element?.className || '').split(/\s+/).filter(Boolean)
}

function hasClass(element, name) {
  return classTokens(element).includes(name)
}

function childWith(element, predicate) {
  for (const child of element.children) if (predicate(child)) return child
  return null
}

// One pass over the followed log. Tool narration, decisions, and results fold
// into the turn's activity row. The assistant text after the last tool step
// stays a visible answer. Reasoning deltas are not part of Chat.
function projectChat(events, live, writable) {
  const blocks = []
  let activity = null
  let stream = null
  let answer = null

  const startActivity = (id) => {
    if (activity) return activity
    activity = { type: 'activity', id: String(id), lines: [], tools: [], streamInterrupted: false }
    const index = answer ? blocks.indexOf(answer) : -1
    if (index >= 0) blocks.splice(index, 0, activity)
    else blocks.push(activity)
    return activity
  }
  const noteFor = (id) => {
    const group = startActivity(id)
    let note = group.lines.find((line) => line.kind === 'note' && line.id === id)
    if (!note) {
      note = { kind: 'note', id, text: '' }
      group.lines.push(note)
    }
    return note
  }
  const ensureTool = (id, name) => {
    const group = startActivity(stream?.id ?? id)
    let tool = group.tools.find((item) => item.id === id)
    if (!tool) {
      tool = { id, name: name || 'tool', state: 'pending' }
      group.tools.push(tool)
    } else if (name) tool.name = name
    return tool
  }
  const clearAnswer = (streamId) => {
    if (!answer || (streamId != null && answer.stream !== streamId)) return
    const index = blocks.indexOf(answer)
    if (index >= 0) blocks.splice(index, 1)
    answer = null
  }
  const showAnswer = () => {
    if (!stream) return
    if (!answer || answer.stream !== stream.id) {
      if (!stream.text && !stream.interrupted) return
      answer = { type: 'assistant', stream: stream.id, text: stream.text, interrupted: Boolean(stream.interrupted) }
      blocks.push(answer)
    } else {
      answer.text = stream.text
      answer.interrupted = Boolean(stream.interrupted)
    }
  }
  const foldStream = () => {
    if (!stream) return
    if (stream.text) noteFor(stream.id).text = stream.text
    stream.folded = true
    clearAnswer(stream.id)
  }
  const abandonStream = () => {
    if (!stream) return
    const incomplete = !stream.ended || !completeFinish(stream.finish)
    if (!incomplete) return
    if (stream.folded && activity) activity.streamInterrupted = true
    else if (answer?.stream === stream.id) answer.interrupted = true
  }

  for (const event of events) {
    if (event.type === 'message' && event.message?.role === 'user') {
      abandonStream()
      activity = null
      stream = null
      answer = null
      if (event.message.content) blocks.push({ type: 'user', text: event.message.content })
    } else if (event.type === 'stream.started') {
      stream = { id: event.seq, text: '', tool: false, folded: false, ended: false, finish: null, interrupted: false }
    } else if (event.type === 'stream.delta' && stream && event.stream === stream.id) {
      if (event.tool_call) {
        stream.tool = true
        foldStream()
      }
      if (typeof event.text === 'string' && event.text) {
        stream.text += event.text
        if (stream.folded) noteFor(stream.id).text = stream.text
        else showAnswer()
      }
    } else if (event.type === 'stream.ended' && stream && event.stream === stream.id) {
      stream.ended = true
      stream.finish = event.finish
      const toolStep = stream.tool || event.finish === 'tool_calls'
      if (toolStep) {
        foldStream()
        if (!completeFinish(event.finish) && activity) activity.streamInterrupted = true
      } else if (!completeFinish(event.finish)) {
        stream.interrupted = true
        showAnswer()
      }
    } else if (event.type === 'message' && event.message?.role === 'assistant') {
      const message = event.message
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (calls.length) {
        const text = typeof message.content === 'string' ? message.content : (stream?.text ?? '')
        if (text) noteFor(stream?.id ?? event.seq).text = text
        clearAnswer(stream?.id)
        for (const call of calls) if (call?.id) ensureTool(call.id, call.function?.name || 'tool')
        if (stream?.ended && !completeFinish(stream.finish) && activity) activity.streamInterrupted = true
        stream = null
      } else if (stream && !stream.folded) {
        stream.text = message.content ?? ''
        stream.interrupted = false
        showAnswer()
        stream = null
      } else if (message.content) {
        answer = { type: 'assistant', stream: null, text: message.content, interrupted: false }
        blocks.push(answer)
        stream = null
      } else stream = null
    } else if (event.type === 'permission.decided') {
      startActivity(stream?.id ?? event.seq).lines.push({
        kind: 'progress',
        text: `${event.decision === 'allow' ? 'Allowed once' : 'Denied'} · ${event.name}`,
      })
      const tool = ensureTool(event.callId, event.name)
      if (event.decision === 'deny') tool.state = 'denied'
    } else if (event.type === 'tool.started') {
      startActivity(stream?.id ?? event.seq).lines.push({ kind: 'progress', text: `Running ${event.name}…` })
      const tool = ensureTool(event.callId, event.name)
      if (tool.state !== 'denied') tool.state = 'running'
    } else if (event.type === 'tool.finished') {
      startActivity(stream?.id ?? event.seq).lines.push({ kind: 'progress', text: String(event.result) })
      const tool = ensureTool(event.callId)
      tool.state = isErrorText(event.result) ? 'failed' : 'ok'
    }
  }

  if (stream) {
    const incomplete = !stream.ended || !completeFinish(stream.finish)
    const abandoned = incomplete && !live && !writable
    if ((stream.ended && !completeFinish(stream.finish)) || abandoned) {
      if (stream.folded && activity) activity.streamInterrupted = true
      else if (answer?.stream === stream.id) answer.interrupted = true
    }
  }
  if (!live) {
    for (const block of blocks) {
      if (block.type !== 'activity') continue
      for (const tool of block.tools) {
        if (tool.state === 'running' || tool.state === 'pending') tool.state = 'interrupted'
      }
    }
  }
  return blocks
}

function activitySummary(block) {
  const tools = block.tools
  const failed = tools.some((tool) => tool.state === 'failed')
  const denied = tools.some((tool) => tool.state === 'denied')
  const running = tools.some((tool) => tool.state === 'running')
  const interrupted = block.streamInterrupted || tools.some((tool) => tool.state === 'interrupted')
  const tone = interrupted ? 'interrupted' : failed ? 'failed' : denied ? 'denied' : running ? 'running' : 'ok'
  if (!tools.length) {
    const note = block.lines.find((line) => line.kind === 'note' && line.text)
    let text = note ? clip(note.text) : 'Activity'
    if (tone === 'interrupted') text = text === 'Activity' ? 'Interrupted' : `${text} · interrupted`
    return { text, tone }
  }
  const parts = tools.map((tool) => {
    if (tool.state === 'running') return `running ${tool.name}`
    if (tool.state === 'failed') return `${tool.name} failed`
    if (tool.state === 'interrupted') return `${tool.name} interrupted`
    if (tool.state === 'denied') return `${tool.name} denied`
    return tool.name
  })
  let text = tools.length === 1 && tools[0].state === 'running' ? `Running ${tools[0].name}…` : parts.join(' · ')
  if (block.streamInterrupted && !tools.some((tool) => tool.state === 'interrupted')) text = `${text} · interrupted`
  return { text, tone }
}

function activityPresent(block) {
  if (block.tools.length || block.streamInterrupted) return true
  return block.lines.some((line) => line.text)
}

function rememberActivity() {
  for (const child of chat.children) {
    if (!hasClass(child, 'activity')) continue
    const id = child.getAttribute('data-id')
    if (!id) continue
    const button = childWith(child, (element) => isTag(element, 'button'))
    const body = childWith(child, (element) => hasClass(element, 'activity-log'))
    const prior = activityView.get(id)
    const open = button?.getAttribute('aria-expanded') === 'true'
    const scrollTop = body && !body.hidden ? body.scrollTop : prior?.scrollTop ?? 0
    activityView.set(id, { open, scrollTop })
  }
}

function focusedActivity() {
  const active = document.activeElement
  if (!active?.closest || !chat.contains?.(active)) return null
  const row = active.closest('.activity')
  if (!row || !chat.contains(row)) return null
  return { id: row.getAttribute('data-id'), log: Boolean(active.closest('.activity-log')) }
}

function renderActivity(block) {
  const view = activityView.get(block.id) ?? { open: false, scrollTop: 0 }
  const summary = activitySummary(block)
  const tone = summary.tone === 'failed' || summary.tone === 'interrupted' || summary.tone === 'denied' ? summary.tone : ''
  const row = node('section', tone ? `activity ${tone}` : 'activity')
  row.setAttribute('data-id', block.id)
  const button = node('button', 'activity-toggle')
  button.type = 'button'
  button.setAttribute('aria-expanded', view.open ? 'true' : 'false')
  button.setAttribute('aria-controls', `activity-log-${block.id}`)
  const chevron = node('span', 'activity-chevron')
  chevron.setAttribute('aria-hidden', 'true')
  button.append(chevron, node('span', 'sr-only', 'Activity'), node('span', 'activity-label', summary.text))
  const body = node('div', 'activity-log')
  body.id = `activity-log-${block.id}`
  body.setAttribute('role', 'region')
  body.setAttribute('aria-label', 'Activity details')
  body.tabIndex = 0
  body.hidden = !view.open
  for (const line of block.lines) {
    if (!line.text) continue
    body.append(node('p', line.kind === 'note' ? 'note' : 'progress', line.text))
  }
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true'
    const current = activityView.get(block.id) ?? { open: false, scrollTop: 0 }
    if (!body.hidden) current.scrollTop = body.scrollTop
    current.open = open
    activityView.set(block.id, current)
    button.setAttribute('aria-expanded', open ? 'true' : 'false')
    body.hidden = !open
    if (open) body.scrollTop = current.scrollTop
  })
  body.addEventListener('scroll', () => {
    if (body.hidden) return
    const current = activityView.get(block.id) ?? { open: true, scrollTop: 0 }
    current.open = button.getAttribute('aria-expanded') === 'true'
    current.scrollTop = body.scrollTop
    activityView.set(block.id, current)
  })
  row.append(button, body)
  return { row, body, scrollTop: view.open ? view.scrollTop : 0 }
}

function transcript() {
  const live = Boolean(connection && status.writable && (status.busy || pending))
  // Keystrokes and tab changes call render(). Skip the rebuild when the log,
  // the open ask, and the live/read-only flags are unchanged so an open row
  // keeps its DOM, focus, and scroll position.
  const signature = `${cursor}|${pending?.id ?? ''}|${live ? 1 : 0}|${status.writable ? 1 : 0}`
  if (signature === renderedSignature) return
  renderedSignature = signature
  const focus = focusedActivity()
  rememberActivity()
  const scrollTop = chat.scrollTop
  const atBottom = chat.scrollHeight - scrollTop - chat.clientHeight < 80
  const blocks = projectChat(log, live, status.writable)
  chat.replaceChildren()
  let visible = false
  const scrolls = []
  for (const block of blocks) {
    if (block.type === 'user') {
      const bubble = node('div', 'user')
      bubble.append(node('p', '', block.text))
      chat.append(bubble)
      visible = true
    } else if (block.type === 'activity') {
      if (!activityPresent(block)) continue
      const rendered = renderActivity(block)
      chat.append(rendered.row)
      if (rendered.scrollTop) scrolls.push([rendered.body, rendered.scrollTop])
      visible = true
    } else if (block.type === 'assistant') {
      if (!block.text && !block.interrupted) continue
      if (block.interrupted) chat.append(node('p', 'outcome', 'Interrupted'))
      if (block.text) chat.append(node('p', 'assistant', block.text))
      visible = true
    }
  }
  if (!visible && !pending) chat.append(node('p', 'progress', 'Ready when you are.'))
  if (pending) chat.append(approvalCard())
  for (const [body, top] of scrolls) body.scrollTop = top
  if (focus?.id) {
    const row = childWith(chat, (element) => hasClass(element, 'activity') && element.getAttribute('data-id') === focus.id)
    const target = row && (focus.log ? childWith(row, (element) => hasClass(element, 'activity-log')) : childWith(row, (element) => isTag(element, 'button')))
    if (!target?.hidden) target?.focus?.()
  }
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
