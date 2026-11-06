import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AGENT_SCOPE } from '../src/agents.js'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'
import { project } from '../src/trajectory.js'
import { assertRunCodeArguments, parseNestedDispatch, Tools } from '../src/services.js'

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
    assert.equal(raw.text, 'Error: run_code program is stored and was not executed')
    assert.equal(raw.text.includes('EVALUATED'), false)
    assert.throws(() => parseNestedDispatch('{"name":"read"}'), /stored and was not executed/)
    assert.throws(() => parseNestedDispatch('[{"name":"run_code","arguments":{}}]'), /cannot call run_code/)
    assert.deepEqual(parseNestedDispatch('[]'), [])
    const listed = ctx.tools.createExecution({
      callId: 'c2',
      name: 'run_code',
      args: { code: '[{"name":"read","arguments":{}}]', description: 'List' },
      tool: ctx.tools.runCode,
    })
    const listedRaw = await ctx.tools.executeOnly(listed)
    assert.equal(listedRaw.isError, true)
    assert.match(listedRaw.text, /nested dispatch is unavailable/)
    assert.equal(listedRaw.text.includes('read'), false)
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
    assert.equal(finished.result, 'Error: run_code program is stored and was not executed')
    assert.equal(finished.result.includes('EVALUATED'), false)
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
    assert.equal(again.ctx.session.messages.find((message) => message.tool_call_id === 'entry').content, 'Error: run_code program is stored and was not executed')
    await again.ctx.agent.turn('three')
    assert.equal(again.ctx.session.events.filter((event) => event.type === 'tool.finished' && event.callId === 'entry').length, 1)
    const replayed = againModel.sent[0].messages.find((message) => message.role === 'tool' && message.tool_call_id === 'entry')
    assert.equal(replayed.content, 'Error: run_code program is stored and was not executed')
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

test('run_code dispatches nested calls through permission, hooks, and JSONL', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'a.txt'), 'hello-code\n')
  const trace = []
  const parameters = { type: 'object', properties: {}, additionalProperties: false }
  const manifest = JSON.stringify([
    { name: 'read', arguments: { path: 'a.txt' } },
    { name: 'echo', arguments: {} },
    { name: 'blocked', arguments: {} },
    { name: 'write', arguments: { path: 'nope.txt', content: 'x' } },
    { name: 'shell', arguments: { command: 'true' } },
    { name: 'note', arguments: {} },
  ])
  const batch = JSON.stringify([
    { name: 'safe_a', arguments: {} },
    { name: 'safe_b', arguments: {} },
    { name: 'barrier', arguments: {} },
  ])
  const safe = (name) => ({
    name,
    description: name,
    parameters,
    isConcurrencySafe: () => true,
    async execute() {
      trace.push(`${name}-in`)
      await new Promise((resolve) => setTimeout(resolve, 40))
      trace.push(`${name}-out`)
      return name
    },
  })
  const model = fakeProvider([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'bad', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: "throw new Error('EVALUATED')", description: 'Do not run' }) } },
        { id: 'direct', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) } },
        { id: 'entry', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: manifest, description: 'Dispatch nested calls' }) } },
        { id: 'recurse', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: '[{"name":"run_code","arguments":{}}]', description: 'Nested entry' }) } },
        { id: 'shape', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: '{"name":"read"}', description: 'Wrong shape' }) } },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'batch', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: batch, description: 'Overlap safe calls' }) } },
      ],
    },
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({ workspace: dir, web: false, provider: model })
  const sessionPath = app.sessionPath
  try {
    const fiber = app.ctx.plugin({
      inject: ['tools', 'permissions'],
      apply(inner) {
        inner.tools.presentAs('code')
        inner.tools.restrict({ deny: ['shell'] })
        inner.effect(() => inner.permissions.overlay('shell', 'allow'))
        inner.effect(() => inner.permissions.register('run_code', 'allow'))
        for (const name of ['echo', 'blocked', 'note', 'safe_a', 'safe_b', 'barrier']) {
          inner.effect(() => inner.permissions.register(name, 'allow'))
        }
        inner.tools.register({ name: 'echo', description: 'echo', parameters, execute: () => 'raw' })
        inner.tools.register({
          name: 'blocked', description: 'blocked', parameters, execute() { throw new Error('RAN') },
        })
        inner.tools.register({
          name: 'note',
          description: 'note',
          parameters,
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          execute(_args, exec) {
            exec.deferContext({ role: 'user', content: 'from-child' })
            return { text: 'noted' }
          },
        })
        inner.tools.register(safe('safe_a'))
        inner.tools.register(safe('safe_b'))
        inner.tools.register({
          name: 'barrier', description: 'barrier', parameters,
          execute() { trace.push('barrier'); return 'C' },
        })
      },
    })
    await fiber.await()
    app.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'blocked') return { kind: 'deny', reason: 'hook-denied' }
      return next()
    })
    app.ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.name !== 'echo' || decision.kind !== 'accept') return decision
      return { kind: 'accept', content: [{ type: 'text', text: 'hooked' }] }
    })
    await app.ctx.agent.turn('one', () => {}, { approve: () => false })
    const events = app.ctx.session.events
    assert.equal(events.find((event) => event.type === 'tool.finished' && event.callId === 'bad').result.includes('EVALUATED'), false)
    assert.match(events.find((event) => event.type === 'tool.finished' && event.callId === 'bad').result, /stored and was not executed/)
    const direct = events.find((event) => event.type === 'permission.decided' && event.callId === 'direct')
    assert.equal(direct.decision, 'deny')
    assert.equal(direct.reason, 'unknown tool')
    assert.equal(events.some((event) => event.type === 'tool.started' && event.callId === 'direct'), false)
    const started = events.find((event) => event.type === 'tool.started' && event.callId === 'entry')
    assert.equal(started.arguments.code, manifest)
    const readDecision = events.find((event) => event.type === 'permission.decided' && event.callId === 'entry:code:1')
    assert.equal(readDecision.decision, 'allow')
    assert.equal(readDecision.parent, 'entry')
    assert.equal(readDecision.name, 'read')
    const readStarted = events.find((event) => event.type === 'tool.started' && event.callId === 'entry:code:1')
    assert.equal(readStarted.parent, 'entry')
    assert.deepEqual(readStarted.arguments, { path: 'a.txt' })
    assert.equal(events.some((event) => event.type === 'tool.started' && event.name === 'blocked'), false)
    assert.equal(events.some((event) => event.type === 'tool.started' && event.name === 'write'), false)
    assert.equal(events.some((event) => event.type === 'tool.started' && event.name === 'shell'), false)
    assert.equal(events.some((event) => event.type === 'tool.finished' && event.result === 'RAN'), false)
    const childMessage = events.find((event) => event.message?.tool_call_id === 'entry:code:2')
    assert.equal(childMessage.message.parent, 'entry')
    assert.equal(childMessage.message.content, 'hooked')
    const summary = JSON.parse(events.find((event) => event.type === 'tool.finished' && event.callId === 'entry').result)
    assert.deepEqual(summary, [
      { callId: 'entry:code:1', name: 'read', result: 'hello-code\n' },
      { callId: 'entry:code:2', name: 'echo', result: 'hooked' },
      { callId: 'entry:code:3', name: 'blocked', result: 'Error: hook-denied' },
      { callId: 'entry:code:4', name: 'write', result: 'Error: denied' },
      { callId: 'entry:code:5', name: 'shell', result: 'Error: tool shell is restricted' },
      { callId: 'entry:code:6', name: 'note', result: 'noted' },
    ])
    assert.equal(events.find((event) => event.type === 'tool.finished' && event.callId === 'recurse').result, 'Error: run_code nested dispatch cannot call run_code')
    assert.equal(events.some((event) => event.type === 'tool.started' && event.parent === 'recurse'), false)
    assert.match(events.find((event) => event.type === 'tool.finished' && event.callId === 'shape').result, /stored and was not executed/)
    const context = events.filter((event) => event.type === 'tools.context')
    assert.deepEqual(context.map((event) => ({ callId: event.callId, content: event.content })), [{ callId: 'entry', content: 'from-child' }])
    assert.equal(app.ctx.session.messages.some((message) => message.tool_call_id === 'entry:code:1'), false)
    assert.equal(app.ctx.session.messages.find((message) => message.tool_call_id === 'entry').content, JSON.stringify(summary))
    assert.equal(app.ctx.session.messages.some((message) => message.role === 'user' && message.content === 'from-child'), true)
    const follow = model.sent[1].messages
    assert.equal(follow.find((message) => message.tool_call_id === 'entry').content, JSON.stringify(summary))
    assert.equal(follow.some((message) => message.tool_call_id === 'entry:code:1'), false)
    assert.equal(follow.some((message) => message.role === 'user' && message.content === 'from-child'), true)
    assert.deepEqual(model.sent[1].tools.map((item) => item.function.name), ['run_code'])
    await assert.rejects(access(join(dir, 'nope.txt')))
    assert.ok(trace.indexOf('safe_a-in') < trace.indexOf('safe_b-out'), trace.join(','))
    assert.ok(trace.indexOf('safe_b-in') < trace.indexOf('safe_a-out'), trace.join(','))
    assert.ok(trace.indexOf('barrier') > trace.indexOf('safe_a-out'), trace.join(','))
    assert.ok(trace.indexOf('barrier') > trace.indexOf('safe_b-out'), trace.join(','))
    const batchStarts = events.filter((event) => event.type === 'tool.started' && event.parent === 'batch').map((event) => event.callId)
    assert.deepEqual(batchStarts, ['batch:code:1', 'batch:code:2', 'batch:code:3'])
    const cards = project(events).turns.flatMap((turn) => turn.cards)
    const parentCard = cards.find((card) => card.callId === 'entry')
    const childCard = cards.find((card) => card.callId === 'entry:code:1')
    assert.equal(parentCard.status, 'ok')
    assert.equal(childCard.status, 'ok')
    assert.match(childCard.result, /hello-code/)
    await assert.rejects(
      app.ctx.agent.dispatchNested({ parentId: 'entry', calls: [], deferContext() {} }),
      /open run_code call/,
    )
  } finally {
    await app.dispose()
  }
  const againModel = fakeProvider([{ role: 'assistant', content: 'reopened' }])
  const again = await boot({ workspace: dir, session: sessionPath, web: false, provider: againModel })
  try {
    await again.ctx.agent.turn('two')
    assert.equal(again.ctx.session.events.filter((event) => event.type === 'tool.finished' && event.callId === 'entry:code:1').length, 1)
    assert.equal(again.ctx.session.events.filter((event) => event.type === 'tool.started' && event.callId === 'entry').length, 1)
    const replayed = againModel.sent[0].messages.find((message) => message.role === 'tool' && message.tool_call_id === 'entry')
    assert.equal(replayed.content.includes('hello-code'), true)
    assert.equal(againModel.sent[0].messages.some((message) => message.tool_call_id === 'entry:code:1'), false)
  } finally {
    await again.dispose()
  }
})
