import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'
import { composition } from '../src/composition.js'

const modulePath = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-loop')
const call = (name, args) => ({ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } })
async function setup(t, replies, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-loop-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'official-loop', module: modulePath }] }))
  const provider = fakeProvider(replies)
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider, ...options })
  t.after(() => app.dispose())
  return { dir, app, provider }
}

test('the real DSH loop drives the mini provider and persists its observed response', async (t) => {
  const { app, provider } = await setup(t, [{ role: 'assistant', content: 'Hello from DSH.' }])
  await app.ctx.agent.turn('Hello')
  assert.equal(app.ctx.agent.nativeAgent.session.events.findLast((e) => e.type === 'turn/end').data.reason.kind, 'completed')
  assert.equal(app.ctx.session.events.findLast((e) => e.type === 'message').message.content, 'Hello from DSH.')
  assert.equal(provider.sent.length, 1)
})

test('the real DSH loop uses mini-dsh permissions and checkpoints for tool calls', async (t) => {
  const { app, dir, provider } = await setup(t, [
    { role: 'assistant', content: null, tool_calls: [call('read', { path: 'hello.txt' })] },
    { role: 'assistant', content: 'Read complete.' },
  ])
  await writeFile(join(dir, 'hello.txt'), 'hello DSH')
  await app.ctx.agent.turn('Read hello.txt')
  const events = app.ctx.session.events
  assert.equal(events.find((e) => e.type === 'permission.decided').decision, 'allow')
  assert.equal(events.find((e) => e.type === 'tool.finished').result, 'hello DSH')
  assert.equal(provider.sent[1].messages.at(-1).content, 'hello DSH')
  assert.equal(app.ctx.agent.nativeAgent.session.events.findLast((e) => e.type === 'turn/end').data.reason.kind, 'completed')
})

test('DSH loop respects per-call denial and does not execute a denied write', async (t) => {
  let asks = 0
  const { app, dir, provider } = await setup(t, [
    { role: 'assistant', content: null, tool_calls: [call('write', { path: 'denied.txt', content: 'no' })] },
    { role: 'assistant', content: 'Denied.' },
  ], { approve: () => { asks++; return false } })
  await app.ctx.agent.turn('Write a file')
  assert.equal(asks, 1)
  assert.equal(app.ctx.session.events.find((e) => e.type === 'permission.decided').decision, 'deny')
  assert.equal(app.ctx.session.events.some((e) => e.type === 'tool.started'), false)
  assert.match(provider.sent[1].messages.at(-1).content, /^Error:/)
  await assert.rejects(import('node:fs/promises').then((fs) => fs.access(join(dir, 'denied.txt'))), { code: 'ENOENT' })
})

test('DSH loop executes multiple model calls in order with separate decisions', async (t) => {
  const calls = [call('read', { path: 'first' }), { ...call('read', { path: 'second' }), id: 'call-2' }]
  const { app, dir, provider } = await setup(t, [
    { role: 'assistant', content: null, tool_calls: calls },
    { role: 'assistant', content: 'Both read.' },
  ])
  await writeFile(join(dir, 'first'), 'one')
  await writeFile(join(dir, 'second'), 'two')
  await app.ctx.agent.turn('Read both')
  assert.deepEqual(app.ctx.session.events.filter((e) => e.type === 'tool.finished').map((e) => e.result), ['one', 'two'])
  assert.deepEqual(provider.sent[1].messages.slice(-2).map((message) => message.content), ['one', 'two'])
})

test('DSH loop propagates model errors and preserves unknown streams', async (t) => {
  const provider = { inject: ['model'], apply(ctx) { ctx.effect(() => ctx.model.register({
    name: 'fake', prepare: () => ({ model: 'fake' }),
    async *dispatch() { yield { start: true }; yield { text: 'partial' }; throw new Error('connection dropped') },
  })) } }
  const { app } = await setup(t, [], { provider })
  await assert.rejects(app.ctx.agent.turn('Hello'), /connection dropped/)
  assert.equal(app.ctx.session.writable, false)
  assert.ok(app.ctx.session.unknownStreams.length)
})

test('DSH loop uses persisted mini-dsh history after restarting', async (t) => {
  const first = await setup(t, [{ role: 'assistant', content: 'First answer.' }])
  await first.app.ctx.agent.turn('First question')
  await first.app.dispose()
  const provider = fakeProvider([{ role: 'assistant', content: 'Second answer.' }])
  const second = await boot({ workspace: first.dir, pluginConfig: 'plugins.json', provider })
  t.after(() => second.dispose())
  await second.ctx.agent.turn('Second question')
  assert.deepEqual(provider.sent[0].messages.map((m) => m.content), ['First question', 'First answer.', 'Second question'])
})

test('DSH loop does not run a tool when the start checkpoint fails', async (t) => {
  const { app, dir } = await setup(t, [
    { role: 'assistant', content: null, tool_calls: [call('write', { path: 'should-not-exist', content: 'no' })] },
  ], { approve: () => true })
  const original = app.ctx.checkpoint.guard.bind(app.ctx.checkpoint)
  app.ctx.checkpoint.guard = (event, work) => event.type === 'tool.started' ? Promise.reject(Object.assign(new Error('disk full'), { code: 'CHECKPOINT' })) : original(event, work)
  await assert.rejects(app.ctx.agent.turn('Write a file'), /disk full/)
  await assert.rejects(import('node:fs/promises').then((fs) => fs.access(join(dir, 'should-not-exist'))), { code: 'ENOENT' })
  assert.equal(app.ctx.session.events.some((e) => e.type === 'tool.finished'), false)
})

test('DSH loop denies pending and unstarted calls on shutdown', async (t) => {
  let asked
  const waiting = new Promise((resolve) => { asked = resolve })
  const calls = [call('write', { path: 'a', content: 'a' }), { ...call('write', { path: 'b', content: 'b' }), id: 'call-2' }]
  const { app } = await setup(t, [{ role: 'assistant', content: null, tool_calls: calls }], { approve: () => { asked(); return new Promise(() => {}) } })
  const session = app.ctx.session
  const turn = app.ctx.agent.turn('Write both')
  await waiting
  const disposing = app.dispose()
  await turn.catch(() => {})
  await disposing
  const events = session.events
  assert.deepEqual(events.filter((e) => e.type === 'permission.decided').map((e) => e.callId), ['call-1', 'call-2'])
  assert.equal(events.some((e) => e.type === 'tool.started'), false)
  assert.equal(events.filter((e) => e.type === 'message' && e.message.role === 'tool').length, 2)
})

test('DSH loop drains an already-started tool before disposing its session', async (t) => {
  let entered, release
  const started = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const coding = { inject: ['tools'], apply(ctx) { ctx.tools.register({
    name: 'read', description: 'blocked read', parameters: { type: 'object', properties: {} },
    async execute() { entered(); await gate; return 'observed result' },
  }) } }
  const custom = (options) => composition(options).map((entry) => entry.name === 'coding' ? { name: 'coding', plugin: coding } : entry)
  const { app } = await setup(t, [{ role: 'assistant', content: null, tool_calls: [call('read', {})] }], { composition: custom })
  const session = app.ctx.session
  const turn = app.ctx.agent.turn('Read')
  await started
  const disposing = app.dispose()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(session.writable, true)
  assert.equal(session.events.some((e) => e.type === 'tool.finished'), false)
  release()
  await turn.catch(() => {})
  await disposing
  assert.equal(session.events.find((e) => e.type === 'tool.finished').result, 'observed result')
})

test('the Web control sends a turn through the DSH agent loop', async (t) => {
  const { app } = await setup(t, [{ role: 'assistant', content: 'Web response.' }], { web: { port: 0 } })
  const url = app.ctx.webControl.url
  const controller = new AbortController()
  t.after(() => controller.abort())
  const stream = await fetch(`${url}/events`, { signal: controller.signal })
  const reader = stream.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  const match = first.match(/event: hello\ndata: (.+)/)
  assert.ok(match)
  const connection = JSON.parse(match[1]).connection
  const response = await fetch(`${url}/turn`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ connection, input: 'Hello from Web' }) })
  assert.equal(response.status, 202)
  const deadline = Date.now() + 3000
  while (app.ctx.agent.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(app.ctx.agent.busy, false)
  assert.equal(app.ctx.session.events.findLast((e) => e.type === 'message').message.content, 'Web response.')
  assert.equal(app.ctx.agent.nativeAgent.session.events.findLast((e) => e.type === 'turn/end').data.reason.kind, 'completed')
  await reader.cancel()
})
