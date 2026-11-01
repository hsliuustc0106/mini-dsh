import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '../src/boot.js'
import { composition } from '../src/composition.js'
import { acquireWriter, lockPathFor } from '../src/lock.js'
import { observeStream, unknownOutcomes } from '../src/log.js'
import { Prompt } from '../src/prompt.js'
import { fakeProvider } from '../src/provider.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function ready(fibers) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await Promise.all(fibers.map((fiber) => fiber.await().catch(() => {})))
    if (fibers.every((fiber) => fiber.state === 2)) return
    await tick()
  }
  throw new Error(`plugins were not ready: ${fibers.map((fiber) => fiber.state).join(',')}`)
}

async function directory() {
  return mkdtemp(join(tmpdir(), 'mini-loop-'))
}

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function assistant(content, calls) {
  return { role: 'assistant', content: content ?? null, ...(calls?.length ? { tool_calls: calls } : {}) }
}

function replacePlugin(name, plugin) {
  return (options) => composition(options).map((entry) => entry.name === name ? { name, plugin } : entry)
}

function readTool(execute) {
  return {
    inject: ['tools'],
    apply(ctx) {
      ctx.effect(() => ctx.tools.register({
        name: 'read',
        description: 'Read.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        execute,
      }))
    },
  }
}

async function saved(app) {
  const text = await readFile(app.sessionPath, 'utf8')
  return { text, events: text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [] }
}

test('prompt contributions stay ordered and leave with the plugin', async () => {
  const ctx = new Context()
  const prompt = ctx.plugin(Prompt)
  const plugin = {
    inject: ['prompt'],
    apply(inner) {
      inner.effect(() => inner.prompt.contribute({ order: 20, instructions: 'later' }))
      inner.effect(() => inner.prompt.contribute({ order: 10, instructions: 'earlier', context: () => ({ n: 1 }) }))
    },
  }
  const fiber = ctx.plugin(plugin)
  try {
    await ready([prompt, fiber])
    assert.deepEqual(ctx.prompt.snapshot().instructions, ['earlier', 'later'])
    assert.deepEqual(ctx.prompt.snapshot().context, [{ n: 1 }])
    await fiber.dispose()
    assert.deepEqual(ctx.prompt.snapshot(), { instructions: [], context: [] })
  } finally {
    await fiber.dispose()
    await prompt.dispose()
  }
})

test('records the exact provider request before dispatch', async () => {
  const dir = await directory()
  let app
  let extra
  const provider = fakeProvider([
    async (body) => {
      const { events } = await saved(app)
      const recorded = events.find((event) => event.type === 'model.request')
      assert.equal(recorded.provider, 'fake')
      assert.deepEqual(recorded.body, body)
      assert.equal(body.instructions[0].includes('coding assistant'), true)
      assert.equal(body.instructions[1], 'Extra rule')
      assert.equal(body.context[0].workspace, dir)
      assert.equal(body.context[0].sandbox, false)
      assert.match(body.context[0].permissions, /approval/)
      assert.equal(body.messages[0].content, 'Hello')
      assert.equal(body.tools.find((tool) => tool.function.name === 'read').function.parameters.required[0], 'path')
      assert.equal(JSON.stringify(recorded).includes('sk-secret'), false)
      return assistant('ok')
    },
    async (body) => {
      assert.equal(body.instructions.some((text) => text === 'Extra rule'), false)
      assert.equal(body.context[0].workspace, dir)
      const { events } = await saved(app)
      assert.deepEqual(events.filter((event) => event.type === 'model.request').at(-1).body, body)
      return assistant('still ok')
    },
  ])
  app = await boot({ workspace: dir, provider, model: { key: 'sk-secret' } })
  try {
    extra = app.ctx.prompt.contribute({ order: 5, instructions: 'Extra rule' })
    await app.ctx.agent.turn('Hello')
    extra()
    extra = null
    await app.ctx.agent.turn('Again')
    assert.equal((await saved(app)).text.includes('sk-secret'), false)
    assert.deepEqual(provider.sent[0].context[0].workspace, dir)
  } finally {
    extra?.()
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects invalid tool arguments before execution or approval', async () => {
  const dir = await directory()
  let executed = false
  const asks = []
  const provider = fakeProvider([
    assistant(null, [
      { id: 'bad-json', type: 'function', function: { name: 'read', arguments: '{' } },
      call('bad-type', 'read', { path: 1 }),
    ]),
    assistant('stopped'),
  ])
  const app = await boot({
    workspace: dir,
    provider,
    approve: (detail) => { asks.push(detail); return true },
    composition: replacePlugin('coding', readTool(() => { executed = true; return 'ran' })),
  })
  try {
    await app.ctx.agent.turn('Read it')
    assert.equal(executed, false)
    assert.deepEqual(asks, [])
    const { events } = await saved(app)
    assert.equal(events.some((event) => event.type === 'tool.started'), false)
    const results = events.filter((event) => event.message?.role === 'tool').map((event) => event.message.content)
    assert.match(results[0], /invalid arguments/)
    assert.match(results[1], /path must be a string/)
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('denies a rejected, missing, or unknown tool call without starting it', async () => {
  const dir = await directory()
  let executed = false
  const explode = {
    inject: ['tools'],
    apply(ctx) {
      ctx.effect(() => ctx.tools.register({
        name: 'explode',
        description: 'Do not run.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute() { executed = true; return 'boom' },
      }))
    },
  }
  const cases = [
    ['denied', () => false, 'denied'],
    ['missing', undefined, 'approval unavailable'],
    ['vague', () => 'yes', 'approval unavailable'],
  ]
  try {
    for (const [name, approve, reason] of cases) {
      const workspace = join(dir, name)
      await rm(workspace, { recursive: true, force: true })
      const nested = await mkdtemp(join(dir, `${name}-`))
      const provider = fakeProvider([
        assistant(null, [call('w1', 'write', { path: 'marker.txt', content: 'nope' })]),
        assistant('stopped'),
      ])
      const app = await boot({ workspace: nested, provider, approve })
      try {
        await app.ctx.agent.turn('Write it')
        await assert.rejects(access(join(nested, 'marker.txt')))
        const { events } = await saved(app)
        assert.equal(events.some((event) => event.type === 'tool.started'), false)
        const decision = events.find((event) => event.type === 'permission.decided')
        assert.equal(decision.decision, 'deny')
        assert.equal(decision.reason, reason)
        assert.equal(decision.workspace, nested)
        assert.deepEqual(decision.arguments, { path: 'marker.txt', content: 'nope' })
      } finally { await app.dispose() }
    }
    const nested = await mkdtemp(join(dir, 'unknown-'))
    const provider = fakeProvider([
      assistant(null, [call('e1', 'explode', {})]),
      assistant('stopped'),
    ])
    const app = await boot({
      workspace: nested,
      provider,
      approve: () => true,
      composition: (options) => [...composition(options), { name: 'explode', plugin: explode }],
    })
    try {
      await app.ctx.agent.turn('Explode')
      assert.equal(executed, false)
      const { events } = await saved(app)
      assert.equal(events.some((event) => event.type === 'tool.started'), false)
      const decision = events.find((event) => event.type === 'permission.decided')
      assert.equal(decision.reason, 'unknown tool')
      assert.equal(decision.workspace, nested)
    } finally { await app.dispose() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a failed tool-start checkpoint does not run the tool or invent a result', async () => {
  const dir = await directory()
  let executed = false
  const provider = fakeProvider([
    assistant(null, [call('read-1', 'read', { path: 'a.txt' })]),
  ])
  const app = await boot({
    workspace: dir,
    provider,
    composition: replacePlugin('coding', readTool(() => { executed = true; return 'should-not-run' })),
  })
  try {
    const session = app.ctx.session
    session.config.write = async (line) => {
      const event = JSON.parse(line)
      if (event.type === 'tool.started') throw new Error('disk full')
      const buffer = Buffer.from(line)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesWritten } = await session.handle.write(buffer.subarray(offset))
        if (!bytesWritten) throw new Error('incomplete log write')
        offset += bytesWritten
      }
    }
    await assert.rejects(app.ctx.agent.turn('Read it'), /disk full/)
    assert.equal(executed, false)
    const { text } = await saved(app)
    assert.equal(text.includes('tool.started'), false)
    assert.equal(text.includes('tool.finished'), false)
    assert.equal(text.includes('should-not-run'), false)
    assert.equal(text.includes('"role":"tool"'), false)
    let later = false
    await assert.rejects(app.ctx.checkpoint.guard({ type: 'tool.started', callId: 'later', name: 'read' }, async () => { later = true }), /blocked/)
    assert.equal(later, false)
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('checkpoints each tool start before its body and runs calls in order', async () => {
  const dir = await directory()
  const order = []
  let sessionPath
  const provider = fakeProvider([
    assistant(null, [call('read-a', 'read', { path: 'a' }), call('read-b', 'read', { path: 'b' })]),
    assistant('done'),
  ])
  const app = await boot({
    workspace: dir,
    provider,
    composition: replacePlugin('coding', readTool(async (args) => {
      const events = (await readFile(sessionPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      order.push({
        path: args.path,
        started: events.filter((event) => event.type === 'tool.started').map((event) => event.callId),
        workspaces: events.filter((event) => event.type === 'tool.started').map((event) => event.workspace),
        finished: events.filter((event) => event.type === 'tool.finished').map((event) => event.callId),
      })
      return args.path
    })),
  })
  sessionPath = app.sessionPath
  try {
    await app.ctx.agent.turn('Read both')
    assert.deepEqual(order, [
      { path: 'a', started: ['read-a'], workspaces: [dir], finished: [] },
      { path: 'b', started: ['read-a', 'read-b'], workspaces: [dir, dir], finished: ['read-a'] },
    ])
    const { events } = await saved(app)
    const results = events.filter((event) => event.message?.role === 'tool').map((event) => event.message.content)
    assert.deepEqual(results, ['a', 'b'])
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('rejects a second turn while one is running', async () => {
  const dir = await directory()
  let release
  let entered
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  const provider = fakeProvider([
    assistant(null, [call('read-1', 'read', { path: 'a' })]),
    assistant('done'),
    assistant('next'),
  ])
  const app = await boot({
    workspace: dir,
    provider,
    composition: replacePlugin('coding', readTool(async () => {
      entered()
      await gate
      return 'first'
    })),
  })
  try {
    const first = app.ctx.agent.turn('First')
    await started
    await assert.rejects(async () => app.ctx.agent.turn('Second'), (error) => {
      assert.equal(error.code, 'BUSY')
      assert.match(error.message, /busy/)
      return true
    })
    assert.equal((await saved(app)).text.includes('Second'), false)
    release()
    await first
    assert.equal(app.ctx.agent.busy, false)
    await app.ctx.agent.turn('Third')
    assert.equal((await saved(app)).text.includes('Third'), true)
    assert.equal((await saved(app)).events.find((event) => event.type === 'tool.finished').result, 'first')
  } finally {
    release()
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('uses the boot workspace for paths and shell cwd without sandboxing an approved command', async () => {
  const dir = await directory()
  const outside = await directory()
  const outsideFile = join(outside, 'secret.txt')
  await writeFile(join(dir, 'note.txt'), 'from-workspace')
  await writeFile(join(dir, 'edit.txt'), 'alpha beta')
  await writeFile(outsideFile, 'secret-bytes')
  assert.notEqual(process.cwd(), dir)
  const asks = []
  const command = `pwd; cat '${outsideFile}'`
  const provider = fakeProvider([
    assistant(null, [
      call('read-1', 'read', { path: 'note.txt' }),
      call('write-1', 'write', { path: 'out.txt', content: 'written' }),
      call('edit-1', 'edit', { path: 'edit.txt', old_text: 'beta', new_text: 'gamma' }),
      call('shell-1', 'shell', { command }),
    ]),
    assistant('done'),
  ])
  const app = await boot({
    workspace: dir,
    provider,
    approve(detail) { asks.push(structuredClone(detail)); return true },
  })
  try {
    await app.ctx.agent.turn('Work in the workspace')
    assert.deepEqual(asks.map((detail) => detail.name), ['write', 'edit', 'shell'])
    for (const detail of asks) assert.equal(detail.workspace, dir)
    assert.deepEqual(asks[0].arguments, { path: 'out.txt', content: 'written' })
    assert.deepEqual(asks[1].arguments, { path: 'edit.txt', old_text: 'beta', new_text: 'gamma' })
    assert.deepEqual(asks[2].arguments, { command })
    assert.equal(await readFile(join(dir, 'note.txt'), 'utf8'), 'from-workspace')
    assert.equal(await readFile(join(dir, 'out.txt'), 'utf8'), 'written')
    assert.equal(await readFile(join(dir, 'edit.txt'), 'utf8'), 'alpha gamma')
    await assert.rejects(access(join(process.cwd(), 'out.txt')))
    const { events } = await saved(app)
    assert.equal(events.find((event) => event.message?.tool_call_id === 'read-1').message.content, 'from-workspace')
    const shell = events.find((event) => event.message?.tool_call_id === 'shell-1').message.content
    const [pwd, secret] = shell.split('\n')
    assert.equal(pwd, dir)
    assert.equal(secret, 'secret-bytes')
    const decisions = events.filter((event) => event.type === 'permission.decided')
    assert.equal(decisions.every((event) => event.workspace === dir), true)
    assert.equal(events.find((event) => event.type === 'model.request').body.context[0].workspace, dir)
    assert.equal(events.find((event) => event.type === 'model.request').body.context[0].sandbox, false)
    const readDone = events.find((event) => event.type === 'tool.finished' && event.callId === 'read-1')
    const writeStarted = events.find((event) => event.type === 'tool.started' && event.callId === 'write-1')
    assert.ok(readDone.seq < writeStarted.seq)
  } finally {
    await app.dispose()
    await rm(join(process.cwd(), 'out.txt'), { force: true })
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('disposal drains a blocked tool without inventing its result', async () => {
  const dir = await directory()
  let release = () => {}
  let entered
  const gate = new Promise((resolve) => { release = () => resolve() })
  const started = new Promise((resolve) => { entered = resolve })
  const provider = fakeProvider([
    assistant(null, [call('read-1', 'read', { path: 'a' })]),
    assistant('done'),
  ])
  const app = await boot({
    workspace: dir,
    provider,
    composition: replacePlugin('coding', readTool(async () => {
      entered()
      await gate
      return 'from-tool'
    })),
  })
  const agent = app.ctx.agent
  try {
    const turn = agent.turn('Read it')
    await started
    const disposing = app.dispose()
    await tick()
    assert.equal(app.ctx.session.writable, true)
    assert.equal(typeof app.ctx.checkpoint.guard, 'function')
    assert.equal(app.ctx.tools.schemas().length, 1)
    const mid = await saved(app)
    assert.equal(mid.events.some((event) => event.type === 'tool.started' && event.callId === 'read-1'), true)
    assert.equal(mid.events.some((event) => event.type === 'tool.finished'), false)
    await assert.rejects(acquireWriter(lockPathFor(app.sessionPath)), (error) => error.code === 'SESSION_LOCKED')
    await assert.rejects(async () => agent.turn('other'), (error) => {
      assert.equal(error.code, 'BUSY')
      assert.match(error.message, /shutting down/)
      return true
    })
    release()
    await turn
    await disposing
    const { events, text } = await saved(app)
    assert.equal(events.find((event) => event.type === 'tool.finished').result, 'from-tool')
    assert.equal(text.includes('cancelled'), false)
    assert.deepEqual(unknownOutcomes(events), [])
    const lock = await acquireWriter(lockPathFor(app.sessionPath))
    lock.release()
    const again = await boot({ workspace: dir, provider: fakeProvider([]), approve: () => true })
    try { assert.equal(again.ctx.session.writable, true) }
    finally { await again.dispose() }
  } finally {
    release()
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('disposal cancels a pending approval without running the tool or granting it', async () => {
  const dir = await directory()
  const during = {}
  let detail
  let sawAsk
  const asked = new Promise((resolve) => { sawAsk = resolve })
  const provider = fakeProvider([
    assistant(null, [
      call('w1', 'write', { path: 'marker-a.txt', content: 'nope' }),
      call('w2', 'write', { path: 'marker-b.txt', content: 'nope' }),
    ]),
  ])
  const app = await boot({
    workspace: dir,
    provider,
    approve(value, signal) {
      detail = structuredClone(value)
      signal.addEventListener('abort', () => {
        during.writable = app.ctx.session.writable
        during.tools = app.ctx.tools.schemas().length
        during.guard = typeof app.ctx.checkpoint.guard
      }, { once: true })
      sawAsk()
      return new Promise(() => {})
    },
  })
  const session = app.ctx.session
  try {
    const turn = app.ctx.agent.turn('Write both')
    await asked
    assert.equal(detail.workspace, dir)
    assert.deepEqual(detail.arguments, { path: 'marker-a.txt', content: 'nope' })
    const disposing = app.dispose()
    await turn
    await disposing
    assert.equal(during.writable, true)
    assert.ok(during.tools >= 4)
    assert.equal(during.guard, 'function')
    await assert.rejects(access(join(dir, 'marker-a.txt')))
    await assert.rejects(access(join(dir, 'marker-b.txt')))
    const { events } = await saved(app)
    assert.equal(events.some((event) => event.type === 'tool.started'), false)
    assert.equal(events.some((event) => event.type === 'tool.finished'), false)
    const decisions = events.filter((event) => event.type === 'permission.decided')
    assert.deepEqual(decisions.map((event) => event.callId), ['w1', 'w2'])
    assert.equal(decisions.every((event) => event.decision === 'deny' && event.reason === 'approval unavailable' && event.workspace === dir), true)
    assert.deepEqual(unknownOutcomes(session.events), [])
    const lock = await acquireWriter(lockPathFor(app.sessionPath))
    lock.release()
    const again = await boot({ workspace: dir, provider: fakeProvider([]), approve: () => true })
    try {
      assert.equal(again.ctx.session.writable, true)
      assert.equal(again.ctx.session.events.some((event) => event.type === 'tool.started'), false)
    } finally { await again.dispose() }
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('the assistant message is only the text committed in stream deltas', async () => {
  const dir = await directory()
  let tick = 0
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
  const provider = fakeProvider([{ stream: [
    { text: 'saw ' },
    { reasoning: 'note' },
    { text: 'a' },
    { finish: 'stop' },
  ] }])
  const app = await boot({ workspace: dir, provider, clock })
  try {
    await app.ctx.agent.turn('Hi')
    const { events } = await saved(app)
    const request = events.find((event) => event.type === 'model.request')
    const started = events.find((event) => event.type === 'stream.started')
    const deltas = events.filter((event) => event.type === 'stream.delta')
    const ended = events.find((event) => event.type === 'stream.ended')
    const message = events.find((event) => event.seq === ended.seq + 1)
    assert.ok(request.seq < started.seq && started.seq < deltas[0].seq && deltas.at(-1).seq < ended.seq)
    assert.ok(request.time < deltas[0].time && deltas[0].time < deltas.at(-1).time && deltas.at(-1).time <= ended.time)
    const observed = observeStream(events, ended.stream)
    assert.equal(observed.text, 'saw a')
    assert.equal(observed.reasoning, 'note')
    assert.equal(message.message.content, 'saw a')
    assert.equal(message.message.reasoning_content, 'note')
    assert.equal(events.filter((event) => event.message?.role === 'assistant').length, 1)
    assert.equal(app.ctx.session.messages.at(-1).content, 'saw a')
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('a failed stream checkpoint does not invent the uncommitted tail', async () => {
  const dir = await directory()
  const provider = fakeProvider([{ stream: [
    { text: 'Hel' },
    { text: 'lo!' },
    { finish: 'stop' },
  ] }])
  const app = await boot({ workspace: dir, provider })
  try {
    const session = app.ctx.session
    let deltas = 0
    session.config.write = async (line) => {
      const event = JSON.parse(line)
      if (event.type === 'stream.delta' && ++deltas === 2) throw new Error('disk full')
      const buffer = Buffer.from(line)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesWritten } = await session.handle.write(buffer.subarray(offset))
        if (!bytesWritten) throw new Error('incomplete log write')
        offset += bytesWritten
      }
    }
    await assert.rejects(app.ctx.agent.turn('Hi'), /disk full/)
    const { text } = await saved(app)
    assert.equal(text.includes('Hel'), true)
    assert.equal(text.includes('lo!'), false)
    assert.equal(text.includes('stream.ended'), false)
    assert.equal(text.includes('"role":"assistant"'), false)
    await assert.rejects(app.ctx.checkpoint.commit({ type: 'note' }), /blocked/)
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('a dropped stream leaves the observed prefix and stays read-only', async () => {
  const dir = await directory()
  const provider = {
    inject: ['model'],
    apply(ctx) {
      ctx.effect(() => ctx.model.register({
        name: 'fake',
        prepare: () => ({ model: 'fake' }),
        async *dispatch() {
          yield { start: true }
          yield { text: 'Hel' }
          throw new Error('socket closed')
        },
      }))
    },
  }
  const app = await boot({ workspace: dir, provider })
  const sessionPath = app.sessionPath
  try {
    await assert.rejects(app.ctx.agent.turn('Hi'), /socket closed/)
    const { events, text } = await saved(app)
    assert.equal(events.some((event) => event.text === 'Hel'), true)
    assert.equal(text.includes('Hello'), false)
    assert.equal(events.some((event) => event.type === 'stream.ended'), false)
    assert.equal(events.some((event) => event.message?.role === 'assistant'), false)
    assert.match(app.ctx.session.readonlyReason, /unknown stream outcome/)
  } finally { await app.dispose() }
  const again = await boot({ workspace: dir, session: sessionPath, provider: fakeProvider([]) })
  try {
    assert.equal(again.ctx.session.writable, false)
    assert.equal(again.ctx.session.messages.some((message) => message.role === 'assistant'), false)
    assert.match(again.ctx.session.readonlyReason, /unknown stream outcome/)
  } finally { await again.dispose(); await rm(dir, { recursive: true, force: true }) }
})
