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
  const script = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8')
  runInNewContext(script, {
    document,
    EventSource,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => { timers.push(callback); return timers.length },
    fetch: async (url) => { assert.equal(url, '/trajectory'); return { ok: true, json: async () => snapshot } },
  })
  return {
    elements, source,
    snapshot(value) { snapshot = value },
    async flush() { while (timers.length) await timers.shift()() },
  }
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

test('shows input, model and tool timing and opens the selected event', async () => {
  const { elements, source, snapshot, flush } = await browser()
  source.emit('hello', { connection: 'browser', busy: false, writable: true })
  const emit = (event) => source.emit('session', event)
  emit({ seq: 1, type: 'message', message: { role: 'user', content: 'Write' } })
  emit({ seq: 2, type: 'model.request', provider: 'fake' })
  emit({ seq: 3, type: 'tool.started', callId: 'one', name: 'write' })
  snapshot({ cursor: 3, overview: [
    { kind: 'input', seq: 1, status: 'ok', durationMs: 0 },
    { kind: 'model', seq: 2, status: 'ok', durationMs: 20 },
    { kind: 'tool', seq: 3, status: 'open', durationMs: null, name: 'write' },
  ] })
  await flush()
  assert.deepEqual(elements.timeline.children.map((bar) => bar.textContent), ['input', 'model', 'tool …'])
  assert.deepEqual(elements.timeline.children.map((bar) => bar.className), ['bar input', 'bar model', 'bar tool open'])
  elements.timeline.children[1].fire('click')
  const modelRow = elements.events.children[1]
  assert.equal(modelRow.firstElementChild.open, true)
  assert.equal(modelRow.scrolled, true)
})
