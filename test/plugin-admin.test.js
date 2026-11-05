import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { boot } from '../src/boot.js'
import { nextConfig } from '../src/plugin-admin.js'
import { fakeProvider } from '../src/provider.js'

test('supported settings reject undeclared, nested, and host-managed keys', () => {
  const plugin = {
    apply() {},
    Config: z.object({
      prefix: z.string().description('Prefix'),
      mode: z.union(['soft', 'loud']).default('soft'),
      nested: z.object({ a: z.string() }),
    }),
  }
  const saved = nextConfig(plugin, { workDir: '/tmp/ws', prefix: 'A' }, { prefix: 'B' })
  assert.equal(saved.prefix, 'B')
  assert.equal(saved.workDir, '/tmp/ws')
  assert.equal(saved.mode, 'soft')
  assert.throws(() => nextConfig(plugin, { prefix: 'A' }, { nested: { a: 'x' } }), /Unsupported setting nested/)
  assert.throws(() => nextConfig(plugin, { prefix: 'A' }, { mode: 'nope' }), /soft/)
  assert.throws(() => nextConfig(plugin, {}, { workDir: '/tmp/other' }), /managed by mini-dsh/)

  const plain = { apply() {}, settings: { prefix: { type: 'string', required: true } } }
  assert.equal(nextConfig(plain, { prefix: 'A', workDir: '/tmp/ws' }, { prefix: 'B' }).prefix, 'B')
  assert.throws(() => nextConfig(plain, {}, { prefix: 1 }), /prefix must be a string/)
  assert.throws(() => nextConfig(plain, {}, { other: 'x' }), /Unsupported setting other/)
  assert.throws(() => nextConfig({ apply() {} }, {}, { prefix: 'A' }), /no supported settings/)
})

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-plugin-admin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function pluginSource() {
  return `export default {
  inject: ['tools'],
  settings: {
    prefix: { type: 'string', description: 'Prefix' },
    extra: { type: 'object' },
  },
  apply(ctx, config = {}) {
    if (config.prefix === 'boom') throw new Error('prefix boom is refused')
    for (const name of ['echo', 'silent']) {
      ctx.effect(() => ctx.tools.register({
        name,
        description: name,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => config.prefix ?? 'ok',
      }))
    }
  },
}
`
}

function gapSource() {
  return `export default {
  inject: ['tools', 'dshFilesystem'],
  settings: { label: { type: 'string', description: 'Label' } },
  apply() {},
}
`
}

async function post(url, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

test('web plugin management persists policies, denies by default, and reports activation', async (t) => {
  const dir = await workspace(t)
  const configPath = join(dir, 'plugins.json')
  await writeFile(join(dir, 'echo.mjs'), pluginSource())
  await writeFile(join(dir, 'gap.mjs'), gapSource())
  await writeFile(configPath, JSON.stringify({ plugins: [
    { name: 'echo', module: './echo.mjs', config: { prefix: 'Hello' } },
    { name: 'gap', module: './gap.mjs', required: false, config: { label: 'pending' } },
  ] }, null, 2))
  const app = await boot({ workspace: dir, pluginConfig: configPath, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    const url = app.ctx.webControl.url
    assert.equal(app.ctx.livePlugins.ownsFiber('echo', app.ctx.tools.owners.get('echo')), true)
    assert.equal(app.ctx.livePlugins.ownsFiber('echo', app.ctx.tools.owners.get('read')), false)
    const listed = await (await fetch(`${url}/plugins`)).json()
    const echo = listed.plugins.find((item) => item.name === 'echo')
    const gap = listed.plugins.find((item) => item.name === 'gap')
    assert.equal(echo.state, 'active')
    assert.deepEqual(echo.tools.map((tool) => [tool.name, tool.decision, tool.source]), [
      ['echo', 'deny', 'default'],
      ['silent', 'deny', 'default'],
    ])
    assert.equal(echo.settings.find((field) => field.key === 'prefix').value, 'Hello')
    assert.equal(echo.settings.find((field) => field.key === 'extra').supported, false)
    assert.equal(gap.state, 'pending')
    const missing = gap.dependencies.find((item) => item.service === 'dshFilesystem')
    assert.equal(missing.status, 'unsupported')
    assert.match(missing.message, /does not provide dshFilesystem/)
    assert.match(missing.message, /Installing a package does not make this service available/)
    assert.equal((await app.ctx.permissions.decide({ name: 'echo', arguments: {} })).reason, 'unknown tool')
    assert.equal((await app.ctx.permissions.decide({ name: 'silent', arguments: {} })).reason, 'unknown tool')
    assert.equal((await app.ctx.permissions.decide({ name: 'read', arguments: {} })).decision, 'allow')

    const unknown = await post(url, '/plugins/permissions', { name: 'echo', policies: { nope: 'allow' } })
    assert.equal(unknown.status, 400)
    assert.match(unknown.body.error, /Unknown tool nope is denied/)
    assert.equal((await app.ctx.permissions.decide({ name: 'nope', arguments: {} })).reason, 'unknown tool')
    const foreign = await post(url, '/plugins/permissions', { name: 'echo', policies: { read: 'deny' } })
    assert.equal(foreign.status, 400)
    assert.match(foreign.body.error, /not registered by echo/)
    assert.equal((await app.ctx.permissions.decide({ name: 'read', arguments: {} })).decision, 'allow')

    const asked = await post(url, '/plugins/permissions', { name: 'echo', policies: { echo: 'ask' } })
    assert.equal(asked.status, 200, JSON.stringify(asked.body))
    assert.match(asked.body.message, /Active now/)
    assert.equal(app.ctx.permissions.effective('echo').decision, 'ask')
    const granted = await app.ctx.permissions.decide({ name: 'echo', arguments: {} }, undefined, () => true)
    assert.equal(granted.decision, 'allow')
    assert.equal((await app.ctx.permissions.decide({ name: 'silent', arguments: {} })).reason, 'unknown tool')
    const denied = await post(url, '/plugins/permissions', { name: 'echo', policies: { silent: 'deny' } })
    assert.equal(denied.status, 200, JSON.stringify(denied.body))
    assert.equal((await app.ctx.permissions.decide({ name: 'silent', arguments: {} })).reason, 'denied by policy')

    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    assert.equal(saved.plugins.find((item) => item.name === 'default-tool-permissions').config.policies.echo, 'ask')
    assert.equal(saved.plugins.find((item) => item.name === 'default-tool-permissions').config.policies.silent, 'deny')
    assert.equal(saved.plugins.find((item) => item.name === 'default-tool-permissions').config.policies.nope, undefined)
    assert.equal(saved.plugins.find((item) => item.name === 'default-tool-permissions').config.policies.read, undefined)

    const updated = await post(url, '/plugins/config', { name: 'echo', config: { prefix: 'Hi' } })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    assert.equal(updated.body.active, true)
    assert.match(updated.body.message, /Active now/)
    assert.equal(app.ctx.tools.items.get('echo').execute({}), 'Hi')
    assert.equal(app.ctx.permissions.effective('echo').decision, 'ask')

    const unsupported = await post(url, '/plugins/config', { name: 'echo', config: { extra: { a: 1 } } })
    assert.equal(unsupported.status, 400)
    assert.match(unsupported.body.error, /Unsupported setting extra/)
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).plugins.find((item) => item.name === 'echo').config.prefix, 'Hi')

    const boom = await post(url, '/plugins/config', { name: 'echo', config: { prefix: 'boom' } })
    assert.equal(boom.status, 400)
    assert.equal(boom.body.restored, true)
    assert.match(boom.body.error, /previous configuration was restored/)
    assert.match(boom.body.error, /prefix boom is refused/)
    assert.equal(app.ctx.tools.items.get('echo').execute({}), 'Hi')
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).plugins.find((item) => item.name === 'echo').config.prefix, 'Hi')

    const gapUpdate = await post(url, '/plugins/config', { name: 'gap', config: { label: 'next' } })
    assert.equal(gapUpdate.status, 200, JSON.stringify(gapUpdate.body))
    assert.equal(gapUpdate.body.active, false)
    assert.match(gapUpdate.body.message, /not active/)
    assert.match(gapUpdate.body.message, /does not provide dshFilesystem/)
    assert.match(gapUpdate.body.message, /Installing a package does not make this service available/)
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).plugins.find((item) => item.name === 'gap').config.label, 'next')
    assert.equal(app.ctx.tools.items.has('gap_tool'), false)
  } finally { await app.dispose() }

  const again = await boot({ workspace: dir, pluginConfig: configPath, provider: fakeProvider([]) })
  try {
    assert.equal(again.ctx.permissions.effective('echo').source, 'policy')
    assert.equal(again.ctx.permissions.effective('echo').decision, 'ask')
    const granted = await again.ctx.permissions.decide({ name: 'echo', arguments: {} }, undefined, () => true)
    assert.equal(granted.decision, 'allow')
    assert.equal((await again.ctx.permissions.decide({ name: 'silent', arguments: {} })).reason, 'denied by policy')
    assert.equal((await again.ctx.permissions.decide({ name: 'nope', arguments: {} })).reason, 'unknown tool')
    assert.equal(again.ctx.tools.items.get('echo').execute({}), 'Hi')
    assert.equal(again.report.find((item) => item.name === 'gap').state, 'pending')
  } finally { await again.dispose() }
})

test('disabled default permissions refuse policy changes', async (t) => {
  const dir = await workspace(t)
  const configPath = join(dir, 'plugins.json')
  await writeFile(join(dir, 'echo.mjs'), pluginSource())
  const before = JSON.stringify({ plugins: [
    { name: 'echo', module: './echo.mjs', config: { prefix: 'Hello' } },
    { name: 'default-tool-permissions', enabled: false },
  ] }, null, 2)
  await writeFile(configPath, before)
  const app = await boot({ workspace: dir, pluginConfig: configPath, web: { port: 0 }, provider: fakeProvider([]) })
  try {
    const url = app.ctx.webControl.url
    assert.equal((await app.ctx.permissions.decide({ name: 'echo', arguments: {} })).reason, 'unknown tool')
    const refused = await post(url, '/plugins/permissions', { name: 'echo', policies: { echo: 'allow' } })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /default-tool-permissions is disabled/)
    assert.equal((await app.ctx.permissions.decide({ name: 'echo', arguments: {} })).reason, 'unknown tool')
    assert.equal(await readFile(configPath, 'utf8'), before)
  } finally { await app.dispose() }
})
