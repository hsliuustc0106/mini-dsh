import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../src/boot.js'
import { installPlugin } from '../src/install-plugin.js'
import { loadProfileEntries } from '../src/live-plugins.js'
import { fakeProvider } from '../src/provider.js'
import { SUPPORTED_HOOKS } from '../src/agents.js'

const packedDatetime = '/tmp/dsh-message-datetime-0.1.3.tgz'

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
    assert.deepEqual([...SUPPORTED_HOOKS], ['agent/pre-step'])
    assert.throws(() => app.ctx.agents.setFactory({}), /Agent factory is not supported/)
    await assert.rejects(app.ctx.agents.create({}), /agents.create is not supported/)
    await assert.rejects(app.ctx.agents.resume({}), /agents.resume is not supported/)
    assert.throws(() => app.ctx.agents.on('agent/request', async (_p, next) => next()), /Unsupported agent hook: agent\/request/)
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
  } finally { await app.dispose() }
})
