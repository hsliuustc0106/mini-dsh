import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AGENT_SCOPE } from '../src/agents.js'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'
import { assertRunCodeArguments, Tools } from '../src/services.js'

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
    for (const mode of ['ptc', 'both', '', 1, null]) {
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
    assert.throws(() => scope.tools.presentAs('code'), /already declared/)
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

test('presentAs code offers reserved run_code and leaves with the fiber', async () => {
  const { ctx, scope, tools } = await registry()
  try {
    assert.throws(() => assertRunCodeArguments({ code: 'return 1', description: ' ' }), /description must be a non-empty string/)
    assert.throws(() => assertRunCodeArguments({ code: '', description: 'sum' }), /code must be a non-empty string/)
    const plugin = scope.plugin({
      inject: ['tools'],
      apply(inner) {
        inner.tools.presentAs('code')
        inner.tools.restrict({ allow: ['read'] })
      },
    })
    await plugin.await()
    assert.equal(ctx.tools.presentations.get('mini-dsh'), 'code')
    const offered = ctx.tools.schemas({ id: 'mini-dsh' })
    assert.deepEqual(offered.map((item) => item.function.name), ['run_code'])
    assert.deepEqual(offered[0].function.parameters.required, ['code', 'description'])
    assert.equal(offered[0].function.parameters.additionalProperties, false)
    assert.equal(offered[0].function.parameters.properties.code.type, 'string')
    assert.deepEqual(names(ctx.tools.schemas()), ['read', 'shell'])
    assert.deepEqual(names(ctx.tools.schemas({ id: 'other' })), ['read', 'shell'])
    assert.equal(ctx.tools.callable('run_code', { id: 'mini-dsh' }), ctx.tools.runCode)
    assert.equal(ctx.tools.callable('read', { id: 'mini-dsh' }), undefined)
    assert.equal(ctx.tools.callable('run_code', { id: 'other' }), undefined)
    assert.equal(ctx.tools.callable('read', { id: 'other' }).name, 'read')
    const reserved = ctx.tools.createExecution({
      callId: 'c',
      name: 'run_code',
      args: { code: "throw new Error('EVALUATED')", description: 'Fail closed' },
      tool: ctx.tools.runCode,
    })
    const denyEntry = scope.tools.guard((view) => (view.name === 'run_code' ? 'entry denied' : undefined))
    assert.equal(ctx.tools.checkGuards(reserved), 'entry denied')
    denyEntry()
    assert.equal(ctx.tools.checkGuards(reserved), undefined)
    const hidden = ctx.tools.createExecution({
      callId: 's', name: 'shell', args: {}, tool: ctx.tools.items.get('shell'),
    })
    assert.equal(ctx.tools.checkGuards(hidden), 'tool shell is restricted')
    const raw = await ctx.tools.executeOnly(reserved)
    assert.equal(raw.isError, true)
    assert.equal(raw.text, 'Error: run_code nested dispatch is not supported')
    assert.equal(raw.text.includes('EVALUATED'), false)
    await assert.rejects(ctx.tools.run('run_code', { code: 'return 1', description: 'no' }), /Unknown tool: run_code/)
    await plugin.dispose()
    assert.equal(ctx.tools.presentations.has('mini-dsh'), false)
    assert.equal(ctx.tools.masks.length, 0)
    assert.deepEqual(names(ctx.tools.schemas({ id: 'mini-dsh' })), ['read', 'shell'])
    assert.equal(ctx.tools.callable('run_code', { id: 'mini-dsh' }), undefined)
  } finally {
    await tools.dispose()
  }
})

test('code mode records run_code on JSONL and does not run the program', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'a.txt'), 'hello-code\n')
  const program = "throw new Error('EVALUATED')"
  const model = fakeProvider([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'blank', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: '   ', description: 'blank' }) } },
        { id: 'direct', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) } },
        { id: 'entry', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: program, description: 'Record a program' }) } },
      ],
    },
    { role: 'assistant', content: 'done' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'native-code', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: 'return 1', description: 'After' }) } },
        { id: 'later', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) } },
      ],
    },
    { role: 'assistant', content: 'restored' },
  ])
  const app = await boot({ workspace: dir, web: false, provider: model })
  const sessionPath = app.sessionPath
  try {
    const allow = app.ctx.plugin({
      inject: ['permissions'],
      apply(inner) {
        inner.effect(() => inner.permissions.register('run_code', 'allow'))
      },
    })
    const fiber = app.ctx.plugin({
      inject: ['tools'],
      apply(inner) {
        inner.tools.presentAs('code')
      },
    })
    await allow.await()
    await fiber.await()
    await app.ctx.agent.turn('one')
    assert.deepEqual(model.sent[0].tools.map((item) => item.function.name), ['run_code'])
    const permissions = model.sent[0].context.find((item) => item?.permissions)?.permissions
    assert.match(permissions, /run_code is allowed/)
    assert.equal(/\bread\b/.test(permissions), false)
    const recorded = app.ctx.session.events.find((event) => event.type === 'model.request')
    assert.deepEqual(recorded.body.tools.map((item) => item.function.name), ['run_code'])
    assert.equal(app.ctx.session.events.some((event) => event.type === 'permission.decided' && event.callId === 'blank'), false)
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started' && event.callId === 'blank'), false)
    assert.match(app.ctx.session.events.find((event) => event.message?.tool_call_id === 'blank').message.content, /code must be a non-empty string/)
    const direct = app.ctx.session.events.find((event) => event.type === 'permission.decided' && event.callId === 'direct')
    assert.equal(direct.decision, 'deny')
    assert.equal(direct.reason, 'unknown tool')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started' && event.callId === 'direct'), false)
    const started = app.ctx.session.events.filter((event) => event.type === 'tool.started')
    assert.deepEqual(started.map((event) => event.callId), ['entry'])
    assert.equal(started[0].name, 'run_code')
    assert.deepEqual(started[0].arguments, { code: program, description: 'Record a program' })
    const finished = app.ctx.session.events.find((event) => event.type === 'tool.finished' && event.callId === 'entry')
    assert.equal(finished.result, 'Error: run_code nested dispatch is not supported')
    const stored = model.sent[1].messages.find((message) => message.role === 'tool' && message.tool_call_id === 'entry')
    assert.equal(stored.content, finished.result)
    await fiber.dispose()
    await app.ctx.agent.turn('two')
    const restored = model.sent.at(-2).tools.map((item) => item.function.name)
    assert.equal(restored.includes('run_code'), false)
    assert.equal(restored.includes('read'), true)
    const nativeCode = app.ctx.session.events.find((event) => event.type === 'permission.decided' && event.callId === 'native-code')
    assert.equal(nativeCode.decision, 'deny')
    assert.equal(nativeCode.reason, 'unknown tool')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started' && event.callId === 'native-code'), false)
    const readBack = app.ctx.session.events.find((event) => event.type === 'tool.finished' && event.callId === 'later')
    assert.match(readBack.result, /hello-code/)
    assert.equal(app.ctx.session.events.filter((event) => event.type === 'tool.finished' && event.callId === 'entry').length, 1)
  } finally {
    await app.dispose()
  }
  const againModel = fakeProvider([{ role: 'assistant', content: 'reopened' }])
  const again = await boot({ workspace: dir, session: sessionPath, web: false, provider: againModel })
  try {
    const historical = again.ctx.session.events.find((event) => event.type === 'model.request')
    assert.deepEqual(historical.body.tools.map((item) => item.function.name), ['run_code'])
    assert.equal(again.ctx.session.messages.find((message) => message.tool_call_id === 'entry').content, 'Error: run_code nested dispatch is not supported')
    await again.ctx.agent.turn('three')
    assert.equal(again.ctx.session.events.filter((event) => event.type === 'tool.finished' && event.callId === 'entry').length, 1)
    const replayed = againModel.sent[0].messages.find((message) => message.role === 'tool' && message.tool_call_id === 'entry')
    assert.equal(replayed.content, 'Error: run_code nested dispatch is not supported')
    assert.equal(againModel.sent[0].tools.some((item) => item.function.name === 'run_code'), false)
  } finally {
    await again.dispose()
  }
})

test('run_code without a policy is denied before it starts', async (t) => {
  const dir = await workspace(t)
  const model = fakeProvider([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'entry', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: 'return 1', description: 'Count' }) } }],
    },
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({ workspace: dir, web: false, provider: model })
  try {
    const fiber = app.ctx.plugin({
      inject: ['tools'],
      apply(inner) { inner.tools.presentAs('code') },
    })
    await fiber.await()
    await app.ctx.agent.turn('one')
    const decision = app.ctx.session.events.find((event) => event.type === 'permission.decided' && event.callId === 'entry')
    assert.equal(decision.decision, 'deny')
    assert.equal(decision.reason, 'unknown tool')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started'), false)
    assert.match(app.ctx.session.events.find((event) => event.message?.tool_call_id === 'entry').message.content, /unknown tool/)
  } finally {
    await app.dispose()
  }
})
