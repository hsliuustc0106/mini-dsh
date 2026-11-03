import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'

// Opt in with the built, unmodified DSH plugin module and its resolved imports.
const module = process.env.DSH_TEST_WORKSPACE_DEPENDENCIES

test('the real DSH workspace-dependencies plugin renders its object result', { skip: !module }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-real-dsh-plugin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'runtime')
  const windows = process.platform === 'win32'
  const python = join(source, 'dependencies', 'python', ...(windows ? ['python.exe'] : ['bin', 'python3']))
  const packages = join(source, 'dependencies', 'python', ...(windows ? ['Lib'] : ['lib', 'python3.12']), 'site-packages')
  await mkdir(dirname(python), { recursive: true })
  await mkdir(packages, { recursive: true })
  await writeFile(python, 'fixture placeholder, not an interpreter')
  await writeFile(join(source, 'runtime.json'), JSON.stringify({
    desktopVersion: '1.0.0', platform: process.platform, arch: process.arch, python: '3.12.14',
    pythonPackages: { 'python-docx': '1.2.0' },
  }))
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [
    { name: 'workspace-dependencies', module, config: { source } },
    { name: 'default-tool-permissions', config: { policies: { load_workspace_dependencies: 'ask' } } },
  ] }))
  const model = fakeProvider([
    { role: 'assistant', content: null, tool_calls: [{ id: 'deps-1', type: 'function', function: { name: 'load_workspace_dependencies', arguments: '{}' } }] },
    { role: 'assistant', content: 'done' },
  ])
  const approvals = []
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider: model, approve: ({ name }) => { approvals.push(name); return true } })
  try {
    assert.equal(app.report.find(({ name }) => name === 'workspace-dependencies').state, 'active')
    await app.ctx.agent.turn('Load workspace dependencies')
    const text = app.ctx.session.events.find(({ type }) => type === 'tool.finished').result
    assert.deepEqual(approvals, ['load_workspace_dependencies'])
    assert.deepEqual(JSON.parse(text), { python, pythonPackages: packages, pythonDistributions: { 'python-docx': '1.2.0' } })
    assert.equal(model.sent[1].messages.at(-1).content, text)
  } finally { await app.dispose() }
})
