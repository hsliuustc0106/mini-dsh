import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Agent } from '../src/agent.js'
import { coding } from '../src/coding.js'
import { Session, Tools } from '../src/services.js'

const tick = () => new Promise(setImmediate)

test('Cordis removes tool effects and reactivates consumers when dependencies return', async () => {
  const ctx = new Context()
  const codingFiber = ctx.plugin(coding)
  const first = ctx.plugin(Tools)
  await tick()
  assert.equal(ctx.tools.schemas().length, 4)
  await first.dispose()
  assert.equal(ctx.tools, undefined)
  const second = ctx.plugin(Tools)
  await tick()
  assert.equal(ctx.tools.schemas().length, 4)
  await codingFiber.dispose()
  assert.equal(ctx.tools.schemas().length, 0)
  await second.dispose()
})

test('agent records a tool call and replays the resulting history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-agent-'))
  const path = join(dir, 'session.jsonl'), file = join(dir, 'example.txt')
  await writeFile(file, 'hello')
  const seen = []
  class FakeModel extends Service {
    constructor(ctx) { super(ctx, 'model') }
    async complete(messages) {
      seen.push(structuredClone(messages))
      return seen.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }] }
        : { role: 'assistant', content: 'done' }
    }
  }
  const ctx = new Context()
  const fibers = [ctx.plugin(Agent), ctx.plugin(coding), ctx.plugin(Tools), ctx.plugin(Session, { path }), ctx.plugin(FakeModel)]
  try {
    await tick()
    await ctx.session.load()
    await ctx.agent.turn('Read the file')
    assert.equal(seen[1].at(-1).content, 'hello')
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(lines.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'])
    ctx.session.messages = []
    await ctx.session.load()
    assert.deepEqual(ctx.session.messages, lines)
  } finally {
    await Promise.all(fibers.map((fiber) => fiber.dispose()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('refuses to resume an interrupted tool call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-agent-')), path = join(dir, 'session.jsonl')
  await writeFile(path, JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'pending' }] }) + '\n')
  const ctx = new Context(), fiber = ctx.plugin(Session, { path })
  try { await tick(); await assert.rejects(ctx.session.load(), /unresolved tool calls/) }
  finally { await fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('model adapter sends the conversation and tool schemas over HTTP', async () => {
  const { createServer } = await import('node:http')
  const { Model } = await import('../src/services.js')
  let requestBody, authorization
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization
    let body = ''
    for await (const chunk of request) body += chunk
    requestBody = JSON.parse(body)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const ctx = new Context()
  const fiber = ctx.plugin(Model, { key: 'test-key', baseURL: `http://127.0.0.1:${server.address().port}`, model: 'test-model' })
  try {
    await tick()
    const result = await ctx.model.complete([{ role: 'user', content: 'hi' }], [{ type: 'function', function: { name: 'read' } }])
    assert.equal(result.content, 'hello')
    assert.equal(authorization, 'Bearer test-key')
    assert.equal(requestBody.model, 'test-model')
    assert.equal(requestBody.tools[0].function.name, 'read')
  } finally { await fiber.dispose(); await new Promise((resolve) => server.close(resolve)) }
})
