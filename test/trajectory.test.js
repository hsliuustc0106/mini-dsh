import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '../src/boot.js'
import { composition, viewerComposition } from '../src/composition.js'
import { observeStream, readSession } from '../src/log.js'
import { fakeProvider } from '../src/provider.js'
import { Session, Workspace } from '../src/services.js'
import { project } from '../src/trajectory.js'
import { TrajectoryViewer } from '../src/viewer.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixtureDir = join(root, 'fixtures/write-hello')
const clock = '2026-01-01T00:00:00.000Z'

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function directory() { return mkdtemp(join(tmpdir(), 'mini-view-')) }

function cleanEnv(overrides) {
  const env = { ...process.env }
  for (const name of ['MINI_WORKSPACE', 'MINI_SESSION', 'MINI_REPLIES', 'MINI_CLOCK', 'MINI_INSPECT', 'MINI_VIEW', 'MINI_VIEW_PORT', 'DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_FILE', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_TOOL_CHOICE']) {
    delete env[name]
  }
  return { ...env, DEEPSEEK_API_KEY: 'sk-secret', MINI_VIEW_PORT: '0', ...overrides }
}

function request(url, { method = 'GET', headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

function openSse(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers, agent: false }, (res) => {
      const state = { status: res.statusCode, events: [], buf: '', done: false }
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        state.buf += chunk
        let split
        while ((split = state.buf.indexOf('\n\n')) >= 0) {
          const block = state.buf.slice(0, split)
          state.buf = state.buf.slice(split + 2)
          const dataLine = block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
          if (!dataLine) continue
          state.events.push({
            event: block.match(/^event: (.*)$/m)?.[1] ?? 'message',
            id: block.match(/^id: (.*)$/m)?.[1],
            data: JSON.parse(dataLine),
          })
        }
      })
      res.on('end', () => { state.done = true })
      resolve({
        get status() { return state.status },
        get events() { return state.events },
        get done() { return state.done },
        close() { req.destroy() },
      })
    })
    req.on('error', (error) => {
      if (error.code === 'ECONNRESET') return
      reject(error)
    })
    req.end()
  })
}

async function until(read, ms = 2000) {
  const start = Date.now()
  for (;;) {
    if (read()) return
    if (Date.now() - start > ms) throw new Error(`timed out waiting for trajectory events`)
    await delay(15)
  }
}

function rowsOf(view) {
  return [...view.preamble, ...view.turns.flatMap((turn) => turn.rows)]
}

function embedded(html) {
  const match = html.match(/<script type="application\/json" id="projection">([^<]*)<\/script>/)
  assert.ok(match)
  return JSON.parse(match[1])
}

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function assistant(content, calls) {
  const message = { role: 'assistant', content: content ?? null }
  if (calls?.length) message.tool_calls = calls
  return message
}

async function ready(fibers) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await Promise.all(fibers.map((fiber) => fiber.await().catch(() => {})))
    if (fibers.every((fiber) => fiber.state === 2)) return
    await delay(0)
  }
  throw new Error(`plugins were not ready: ${fibers.map((fiber) => fiber.state).join(',')}`)
}

function startView(env) {
  const child = spawn(process.execPath, ['src/view.js'], {
    cwd: root,
    env: cleanEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk })
  child.stderr.on('data', (chunk) => { output.stderr += chunk })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return {
    output,
    async url() {
      const start = Date.now()
      while (!/http:\/\/127\.0\.0\.1:\d+/.test(output.stdout)) {
        if (child.exitCode != null || child.signalCode != null) {
          throw new Error(`view.js exited\n${output.stdout}\n${output.stderr}`)
        }
        if (Date.now() - start > 5000) throw new Error(`view.js did not print a url\n${output.stdout}\n${output.stderr}`)
        await delay(20)
      }
      return output.stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    },
    async stop() {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      const status = await exited
      clearTimeout(timer)
      return { ...status, stdout: output.stdout, stderr: output.stderr }
    },
  }
}

function startMain(env) {
  const child = spawn(process.execPath, ['src/main.js'], {
    cwd: root,
    env: cleanEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk })
  child.stderr.on('data', (chunk) => { output.stderr += chunk })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return { child, output, exited }
}

test('projects the recorded fixture into turns, timing, and inspectable records', async () => {
  const events = (await readSession(join(fixtureDir, 'session.jsonl'))).events
  const view = project(events)
  assert.equal(view.wordmark, 'mini-dsh')
  assert.equal(view.count, 19)
  assert.equal(view.cursor, 19)
  assert.deepEqual(view.unknown, [])
  assert.deepEqual(view.unknownStreams, [])
  assert.deepEqual(view.overview.map((span) => span.kind), ['input', 'model', 'tool', 'model'])
  assert.deepEqual(view.overview.map((span) => [span.seq, span.endSeq, span.status, span.durationMs]), [
    [2, 2, 'ok', 0],
    [3, 8, 'ok', 0],
    [11, 12, 'ok', 0],
    [14, 18, 'ok', 0],
  ])
  assert.equal(view.overview[2].callId, 'write-hello')
  assert.equal(view.overview[2].name, 'write')
  assert.equal(view.overview[1].provider, 'fake')
  assert.equal(view.preamble.map((row) => row.type).join(), 'session.opened')
  assert.equal(view.turns.length, 1)
  assert.equal(view.turns[0].id, 1)
  assert.equal(view.turns[0].input, 'Write hello.txt')
  assert.deepEqual(view.turns[0].rows.map((row) => row.label), [
    'message:user', 'model.request', 'stream.started', 'stream.delta', 'stream.delta', 'stream.delta', 'stream.ended', 'message:assistant', 'permission.decided',
    'tool.started', 'tool.finished', 'message:tool', 'model.request', 'stream.started', 'stream.delta', 'stream.delta', 'stream.ended', 'message:assistant',
  ])
  const rows = rowsOf(view)
  assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  const requestRow = rows.find((row) => row.type === 'model.request')
  assert.equal(requestRow.detail.provider, 'fake')
  assert.equal(requestRow.detail.body.messages[0].content, 'Write hello.txt')
  assert.equal(requestRow.detail.body.tools.length, 6)
  assert.equal(JSON.stringify(requestRow.detail).includes('sk-'), false)
  const started = rows.find((row) => row.type === 'tool.started')
  assert.deepEqual(started.detail.arguments, { path: 'hello.txt', content: 'hello\n' })
  assert.equal(started.detail.outcome, undefined)
  assert.equal(started.status, 'ok')
  const finished = rows.find((row) => row.type === 'tool.finished')
  assert.equal(finished.detail.result, 'File written.')
  assert.equal(finished.detail.error, undefined)
  const decision = rows.find((row) => row.type === 'permission.decided')
  assert.equal(decision.detail.decision, 'allow')
  assert.equal(decision.detail.arguments.path, 'hello.txt')
  assert.equal(rows.at(-1).detail.content, 'Wrote hello.txt.')
  const ends = rows.filter((row) => row.type === 'stream.ended')
  assert.equal(ends[0].detail.tool_calls[0].id, 'write-hello')
  assert.equal(ends[0].detail.tool_calls[0].function.arguments, '{"path":"hello.txt","content":"hello\\n"}')
  assert.equal(ends[1].detail.text, 'Wrote hello.txt.')
  assert.deepEqual(view.overview[3].tokens.map((token) => token.text), ['Wrote he', 'llo.txt.'])
  assert.equal(view.overview[3].tokens.map((token) => token.text).join(''), rows.at(-1).detail.content)
})

test('projects an interrupted tool and an unresolved tool call as unknown', () => {
  const interrupted = project([{
    seq: 1,
    time: clock,
    type: 'tool.started',
    callId: 'write-hello',
    name: 'write',
    arguments: { path: 'hello.txt', content: 'should-not-retry' },
    workspace: '/tmp/workspace',
  }])
  assert.deepEqual(interrupted.unknown, ['write-hello'])
  assert.equal(interrupted.overview.length, 1)
  assert.equal(interrupted.overview[0].kind, 'tool')
  assert.equal(interrupted.overview[0].status, 'unknown')
  assert.equal(interrupted.overview[0].endTime, null)
  assert.equal(interrupted.overview[0].durationMs, null)
  assert.equal(interrupted.preamble[0].detail.outcome, 'unknown')
  assert.equal('result' in interrupted.preamble[0].detail, false)
  assert.equal(interrupted.preamble[0].detail.arguments.content, 'should-not-retry')
  assert.equal(JSON.stringify(interrupted).includes('File written'), false)

  const pending = project([
    { seq: 1, time: clock, type: 'session.opened', workspace: '/tmp/workspace' },
    { seq: 2, time: clock, type: 'message', message: { role: 'user', content: 'Write hello.txt' } },
    { seq: 3, time: clock, type: 'model.request', provider: 'fake', body: { model: 'fake' } },
    { seq: 4, time: clock, type: 'message', message: assistant(null, [call('write-hello', 'write', { path: 'hello.txt', content: 'nope' })]) },
  ])
  assert.deepEqual(pending.unknown, ['write-hello'])
  assert.equal(pending.turns[0].rows.find((row) => row.type === 'message' && row.detail.role === 'assistant').detail.outcome, 'unknown')
  assert.equal(rowsOf(pending).some((row) => row.type === 'tool.started' || row.type === 'tool.finished'), false)
  assert.equal(pending.overview.some((span) => span.kind === 'tool'), false)
})

test('projects a denied tool error without a tool span', () => {
  const view = project([
    { seq: 1, time: clock, type: 'message', message: { role: 'user', content: 'Write nope' } },
    { seq: 2, time: clock, type: 'model.request', provider: 'fake', body: { model: 'fake' } },
    { seq: 3, time: clock, type: 'message', message: assistant(null, [call('write-1', 'write', { path: 'nope.txt', content: 'x' })]) },
    { seq: 4, time: clock, type: 'permission.decided', callId: 'write-1', name: 'write', arguments: { path: 'nope.txt', content: 'x' }, workspace: '/tmp/workspace', decision: 'deny', reason: 'denied' },
    { seq: 5, time: clock, type: 'message', message: { role: 'tool', tool_call_id: 'write-1', content: 'Error: denied' } },
    { seq: 6, time: clock, type: 'message', message: { role: 'assistant', content: 'Stopped.' } },
  ])
  assert.deepEqual(view.unknown, [])
  const denied = view.turns[0].rows.find((row) => row.type === 'permission.decided')
  assert.equal(denied.status, 'deny')
  assert.deepEqual(denied.detail.arguments, { path: 'nope.txt', content: 'x' })
  assert.equal(denied.detail.reason, 'denied')
  const error = view.turns[0].rows.find((row) => row.detail.error)
  assert.equal(error.detail.error, 'Error: denied')
  assert.equal(view.overview.some((span) => span.kind === 'tool'), false)
})

test('times model and tool spans from the recorded clock', () => {
  const view = project([
    { seq: 1, time: '2026-01-01T00:00:00.000Z', type: 'message', message: { role: 'user', content: 'A' } },
    { seq: 2, time: '2026-01-01T00:00:01.000Z', type: 'model.request', provider: 'fake', body: {} },
    { seq: 3, time: '2026-01-01T00:00:04.000Z', type: 'message', message: assistant(null, [call('shell-1', 'shell', { command: 'true' })]) },
    { seq: 4, time: '2026-01-01T00:00:04.500Z', type: 'tool.started', callId: 'shell-1', name: 'shell', arguments: { command: 'true' } },
    { seq: 5, time: '2026-01-01T00:00:06.500Z', type: 'tool.finished', callId: 'shell-1', result: 'Error: failed' },
    { seq: 6, time: '2026-01-01T00:00:06.500Z', type: 'message', message: { role: 'tool', tool_call_id: 'shell-1', content: 'Error: failed' } },
    { seq: 7, time: '2026-01-01T00:00:07.000Z', type: 'message', message: { role: 'user', content: 'B' } },
    { seq: 8, time: '2026-01-01T00:00:08.000Z', type: 'message', message: { role: 'assistant', content: 'Done.' } },
  ])
  assert.deepEqual(view.turns.map((turn) => turn.input), ['A', 'B'])
  assert.equal(view.overview[1].durationMs, 3000)
  assert.equal(view.overview.find((span) => span.kind === 'tool').durationMs, 2000)
  assert.equal(view.overview.find((span) => span.kind === 'tool').status, 'error')
  assert.equal(view.turns[0].rows.find((row) => row.type === 'tool.finished').detail.error, 'Error: failed')
  assert.throws(() => project([{ seq: 1, type: 'note' }, { seq: 3, type: 'note' }]), /Trajectory sequence gap: expected 2, received 3/)
})

test('projects stream fragments from the session and follows them without a gap', async () => {
  const dir = await directory()
  let tick = 0
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
  const app = await boot({
    workspace: dir,
    provider: fakeProvider([{ stream: [
      { text: 'Hel' },
      { text: 'lo' },
      { finish: 'stop' },
    ] }]),
    clock,
    view: { port: 0, refreshMs: 0 },
  })
  const live = []
  try {
    const joined = await openSse(`${app.ctx.viewer.url}/events?after=0`)
    live.push(joined)
    await app.ctx.agent.turn('Hi')
    await until(() => joined.events.length === app.ctx.session.events.length)
    const seqs = joined.events.map((item) => item.data.seq)
    assert.deepEqual(seqs, app.ctx.session.events.map((event) => event.seq))
    seqs.forEach((seq, index) => assert.equal(seq, index + 1))
    const saved = app.ctx.session.events
    const view = project(saved)
    const page = await request(`${app.ctx.viewer.url}/`)
    const trajectory = await request(`${app.ctx.viewer.url}/trajectory`)
    assert.deepEqual(JSON.parse(trajectory.body), view)
    assert.deepEqual(embedded(page.body), view)
    assert.deepEqual(view.unknownStreams, [])
    const ended = saved.find((event) => event.type === 'stream.ended')
    assert.equal(observeStream(saved, ended.stream).text, 'Hello')
    assert.equal(saved.find((event) => event.seq === ended.seq + 1).message.content, 'Hello')
    const model = view.overview.find((span) => span.kind === 'model')
    assert.equal(model.status, 'ok')
    assert.equal(model.endSeq, ended.seq)
    assert.ok(model.durationMs >= 1000)
    assert.deepEqual(model.tokens.map((token) => token.text), ['Hel', 'lo'])
    assert.match(page.body, /class="token"/)
    assert.match(page.body, />Hel</)
    assert.match(page.body, />lo</)
    assert.equal(page.body.includes('sk-secret'), false)
    assert.equal(view.turns[0].rows.some((row) => row.type === 'stream.delta' && row.detail.text === 'Hel'), true)
    const endRow = view.turns[0].rows.find((row) => row.type === 'stream.ended')
    assert.equal(endRow.detail.text, 'Hello')
    assert.equal(endRow.detail.finish, 'stop')

    joined.close()
    const resumed = await openSse(`${app.ctx.viewer.url}/events?after=${ended.seq}`)
    live.push(resumed)
    await until(() => resumed.events.length >= 1)
    assert.equal(resumed.events[0].data.seq, ended.seq + 1)
    assert.equal(resumed.events[0].id, String(ended.seq + 1))
  } finally {
    for (const stream of live) stream.close()
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unfinished stream has no invented end or assistant text', () => {
  const view = project([
    { seq: 1, time: '2026-01-01T00:00:00.000Z', type: 'message', message: { role: 'user', content: 'Hi' } },
    { seq: 2, time: '2026-01-01T00:00:01.000Z', type: 'model.request', provider: 'fake', body: { model: 'fake' } },
    { seq: 3, time: '2026-01-01T00:00:02.000Z', type: 'stream.started' },
    { seq: 4, time: '2026-01-01T00:00:03.000Z', type: 'stream.delta', stream: 3, text: 'Hel' },
  ])
  assert.deepEqual(view.unknownStreams, [3])
  assert.equal(view.overview.find((span) => span.kind === 'model').status, 'unknown')
  assert.equal(view.overview.find((span) => span.kind === 'model').endTime, null)
  assert.equal(view.overview.find((span) => span.kind === 'model').durationMs, null)
  assert.deepEqual(view.overview.find((span) => span.kind === 'model').tokens.map((token) => token.text), ['Hel'])
  assert.equal(view.turns[0].rows.some((row) => row.detail?.role === 'assistant'), false)
  assert.equal(JSON.stringify(view).includes('Hello'), false)
  assert.equal(view.turns[0].rows.find((row) => row.type === 'stream.started').status, 'unknown')
})

test('serves the fixture read-only and renders the same history after restart', async () => {
  const dir = await directory()
  const sessionPath = join(dir, 'session.jsonl')
  const original = await readFile(join(fixtureDir, 'session.jsonl'))
  await writeFile(sessionPath, original)
  const events = (await readSession(sessionPath)).events
  const expected = project(events)
  const first = startView({ MINI_WORKSPACE: dir, MINI_SESSION: sessionPath })
  try {
    const url = await first.url()
    const page = await request(`${url}/`)
    const trajectory = await request(`${url}/trajectory`)
    assert.equal(page.status, 200)
    assert.match(page.body, /<p class="wordmark">mini-dsh<\/p>/)
    assert.match(page.body, /Turn 1 · Write hello\.txt/)
    assert.match(page.body, /class="bar input"/)
    assert.equal(page.body.split('class="bar model"').length - 1, 2)
    assert.match(page.body, /class="bar tool"/)
    assert.match(page.body, />input</)
    assert.match(page.body, />model</)
    assert.match(page.body, />tool</)
    assert.equal(page.body.includes('<form'), false)
    assert.equal(page.body.includes('<textarea'), false)
    assert.equal(page.body.includes('<input'), false)
    assert.equal(page.body.includes('Approve'), false)
    assert.equal(page.body.includes('sk-secret'), false)
    assert.equal(page.body.split('</script>').length - 1, 2)
    assert.deepEqual(embedded(page.body), expected)
    assert.deepEqual(JSON.parse(trajectory.body), expected)
    const posted = await request(`${url}/trajectory`, { method: 'POST' })
    assert.equal(posted.status, 405)
    assert.deepEqual(await readFile(sessionPath), original)
    await assert.rejects(access(`${sessionPath}.lock`))
    await assert.rejects(access(join(dir, 'hello.txt')))
  } finally { await first.stop() }

  const again = startView({ MINI_WORKSPACE: dir, MINI_SESSION: sessionPath })
  try {
    const url = await again.url()
    const trajectory = await request(`${url}/trajectory`)
    assert.deepEqual(JSON.parse(trajectory.body), expected)
    assert.equal(again.output.stderr, '')
    assert.deepEqual(await readFile(sessionPath), original)
    await assert.rejects(access(`${sessionPath}.lock`))
  } finally {
    const stopped = await again.stop()
    assert.equal(stopped.code, 0)
    await rm(dir, { recursive: true, force: true })
  }
})

test('reopens an interrupted tool and shows the unknown outcome', async () => {
  const dir = await directory()
  const sessionPath = join(dir, 'session.jsonl')
  const line = JSON.stringify({
    seq: 1,
    time: clock,
    type: 'tool.started',
    callId: 'write-hello',
    name: 'write',
    arguments: { path: 'hello.txt', content: 'should-not-retry' },
    workspace: dir,
  }) + '\n'
  await writeFile(sessionPath, line)
  const expected = project((await readSession(sessionPath)).events)
  async function look() {
    const handle = startView({ MINI_WORKSPACE: dir, MINI_SESSION: sessionPath })
    try {
      const url = await handle.url()
      const page = await request(`${url}/`)
      const trajectory = await request(`${url}/trajectory`)
      await until(() => /unknown tool outcome for write-hello/.test(handle.output.stderr))
      assert.match(page.body, /unknown tool outcome for write-hello/)
      assert.match(page.body, /data-status="unknown"/)
      assert.match(page.body, /tool unknown/)
      assert.equal(page.body.includes('should-not-retry'), true)
      assert.equal(page.body.includes('File written'), false)
      assert.deepEqual(JSON.parse(trajectory.body), expected)
      assert.deepEqual(embedded(page.body).unknown, ['write-hello'])
      await assert.rejects(access(`${sessionPath}.lock`))
      await assert.rejects(access(join(dir, 'hello.txt')))
      assert.equal(await readFile(sessionPath, 'utf8'), line)
    } finally { await handle.stop() }
  }
  try {
    await look()
    await look()
    assert.equal(await readFile(sessionPath, 'utf8'), line)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('follows live events without gaps and resumes from the last sequence', async () => {
  const dir = await directory()
  const app = await boot({
    workspace: dir,
    session: 'live.jsonl',
    composition: ({ sessionPath, view }) => [
      { name: 'viewer', plugin: TrajectoryViewer, config: view },
      { name: 'session', plugin: Session, config: { path: sessionPath, writable: true, clock: () => clock } },
    ],
    view: { port: 0, refreshMs: 0 },
  })
  const streams = []
  try {
    const url = app.ctx.viewer.url
    await app.ctx.session.append({ type: 'note', text: 'one' })
    const joined = await openSse(`${url}/events?after=0`)
    streams.push(joined)
    await until(() => joined.events.length === 1)
    await app.ctx.session.append({ type: 'note', text: 'two' })
    await app.ctx.session.append({ type: 'note', text: 'three' })
    await until(() => joined.events.length === 3)
    assert.deepEqual(joined.events.map((item) => item.data.seq), [1, 2, 3])
    assert.deepEqual(joined.events.map((item) => item.data.text), ['one', 'two', 'three'])
    joined.close()

    const resumed = await openSse(`${url}/events?after=3`)
    streams.push(resumed)
    await app.ctx.session.append({ type: 'note', text: 'four' })
    await until(() => resumed.events.length >= 1)
    await delay(80)
    assert.deepEqual(resumed.events.map((item) => item.data.seq), [4])
    resumed.close()

    const header = await openSse(`${url}/events?after=0`, { 'Last-Event-ID': '4' })
    streams.push(header)
    await app.ctx.session.append({ type: 'note', text: 'five' })
    await until(() => header.events.length >= 1)
    await delay(80)
    assert.deepEqual(header.events.map((item) => [item.id, item.data.seq, item.data.text]), [['5', 5, 'five']])
    const page = await request(`${url}/trajectory`)
    const view = JSON.parse(page.body)
    assert.deepEqual(view.preamble.map((row) => row.seq), [1, 2, 3, 4, 5])
    assert.equal(view.cursor, app.ctx.session.events.at(-1).seq)
    assert.equal(page.body.includes('sk-secret'), false)

    const ahead = await request(`${url}/events?after=9`)
    assert.equal(ahead.status, 409)
    const bad = await request(`${url}/events?after=-1`)
    assert.equal(bad.status, 400)
  } finally {
    for (const stream of streams) stream.close()
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports a sequence gap instead of skipping it', async () => {
  const dir = await directory()
  const app = await boot({
    workspace: dir,
    composition: ({ sessionPath, view }) => [
      { name: 'viewer', plugin: TrajectoryViewer, config: view },
      { name: 'session', plugin: Session, config: { path: sessionPath, writable: true, clock: () => clock } },
    ],
    view: { port: 0, refreshMs: 0 },
  })
  try {
    await app.ctx.session.append({ type: 'note', text: 'one' })
    await app.ctx.session.append({ type: 'note', text: 'two' })
    await app.ctx.session.append({ type: 'note', text: 'three' })
    const before = await readFile(app.sessionPath)
    app.ctx.session.events.push({ seq: 5, time: clock, type: 'note', text: 'skipped' })
    const gap = await openSse(`${app.ctx.viewer.url}/events?after=3`)
    await until(() => gap.done)
    assert.equal(gap.events.length, 1)
    assert.equal(gap.events[0].event, 'gap')
    assert.match(gap.events[0].data.error, /Session follow gap: expected sequence 4, received 5/)
    assert.equal(gap.events.some((item) => item.data.seq === 5), false)
    assert.deepEqual(await readFile(app.sessionPath), before)
  } finally {
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a read-only viewer follows a writer and reloads the same history', async () => {
  const dir = await directory()
  const sessionPath = join(dir, 'session.jsonl')
  const ctx = new Context()
  const writer = ctx.plugin(Session, { path: sessionPath, writable: true, clock: () => clock })
  let reader
  let stream
  try {
    await ready([writer])
    reader = await boot({
      workspace: dir,
      session: sessionPath,
      writable: false,
      composition: viewerComposition,
      view: { port: 0, refreshMs: 20 },
    })
    stream = await openSse(`${reader.ctx.viewer.url}/events?after=0`)
    await ctx.session.append({ type: 'note', text: 'from-writer' })
    await ctx.session.append({ type: 'note', text: 'next' })
    await until(() => stream.events.length >= 2, 2000)
    assert.deepEqual(stream.events.map((item) => item.data.seq), [1, 2])
    assert.deepEqual(stream.events.map((item) => item.data.text), ['from-writer', 'next'])
    const seen = JSON.parse((await request(`${reader.ctx.viewer.url}/trajectory`)).body)
    stream.close()
    await reader.dispose()
    const reopened = await boot({
      workspace: dir,
      session: sessionPath,
      composition: viewerComposition,
      view: { port: 0, refreshMs: 0 },
    })
    reader = reopened
    const again = JSON.parse((await request(`${reopened.ctx.viewer.url}/trajectory`)).body)
    assert.deepEqual(again, seen)
    assert.equal(again.cursor, 2)
  } finally {
    stream?.close()
    await reader?.dispose()
    await writer.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('unloading the viewer closes its port and leaves the session writable', async () => {
  const dir = await directory()
  const ctx = new Context()
  const sessionFiber = ctx.plugin(Session, { path: join(dir, 'session.jsonl'), writable: true, clock: () => clock })
  const viewerFiber = ctx.plugin(TrajectoryViewer, { port: 0, refreshMs: 0 })
  try {
    await ready([sessionFiber, viewerFiber])
    assert.deepEqual(TrajectoryViewer.inject, ['session'])
    const url = ctx.viewer.url
    await ctx.session.append({ type: 'note', text: 'kept' })
    const page = await request(`${url}/trajectory`)
    assert.equal(page.status, 200)
    assert.equal(JSON.parse(page.body).cursor, 1)
    await viewerFiber.dispose()
    await assert.rejects(request(`${url}/trajectory`))
    await ctx.session.append({ type: 'note', text: 'still-writing' })
    assert.deepEqual(ctx.session.events.map((event) => event.text), ['kept', 'still-writing'])
    assert.equal(ctx.session.writable, true)
  } finally {
    await viewerFiber.dispose()
    await sessionFiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the viewer escapes recorded text and stays on loopback', async () => {
  const dir = await directory()
  const payload = '</script><img src=x onerror=alert(1)>'
  const app = await boot({
    workspace: dir,
    composition: ({ sessionPath, view }) => [
      { name: 'viewer', plugin: TrajectoryViewer, config: view },
      { name: 'session', plugin: Session, config: { path: sessionPath, writable: true, workspace: dir, clock: () => clock } },
      { name: 'workspace', plugin: Workspace, config: { root: dir } },
    ],
    view: { port: 0, refreshMs: 0 },
  })
  try {
    await app.ctx.session.append({ role: 'user', content: payload })
    const page = await request(`${app.ctx.viewer.url}/`)
    assert.equal(page.body.split('</script>').length - 1, 2)
    assert.equal(page.body.includes('<img'), false)
    assert.match(page.body, /&lt;img src=x onerror=alert\(1\)&gt;/)
    assert.equal(embedded(page.body).turns[0].input, payload)
    assert.equal(app.report[0].name, 'viewer')
    await assert.rejects(() => boot({
      workspace: dir,
      composition: viewerComposition,
      view: { host: '0.0.0.0', port: 0 },
    }), /127\.0\.0\.1/)
    await assert.rejects(() => boot({
      workspace: dir,
      composition: viewerComposition,
      view: { port: -1 },
    }), /Viewer port is invalid/)
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('projects a denied tool from the agent through the same session', async () => {
  const dir = await directory()
  const app = await boot({
    workspace: dir,
    composition,
    provider: fakeProvider([
      assistant(null, [call('write-1', 'write', { path: 'nope.txt', content: 'x' })]),
      assistant('Stopped.'),
    ]),
    approve: async () => false,
    clock: () => clock,
    view: { port: 0, refreshMs: 0 },
  })
  try {
    await app.ctx.agent.turn('Write nope')
    const saved = (await readSession(app.sessionPath)).events
    const view = project(saved)
    assert.equal(view.cursor, saved.at(-1).seq)
    assert.equal(view.unknown.length, 0)
    const denied = rowsOf(view).find((row) => row.type === 'permission.decided')
    assert.equal(denied.detail.decision, 'deny')
    assert.deepEqual(denied.detail.arguments, { path: 'nope.txt', content: 'x' })
    assert.equal(rowsOf(view).find((row) => row.detail.error).detail.error, 'Error: denied')
    assert.equal(view.overview.some((span) => span.kind === 'tool'), false)
    const url = app.ctx.viewer.url
    const page = await request(`${url}/`)
    const trajectory = await request(`${url}/trajectory`)
    assert.match(page.body, /mini-dsh/)
    assert.match(page.body, /Turn 1 · Write nope/)
    assert.match(page.body, /Error: denied/)
    assert.equal(page.body.includes('<form'), false)
    assert.equal(page.body.includes('sk-secret'), false)
    assert.deepEqual(JSON.parse(trajectory.body), JSON.parse(JSON.stringify(view)))
    assert.equal((await readFile(app.sessionPath, 'utf8')).includes(url), false)
    await app.dispose()
    await assert.rejects(request(`${url}/trajectory`))
    await assert.rejects(access(join(dir, 'nope.txt')))
  } finally {
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('MINI_VIEW follows the terminal session and inspect mode does not bind', async () => {
  const dir = await directory()
  const sessionPath = join(dir, 'session.jsonl')
  const handle = startMain({ MINI_WORKSPACE: dir, MINI_SESSION: sessionPath, MINI_VIEW: '1', MINI_VIEW_PORT: '0' })
  try {
    const start = Date.now()
    while (!/Trajectory: http:\/\/127\.0\.0\.1:\d+/.test(handle.output.stdout)) {
      if (handle.child.exitCode != null) throw new Error(handle.output.stderr)
      if (Date.now() - start > 5000) throw new Error(`no trajectory url\n${handle.output.stdout}\n${handle.output.stderr}`)
      await delay(20)
    }
    const url = handle.output.stdout.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    const page = await request(`${url}/`)
    assert.match(page.body, /mini-dsh/)
    assert.match(page.body, /session\.opened/)
    assert.equal(page.body.includes('<form'), false)
    assert.equal(page.body.includes('Approve'), false)
    handle.child.stdin.end('/quit\n')
    const status = await handle.exited
    assert.equal(status.code, 0, handle.output.stderr)
  } finally {
    if (handle.child.exitCode == null && handle.child.signalCode == null) handle.child.kill('SIGKILL')
    await handle.exited
  }

  const fixture = await readFile(join(fixtureDir, 'session.jsonl'))
  await writeFile(sessionPath, fixture)
  const inspected = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/main.js'], {
      cwd: root,
      env: cleanEnv({
        MINI_WORKSPACE: dir,
        MINI_SESSION: sessionPath,
        MINI_INSPECT: '1',
        MINI_VIEW: '1',
        MINI_VIEW_PORT: '99999',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`inspect stayed up\n${stdout}\n${stderr}`)) }, 5000)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
  assert.equal(inspected.code, 0, inspected.stderr)
  assert.equal(inspected.stdout, fixture.toString())
  assert.equal(inspected.stdout.includes('Trajectory:'), false)
  assert.deepEqual(await readFile(sessionPath), fixture)
  await rm(dir, { recursive: true, force: true })
})
