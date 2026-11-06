import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '../src/boot.js'
import { project } from '../src/trajectory.js'
import { loadProfileEntries } from '../src/live-plugins.js'
import { fakeProvider } from '../src/provider.js'
import { Tools } from '../src/services.js'

const objectParameters = { type: 'object', properties: {}, additionalProperties: false }

function call(name, args = {}, id = 'call-1') {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  }
}

function calls(items) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: items.map(([id, name, args = {}]) => ({
      id, type: 'function', function: { name, arguments: JSON.stringify(args) },
    })),
  }
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-tool-hooks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('pre-execute deny and cancel skip the body; ask is denied; permission deny skips hooks', async (t) => {
  const source = `
export const inject = ['tools', 'permissions']
export function apply(ctx, config) {
  const mode = config.mode
  ctx.effect(() => ctx.tools.register({
    name: 'echo', description: 'Echo.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'raw',
  }))
  if (config.policy) ctx.effect(() => ctx.permissions.register('echo', config.policy))
  ctx.on('tools/pre-execute', async () => {
    if (mode === 'skip') throw new Error('hook ran')
    if (mode === 'deny') return { kind: 'deny', reason: 'hook no' }
    if (mode === 'cancel') return { kind: 'cancel' }
    if (mode === 'ask') return { kind: 'ask', reason: 'please', displayReason: { en: 'Please' } }
    if (mode === 'bad') return { kind: 'rewrite' }
    return { kind: 'allow' }
  })
}
`
  const cases = [
    ['deny', 'allow', /hook no/],
    ['cancel', 'allow', /cancelled before dispatch/],
    ['ask', 'allow', /ask is not supported/],
    ['bad', 'allow', /Unsupported pre-execute decision/],
    ['skip', undefined, /unknown tool/],
  ]
  for (const [mode, policy, pattern] of cases) {
    const dir = await workspace(t)
    await writeFile(join(dir, 'hook.mjs'), source)
    await writeFile(join(dir, 'plugins.json'), JSON.stringify({
      plugins: [{ name: 'hook', module: './hook.mjs', config: { mode, ...(policy ? { policy } : {}) } }],
    }))
    const app = await boot({
      workspace: dir,
      pluginConfig: 'plugins.json',
      web: false,
      provider: fakeProvider([call('echo'), { role: 'assistant', content: 'done' }]),
    })
    try {
      await app.ctx.agent.turn('go')
      assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started'), false, mode)
      const result = app.ctx.session.events.find((event) => event.message?.role === 'tool').message.content
      assert.match(result, pattern, mode)
    } finally { await app.dispose() }
  }
})

test('a guard denies after pre-execute allow and leaves with its plugin', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'hook.mjs'), `
export const inject = ['tools', 'permissions']
export function apply(ctx) {
  let ran = false
  ctx.effect(() => ctx.tools.register({
    name: 'echo', description: 'Echo.', parameters: ${JSON.stringify(objectParameters)},
    execute: () => { ran = true; return 'raw' },
  }))
  ctx.effect(() => ctx.permissions.register('echo', 'allow'))
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
  ctx.tools.guard(() => undefined)
  ctx.tools.guard((exec) => exec.name === 'echo' ? 'owner policy' : undefined)
  ctx.effect(() => () => { if (ran) throw new Error('body ran') })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'hook', module: './hook.mjs' }] }))
  const app = await boot({
    workspace: dir,
    pluginConfig: 'plugins.json',
    web: false,
    provider: fakeProvider([call('echo'), { role: 'assistant', content: 'done' }]),
  })
  try {
    await app.ctx.agent.turn('go')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started'), false)
    assert.match(app.ctx.session.events.find((event) => event.message?.role === 'tool').message.content, /owner policy/)
  } finally { await app.dispose() }

  const ctx = new Context()
  const tools = ctx.plugin(Tools)
  const plugin = ctx.plugin({
    inject: ['tools'],
    apply(inner) {
      inner.tools.guard(() => 'no')
      inner.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'hook' }))
    },
  })
  await Promise.all([tools.await(), plugin.await()])
  assert.equal(ctx.tools.guards.length, 1)
  const exec = ctx.tools.createExecution({
    callId: 'c', name: 'echo', args: {}, tool: { name: 'echo', execute() { return 'x' } },
  })
  assert.equal(ctx.tools.checkGuards(exec), 'no')
  await plugin.dispose()
  assert.equal(ctx.tools.guards.length, 0)
  assert.deepEqual(await ctx.tools.preExecute(exec), { kind: 'allow' })
  const asyncGuard = ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.guard(() => Promise.resolve('later')) } })
  await asyncGuard.await()
  assert.throws(() => ctx.tools.checkGuards(exec), /synchronous/)
  await asyncGuard.dispose()
  await tools.dispose()
})

test('post-execute can replace text, replace a value, or block, and tools/result failures stay contained', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'hook.mjs'), `
export const inject = ['tools', 'permissions']
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'echo', description: 'Echo.', parameters: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: 'n=' + value.n }],
    },
    execute: ({ op }) => ({ n: op === 'value' ? 1 : 7 }),
  }))
  ctx.effect(() => ctx.permissions.register('echo', 'allow'))
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.arguments.op === 'text') return { kind: 'accept', content: [{ type: 'text', text: 'replaced-text' }] }
    if (exec.arguments.op === 'value') return { kind: 'accept', value: { n: 2 } }
    if (exec.arguments.op === 'block') return { kind: 'block', feedback: [{ type: 'text', text: 'stop' }], additionalContexts: [{ role: 'user', content: 'after-block' }] }
    if (exec.arguments.op === 'both') return { kind: 'accept', content: [{ type: 'text', text: 'x' }], value: { n: 3 } }
    return decision
  })
  ctx.on('tools/result', () => { throw new Error('observer boom') })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'hook', module: './hook.mjs' }] }))
  const model = fakeProvider([
    calls([['text', 'echo', { op: 'text' }], ['value', 'echo', { op: 'value' }], ['block', 'echo', { op: 'block' }], ['both', 'echo', { op: 'both' }]]),
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', web: false, provider: model })
  try {
    await app.ctx.agent.turn('go')
    const finished = app.ctx.session.events.filter((event) => event.type === 'tool.finished').map((event) => event.result)
    assert.deepEqual(finished, ['replaced-text', 'n=2', 'Error: stop', 'Error: post-execute accept cannot replace content and value'])
    assert.equal(model.sent[1].messages.some((message) => message.role === 'user' && message.content === 'after-block'), true)
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tools.context' && event.content === 'after-block'), true)
    assert.equal(JSON.stringify(app.ctx.session.events).includes('observer boom'), false)
  } finally { await app.dispose() }
})

test('non-text content blocks fail closed and are not stored as model input', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'hook.mjs'), `
export const inject = ['tools', 'permissions']
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'picture', description: 'Picture.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: () => [{ type: 'image', data: 'IMAGEPAYLOAD' }] },
    execute: () => 'bytes',
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'noted', description: 'Noted.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'ok',
  }))
  ctx.effect(() => ctx.permissions.register('picture', 'allow'))
  ctx.effect(() => ctx.permissions.register('noted', 'allow'))
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (exec.name !== 'noted') return decision
    return { kind: 'accept', content: [{ type: 'image', data: 'SENTINEL' }] }
  })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'hook', module: './hook.mjs' }] }))
  const model = fakeProvider([
    calls([['pic', 'picture'], ['note', 'noted']]),
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', web: false, provider: model })
  try {
    await app.ctx.agent.turn('go')
    const finished = app.ctx.session.events.filter((event) => event.type === 'tool.finished').map((event) => event.result)
    assert.equal(finished.length, 2)
    assert.match(finished[0], /only text output blocks are supported/)
    assert.match(finished[1], /only text output blocks are supported/)
    const encoded = JSON.stringify(app.ctx.session.events)
    assert.equal(encoded.includes('IMAGEPAYLOAD'), false)
    assert.equal(encoded.includes('SENTINEL'), false)
    assert.equal(model.sent[1].messages.filter((message) => message.role === 'tool').every((message) => !String(message.content).includes('IMAGEPAYLOAD') && !String(message.content).includes('SENTINEL')), true)
  } finally { await app.dispose() }
})

test('hook-mutated tool output and context replay from JSONL and are not rewritten', async (t) => {
  const dir = await workspace(t)
  const sessionPath = join(dir, 'session.jsonl')
  const source = `
export const inject = ['tools', 'permissions']
export function apply(ctx, config = {}) {
  const stamp = config.stamp ?? 'missing'
  ctx.effect(() => ctx.tools.register({
    name: 'echo', description: 'Echo.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'raw-' + stamp,
  }))
  ctx.effect(() => ctx.permissions.register('echo', 'allow'))
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (exec.name !== 'echo' || decision.kind !== 'accept') return decision
    return {
      kind: 'accept',
      content: [{ type: 'text', text: 'body@' + stamp }],
      additionalContexts: [{ role: 'user', content: 'note@' + stamp }],
    }
  })
}
`
  await writeFile(join(dir, 'hook.mjs'), source)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'hook', module: './hook.mjs', config: { stamp: 'clock-A' } }],
  }))
  const recorded = fakeProvider([call('echo'), { role: 'assistant', content: 'done-A' }])
  const writer = await boot({
    workspace: dir,
    sessionPath,
    pluginConfig: 'plugins.json',
    web: false,
    clock: () => '2026-01-01T00:00:00.000Z',
    provider: recorded,
  })
  let recordedEvents
  try {
    await writer.ctx.agent.turn('hello')
    assert.equal(writer.ctx.session.events.find((event) => event.type === 'tool.finished').result, 'body@clock-A')
    assert.equal(recorded.sent[1].messages.some((message) => message.content === 'note@clock-A'), true)
    assert.equal(recorded.sent[1].messages.some((message) => message.content === 'note@clock-B'), false)
    recordedEvents = writer.ctx.session.events.map((event) => ({ ...event }))
  } finally { await writer.dispose() }

  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'hook', module: './hook.mjs', config: { stamp: 'clock-B' } }],
  }))
  const reader = await boot({
    workspace: dir,
    sessionPath,
    pluginConfig: 'plugins.json',
    web: false,
    writable: false,
    clock: () => '2026-06-15T12:00:00.000Z',
    provider: fakeProvider([]),
  })
  try {
    assert.equal(reader.report.find((entry) => entry.name === 'hook').state, 'active')
    assert.equal(reader.ctx.session.events.find((event) => event.type === 'tool.finished').result, 'body@clock-A')
    assert.equal(reader.ctx.session.messages.some((message) => message.content === 'note@clock-A'), true)
    assert.equal(reader.ctx.session.messages.some((message) => message.content === 'note@clock-B' || message.content === 'body@clock-B'), false)
    assert.ok(reader.ctx.session.events.every((event) => event.time === '2026-01-01T00:00:00.000Z'))
    assert.equal(reader.ctx.session.events.length, recordedEvents.length)
  } finally { await reader.dispose() }
})

test('tools/execute may replace signal but not call identity', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'hook.mjs'), `
export const inject = ['tools', 'permissions']
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'echo', description: 'Echo.', parameters: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(_args, exec) { return exec.signal.aborted ? 'aborted' : 'open' },
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'bare', description: 'Bare.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute() { return 'ran' },
  }))
  ctx.effect(() => ctx.permissions.register('echo', 'allow'))
  ctx.effect(() => ctx.permissions.register('bare', 'allow'))
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'echo') {
      const controller = new AbortController()
      exec.signal = controller.signal
      controller.abort()
      return next()
    }
    exec.name = 'other'
    return next()
  })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'hook', module: './hook.mjs' }] }))
  const app = await boot({
    workspace: dir,
    pluginConfig: 'plugins.json',
    web: false,
    provider: fakeProvider([
      calls([['sig', 'echo', { op: 'abort' }], ['id', 'bare']]),
      { role: 'assistant', content: 'done' },
    ]),
  })
  try {
    await app.ctx.agent.turn('go')
    const finished = app.ctx.session.events.filter((event) => event.type === 'tool.finished')
    assert.equal(finished[0].result, 'aborted')
    assert.match(finished[1].result, /read only property/)
    assert.equal(app.ctx.session.events.filter((event) => event.type === 'tool.started').length, 2)
  } finally { await app.dispose() }
})

test('concurrency-safe calls overlap and exclusive calls stay barriers', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'hook.mjs'), `
export const inject = ['tools', 'permissions']
export function apply(ctx) {
  const flags = { a: false, b: false }
  const trace = globalThis.__trace = []
  const wait = (read) => new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      if (read() || Date.now() - start > 400) resolve(read())
      else setTimeout(tick, 5)
    }
    tick()
  })
  const register = (name, tool) => {
    ctx.effect(() => ctx.tools.register(tool))
    ctx.effect(() => ctx.permissions.register(name, 'allow'))
  }
  register('safe_a', {
    name: 'safe_a', description: 'A', parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    async execute() {
      flags.a = true
      const saw = await wait(() => flags.b)
      trace.push(saw ? 'a-saw-b' : 'a-missed')
      await new Promise((resolve) => setTimeout(resolve, 40))
      trace.push('a-out')
      return 'A'
    },
  })
  register('safe_b', {
    name: 'safe_b', description: 'B', parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    async execute() {
      flags.b = true
      const saw = await wait(() => flags.a)
      trace.push(saw ? 'b-saw-a' : 'b-missed')
      trace.push('b-out')
      return 'B'
    },
  })
  register('barrier', {
    name: 'barrier', description: 'C', parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => false,
    execute() { trace.push('barrier'); return 'C' },
  })
  register('bad', {
    name: 'bad', description: 'Bad', parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe() { throw new Error('classifier') },
    async execute() {
      trace.push('bad-in')
      await new Promise((resolve) => setTimeout(resolve, 30))
      trace.push('bad-out')
      return 'bad'
    },
  })
  register('after', {
    name: 'after', description: 'After', parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    execute() { trace.push('after'); return 'after' },
  })
}

`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'hook', module: './hook.mjs' }] }))
  const app = await boot({
    workspace: dir,
    pluginConfig: 'plugins.json',
    web: false,
    provider: fakeProvider([
      calls([
        ['a', 'safe_a'],
        ['b', 'safe_b'],
        ['c', 'barrier'],
        ['d', 'bad'],
        ['e', 'after'],
      ]),
      { role: 'assistant', content: 'done' },
    ]),
  })
  try {
    await app.ctx.agent.turn('go')
    const finished = app.ctx.session.events.filter((event) => event.type === 'tool.finished').map((event) => event.result)
    assert.deepEqual(finished, ['A', 'B', 'C', 'bad', 'after'])
    const trace = globalThis.__trace
    assert.ok(trace.includes('a-saw-b'), trace.join(','))
    assert.ok(trace.includes('b-saw-a'), trace.join(','))
    assert.ok(trace.indexOf('barrier') > trace.indexOf('a-out'), trace.join(','))
    assert.ok(trace.indexOf('barrier') > trace.indexOf('b-out'), trace.join(','))
    assert.ok(trace.indexOf('after') > trace.indexOf('bad-out'), trace.join(','))
    const starts = app.ctx.session.events.filter((event) => event.type === 'tool.started').map((event) => event.callId)
    assert.deepEqual(starts, ['a', 'b', 'c', 'd', 'e'])
  } finally { await app.dispose() }
})

test('live unmount removes tool hooks and direct run does not re-enter them', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'tool.mjs'), `
export const inject = ['tools', 'permissions']
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'echo', description: 'Echo.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'raw',
  }))
  ctx.effect(() => ctx.permissions.register('echo', 'allow'))
}
`)
  await writeFile(join(dir, 'hook.mjs'), `
export function apply(ctx) {
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (exec.name !== 'echo' || decision.kind !== 'accept') return decision
    return { kind: 'accept', content: [{ type: 'text', text: 'hooked' }] }
  })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'echo-tool', module: './tool.mjs' }],
  }))
  const model = fakeProvider([
    call('echo', {}, 'one'),
    { role: 'assistant', content: 'first' },
    call('echo', {}, 'two'),
    { role: 'assistant', content: 'second' },
  ])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', web: false, provider: model })
  try {
    assert.equal(await app.ctx.tools.run('echo', {}), 'raw')
    const profile = join(dir, 'live.json')
    await writeFile(profile, JSON.stringify({ plugins: [{ name: 'echo-hook', module: join(dir, 'hook.mjs') }] }))
    const mounted = await app.ctx.livePlugins.mountAll(await loadProfileEntries(profile, ['echo-hook']))
    assert.equal(mounted[0].state, 'active')
    await app.ctx.agent.turn('one')
    assert.equal(app.ctx.session.events.find((event) => event.callId === 'one' && event.type === 'tool.finished').result, 'hooked')
    await app.ctx.livePlugins.unmount('echo-hook')
    await app.ctx.agent.turn('two')
    assert.equal(app.ctx.session.events.find((event) => event.callId === 'one' && event.type === 'tool.finished').result, 'hooked')
    assert.equal(app.ctx.session.events.find((event) => event.callId === 'two' && event.type === 'tool.finished').result, 'raw')
  } finally { await app.dispose() }
})

test('projectContent, finalizeContent, and deferLoading are the JSONL model input', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'hook.mjs'), `
export const inject = ['tools', 'permissions']
export function apply(ctx) {
  const parameters = { type: 'object', properties: {}, additionalProperties: false }
  ctx.effect(() => ctx.tools.register({
    name: 'shown', description: 'Shown.', parameters, deferLoading: true, execute: () => 'raw',
    projectContent() { return [{ type: 'text', text: 'projected' }] },
    finalizeContent() { return [{ type: 'text', text: 'final-text' }] },
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'hooked', description: 'Hooked.', parameters, execute: () => 'raw',
    projectContent() { return [{ type: 'text', text: 'projected' }] },
    finalizeContent(_exec, result) {
      return [{ type: 'text', text: result.content.map((block) => block.text).join('\\n') + '|final' }]
    },
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'picture', description: 'Picture.', parameters, execute: () => 'raw',
    projectContent() { return [{ type: 'image', data: 'IMAGEPAYLOAD' }] },
    finalizeContent() { return [{ type: 'text', text: 'sealed' }] },
  }))
  for (const name of ['shown', 'hooked', 'picture']) ctx.effect(() => ctx.permissions.register(name, 'allow'))
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (exec.name === 'hooked') return { kind: 'accept', content: [{ type: 'text', text: 'hooked' }] }
    if (exec.name === 'picture') return { kind: 'accept', content: [{ type: 'text', text: 'POSTED' }] }
    return decision
  })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'hook', module: './hook.mjs' }] }))
  const model = fakeProvider([
    calls([['show', 'shown'], ['hook', 'hooked'], ['pic', 'picture']]),
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', web: false, provider: model })
  try {
    await app.ctx.agent.turn('go')
    const offered = model.sent[0].tools.find((tool) => tool.function.name === 'shown')
    const recorded = app.ctx.session.events.find((event) => event.type === 'model.request')
    const recordedTool = recorded.body.tools.find((tool) => tool.function.name === 'shown')
    assert.equal(offered.function.deferLoading, true)
    assert.deepEqual(recordedTool, offered)
    assert.equal(JSON.stringify(recordedTool).includes('projectContent'), false)
    assert.equal(recorded.body.tools.find((tool) => tool.function.name === 'read').function.deferLoading, undefined)
    assert.equal(recorded.body.tools.find((tool) => tool.function.name === 'hooked').function.deferLoading, undefined)
    const finished = app.ctx.session.events.filter((event) => event.type === 'tool.finished').map((event) => event.result)
    const sentTools = model.sent[1].messages.filter((message) => message.role === 'tool').map((message) => message.content)
    assert.deepEqual(finished, ['final-text', 'hooked|final', 'sealed'])
    assert.deepEqual(sentTools, finished)
    const encoded = JSON.stringify(app.ctx.session.events)
    assert.equal(encoded.includes('IMAGEPAYLOAD'), false)
    assert.equal(encoded.includes('POSTED'), false)
  } finally { await app.dispose() }
})

test('supported image blocks are the JSONL model input and unsupported blocks are not stored', async (t) => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const dir = await workspace(t)
  const session = join(dir, 'session.jsonl')
  await writeFile(join(dir, 'hook.mjs'), `
export const inject = ['tools', 'permissions']
export function apply(ctx) {
  const png = ${JSON.stringify(png)}
  const parameters = { type: 'object', properties: {}, additionalProperties: false }
  ctx.effect(() => ctx.tools.register({
    name: 'shot', description: 'Shot.', parameters,
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'frame' }, { type: 'image', mediaType: 'image/png', data: png }] },
    execute: () => 'bytes',
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'only', description: 'Only.', parameters, execute: () => 'raw',
    finalizeContent() { return [{ type: 'image', mediaType: 'image/png', data: png }] },
  }))
  ctx.effect(() => ctx.tools.register({
    name: 'leak', description: 'Leak.', parameters, execute: () => 'raw',
    projectContent() { return [{ type: 'file', name: 'FILESECRET' }] },
  }))
  for (const name of ['shot', 'only', 'leak']) ctx.effect(() => ctx.permissions.register(name, 'allow'))
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'hook', module: './hook.mjs' }] }))
  const model = fakeProvider([
    calls([['shot', 'shot'], ['only', 'only'], ['leak', 'leak']]),
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({ workspace: dir, session, pluginConfig: 'plugins.json', web: false, provider: model })
  try {
    await app.ctx.agent.turn('go')
    const shot = [{ type: 'text', text: 'frame' }, { type: 'image', mediaType: 'image/png', data: png }]
    const only = [{ type: 'image', mediaType: 'image/png', data: png }]
    const finished = app.ctx.session.events.filter((event) => event.type === 'tool.finished')
    assert.equal(finished[0].result, 'frame')
    assert.deepEqual(finished[0].content, shot)
    assert.equal(finished[1].result, '')
    assert.deepEqual(finished[1].content, only)
    assert.match(finished[2].result, /only text output blocks are supported/)
    assert.equal(finished[2].content, undefined)
    const tools = app.ctx.session.messages.filter((message) => message.role === 'tool').map((message) => message.content)
    assert.deepEqual(tools[0], shot)
    assert.deepEqual(tools[1], only)
    assert.match(tools[2], /only text output blocks are supported/)
    const sent = model.sent[1].messages.filter((message) => message.role === 'tool').map((message) => message.content)
    assert.deepEqual(sent, tools)
    const recorded = app.ctx.session.events.filter((event) => event.type === 'model.request')
    assert.deepEqual(recorded[1].body.messages.filter((message) => message.role === 'tool').map((message) => message.content), sent)
    assert.equal(JSON.stringify(app.ctx.session.events).includes('FILESECRET'), false)
    const view = project(app.ctx.session.events)
    const card = view.turns[0].cards.find((item) => item.name === 'shot')
    assert.deepEqual(card.result, shot)
    const summary = view.turns[0].rows.find((row) => row.detail?.tool_call_id === 'shot').summary
    assert.match(summary, /frame/)
    assert.match(summary, /\[image\]/)
  } finally { await app.dispose() }

  await writeFile(join(dir, 'next.mjs'), `
export const inject = ['tools', 'permissions']
export function apply(ctx) {
  const parameters = { type: 'object', properties: {}, additionalProperties: false }
  ctx.effect(() => ctx.tools.register({
    name: 'shot', description: 'Shot.', parameters,
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'FILESECRET' }] },
    execute: () => 'bytes',
  }))
  ctx.effect(() => ctx.permissions.register('shot', 'allow'))
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'next', module: './next.mjs' }] }))
  const again = fakeProvider([
    call('shot', {}, 'again'),
    { role: 'assistant', content: 'later' },
  ])
  const resumed = await boot({ workspace: dir, session, pluginConfig: 'plugins.json', web: false, provider: again })
  try {
    await resumed.ctx.agent.turn('next')
    const request = again.sent[1]
    const encoded = JSON.stringify(request.messages)
    assert.equal(encoded.includes(png), true)
    assert.equal(request.messages.some((message) => message.role === 'tool' && message.content?.[1]?.data === png), true)
    assert.equal(request.messages.some((message) => message.role === 'tool' && message.content === 'FILESECRET'), true)
    const stored = resumed.ctx.session.events.find((event) => event.type === 'tool.finished' && event.callId === 'shot')
    assert.equal(stored.content[1].data, png)
    const fresh = resumed.ctx.session.events.find((event) => event.type === 'tool.finished' && event.callId === 'again')
    assert.equal(fresh.result, 'FILESECRET')
    assert.equal(fresh.content, undefined)
  } finally { await resumed.dispose() }
})

test('presentAs, restrict, run_code, and deferContext fail closed', async () => {
  const ctx = new Context()
  const tools = ctx.plugin(Tools)
  await tools.await()
  assert.throws(() => ctx.tools.presentAs('code'), /tools\.presentAs is not supported/)
  assert.throws(() => ctx.tools.restrict({ deny: ['read'] }), /tools\.restrict\(\) requires agent\.ctx/)
  assert.throws(() => ctx.tools.register({
    name: 'run_code', description: 'no', parameters: objectParameters, execute: () => 'x',
  }), /Code Mode is not supported/)
  ctx.tools.register({
    name: 'defer', description: 'Defer.', parameters: objectParameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(_args, exec) { exec.deferContext({ role: 'user', content: 'later' }); return 'x' },
  })
  await assert.rejects(ctx.tools.run('defer', {}, { callId: 'c' }), /deferContext is not supported/)
  assert.deepEqual(ctx.tools.executionMode({ name: 'missing', arguments: {} }), { kind: 'exclusive' })
  await tools.dispose()
})
