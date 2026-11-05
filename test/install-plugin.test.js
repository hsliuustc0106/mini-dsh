import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPackageCompatible, evaluateJsExpression, installPlugin, npmInstallError, satisfiesVersion } from '../src/install-plugin.js'
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

test('unknown replace/remove targets and isolate leave the profile unchanged', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace'); await mkdir(workspace)
  for (const [name, patch, pattern] of [
    ['bad-remove', '- remove:\n    - existing\n', /removes unknown plugin id: existing/],
    ['bad-replace', '- id: missing\n  config: {}\n', /unknown plugin id: missing/],
    ['bad-isolate', '- insert:\n    - id: g\n      name: cordis:group\n      group: true\n      isolate:\n        shell: true\n      config:\n        - id: child\n          name: bad-isolate\n', /isolate realms are not implemented/],
  ]) {
    const pkg = join(dir, name); await mkdir(pkg)
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
    await writeFile(join(pkg, 'index.js'), 'export function apply() {}')
    await writeFile(join(pkg, 'patch.yml'), patch)
    const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
    await assert.rejects(installPlugin(join(dir, archive), workspace), pattern)
  }
  await assert.rejects(readFile(join(workspace, '.mini-dsh/plugins.json')), { code: 'ENOENT' })
})

test('teaching-scoped !!js evaluates at install time; Loader ctx expressions fail closed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-tag-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace'); await mkdir(workspace)
  const ok = join(dir, 'ok'); await mkdir(ok)
  await writeFile(join(ok, 'package.json'), JSON.stringify({ name: 'tag-bundle', version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(ok, 'index.js'), 'export function apply() {}')
  await writeFile(join(ok, 'patch.yml'), `- insert:
    - id: tagged
      name: tag-bundle
      disabled: !!js process.platform === 'not-a-real-platform'
      config:
        root: !!js dshHomePath('speech-to-text')
        cwd: !!js process.cwd()
`)
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: ok, encoding: 'utf8' }).trim()
  const result = await installPlugin(join(dir, archive), workspace)
  assert.deepEqual(result.names, ['tagged'])
  const row = JSON.parse(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8')).plugins.find((item) => item.name === 'tagged')
  assert.equal(row.enabled, undefined)
  assert.match(row.config.root, /speech-to-text$/)
  assert.equal(row.config.cwd, process.cwd())

  const bad = join(dir, 'bad'); await mkdir(bad)
  await writeFile(join(bad, 'package.json'), JSON.stringify({ name: 'bad-js', version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(bad, 'index.js'), 'export function apply() {}')
  await writeFile(join(bad, 'patch.yml'), "- insert:\n    - id: tagged\n      name: bad-js\n      config:\n        flag: !!js \"!ctx.get('profileContext')\"\n")
  const badArchive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: bad, encoding: 'utf8' }).trim()
  const before = await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8')
  await assert.rejects(installPlugin(join(dir, badArchive), workspace), /Unsupported !!js expression/)
  assert.equal(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8'), before)
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

test('id-targeted replace updates a row inserted earlier in the same install', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-replace-same-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'package'), workspace = join(dir, 'workspace')
  await mkdir(pkg); await mkdir(workspace)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'replace-same', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(pkg, 'patch.yml'), '- insert:\n    - id: example\n      name: replace-same\n      config:\n        mode: initial\n- id: example\n  config:\n    mode: replaced\n- insert:\n    - id: extra\n      name: replace-same\n      disabled: true\n')
  await writeFile(join(pkg, 'index.js'), 'export function apply() {}')
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
  const result = await installPlugin(join(dir, archive), workspace)
  // Live activation names: unique, omit disabled; replace must not re-list the id.
  assert.deepEqual(result.names, ['example'])
  const profile = JSON.parse(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8'))
  assert.equal(profile.plugins.find((row) => row.name === 'example').config.mode, 'replaced')
  assert.equal(profile.plugins.find((row) => row.name === 'extra').enabled, false)
  // loadProfileEntries must accept the install names without hanging or throwing.
  const { loadProfileEntries } = await import('../src/live-plugins.js')
  const entries = await loadProfileEntries(result.configPath, result.names)
  assert.deepEqual(entries.map((entry) => entry.name), ['example'])
  const app = await boot({ workspace, pluginConfig: result.configPath, provider: fakeProvider([]) })
  try {
    assert.equal(app.report.find((row) => row.name === 'example').state, 'active')
    assert.equal(app.report.find((row) => row.name === 'extra'), undefined)
  } finally { await app.dispose() }
})

test('id-targeted replace cannot rewrite a pre-existing profile row from another package', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-replace-cross-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = join(dir, 'first'), second = join(dir, 'second'), workspace = join(dir, 'workspace')
  await mkdir(first); await mkdir(second); await mkdir(workspace)
  await writeFile(join(first, 'package.json'), JSON.stringify({ name: 'replace-first', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(first, 'patch.yml'), '- insert:\n    - id: example\n      name: replace-first\n      config:\n        mode: initial\n')
  await writeFile(join(first, 'index.js'), 'export function apply() {}')
  const firstArchive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: first, encoding: 'utf8' }).trim()
  await installPlugin(join(dir, firstArchive), workspace)
  const before = await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8')
  await writeFile(join(second, 'package.json'), JSON.stringify({ name: 'replace-second', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(second, 'patch.yml'), '- id: example\n  config:\n    mode: hijacked\n')
  await writeFile(join(second, 'index.js'), 'export function apply() {}')
  const secondArchive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: second, encoding: 'utf8' }).trim()
  await assert.rejects(
    installPlugin(join(dir, secondArchive), workspace),
    /cannot replace pre-existing plugin id: example/
  )
  assert.equal(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8'), before)
  assert.equal(JSON.parse(before).plugins.find((row) => row.name === 'example').config.mode, 'initial')
})

test('non-ERESOLVE npm failures keep only a short error tail', () => {
  const noise = 'x'.repeat(4000)
  const error = npmInstallError(`${noise}final-tail-marker`, 1)
  assert.match(error.message, /^npm install failed \(1\): /)
  assert.match(error.message, /final-tail-marker$/)
  assert.ok(error.message.length < 1700)
  assert.equal(error.message.includes(noise), false)
})

test('peer dependency conflicts fail closed without force or legacy-peer-deps', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-peer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'package'), workspace = join(dir, 'workspace')
  await mkdir(pkg); await mkdir(join(workspace, '.mini-dsh'), { recursive: true })
  await writeFile(join(workspace, '.mini-dsh/plugins.json'), JSON.stringify({ plugins: [{ name: 'keep-me', module: './keep.js' }] }, null, 2) + '\n')
  const before = await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8')
  await writeFile(join(pkg, 'package.json'), JSON.stringify({
    name: 'peer-conflict-plugin',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    // Unresolvable peer mirrors the @mixian/dsh-desktop-plugin ERESOLVE class of failure.
    peerDependencies: { 'mini-dsh-no-such-peer-package-zzzz': '^1.0.0' },
  }))
  await writeFile(join(pkg, 'index.js'), 'export function apply() {}')
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
  await assert.rejects(
    installPlugin(join(dir, archive), workspace),
    /ERESOLVE|does not accept --force or --legacy-peer-deps/
  )
  assert.equal(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8'), before)
  const stages = await readdir(join(workspace, '.mini-dsh'))
  assert.equal(stages.some((name) => name.startsWith('.install-')), false)
})

test('same-install remove and multi-file layering update earlier layers only', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-layer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'package'), workspace = join(dir, 'workspace')
  await mkdir(pkg); await mkdir(workspace)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({
    name: 'layer-bundle', version: '1.0.0', type: 'module', main: 'index.js',
    dsh: { bundle: { patch: ['base.yml', 'overlay.yml'] } },
  }))
  await writeFile(join(pkg, 'index.js'), 'export function apply() {}')
  await writeFile(join(pkg, 'base.yml'), `- insert:
    - id: keep
      name: layer-bundle
      config:
        mode: base
    - id: drop
      name: layer-bundle
    - id: grouped
      name: cordis:group
      group: true
      config:
        - id: child
          name: layer-bundle
          config:
            role: child
`)
  await writeFile(join(pkg, 'overlay.yml'), `- id: keep
  config:
    mode: overlay
- remove:
    - drop
`)
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
  const result = await installPlugin(join(dir, archive), workspace)
  assert.deepEqual(result.names.sort(), ['child', 'keep'])
  const profile = JSON.parse(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8'))
  assert.equal(profile.plugins.find((row) => row.name === 'keep').config.mode, 'overlay')
  assert.equal(profile.plugins.find((row) => row.name === 'drop'), undefined)
  assert.equal(profile.plugins.find((row) => row.name === 'child').config.role, 'child')
})

test('remove cannot delete a pre-existing profile row from another package', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-remove-cross-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const first = join(dir, 'first'), second = join(dir, 'second'), workspace = join(dir, 'workspace')
  await mkdir(first); await mkdir(second); await mkdir(workspace)
  await writeFile(join(first, 'package.json'), JSON.stringify({ name: 'remove-first', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(first, 'patch.yml'), '- insert:\n    - id: example\n      name: remove-first\n')
  await writeFile(join(first, 'index.js'), 'export function apply() {}')
  const firstArchive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: first, encoding: 'utf8' }).trim()
  await installPlugin(join(dir, firstArchive), workspace)
  const before = await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8')
  await writeFile(join(second, 'package.json'), JSON.stringify({ name: 'remove-second', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(second, 'patch.yml'), '- remove:\n    - example\n')
  await writeFile(join(second, 'index.js'), 'export function apply() {}')
  const secondArchive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: second, encoding: 'utf8' }).trim()
  await assert.rejects(installPlugin(join(dir, secondArchive), workspace), /cannot remove pre-existing plugin id: example/)
  assert.equal(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8'), before)
})

test('nested preset config.plugins are kept as config; nested group fails closed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-preset-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'package'), workspace = join(dir, 'workspace')
  await mkdir(pkg); await mkdir(workspace)
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'preset-host', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(pkg, 'index.js'), 'export function apply() {}')
  await writeFile(join(pkg, 'patch.yml'), `- insert:
    - id: preset
      name: preset-host
      config:
        id: demo
        plugins:
          - id: persona
            name: preset-host
            config:
              prefix: hi
`)
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
  const result = await installPlugin(join(dir, archive), workspace)
  assert.deepEqual(result.names, ['preset'])
  const row = JSON.parse(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8')).plugins.find((item) => item.name === 'preset')
  assert.equal(row.config.id, 'demo')
  assert.equal(row.config.plugins[0].id, 'persona')

  const bad = join(dir, 'bad'); await mkdir(bad)
  await writeFile(join(bad, 'package.json'), JSON.stringify({ name: 'preset-bad', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'patch.yml' } } }))
  await writeFile(join(bad, 'index.js'), 'export function apply() {}')
  await writeFile(join(bad, 'patch.yml'), `- insert:
    - id: preset
      name: preset-bad
      config:
        plugins:
          - id: shell
            name: cordis:group
            group: true
            config: []
`)
  const badArchive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: bad, encoding: 'utf8' }).trim()
  const before = await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8')
  await assert.rejects(installPlugin(join(dir, badArchive), workspace), /group\/isolate inside nested presets are not implemented/)
  assert.equal(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8'), before)
})

test('version/compat checks reject malformed engines.dsh and DSH client peers', async (t) => {
  assert.equal(satisfiesVersion('0.1.0', '^0.1.0'), true)
  assert.equal(satisfiesVersion('0.1.0', '^1.0.0'), false)
  assert.equal(evaluateJsExpression("process.platform === 'linux'") === (process.platform === 'linux'), true)
  assert.throws(() => evaluateJsExpression('ctx.pluginPackages'), /Unsupported !!js expression/)
  assert.throws(
    () => assertPackageCompatible({ name: 'x', engines: { dsh: 'workspace:^' } }, '0.1.0'),
    /invalid engines\.dsh/,
  )
  // Ordinary DSH engines.dsh ranges are not refused against mini-dsh's teaching runtime id.
  assert.doesNotThrow(() => assertPackageCompatible({ name: 'tool', engines: { dsh: '>=0.2.0-rc.2' } }, '0.1.0'))
  assert.throws(
    () => assertPackageCompatible({
      name: 'desktopish',
      peerDependencies: { '@deepseek-ai/dsh-client-runtime': '*' },
    }),
    /DSH client peers unsupported/,
  )
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-compat-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'package'), workspace = join(dir, 'workspace')
  await mkdir(pkg); await mkdir(join(workspace, '.mini-dsh'), { recursive: true })
  await writeFile(join(workspace, '.mini-dsh/plugins.json'), JSON.stringify({ plugins: [{ name: 'keep-me', module: './keep.js' }] }, null, 2) + '\n')
  const before = await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8')
  await writeFile(join(pkg, 'package.json'), JSON.stringify({
    name: 'compat-fail', version: '1.0.0', type: 'module', main: 'index.js',
    peerDependencies: { '@deepseek-ai/dsh-client-runtime': '*', '@deepseek-ai/dsh-client-ui-slots': '*' },
    dsh: { bundle: { patch: 'patch.yml' } },
  }))
  await writeFile(join(pkg, 'index.js'), 'export function apply() {}')
  await writeFile(join(pkg, 'patch.yml'), '- insert:\n    - id: x\n      name: compat-fail\n')
  // Local directory preflight refuses client peers before npm.
  await assert.rejects(installPlugin(pkg, workspace), /DSH client peers unsupported/)
  assert.equal(await readFile(join(workspace, '.mini-dsh/plugins.json'), 'utf8'), before)
})

test('desktop-shaped bundle patch installs when peers resolve; real desktop peers stay fail-closed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-install-desktop-path-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pkg = join(dir, 'package'), workspace = join(dir, 'workspace')
  await mkdir(pkg); await mkdir(workspace)
  // Mirrors @mixian/dsh-desktop-plugin@0.1.3 patch shape with satisfiable peers.
  await writeFile(join(pkg, 'package.json'), JSON.stringify({
    name: 'desktop-shaped', version: '1.0.0', type: 'module', main: 'index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(pkg, 'index.js'), 'export function apply() {}')
  await writeFile(join(pkg, 'cordis.patch.yml'), `- insert:
    - id: dsh-desktop-plugin
      name: 'desktop-shaped'
`)
  const archive = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkg, encoding: 'utf8' }).trim()
  const result = await installPlugin(join(dir, archive), workspace)
  assert.deepEqual(result.names, ['dsh-desktop-plugin'])
})
