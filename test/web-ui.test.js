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
  setAttribute(name, value) { this.attributes[name] = value }
  scrollIntoView() { this.scrolled = true }
  fire(type, event = {}) { this.listeners.get(type)?.(event) }
}

async function browser() {
  const elements = Object.fromEntries(['chat', 'trajectory', 'events', 'timeline', 'prompt', 'send', 'notice', 'hint', 'workspace', 'chat-tab', 'trajectory-tab'].map((id) => [id, new Element(id)]))
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
