import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'
import { project } from '../src/trajectory.js'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(find) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const value = find()
    if (value) return value
    await delay(10)
  }
  throw new Error('Timed out waiting for web session')
}

function call(id, path, content) {
  return { id, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path, content }) } }
}

function assistant(content, calls) {
  return { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }
}

async function start(replies, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-web-'))
  if (options.sessionText) await writeFile(join(dir, '.mini-session.jsonl'), options.sessionText)
  const app = await boot({ workspace: dir, web: { port: 0 }, provider: fakeProvider(replies), ...options.boot })
  return {
    dir, app, url: app.ctx.webControl.url,
    async close() { await app.dispose(); await rm(dir, { recursive: true, force: true }) },
  }
}

async function request(url, path, { method = 'GET', headers = {}, data } = {}) {
  const response = await fetch(url + path, {
    method, headers: { ...(method === 'POST' ? { origin: url, 'content-type': 'application/json' } : {}), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  return { status: response.status, body: await response.text(), headers: response.headers }
}

function rawRequest(url, path, headers, { method = 'GET', data } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url + path, { method, headers, agent: false }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(data === undefined ? undefined : JSON.stringify(data))
  })
}

function stream(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${url}/events?after=0`, { headers, agent: false }, (res) => {
      const found = []
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        let split
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const part = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const type = part.match(/^event: (.*)$/m)?.[1]
          const raw = part.match(/^data: (.*)$/m)?.[1]
          if (type && raw) found.push({ type, data: JSON.parse(raw), id: part.match(/^id: (.*)$/m)?.[1] })
        }
      })
      resolve({
        status: res.statusCode,
        events: found,
        close() { req.destroy() },
        wait(type, predicate = () => true) { return until(() => found.find((event) => event.type === type && predicate(event.data))?.data) },
      })
    })
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error) })
    req.end()
  })
}

test('web prompt allows one exact call, denies the next, and rejects stale approvals and concurrent prompts', async () => {
  const calls = [call('first', 'hello.txt', 'hello\n'), call('second', 'no.txt', 'no')]
  const run = await start([assistant(null, calls), assistant('Done.')])
  const client = await stream(run.url)
  try {
    const { connection } = await client.wait('hello')
    assert.equal((await request(run.url, '/turn', { method: 'POST', data: { connection, input: 'Create hello.txt' } })).status, 202)
    const first = await client.wait('approval', (data) => data.pending?.arguments.path === 'hello.txt')
    const approval = first.pending
    assert.deepEqual({ name: approval.name, arguments: approval.arguments, workspace: approval.workspace }, {
      name: 'write', arguments: { path: 'hello.txt', content: 'hello\n' }, workspace: run.dir,
    })
    assert.equal((await request(run.url, '/turn', { method: 'POST', data: { connection, input: 'A second turn' } })).status, 409)
    assert.equal((await request(run.url, '/approval', { method: 'POST', data: { connection, id: 'wrong', decision: 'allow' } })).status, 409)
    assert.equal((await request(run.url, '/approval', { method: 'POST', data: { connection, id: approval.id, decision: 'allow' } })).status, 200)
    const second = (await client.wait('approval', (data) => data.pending?.arguments.path === 'no.txt')).pending
    assert.notEqual(second.id, approval.id)
    assert.equal((await request(run.url, '/approval', { method: 'POST', data: { connection, id: approval.id, decision: 'allow' } })).status, 409)
    assert.equal((await request(run.url, '/approval', { method: 'POST', data: { connection, id: second.id, decision: 'deny' } })).status, 200)
    assert.equal((await request(run.url, '/approval', { method: 'POST', data: { connection, id: second.id, decision: 'allow' } })).status, 409)
    await client.wait('session', (event) => event.type === 'message' && event.message.content === 'Done.')
    assert.equal(await readFile(join(run.dir, 'hello.txt'), 'utf8'), 'hello\n')
    await assert.rejects(access(join(run.dir, 'no.txt')))
    const saved = (await readFile(run.app.sessionPath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(saved.filter((event) => event.type === 'permission.decided').map((event) => [event.arguments.path, event.decision]), [
      ['hello.txt', 'allow'], ['no.txt', 'deny'],
    ])
    assert.deepEqual(saved.filter((event) => event.type === 'tool.started').map((event) => event.arguments.path), ['hello.txt'])
    assert.ok(client.events.some((event) => event.type === 'session' && event.data.type === 'stream.delta'))
    const timing = JSON.parse((await request(run.url, '/trajectory')).body)
    assert.equal(timing.cursor, saved.at(-1).seq)
    assert.deepEqual(timing.overview, project(saved).overview.map(({ tokens, ...span }) => span))
    assert.deepEqual(timing.overview.map((span) => span.kind), ['input', 'model', 'tool', 'model'])
  } finally { client.close(); await run.close() }
})

test('timing follows an active model stream and reports its completion', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const provider = {
    inject: ['model'],
    apply(ctx) {
      ctx.effect(() => ctx.model.register({
        name: 'slow',
        prepare: () => ({ model: 'slow' }),
        async *dispatch() {
          yield { start: true }
          yield { text: 'Hello' }
          await gate
          yield { text: ' world' }
          yield { finish: 'stop' }
        },
      }))
    },
  }
  const run = await start([], { boot: { provider } })
  const client = await stream(run.url)
  try {
    const { connection } = await client.wait('hello')
    assert.equal((await request(run.url, '/turn', { method: 'POST', data: { connection, input: 'Hello' } })).status, 202)
    await client.wait('session', (event) => event.type === 'stream.delta' && event.text === 'Hello')
    const active = JSON.parse((await request(run.url, '/trajectory')).body)
    assert.deepEqual(active.overview.map((span) => [span.kind, span.status]), [['input', 'ok'], ['model', 'open']])
    release()
    await client.wait('session', (event) => event.type === 'message' && event.message.content === 'Hello world')
    const completed = JSON.parse((await request(run.url, '/trajectory')).body)
    assert.deepEqual(completed.overview.map((span) => [span.kind, span.status]), [['input', 'ok'], ['model', 'ok']])
    assert.equal(completed.overview[1].endSeq > completed.overview[1].seq, true)
  } finally { release(); client.close(); await run.close() }
})

test('disconnect denies the pending call and reconnect follows only later session events', async () => {
  const run = await start([assistant(null, [call('write', 'lost.txt', 'no')]), assistant('Denied.')])
  const first = await stream(run.url)
  let second
  try {
    const { connection } = await first.wait('hello')
    assert.equal((await request(run.url, '/turn', { method: 'POST', data: { connection, input: 'Write a file' } })).status, 202)
    const approval = (await first.wait('approval', (data) => data.pending)).pending
    const last = Math.max(...first.events.filter((event) => event.type === 'session').map((event) => event.data.seq))
    first.close()
    await until(() => run.app.ctx.session.events.find((event) => event.type === 'permission.decided'))
    const decision = run.app.ctx.session.events.find((event) => event.type === 'permission.decided')
    assert.equal(decision.decision, 'deny')
    assert.equal(decision.reason, 'approval unavailable')
    await assert.rejects(access(join(run.dir, 'lost.txt')))
    second = await stream(run.url, { 'last-event-id': String(last) })
    const reconnected = await second.wait('hello')
    assert.notEqual(reconnected.connection, connection)
    await second.wait('session', (event) => event.seq === last + 1)
    assert.equal((await request(run.url, '/approval', { method: 'POST', data: { connection: reconnected.connection, id: approval.id, decision: 'allow' } })).status, 409)
    assert.equal(second.events.filter((event) => event.type === 'session').every((event) => event.data.seq > last), true)
  } finally { first.close(); second?.close(); await run.close() }
})

test('a disconnected turn cannot transfer its later approval to a new connection', async () => {
  let release
  let entered = false
  const gate = new Promise((resolve) => { release = resolve })
  const run = await start([
    async () => { entered = true; await gate; return assistant(null, [call('later', 'later.txt', 'no')]) },
    assistant('Stopped.'),
  ])
  const first = await stream(run.url)
  let second
  try {
    const { connection } = await first.wait('hello')
    assert.equal((await request(run.url, '/turn', { method: 'POST', data: { connection, input: 'Write later' } })).status, 202)
    await until(() => entered)
    first.close()
    await until(() => !run.app.ctx.webControl.clients.has(connection))
    second = await stream(run.url)
    await second.wait('hello')
    release()
    const decision = await second.wait('session', (event) => event.type === 'permission.decided')
    assert.equal(decision.decision, 'deny')
    assert.equal(decision.reason, 'approval unavailable')
    assert.equal(second.events.some((event) => event.type === 'approval' && event.data.pending), false)
    await assert.rejects(access(join(run.dir, 'later.txt')))
  } finally { release(); first.close(); second?.close(); await run.close() }
})

test('shutdown cancels a pending web approval without executing the tool', async () => {
  const run = await start([assistant(null, [call('pending', 'pending.txt', 'no')])])
  const client = await stream(run.url)
  try {
    const { connection } = await client.wait('hello')
    assert.equal((await request(run.url, '/turn', { method: 'POST', data: { connection, input: 'Write a file' } })).status, 202)
    await client.wait('approval', (data) => data.pending)
    await run.app.dispose()
    const saved = (await readFile(run.app.sessionPath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(saved.find((event) => event.type === 'permission.decided').decision, 'deny')
    assert.equal(saved.some((event) => event.type === 'tool.started'), false)
    await assert.rejects(access(join(run.dir, 'pending.txt')))
    await assert.rejects(fetch(run.url + '/'))
  } finally { client.close(); await run.close() }
})

test('local control rejects untrusted requests and the separate viewer is read-only', async () => {
  const run = await start([], { boot: { view: { port: 0 } } })
  const client = await stream(run.url)
  try {
    const { connection } = await client.wait('hello')
    const page = await request(run.url, '/')
    assert.equal(page.status, 200)
    assert.match(page.body, /aria-label="Session view"/)
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.equal(await rawRequest(run.url, '/', { host: 'attacker.example' }), 403)
    assert.equal(await rawRequest(run.url, '/', { host: 'localhost.attacker.example:60315' }), 403)
    assert.equal(await rawRequest(run.url, '/', { host: 'localhost:0' }), 403)
    assert.equal(await rawRequest(run.url, '/', { host: 'localhost:65536' }), 403)
    assert.equal(await rawRequest(run.url, '/', { host: 'localhost:60315' }), 200)
    const forwarded = { host: 'localhost:60315', origin: 'http://localhost:60315', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
    assert.equal(await rawRequest(run.url, '/turn', forwarded, { method: 'POST', data: { connection, input: ' ' } }), 400)
    assert.equal(await rawRequest(run.url, '/turn', { ...forwarded, origin: 'http://localhost:60316' }, { method: 'POST', data: { connection, input: 'bad' } }), 403)
    assert.equal(await rawRequest(run.url, '/turn', { ...forwarded, 'sec-fetch-site': 'same-site' }, { method: 'POST', data: { connection, input: 'bad' } }), 403)
    assert.equal((await request(run.url, '/turn', { method: 'POST', headers: { origin: 'http://attacker.example' }, data: { connection, input: 'bad' } })).status, 403)
    assert.equal((await request(run.url, '/turn', { method: 'POST', headers: { origin: 'null' }, data: { connection, input: 'bad' } })).status, 403)
    assert.equal((await request(run.url, '/turn', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, data: { connection, input: 'bad' } })).status, 403)
    assert.equal((await request(run.url, '/turn', { method: 'POST', headers: { 'content-type': 'text/plain' }, data: { connection, input: 'bad' } })).status, 415)
    assert.equal((await fetch(run.url + '/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403)
    assert.equal((await request(run.url, '/turn', { method: 'POST', data: { connection: 'unknown', input: 'bad' } })).status, 409)
    assert.equal((await request(run.url, '/turn', { method: 'POST', data: { connection, input: '   ' } })).status, 400)
    const viewer = run.app.ctx.viewer.url
    assert.equal((await request(viewer, '/turn', { method: 'POST', data: { input: 'bad' } })).status, 405)
    assert.equal((await request(viewer, '/approval', { method: 'POST', data: {} })).status, 405)
    assert.equal(run.app.ctx.session.events.length, 1)
  } finally { client.close(); await run.close() }
})

test('terminal turns keep their own approval and web status follows their completion', async () => {
  let release
  let terminalAsked = false
  const approve = () => { terminalAsked = true; return new Promise((resolve) => { release = resolve }) }
  const run = await start([assistant(null, [call('terminal', 'terminal.txt', 'ok')]), assistant('Terminal done.')], { boot: { approve } })
  const client = await stream(run.url)
  try {
    await client.wait('hello')
    const turn = run.app.ctx.agent.turn('From terminal')
    await until(() => terminalAsked)
    await client.wait('state', (state) => state.busy === true)
    assert.equal(client.events.some((event) => event.type === 'approval' && event.data.pending), false)
    release(true)
    await turn
    await client.wait('state', (state) => state.busy === false)
    assert.equal(await readFile(join(run.dir, 'terminal.txt'), 'utf8'), 'ok')
  } finally { client.close(); await run.close() }
})

test('unknown tool outcomes stay read-only and cannot accept a web turn', async () => {
  const sessionText = JSON.stringify({ seq: 1, time: '2026-01-01T00:00:00.000Z', type: 'tool.started', callId: 'lost', name: 'write', arguments: { path: 'lost.txt', content: 'no' }, workspace: '/tmp' }) + '\n'
  const run = await start([], { sessionText })
  const client = await stream(run.url)
  try {
    const hello = await client.wait('hello')
    assert.equal(hello.writable, false)
    assert.match(hello.reason, /unknown tool outcome/)
    assert.equal((await request(run.url, '/turn', { method: 'POST', data: { connection: hello.connection, input: 'Again' } })).status, 409)
    assert.equal(await readFile(run.app.sessionPath, 'utf8'), sessionText)
  } finally { client.close(); await run.close() }
})
