import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPlugin } from '../src/install-plugin.js'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'
import { pluginInstallSpec } from '../src/web-control.js'
import { acquireWriter } from '../src/lock.js'

test('web plugin inputs support GitHub repositories and npm package names', () => {
  assert.equal(pluginInstallSpec('https://github.com/owner/plugin#v1'), 'git+https://github.com/owner/plugin#v1')
  assert.equal(pluginInstallSpec('@example/plugin@1.2.3'), '@example/plugin@1.2.3')
  for (const value of ['https://github.com/owner/plugin/tree/main', 'https://user:secret@github.com/a/b', 'file:///tmp/plugin', '-evil']) {
    assert.throws(() => pluginInstallSpec(value))
  }
})

test('install a DSH bundle and boot its tool with default deny', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'package')
  const workspace = join(dir, 'workspace')
  await mkdir(pkg); await mkdir(workspace)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'mini-test-bundle', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(pkg, 'cordis.patch.yml'), '- insert:\n    - id: example\n      name: mini-test-bundle\n')
  await writeFile(join(pkg, 'index.js'), `import { writeFileSync } from 'node:fs'; export const inject = ['tools']; export function apply(ctx) { if (process.env.MINI_TEST_MARKER) writeFileSync(process.env.MINI_TEST_MARKER, 'loaded'); ctx.tools.register({ name: 'installed_tool', description: 'test', parameters: { type: 'object', properties: {} }, execute: () => 'ok' }) }`)
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
  const customProfile = join(dir, 'custom-profile.json')
  await writeFile(customProfile, JSON.stringify({ plugins: [{ name: 'coding', config: { tools: ['read'] } }] }))
  const result = await installPlugin(join(dir, archive), workspace, { configPath: customProfile })
  assert.deepEqual(result.names, ['example'])
  assert.equal(result.configPath, customProfile)
  assert.equal(JSON.parse(await readFile(customProfile)).plugins[0].name, 'coding')
  const app = await boot({ workspace, pluginConfig: result.configPath, provider: fakeProvider([]) })
  try {
    assert.equal(app.report.find((row) => row.name === 'example').state, 'active')
    assert.ok(app.ctx.tools.schemas().some((item) => item.function.name === 'installed_tool'))
    assert.equal((await app.ctx.permissions.decide({ name: 'installed_tool', arguments: {} })).decision, 'deny')
  } finally { await app.dispose() }
  const marker = join(dir, 'started')
  execFileSync(process.execPath, [new URL('../src/main.js', import.meta.url).pathname], { input: '/quit\n', env: { ...process.env, MINI_WORKSPACE: workspace, MINI_TEST_MARKER: marker, MINI_CONFIG: customProfile, DEEPSEEK_API_KEY: '', DEEPSEEK_API_KEY_FILE: '' } })
  assert.equal(await readFile(marker, 'utf8'), 'loaded')
  const before = await readFile(result.configPath, 'utf8')
  await assert.rejects(installPlugin(join(dir, archive), workspace, { configPath: customProfile }), /duplicate plugin name/)
  assert.equal(await readFile(result.configPath, 'utf8'), before)
})

test('unsupported bundle patches do not modify the profile', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'bad-bundle', version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(dir, 'index.js'), '')
  await writeFile(join(dir, 'patch.yml'), '- id: existing\n  config: {}\n')
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: dir, encoding: 'utf8' }).trim()
  const workspace = join(dir, 'workspace'); await mkdir(workspace)
  await assert.rejects(installPlugin(join(dir, archive), workspace), /Unsupported bundle patch operation/)
  await assert.rejects(readFile(join(workspace, '.mini-dsh/plugins.json')), { code: 'ENOENT' })
})

test('DSH-specific YAML tags are rejected rather than converted to strings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-tag-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'tag-bundle', version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(dir, 'index.js'), 'export function apply() {}')
  await writeFile(join(dir, 'patch.yml'), "- insert:\n    - id: tagged\n      name: tag-bundle\n      config:\n        root: !!js dshHomePath('speech-to-text')\n")
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: dir, encoding: 'utf8' }).trim()
  const workspace = join(dir, 'workspace'); await mkdir(workspace)
  await assert.rejects(installPlugin(join(dir, archive), workspace), /Unsupported or invalid bundle YAML/)
  await assert.rejects(readFile(join(workspace, '.mini-dsh/plugins.json')), { code: 'ENOENT' })
})

test('installs an import-only package entry point', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-esm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'package'), workspace = join(dir, 'workspace')
  await mkdir(pkg); await mkdir(workspace)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'import-only-plugin', version: '1.0.0', type: 'module', exports: { import: './index.js' } }))
  await writeFile(join(pkg, 'index.js'), 'export function apply() {}')
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
  const result = await installPlugin(join(dir, archive), workspace)
  const app = await boot({ workspace, pluginConfig: result.configPath, provider: fakeProvider([]) })
  try { assert.equal(app.report.find((entry) => entry.name === 'import-only-plugin').state, 'active') }
  finally { await app.dispose() }
})

test('resolves bundle rows from the bundle and uses import conditions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-nested-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'bundle'), nested = join(pkg, 'node_modules', 'nested-plugin'), workspace = join(dir, 'workspace')
  await mkdir(nested, { recursive: true }); await mkdir(workspace)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'local-bundle', version: '1.0.0', type: 'module', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(pkg, 'patch.yml'), '- insert:\n    - id: nested\n      name: nested-plugin\n')
  await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'nested-plugin', version: '1.0.0', type: 'module', exports: { import: './index.js' } }))
  await writeFile(join(nested, 'index.js'), 'export function apply() {}')
  const result = await installPlugin(pkg, workspace)
  const app = await boot({ workspace, pluginConfig: result.configPath, provider: fakeProvider([]) })
  try { assert.equal(app.report.find((entry) => entry.name === 'nested').state, 'active') }
  finally { await app.dispose() }
})

test('competing installer processes serialize profile updates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-race-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace'), home = join(workspace, '.mini-dsh')
  await mkdir(home, { recursive: true })
  const archives = []
  for (const name of ['race-first', 'race-second']) {
    const pkg = join(dir, name); await mkdir(pkg)
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }))
    await writeFile(join(pkg, 'index.js'), 'export function apply() {}')
    archives.push(join(dir, execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()))
  }
  const lock = await acquireWriter(join(home, 'plugins.json.install.lock'))
  const script = new URL('../src/install.js', import.meta.url).pathname
  const children = archives.map((archive) => spawn(process.execPath, [script, archive], { env: { ...process.env, MINI_WORKSPACE: workspace }, stdio: ['ignore', 'ignore', 'pipe'] }))
  const completions = children.map((child) => new Promise((resolve, reject) => {
    let errorText = ''
    child.stderr.on('data', (chunk) => { errorText += chunk })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`installer failed: ${errorText}`)))
  }))
  try {
    const deadline = Date.now() + 15000
    let readyCount = 0
    while (Date.now() < deadline) {
      const entries = (await readdir(home)).filter((name) => name.startsWith('.install-'))
      const ready = await Promise.all(entries.map(async (entry) => access(join(home, entry, 'package-lock.json')).then(() => true, () => false)))
      readyCount = ready.filter(Boolean).length
      if (readyCount === 2) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(readyCount, 2, 'both packages should finish staging')
    // The pre-held lock keeps both processes out of the profile update.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await assert.rejects(access(join(home, 'plugins.json')), { code: 'ENOENT' })
    assert.equal(children.every((child) => child.exitCode === null), true, 'both installers must wait for the profile lock')
  } finally { lock.release() }
  await Promise.all(completions)
  const profile = JSON.parse(await readFile(join(home, 'plugins.json'), 'utf8'))
  assert.deepEqual(profile.plugins.map((entry) => entry.name).sort(), ['race-first', 'race-second'])
})
