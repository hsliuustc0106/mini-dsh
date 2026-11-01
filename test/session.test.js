import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { acquireWriter, lockPathFor } from '../src/lock.js'
import { Checkpoint, Session } from '../src/services.js'

const root = fileURLToPath(new URL('..', import.meta.url))

function tick() { return new Promise((resolve) => setImmediate(resolve)) }

async function ready(fibers) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await Promise.all(fibers.map((fiber) => fiber.await().catch(() => {})))
    if (fibers.every((fiber) => fiber.state === 2)) return
    await tick()
  }
  throw new Error(`plugins were not ready: ${fibers.map((fiber) => fiber.state).join(',')}`)
}

async function openSession(path, config = {}) {
  const ctx = new Context()
  const fiber = ctx.plugin(Session, { path, writable: true, clock: () => 't', ...config })
  try { await fiber }
  catch (error) {
    await fiber.dispose()
    throw error
  }
  return { ctx, fiber, session: ctx.session, async close() { await fiber.dispose() } }
}

async function workspace() {
  return mkdtemp(join(tmpdir(), 'mini-session-'))
}

const childSource = `
import { Context } from '@deepseek-ai/cordis'
import { Session } from ${JSON.stringify(pathToFileURL(join(root, 'src/services.js')).href)}
const ctx = new Context()
const fiber = ctx.plugin(Session, { path: process.env.SESSION, writable: true, clock: () => 't' })
await fiber
if (process.env.MODE === 'tool') await ctx.session.append({ type: 'tool.started', callId: 'shell-1', name: 'shell' })
else await ctx.session.append({ type: 'note', text: 'from-child' })
console.log('held')
setInterval(() => {}, 1000)
`

function stop(holder) {
  const child = holder.child
  return new Promise((resolve) => {
    child.once('exit', resolve)
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.kill('SIGKILL')
  })
}

function hold(sessionPath, mode) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: root,
    env: { ...process.env, SESSION: sessionPath, MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let settled = false
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const held = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`holder did not start: ${output}`)), 5000)
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.stdout.on('data', () => { if (output.includes('held')) finish() })
    child.on('exit', (code) => finish(new Error(`holder exited ${code}: ${output}`)))
  })
  return { child, held }
}

test('serializes writes and publishes only after the record is durable', async () => {
  const dir = await workspace()
  const path = join(dir, 'session.jsonl')
  let gate
  const writes = []
  const seen = []
  const { session, close } = await openSession(path, {
    async write(line) {
      writes.push(line)
      if (writes.length === 1) await new Promise((resolve) => { gate = resolve })
    },
  })
  try {
    session.follow(0, (event) => seen.push(event.text))
    const first = session.append({ type: 'note', text: 'a' })
    const second = session.append({ type: 'note', text: 'b' })
    await tick()
    assert.deepEqual(writes.map((line) => JSON.parse(line).text), ['a'])
    assert.deepEqual(seen, [])
    assert.equal(session.events.length, 0)
    gate()
    const saved = await Promise.all([first, second])
    assert.deepEqual(saved.map((event) => event.seq), [1, 2])
    assert.deepEqual(seen, ['a', 'b'])
    assert.deepEqual(session.events.map((event) => event.text), ['a', 'b'])
  } finally { await close(); await rm(dir, { recursive: true, force: true }) }
})

test('follows history then live events and reconnects from the last sequence', async () => {
  const dir = await workspace()
  const path = join(dir, 'session.jsonl')
  const { session, close } = await openSession(path)
  try {
    await session.append({ type: 'note', text: 'one' })
    const seen = []
    const nested = []
    session.follow(0, (event) => {
      seen.push(event.seq)
      if (event.seq === 1) session.follow(0, (inner) => nested.push(inner.seq))
    })
    assert.deepEqual(seen, [1])
    assert.deepEqual(nested, [1])
    await session.append({ type: 'note', text: 'two' })
    assert.deepEqual(seen, [1, 2])
    assert.deepEqual(nested, [1, 2])
    const reconnected = []
    session.follow(seen.at(-1), (event) => reconnected.push(event.seq))
    assert.deepEqual(reconnected, [])
    await session.append({ type: 'note', text: 'three' })
    assert.deepEqual(reconnected, [3])
    assert.deepEqual(seen, [1, 2, 3])
  } finally { await close(); await rm(dir, { recursive: true, force: true }) }
})

test('a read-only observer refreshes committed records without taking the writer lock', async () => {
  const dir = await workspace()
  const path = join(dir, 'session.jsonl')
  const writer = await openSession(path)
  const reader = await openSession(path, { writable: false })
  try {
    const seen = []
    reader.session.follow(0, (event) => seen.push(event.seq))
    await writer.session.append({ type: 'note', text: 'live' })
    assert.deepEqual(seen, [])
    await reader.session.refresh()
    assert.deepEqual(seen, [1])
    assert.equal(reader.session.events[0].text, 'live')
    await reader.session.refresh()
    assert.deepEqual(seen, [1])
    await assert.rejects(reader.session.append({ type: 'note' }), /read-only/)
    await writer.session.append({ type: 'note', text: 'next' })
  } finally {
    await reader.close()
    await writer.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('checkpoint failure publishes nothing and does not run dependent work', async () => {
  const dir = await workspace()
  const path = join(dir, 'session.jsonl')
  let writes = 0
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Checkpoint),
    ctx.plugin(Session, {
      path,
      writable: true,
      clock: () => 't',
      write() { writes += 1; throw new Error('disk full') },
    }),
  ]
  try {
    await ready(fibers)
    const seen = []
    ctx.session.follow(0, () => seen.push('published'))
    let ran = false
    await assert.rejects(ctx.checkpoint.guard({ type: 'tool.started', callId: 'c1', name: 'shell' }, async () => { ran = true }), /disk full/)
    assert.equal(ran, false)
    assert.equal(writes, 1)
    assert.deepEqual(seen, [])
    assert.equal(ctx.session.events.length, 0)
    await assert.rejects(ctx.checkpoint.guard({ type: 'tool.started', callId: 'c1', name: 'shell' }, async () => { ran = true }), /dependent work is blocked/)
    assert.equal(ran, false)
    assert.equal(writes, 1)
    assert.equal(await readFile(path, 'utf8'), '')
  } finally {
    await Promise.all(fibers.map((fiber) => fiber.dispose()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('recovers a valid prefix, preserves an incomplete tail, and refuses corrupt records', async () => {
  const dir = await workspace()
  const path = join(dir, 'session.jsonl')
  const good = JSON.stringify({ seq: 1, type: 'note', time: 't', text: 'kept' }) + '\n'
  const tail = '{"seq":2,"type":"no'
  await writeFile(path, good + tail)
  const reader = await openSession(path, { writable: false })
  try {
    assert.equal(reader.session.events.length, 1)
    assert.equal(reader.session.incompleteTail.toString(), tail)
    assert.equal(await readFile(path, 'utf8'), good + tail)
    await assert.rejects(access(`${path}.incomplete`))
  } finally { await reader.close() }

  const writer = await openSession(path)
  try {
    assert.equal(writer.session.events.length, 1)
    assert.equal(writer.session.incompleteTail.toString(), tail)
    assert.equal(await readFile(`${path}.incomplete`, 'utf8'), tail)
    assert.equal(await readFile(path, 'utf8'), good)
    await writer.session.append({ type: 'note', text: 'next' })
    const events = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(events.map((event) => event.seq), [1, 2])
    assert.equal(events[1].text, 'next')
  } finally { await writer.close() }

  const whole = join(dir, 'partial-only.jsonl')
  await writeFile(whole, '{"seq":1"')
  const recovered = await openSession(whole)
  try {
    assert.equal(recovered.session.events.length, 0)
    assert.equal((await readFile(`${whole}.incomplete`)).toString(), '{"seq":1"')
    assert.equal(await readFile(whole, 'utf8'), '')
  } finally { await recovered.close() }

  for (const [name, body] of [
    ['corrupt', good + 'NOT JSON\n'],
    ['gap', good + JSON.stringify({ seq: 3, type: 'note' }) + '\n'],
    ['zero', JSON.stringify({ seq: 0, type: 'note' }) + '\n'],
    ['duplicate', good + JSON.stringify({ seq: 1, type: 'note' }) + '\n'],
    ['finish', JSON.stringify({ seq: 1, type: 'tool.finished', callId: 'c1' }) + '\n'],
  ]) {
    const broken = join(dir, `${name}.jsonl`)
    await writeFile(broken, body)
    const before = await readFile(broken)
    await assert.rejects(openSession(broken), /corrupt|sequence/)
    assert.deepEqual(await readFile(broken), before)
    await assert.rejects(access(`${broken}.incomplete`))
    await assert.rejects(access(`${broken}.lock`))
  }
  await rm(dir, { recursive: true, force: true })
})

test('an unknown tool outcome stays read-only after the writer lock is free', async () => {
  const dir = await workspace()
  const path = join(dir, 'session.jsonl')
  const holder = hold(path, 'tool')
  try {
    await holder.held
    await assert.rejects(acquireWriter(lockPathFor(path)), (error) => {
      assert.equal(error.code, 'SESSION_LOCKED')
      return true
    })
    const observer = await openSession(path, { writable: false })
    try {
      assert.equal(observer.session.events.at(-1).type, 'tool.started')
      assert.deepEqual(observer.session.unknown, ['shell-1'])
    } finally { await observer.close() }
  } finally { await stop(holder) }
  const reacquired = await acquireWriter(lockPathFor(path))
  reacquired.release()
  const blocked = await openSession(path, { writable: true })
  try {
    assert.equal(blocked.session.writable, false)
    assert.match(blocked.session.readonlyReason, /unknown tool outcome for shell-1/)
    await assert.rejects(blocked.session.append({ type: 'tool.finished', callId: 'shell-1', result: 'guess' }), /unknown tool outcome/)
    assert.equal(blocked.session.history().at(-1).type, 'tool.started')
  } finally { await blocked.close() }
  const fresh = await openSession(join(dir, 'next.jsonl'))
  try {
    const event = await fresh.session.append({ type: 'note', text: 'new session' })
    assert.equal(event.seq, 1)
  } finally { await fresh.close(); await rm(dir, { recursive: true, force: true }) }
})

test('a second process cannot write until the owner is gone, and a reader can', async () => {
  const dir = await workspace()
  const path = join(dir, 'session.jsonl')
  const holder = hold(path, 'hold')
  try {
    await holder.held
    const observer = await openSession(path, { writable: false })
    try { assert.equal(observer.session.events.at(-1).text, 'from-child') }
    finally { await observer.close() }
    await assert.rejects(openSession(path), /already held/)
  } finally { await stop(holder) }
  const next = await openSession(path)
  try {
    const event = await next.session.append({ type: 'note', text: 'after' })
    assert.equal(event.seq, 2)
    assert.equal(next.session.events[0].text, 'from-child')
  } finally { await next.close(); await rm(dir, { recursive: true, force: true }) }
})
