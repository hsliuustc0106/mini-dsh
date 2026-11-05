import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../src/boot.js'
import { installPlugin } from '../src/install-plugin.js'
import { loadProfileEntries, uninstallPlugin } from '../src/live-plugins.js'
import { fakeProvider } from '../src/provider.js'
import { createRequire } from 'node:module'
import { AGENT_SCOPE, SUPPORTED_HOOKS } from '../src/agents.js'

const loopModule = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent-loop')

const packedDatetime = '/tmp/dsh-message-datetime-0.1.3.tgz'

function projectMessages(messages) {
  return messages.map((message) => ({ role: message.role, content: message.content }))
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-hooks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('agents service is available and unsupported factory/hook APIs fail explicitly', async (t) => {
  const dir = await workspace(t)
  const app = await boot({ workspace: dir, web: false, provider: fakeProvider([{ role: 'assistant', content: 'hi' }]) })
  try {
    assert.ok(app.ctx.agents)
    assert.equal(app.ctx.agents.primary.id, 'mini-dsh')
    assert.deepEqual([...SUPPORTED_HOOKS], [
      'agent/session-start', 'agent/pre-step', 'agent/turn-stopping', 'agent/status', 'agent/error',
    ])
    assert.throws(() => app.ctx.agents.setFactory({}), /Agent factory is not supported/)
    await assert.rejects(app.ctx.agents.create({}), /agents.create is not supported/)
    await assert.rejects(app.ctx.agents.resume({}), /agents.resume is not supported/)
    assert.throws(() => app.ctx.agents.on('agent/request', async (_p, next) => next()), /Unsupported agent hook: agent\/request/)
    assert.throws(() => app.ctx.agents.on('agent/request-error', async (_p, next) => next()), /Unsupported agent hook: agent\/request-error/)
    assert.throws(() => app.ctx.agents.primary.followup({}), /agent.followup is not supported/)
    assert.throws(() => app.ctx.agents.primary.send({}), /agent.send is not supported/)
    assert.throws(() => app.ctx.agents.primary.cancel('stop'), /agent.cancel is not supported/)
    assert.throws(() => app.ctx.agents.requireInitiator(), /no initiating agent is active/)
  } finally { await app.dispose() }
})

test('agent/pre-step appends messages on step 1, records session events, and rejects close the turn', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'hook.mjs'), `
export const inject = ['agents']
export function apply(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.step !== 1) return decision
    if (payload.agent?.id !== 'mini-dsh') throw new Error('expected mini-dsh agent')
    return { ...decision, messages: [...decision.messages, { role: 'user', content: 'clock-reading' }] }
  }, { prepend: true })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'clock-hook', module: './hook.mjs' }],
  }))
  const model = fakeProvider([{ role: 'assistant', content: 'noted' }])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', web: false, provider: model })
  try {
    assert.equal(app.report.find((entry) => entry.name === 'clock-hook').state, 'active')
    await app.ctx.agent.turn('hello')
    const pre = app.ctx.session.events.filter((event) => event.type === 'agent.pre-step')
    assert.equal(pre.length, 1)
    assert.equal(pre[0].kind, 'enter')
    assert.equal(pre[0].added, 1)
    assert.ok(app.ctx.session.events.some((event) => event.type === 'turn/end' && event.turn === 1))
    assert.ok(app.ctx.session.messages.some((message) => message.content === 'clock-reading'))
    assert.ok(model.sent[0].messages.some((message) => message.content === 'clock-reading'))
  } finally { await app.dispose() }
})

test('pre-step reject skips the model and still records turn/end', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'reject.mjs'), `
export const inject = ['agents']
export function apply(ctx) {
  ctx.on('agent/pre-step', async () => ({ kind: 'reject' }), { prepend: true })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'reject-hook', module: './reject.mjs' }],
  }))
  const model = fakeProvider([{ role: 'assistant', content: 'should-not-run' }])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', web: false, provider: model })
  try {
    await app.ctx.agent.turn('block me')
    assert.equal(model.sent.length, 0)
    assert.equal(app.ctx.session.events.find((event) => event.type === 'agent.pre-step').kind, 'reject')
    assert.ok(app.ctx.session.events.some((event) => event.type === 'turn/end'))
  } finally { await app.dispose() }
})

test('unsupported pre-step mutation that replaces the baseline fails explicitly', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'mutate.mjs'), `
export const inject = ['agents']
export function apply(ctx) {
  ctx.on('agent/pre-step', async () => ({ kind: 'enter', messages: [{ role: 'user', content: 'replaced' }] }), { prepend: true })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'mutate-hook', module: './mutate.mjs' }],
  }))
  const app = await boot({
    workspace: dir,
    pluginConfig: 'plugins.json',
    web: false,
    provider: fakeProvider([{ role: 'assistant', content: 'x' }]),
  })
  try {
    await assert.rejects(app.ctx.agent.turn('hello'), /Unsupported pre-step mutation/)
  } finally { await app.dispose() }
})

test('live-mounted pre-step hook is removed on unmount', async (t) => {
  const dir = await workspace(t)
  const pkg = join(dir, 'package')
  await mkdir(pkg)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({
    name: 'live-clock', version: '1.0.0', type: 'module', main: 'index.js',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(pkg, 'cordis.patch.yml'), '- insert:\n    - id: live-clock\n      name: live-clock\n')
  await writeFile(join(pkg, 'index.js'), `
export const inject = ['agents']
export function apply(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.step !== 1) return decision
    return { ...decision, messages: [...decision.messages, { role: 'user', content: 'live-reading' }] }
  }, { prepend: true })
}
`)
  const archive = join(dir, execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], {
    cwd: pkg, encoding: 'utf8',
  }).trim())

  const model = fakeProvider([
    { role: 'assistant', content: 'first' },
    { role: 'assistant', content: 'second' },
  ])
  const app = await boot({ workspace: dir, web: false, provider: model })
  try {
    const installed = await installPlugin(archive, dir)
    const entries = await loadProfileEntries(installed.configPath, installed.names)
    await app.ctx.livePlugins.mountAll(entries)
    await app.ctx.agent.turn('one')
    assert.ok(model.sent[0].messages.some((message) => message.content === 'live-reading'))

    await app.ctx.livePlugins.unmount(installed.names[0])
    await app.ctx.agent.turn('two')
    const preSteps = app.ctx.session.events.filter((event) => event.type === 'agent.pre-step')
    assert.equal(preSteps[0].added, 1)
    assert.equal(preSteps[1].added, 0)
    // History still contains the first reading; unmount must not inject a second one.
    assert.equal(model.sent[1].messages.filter((message) => message.content === 'live-reading').length, 1)
  } finally { await app.dispose() }
})

test('unmodified dsh-message-datetime injects a reading on a real turn', async (t) => {
  const dir = await workspace(t)
  // Prefer a previously packed tarball from the box; otherwise pack from npm cache.
  let archive = packedDatetime
  try {
    execFileSync('test', ['-f', archive])
  } catch {
    archive = join(dir, execFileSync('npm', ['pack', 'dsh-message-datetime@0.1.3', '--silent', '--pack-destination', dir], {
      encoding: 'utf8',
    }).trim())
  }
  const model = fakeProvider([{ role: 'assistant', content: 'thanks for the time' }])
  const app = await boot({ workspace: dir, web: false, provider: model })
  try {
    const installed = await installPlugin(archive, dir)
    const entries = await loadProfileEntries(installed.configPath, installed.names)
    const reports = await app.ctx.livePlugins.mountAll(entries)
    assert.equal(reports[0].state, 'active', JSON.stringify(reports))
    await app.ctx.agent.turn('what time is it conceptually')
    const pre = app.ctx.session.events.find((event) => event.type === 'agent.pre-step')
    assert.equal(pre.kind, 'enter')
    assert.equal(pre.added, 1)
    const reading = model.sent[0].messages.find((message) => typeof message.content === 'string' && /UTC|GMT|[A-Z][a-z]+day|\d{1,2}:\d{2}/.test(message.content))
    assert.ok(reading, `expected a datetime reading in model messages: ${JSON.stringify(model.sent[0].messages)}`)
    const stored = app.ctx.session.messages.find((message) => message.source?.kind === 'dsh-message-datetime')
    assert.equal(stored.content, reading.content)
    const ends = app.ctx.agents.primary.session.snapshotEvents().filter((event) => event.type === 'turn/end')
    assert.equal(ends.length, 1)
    assert.equal(typeof ends[0].time, 'number')
  } finally { await app.dispose() }
})

test('built-in agents cannot be unmounted or uninstalled', async (t) => {
  const dir = await workspace(t)
  const app = await boot({ workspace: dir, web: false, provider: fakeProvider([{ role: 'assistant', content: 'hi' }]) })
  try {
    await assert.rejects(app.ctx.livePlugins.unmount('agents'), /Built-in plugin cannot be unmounted: agents/)
    await assert.rejects(uninstallPlugin('agents', dir), /Built-in plugin cannot be uninstalled: agents/)
  } finally { await app.dispose() }
})

test('hook-injected content replays from the JSONL log and is not re-run under a different clock', async (t) => {
  const dir = await workspace(t)
  const sessionPath = join(dir, 'session.jsonl')
  await writeFile(join(dir, 'stamp-hook.mjs'), `
export const inject = ['agents']
export function apply(ctx, config = {}) {
  const stamp = config.stamp ?? 'missing'
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.step !== 1) return decision
    return { ...decision, messages: [...decision.messages, { role: 'user', content: 'reading@' + stamp }] }
  }, { prepend: true })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'stamp-hook', module: './stamp-hook.mjs', config: { stamp: 'clock-A' } }],
  }))

  const recorded = fakeProvider([{ role: 'assistant', content: 'noted-A' }])
  const writer = await boot({
    workspace: dir,
    sessionPath,
    pluginConfig: 'plugins.json',
    web: false,
    clock: () => '2026-01-01T00:00:00.000Z',
    provider: recorded,
  })
  let firstProjection
  try {
    await writer.ctx.agent.turn('hello')
    assert.ok(writer.ctx.session.messages.some((message) => message.content === 'reading@clock-A'))
    assert.ok(recorded.sent[0].messages.some((message) => message.content === 'reading@clock-A'))
    firstProjection = projectMessages(writer.ctx.session.messages)
  } finally { await writer.dispose() }

  // Replay: reopen the same log with a different clock and a hook config that
  // would inject clock-B if the hook re-ran. Projection must stay identical.
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'stamp-hook', module: './stamp-hook.mjs', config: { stamp: 'clock-B' } }],
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
    assert.equal(reader.report.find((entry) => entry.name === 'stamp-hook').state, 'active')
    assert.deepEqual(projectMessages(reader.ctx.session.messages), firstProjection)
    assert.equal(reader.ctx.session.messages.some((message) => message.content === 'reading@clock-B'), false)
    assert.ok(reader.ctx.session.messages.some((message) => message.content === 'reading@clock-A' && message.source?.form === 'hook'))
    assert.throws(() => reader.ctx.agents.primary.inject({ content: 'replay' }), (error) => error.code === 'READONLY')
    assert.ok(reader.ctx.session.events.some((event) => event.type === 'turn/end'))
    assert.equal(reader.ctx.session.events.some((event) => event.type === 'agent.session-start'), false)
    // Event times stay from the recording clock, not the replay clock.
    assert.ok(reader.ctx.session.events.every((event) => event.time === '2026-01-01T00:00:00.000Z'))
  } finally { await reader.dispose() }
})

test('session-start injects startup context, contains listener errors, and resumes once', async (t) => {
  const dir = await workspace(t)
  const sessionPath = join(dir, 'session.jsonl')
  await writeFile(join(dir, 'start.mjs'), `
export const inject = ['agents']
let starts = 0
export function apply(ctx) {
  ctx.on('agent/session-start', ({ agent, source }) => {
    starts += 1
    if (source === 'startup') throw new Error('session-start hook broke')
    agent.inject({ role: 'user', content: 'resumed-' + source, source: { kind: 'plugin', form: 'preamble' } })
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent.status !== 'running') throw new Error('expected running status during pre-step')
    if (ctx.agents.currentInitiator()?.id !== 'mini-dsh') throw new Error('expected initiator')
    if (ctx.agents.withoutInitiator(() => ctx.agents.currentInitiator())) throw new Error('initiator leaked')
    return next()
  })
}
export function startsSeen() { return starts }
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'start-hook', module: './start.mjs' }],
  }))
  const first = fakeProvider([
    { role: 'assistant', content: 'ok' },
    { role: 'assistant', content: 'ok-2' },
  ])
  const writer = await boot({ workspace: dir, sessionPath, pluginConfig: 'plugins.json', web: false, provider: first })
  try {
    const seen = []
    writer.ctx.on('agent/status', ({ status }) => seen.push(status))
    await writer.ctx.agent.turn('hello')
    await writer.ctx.agent.turn('again')
    assert.deepEqual(seen, ['running', 'idle', 'running', 'idle'])
    assert.equal(first.sent.length, 2)
    assert.equal(writer.ctx.session.messages.some((message) => message.content === 'resumed-startup'), false)
    assert.equal(writer.ctx.agents.currentInitiator(), undefined)
  } finally { await writer.dispose() }

  const second = fakeProvider([{ role: 'assistant', content: 'later' }])
  const resumed = await boot({ workspace: dir, sessionPath, pluginConfig: 'plugins.json', web: false, provider: second })
  try {
    await resumed.ctx.agent.turn('next')
    assert.equal(second.sent.length, 1)
    assert.ok(second.sent[0].messages.some((message) => message.content === 'resumed-resume'))
    assert.equal(resumed.ctx.session.messages.filter((message) => message.content === 'resumed-resume').length, 1)
    const agents = resumed.ctx.agents
    await resumed.dispose()
    assert.throws(() => agents.currentInitiator(), /agent initiator scope is disposed/)
  } catch (error) {
    await resumed.dispose()
    throw error
  }
})

test('pre-step can replace an uncommitted entry and fail closed on history, non-text, and request series', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'entry.mjs'), `
export const inject = ['agents']
export function apply(ctx) {
  ctx.on('agent/session-start', ({ agent }) => {
    agent.inject({ role: 'user', content: [{ type: 'text', text: 'preamble' }], source: { kind: 'plugin', form: 'preamble' } })
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const history = payload.messages.slice(0, payload.committed)
    return {
      kind: 'enter',
      messages: [...history, { role: 'user', content: 'rewritten', source: { kind: 'plugin', form: 'rewrite' } }],
    }
  }, { prepend: true })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'entry-hook', module: './entry.mjs' }],
  }))
  const model = fakeProvider([{ role: 'assistant', content: 'ok' }])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', web: false, provider: model })
  try {
    await app.ctx.agent.turn('hello')
    assert.equal(app.ctx.session.messages.some((message) => message.content === 'preamble'), false)
    const rewritten = app.ctx.session.messages.find((message) => message.content === 'rewritten')
    assert.equal(rewritten.source.form, 'rewrite')
    assert.ok(model.sent[0].messages.some((message) => message.content === 'hello'))
    assert.ok(model.sent[0].messages.some((message) => message.content === 'rewritten'))
    assert.equal(model.sent[0].messages.some((message) => message.source), false)
  } finally { await app.dispose() }

  await writeFile(join(dir, 'bad.mjs'), `
export function apply(ctx) {
  ctx.on('agent/pre-step', async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'image' }] }], startsRequestSeries: true }), { prepend: true })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'bad-hook', module: './bad.mjs' }] }))
  const blocked = await boot({
    workspace: dir, session: join(dir, 'other.jsonl'), pluginConfig: 'plugins.json', web: false,
    provider: fakeProvider([{ role: 'assistant', content: 'no' }]),
  })
  try {
    await assert.rejects(blocked.ctx.agent.turn('hello'), /Unsupported pre-step field: startsRequestSeries/)
    assert.equal(blocked.ctx.session.events.some((event) => event.type === 'agent.error'), true)
    assert.ok(blocked.ctx.session.events.some((event) => event.type === 'turn/end'))
  } finally { await blocked.dispose() }

  await writeFile(join(dir, 'image.mjs'), `
export function apply(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    return { kind: 'enter', messages: [...decision.messages, { role: 'user', content: [{ type: 'image' }] }] }
  }, { prepend: true })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'image-hook', module: './image.mjs' }] }))
  const images = await boot({
    workspace: dir, session: join(dir, 'images.jsonl'), pluginConfig: 'plugins.json', web: false,
    provider: fakeProvider([{ role: 'assistant', content: 'no' }]),
  })
  try {
    await assert.rejects(images.ctx.agent.turn('hello'), /Unsupported hook message content: image/)
    assert.equal(images.ctx.session.messages.some((message) => message.content === 'hello'), true)
  } finally { await images.dispose() }
})

test('steer continues the turn and inject waits; reject drops the claimed tail only', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'steer.mjs'), `
export const inject = ['agents']
export function apply(ctx) {
  let steered = false
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (steered) return
    steered = true
    agent.steer({ role: 'user', content: 'go on', source: { kind: 'user', form: 'steer' } })
    agent.inject({ role: 'user', content: 'after-stop', source: { kind: 'plugin', form: 'later' } })
  })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'steer-hook', module: './steer.mjs' }] }))
  const model = fakeProvider([
    { role: 'assistant', content: 'partial' },
    { role: 'assistant', content: 'done' },
    { role: 'assistant', content: 'next-turn' },
  ])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', web: false, provider: model })
  try {
    await app.ctx.agent.turn('hello')
    assert.equal(model.sent.length, 2)
    assert.equal(model.sent[0].messages.some((message) => message.content === 'go on'), false)
    assert.ok(model.sent[1].messages.some((message) => message.content === 'go on'))
    assert.ok(model.sent[1].messages.some((message) => message.content === 'after-stop'))
    assert.equal(app.ctx.session.events.filter((event) => event.type === 'turn/end').length, 1)
    assert.equal(app.ctx.session.events.find((event) => event.type === 'turn/end').steps, 2)
    const steer = app.ctx.session.messages.find((message) => message.content === 'go on')
    assert.equal(steer.source.form, 'steer')
  } finally { await app.dispose() }

  await writeFile(join(dir, 'inject-only.mjs'), `
export const inject = ['agents']
export function apply(ctx) {
  ctx.on('agent/turn-stopping', ({ agent }) => {
    agent.inject({ role: 'user', content: 'after-stop', source: { kind: 'plugin', form: 'later' } })
  })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'inject-only', module: './inject-only.mjs' }] }))
  const waiting = fakeProvider([
    { role: 'assistant', content: 'done' },
    { role: 'assistant', content: 'next-turn' },
  ])
  const later = await boot({
    workspace: dir, session: join(dir, 'later.jsonl'), pluginConfig: 'plugins.json', web: false, provider: waiting,
  })
  try {
    await later.ctx.agent.turn('hello')
    assert.equal(waiting.sent.length, 1)
    assert.equal(waiting.sent[0].messages.some((message) => message.content === 'after-stop'), false)
    await later.ctx.agent.turn('second')
    assert.ok(waiting.sent[1].messages.some((message) => message.content === 'after-stop'))
  } finally { await later.dispose() }

  await writeFile(join(dir, 'reject-entry.mjs'), `
export const inject = ['agents']
export function apply(ctx) {
  ctx.on('agent/session-start', ({ agent }) => {
    agent.inject({ content: 'claimed-preamble', source: { kind: 'plugin', form: 'preamble' } })
  })
  let reject = true
  ctx.on('agent/pre-step', async (payload, next) => {
    if (!reject) return next()
    reject = false
    payload.agent.inject({ content: 'kept-later', source: { kind: 'plugin', form: 'later' } })
    return { kind: 'reject' }
  }, { prepend: true })
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'reject-entry', module: './reject-entry.mjs' }] }))
  const rejected = fakeProvider([{ role: 'assistant', content: 'after' }])
  const second = await boot({
    workspace: dir, session: join(dir, 'reject.jsonl'), pluginConfig: 'plugins.json', web: false, provider: rejected,
  })
  try {
    await second.ctx.agent.turn('block')
    assert.equal(rejected.sent.length, 0)
    assert.equal(second.ctx.session.messages.some((message) => message.content === 'claimed-preamble'), false)
    await second.ctx.agent.turn('allow')
    assert.ok(rejected.sent[0].messages.some((message) => message.content === 'kept-later'))
    assert.equal(rejected.sent[0].messages.some((message) => message.content === 'claimed-preamble'), false)
  } finally { await second.dispose() }
})

test('agent-scoped listeners do not see another scope and leave with their fiber', async (t) => {
  const dir = await workspace(t)
  const app = await boot({ workspace: dir, web: false, provider: fakeProvider([
    { role: 'assistant', content: 'one' },
    { role: 'assistant', content: 'two' },
  ]) })
  try {
    let scoped = 0
    let root = 0
    let foreign = 0
    const scopedFiber = app.ctx.agents.primary.ctx.plugin({
      apply(ctx) { ctx.on('agent/status', () => { scoped += 1 }) },
    })
    await scopedFiber.await()
    app.ctx.on('agent/status', () => { root += 1 })
    const other = app.ctx.extend({ [AGENT_SCOPE]: { id: 'other' } })
    const foreignFiber = other.plugin({
      apply(ctx) { ctx.on('agent/status', () => { foreign += 1 }) },
    })
    await foreignFiber.await()
    await app.ctx.agent.turn('one')
    assert.equal(scoped, 2)
    assert.equal(root, 2)
    assert.equal(foreign, 0)
    await scopedFiber.dispose()
    await app.ctx.agent.turn('two')
    assert.equal(scoped, 2)
    assert.equal(root, 4)
    assert.equal(foreign, 0)
  } finally { await app.dispose() }
})

test('the official agent-loop bridge does not dispatch mini-dsh agent hooks', async (t) => {
  const dir = await workspace(t)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [{ name: 'official-loop', module: loopModule }],
  }))
  const model = fakeProvider([{ role: 'assistant', content: 'from the bridge' }])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', web: false, provider: model })
  try {
    let hooks = 0
    app.ctx.on('agent/session-start', () => { hooks += 1 })
    app.ctx.on('agent/pre-step', () => { hooks += 1 })
    app.ctx.on('agent/turn-stopping', () => { hooks += 1 })
    app.ctx.on('agent/status', () => { hooks += 1 })
    await app.ctx.agent.turn('Hello')
    assert.equal(hooks, 0)
    assert.equal(app.ctx.agents.primary.status, 'idle')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'agent.pre-step'), false)
    assert.throws(() => app.ctx.agents.primary.inject({ content: 'bridge' }), /official DSH agent loop/)
    assert.equal(model.sent.length, 1)
    assert.equal(app.ctx.session.messages.at(-1).content, 'from the bridge')
  } finally { await app.dispose() }
})
