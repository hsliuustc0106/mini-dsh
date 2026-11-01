import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '../src/boot.js'
import { deepseekProvider, providerForConfig, readApiKey } from '../src/provider.js'
import { Model } from '../src/services.js'

const root = fileURLToPath(new URL('..', import.meta.url))
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
  return mkdtemp(join(tmpdir(), 'mini-deepseek-'))
}

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function assistant(content, calls) {
  return { role: 'assistant', content: content ?? null, ...(calls?.length ? { tool_calls: calls } : {}) }
}

function completion(message) {
  return {
    id: 'cmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'deepseek-flash',
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  }
}

function mockFetch(responses) {
  const calls = []
  const queue = [...responses]
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const next = queue.shift()
    if (typeof next !== 'function') throw new Error('unexpected DeepSeek request')
    return next(url, init)
  }
  return { calls, fetchImpl }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

async function saved(app) {
  const text = await readFile(app.sessionPath, 'utf8')
  return { text, events: text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [] }
}

test('prepared replies stay on the fake provider when a key is present', async () => {
  const plugin = providerForConfig({ replies: [assistant('ok')], apiKey: 'sk-secret' })
  const ctx = new Context()
  const model = ctx.plugin(Model)
  const fiber = ctx.plugin(plugin)
  try {
    await ready([model, fiber])
    const prepared = ctx.model.prepare({
      instructions: ['Stay'], context: [], messages: [{ role: 'user', content: 'Hi' }], tools: [],
    })
    assert.equal(prepared.provider, 'fake')
    assert.equal((await prepared.dispatch()).content, 'ok')
    assert.equal(JSON.stringify(plugin.sent).includes('sk-secret'), false)
    await assert.rejects(async () => prepared.dispatch(), /already used/)
  } finally {
    await fiber.dispose()
    await model.dispose()
  }
})

test('no credential selects an empty fake provider', () => {
  const plugin = providerForConfig({ apiKey: '   ' })
  assert.equal(Array.isArray(plugin.sent), true)
  assert.throws(() => deepseekProvider({}), /DEEPSEEK_API_KEY is required/)
  assert.throws(() => deepseekProvider({ apiKey: 'sk-secret', toolChoice: 'read;rm' }), /tool name/)
})

test('records the chat-completions body before posting it and keeps the key in the header', async () => {
  const dir = await directory()
  await writeFile(join(dir, 'note.txt'), 'note')
  let app
  const { calls, fetchImpl } = mockFetch([
    async () => {
      const { events, text } = await saved(app)
      const recorded = events.find((event) => event.type === 'model.request')
      assert.equal(recorded.provider, 'deepseek')
      assert.equal(JSON.stringify(recorded.body), calls[0].init.body)
      assert.equal(text.includes('sk-secret'), false)
      assert.equal(text.includes('Authorization'), false)
      return jsonResponse(completion(assistant(null, [call('read-1', 'read', { path: 'note.txt' })])))
    },
    async () => {
      const { events } = await saved(app)
      const recorded = events.filter((event) => event.type === 'model.request').at(-1)
      assert.equal(JSON.stringify(recorded.body), calls[1].init.body)
      assert.equal(recorded.body.tool_choice, undefined)
      assert.equal(recorded.body.messages.at(-1).content, 'note')
      return jsonResponse(completion(assistant('saw note')))
    },
  ])
  const asks = []
  app = await boot({
    workspace: dir,
    provider: deepseekProvider({
      apiKey: 'sk-secret',
      baseUrl: 'https://example.test/v1/',
      model: 'deepseek-flash',
      toolChoice: 'read',
      fetch: fetchImpl,
    }),
    approve: (detail) => { asks.push(detail); return true },
  })
  try {
    await app.ctx.agent.turn('Read note.txt')
    assert.equal(asks.length, 0)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, 'https://example.test/v1/chat/completions')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-secret')
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.model, 'deepseek-flash')
    assert.equal(body.stream, false)
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.equal(body.tool_choice.function.name, 'read')
    assert.equal(body.messages[0].role, 'system')
    assert.match(body.messages[0].content, /coding assistant/)
    assert.match(body.messages[0].content, /"sandbox":false/)
    assert.equal(body.messages[1].role, 'user')
    assert.equal(body.messages[1].content, 'Read note.txt')
    assert.equal(body.tools.map((tool) => tool.function.name).join(), 'read,write,edit,shell')
    assert.equal(JSON.stringify(body).includes('sk-secret'), false)
    const { events, text } = await saved(app)
    assert.equal(text.includes('sk-secret'), false)
    const decision = events.find((event) => event.type === 'permission.decided')
    assert.equal(decision.decision, 'allow')
    assert.equal(decision.name, 'read')
    assert.equal(decision.workspace, dir)
    assert.deepEqual(decision.arguments, { path: 'note.txt' })
    const started = events.find((event) => event.type === 'tool.started')
    const finished = events.find((event) => event.type === 'tool.finished')
    assert.equal(started.seq < finished.seq, true)
    assert.equal(finished.result, 'note')
    assert.equal(events.at(-1).message.content, 'saw note')
  } finally {
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a deepseek write still asks and a denial does not start the tool', async () => {
  const dir = await directory()
  const asks = []
  const { calls, fetchImpl } = mockFetch([
    async () => jsonResponse(completion(assistant(null, [call('w1', 'write', { path: 'marker.txt', content: 'nope' })]))),
    async () => jsonResponse(completion(assistant('stopped'))),
  ])
  const app = await boot({
    workspace: dir,
    provider: deepseekProvider({ apiKey: 'sk-secret', baseUrl: 'https://example.test', fetch: fetchImpl }),
    approve: (detail) => { asks.push(detail); return false },
  })
  try {
    await app.ctx.agent.turn('Write it')
    assert.equal(asks.length, 1)
    assert.equal(asks[0].name, 'write')
    assert.equal(asks[0].workspace, dir)
    const { events, text } = await saved(app)
    assert.equal(text.includes('sk-secret'), false)
    const body = events.find((event) => event.type === 'model.request').body
    assert.equal(body.tool_choice, undefined)
    assert.match(body.messages[0].content, /"sandbox":false/)
    const decision = events.find((event) => event.type === 'permission.decided')
    assert.equal(decision.decision, 'deny')
    assert.equal(decision.reason, 'denied')
    assert.equal(events.some((event) => event.type === 'tool.started'), false)
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-secret')
  } finally {
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an error response redacts the key and leaves the recorded request', async () => {
  const dir = await directory()
  const { fetchImpl } = mockFetch([
    async () => jsonResponse({ error: { message: 'bad key sk-secret' } }, 401),
  ])
  const app = await boot({
    workspace: dir,
    provider: deepseekProvider({ apiKey: 'sk-secret', baseUrl: 'https://example.test', fetch: fetchImpl }),
  })
  try {
    await assert.rejects(app.ctx.agent.turn('Hello'), (error) => {
      assert.match(error.message, /401/)
      assert.equal(error.message.includes('sk-secret'), false)
      assert.match(error.message, /\[redacted\]/)
      return true
    })
    const { events, text } = await saved(app)
    assert.equal(events.some((event) => event.type === 'model.request'), true)
    assert.equal(events.some((event) => event.message?.role === 'assistant'), false)
    assert.equal(text.includes('sk-secret'), false)
  } finally {
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('disposing the deepseek plugin removes its registration', async () => {
  const ctx = new Context()
  const model = ctx.plugin(Model)
  const fiber = ctx.plugin(deepseekProvider({ apiKey: 'sk-secret', fetch: async () => jsonResponse(completion(assistant('x'))) }))
  try {
    await ready([model, fiber])
    assert.equal(ctx.model.prepare({ instructions: [], context: [], messages: [], tools: [] }).provider, 'deepseek')
    await fiber.dispose()
    assert.throws(() => ctx.model.prepare({ instructions: [], context: [], messages: [], tools: [] }), /single model provider/)
  } finally {
    await model.dispose()
  }
})

test('readApiKey prefers the environment and otherwise one file line', async () => {
  const dir = await directory()
  const file = join(dir, 'key')
  await writeFile(file, '  from-file  \n')
  try {
    assert.equal(await readApiKey({ DEEPSEEK_API_KEY: '  from-env  ', DEEPSEEK_API_KEY_FILE: file }), 'from-env')
    assert.equal(await readApiKey({ DEEPSEEK_API_KEY: '   ', DEEPSEEK_API_KEY_FILE: file }), 'from-file')
    assert.equal(await readApiKey({}), undefined)
    await writeFile(file, '\n')
    await assert.rejects(readApiKey({ DEEPSEEK_API_KEY_FILE: file }), /empty/)
    await assert.rejects(readApiKey({ DEEPSEEK_API_KEY_FILE: join(dir, 'missing') }), /ENOENT/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the live smoke skips when no key is configured', async () => {
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEEK_API_KEY_FILE
  const child = spawn(process.execPath, ['src/smoke.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('smoke skip hung')) }, 5000)
    child.on('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(status, 0)
  assert.equal(stdout, '')
  assert.match(stderr, /DeepSeek smoke skipped: set DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_FILE/)
})
