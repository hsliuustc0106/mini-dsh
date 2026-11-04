import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'

async function installInvoice(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-dsh-invoice-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'pipe' })
  execFileSync('npm', ['install', '--no-audit', '--no-fund', 'dsh-tool-invoice@1.0.0'], {
    cwd: dir, stdio: 'pipe', env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
  })
  const resolved = createRequire(join(dir, 'package.json')).resolve('dsh-tool-invoice')
  return { dir, resolved }
}

test('unmodified dsh-tool-invoice status tool renders structured object output as text', async (t) => {
  const { dir, resolved } = await installInvoice(t)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [
      { name: 'tool-invoice', module: resolved, config: { status: true, extract: false, ledger: false, textCommand: '' } },
      { name: 'default-tool-permissions', config: { policies: { invoice_status: 'ask' } } },
    ],
  }))
  const approvals = []
  const model = fakeProvider([
    { role: 'assistant', content: null, tool_calls: [{ id: 'inv-1', type: 'function', function: { name: 'invoice_status', arguments: '{}' } }] },
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({
    workspace: dir, pluginConfig: 'plugins.json', provider: model,
    approve: ({ name }) => { approvals.push(name); return true },
  })
  const tools = app.ctx.tools
  try {
    assert.equal(app.report.find((entry) => entry.name === 'tool-invoice').state, 'active')
    assert.deepEqual(
      tools.schemas().map((schema) => schema.function.name).filter((name) => name.startsWith('invoice')),
      ['invoice_status'],
    )
    await app.ctx.agent.turn('Invoice status')
    assert.deepEqual(approvals, ['invoice_status'])
    const finished = app.ctx.session.events.find((event) => event.type === 'tool.finished')
    assert.match(finished.result, /Document reading: NOT CONFIGURED/)
    assert.match(finished.result, /Recognised fields \(\d+\):/)
    assert.equal(model.sent[1].messages.at(-1).content, finished.result)
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.failed'), false)
  } finally { await app.dispose() }
  assert.equal(tools.items.has('invoice_status'), false)
})

test('unmodified dsh-tool-invoice remains denied without a policy and does not start', async (t) => {
  const { dir, resolved } = await installInvoice(t)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({
    plugins: [
      { name: 'tool-invoice', module: resolved, config: { status: true, extract: false, ledger: false, textCommand: '' } },
    ],
  }))
  const model = fakeProvider([
    { role: 'assistant', content: null, tool_calls: [{ id: 'inv-2', type: 'function', function: { name: 'invoice_status', arguments: '{}' } }] },
    { role: 'assistant', content: 'done' },
  ])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider: model })
  try {
    await app.ctx.agent.turn('Invoice status')
    const decision = app.ctx.session.events.find((event) => event.type === 'permission.decided')
    assert.equal(decision.decision, 'deny')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started'), false)
  } finally { await app.dispose() }
})
