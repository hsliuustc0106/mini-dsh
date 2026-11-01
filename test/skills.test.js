import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '../src/boot.js'
import { parseSession } from '../src/log.js'
import { deepseekProvider, fakeProvider } from '../src/provider.js'
import { discoverSkills } from '../src/skills.js'
import { project } from '../src/trajectory.js'

const root = fileURLToPath(new URL('..', import.meta.url))

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

function skill(name, description, body, extra = '') {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`
}

function call(id, name) {
  return { id, type: 'function', function: { name: 'skill', arguments: JSON.stringify({ name }) } }
}

function assistant(content, calls) {
  return { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }
}

test('discovers dsh roots in priority order from the nearest git root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-skills-'))
  const project = join(dir, 'project'), cwd = join(project, 'nested')
  const dshHome = join(dir, 'dsh-home'), agentsHome = join(dir, 'agents-home')
  const custom = join(dir, 'custom'), bundled = join(dir, 'bundled')
  const paths = [
    join(project, '.dsh', 'skills'), join(project, '.agents', 'skills'), custom,
    join(dshHome, 'skills'), join(agentsHome, 'skills'), bundled,
  ]
  const options = { env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: '~/agents-home', DSH_BUNDLED_SKILL_DIR: bundled }, home: dir, customSkillDirs: [custom] }
  try {
    await mkdir(cwd, { recursive: true })
    await put(join(project, '.git'), 'gitdir: elsewhere')
    for (let i = 0; i < paths.length; i++) {
      await put(join(paths[i], 'same', 'SKILL.md'), skill('same', `source-${i}`, `body-${i}`))
      await put(join(paths[i], `unique-${i}.md`), skill(`unique-${i}`, `source-${i}`, `body-${i}`))
    }
    await put(join(dshHome, 'skills', '.system', 'SKILL.md'), skill('system', 'hidden', 'hidden'))
    await put(join(project, '.agents', 'skills', 'outer', 'inner', 'SKILL.md'), skill('nested', 'hidden', 'hidden'))
    await put(join(project, '.agents', 'skills', 'block.md'), skill('block', '>\n  folded description\n  with details', 'body'))
    await put(join(dir, 'linked', 'SKILL.md'), skill('linked', 'linked description', 'linked body'))
    await symlink(join(dir, 'linked'), join(project, '.agents', 'skills', 'linked'))

    let result = await discoverSkills(cwd, options)
    assert.equal(result.complete, true)
    assert.deepEqual(result.skills.map((item) => item.name), ['block', 'linked', 'same', 'unique-0', 'unique-1', 'unique-2', 'unique-3', 'unique-4', 'unique-5'])
    assert.match(result.skills.find((item) => item.name === 'block').description, /folded description with details/)
    assert.equal(result.skills.find((item) => item.name === 'linked').content, 'linked body')
    for (let i = 0; i < paths.length; i++) {
      result = await discoverSkills(cwd, options)
      assert.equal(result.skills.find((item) => item.name === 'same').description, `source-${i}`)
      await unlink(join(paths[i], 'same', 'SKILL.md'))
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('uses the default user roots when home overrides are unset or blank', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-skills-'))
  const workspace = join(dir, 'workspace')
  try {
    await mkdir(workspace)
    await put(join(dir, '.dsh', 'skills', 'dsh.md'), skill('dsh', 'DSH home', 'dsh instructions'))
    await put(join(dir, '.agents', 'skills', 'agents.md'), skill('agents', 'Agents home', 'agents instructions'))
    const result = await discoverSkills(workspace, { home: dir, env: { DSH_HOME: ' ', DSH_AGENTS_HOME: '' } })
    assert.deepEqual(result.skills.map((item) => item.name), ['agents', 'dsh'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('skips malformed skills and keeps disabled higher-priority skills from falling through', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-skills-'))
  const root = join(dir, '.dsh', 'skills'), lower = join(dir, '.agents', 'skills')
  const warnings = []
  try {
    await put(join(root, 'hidden.md'), skill('hidden', 'user-only', 'private body', 'disable-model-invocation: yes\n'))
    await put(join(lower, 'hidden.md'), skill('hidden', 'lower priority', 'lower body'))
    await put(join(root, 'invalid.md'), skill('invalid', 'bad flag', 'body', 'disable-model-invocation: maybe\n'))
    await put(join(root, 'bad-yaml.md'), '---\nname: [\n---\nbody\n')
    await put(join(root, 'invalid-name.md'), skill('Invalid', 'bad name', 'body'))
    await put(join(root, 'model-only.md'), skill('model-only', 'available', 'body', 'user-invocable: false\n'))
    const result = await discoverSkills(dir, { env: {}, home: join(dir, 'empty-home') }, (message) => warnings.push(message))
    assert.equal(result.complete, true)
    assert.deepEqual(result.skills.map((item) => [item.name, item.modelInvocable, item.userInvocable]), [['hidden', false, true], ['model-only', true, false]])
    assert.equal(result.skills[0].content, 'private body')
    assert.equal(warnings.length, 3)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('explicit invocations load hidden and ordinary skills once and survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-skills-invoke-'))
  const hidden = join(dir, '.dsh', 'skills', 'hidden', 'SKILL.md')
  const ordinary = join(dir, '.agents', 'skills', 'ordinary.md')
  const options = { env: {}, home: join(dir, 'empty-home') }
  await put(hidden, skill('hidden', 'User-only skill', 'original hidden instructions', 'disable-model-invocation: true\n'))
  await put(ordinary, skill('ordinary', 'Ordinary skill', 'ordinary instructions'))
  await put(join(dir, 'note.txt'), 'note')
  const provider = fakeProvider([
    assistant(null, [{ id: 'read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'note.txt' }) } }]),
    assistant('done'),
  ])
  let app = await boot({ workspace: dir, provider, skillOptions: options })
  try {
    const input = 'Please use /hidden and /ordinary then /hidden again'
    await app.ctx.agent.turn(input)
    const first = provider.sent[0]
    assert.equal(first.messages[0].content, input)
    assert.equal(first.messages.length, 3)
    assert.match(first.messages[1].content, /original hidden instructions/)
    assert.ok(first.messages[1].content.includes(dirname(hidden)))
    assert.match(first.messages[2].content, /ordinary instructions/)
    assert.doesNotMatch(first.instructions.join('\n'), /"name":"hidden"/)
    assert.match(first.instructions.join('\n'), /"name":"ordinary"/)
    assert.equal(provider.sent[1].messages.filter((message) => message.content?.includes('<skill_content name="hidden">')).length, 1)
    const user = app.ctx.session.events.find((event) => event.message?.role === 'user').message
    assert.equal(user.content, input)
    assert.deepEqual(user.skillInvocations.map((item) => item.name), ['hidden', 'ordinary'])
    assert.equal(project(app.ctx.session.events).turns.length, 1)
    assert.equal(project(app.ctx.session.events).turns[0].input, input)
    await app.dispose()

    await put(hidden, skill('hidden', 'User-only skill', 'updated hidden instructions', 'disable-model-invocation: true\n'))
    const nextProvider = fakeProvider([assistant('continued'), assistant('updated')])
    app = await boot({ workspace: dir, provider: nextProvider, skillOptions: options })
    await app.ctx.agent.turn('Continue')
    assert.ok(nextProvider.sent[0].messages.some((message) => message.content?.includes('original hidden instructions')))
    assert.equal(nextProvider.sent[0].messages.some((message) => message.content?.includes('updated hidden instructions')), false)
    await app.ctx.agent.turn('/hidden run again')
    assert.ok(nextProvider.sent[1].messages.some((message) => message.content?.includes('updated hidden instructions')))
    assert.equal(project(app.ctx.session.events).turns.length, 3)
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('unknown names, user-disabled skills, paths and non-whitespace boundaries do not invoke skills', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-skills-invoke-'))
  const root = join(dir, '.dsh', 'skills'), lower = join(dir, '.agents', 'skills')
  await put(join(root, 'ordinary.md'), skill('ordinary', 'Available', 'ordinary instructions'))
  await put(join(root, 'model-only.md'), skill('model-only', 'Model only', 'model instructions', 'user-invocable: false\n'))
  await put(join(root, 'both-disabled.md'), skill('both-disabled', 'Not invocable', 'private instructions', 'disable-model-invocation: true\nuser-invocable: false\n'))
  await put(join(lower, 'both-disabled.md'), skill('both-disabled', 'Lower priority', 'lower instructions'))
  const provider = fakeProvider([assistant(null, [call('model-call', 'model-only')]), assistant('done')])
  const app = await boot({ workspace: dir, provider, skillOptions: { env: {}, home: join(dir, 'empty-home') } })
  try {
    const input = '/unknown /model-only /both-disabled /ordinary/path x/ordinary /ordinary, 5/8 https://example.test/ordinary'
    await app.ctx.agent.turn(input)
    const first = provider.sent[0]
    assert.equal(first.messages.length, 1)
    assert.equal(first.messages[0].content, input)
    assert.equal(app.ctx.session.events.find((event) => event.message?.role === 'user').message.skillInvocations, undefined)
    assert.match(app.ctx.session.events.find((event) => event.callId === 'model-call' && event.type === 'tool.finished').result, /model instructions/)
    assert.doesNotMatch(JSON.stringify(first), /private instructions|lower instructions|ordinary instructions/)
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('explicit skill contents are recorded atomically before the model receives them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-skills-invoke-'))
  await put(join(dir, '.agents', 'skills', 'hidden.md'), skill('hidden', 'User-only', 'sensitive instructions', 'disable-model-invocation: true\n'))
  const provider = fakeProvider([assistant('should not run')])
  const app = await boot({ workspace: dir, provider, skillOptions: { env: {}, home: join(dir, 'empty-home') } })
  try {
    app.ctx.session.config.write = async () => { throw new Error('disk full') }
    await assert.rejects(app.ctx.agent.turn('/hidden run'), /disk full/)
    assert.equal(provider.sent.length, 0)
    assert.equal(app.ctx.session.events.some((event) => event.message?.role === 'user'), false)
    assert.doesNotMatch(await readFile(app.sessionPath, 'utf8'), /sensitive instructions/)
    const malformed = { seq: 1, type: 'message', message: { role: 'user', content: '/hidden', skillInvocations: [{ name: 'hidden' }] } }
    assert.throws(() => parseSession(Buffer.from(JSON.stringify(malformed) + '\n')), /invalid skill invocations/)
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('DeepSeek requests include explicitly invoked instructions as user context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-skills-invoke-'))
  await put(join(dir, '.agents', 'skills', 'hidden.md'), skill('hidden', 'User-only', 'deepseek instructions', 'disable-model-invocation: true\n'))
  const sent = []
  const provider = deepseekProvider({
    apiKey: 'test-key',
    async fetch(_url, options) {
      sent.push(JSON.parse(options.body))
      const chunk = { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 })
    },
  })
  const app = await boot({ workspace: dir, provider, skillOptions: { env: {}, home: join(dir, 'empty-home') } })
  try {
    await app.ctx.agent.turn('/hidden do the task')
    assert.deepEqual(sent[0].messages.map((message) => message.role), ['system', 'user', 'user'])
    assert.equal(sent[0].messages[1].content, '/hidden do the task')
    assert.match(sent[0].messages[2].content, /deepseek instructions/)
    assert.doesNotMatch(sent[0].messages[0].content, /deepseek instructions/)
    assert.deepEqual(app.ctx.session.events.find((event) => event.type === 'model.request').body, sent[0])
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('reports an unreadable root and retries discovery after it is repaired', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-skills-'))
  const parent = join(dir, '.agents'), root = join(parent, 'skills'), warnings = []
  try {
    await mkdir(parent, { recursive: true })
    await symlink('skills', root)
    const options = { env: {}, home: join(dir, 'empty-home') }
    const first = await discoverSkills(dir, options, (message) => warnings.push(message))
    assert.equal(first.complete, false)
    assert.equal(warnings.length, 1)
    await unlink(root)
    await put(join(root, 'recovered.md'), skill('recovered', 'fixed', 'instructions'))
    const next = await discoverSkills(dir, options)
    assert.equal(next.complete, true)
    assert.deepEqual(next.skills.map((item) => item.name), ['recovered'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('catalogs skills, loads them through a recorded read-only tool, and refreshes changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-skills-'))
  const path = join(dir, '.agents', 'skills', 'review', 'SKILL.md')
  await put(path, skill('review', 'Review changes', 'first instructions'))
  await put(join(dir, '.agents', 'skills', 'hidden.md'), skill('hidden', 'private', 'secret instructions', 'disable-model-invocation: true\n'))
  const provider = fakeProvider([
    assistant(null, [call('load-1', 'review'), call('hidden-1', 'hidden')]),
    assistant('first done'),
    assistant(null, [call('load-2', 'review')]),
    assistant('second done'),
  ])
  const asks = []
  const app = await boot({ workspace: dir, provider, skillOptions: { env: {}, home: join(dir, 'empty-home') }, approve: (detail) => asks.push(detail) })
  try {
    await app.ctx.agent.turn('Review this')
    const first = provider.sent[0]
    assert.match(first.instructions.join('\n'), /"name":"review"/)
    assert.doesNotMatch(first.instructions.join('\n'), /first instructions|"name":"hidden"|secret instructions/)
    assert.ok(first.tools.some((tool) => tool.function.name === 'skill'))
    const result = app.ctx.session.events.find((event) => event.callId === 'load-1' && event.type === 'tool.finished')
    assert.match(result.result, /first instructions/)
    assert.ok(result.result.includes(dirname(path)))
    const hidden = app.ctx.session.events.find((event) => event.callId === 'hidden-1' && event.type === 'tool.finished')
    assert.match(hidden.result, /not available/)
    assert.doesNotMatch(hidden.result, /secret instructions/)
    assert.deepEqual(asks, [])
    assert.equal(app.ctx.session.events.find((event) => event.callId === 'load-1' && event.type === 'permission.decided').decision, 'allow')

    await put(path, skill('review', 'Updated description', 'second instructions'))
    await app.ctx.agent.turn('Review again')
    assert.match(provider.sent[2].instructions.join('\n'), /Updated description/)
    assert.match(app.ctx.session.events.find((event) => event.callId === 'load-2' && event.type === 'tool.finished').result, /second instructions/)
    assert.deepEqual(app.ctx.session.events.filter((event) => event.type === 'model.request').map((event) => event.body), provider.sent)
  } finally { await app.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('the terminal discovers user skills through DSH_HOME', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-skills-cli-'))
  const home = join(dir, 'dsh-home'), workspace = join(dir, 'workspace')
  try {
    await mkdir(workspace)
    await put(join(home, 'skills', 'cli.md'), skill('cli', 'Terminal skill', 'terminal instructions'))
    await put(join(home, 'skills', 'hidden.md'), skill('hidden', 'User-only skill', 'explicit terminal instructions', 'disable-model-invocation: true\n'))
    const replies = join(dir, 'replies.json')
    await writeFile(replies, JSON.stringify([assistant(null, [call('cli-call', 'cli')]), assistant('done'), assistant('explicit done')]))
    const child = spawn(process.execPath, ['src/main.js'], {
      cwd: root,
      env: { ...process.env, MINI_WORKSPACE: workspace, MINI_SESSION: join(workspace, '.mini-session.jsonl'), MINI_REPLIES: replies, MINI_CLOCK: '', MINI_INSPECT: '', MINI_VIEW: '', DSH_HOME: home, DSH_AGENTS_HOME: join(dir, 'empty-agents'), DSH_BUNDLED_SKILL_DIR: join(dir, 'empty-bundled') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = '', errors = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { errors += chunk })
    child.stdin.end('Use cli\n/hidden perform the task\n/quit\n')
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`terminal did not exit: ${errors}`)) }, 5000)
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('exit', (status) => { clearTimeout(timer); resolve(status) })
    })
    assert.equal(code, 0, errors)
    assert.match(output, /terminal instructions/)
    assert.doesNotMatch(output, /Approve skill/)
    const events = (await readFile(join(workspace, '.mini-session.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(events.find((event) => event.type === 'model.request').body.instructions.some((part) => part.includes('Terminal skill')))
    assert.equal(events.find((event) => event.type === 'permission.decided').decision, 'allow')
    const explicit = events.find((event) => event.message?.content === '/hidden perform the task').message
    assert.deepEqual(explicit.skillInvocations.map((item) => item.name), ['hidden'])
    assert.match(explicit.skillInvocations[0].content, /explicit terminal instructions/)
    assert.ok(events.filter((event) => event.type === 'model.request').at(-1).body.messages.some((message) => message.content?.includes('explicit terminal instructions')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
