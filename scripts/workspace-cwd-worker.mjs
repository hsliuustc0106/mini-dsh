import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { boot } from '../src/boot.js'
import { installPlugin } from '../src/install-plugin.js'
import { loadProfileEntries, uninstallPlugin } from '../src/live-plugins.js'
import { fakeProvider } from '../src/provider.js'

const mode = process.argv[2]
const home = await mkdtemp(join(tmpdir(), 'mini-ws-worker-'))
try {
  if (mode === 'live') {
    const workspace = join(home, 'workspace')
    const otherCwd = join(home, 'cwd')
    await mkdir(workspace)
    await mkdir(otherCwd)
    await writeFile(join(home, 'workdir-plugin.mjs'), `
export const inject = ['tools']
export function apply(ctx, config) {
  const workDir = config.workDir
  ctx.effect(() => ctx.tools.register({
    name: 'report_workdir',
    description: 'Report workDir',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object', properties: { workDir: { type: 'string' } }, required: ['workDir'], additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: v.workDir }],
    },
    execute: () => ({ workDir }),
  }))
}
`)
    const profile = join(workspace, 'plugins.json')
    await writeFile(profile, JSON.stringify({
      plugins: [
        { name: 'workdir-plugin', module: join(home, 'workdir-plugin.mjs') },
        { name: 'default-tool-permissions', config: { policies: { report_workdir: 'allow' } } },
      ],
    }))
    process.chdir(otherCwd)
    assert.notEqual(process.cwd(), workspace)
    const app = await boot({ workspace, provider: fakeProvider([]) })
    try {
      const [report] = await app.ctx.livePlugins.mountAll(await loadProfileEntries(profile, ['workdir-plugin']))
      assert.equal(report.state, 'active')
      assert.equal(await app.ctx.tools.run('report_workdir', {}), workspace)
    } finally { await app.dispose() }
  } else if (mode === 'protobuf') {
    const workspace = join(home, 'workspace')
    const otherCwd = join(home, 'other-cwd')
    await mkdir(workspace)
    await mkdir(otherCwd)
    await writeFile(join(workspace, 'demo.proto'), 'syntax = "proto3";\nmessage Demo { string name = 1; }\n')
    await writeFile(join(otherCwd, 'demo.proto'), 'syntax = "proto3";\nmessage Wrong { string nope = 1; }\n')
    const packDir = join(home, 'pack')
    await mkdir(packDir)
    execFileSync('npm', ['pack', 'dsh-tool-protobuf@0.1.0', '--silent', '--pack-destination', packDir], { stdio: 'pipe' })
    const archive = join(packDir, 'dsh-tool-protobuf-0.1.0.tgz')
    process.chdir(otherCwd)
    assert.notEqual(process.cwd(), workspace)
    const installed = await installPlugin(archive, workspace)
    assert.equal(JSON.parse(await readFile(installed.configPath, 'utf8')).plugins[0].config.workDir, workspace)
    const profile = JSON.parse(await readFile(installed.configPath, 'utf8'))
    profile.plugins.push({
      name: 'default-tool-permissions',
      config: { policies: { protobuf_status: 'ask', protobuf_outline: 'ask' } },
    })
    await writeFile(installed.configPath, `${JSON.stringify(profile, null, 2)}\n`)
    const approvals = []
    const model = fakeProvider([
      {
        role: 'assistant', content: null, tool_calls: [
          { id: 's1', type: 'function', function: { name: 'protobuf_status', arguments: '{}' } },
          { id: 'o1', type: 'function', function: { name: 'protobuf_outline', arguments: JSON.stringify({ path: 'demo.proto' }) } },
        ],
      },
      { role: 'assistant', content: 'done' },
    ])
    const app = await boot({
      workspace,
      pluginConfig: installed.configPath,
      provider: model,
      approve: ({ name }) => { approvals.push(name); return true },
    })
    const pluginName = installed.names[0]
    try {
      assert.equal(app.report.find((row) => row.name === pluginName).state, 'active')
      assert.notEqual(process.cwd(), workspace)
      await app.ctx.agent.turn('Inspect proto')
      assert.deepEqual(approvals, ['protobuf_status', 'protobuf_outline'])
      const status = app.ctx.session.events.find((event) => event.type === 'tool.finished' && event.callId === 's1').result
      assert.match(status, new RegExp(`workDir: ${workspace.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`))
      assert.equal(status.includes(otherCwd), false)
      const outline = app.ctx.session.events.find((event) => event.type === 'tool.finished' && event.callId === 'o1').result
      assert.match(outline, /Demo/)
      assert.equal(outline.includes('Wrong'), false)
      await app.ctx.livePlugins.unmount(pluginName)
      await uninstallPlugin(pluginName, workspace, { configPath: installed.configPath })
      assert.equal(JSON.parse(await readFile(installed.configPath, 'utf8')).plugins.some((row) => row.name === pluginName), false)
    } finally { await app.dispose() }
    const again = await boot({ workspace, pluginConfig: installed.configPath, provider: fakeProvider([]) })
    try {
      assert.equal(again.report.find((row) => row.name === pluginName), undefined)
      assert.equal(again.ctx.workspace.root, workspace)
      assert.equal(again.ctx.workspace.resolve('demo.proto'), join(workspace, 'demo.proto'))
    } finally { await again.dispose() }
  } else {
    throw new Error(`unknown mode ${mode}`)
  }
} finally {
  await rm(home, { recursive: true, force: true })
}
