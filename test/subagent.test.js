import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { boot } from '../src/boot.js'
import { composition } from '../src/composition.js'
import { parseSession, projectSessionMessages } from '../src/log.js'
import { fakeProvider } from '../src/provider.js'
import { projectChildMessages } from '../src/subagent.js'

const toolModule = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tool-subagent')

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function assistant(content, calls) {
  return { role: 'assistant', content: content ?? null, ...(calls?.length ? { tool_calls: calls } : {}) }
}

function replies(fn, count = 8) {
  return Array.from({ length: count }, () => fn)
}

function withSubagent(config, extras = []) {
  return (options) => {
    const entries = composition(options)
    const at = entries.findIndex((entry) => entry.name === 'default-tool-permissions')
    entries.splice(at, 0, { name: 'subagent-tool', plugin: subagentTool, config }, ...extras)
    return entries
  }
}

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-subagent-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function toolResult(events) {
  return events.filter((event) => event.type === 'message' && event.message?.role === 'tool').map((event) => event.message.content)
}

test('subagent notices do not close a parent stream and appear after that step', () => {
  const lines = [
    { seq: 1, time: 't', type: 'message', message: { role: 'user', content: 'go' } },
    { seq: 2, time: 't', type: 'stream.started' },
    { seq: 3, time: 't', type: 'stream.ended', stream: 2, finish: 'stop' },
    { seq: 4, time: 't', type: 'subagent.notice', agent: 'agent-1', jobId: 'job-1', content: 'background subagent job job-1 completed: hi', source: { kind: 'subagent', form: 'notice', jobId: 'job-1' } },
    { seq: 5, time: 't', type: 'message', message: { role: 'assistant', content: 'working' } },
  ]
  const buffer = Buffer.from(lines.map((event) => JSON.stringify(event)).join('\n') + '\n')
  const parsed = parseSession(buffer)
  assert.equal(parsed.events.length, 5)
  const messages = projectSessionMessages(parsed.events)
  assert.deepEqual(messages.map((message) => message.content), ['go', 'working', 'background subagent job job-1 completed: hi'])
  assert.equal(messages.at(-1).source.jobId, 'job-1')
})

test('the official subagent tool runs a fresh child with plugin tools and durable JSONL', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'echo.mjs'), `
    export const inject = ['tools', 'permissions']
    export function apply(ctx) {
      ctx.effect(() => ctx.tools.register({
        name: 'echo',
        description: 'Echo text.',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        execute: (args) => args.text,
      }))
      ctx.effect(() => ctx.permissions.register('echo', 'allow'))
    }
  `)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [
    { name: 'subagent-tool', module: toolModule, config: { provider: 'spawn', maxDepth: 2 } },
    { name: 'echo-plugin', module: './echo.mjs' },
  ] }))
  const model = fakeProvider(replies((body) => {
    const blob = JSON.stringify(body.messages)
    const child = !blob.includes('PARENT-SECRET')
    if (child && blob.includes('CHILD-TASK') && !blob.includes('echoed-token')) {
      return assistant(null, [call('e1', 'echo', { text: 'echoed-token' })])
    }
    if (child) return assistant('child-final')
    if (blob.includes('child-final')) return assistant('parent-final')
    return assistant(null, [call('p1', 'subagent', { description: 'echo it', prompt: 'CHILD-TASK' })])
  }))
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider: model })
  try {
    assert.equal(app.report.find((entry) => entry.name === 'subagent-tool').state, 'active')
    assert.equal(app.ctx.tools.items.get('subagent').description.includes('does not see this conversation'), true)
    await app.ctx.agent.turn('PARENT-SECRET')
    const events = app.ctx.session.events
    assert.deepEqual(toolResult(events), ['child-final'])
    const childRequests = events.filter((event) => event.type === 'subagent.model.request')
    assert.ok(childRequests.length >= 1)
    for (const event of childRequests) {
      assert.equal(JSON.stringify(event.body.messages).includes('PARENT-SECRET'), false)
      assert.equal(event.body.messages[0].content, 'CHILD-TASK')
    }
    assert.equal(events.some((event) => event.type === 'subagent.tool.started' && event.name === 'echo' && event.agent === 'agent-1'), true)
    assert.equal(events.some((event) => event.type === 'subagent.permission' && event.name === 'echo' && event.decision === 'allow'), true)
    assert.deepEqual(events.filter((event) => event.type === 'permission.decided').map((event) => event.name), ['subagent'])
    const opened = events.find((event) => event.type === 'subagent.opened')
    assert.equal(opened.parent, 'mini-dsh')
    assert.equal(opened.depth, 1)
    assert.equal(events.find((event) => event.type === 'subagent.settled').stopReason, 'completed')
    assert.deepEqual(projectChildMessages(events, 'agent-1').map((message) => message.content ?? message.tool_calls?.[0]?.function?.name), [
      'CHILD-TASK', 'echo', 'echoed-token', 'child-final',
    ])
    const parentUsers = app.ctx.session.messages.filter((message) => message.role === 'user').map((message) => message.content)
    assert.deepEqual(parentUsers, ['PARENT-SECRET'])
  } finally { await app.dispose() }

  const text = await readFile(join(dir, '.mini-session.jsonl'), 'utf8')
  const saved = text.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(saved.some((event) => event.type === 'subagent.message' && event.message?.content === 'CHILD-TASK'), true)
  const reader = fakeProvider([])
  const again = await boot({ workspace: dir, session: join(dir, '.mini-session.jsonl'), writable: false, provider: reader })
  try {
    assert.equal(reader.sent.length, 0)
    assert.equal(projectChildMessages(again.ctx.session.events, 'agent-1')[0].content, 'CHILD-TASK')
    assert.equal(again.ctx.session.messages.some((message) => message.role === 'user' && message.content === 'CHILD-TASK'), false)
    assert.equal(again.ctx.session.messages.some((message) => message.content === 'child-final'), true)
  } finally { await again.dispose() }
})

test('nested spawn stops at the configured depth', async (t) => {
  const dir = await directory(t)
  const model = fakeProvider(replies((body) => {
    const blob = JSON.stringify(body.messages)
    const child = !blob.includes('ROOT-SECRET')
    if (child && blob.includes('PROMPT-LEAF') && !blob.includes('PROMPT-MID')) return assistant('leaf-ok')
    if (child && blob.includes('leaf-ok')) return assistant('mid-ok')
    if (child && blob.includes('PROMPT-MID') && !blob.includes('exceeds')) {
      return assistant(null, [call('g1', 'subagent', { description: 'leaf', prompt: 'PROMPT-LEAF' })])
    }
    if (child) return assistant('blocked')
    if (blob.includes('mid-ok') || blob.includes('blocked')) return assistant('root-ok')
    return assistant(null, [call('m1', 'subagent', { description: 'mid', prompt: 'PROMPT-MID' })])
  }))
  const app = await boot({
    workspace: dir,
    provider: model,
    composition: withSubagent({ provider: 'spawn', maxDepth: 2 }),
  })
  try {
    await app.ctx.agent.turn('ROOT-SECRET')
    const opened = app.ctx.session.events.filter((event) => event.type === 'subagent.opened')
    assert.deepEqual(opened.map((event) => event.depth), [1, 2])
    assert.equal(toolResult(app.ctx.session.events).at(-1), 'mid-ok')
    assert.equal(app.ctx.session.events.some((event) => event.type === 'subagent.settled' && event.agent === 'agent-2' && event.stopReason === 'completed'), true)
  } finally { await app.dispose() }

  const capped = fakeProvider(replies((body) => {
    const blob = JSON.stringify(body.messages)
    const child = !blob.includes('ROOT-SECRET')
    if (child && blob.includes('NEST') && !blob.includes('exceeds')) {
      return assistant(null, [call('n1', 'subagent', { description: 'deeper', prompt: 'DEEPER' })])
    }
    if (child) return assistant('blocked')
    if (blob.includes('blocked')) return assistant('root-done')
    return assistant(null, [call('p1', 'subagent', { description: 'nest', prompt: 'NEST' })])
  }))
  const limited = await boot({
    workspace: dir,
    session: join(dir, 'depth.jsonl'),
    provider: capped,
    composition: withSubagent({ provider: 'spawn', maxDepth: 1 }),
  })
  try {
    await limited.ctx.agent.turn('ROOT-SECRET')
    const events = limited.ctx.session.events
    assert.deepEqual(events.filter((event) => event.type === 'subagent.opened').map((event) => event.agent), ['agent-1'])
    assert.match(projectChildMessages(events, 'agent-1').find((message) => message.role === 'tool').content, /exceeds maxDepth 1/)
    assert.equal(toolResult(events).at(-1), 'blocked')
  } finally { await limited.dispose() }
})

test('child tool permissions and cancellation go through mini-dsh', async (t) => {
  const dir = await directory(t)
  let ran = false
  const approvals = []
  let release
  const ready = new Promise((resolve) => { release = resolve })
  const gates = {
    inject: ['tools', 'permissions'],
    apply(ctx) {
      ctx.effect(() => ctx.tools.register({
        name: 'needs_approval',
        description: 'Needs approval.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => { ran = true; return 'ran-approval' },
      }))
      ctx.effect(() => ctx.tools.register({
        name: 'wait_for_abort',
        description: 'Wait until cancelled.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: (_args, exec) => new Promise((resolve) => {
          release()
          if (exec?.signal?.aborted) return resolve('aborted')
          exec?.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
        }),
      }))
      ctx.effect(() => ctx.permissions.register('needs_approval', 'ask'))
      ctx.effect(() => ctx.permissions.register('wait_for_abort', 'allow'))
    },
  }
  const approved = fakeProvider(replies((body) => {
    const blob = JSON.stringify(body.messages)
    if (!blob.includes('ASK-PARENT')) {
      if (blob.includes('ran-approval')) return assistant('approved-text')
      return assistant(null, [call('a1', 'needs_approval', {})])
    }
    if (blob.includes('approved-text')) return assistant('parent-ok')
    return assistant(null, [call('p1', 'subagent', { description: 'ask', prompt: 'ASK-CHILD' })])
  }))
  const app = await boot({
    workspace: dir,
    provider: approved,
    approve: (detail) => { approvals.push(detail); return true },
    composition: withSubagent({ provider: 'spawn', maxDepth: 1 }, [{ name: 'gates', plugin: gates }]),
  })
  try {
    await app.ctx.agent.turn('ASK-PARENT')
    assert.equal(ran, true)
    assert.equal(approvals.some((detail) => detail.name === 'needs_approval' && detail.agent === 'agent-1'), true)
    const decision = app.ctx.session.events.find((event) => event.type === 'subagent.permission' && event.name === 'needs_approval')
    assert.equal(decision.decision, 'allow')
    assert.equal(toolResult(app.ctx.session.events).at(-1), 'approved-text')
  } finally { await app.dispose() }

  ran = false
  const denied = fakeProvider(replies((body) => {
    const blob = JSON.stringify(body.messages)
    if (!blob.includes('ASK-PARENT')) {
      if (blob.includes('denied')) return assistant('was-denied')
      return assistant(null, [call('a1', 'needs_approval', {})])
    }
    if (blob.includes('was-denied')) return assistant('parent-ok')
    return assistant(null, [call('p1', 'subagent', { description: 'ask', prompt: 'ASK-CHILD' })])
  }))
  const no = await boot({
    workspace: dir,
    session: join(dir, 'deny.jsonl'),
    provider: denied,
    approve: () => false,
    composition: withSubagent({ provider: 'spawn', maxDepth: 1 }, [{ name: 'gates', plugin: gates }]),
  })
  try {
    await no.ctx.agent.turn('ASK-PARENT')
    assert.equal(ran, false)
    const decision = no.ctx.session.events.find((event) => event.type === 'subagent.permission' && event.name === 'needs_approval')
    assert.equal(decision.decision, 'deny')
    assert.match(projectChildMessages(no.ctx.session.events, 'agent-1').find((message) => message.role === 'tool').content, /denied/)
  } finally { await no.dispose() }

  const waiting = fakeProvider(replies((body) => {
    const blob = JSON.stringify(body.messages)
    if (!blob.includes('CANCEL-ME')) return assistant(null, [call('w1', 'wait_for_abort', {})])
    return assistant(null, [call('p1', 'subagent', { description: 'wait', prompt: 'WAIT-PLEASE' })])
  }))
  const stopping = await boot({
    workspace: dir,
    session: join(dir, 'cancel.jsonl'),
    provider: waiting,
    composition: withSubagent({ provider: 'spawn', maxDepth: 1 }, [{ name: 'gates', plugin: gates }]),
  })
  try {
    const pending = stopping.ctx.agent.turn('CANCEL-ME')
    await ready
    await stopping.ctx.agent.shutdown()
    await pending
    const settled = stopping.ctx.session.events.find((event) => event.type === 'subagent.settled')
    assert.equal(settled.stopReason, 'aborted')
    assert.match(toolResult(stopping.ctx.session.events).at(-1), /cancelled/)
  } finally { await stopping.dispose() }
})

test('one-shot background jobs settle in the log and the next parent request sees the notice', async (t) => {
  const dir = await directory(t)
  let release
  const ready = new Promise((resolve) => { release = resolve })
  const gates = {
    inject: ['tools', 'permissions'],
    apply(ctx) {
      ctx.effect(() => ctx.tools.register({
        name: 'wait_for_abort',
        description: 'Wait until cancelled.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: (_args, exec) => new Promise((resolve) => {
          release()
          if (exec?.signal?.aborted) return resolve('aborted')
          exec?.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
        }),
      }))
      ctx.effect(() => ctx.permissions.register('wait_for_abort', 'allow'))
    },
  }
  const model = fakeProvider(replies((body) => {
    const blob = JSON.stringify(body.messages)
    if (blob.includes('LOOK')) return assistant('saw-notice')
    if (!blob.includes('BG-PARENT')) return assistant(null, [call('w1', 'wait_for_abort', {})])
    if (blob.includes('started background')) return assistant('parent-ok')
    return assistant(null, [call('b1', 'subagent', {
      description: 'bg', prompt: 'WAIT-BG', run_in_background: true,
    })])
  }))
  const app = await boot({
    workspace: dir,
    provider: model,
    composition: withSubagent({ provider: 'spawn', maxDepth: 1 }, [{ name: 'gates', plugin: gates }]),
  })
  try {
    const pending = app.ctx.agent.turn('BG-PARENT')
    await ready
    const running = app.ctx.session.events.find((event) => event.type === 'subagent.job' && event.status === 'running')
    assert.equal(running.jobId, 'job-1')
    assert.equal(app.ctx.jobs.cancel(running.jobId), true)
    await pending
    await app.ctx.jobs.settle()
    assert.match(toolResult(app.ctx.session.events)[0], /started background subagent task job-1/)
    const notice = app.ctx.session.events.find((event) => event.type === 'subagent.notice')
    assert.match(notice.content, /job-1 killed/)
    assert.equal(app.ctx.session.events.find((event) => event.type === 'subagent.settled').stopReason, 'aborted')
    await app.ctx.agent.turn('LOOK')
    const looked = model.sent.find((body) => JSON.stringify(body.messages).includes('LOOK'))
    assert.match(JSON.stringify(looked.messages), /background subagent job job-1 killed/)
  } finally { await app.dispose() }
})

test('unsupported subagent options fail closed', async (t) => {
  const dir = await directory(t)
  const cases = [
    [{ provider: 'spawn', persona: 'reviewer' }, /persona is not supported/],
    [{ provider: 'spawn', toolFilter: { allow: ['read'] } }, /toolFilter is not supported/],
    [{ provider: 'spawn', agentOptions: { model: 'other' } }, /agentOptions are not supported/],
    [{ provider: 'spawn', maxDepth: 'provider-managed' }, /provider-managed/],
    [{ provider: 'spawn', maxDepth: 0 }, /exceeds maxDepth 0/],
    [{ provider: 'spawn', maxDepth: 4 }, /exceeds the mini-dsh limit of 3/],
  ]
  let index = 0
  for (const [config, pattern] of cases) {
    const model = fakeProvider([
      assistant(null, [call('p1', 'subagent', { description: 'nope', prompt: 'DO-NOT-START' })]),
      assistant('done'),
    ])
    const app = await boot({
      workspace: dir,
      session: join(dir, `fail-${index}.jsonl`),
      provider: model,
      composition: withSubagent(config),
    })
    index += 1
    try {
      await app.ctx.agent.turn('parent')
      const events = app.ctx.session.events
      assert.equal(events.some((event) => event.type === 'subagent.opened'), false)
      assert.match(toolResult(events)[0], pattern)
    } finally { await app.dispose() }
  }

  const foregroundOnly = fakeProvider([
    assistant(null, [call('p1', 'subagent', { description: 'bg', prompt: 'NO', run_in_background: true })]),
    assistant('done'),
  ])
  const blocked = await boot({
    workspace: dir,
    session: join(dir, 'foreground-only.jsonl'),
    provider: foregroundOnly,
    composition: withSubagent({ provider: 'spawn', enableRunInBackground: false, maxDepth: 1 }),
  })
  try {
    await blocked.ctx.agent.turn('parent')
    assert.equal(blocked.ctx.session.events.some((event) => event.type === 'subagent.opened'), false)
    assert.match(toolResult(blocked.ctx.session.events)[0], /run_in_background is disabled|invalid arguments/)
  } finally { await blocked.dispose() }

  await assert.rejects(
    boot({
      workspace: dir,
      session: join(dir, 'continuable.jsonl'),
      provider: fakeProvider([]),
      composition: withSubagent({ provider: 'spawn', backgroundMode: 'continuable' }),
    }),
    /continuable/,
  )

  const missing = await boot({
    workspace: dir,
    session: join(dir, 'fork.jsonl'),
    provider: fakeProvider([
      assistant(null, [call('p1', 'subagent', { description: 'fork', prompt: 'NO' })]),
      assistant('done'),
    ]),
    composition: withSubagent({ provider: 'fork' }),
  })
  try {
    assert.equal(missing.ctx.tools.items.has('subagent'), false)
    await missing.ctx.agent.turn('parent')
    assert.match(toolResult(missing.ctx.session.events)[0], /unknown tool/)
    assert.equal(missing.ctx.session.events.some((event) => event.type === 'subagent.opened'), false)
  } finally { await missing.dispose() }

  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tool-subagent', version: '9.9.9', type: 'module' }))
  await writeFile(join(dir, 'index.js'), "export const name = 'tool-subagent'\nexport function apply() {}\n")
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [
    { name: 'future-tool', module: './index.js', config: { provider: 'spawn' } },
  ] }))
  await assert.rejects(
    boot({ workspace: dir, session: join(dir, 'version.jsonl'), pluginConfig: 'plugins.json', provider: fakeProvider([]) }),
    /unsupported DSH subagent tool version 9\.9\.9/,
  )
})

test('a child tool image is stored on the child model request', async (t) => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const dir = await directory(t)
  await writeFile(join(dir, 'picture.mjs'), `
export const inject = ['tools', 'permissions']
export function apply(ctx) {
  const png = ${JSON.stringify(png)}
  ctx.effect(() => ctx.tools.register({
    name: 'picture', description: 'Picture.', parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: () => [{ type: 'text', text: 'frame' }, { type: 'image', mediaType: 'image/png', data: png }],
    },
    execute: () => 'bytes',
  }))
  ctx.effect(() => ctx.permissions.register('picture', 'allow'))
}
`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [
    { name: 'subagent-tool', module: toolModule, config: { provider: 'spawn', maxDepth: 2 } },
    { name: 'picture-plugin', module: './picture.mjs' },
  ] }))
  const model = fakeProvider(replies((body) => {
    const blob = JSON.stringify(body.messages)
    const child = !blob.includes('PARENT-SECRET')
    if (child && blob.includes('CHILD-TASK') && !blob.includes(png)) {
      return assistant(null, [call('e1', 'picture', {})])
    }
    if (child) return assistant('child-final')
    if (blob.includes('child-final')) return assistant('parent-final')
    return assistant(null, [call('p1', 'subagent', { description: 'picture', prompt: 'CHILD-TASK' })])
  }))
  const app = await boot({ workspace: dir, pluginConfig: 'plugins.json', provider: model })
  try {
    await app.ctx.agent.turn('PARENT-SECRET')
    const events = app.ctx.session.events
    const finished = events.find((event) => event.type === 'subagent.tool.finished' && event.name === 'picture')
    assert.equal(finished.result, 'frame')
    assert.equal(finished.content[1].data, png)
    const follow = events.find((event) => event.type === 'subagent.model.request' && JSON.stringify(event.body).includes(png))
    const toolMessage = follow.body.messages.find((message) => message.role === 'tool')
    assert.deepEqual(toolMessage.content, [
      { type: 'text', text: 'frame' },
      { type: 'image', mediaType: 'image/png', data: png },
    ])
    assert.deepEqual(projectChildMessages(events, 'agent-1').find((message) => message.role === 'tool').content, toolMessage.content)
  } finally { await app.dispose() }
})
