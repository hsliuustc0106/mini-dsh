import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'

const cli = new URL('../src/uninstall.js', import.meta.url).pathname

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'mini-offline-cascade-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = join(workspace, 'plugins.json')
  await writeFile(join(workspace, 'a.mjs'), "export function apply(ctx) { ctx.provide('offlineA', {}) }\n")
  await writeFile(join(workspace, 'b.mjs'), "export const inject = ['offlineA']; export function apply(ctx) { ctx.provide('offlineB', {}) }\n")
  await writeFile(join(workspace, 'c.mjs'), "export const inject = ['offlineB']; export function apply() {}\n")
  const contents = JSON.stringify({ plugins: [
    ...['a', 'b', 'c'].map((name) => ({ name, module: `./${name}.mjs` })),
    { name: 'disabled', module: './unused.mjs', enabled: false },
  ] })
  await writeFile(profile, contents)
  const env = { ...process.env, MINI_WORKSPACE: workspace, MINI_CONFIG: profile }
  return { workspace, profile, contents, env }
}

test('offline cascade previews dependents, requires confirmation and keeps disabled entries', async (t) => {
  const { workspace, profile, contents, env } = await fixture(t)
  assert.throws(() => execFileSync(process.execPath, [cli, 'a', '--cascade'], { env, encoding: 'utf8', input: 'no\n', stdio: 'pipe' }), /cancelled/)
  assert.throws(() => execFileSync(process.execPath, [cli, 'a', '--cascade'], { env, encoding: 'utf8', input: '', stdio: 'pipe' }), /cancelled/)
  assert.equal(await readFile(profile, 'utf8'), contents)
  const output = execFileSync(process.execPath, [cli, 'a', '--cascade'], { env, encoding: 'utf8', input: 'yes\n', stdio: 'pipe' })
  assert.match(output, /Will uninstall \(dependents first\): c, b, a/)
  assert.match(output, /Uninstalled c, b, a/)
  assert.deepEqual(JSON.parse(await readFile(profile, 'utf8')).plugins.map((row) => row.name), ['disabled'])
  const app = await boot({ workspace, pluginConfig: profile, provider: fakeProvider([]) })
  try { assert.equal(app.ctx.livePlugins.list().length, 0) } finally { await app.dispose() }
})

test('offline cascade can remove a disabled entry without activating it', async (t) => {
  const { profile, env } = await fixture(t)
  const output = execFileSync(process.execPath, [cli, 'disabled', '--cascade'], { env, encoding: 'utf8', input: 'yes\n', stdio: 'pipe' })
  assert.match(output, /Will uninstall \(dependents first\): disabled/)
  assert.deepEqual(JSON.parse(await readFile(profile, 'utf8')).plugins.map((row) => row.name), ['a', 'b', 'c'])
})

test('offline cascade refuses a profile changed after preview', async (t) => {
  const { profile, contents, env } = await fixture(t)
  const child = spawn(process.execPath, [cli, 'a', '--cascade'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', error = '', changed = false
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { error += chunk })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', async (chunk) => {
    output += chunk
    if (!changed && output.includes('Type yes to confirm:')) {
      changed = true
      await writeFile(profile, `${contents}\n`)
      child.stdin.end('yes\n')
    }
  })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(changed, true)
  assert.notEqual(code, 0)
  assert.match(error, /profile changed during inspection/i)
  assert.equal(await readFile(profile, 'utf8'), `${contents}\n`)
})

test('offline cascade refuses built-in dependents before confirmation', async (t) => {
  const { workspace, profile, env } = await fixture(t)
  await writeFile(join(workspace, 'coding.mjs'), "export const inject = ['offlineA']; export function apply() {}\n")
  const contents = JSON.stringify({ plugins: [{ name: 'a', module: './a.mjs' }, { name: 'coding', module: './coding.mjs' }] })
  await writeFile(profile, contents)
  assert.throws(() => execFileSync(process.execPath, [cli, 'a', '--cascade'], { env, encoding: 'utf8', input: 'yes\n', stdio: 'pipe' }), /built-in coding/)
  assert.equal(await readFile(profile, 'utf8'), contents)
})
