import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '../src/boot.js'
import { fakeProvider } from '../src/provider.js'
import { webControlSettings } from '../src/web-control.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const example = join(root, 'examples/plugins/greeting.mjs')
const call = (name, args) => ({ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } })
const assistant = (calls) => ({ role: 'assistant', content: null, tool_calls: calls })

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-plugins-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function profile(dir, value, name = 'plugins.json') {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(value))
  return path
}

test('a config adds a plugin, disables a built-in, and removes contributions on disposal', async (t) => {
  const dir = await directory(t)
  await mkdir(join(dir, 'profile'))
  await copyFile(example, join(dir, 'profile', 'greeting.mjs'))
  await profile(join(dir, 'profile'), { plugins: [
    { name: 'coding', enabled: false },
    { name: 'greeting', module: './greeting.mjs', config: { prefix: 'Hi' } },
  ] })
  const provider = fakeProvider([assistant([call('greet', { name: 'Ada' })]), { role: 'assistant', content: 'done' }])
  let asks = 0
  const app = await boot({ workspace: dir, pluginConfig: 'profile/plugins.json', provider, approve: () => { asks++; return false } })
  const { tools, permissions } = app.ctx
  try {
    assert.deepEqual(tools.schemas().map((item) => item.function.name).sort(), ['greet', 'skill'])
    assert.equal(app.report.find((item) => item.name === 'greeting').state, 'active')
    assert.equal(app.report.some((item) => item.name === 'coding'), false)
    await app.ctx.agent.turn('Say hello')
    assert.equal(asks, 0)
    assert.equal(app.ctx.session.events.find((event) => event.type === 'tool.finished').result, 'Hi, Ada!')
    assert.equal(app.ctx.session.events.find((event) => event.type === 'permission.decided').decision, 'allow')
    assert.match(provider.sent[0].context[0].permissions, /greet/)
  } finally { await app.dispose() }
  assert.equal(tools.items.has('greet'), false)
  assert.equal(permissions.policies.has('greet'), false)
})

test('a profile selects built-in coding tools and describes only installed policies', async (t) => {
  const dir = await directory(t)
  await profile(dir, { plugins: [{ name: 'coding', config: { tools: ['read', 'glob', 'grep'] } }] })
  const provider = fakeProvider([{ role: 'assistant', content: 'done' }])
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider })
  try {
    assert.deepEqual(app.ctx.tools.schemas().map((tool) => tool.function.name).sort(), ['glob', 'grep', 'read', 'skill'])
    await app.ctx.agent.turn('Hello')
    const policy = provider.sent[0].context[0].permissions
    assert.match(policy, /read, glob, grep, and skill are allowed/)
    assert.doesNotMatch(policy, /write|edit|shell/)
    const instructions = provider.sent[0].instructions.join('\n')
    assert.match(instructions, /glob.*grep/)
    assert.doesNotMatch(instructions, /before editing/)
  } finally { await app.dispose() }
})

test('an extension must register a policy and ask policies keep per-call approval', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'policy.mjs'), `
export default {
  inject: ['tools', 'permissions'],
  apply(ctx) {
    for (const name of ['unlisted', 'ask_me']) {
      ctx.effect(() => ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => 'ran' }))
    }
    ctx.effect(() => ctx.permissions.register('ask_me', 'ask'))
  },
}
`)
  const config = await profile(dir, { plugins: [{ name: 'extra', module: './policy.mjs' }] })
  const provider = fakeProvider([assistant([call('unlisted', {}), { ...call('ask_me', {}), id: 'call-2' }]), { role: 'assistant', content: 'done' }])
  const asks = []
  const app = await boot({ workspace: dir, pluginConfig: config, provider, approve: (detail) => { asks.push(detail); return false } })
  try {
    await app.ctx.agent.turn('Try both')
    const decisions = app.ctx.session.events.filter((event) => event.type === 'permission.decided')
    assert.deepEqual(decisions.map(({ name, decision }) => [name, decision]), [['unlisted', 'deny'], ['ask_me', 'deny']])
    assert.equal(asks.length, 1)
    assert.equal(asks[0].name, 'ask_me')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started'), false)
  } finally { await app.dispose() }
})

test('a profile can replace the default tool permissions', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'permissions.mjs'), `
export default {
  inject: ['permissions'],
  apply(ctx) { ctx.effect(() => ctx.permissions.register('read', 'ask')) },
}
`)
  await profile(dir, { plugins: [
    { name: 'default-tool-permissions', enabled: false },
    { name: 'custom-permissions', module: './permissions.mjs' },
  ] })
  const provider = fakeProvider([assistant([call('read', { path: 'note.txt' })]), { role: 'assistant', content: 'done' }])
  const asks = []
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider, approve: (detail) => { asks.push(detail); return false } })
  try {
    await app.ctx.agent.turn('Read the note')
    assert.deepEqual(asks.map((detail) => detail.name), ['read'])
    assert.equal(app.ctx.session.events.find((event) => event.type === 'permission.decided').decision, 'deny')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'tool.started'), false)
    assert.match(provider.sent[0].context[0].permissions, /each read call requires approval/)
  } finally { await app.dispose() }
})

test('a configured provider replaces the terminal default without reading its environment', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'provider.mjs'), `
export const custom = {
  inject: ['model'],
  apply(ctx) {
    ctx.effect(() => ctx.model.register({
      name: 'custom',
      prepare(input) { return { messages: input.messages } },
      async *dispatch() { yield { start: true }; yield { text: 'custom provider' }; yield { finish: 'stop' } },
    }))
  },
}
`)
  await profile(dir, { plugins: [{ name: 'provider', module: './provider.mjs', export: 'custom' }] })
  const child = spawn(process.execPath, ['src/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      MINI_WORKSPACE: dir, MINI_CONFIG: 'plugins.json', MINI_REPLIES: join(dir, 'missing.json'),
      MINI_SESSION: '', MINI_INSPECT: '', MINI_VIEW: '', MINI_WEB: '', DEEPSEEK_API_KEY: '',
      DEEPSEEK_API_KEY_FILE: join(dir, 'missing-key'), DSH_HOME: dir, DSH_AGENTS_HOME: dir, DSH_BUNDLED_SKILL_DIR: dir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.end('hello\n/quit\n')
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('terminal did not exit')) }, 5000)
    child.once('error', reject)
    child.once('close', (code) => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(status, 0, stderr)
  assert.match(stdout, /assistant> custom provider/)
  const events = (await readFile(join(dir, '.mini-session.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(events.find((event) => event.type === 'model.request').provider, 'custom')
})

test('a configured terminal can drive the agent and provide approvals', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'terminal.mjs'), `
export default {
  inject: ['agent'],
  apply(ctx) {
    ctx.provide('terminal', {
      async run() { await ctx.agent.turn('Write from the custom terminal'); console.log('custom terminal finished') },
      approve(detail) { console.log('custom approval:', detail.name); return true },
    })
  },
}
`)
  await profile(dir, { plugins: [{ name: 'terminal', module: './terminal.mjs' }] })
  await writeFile(join(dir, 'replies.json'), JSON.stringify([
    assistant([call('write', { path: 'created.txt', content: 'hello' })]),
    { role: 'assistant', content: 'done' },
  ]))
  const child = spawn(process.execPath, ['src/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      MINI_WORKSPACE: dir, MINI_CONFIG: 'plugins.json', MINI_REPLIES: join(dir, 'replies.json'),
      MINI_SESSION: '', MINI_INSPECT: '', MINI_VIEW: '', MINI_WEB: '', DSH_HOME: dir, DSH_AGENTS_HOME: dir, DSH_BUNDLED_SKILL_DIR: dir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('custom terminal did not exit')) }, 5000)
    child.once('error', reject)
    child.once('close', (code) => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(status, 0, stderr)
  assert.match(stdout, /custom approval: write/)
  assert.match(stdout, /custom terminal finished/)
  assert.equal(await readFile(join(dir, 'created.txt'), 'utf8'), 'hello')
  const events = (await readFile(join(dir, '.mini-session.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(events.find((event) => event.type === 'permission.decided').decision, 'allow')
})

test('a profile can disable web control without reading its port', async (t) => {
  const dir = await directory(t)
  const web = webControlSettings({ MINI_WEB_PORT: '99999' })
  await assert.rejects(boot({ workspace: dir, web }), /MINI_WEB_PORT is invalid/)
  await profile(dir, { plugins: [{ name: 'web-control', enabled: false }] })
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', web })
  try { assert.equal(app.ctx.webControl, undefined) }
  finally { await app.dispose() }
})

test('config errors fail before boot and optional plugins may remain pending', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'invalid.json'), '{')
  await assert.rejects(boot({ workspace: dir, pluginConfig: 'invalid.json' }), /not valid JSON/)
  for (const [value, message] of [
    [{ plugins: [{ name: 'not-found', enabled: false }] }, /Unknown plugin: not-found/],
    [{ plugins: [{ name: 'coding' }, { name: 'coding' }] }, /Duplicate plugin entry/],
    [{ plugins: [{ name: 'new', module: './missing.mjs', before: 'not-found' }] }, /unknown before target/],
    [{ plugins: [{ name: 'new', module: './missing.mjs' }] }, /could not load/],
    [{ plugins: [{ name: 'coding', config: { tools: ['missing'] } }] }, /coding: unknown tool missing/],
  ]) {
    await profile(dir, value)
    await assert.rejects(boot({ workspace: dir, pluginConfig: 'plugins.json' }), message)
  }
  await writeFile(join(dir, 'pending.mjs'), "export default { inject: ['absent'], apply() {} }\n")
  await profile(dir, { plugins: [{ name: 'optional', module: './pending.mjs', required: false }] })
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json' })
  try { assert.equal(app.report.find((item) => item.name === 'optional').state, 'pending') }
  finally { await app.dispose() }
})

test('the entire overlay is validated before any external module is evaluated', async (t) => {
  const dir = await directory(t)
  const marker = join(dir, 'imported')
  await writeFile(join(dir, 'side-effect.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'imported')\nexport default { apply() {} }\n`)
  await profile(dir, { plugins: [
    { name: 'side-effect', module: './side-effect.mjs' },
    { name: 'misspelled', enabled: false },
  ] })
  await assert.rejects(boot({ workspace: dir, pluginConfig: 'plugins.json' }), /Unknown plugin: misspelled/)
  await assert.rejects(access(marker))
})

test('inspect mode ignores the interactive plugin config', async (t) => {
  const dir = await directory(t)
  const marker = join(dir, 'imported')
  await writeFile(join(dir, 'side-effect.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'imported')\nexport default { apply() {} }\n`)
  await profile(dir, { plugins: [{ name: 'side-effect', module: './side-effect.mjs' }] })
  const child = spawn(process.execPath, ['src/main.js'], {
    cwd: root,
    env: { ...process.env, MINI_WORKSPACE: dir, MINI_CONFIG: 'plugins.json', MINI_SESSION: '', MINI_INSPECT: '1', MINI_VIEW: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('inspect did not exit')) }, 5000)
    child.once('error', reject)
    child.once('close', (code) => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(status, 0, stderr)
  await assert.rejects(access(marker))
})

test('an external plugin startup failure disposes its effects and releases the session', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'broken.mjs'), `
import { appendFileSync } from 'node:fs'
export default {
  inject: ['tools'],
  apply(ctx, config) {
    ctx.effect(() => { appendFileSync(config.marker, 'start\\n'); return () => appendFileSync(config.marker, 'stop\\n') })
    throw new Error('broken plugin')
  },
}
`)
  await profile(dir, { plugins: [{ name: 'broken', module: './broken.mjs', config: { marker: join(dir, 'marker') } }] })
  await assert.rejects(boot({ workspace: dir, pluginConfig: 'plugins.json' }), /broken failed: broken plugin/)
  assert.equal(await readFile(join(dir, 'marker'), 'utf8'), 'start\nstop\n')
  const app = await boot({ workspace: dir })
  await app.dispose()
})
