import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../src/boot.js'
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
