import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

// Exercise the actual browser script without adding a browser dependency to CI.
class Element {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.listeners = new Map()
    this.style = {}
    this.attributes = {}
    this._text = ''
    this.hidden = false
    this.open = false
    this.value = ''
    this.scrollHeight = 0
    this.scrollTop = 0
    this.clientHeight = 0
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join('') }
  set textContent(value) { this._text = String(value ?? ''); this.children = [] }
  get firstElementChild() { return this.children.find((child) => child instanceof Element) }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children) }
  addEventListener(type, listener) { this.listeners.set(type, listener) }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null }
  scrollIntoView() { this.scrolled = true }
  fire(type, event = {}) { this.listeners.get(type)?.(event) }
}

async function browser(installResponse) {
  const elements = Object.fromEntries(['chat', 'trajectory', 'events', 'timeline', 'prompt', 'send', 'notice', 'hint', 'workspace', 'chat-tab', 'trajectory-tab', 'plugins-panel', 'plugins-toggle', 'plugins-form', 'plugin-spec', 'plugin-install', 'plugin-result'].map((id) => [id, new Element(id)]))
  elements.trajectory.hidden = true
  const find = (element, id) => element.id === id ? element : element.children.map((child) => child instanceof Element ? find(child, id) : null).find(Boolean)
  const document = {
    getElementById: (id) => elements[id] ?? find(elements.events, id),
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ textContent: text }),
  }
  const timers = []
  let source
  let snapshot = { cursor: 0, overview: [] }
  class EventSource {
    constructor() { source = this; this.listeners = new Map() }
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }) }
    close() { this.closed = true }
  }
  const posts = []
  const script = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8')
  runInNewContext(script, {
    document,
    EventSource,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => { timers.push(callback); return timers.length },
    fetch: async (url, init) => {
      if (url === '/trajectory') return { ok: true, json: async () => snapshot }
      if (url === '/plugins/install' && installResponse) {
        posts.push(JSON.parse(init.body))
        return { ok: true, json: async () => installResponse }
      }
      if (url === '/approval') {
        posts.push(JSON.parse(init.body))
        return { ok: true, json: async () => ({}) }
      }
      throw new Error(`unexpected fetch ${url}`)
    },
  })
  return {
    elements, source, posts,
    snapshot(value) { snapshot = value },
    async flush() { while (timers.length) await timers.shift()() },
  }
}

test('plugin form submits the URL and explains restart and permissions', async () => {
  const { elements, posts } = await browser({ packageName: 'example', names: ['example'] })
  elements['plugin-spec'].value = 'https://github.com/example/plugin'
  await elements['plugins-form'].listeners.get('submit')({ preventDefault() {} })
  assert.equal(posts[0].spec, 'https://github.com/example/plugin')
  assert.match(elements['plugin-result'].textContent, /Restart mini-dsh/)
  assert.match(elements['plugin-result'].textContent, /denied/)
})

function descendants(element) {
  return element.children.flatMap((child) => child instanceof Element ? [child, ...descendants(child)] : [])
}

test('groups streamed fragments while preserving their text, details, and order', async () => {
  const { elements, source } = await browser()
  const emit = (event) => source.emit('session', event)
  source.emit('hello', { connection: 'browser', busy: false, writable: true })
  emit({ seq: 1, type: 'session.opened', workspace: '/tmp/workspace' })
  emit({ seq: 2, type: 'message', message: { role: 'user', content: 'Say hello' } })
  emit({ seq: 3, type: 'model.request', provider: 'fake' })
  emit({ seq: 4, type: 'stream.started' })
  emit({ seq: 5, type: 'stream.delta', stream: 4, text: 'Hel' })
  emit({ seq: 6, type: 'stream.delta', stream: 4, text: 'lo ' })
  emit({ seq: 7, type: 'stream.delta', stream: 4, text: 'world' })

  assert.equal(elements.events.children.length, 5)
  const group = elements.events.children.at(-1).firstElementChild
  assert.equal(group.firstElementChild.textContent, '#5–#7stream.delta · 3Hello world')
  assert.equal(elements.chat.children.filter((child) => child.className === 'assistant')[0].textContent, 'Hello world')
  assert.equal(elements.chat.children.some((child) => String(child.className).split(/\s+/).includes('activity')), false)

  group.open = true
  group.fire('toggle')
  source.emit('hello', { connection: 'reconnected', busy: true, writable: true })
  emit({ seq: 8, type: 'stream.delta', stream: 4, text: '!' })
  assert.equal(elements.events.children.length, 5)
  assert.equal(group.firstElementChild.textContent, '#5–#8stream.delta · 4Hello world!')
  for (const seq of [5, 6, 7, 8]) assert.equal(group.children[1].textContent.split(`"seq": ${seq}`).length - 1, 1)

  emit({ seq: 9, type: 'stream.ended', stream: 4, finish: 'stop' })
  emit({ seq: 10, type: 'message', message: { role: 'assistant', content: 'Hello world!' } })
  assert.deepEqual(elements.chat.children.filter((child) => child.className === 'assistant').map((child) => child.textContent), ['Hello world!'])
  emit({ seq: 11, type: 'model.request', provider: 'fake' })
  emit({ seq: 12, type: 'stream.started' })
  emit({ seq: 13, type: 'stream.delta', stream: 12, tool_call: { index: 0, name: 'write' } })
  emit({ seq: 14, type: 'stream.delta', stream: 12, tool_call: { index: 0, arguments: '{"path":"hello.txt"}' } })
  const second = elements.events.children.at(-1).firstElementChild
  assert.equal(second.firstElementChild.textContent, '#13–#14stream.delta · 2write{"path":"hello.txt"}')
  assert.equal(group.open, true)
  assert.equal(elements.events.children.length, 10)
  assert.equal(elements.chat.textContent.includes('{"path":"hello.txt"}'), false)
})

test('shows recorded timing for each span and updates its event details', async () => {
  const { elements, source, snapshot, flush } = await browser()
  source.emit('hello', { connection: 'browser', busy: false, writable: true })
  const emit = (event) => source.emit('session', event)
  emit({ seq: 1, type: 'message', message: { role: 'user', content: 'Write' } })
  emit({ seq: 2, type: 'model.request', provider: 'fake' })
  emit({ seq: 3, type: 'tool.started', callId: 'one', name: 'write' })
  snapshot({ cursor: 3, overview: [
    { kind: 'input', seq: 1, status: 'ok', durationMs: 0, time: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:00:00.000Z' },
    { kind: 'model', seq: 2, status: 'ok', durationMs: 20, time: '2026-01-01T00:00:01.000Z', endTime: '2026-01-01T00:00:01.020Z' },
    { kind: 'tool', seq: 3, status: 'open', durationMs: null, name: 'write', time: '2026-01-01T00:00:02.000Z', endTime: null },
  ] })
  await flush()
  assert.deepEqual(elements.timeline.children.map((bar) => bar.textContent), ['inputinstant', 'model20 ms', 'toolrunning'])
  assert.deepEqual(elements.timeline.children.map((bar) => bar.className), ['bar input', 'bar model', 'bar tool open'])
  assert.match(elements.timeline.children[0].title, /At:/)
  assert.match(elements.timeline.children[1].title, /Started:.*Finished:.*Duration: 20 ms/)
  assert.equal(elements.timeline.children[1].attributes['aria-label'], elements.timeline.children[1].title)
  assert.match(elements.timeline.children[2].title, /Duration: in progress.*Status: running/)
  elements.timeline.children[1].fire('click')
  const modelRow = elements.events.children[1]
  assert.equal(modelRow.firstElementChild.open, true)
  assert.equal(modelRow.scrolled, true)
  assert.match(modelRow.firstElementChild.children[1].textContent, /Started:.*Finished:.*Duration: 20 ms/)
  assert.equal(modelRow.firstElementChild.children[1].hidden, false)

  snapshot({ cursor: 3, overview: [
    { kind: 'input', seq: 1, status: 'ok', durationMs: null },
    { kind: 'model', seq: 2, status: 'unknown', durationMs: null, time: '2026-01-01T00:00:01.000Z' },
    { kind: 'tool', seq: 3, status: 'ok', durationMs: 46, name: 'write', time: '2026-01-01T00:00:02.000Z', endTime: '2026-01-01T00:00:02.046Z' },
  ] })
  source.emit('state', { busy: false, writable: true })
  await flush()
  assert.deepEqual(elements.timeline.children.map((bar) => bar.textContent), ['input—', 'modelunknown', 'tool46 ms'])
  assert.match(modelRow.firstElementChild.children[1].textContent, /Duration: unavailable.*Status: unknown/)
  assert.match(elements.events.children[2].firstElementChild.children[1].textContent, /Finished:.*Duration: 46 ms/)
})

test('an approval click waits for the session event before showing a decision or tool result', async () => {
  const { elements, source, posts } = await browser()
  source.emit('hello', { connection: 'browser', busy: true, writable: true })
  const emit = (event) => source.emit('session', event)
  emit({ seq: 1, type: 'message', message: { role: 'user', content: 'Write hello.txt' } })
  emit({ seq: 2, type: 'model.request', provider: 'fake' })
  emit({ seq: 3, type: 'stream.started' })
  emit({ seq: 4, type: 'stream.delta', stream: 3, text: 'Writing' })
  emit({ seq: 5, type: 'stream.ended', stream: 3, finish: 'tool_calls' })
  emit({ seq: 6, type: 'message', message: { role: 'assistant', content: 'Writing', tool_calls: [
    { id: 'write-hello', type: 'function', function: { name: 'write', arguments: '{"path":"hello.txt","content":"hello\\n"}' } },
  ] } })
  source.emit('approval', { pending: { id: 'ask-1', name: 'write', arguments: { path: 'hello.txt', content: 'hello\n' }, workspace: '/tmp/workspace' } })
  assert.match(elements.chat.textContent, /Allow this tool call\?/)
  const activity = elements.chat.children.find((child) => String(child.className).split(/\s+/).includes('activity'))
  const activityLog = activity.children.find((child) => String(child.className).split(/\s+/).includes('activity-log'))
  const card = elements.chat.children.find((child) => child.className === 'approval')
  assert.equal(activityLog.hidden, true)
  assert.equal(elements.chat.children.includes(card), true)
  assert.equal(activityLog.children.includes(card), false)
  assert.equal(elements.chat.textContent.includes('Allowed once'), false)
  assert.equal(elements.chat.textContent.includes('Running'), false)
  assert.equal(elements.chat.textContent.includes('File written'), false)

  const rows = elements.events.children.length
  descendants(elements.chat).find((element) => element.className === 'allow').fire('click')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(posts, [{ connection: 'browser', id: 'ask-1', decision: 'allow' }])
  assert.equal(elements.events.children.length, rows)
  assert.equal(elements.chat.textContent.includes('Allowed once'), false)
  assert.equal(elements.chat.textContent.includes('Running'), false)
  assert.equal(elements.chat.textContent.includes('File written'), false)

  emit({ seq: 7, type: 'permission.decided', callId: 'write-hello', name: 'write', decision: 'allow', arguments: { path: 'hello.txt', content: 'hello\n' }, workspace: '/tmp/workspace' })
  assert.match(elements.chat.textContent, /Allowed once · write/)
  assert.equal(elements.chat.textContent.includes('Running'), false)
  assert.equal(elements.chat.textContent.includes('File written'), false)
  emit({ seq: 8, type: 'tool.started', callId: 'write-hello', name: 'write', arguments: { path: 'hello.txt', content: 'hello\n' } })
  assert.match(elements.chat.textContent, /Running write/)
  assert.equal(elements.chat.textContent.includes('File written'), false)
  emit({ seq: 9, type: 'tool.finished', callId: 'write-hello', result: 'File written.' })
  assert.match(elements.chat.textContent, /File written\./)
})

function activityRows(chat) {
  return chat.children.filter((child) => String(child.className).split(/\s+/).includes('activity'))
}

function activityParts(row) {
  return {
    button: row.children.find((child) => child.tag === 'button'),
    body: row.children.find((child) => String(child.className).split(/\s+/).includes('activity-log')),
  }
}

test('collapses intermediate activity, keeps the answer visible, and preserves expand and scroll', async () => {
  const { elements, source } = await browser()
  source.emit('hello', { connection: 'browser', busy: true, writable: true })
  const emit = (event) => source.emit('session', event)
  const longOutput = `ok 1 - diamond\n${'line '.repeat(800)}\nok 20 - done`
  emit({ seq: 1, type: 'message', message: { role: 'user', content: 'Run the suite' } })
  emit({ seq: 2, type: 'model.request', provider: 'fake' })
  emit({ seq: 3, type: 'stream.started' })
  emit({ seq: 4, type: 'stream.delta', stream: 3, text: 'Let me edit the test. ', reasoning: 'hidden chain of thought' })
  emit({ seq: 5, type: 'stream.delta', stream: 3, tool_call: { index: 0, name: 'edit', arguments: '{"path":"test.js"}' } })
  emit({ seq: 6, type: 'stream.ended', stream: 3, finish: 'tool_calls' })
  emit({ seq: 7, type: 'message', message: { role: 'assistant', content: 'Let me edit the test.', tool_calls: [
    { id: 'edit-1', type: 'function', function: { name: 'edit', arguments: '{"path":"test.js"}' } },
  ] } })
  emit({ seq: 8, type: 'permission.decided', callId: 'edit-1', name: 'edit', decision: 'allow', arguments: { path: 'test.js' }, workspace: '/tmp/workspace' })
  emit({ seq: 9, type: 'tool.started', callId: 'edit-1', name: 'edit', arguments: { path: 'test.js' } })
  emit({ seq: 10, type: 'tool.finished', callId: 'edit-1', result: 'File edited.' })
  emit({ seq: 11, type: 'message', message: { role: 'tool', tool_call_id: 'edit-1', content: 'File edited.' } })
  emit({ seq: 12, type: 'model.request', provider: 'fake' })
  emit({ seq: 13, type: 'stream.started' })
  emit({ seq: 14, type: 'stream.delta', stream: 13, text: 'Now the suite. ' })
  emit({ seq: 15, type: 'stream.delta', stream: 13, tool_call: { index: 0, name: 'shell' } })
  emit({ seq: 16, type: 'stream.ended', stream: 13, finish: 'tool_calls' })
  emit({ seq: 17, type: 'message', message: { role: 'assistant', content: 'Now the suite.', tool_calls: [
    { id: 'shell-1', type: 'function', function: { name: 'shell', arguments: '{"command":"npm test"}' } },
  ] } })
  emit({ seq: 18, type: 'permission.decided', callId: 'shell-1', name: 'shell', decision: 'allow' })
  emit({ seq: 19, type: 'tool.started', callId: 'shell-1', name: 'shell' })
  emit({ seq: 20, type: 'tool.finished', callId: 'shell-1', result: longOutput })

  assert.equal(elements.chat.children[0].className, 'user')
  assert.equal(elements.chat.children[0].textContent, 'Run the suite')
  assert.equal(activityRows(elements.chat).length, 1)
  const collapsed = activityParts(activityRows(elements.chat)[0])
  const label = collapsed.button.children.find((child) => String(child.className).split(/\s+/).includes('activity-label'))
  assert.equal(collapsed.button.tag, 'button')
  assert.equal(collapsed.button.type, 'button')
  assert.equal(collapsed.button.disabled, undefined)
  assert.equal(collapsed.button.getAttribute('aria-expanded'), 'false')
  assert.equal(collapsed.button.getAttribute('aria-controls'), collapsed.body.id)
  assert.equal(collapsed.body.hidden, true)
  assert.equal(collapsed.body.tabIndex, 0)
  assert.equal(collapsed.body.getAttribute('role'), 'region')
  assert.equal(label.textContent, 'edit · shell')
  assert.equal(label.textContent.includes('\n'), false)
  assert.equal(collapsed.button.textContent.includes('line '), false)
  assert.equal(elements.chat.textContent.includes('hidden chain of thought'), false)
  assert.deepEqual(elements.chat.children.filter((child) => child.className === 'assistant').map((child) => child.textContent), [])
  assert.deepEqual(collapsed.body.children.map((child) => child.textContent), [
    'Let me edit the test.',
    'Allowed once · edit',
    'Running edit…',
    'File edited.',
    'Now the suite.',
    'Allowed once · shell',
    'Running shell…',
    longOutput,
  ])
  const ledger = elements.events.children.find((item) => item.textContent.includes('stream.delta'))
  ledger.firstElementChild.open = true
  ledger.firstElementChild.fire('toggle')
  assert.match(ledger.textContent, /hidden chain of thought/)

  collapsed.button.fire('click')
  assert.equal(collapsed.button.getAttribute('aria-expanded'), 'true')
  assert.equal(collapsed.body.hidden, false)
  collapsed.body.scrollTop = 180

  emit({ seq: 21, type: 'message', message: { role: 'tool', tool_call_id: 'shell-1', content: longOutput } })
  emit({ seq: 22, type: 'model.request', provider: 'fake' })
  emit({ seq: 23, type: 'stream.started' })
  emit({ seq: 24, type: 'stream.delta', stream: 23, text: 'All 20 pass.' })
  const open = activityParts(activityRows(elements.chat)[0])
  assert.equal(open.button.getAttribute('aria-expanded'), 'true')
  assert.equal(open.body.hidden, false)
  assert.equal(open.body.scrollTop, 180)
  assert.equal(open.body.textContent.includes('All 20 pass.'), false)
  assert.deepEqual(elements.chat.children.map((child) => String(child.className).split(/\s+/)[0]), ['user', 'activity', 'assistant'])
  assert.deepEqual(elements.chat.children.filter((child) => child.className === 'assistant').map((child) => child.textContent), ['All 20 pass.'])

  emit({ seq: 25, type: 'stream.delta', stream: 23, text: ' The new test caught it.' })
  const grown = activityParts(activityRows(elements.chat)[0])
  assert.equal(grown.button.getAttribute('aria-expanded'), 'true')
  assert.equal(grown.body.scrollTop, 180)
  assert.deepEqual(elements.chat.children.filter((child) => child.className === 'assistant').map((child) => child.textContent), ['All 20 pass. The new test caught it.'])

  emit({ seq: 26, type: 'message', message: { role: 'user', content: 'One more' } })
  emit({ seq: 27, type: 'stream.started' })
  emit({ seq: 28, type: 'stream.delta', stream: 27, text: 'Checking. ' })
  emit({ seq: 29, type: 'stream.ended', stream: 27, finish: 'tool_calls' })
  emit({ seq: 30, type: 'message', message: { role: 'assistant', content: 'Checking.', tool_calls: [
    { id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"out.txt"}' } },
  ] } })
  const rows = activityRows(elements.chat)
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].getAttribute('data-id'), rows[1].getAttribute('data-id'))
  const first = activityParts(rows[0])
  const second = activityParts(rows[1])
  assert.equal(first.button.getAttribute('aria-expanded'), 'true')
  assert.equal(first.body.scrollTop, 180)
  assert.equal(second.button.getAttribute('aria-expanded'), 'false')
  assert.equal(second.body.hidden, true)
  assert.equal(second.button.children.find((child) => String(child.className).includes('activity-label')).textContent, 'read')
  assert.deepEqual(elements.chat.children.filter((child) => child.className === 'assistant').map((child) => child.textContent), ['All 20 pass. The new test caught it.'])

  first.button.fire('click')
  assert.equal(first.button.getAttribute('aria-expanded'), 'false')
  assert.equal(first.body.hidden, true)
  assert.deepEqual(elements.chat.children.filter((child) => child.className === 'assistant').map((child) => child.textContent), ['All 20 pass. The new test caught it.'])
})

test('shows a failure, denial, or interruption on the collapsed activity row', async () => {
  const failed = await browser()
  failed.source.emit('hello', { connection: 'browser', busy: true, writable: true })
  const emitFailed = (event) => failed.source.emit('session', event)
  emitFailed({ seq: 1, type: 'message', message: { role: 'user', content: 'Run it' } })
  emitFailed({ seq: 2, type: 'stream.started' })
  emitFailed({ seq: 3, type: 'stream.ended', stream: 2, finish: 'tool_calls' })
  emitFailed({ seq: 4, type: 'message', message: { role: 'assistant', content: null, tool_calls: [
    { id: 'shell-1', type: 'function', function: { name: 'shell', arguments: '{}' } },
  ] } })
  emitFailed({ seq: 5, type: 'permission.decided', callId: 'shell-1', name: 'shell', decision: 'allow' })
  emitFailed({ seq: 6, type: 'tool.started', callId: 'shell-1', name: 'shell' })
  emitFailed({ seq: 7, type: 'tool.finished', callId: 'shell-1', result: 'Error: disk full' })
  const failedRow = activityRows(failed.elements.chat)[0]
  const failedParts = activityParts(failedRow)
  assert.match(failedRow.className, /\bfailed\b/)
  assert.equal(failedParts.body.hidden, true)
  assert.equal(failedParts.button.children.find((child) => String(child.className).includes('activity-label')).textContent, 'shell failed')
  assert.match(failedParts.body.textContent, /Error: disk full/)
  assert.equal(failedParts.button.textContent.includes('disk full'), false)

  const command = await browser()
  command.source.emit('hello', { connection: 'browser', busy: true, writable: true })
  const emitCommand = (event) => command.source.emit('session', event)
  emitCommand({ seq: 1, type: 'message', message: { role: 'user', content: 'Run' } })
  emitCommand({ seq: 2, type: 'stream.started' })
  emitCommand({ seq: 3, type: 'stream.ended', stream: 2, finish: 'tool_calls' })
  emitCommand({ seq: 4, type: 'message', message: { role: 'assistant', content: null, tool_calls: [
    { id: 'shell-2', type: 'function', function: { name: 'shell', arguments: '{}' } },
  ] } })
  emitCommand({ seq: 5, type: 'tool.started', callId: 'shell-2', name: 'shell' })
  emitCommand({ seq: 6, type: 'tool.finished', callId: 'shell-2', result: 'Command failed: exit 1\nok 1 - kept in the log' })
  const commandRow = activityRows(command.elements.chat)[0]
  const commandParts = activityParts(commandRow)
  assert.match(commandRow.className, /\bfailed\b/)
  assert.equal(commandParts.body.hidden, true)
  assert.equal(commandParts.button.children.find((child) => String(child.className).includes('activity-label')).textContent, 'shell failed')
  assert.match(commandParts.body.textContent, /Command failed: exit 1/)
  assert.equal(commandParts.button.textContent.includes('kept in the log'), false)

  const denied = await browser()
  denied.source.emit('hello', { connection: 'browser', busy: true, writable: true })
  const emitDenied = (event) => denied.source.emit('session', event)
  emitDenied({ seq: 1, type: 'message', message: { role: 'user', content: 'Write' } })
  emitDenied({ seq: 2, type: 'stream.started' })
  emitDenied({ seq: 3, type: 'stream.delta', stream: 2, text: "I'll write" })
  emitDenied({ seq: 4, type: 'stream.ended', stream: 2, finish: 'tool_calls' })
  emitDenied({ seq: 5, type: 'message', message: { role: 'assistant', content: "I'll write", tool_calls: [
    { id: 'write-1', type: 'function', function: { name: 'write', arguments: '{}' } },
  ] } })
  emitDenied({ seq: 6, type: 'permission.decided', callId: 'write-1', name: 'write', decision: 'deny', reason: 'denied' })
  const deniedRow = activityRows(denied.elements.chat)[0]
  const deniedParts = activityParts(deniedRow)
  assert.match(deniedRow.className, /\bdenied\b/)
  assert.equal(deniedParts.body.hidden, true)
  assert.equal(deniedParts.button.children.find((child) => String(child.className).includes('activity-label')).textContent, 'write denied')
  assert.match(deniedParts.body.textContent, /I'll write/)
  assert.match(deniedParts.body.textContent, /Denied · write/)
  assert.equal(denied.elements.chat.children.some((child) => child.className === 'assistant'), false)

  const stopped = await browser()
  stopped.source.emit('hello', { connection: 'browser', busy: true, writable: true })
  const emitStopped = (event) => stopped.source.emit('session', event)
  emitStopped({ seq: 1, type: 'message', message: { role: 'user', content: 'Check' } })
  emitStopped({ seq: 2, type: 'stream.started' })
  emitStopped({ seq: 3, type: 'stream.delta', stream: 2, text: 'Partial answer' })
  emitStopped({ seq: 4, type: 'stream.ended', stream: 2, finish: 'aborted' })
  assert.equal(activityRows(stopped.elements.chat).length, 0)
  assert.equal(stopped.elements.chat.children.find((child) => child.className === 'outcome').textContent, 'Interrupted')
  assert.equal(stopped.elements.chat.children.find((child) => child.className === 'assistant').textContent, 'Partial answer')
  assert.equal(stopped.elements.chat.textContent.includes('reasoning'), false)

  const hanging = await browser()
  hanging.source.emit('hello', { connection: 'browser', busy: true, writable: true })
  const emitHanging = (event) => hanging.source.emit('session', event)
  emitHanging({ seq: 1, type: 'message', message: { role: 'user', content: 'Search' } })
  emitHanging({ seq: 2, type: 'stream.started' })
  emitHanging({ seq: 3, type: 'stream.ended', stream: 2, finish: 'tool_calls' })
  emitHanging({ seq: 4, type: 'message', message: { role: 'assistant', content: 'Searching.', tool_calls: [
    { id: 'grep-1', type: 'function', function: { name: 'grep', arguments: '{}' } },
  ] } })
  emitHanging({ seq: 5, type: 'permission.decided', callId: 'grep-1', name: 'grep', decision: 'allow' })
  emitHanging({ seq: 6, type: 'tool.started', callId: 'grep-1', name: 'grep' })
  const running = activityParts(activityRows(hanging.elements.chat)[0])
  assert.equal(running.button.children.find((child) => String(child.className).includes('activity-label')).textContent, 'Running grep…')
  assert.equal(running.body.hidden, true)
  running.button.fire('click')
  running.body.scrollTop = 24
  hanging.source.emit('state', { busy: false, writable: false })
  const interrupted = activityRows(hanging.elements.chat)[0]
  const interruptedParts = activityParts(interrupted)
  assert.match(interrupted.className, /\binterrupted\b/)
  assert.equal(interruptedParts.button.children.find((child) => String(child.className).includes('activity-label')).textContent, 'grep interrupted')
  assert.equal(interruptedParts.button.getAttribute('aria-expanded'), 'true')
  assert.equal(interruptedParts.body.hidden, false)
  assert.equal(interruptedParts.body.scrollTop, 24)
  assert.match(interruptedParts.body.textContent, /Running grep/)
  assert.equal(interruptedParts.body.textContent.includes('Error:'), false)
})
