import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '../src/boot.js'
import { composition } from '../src/composition.js'
import { acquireWriter, lockPathFor } from '../src/lock.js'
import { Session } from '../src/services.js'

const root = fileURLToPath(new URL('..', import.meta.url))

async function directory() {
  return mkdtemp(join(tmpdir(), 'mini-boot-'))
}

function runMain(env) {
  const child = spawn(process.execPath, ['src/main.js'], {
    cwd: root,
    env: { ...process.env, DEEPSEEK_API_KEY: '', DEEPSEEK_API_KEY_FILE: '', DEEPSEEK_TOOL_CHOICE: '', MINI_VIEW: '', MINI_VIEW_PORT: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`main.js did not exit\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, 5000)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
  return exited
}

test('boot requires an absolute workspace and reports plugin failures after cleanup', async () => {
  let composed = false
  await assert.rejects(() => boot({ workspace: 'relative', composition() { composed = true; return [] } }), /absolute/)
  assert.equal(composed, false)
  const dir = await directory()
  try {
    await assert.rejects(() => boot({ workspace: join(dir, 'missing'), composition: () => [] }), /does not exist/)
    const file = join(dir, 'not-a-directory')
    await writeFile(file, 'x')
    await assert.rejects(() => boot({ workspace: file, composition: () => [] }), /directory/)

    let alive = 0
    const marker = {
      apply(ctx) {
        alive += 1
        ctx.effect(() => () => { alive -= 1 })
      },
    }
    const boom = { apply() { throw new Error('plugin failed') } }
    await assert.rejects(() => boot({
      workspace: dir,
      composition: () => [
        { name: 'marker', plugin: marker },
        { name: 'boom', plugin: boom },
      ],
    }), (error) => {
      assert.equal(error.name, 'BootError')
      assert.match(error.message, /boom failed: plugin failed/)
      assert.equal(error.report.find((item) => item.name === 'boom').state, 'failed')
      return true
    })
    assert.equal(alive, 0)

    const needs = { inject: ['missing'], apply() {} }
    await assert.rejects(() => boot({
      workspace: dir,
      composition: () => [
        { name: 'marker', plugin: marker },
        { name: 'needs-missing', plugin: needs },
      ],
    }), /needs-missing is pending: waiting for missing/)
    assert.equal(alive, 0)

    const optional = await boot({
      workspace: dir,
      composition: () => [{ name: 'optional', plugin: needs, required: false }],
    })
    assert.equal(optional.report[0].state, 'pending')
    await optional.dispose()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('boots the composition, records the workspace, and releases the writer on failure', async () => {
  const dir = await directory()
  try {
    const app = await boot({
      workspace: dir,
      session: 'nested/session.jsonl',
      composition,
      model: { key: '', baseURL: 'http://127.0.0.1', model: 'test' },
    })
    try {
      assert.equal(app.workspace, dir)
      assert.equal(app.sessionPath, join(dir, 'nested/session.jsonl'))
      assert.equal(app.ctx.workspace.root, dir)
      assert.equal(app.ctx.tools.schemas().length, 6)
      assert.equal(app.ctx.session.writable, true)
      assert.equal(app.ctx.session.events[0].type, 'session.opened')
      assert.equal(app.ctx.session.events[0].workspace, dir)
      assert.ok(app.ctx.checkpoint)
      assert.ok(app.ctx.agent)
      assert.ok(app.report.every((item) => item.state === 'active'))
      await assert.rejects(boot({ workspace: dir, session: 'nested/session.jsonl', composition }), /already held/)
    } finally { await app.dispose() }

    const again = await boot({ workspace: dir, session: 'nested/session.jsonl', composition, model: {} })
    await again.dispose()

    let sawWriter = false
    const grab = {
      inject: ['session'],
      apply(ctx) {
        sawWriter = ctx.session.writable
        throw new Error('after session')
      },
    }
    await assert.rejects(() => boot({
      workspace: dir,
      session: 'locked.jsonl',
      composition: ({ sessionPath, workspace }) => [
        { name: 'session', plugin: Session, config: { path: sessionPath, writable: true, workspace } },
        { name: 'grab', plugin: grab },
      ],
    }), /grab failed: after session/)
    assert.equal(sawWriter, true)
    const lock = await acquireWriter(lockPathFor(join(dir, 'locked.jsonl')))
    lock.release()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the entry point rejects a bad workspace and an unknown tool outcome', async () => {
  const relative = await runMain({ MINI_WORKSPACE: 'relative' })
  assert.equal(relative.code, 1)
  assert.match(relative.stderr, /absolute/)

  const dir = await directory()
  try {
    const path = join(dir, '.mini-session.jsonl')
    await writeFile(path, JSON.stringify({ seq: 1, type: 'tool.started', callId: 'shell-9', name: 'shell', time: 't' }) + '\n')
    const interrupted = await runMain({ MINI_WORKSPACE: dir })
    assert.equal(interrupted.code, 1)
    assert.match(interrupted.stderr, /unknown tool outcome for shell-9/)
    assert.equal(await readFile(path, 'utf8'), JSON.stringify({ seq: 1, type: 'tool.started', callId: 'shell-9', name: 'shell', time: 't' }) + '\n')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
