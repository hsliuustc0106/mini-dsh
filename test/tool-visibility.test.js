import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AGENT_SCOPE } from '../src/agents.js'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'
import { Tools } from '../src/services.js'

const parameters = { type: 'object', properties: {}, additionalProperties: false }

function tool(name) {
  return {
    name,
    description: name,
    parameters,
    execute: () => name,
  }
}

function names(schemas) {
  return schemas.map((schema) => schema.function.name)
}

async function registry() {
  const ctx = new Context()
  const tools = ctx.plugin(Tools)
  await tools.await()
  const scope = ctx.extend({ [AGENT_SCOPE]: { id: 'mini-dsh' } })
  scope.tools.register(tool('read'))
  scope.tools.register(tool('shell'))
  return { ctx, scope, tools }
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-tool-visibility-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('presentAs and restrict register on agent.ctx and leave with the fiber', async () => {
  const { ctx, scope, tools } = await registry()
  try {
    const plugin = scope.plugin({
      inject: ['tools'],
      apply(inner) {
        inner.tools.presentAs('native')
        inner.tools.restrict({ deny: ['shell'] })
        inner.tools.restrict({ allow: ['read', 'shell'] })
      },
    })
    await plugin.await()
    assert.equal(ctx.tools.presentations.get('mini-dsh'), 'native')
    assert.equal(ctx.tools.guards.length, 2)
    assert.deepEqual(names(ctx.tools.schemas()), ['read', 'shell'])
    assert.deepEqual(names(ctx.tools.schemas({ id: 'mini-dsh' })), ['read'])
    assert.deepEqual(names(ctx.tools.schemas({ id: 'other' })), ['read', 'shell'])
    const denied = ctx.tools.createExecution({
      callId: 'c', name: 'shell', args: {}, tool: ctx.tools.items.get('shell'),
    })
    assert.equal(ctx.tools.checkGuards(denied), 'tool shell is restricted')
    assert.equal(await ctx.tools.run('shell', {}), 'shell')
    scope.tools.register(tool('later'))
    assert.deepEqual(names(ctx.tools.schemas({ id: 'mini-dsh' })), ['read'])
    await plugin.dispose()
    assert.equal(ctx.tools.presentations.has('mini-dsh'), false)
    assert.equal(ctx.tools.guards.length, 0)
    assert.equal(ctx.tools.masks.length, 0)
    assert.deepEqual(names(ctx.tools.schemas({ id: 'mini-dsh' })), ['read', 'shell', 'later'])
    scope.tools.presentAs('native')
    assert.equal(ctx.tools.presentations.get('mini-dsh'), 'native')
  } finally {
    await tools.dispose()
  }
})

test('a deny-only mask admits a tool registered later', async () => {
  const { ctx, scope, tools } = await registry()
  try {
    const remove = scope.tools.restrict({ deny: ['shell'] })
    scope.tools.register(tool('later'))
    assert.deepEqual(names(ctx.tools.schemas({ id: 'mini-dsh' })), ['read', 'later'])
    const allowNone = scope.tools.restrict({ allow: [] })
    assert.deepEqual(names(ctx.tools.schemas({ id: 'mini-dsh' })), [])
    allowNone()
    assert.deepEqual(names(ctx.tools.schemas({ id: 'mini-dsh' })), ['read', 'later'])
    remove()
    assert.deepEqual(names(ctx.tools.schemas({ id: 'mini-dsh' })), ['read', 'shell', 'later'])
    assert.equal(ctx.tools.guards.length, 0)
  } finally {
    await tools.dispose()
  }
})

test('presentAs and restrict reject unsupported shapes', async () => {
  const { ctx, scope, tools } = await registry()
  try {
    for (const mode of ['code', 'ptc', 'both', '', 1, null]) {
      assert.throws(() => scope.tools.presentAs(mode), /tools\.presentAs is not supported/)
    }
    assert.equal(ctx.tools.presentations.size, 0)
    assert.throws(() => ctx.tools.presentAs('native'), /requires agent\.ctx/)
    assert.throws(() => scope.tools.restrict(null), /requires \{ allow/)
    assert.throws(() => scope.tools.restrict({}), /requires allow and\/or deny/)
    assert.throws(() => scope.tools.restrict({ allow: ['read'], extra: true }), /field 'extra' is not supported/)
    assert.throws(() => scope.tools.restrict({ deny: [] }), /deny is empty/)
    assert.throws(() => scope.tools.restrict({ deny: ['shell', 'shell'] }), /more than once/)
    assert.throws(() => scope.tools.restrict({ allow: ['missing'] }), /unknown tool/)
    assert.throws(() => scope.tools.restrict({ deny: ['run_code'] }), /reserved run_code/)
    assert.throws(() => scope.tools.restrict({ deny: ['nope', 'run_code'] }), /reserved run_code/)
    assert.equal(ctx.tools.masks.length, 0)
    assert.equal(ctx.tools.guards.length, 0)
    scope.tools.presentAs('native')
    assert.throws(() => scope.tools.presentAs('native'), /already declared/)
    ctx.tools.presentations.set('mini-dsh', 'ptc')
    const exec = ctx.tools.createExecution({
      callId: 'c', name: 'read', args: {}, tool: ctx.tools.items.get('read'),
    })
    assert.throws(() => ctx.tools.checkGuards(exec), /tools\.presentAs is not supported/)
    assert.throws(() => ctx.tools.schemas({ id: 'mini-dsh' }), /tools\.presentAs is not supported/)
    assert.throws(() => ctx.tools.schemas({}), /agent must have an id/)
  } finally {
    await tools.dispose()
  }
})

test('a restricted tool is omitted from the model request and denied by the guard', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'a.txt'), 'hello-mask\n')
  const model = fakeProvider([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'assistant', content: 'next' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'r2', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({ workspace: dir, web: false, provider: model })
  try {
    const fiber = app.ctx.plugin({
      inject: ['tools'],
      apply(inner) {
        inner.tools.presentAs('native')
        inner.tools.restrict({ deny: ['read'] })
      },
    })
    await fiber.await()
    assert.equal(app.ctx.tools.schemas({ id: 'other' }).some((item) => item.function.name === 'read'), true)
    await app.ctx.agent.turn('one')
    const offered = model.sent[0].tools.map((item) => item.function.name)
    assert.equal(offered.includes('read'), false)
    assert.equal(offered.includes('shell'), true)
    assert.equal(/\bread\b/.test(model.sent[0].context[0].permissions), false)
    const recorded = app.ctx.session.events.find((event) => event.type === 'model.request')
    assert.deepEqual(recorded.body.tools.map((item) => item.function.name), offered)
    const decision = app.ctx.session.events.find((event) => event.type === 'permission.decided' && event.callId === 'r1')
    assert.equal(decision.decision, 'allow')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started'), false)
    assert.match(app.ctx.session.events.find((event) => event.message?.tool_call_id === 'r1').message.content, /tool read is restricted/)
    await fiber.dispose()
    await app.ctx.agent.turn('two')
    const restored = model.sent.at(-2).tools.map((item) => item.function.name)
    assert.equal(restored.includes('read'), true)
    const finished = app.ctx.session.events.find((event) => event.type === 'tool.finished' && event.callId === 'r2')
    assert.match(finished.result, /hello-mask/)
  } finally {
    await app.dispose()
  }
})
