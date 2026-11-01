import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '../src/boot.js'
import { coding } from '../src/coding.js'
import { Prompt } from '../src/prompt.js'
import { fakeProvider } from '../src/provider.js'
import { Session, Tools, Workspace } from '../src/services.js'

const tick = () => new Promise(setImmediate)

async function ready(fibers) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await Promise.all(fibers.map((fiber) => fiber.await().catch(() => {})))
    if (fibers.every((fiber) => fiber.state === 2)) return
    await tick()
  }
  throw new Error(`plugins were not ready: ${fibers.map((fiber) => fiber.state).join(',')}`)
}

test('Cordis removes tool effects and reactivates consumers when dependencies return', async () => {
  const ctx = new Context()
  const workspace = ctx.plugin(Workspace, { root: tmpdir() })
  const codingFiber = ctx.plugin(coding)
  const first = ctx.plugin(Tools)
  await ready([workspace, codingFiber, first])
  assert.equal(ctx.tools.schemas().length, 6)
  assert.throws(() => ctx.tools.register({
    name: 'read', description: 'again', parameters: { type: 'object', properties: {} }, execute() {},
  }), /Duplicate tool: read/)
  await assert.rejects(ctx.tools.run('read', { path: 1 }), /path must be a string/)
  await assert.rejects(ctx.tools.run('read', {}), /path is required/)
  await assert.rejects(ctx.tools.run('read', { path: 'a', extra: true }), /extra is not allowed/)
  await assert.rejects(ctx.tools.run('read', null), /must be an object/)
  const remove = ctx.tools.register({
    name: 'extra', description: 'n', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute() { throw new Error('ran') },
  })
  await assert.rejects(ctx.tools.run('extra', { nope: 1 }), /nope is not allowed/)
  remove()
  await assert.rejects(ctx.tools.run('extra', {}), /Unknown tool: extra/)
  await first.dispose()
  assert.equal(ctx.tools, undefined)
  const second = ctx.plugin(Tools)
  await ready([codingFiber, second])
  assert.equal(ctx.tools.schemas().length, 6)
  await codingFiber.dispose()
  assert.equal(ctx.tools.schemas().length, 0)
  await second.dispose()
  await workspace.dispose()
})

test('coding guidance follows the coding and prompt service lifecycles', async () => {
  const ctx = new Context()
  const workspace = ctx.plugin(Workspace, { root: tmpdir() })
  const tools = ctx.plugin(Tools)
  const codingFiber = ctx.plugin(coding)
  await ready([workspace, tools, codingFiber])
  assert.ok(ctx.tools.items.has('grep'))

  const first = ctx.plugin(Prompt)
  await ready([first])
  await tick()
  assert.match(ctx.prompt.snapshot().instructions.join('\n'), /glob.*grep/)
  await first.dispose()
  assert.ok(ctx.tools.items.has('grep'))

  const second = ctx.plugin(Prompt)
  await ready([second])
  await tick()
  assert.equal(ctx.prompt.snapshot().instructions.length, 1)
  await codingFiber.dispose()
  assert.deepEqual(ctx.prompt.snapshot().instructions, [])
  await second.dispose()
  await tools.dispose()
  await workspace.dispose()
})

test('agent records a tool call and replays the resulting history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-agent-'))
  await writeFile(join(dir, 'example.txt'), 'hello')
  const provider = fakeProvider([
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'example.txt' }) } }] },
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({ workspace: dir, provider })
  try {
    await app.ctx.agent.turn('Read the file')
    assert.equal(provider.sent[1].messages.at(-1).content, 'hello')
    const events = app.ctx.session.events
    const started = events.find((event) => event.type === 'tool.started')
    const finished = events.find((event) => event.type === 'tool.finished')
    assert.equal(started.callId, 'call-1')
    assert.equal(started.workspace, dir)
    assert.equal(finished.result, 'hello')
    assert.ok(started.seq < finished.seq)
    assert.ok(finished.seq < events.find((event) => event.message?.role === 'tool').seq)
    assert.deepEqual(app.ctx.session.messages.map((message) => message.role), ['user', 'assistant', 'tool', 'assistant'])
    const reader = await boot({ workspace: dir, writable: false, provider: fakeProvider([]) })
    try { assert.deepEqual(reader.ctx.session.messages, app.ctx.session.messages) }
    finally { await reader.dispose() }
  } finally {
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('keeps an interrupted tool call readable and refuses to continue it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-agent-')), path = join(dir, 'session.jsonl')
  await writeFile(path, JSON.stringify({ seq: 1, type: 'message', time: 't', message: { role: 'assistant', tool_calls: [{ id: 'pending' }] } }) + '\n')
  const ctx = new Context(), fiber = ctx.plugin(Session, { path, writable: true })
  try {
    await ready([fiber])
    assert.equal(ctx.session.writable, false)
    assert.match(ctx.session.readonlyReason, /unknown tool outcome for pending/)
    assert.equal(ctx.session.history()[0].message.tool_calls[0].id, 'pending')
    await assert.rejects(ctx.session.append({ type: 'note' }), /unknown tool outcome/)
  } finally { await fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('a prepared provider call is one-use and leaves with its plugin', async () => {
  const { Model } = await import('../src/services.js')
  const ctx = new Context()
  const model = ctx.plugin(Model)
  const plugin = fakeProvider([{ role: 'assistant', content: 'one' }])
  const fiber = ctx.plugin(plugin)
  try {
    await ready([model, fiber])
    const prepared = ctx.model.prepare({
      instructions: ['Stay'], context: [{ workspace: '/work' }], messages: [{ role: 'user', content: 'hi' }], tools: [],
    })
    assert.equal(prepared.provider, 'fake')
    assert.deepEqual(prepared.body.instructions, ['Stay'])
    assert.equal(JSON.stringify(prepared.body).includes('secret'), false)
    const chunks = []
    for await (const chunk of prepared.dispatch()) chunks.push(chunk)
    assert.equal(chunks[0].start, true)
    assert.equal(chunks.filter((chunk) => chunk.text).map((chunk) => chunk.text).join(''), 'one')
    assert.equal(chunks.at(-1).finish, 'stop')
    assert.deepEqual(plugin.sent[0], prepared.body)
    await assert.rejects(async () => prepared.dispatch(), /already used/)
    assert.throws(() => ctx.model.register({ name: 'fake', prepare: () => ({}), dispatch() {} }), /Duplicate provider: fake/)
    await fiber.dispose()
    assert.throws(() => ctx.model.prepare({ instructions: [], context: [], messages: [], tools: [] }), /single model provider/)
  } finally { await model.dispose() }
})
