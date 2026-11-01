import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixtureDir = join(root, 'fixtures/write-hello')
const managed = ['MINI_WORKSPACE', 'MINI_SESSION', 'MINI_REPLIES', 'MINI_CLOCK', 'MINI_INSPECT', 'MINI_VIEW', 'MINI_VIEW_PORT', 'DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY_FILE', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_TOOL_CHOICE']

function cleanEnv(overrides) {
  const env = { ...process.env }
  for (const name of managed) delete env[name]
  return { ...env, DEEPSEEK_API_KEY: 'sk-secret', ...overrides }
}

function startMain(overrides) {
  const child = spawn(process.execPath, ['src/main.js'], {
    cwd: root,
    env: cleanEnv(overrides),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => { output.stdout += chunk })
  child.stderr.on('data', (chunk) => { output.stderr += chunk })
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  return { child, output, exited }
}

function finish(handle, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      handle.child.kill('SIGKILL')
      reject(new Error(`main.js did not exit\nstdout: ${handle.output.stdout}\nstderr: ${handle.output.stderr}`))
    }, ms)
    handle.exited.then((status) => {
      clearTimeout(timer)
      resolve({ ...status, stdout: handle.output.stdout, stderr: handle.output.stderr })
    })
  })
}

async function runMain(overrides, input) {
  const handle = startMain(overrides)
  if (input != null) handle.child.stdin.end(input)
  else handle.child.stdin.end()
  try { return await finish(handle) }
  finally {
    if (handle.child.exitCode == null && handle.child.signalCode == null) handle.child.kill('SIGKILL')
    await handle.exited
  }
}

async function until(handle, pattern, ms = 5000) {
  const start = Date.now()
  while (!pattern.test(handle.output.stdout)) {
    if (handle.child.exitCode != null || handle.child.signalCode != null) {
      throw new Error(`main.js exited before ${pattern}\nstdout: ${handle.output.stdout}\nstderr: ${handle.output.stderr}`)
    }
    if (Date.now() - start > ms) {
      handle.child.kill('SIGKILL')
      throw new Error(`timed out waiting for ${pattern}\nstdout: ${handle.output.stdout}\nstderr: ${handle.output.stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function directory() {
  return mkdtemp(join(tmpdir(), 'mini-term-'))
}

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function assistant(content, calls) {
  const message = { role: 'assistant', content: content ?? null }
  if (calls?.length) message.tool_calls = calls
  return message
}

function label(event) {
  return event.type === 'message' ? `message:${event.message.role}` : event.type
}

async function readEvents(file) {
  const text = await readFile(file, 'utf8')
  return { text, events: text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [] }
}

function placeholder(text, workspace) {
  return text.split(workspace).join('$WORKSPACE')
}

test('keyless entry point records a write and inspects the same session after restart', async () => {
  const dir = await directory()
  const sessionPath = join(dir, '.mini-session.jsonl')
  const env = {
    MINI_WORKSPACE: dir,
    MINI_SESSION: sessionPath,
    MINI_REPLIES: join(fixtureDir, 'replies.json'),
    MINI_CLOCK: '2026-01-01T00:00:00.000Z',
  }
  try {
    const first = await runMain(env, 'Write hello.txt\ny\n/quit\n')
    assert.equal(first.code, 0, first.stderr)
    assert.match(first.stdout, /workspace:/)
    assert.match(first.stdout, /Approve write \{"path":"hello.txt","content":"hello\\n"\}/)
    assert.match(first.stdout, /result> File written\./)
    assert.match(first.stdout, /assistant> Wrote hello\.txt\./)
    assert.equal(await readFile(join(dir, 'hello.txt'), 'utf8'), await readFile(join(fixtureDir, 'hello.txt'), 'utf8'))
    await assert.rejects(access(join(root, 'hello.txt')))

    const saved = await readEvents(sessionPath)
    assert.equal(saved.text.includes('sk-secret'), false)
    assert.deepEqual(saved.events.map(label), [
      'session.opened',
      'message:user',
      'model.request',
      'stream.started',
      'stream.delta',
      'stream.delta',
      'stream.delta',
      'stream.ended',
      'message:assistant',
      'permission.decided',
      'tool.started',
      'tool.finished',
      'message:tool',
      'model.request',
      'stream.started',
      'stream.delta',
      'stream.delta',
      'stream.ended',
      'message:assistant',
    ])
    const decision = saved.events.find((event) => event.type === 'permission.decided')
    assert.equal(decision.decision, 'allow')
    assert.equal(decision.callId, 'write-hello')
    assert.equal(decision.workspace, dir)
    assert.deepEqual(decision.arguments, { path: 'hello.txt', content: 'hello\n' })
    const started = saved.events.find((event) => event.type === 'tool.started')
    const finished = saved.events.find((event) => event.type === 'tool.finished')
    assert.equal(started.seq < finished.seq, true)
    assert.equal(finished.result, 'File written.')
    assert.equal(saved.events.find((event) => event.type === 'model.request').provider, 'fake')
    assert.equal(saved.events.find((event) => event.type === 'model.request').body.context[0].sandbox, false)
    assert.equal(placeholder(saved.text, dir), await readFile(join(fixtureDir, 'session.jsonl'), 'utf8'))

    const before = await readFile(sessionPath)
    const inspected = await runMain({ ...env, MINI_INSPECT: '1' })
    assert.equal(inspected.code, 0, inspected.stderr)
    assert.equal(inspected.stderr, '')
    assert.equal(inspected.stdout, before.toString())
    assert.deepEqual(await readFile(sessionPath), before)
    assert.equal(await readFile(join(dir, 'hello.txt'), 'utf8'), 'hello\n')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('one approval is not reused for the next write', async () => {
  const dir = await directory()
  const replies = join(dir, 'replies.json')
  await writeFile(replies, JSON.stringify([
    assistant(null, [
      call('write-a', 'write', { path: 'a.txt', content: 'A' }),
      call('write-b', 'write', { path: 'b.txt', content: 'B' }),
    ]),
    assistant('Stopped.'),
  ]))
  try {
    const result = await runMain({ MINI_WORKSPACE: dir, MINI_REPLIES: replies }, 'Two files\nyes\nn\n/quit\n')
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout.split('Approve write').length - 1, 2)
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'A')
    await assert.rejects(access(join(dir, 'b.txt')))
    const { events } = await readEvents(join(dir, '.mini-session.jsonl'))
    const decisions = events.filter((event) => event.type === 'permission.decided')
    assert.deepEqual(decisions.map((event) => [event.callId, event.decision, event.reason]), [
      ['write-a', 'allow', undefined],
      ['write-b', 'deny', 'denied'],
    ])
    assert.deepEqual(events.filter((event) => event.type === 'tool.started').map((event) => event.callId), ['write-a'])
    assert.equal(events.some((event) => event.callId === 'write-b' && event.type === 'tool.finished'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a closed approval prompt refuses the write', async () => {
  const dir = await directory()
  const replies = join(dir, 'replies.json')
  await writeFile(replies, JSON.stringify([
    assistant(null, [call('write-hello', 'write', { path: 'hello.txt', content: 'nope' })]),
    assistant('Stopped.'),
  ]))
  try {
    const result = await runMain({ MINI_WORKSPACE: dir, MINI_REPLIES: replies }, 'Write hello.txt\n')
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
    await assert.rejects(access(join(dir, 'hello.txt')))
    assert.match(result.stdout, /approval unavailable/)
    assert.match(result.stdout, /Stopped\./)
    const { events } = await readEvents(join(dir, '.mini-session.jsonl'))
    const decision = events.find((event) => event.type === 'permission.decided')
    assert.equal(decision.decision, 'deny')
    assert.equal(decision.reason, 'approval unavailable')
    assert.equal(decision.workspace, dir)
    assert.equal(events.some((event) => event.type === 'tool.started' || event.type === 'tool.finished'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the terminal stays blocked while approval is unanswered and does not retry after it is killed', async () => {
  const dir = await directory()
  const sessionPath = join(dir, '.mini-session.jsonl')
  const env = {
    MINI_WORKSPACE: dir,
    MINI_SESSION: sessionPath,
    MINI_REPLIES: join(fixtureDir, 'replies.json'),
  }
  const handle = startMain(env)
  try {
    handle.child.stdin.write('Write hello.txt\n')
    await until(handle, /Approve write/)
    assert.equal(handle.child.exitCode, null)
    const mid = await readFile(sessionPath)
    assert.equal(mid.includes('"type":"tool.started"'), false)
    assert.equal(mid.includes('"type":"permission.decided"'), false)
    await assert.rejects(access(join(dir, 'hello.txt')))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(handle.child.exitCode, null)
    assert.deepEqual(await readFile(sessionPath), mid)
    handle.child.kill('SIGKILL')
    const killed = await handle.exited
    assert.equal(killed.signal, 'SIGKILL')
    assert.deepEqual(await readFile(sessionPath), mid)

    const again = await runMain(env, 'Write hello.txt\ny\n/quit\n')
    assert.equal(again.code, 1)
    assert.match(again.stderr, /unknown tool outcome for write-hello/)
    assert.equal(again.stdout.includes('You>'), false)
    assert.equal(again.stdout.includes('Approve'), false)
    assert.deepEqual(await readFile(sessionPath), mid)
    await assert.rejects(access(join(dir, 'hello.txt')))

    const inspected = await runMain({ ...env, MINI_INSPECT: '1' })
    assert.equal(inspected.code, 1)
    assert.match(inspected.stderr, /unknown tool outcome for write-hello/)
    assert.equal(inspected.stdout, mid.toString())
    assert.equal(inspected.stdout.includes('tool.finished'), false)
    assert.deepEqual(await readFile(sessionPath), mid)
  } finally {
    handle.child.stdin.destroy()
    if (handle.child.exitCode == null && handle.child.signalCode == null) handle.child.kill('SIGKILL')
    await handle.exited
    await rm(dir, { recursive: true, force: true })
  }
})

test('an interrupted tool is not retried when the terminal starts again', async () => {
  const dir = await directory()
  const sessionPath = join(dir, '.mini-session.jsonl')
  const line = JSON.stringify({
    seq: 1,
    time: '2026-01-01T00:00:00.000Z',
    type: 'tool.started',
    callId: 'write-hello',
    name: 'write',
    arguments: { path: 'hello.txt', content: 'should-not-retry' },
    workspace: dir,
  }) + '\n'
  await writeFile(sessionPath, line)
  try {
    const result = await runMain({
      MINI_WORKSPACE: dir,
      MINI_SESSION: sessionPath,
      MINI_REPLIES: join(fixtureDir, 'replies.json'),
    }, 'Write hello.txt\ny\n/quit\n')
    assert.equal(result.code, 1)
    assert.match(result.stderr, /unknown tool outcome for write-hello/)
    assert.match(result.stderr, /start a new session/)
    assert.equal(result.stdout.includes('You>'), false)
    assert.equal(result.stdout.includes('Approve'), false)
    assert.equal(await readFile(sessionPath, 'utf8'), line)
    await assert.rejects(access(`${sessionPath}.lock`))
    await assert.rejects(access(join(dir, 'hello.txt')))

    const inspected = await runMain({
      MINI_WORKSPACE: dir,
      MINI_SESSION: sessionPath,
      MINI_INSPECT: '1',
    })
    assert.equal(inspected.code, 1)
    assert.equal(inspected.stdout, line)
    assert.match(inspected.stderr, /unknown tool outcome for write-hello/)
    assert.equal(await readFile(sessionPath, 'utf8'), line)
    await assert.rejects(access(`${sessionPath}.lock`))
    await assert.rejects(access(join(dir, 'hello.txt')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
