import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'
import { Tools } from '../src/services.js'

// DSH-style module: named exports, direct registration and canonical output.
const pluginSource = `
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register({
    name: 'dsh_greet', description: 'Greet someone.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: 'rendered: ' + value }] },
    async execute({ name }) { return 'Hello, ' + name + '!' },
  })
}
`

async function workspace(t, policies) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-compat-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'dsh-tool.mjs'), pluginSource)
  const plugins = [{ name: 'dsh-tool', module: './dsh-tool.mjs' }]
  if (policies) plugins.push({ name: 'default-tool-permissions', config: { policies } })
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins }))
  return dir
}

function provider() {
  return fakeProvider([
    { role: 'assistant', content: null, tool_calls: [{ id: 'greet-1', type: 'function', function: { name: 'dsh_greet', arguments: '{"name":"Ada"}' } }] },
    { role: 'assistant', content: 'done' },
  ])
}

test('loads a DSH-style tool, asks for permission and renders its text result', async (t) => {
  const dir = await workspace(t, { dsh_greet: 'ask' })
  const calls = []
  const model = provider()
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider: model, approve: (detail) => { calls.push(detail.name); return true } })
  const tools = app.ctx.tools
  try {
    assert.equal(app.report.find((entry) => entry.name === 'dsh-tool').state, 'active')
    await app.ctx.agent.turn('Greet Ada')
    assert.deepEqual(calls, ['dsh_greet'])
    assert.equal(app.ctx.session.events.find((event) => event.type === 'tool.finished').result, 'rendered: Hello, Ada!')
    assert.equal(model.sent[1].messages.at(-1).content, 'rendered: Hello, Ada!')
  } finally { await app.dispose() }
  assert.equal(tools.items.has('dsh_greet'), false)
})

test('a DSH-style tool without an explicit policy remains denied', async (t) => {
  const dir = await workspace(t)
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider: provider() })
  try {
    await app.ctx.agent.turn('Greet Ada')
    const decision = app.ctx.session.events.find((event) => event.type === 'permission.decided')
    assert.equal(decision.decision, 'deny')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started'), false)
  } finally { await app.dispose() }
})

test('missing DSH services are reported instead of starting a partial plugin', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'dsh-tool.mjs'), "export const inject = ['systemPrompt']; export function apply() {}\n")
  await assert.rejects(boot({ workspace: dir, pluginConfig: 'plugins.json', provider: provider() }), /waiting for systemPrompt/)
})

test('invalid configured tool policies fail at startup', async (t) => {
  const dir = await workspace(t, { dsh_greet: 'sometimes' })
  await assert.rejects(boot({ workspace: dir, pluginConfig: 'plugins.json', provider: provider() }), /invalid policy for dsh_greet/)
})

test('configured policies can override a built-in tool policy', async (t) => {
  const dir = await workspace(t, { read: 'deny' })
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider: provider() })
  try {
    const decision = await app.ctx.permissions.decide({ callId: 'read-1', name: 'read', arguments: { path: 'x' } })
    assert.equal(decision.decision, 'deny')
  } finally { await app.dispose() }
})

test('direct tool registrations are removed when their plugin unloads', async () => {
  const ctx = new Context()
  const tools = ctx.plugin(Tools)
  const plugin = ctx.plugin({ inject: ['tools'], apply(inner) {
    inner.tools.register({ name: 'temporary', description: 'Temporary tool', parameters: { type: 'object' }, execute: () => 'ok' })
  } })
  await Promise.all([tools.await(), plugin.await()])
  assert.equal(ctx.tools.items.has('temporary'), true)
  await plugin.dispose()
  assert.equal(ctx.tools.items.has('temporary'), false)
  await tools.dispose()
})

test('unsupported DSH output schemas are rejected rather than silently mishandled', async () => {
  const ctx = new Context(), tools = ctx.plugin(Tools)
  await tools.await()
  assert.throws(() => ctx.tools.register({
    name: 'unknown_keyword', description: 'Unsupported output', parameters: { type: 'object' }, execute: () => ({}),
    output: { schema: { type: 'object', unknownKeyword: true }, render: () => [{ type: 'text', text: 'value' }] },
  }), /unsupported DSH output schema/)
  assert.throws(() => ctx.tools.register({
    name: 'async_schema', description: 'Unsupported async schema', parameters: { type: 'object' }, execute: () => 'value',
    output: { schema: { $async: true, type: 'string' }, render: () => [{ type: 'text', text: 'value' }] },
  }), /asynchronous DSH output schemas are not supported/)
  await tools.dispose()
})

test('a DSH tool can validate and render a structured object result', async (t) => {
  const dir = await workspace(t, { object_data: 'ask' })
  await writeFile(join(dir, 'dsh-tool.mjs'), `
    export const inject = ['tools']
    export function apply(ctx) {
      ctx.tools.register({
        name: 'object_data', description: 'Return structured data.', parameters: { type: 'object', properties: {} },
        output: {
          schema: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' }, values: { type: 'array', items: { oneOf: [{ type: 'boolean' }, { type: 'null' }] } } }, required: ['name', 'count', 'values'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: () => ({ name: 'Ada', count: 2, values: [true, null] }),
      })
    }
  `)
  const model = fakeProvider([
    { role: 'assistant', content: null, tool_calls: [{ id: 'object-1', type: 'function', function: { name: 'object_data', arguments: '{}' } }] },
    { role: 'assistant', content: 'done' },
  ])
  const approvals = []
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider: model, approve: (detail) => { approvals.push(detail.name); return true } })
  try {
    await app.ctx.agent.turn('Return structured data')
    assert.deepEqual(approvals, ['object_data'])
    assert.equal(app.ctx.session.events.find((event) => event.type === 'tool.finished').result, '{"name":"Ada","count":2,"values":[true,null]}')
    assert.equal(model.sent[1].messages.at(-1).content, '{"name":"Ada","count":2,"values":[true,null]}')
  } finally { await app.dispose() }
})

test('invalid or non-JSON DSH results are rejected before rendering', async () => {
  const ctx = new Context(), tools = ctx.plugin(Tools)
  await tools.await()
  let result = { nested: { status: 'unknown' } }, renders = 0
  ctx.tools.register({
    name: 'structured', description: 'Structured result', parameters: { type: 'object' }, execute: () => result,
    output: {
      schema: { type: 'object', properties: { nested: { type: 'object', properties: { status: { type: 'string', enum: ['ready'] } }, required: ['status'], additionalProperties: false } }, required: ['nested'], additionalProperties: false },
      render: () => { renders++; return [{ type: 'text', text: 'value' }] },
    },
  })
  await assert.rejects(ctx.tools.run('structured', {}), /output does not match schema/)
  result = { nested: { status: 'ready' }, extra: true }
  await assert.rejects(ctx.tools.run('structured', {}), /output does not match schema/)
  result = { nested: { status: 'ready' }, extra: undefined }
  await assert.rejects(ctx.tools.run('structured', {}), /expected a lossless JSON result/)
  result = { nested: { status: 'ready' }, extra: NaN }
  await assert.rejects(ctx.tools.run('structured', {}), /expected a lossless JSON result/)
  result = JSON.parse('{"nested":{"status":"ready"},"__proto__":{"extra":true}}')
  await assert.rejects(ctx.tools.run('structured', {}), /output does not match schema/)
  result = { nested: { status: 'ready' } }
  result.circular = result
  await assert.rejects(ctx.tools.run('structured', {}), /expected a lossless JSON result/)
  assert.equal(renders, 0)
  await tools.dispose()
})

test('DSH object output is detached and frozen before it reaches the renderer', async () => {
  const ctx = new Context(), tools = ctx.plugin(Tools)
  await tools.await()
  const result = Object.assign(Object.create(null), { nested: { value: 'ready' } })
  ctx.tools.register({
    name: 'snapshot', description: 'Snapshot output', parameters: { type: 'object' }, execute: () => result,
    output: {
      schema: { type: 'object', properties: { nested: { type: 'object', properties: { value: { type: 'string' } } } } },
      render: (_args, value) => {
        assert.notEqual(value, result)
        assert.notEqual(value.nested, result.nested)
        assert.equal(Object.isFrozen(value.nested), true)
        return [{ type: 'text', text: value.nested.value }]
      },
    },
  })
  assert.equal(await ctx.tools.run('snapshot', {}), 'ready')
  assert.equal(Object.isFrozen(result.nested), false)
  await tools.dispose()
})

test('an in-flight DSH call retains its output contract when the tool unloads', async () => {
  const ctx = new Context(), tools = ctx.plugin(Tools)
  await tools.await()
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const remove = ctx.tools.register({
    name: 'slow', description: 'Slow result', parameters: { type: 'object' }, execute: () => pending,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.message }] },
  })
  const result = ctx.tools.run('slow', {})
  remove()
  finish({ message: 'finished' })
  assert.equal(await result, 'finished')
  await assert.rejects(ctx.tools.run('slow', {}), /Unknown tool/)
  await tools.dispose()
})

test('DSH activation and execution extensions are not silently ignored', async () => {
  const ctx = new Context(), tools = ctx.plugin(Tools)
  await tools.await()
  const base = {
    name: 'extended', description: 'Unsupported extension', parameters: { type: 'object' }, execute: () => 'value',
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'value' }] },
  }
  assert.throws(() => ctx.tools.register(base, { when: () => false }), /registration options are not supported/)
  for (const extension of [{ projectContent() {} }, { finalizeContent() {} }, { deferLoading: true }]) {
    assert.throws(() => ctx.tools.register({ ...base, ...extension }), /DSH execution extensions are not supported/)
  }
  for (const timeoutMs of [0, -1, Infinity, 2147483648]) assert.throws(() => ctx.tools.register({ ...base, timeoutMs }), /timeoutMs/)
  await tools.dispose()
})

test('DSH timeouts signal the tool and wait for its work to settle', async () => {
  const ctx = new Context(), tools = ctx.plugin(Tools)
  await tools.await()
  let aborted, finish
  const abortSeen = new Promise((resolve) => { aborted = resolve })
  const cleanup = new Promise((resolve) => { finish = resolve })
  ctx.tools.register({
    name: 'timed', description: 'Cooperative timeout', parameters: { type: 'object' }, timeoutMs: 10,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      assert.equal(exec.name, 'timed')
      assert.equal(exec.callId, 'test-call')
      await new Promise((resolve) => exec.signal.addEventListener('abort', resolve, { once: true }))
      aborted()
      await cleanup
      return 'late success'
    },
  })
  let settled = false
  const result = ctx.tools.run('timed', {}, { callId: 'test-call' }).finally(() => { settled = true })
  await abortSeen
  assert.equal(settled, false)
  finish()
  await assert.rejects(result, /tool call timed out after 10ms/)
  await tools.dispose()
})

test('DSH text renderers must produce text blocks', async () => {
  const ctx = new Context(), tools = ctx.plugin(Tools)
  await tools.await()
  ctx.tools.register({
    name: 'image_result', description: 'Unsupported block', parameters: { type: 'object' }, execute: () => 'value',
    output: { schema: { type: 'string' }, render: () => [{ type: 'image', data: 'x' }] },
  })
  await assert.rejects(ctx.tools.run('image_result', {}), /only text output blocks/)
  await tools.dispose()
})

test('DSH tool results must match their declared string type', async () => {
  const ctx = new Context(), tools = ctx.plugin(Tools)
  await tools.await()
  ctx.tools.register({
    name: 'wrong_result', description: 'Wrong result type', parameters: { type: 'object' }, execute: () => 42,
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'value' }] },
  })
  await assert.rejects(ctx.tools.run('wrong_result', {}), /output does not match schema/)
  await tools.dispose()
})
