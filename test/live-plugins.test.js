import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../src/boot.js'
import { composition } from '../src/composition.js'
import { installPlugin } from '../src/install-plugin.js'
import { CORDIS_PIN, LivePlugins, loadProfileEntries, uninstallPlugin } from '../src/live-plugins.js'
import { fakeProvider } from '../src/provider.js'

async function packToolPlugin(dir, { name = 'live-tool', tool = 'live_echo' } = {}) {
  const pkg = join(dir, 'package')
  await mkdir(pkg)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({
    name, version: '1.0.0', type: 'module', main: 'index.js',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(pkg, 'cordis.patch.yml'), `- insert:\n    - id: ${name.replace(/[^A-Za-z0-9_.-]/g, '-')}\n      name: ${name}\n`)
  await writeFile(join(pkg, 'index.js'), `let disposed = false
export function wasDisposed() { return disposed }
export const inject = ['tools']
export function apply(ctx) {
  ctx.effect(() => {
    disposed = false
    ctx.tools.register({
      name: ${JSON.stringify(tool)},
      description: 'live plugin tool',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => 'live-ok',
    })
    return () => { disposed = true }
  })
}
`)
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
  return { archive: join(dir, archive), pkg }
}

test('live install mounts a tool, uninstall disposes it, and reinstall restores it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  const { archive } = await packToolPlugin(dir)
  const app = await boot({ workspace, web: false, provider: fakeProvider([]) })
  try {
    assert.equal(app.ctx.tools.items.has('live_echo'), false)
    const installed = await installPlugin(archive, workspace)
    const entries = await loadProfileEntries(installed.configPath, installed.names)
    const reports = await app.ctx.livePlugins.mountAll(entries)
    assert.equal(reports[0].state, 'active')
    assert.ok(app.ctx.tools.items.has('live_echo'))
    assert.equal((await app.ctx.permissions.decide({ name: 'live_echo', arguments: {} })).decision, 'deny')
    const mountedEvents = app.ctx.session.events.filter((event) => event.type === 'plugin.mounted')
    assert.equal(mountedEvents.at(-1).name, installed.names[0])

    await app.ctx.livePlugins.unmount(installed.names[0])
    await uninstallPlugin(installed.names[0], workspace, { configPath: installed.configPath })
    assert.equal(app.ctx.tools.items.has('live_echo'), false)
    assert.ok(app.ctx.session.events.some((event) => event.type === 'plugin.unmounted' && event.name === installed.names[0]))
    assert.equal(JSON.parse(await readFile(installed.configPath, 'utf8')).plugins.some((row) => row.name === installed.names[0]), false)

    const again = await installPlugin(archive, workspace)
    const restored = await app.ctx.livePlugins.mountAll(await loadProfileEntries(again.configPath, again.names))
    assert.equal(restored[0].state, 'active')
    assert.ok(app.ctx.tools.items.has('live_echo'))
  } finally { await app.dispose() }
})

test('unsupported live mounts fail explicitly without leaving a partial mount', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-bad-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  await writeFile(join(dir, 'broken.mjs'), `
export default {
  inject: ['tools'],
  apply(ctx) {
    ctx.effect(() => ctx.tools.register({
      name: 'broken_tool',
      description: 'broken',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => 'nope',
    }))
    throw new Error('activation boom')
  },
}
`)
  const profile = join(workspace, '.mini-dsh', 'plugins.json')
  await mkdir(join(workspace, '.mini-dsh'), { recursive: true })
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'broken', module: join(dir, 'broken.mjs') }] }, null, 2))
  const app = await boot({ workspace, provider: fakeProvider([]) })
  try {
    const entries = await loadProfileEntries(profile, ['broken'])
    await assert.rejects(app.ctx.livePlugins.mountAll(entries), /activation boom/)
    assert.equal(app.ctx.livePlugins.changing, false)
    assert.equal(app.ctx.tools.items.has('broken_tool'), false)
    assert.equal(app.ctx.livePlugins.list().some((row) => row.name === 'broken'), false)
    assert.ok(app.ctx.session.events.some((event) => event.type === 'plugin.failed' && event.name === 'broken'))
  } finally { await app.dispose() }
})

test('live changes refuse while a turn is in progress', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-busy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const provider = fakeProvider([{
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'x.txt', content: '1' }) } }],
  }, { role: 'assistant', content: 'done' }])
  // Replace write execute by delaying through approval.
  const app = await boot({
    workspace,
    provider,
    approve: async () => { await gate; return true },
  })
  try {
    const turn = app.ctx.agent.turn('write something')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(app.ctx.agent.busy, true)
    await writeFile(join(dir, 'extra.mjs'), `export default { inject: ['tools'], apply(ctx) { ctx.effect(() => ctx.tools.register({ name: 'extra_tool', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => 'x' })) } }`)
    const profile = join(workspace, 'plugins.json')
    await writeFile(profile, JSON.stringify({ plugins: [{ name: 'extra', module: join(dir, 'extra.mjs') }] }))
    await assert.rejects(app.ctx.livePlugins.mountAll(await loadProfileEntries(profile, ['extra'])), /turn is in progress/)
    release()
    await turn
  } finally { await app.dispose() }
})

test('direct mounts and unmounts reserve the agent until setup or disposal completes', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-reservation-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const app = await boot({ workspace, provider: fakeProvider([{ role: 'assistant', content: 'ok' }]) })
  let startSetup, finishSetup, startDispose, finishDispose
  const setupStarted = new Promise((resolve) => { startSetup = resolve })
  const setupGate = new Promise((resolve) => { finishSetup = resolve })
  const disposeStarted = new Promise((resolve) => { startDispose = resolve })
  const disposeGate = new Promise((resolve) => { finishDispose = resolve })
  const plugin = { async apply(ctx) {
    startSetup()
    await setupGate
    ctx.effect(() => async () => { startDispose(); await disposeGate })
  } }
  try {
    const mounting = app.ctx.livePlugins.mount({ name: 'slow', plugin })
    await setupStarted
    assert.throws(() => app.ctx.agent.turn('during mount'), /plugin change is already in progress/)
    await assert.rejects(app.ctx.livePlugins.mount({ name: 'other', plugin: { apply() {} } }), /plugin change is already in progress/)
    finishSetup()
    await mounting
    const unmounting = app.ctx.livePlugins.unmount('slow')
    await disposeStarted
    assert.throws(() => app.ctx.agent.turn('during unmount'), /plugin change is already in progress/)
    finishDispose()
    await unmounting
    await app.ctx.agent.turn('afterwards')
  } finally { finishSetup(); finishDispose(); await app.dispose() }
})

test('web installation reserves turns throughout package installation and activation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-install-reservation-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  const { archive } = await packToolPlugin(dir)
  const app = await boot({ workspace, web: { port: 0 }, provider: fakeProvider([{ role: 'assistant', content: 'ok' }]) })
  try {
    const url = app.ctx.webControl.url
    const installing = fetch(`${url}/plugins/install`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ spec: archive }) })
    const deadline = Date.now() + 3000
    while (!app.ctx.webControl.installing && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(app.ctx.webControl.installing, true)
    assert.throws(() => app.ctx.agent.turn('during install'), /plugin change is already in progress/)
    const response = await installing
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    await app.ctx.agent.turn('after install')
  } finally { await app.dispose() }
})

test('web installation refuses before writing the profile when a turn is active', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-install-busy-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  let approveStarted, release
  const started = new Promise((resolve) => { approveStarted = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const provider = fakeProvider([
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'x', content: 'ok' }) } }] },
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({ workspace, web: { port: 0 }, provider, approve: async () => { approveStarted(); await gate; return false } })
  try {
    const turn = app.ctx.agent.turn('write')
    await started
    const url = app.ctx.webControl.url
    const response = await fetch(`${url}/plugins/install`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ spec: 'example-plugin' }) })
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /turn is in progress/)
    await assert.rejects(readFile(join(workspace, '.mini-dsh/plugins.json')), { code: 'ENOENT' })
    release()
    await turn
  } finally { release(); await app.dispose() }
})

test('web install activates without restart and uninstall removes the tool', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-web-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  const { archive } = await packToolPlugin(dir, { name: 'web-live-tool', tool: 'web_live_echo' })
  const app = await boot({ workspace, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    const url = app.ctx.webControl.url
    const installed = await fetch(`${url}/plugins/install`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json' },
      body: JSON.stringify({ spec: archive }),
    })
    const body = await installed.json()
    assert.equal(installed.status, 200, body.error)
    assert.equal(body.restartRequired, false)
    assert.equal(body.phase, 'active')
    assert.ok(app.ctx.tools.items.has('web_live_echo'))
    const listed = await (await fetch(`${url}/plugins`)).json()
    assert.ok(listed.plugins.some((row) => row.name === body.names[0] && row.state === 'active'))

    const removed = await fetch(`${url}/plugins/uninstall`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json' },
      body: JSON.stringify({ name: body.names[0] }),
    })
    const removedBody = await removed.json()
    assert.equal(removed.status, 200, removedBody.error)
    assert.equal(app.ctx.tools.items.has('web_live_echo'), false)
  } finally { await app.dispose() }
})

async function writeToolModule(dir, name, tool) {
  const file = join(dir, `${name}.mjs`)
  await writeFile(file, `export default {
  inject: ['tools'],
  apply(ctx) {
    ctx.effect(() => ctx.tools.register({
      name: ${JSON.stringify(tool)},
      description: 'live',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => 'ok',
    }))
  },
}
`)
  return file
}

async function disposeLivePlugins(app) {
  const runtime = app.ctx.registry.get(LivePlugins)
  assert.ok(runtime, 'live-plugins runtime missing')
  for (const fiber of [...runtime.fibers]) await fiber.dispose()
}

test('disposing livePlugins removes live-mounted tools', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-svc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  const module = await writeToolModule(dir, 'owned', 'owned_tool')
  const profile = join(workspace, 'plugins.json')
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'owned', module }] }))
  const app = await boot({ workspace, provider: fakeProvider([]) })
  try {
    await app.ctx.livePlugins.mountAll(await loadProfileEntries(profile, ['owned']))
    assert.ok(app.ctx.tools.items.has('owned_tool'))
    await disposeLivePlugins(app)
    assert.equal(app.ctx.tools.items.has('owned_tool'), false)
  } finally { await app.dispose() }
})

test('manual unmount then livePlugins dispose emits one unmounted and does not double-dispose', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-once-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  const module = await writeToolModule(dir, 'once', 'once_tool')
  const profile = join(workspace, 'plugins.json')
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'once', module }] }))
  const app = await boot({ workspace, provider: fakeProvider([]) })
  try {
    await app.ctx.livePlugins.mountAll(await loadProfileEntries(profile, ['once']))
    await app.ctx.livePlugins.unmount('once')
    assert.equal(app.ctx.tools.items.has('once_tool'), false)
    await disposeLivePlugins(app)
    const unmounted = app.ctx.session.events.filter((event) => event.type === 'plugin.unmounted' && event.name === 'once')
    assert.equal(unmounted.length, 1)
  } finally { await app.dispose() }
})

test('pins Cordis 4.0.5 fiber internals used by live plugins and boot', async () => {
  const pkg = JSON.parse(await readFile(new URL('../node_modules/@deepseek-ai/cordis/package.json', import.meta.url)))
  assert.equal(pkg.version, CORDIS_PIN)
  const declared = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).dependencies['@deepseek-ai/cordis']
  assert.equal(declared, CORDIS_PIN)
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-pin-'))
  try {
    const workspace = join(dir, 'workspace')
    await mkdir(workspace)
    const module = await writeToolModule(dir, 'pin', 'pin_tool')
    const profile = join(workspace, 'plugins.json')
    await writeFile(profile, JSON.stringify({ plugins: [{ name: 'pin', module }] }))
    const app = await boot({ workspace, provider: fakeProvider([]) })
    try {
      const [report] = await app.ctx.livePlugins.mountAll(await loadProfileEntries(profile, ['pin']))
      assert.equal(report.state, 'active')
      const listed = app.ctx.livePlugins.list().find((row) => row.name === 'pin')
      assert.equal(listed.state, 'active')
      assert.equal(listed.missing.length, 0)
    } finally { await app.dispose() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('same-install replace + disabled insert activates only enabled unique names', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-names-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'package'), workspace = join(dir, 'workspace')
  await mkdir(pkg); await mkdir(workspace)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({
    name: 'names-bundle', version: '1.0.0', type: 'module', main: 'index.js',
    dsh: { bundle: { patch: 'patch.yml' } },
  }))
  await writeFile(join(pkg, 'patch.yml'), `- insert:
    - id: example
      name: names-bundle
      config:
        mode: initial
- id: example
  config:
    mode: replaced
- insert:
    - id: extra
      name: names-bundle
      disabled: true
`)
  await writeFile(join(pkg, 'index.js'), `export const inject = ['tools']
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'names_echo', description: 'n', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'ok',
  }))
}
`)
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
  const app = await boot({ workspace, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    const url = app.ctx.webControl.url
    const response = await fetch(`${url}/plugins/install`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json' },
      body: JSON.stringify({ spec: join(dir, archive) }),
    })
    const body = await response.json()
    assert.equal(response.status, 200, body.error)
    assert.equal(body.phase, 'active')
    assert.deepEqual(body.names, ['example'])
    assert.deepEqual(body.installedNames, ['example', 'extra'])
    assert.ok(app.ctx.tools.items.has('names_echo'))
    assert.equal(JSON.parse(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8')).plugins.find((row) => row.name === 'extra').enabled, false)
    const listed = await (await fetch(`${url}/plugins`)).json()
    assert.ok(listed.plugins.some((row) => row.name === 'example' && row.state === 'active'))
    assert.ok(listed.plugins.some((row) => row.name === 'extra' && row.state === 'disabled'))
  } finally { await app.dispose() }
})

test('uninstall refuses when required dependents need a provided service; profile stays restartable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-deps-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  await writeFile(join(dir, 'provider.mjs'), `
export default {
  apply(ctx) { ctx.provide('demoSkills', { list: () => ['alpha'] }) },
}
`)
  await writeFile(join(dir, 'consumer.mjs'), `
export const inject = ['demoSkills', 'tools']
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'demo_themes',
    description: 'needs demoSkills',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ctx.demoSkills.list().join(','),
  }))
}
`)
  await writeFile(join(dir, 'unrelated.mjs'), `
export const inject = ['tools']
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'unrelated_tool',
    description: 'independent',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'solo',
  }))
}
`)
  const profile = join(workspace, '.mini-dsh', 'plugins.json')
  await mkdir(join(workspace, '.mini-dsh'), { recursive: true })
  await writeFile(profile, JSON.stringify({
    plugins: [
      { name: 'demo-skills', module: join(dir, 'provider.mjs') },
      { name: 'demo-ppt', module: join(dir, 'consumer.mjs') },
      { name: 'demo-qr', module: join(dir, 'unrelated.mjs') },
      { name: 'default-tool-permissions', config: { policies: { demo_themes: 'allow', unrelated_tool: 'allow' } } },
    ],
  }, null, 2))

  const model = fakeProvider([
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'demo_themes', arguments: '{}' } }] },
    { role: 'assistant', content: 'themes-done' },
  ])
  const app = await boot({ workspace, pluginConfig: profile, web: { port: 0 }, provider: model })
  try {
    assert.equal(app.report.find((row) => row.name === 'demo-ppt').state, 'active')
    assert.ok(app.ctx.tools.items.has('demo_themes'))
    assert.ok(app.ctx.tools.items.has('unrelated_tool'))
    await app.ctx.agent.turn('themes')
    assert.equal(app.ctx.session.events.find((event) => event.type === 'tool.finished').result, 'alpha')

    const url = app.ctx.webControl.url
    const refused = await fetch(`${url}/plugins/uninstall`, {
      method: 'POST',
      headers: { origin: url, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo-skills' }),
    })
    const refusedBody = await refused.json()
    assert.equal(refused.status, 400, JSON.stringify(refusedBody))
    assert.match(refusedBody.error, /Cannot uninstall demo-skills/)
    assert.match(refusedBody.error, /demo-ppt/)
    assert.match(refusedBody.error, /demoSkills/)
    assert.equal(refusedBody.code, 'PLUGIN_DEPENDENTS')
    assert.deepEqual(refusedBody.dependents, [{ name: 'demo-ppt', services: ['demoSkills'], removable: true }])
    assert.equal(JSON.parse(await readFile(profile, 'utf8')).plugins.some((row) => row.name === 'demo-skills'), true)
    assert.equal(app.ctx.livePlugins.list().find((row) => row.name === 'demo-ppt').state, 'active')
    assert.ok(app.ctx.tools.items.has('demo_themes'))
    assert.ok(app.ctx.tools.items.has('unrelated_tool'))
  } finally { await app.dispose() }

  const again = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try {
    assert.equal(again.report.find((row) => row.name === 'demo-ppt').state, 'active')
    assert.equal(again.report.find((row) => row.name === 'demo-skills').state, 'active')
    assert.ok(again.ctx.tools.items.has('demo_themes'))
  } finally { await again.dispose() }
})

test('uninstall lists every required dependent and allows removal after dependents are gone', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-multi-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  await mkdir(workspace)
  await writeFile(join(dir, 'provider.mjs'), `
export default { apply(ctx) { ctx.provide('sharedSvc', {}) } }
`)
  await writeFile(join(dir, 'one.mjs'), `export const inject = ['sharedSvc']\nexport function apply() {}\n`)
  await writeFile(join(dir, 'two.mjs'), `export const inject = ['sharedSvc']\nexport function apply() {}\n`)
  await writeFile(join(dir, 'optional.mjs'), `export const inject = ['sharedSvc']\nexport function apply() {}\n`)
  const profile = join(workspace, '.mini-dsh', 'plugins.json')
  await mkdir(join(workspace, '.mini-dsh'), { recursive: true })
  await writeFile(profile, JSON.stringify({
    plugins: [
      { name: 'shared-provider', module: join(dir, 'provider.mjs') },
      { name: 'dep-one', module: join(dir, 'one.mjs') },
      { name: 'dep-two', module: join(dir, 'two.mjs') },
      { name: 'dep-optional', module: join(dir, 'optional.mjs'), required: false },
    ],
  }, null, 2))
  const app = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try {
    const blockers = app.ctx.livePlugins.dependentsBlockingRemoval('shared-provider')
    assert.deepEqual(blockers.map((row) => row.name).sort(), ['dep-one', 'dep-two'])
    await assert.rejects(app.ctx.livePlugins.unmount('shared-provider'), /dep-one.*dep-two|dep-two.*dep-one/)

    await app.ctx.livePlugins.unmount('dep-one')
    await uninstallPlugin('dep-one', workspace, { configPath: profile })
    await app.ctx.livePlugins.unmount('dep-two')
    await uninstallPlugin('dep-two', workspace, { configPath: profile })
    // optional dependent does not block
    await app.ctx.livePlugins.unmount('shared-provider')
    await uninstallPlugin('shared-provider', workspace, { configPath: profile })
    assert.equal(JSON.parse(await readFile(profile, 'utf8')).plugins.some((row) => row.name === 'shared-provider'), false)
  } finally { await app.dispose() }

  const again = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try {
    assert.equal(again.report.find((row) => row.name === 'shared-provider'), undefined)
    assert.equal(again.report.find((row) => row.name === 'dep-optional')?.state, 'pending')
  } finally { await again.dispose() }
})

test('uninstall protects required built-in replacements that depend on a plugin service', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-builtin-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await writeFile(join(workspace, 'provider.mjs'), "export function apply(ctx) { ctx.provide('extraSvc', {}) }\n")
  const profile = join(workspace, 'plugins.json')
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'extra-provider', module: './provider.mjs' }] }))
  const compose = (options) => {
    const entries = composition(options)
    entries.find((entry) => entry.name === 'coding').plugin = {
      inject: ['tools', 'extraSvc'],
      apply(ctx) { ctx.tools.register({ name: 'replacement_tool', description: 'replacement', parameters: { type: 'object' }, execute: () => 'ok' }) },
    }
    return entries
  }
  const app = await boot({ workspace, pluginConfig: profile, web: { port: 0 }, provider: fakeProvider([]), composition: compose })
  try {
    assert.ok(app.ctx.tools.items.has('replacement_tool'))
    const url = app.ctx.webControl.url
    const response = await fetch(`${url}/plugins/uninstall`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'extra-provider' }) })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /coding \(needs extraSvc\)/)
    const preview = await fetch(`${url}/plugins/uninstall`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'extra-provider', preview: true }) })
    assert.equal(preview.status, 400)
    assert.match((await preview.json()).error, /built-in coding/)
    assert.ok(app.ctx.tools.items.has('replacement_tool'))
    assert.ok(JSON.parse(await readFile(profile, 'utf8')).plugins.some((entry) => entry.name === 'extra-provider'))
    assert.ok(!app.ctx.livePlugins.list().some((entry) => entry.name === 'coding'))
  } finally { await app.dispose() }
  const again = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]), composition: compose })
  try { assert.ok(again.ctx.tools.items.has('replacement_tool')) } finally { await again.dispose() }
})

test('same-named isolated service does not block removal of an unrelated provider', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-isolated-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const app = await boot({ workspace, provider: fakeProvider([]) })
  try {
    await app.ctx.livePlugins.mount({ name: 'root-provider', plugin: { apply(ctx) { ctx.provide('sharedScoped', {}) } } })
    await app.ctx.livePlugins.mount({ name: 'consumer', plugin: { inject: ['sharedScoped'], apply() {} } })
    await app.ctx.livePlugins.mount({ name: 'isolated-provider', plugin: {
      apply(ctx) { ctx.isolate('sharedScoped').plugin({ apply(child) { child.provide('sharedScoped', {}) } }) },
    } })
    assert.deepEqual(app.ctx.livePlugins.dependentsBlockingRemoval('isolated-provider'), [])
    assert.deepEqual(app.ctx.livePlugins.dependentsBlockingRemoval('root-provider'), [{ name: 'consumer', services: ['sharedScoped'] }])
    await app.ctx.livePlugins.unmount('isolated-provider')
    assert.equal(app.ctx.livePlugins.list().find((row) => row.name === 'consumer').state, 'active')
  } finally { await app.dispose() }
})

test('nested Service ownership protects dependents while isolated providers remain removable', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-nested-service-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  const nestedProvider = new URL('../fixtures/nested-service-provider.js', import.meta.url).pathname
  await writeFile(join(workspace, 'consumer.mjs'), "export const inject = ['nestedFixture']; export function apply() {}\n")
  await writeFile(profile, JSON.stringify({ plugins: [
    { name: 'nested-provider', module: nestedProvider },
    { name: 'isolated-provider', module: nestedProvider, config: { isolated: true } },
    { name: 'nested-consumer', module: './consumer.mjs' },
  ] }))
  const app = await boot({ workspace, pluginConfig: profile, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    const live = app.ctx.livePlugins
    const countNested = () => Object.getOwnPropertySymbols(app.ctx.reflect.store).filter((key) => app.ctx.reflect.store[key]?.name === 'nestedFixture').length
    assert.equal(countNested(), 2)
    assert.deepEqual(live.servicesProvidedBy('nested-provider'), ['nestedFixture'])
    assert.deepEqual(live.dependentsBlockingRemoval('nested-provider'), [{ name: 'nested-consumer', services: ['nestedFixture'] }])
    assert.deepEqual(live.dependentsBlockingRemoval('isolated-provider'), [])
    const url = app.ctx.webControl.url
    const post = (name) => fetch(`${url}/plugins/uninstall`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
    assert.equal((await post('nested-provider')).status, 400)
    assert.equal((await post('isolated-provider')).status, 200)
    assert.equal(countNested(), 1)
    assert.ok(app.ctx.reflect.get('nestedFixture'))
    assert.equal(live.list().find((row) => row.name === 'nested-consumer').state, 'active')
  } finally { await app.dispose() }
  assert.equal(Object.getOwnPropertySymbols(app.ctx.reflect.store).filter((key) => app.ctx.reflect.store[key]?.name === 'nestedFixture').length, 0)
  const again = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try {
    assert.ok(again.ctx.reflect.get('nestedFixture'))
    assert.equal(again.ctx.livePlugins.list().find((row) => row.name === 'nested-consumer').state, 'active')
  } finally { await again.dispose() }
})

test('a nested required consumer prevents removing its provider', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-nested-consumer-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  const nestedProvider = new URL('../fixtures/nested-service-provider.js', import.meta.url).pathname
  await writeFile(join(workspace, 'consumer.mjs'), "export function apply(ctx) { ctx.plugin({ inject: ['nestedFixture'], apply() {} }) }\n")
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'nested-provider', module: nestedProvider }, { name: 'parent-consumer', module: './consumer.mjs' }] }))
  const app = await boot({ workspace, pluginConfig: profile, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    const url = app.ctx.webControl.url
    const response = await fetch(`${url}/plugins/uninstall`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'nested-provider' }) })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /parent-consumer.*nestedFixture/)
    assert.deepEqual(app.ctx.livePlugins.removalPlan('nested-provider'), ['parent-consumer', 'nested-provider'])
    assert.equal(JSON.parse(await readFile(profile, 'utf8')).plugins.length, 2)
  } finally { await app.dispose() }
  const again = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try { assert.ok(again.ctx.reflect.get('nestedFixture')) } finally { await again.dispose() }
})

test('a nested consumer using an isolated provider does not block root provider removal', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-nested-scoped-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  const nestedProvider = new URL('../fixtures/nested-service-provider.js', import.meta.url).pathname
  await writeFile(join(workspace, 'consumer.mjs'), `
export function apply(ctx) {
  const scope = ctx.isolate('nestedFixture')
  scope.plugin({ apply(child) { child.provide('nestedFixture', {}) } })
  scope.plugin({ inject: ['nestedFixture', 'tools'], apply(child) {
    child.tools.register({ name: 'nested_isolated_tool', description: 'fixture', parameters: { type: 'object' }, execute: () => 'ok' })
  } })
}
`)
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'nested-provider', module: nestedProvider }, { name: 'isolated-consumer', module: './consumer.mjs' }] }))
  const app = await boot({ workspace, pluginConfig: profile, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    assert.ok(app.ctx.tools.items.has('nested_isolated_tool'))
    const url = app.ctx.webControl.url
    const response = await fetch(`${url}/plugins/uninstall`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'nested-provider' }) })
    assert.equal(response.status, 200)
    assert.ok(app.ctx.tools.items.has('nested_isolated_tool'))
  } finally { await app.dispose() }
  const again = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try { assert.ok(again.ctx.tools.items.has('nested_isolated_tool')) } finally { await again.dispose() }
})

test('same-scope duplicate providers are rejected and do not become an uninstall fallback', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-duplicate-provider-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  await writeFile(join(workspace, 'provider.mjs'), "export function apply(ctx) { ctx.provide('uniqueService', { name: 'original' }) }\n")
  await writeFile(join(workspace, 'consumer.mjs'), "export const inject = ['uniqueService']; export function apply() {}\n")
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'first', module: './provider.mjs' }, { name: 'consumer', module: './consumer.mjs' }] }))
  const app = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try {
    await assert.rejects(app.ctx.livePlugins.mount({ name: 'second', plugin: { apply(ctx) { ctx.provide('uniqueService', { name: 'second' }) } } }), /already|registered/i)
    assert.equal(app.ctx.reflect.get('uniqueService').name, 'original')
    assert.deepEqual(app.ctx.livePlugins.dependentsBlockingRemoval('first'), [{ name: 'consumer', services: ['uniqueService'] }])
    await assert.rejects(app.ctx.livePlugins.unmount('first'), /consumer.*uniqueService/)
  } finally { await app.dispose() }
  const again = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try { assert.equal(again.ctx.livePlugins.list().find((row) => row.name === 'consumer').state, 'active') }
  finally { await again.dispose() }
})

test('Cordis inject metadata with required false still blocks provider removal', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-inject-config-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  await writeFile(join(workspace, 'provider.mjs'), "export function apply(ctx) { ctx.provide('configuredService', {}) }\n")
  await writeFile(join(workspace, 'consumer.mjs'), "export const inject = { configuredService: { required: false } }; export function apply() {}\n")
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'provider-x', module: './provider.mjs' }, { name: 'consumer-x', module: './consumer.mjs' }] }))
  const app = await boot({ workspace, pluginConfig: profile, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    const url = app.ctx.webControl.url
    const response = await fetch(`${url}/plugins/uninstall`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'provider-x' }) })
    assert.equal(response.status, 400)
    assert.deepEqual((await response.json()).dependents.map(({ name, services }) => ({ name, services })), [{ name: 'consumer-x', services: ['configuredService'] }])
    assert.equal(JSON.parse(await readFile(profile, 'utf8')).plugins.length, 2)
  } finally { await app.dispose() }
  const again = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try { assert.equal(again.ctx.livePlugins.list().find((row) => row.name === 'consumer-x').state, 'active') }
  finally { await again.dispose() }
})

test('profile replacement failure restores the live plugin and keeps the profile', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-rollback-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  await writeFile(join(workspace, 'plugin.mjs'), `
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
export const inject = ['tools']
export function apply(ctx, config) {
  ctx.effect(() => {
    ctx.tools.register({ name: 'rollback_tool', description: 'rollback', parameters: { type: 'object' }, execute: () => 'ok' })
    return async () => {
      for (const name of await readdir(config.workDir)) {
        if (name.startsWith('.plugins-uninstall-')) await rm(join(config.workDir, name))
      }
    }
  })
}
`)
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'rollback', module: './plugin.mjs' }] }))
  const app = await boot({ workspace, pluginConfig: profile, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    const url = app.ctx.webControl.url
    const response = await fetch(`${url}/plugins/uninstall`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'rollback' }) })
    assert.equal(response.status, 400)
    assert.ok(JSON.parse(await readFile(profile, 'utf8')).plugins.some((row) => row.name === 'rollback'))
    assert.equal(app.ctx.livePlugins.list().find((row) => row.name === 'rollback').state, 'active')
    assert.ok(app.ctx.tools.items.has('rollback_tool'))
  } finally { await app.dispose() }
})

test('a turn cannot start while a live uninstall is disposing', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-uninstall-turn-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'slow', module: './slow.mjs' }] }))
  const app = await boot({ workspace, provider: fakeProvider([]) })
  let started, release
  const disposing = new Promise((resolve) => { started = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  try {
    await app.ctx.livePlugins.mount({ name: 'slow', plugin: { apply(ctx) { ctx.effect(() => async () => { started(); await gate }) } } })
    const removing = uninstallPlugin('slow', workspace, { configPath: profile, livePlugins: app.ctx.livePlugins })
    await disposing
    assert.throws(() => app.ctx.agent.turn('hello'), /plugin change is already in progress/)
    release()
    await removing
  } finally { release(); await app.dispose() }
})

test('cascade preview removes transitive dependents in order and rejects stale confirmation', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-live-cascade-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  await writeFile(join(workspace, 'a.mjs'), "export function apply(ctx) { ctx.provide('cascadeA', {}) }\n")
  await writeFile(join(workspace, 'b.mjs'), "export const inject = ['cascadeA']; export function apply(ctx) { ctx.provide('cascadeB', {}) }\n")
  await writeFile(join(workspace, 'c.mjs'), "export const inject = ['cascadeB']; export function apply() {}\n")
  await writeFile(profile, JSON.stringify({ plugins: ['a', 'b', 'c'].map((name) => ({ name, module: `./${name}.mjs` })) }))
  const app = await boot({ workspace, pluginConfig: profile, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    const url = app.ctx.webControl.url
    const post = (data) => fetch(`${url}/plugins/uninstall`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify(data) })
    const preview = await (await post({ name: 'a', preview: true })).json()
    assert.deepEqual(preview.names, ['c', 'b', 'a'])
    assert.equal((await post({ name: 'a', names: ['b', 'a'] })).status, 400)
    assert.equal(JSON.parse(await readFile(profile, 'utf8')).plugins.length, 3)
    const response = await post({ name: 'a', names: preview.names })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.deepEqual((await response.json()).names, preview.names)
    assert.equal(JSON.parse(await readFile(profile, 'utf8')).plugins.length, 0)
  } finally { await app.dispose() }
  const again = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try { assert.equal(again.ctx.livePlugins.list().length, 0) } finally { await again.dispose() }
})

test('offline uninstall inspects required dependents before changing the profile', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-offline-uninstall-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  await writeFile(join(workspace, 'provider.mjs'), "export function apply(ctx) { ctx.provide('offlineService', {}) }\n")
  await writeFile(join(workspace, 'consumer.mjs'), "export const inject = ['offlineService']; export function apply() {}\n")
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'provider-x', module: './provider.mjs' }, { name: 'consumer-x', module: './consumer.mjs' }] }))
  const cli = new URL('../src/uninstall.js', import.meta.url).pathname
  const env = { ...process.env, MINI_WORKSPACE: workspace, MINI_CONFIG: profile }
  assert.throws(() => execFileSync(process.execPath, [cli, 'provider-x'], { env, encoding: 'utf8', stdio: 'pipe' }), /required by consumer-x/)
  assert.equal(JSON.parse(await readFile(profile, 'utf8')).plugins.length, 2)
  execFileSync(process.execPath, [cli, 'consumer-x'], { env, encoding: 'utf8', stdio: 'pipe' })
  execFileSync(process.execPath, [cli, 'provider-x'], { env, encoding: 'utf8', stdio: 'pipe' })
  assert.equal(JSON.parse(await readFile(profile, 'utf8')).plugins.length, 0)
})

test('uninstall refuses a profile changed since offline inspection', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-offline-changed-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  const original = JSON.stringify({ plugins: [{ name: 'disabled', module: './unused.mjs', enabled: false }] })
  await writeFile(profile, original)
  const app = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try {
    const changed = `${original}\n`
    await writeFile(profile, changed)
    await assert.rejects(uninstallPlugin('disabled', workspace, { configPath: profile, livePlugins: app.ctx.livePlugins, expectedProfile: original, requireMounted: true }), /changed during inspection/)
    assert.equal(await readFile(profile, 'utf8'), changed)
  } finally { await app.dispose() }
})

test('cascade commit failure remounts removed providers and dependents', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-cascade-rollback-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  await writeFile(join(workspace, 'provider.mjs'), `
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
export function apply(ctx, config) {
  ctx.provide('cascadeRollback', {})
  ctx.effect(() => async () => {
    for (const name of await readdir(config.workDir)) if (name.startsWith('.plugins-uninstall-')) await rm(join(config.workDir, name))
  })
}
`)
  await writeFile(join(workspace, 'consumer.mjs'), "export const inject = ['cascadeRollback']; export function apply() {}\n")
  await writeFile(profile, JSON.stringify({ plugins: [{ name: 'provider-x', module: './provider.mjs' }, { name: 'consumer-x', module: './consumer.mjs' }] }))
  const app = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try {
    await assert.rejects(uninstallPlugin('provider-x', workspace, { configPath: profile, livePlugins: app.ctx.livePlugins, expectedNames: ['consumer-x', 'provider-x'] }))
    assert.equal(JSON.parse(await readFile(profile, 'utf8')).plugins.length, 2)
    assert.deepEqual(app.ctx.livePlugins.list().filter((row) => row.state === 'active').map((row) => row.name).sort(), ['consumer-x', 'provider-x'])
  } finally { await app.dispose() }
})

test('disabled bundle entries remain visible and can be uninstalled through the web API', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-live-disabled-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'package'), workspace = join(dir, 'workspace')
  await mkdir(pkg); await mkdir(workspace)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'disabled-bundle', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(pkg, 'index.js'), 'export function apply() {}\n')
  await writeFile(join(pkg, 'patch.yml'), '- insert:\n    - id: disabled-entry\n      name: disabled-bundle\n      disabled: true\n')
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
  const app = await boot({ workspace, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    const url = app.ctx.webControl.url
    const post = (path, data) => fetch(`${url}${path}`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify(data) })
    const response = await post('/plugins/install', { spec: join(dir, archive) })
    const installed = await response.json()
    assert.equal(response.status, 200, installed.error)
    assert.equal(installed.phase, 'installed')
    assert.deepEqual(installed.names, [])
    assert.deepEqual(installed.installedNames, ['disabled-entry'])
    const listed = await (await fetch(`${url}/plugins`)).json()
    const profileModule = JSON.parse(await readFile(installed.configPath, 'utf8')).plugins[0].module
    assert.deepEqual(listed.plugins, [{
      name: 'disabled-entry',
      state: 'disabled',
      source: 'profile',
      module: profileModule,
      missing: [],
      dependencies: [],
      settings: [],
      tools: [],
    }])
    assert.equal((await post('/plugins/uninstall', { name: 'disabled-entry' })).status, 200)
    assert.deepEqual((await (await fetch(`${url}/plugins`)).json()).plugins, [])
    assert.deepEqual(JSON.parse(await readFile(installed.configPath, 'utf8')).plugins, [])
  } finally { await app.dispose() }
})
