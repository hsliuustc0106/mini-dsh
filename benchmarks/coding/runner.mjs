import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { boot } from '../../src/boot.js'
import { composition } from '../../src/composition.js'
import { Permissions } from '../../src/permissions.js'
import { Prompt } from '../../src/prompt.js'
import { deepseekProvider, DEEPSEEK_MODEL } from '../../src/provider.js'
import { checkPublicConfig } from './public-quality.mjs'
import { checkQuality } from './quality.mjs'
import { ensureSandbox, startSandbox } from './sandbox.mjs'
import { tasks } from './tasks.mjs'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const previousBase = 'You are a coding assistant. Inspect relevant files, make focused changes, and run suitable checks. Use tools when needed. Explain results and failures honestly.'

// In the original composition, the coding plugin had no static order-10
// instruction; skill instructions are dynamic and stay in both variants.
class PreviousPrompt extends Prompt {
  async snapshot() {
    const snap = await super.snapshot()
    const codingInstructions = this.parts.filter((part) => part.order === 10 && typeof part.instructions === 'string').map((part) => part.instructions)
    return { ...snap, instructions: snap.instructions.filter((part) => !codingInstructions.includes(part)) }
  }
}

const previousInstructions = {
  inject: ['prompt'],
  apply(ctx) { ctx.effect(() => ctx.prompt.contribute({ order: 0, instructions: previousBase })) },
}

function isInside(root, path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function resolvesInside(root, path) {
  const realRoot = await realpath(root)
  for (let current = path; ; current = dirname(current)) {
    try { return isInside(realRoot, await realpath(current)) }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(current) === current) return false
    }
  }
}

// The normal permission service allows arbitrary reads and asks about shell.
// Benchmark tasks need only fixture reads and edits to their one source file.
export function restrictedPermissions(target) {
  return class extends Permissions {
    async decide(call, signal, approve) {
      const root = this.ctx.workspace.root
      let allowed = true
      if (call.name === 'skill' || call.name === 'shell') allowed = false
      if (['read', 'glob', 'grep', 'write', 'edit'].includes(call.name)) {
        const path = resolve(root, call.arguments?.path ?? '.')
        allowed = isInside(root, path)
        if (allowed) allowed = await resolvesInside(root, path)
        if (allowed && ['write', 'edit'].includes(call.name)) allowed = path === resolve(root, target)
      }
      if (!allowed) return { ...call, workspace: root, decision: 'deny', reason: 'benchmark restriction' }
      return super.decide(call, signal, approve)
    }
  }
}

export function benchmarkComposition(variant, target) {
  return (options) => composition(options).map((entry) => {
    if (entry.name === 'permissions') return { ...entry, plugin: restrictedPermissions(target) }
    if (variant === 'previous' && entry.name === 'prompt') return { ...entry, plugin: PreviousPrompt }
    if (variant === 'previous' && entry.name === 'instructions') return { ...entry, plugin: previousInstructions }
    return entry
  })
}

export async function grade(task, workspace, start = startSandbox) {
  let sandbox
  try {
    sandbox = await start(join(workspace, task.file))
    return await checkQuality(task.id, sandbox)
  } catch (error) {
    return { checks: [], passed: false, error: String(error.message ?? error).slice(0, 500) }
  } finally { if (sandbox) await sandbox.close() }
}

async function publicConfigCheck(task, workspace, start, signal) {
  const sandbox = await start(join(workspace, task.file))
  let closing
  const close = () => closing ??= sandbox.close()
  const onAbort = () => { void close().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) throw new Error('Benchmark timeout')
    return await checkPublicConfig(sandbox)
  } finally {
    signal.removeEventListener('abort', onAbort)
    await close()
  }
}

export async function runOne({ task, variant, repetition, directory, apiKey, model = DEEPSEEK_MODEL, baseUrl, fetchImpl = fetch, maxCalls = 20, timeoutMs = 120000, start = startSandbox, fixtures = join(here, 'fixtures') }) {
  const workspace = join(directory, 'workspace')
  const emptyHome = join(directory, 'empty-skill-home')
  await mkdir(directory, { recursive: true })
  await cp(join(fixtures, task.id), workspace, { recursive: true })
  await mkdir(emptyHome)
  const initial = await readFile(join(workspace, task.file), 'utf8')
  let calls = 0
  const provider = deepseekProvider({
    apiKey, model, baseUrl,
    fetch: async (url, options) => {
      if (calls >= maxCalls) throw new Error(`Benchmark stopped after ${maxCalls} model calls`)
      calls++
      return fetchImpl(url, options)
    },
  })
  const session = join(directory, 'session.jsonl')
  const app = await boot({
    workspace, session, provider, composition: benchmarkComposition(variant, task.file),
    approve: (detail) => ['write', 'edit'].includes(detail.name),
    skillOptions: { home: emptyHome, env: { DSH_HOME: emptyHome, DSH_AGENTS_HOME: emptyHome, DSH_BUNDLED_SKILL_DIR: emptyHome } },
  })
  let error = null, timedOut = false, publicCheck = null, repairAttempted = false
  const checkController = new AbortController()
  const timer = setTimeout(() => { timedOut = true; checkController.abort(); void app.ctx.agent.shutdown() }, timeoutMs)
  const startedAt = performance.now()
  try {
    await app.ctx.agent.turn(task.prompt)
    const first = app.ctx.session.events.filter((event) => event.type === 'message' && event.message?.role === 'assistant').at(-1)?.message
    if (task.id === 'config' && !timedOut && first && !first.tool_calls?.length) {
      publicCheck = await publicConfigCheck(task, workspace, start, checkController.signal)
      if (!publicCheck.passed && !timedOut) {
        const failures = publicCheck.checks.filter((check) => !check.passed).map((check) => `- ${check.name}`).join('\n')
        repairAttempted = true
        await app.ctx.agent.turn(`The sandboxed public check failed:\n${failures}\nYou have one opportunity to repair ${task.file}. The same file and tool restrictions still apply.`)
      }
    }
  }
  catch (caught) { error = String(caught.message ?? caught).replaceAll(apiKey, '[redacted]') }
  const durationMs = Math.round(performance.now() - startedAt)
  clearTimeout(timer)
  const events = app.ctx.session.events
  const messages = events.filter((event) => event.type === 'message' && event.message?.role === 'assistant')
  const last = messages.at(-1)?.message
  const completed = !error && !timedOut && !!last && !(last.tool_calls?.length)
  const deniedCalls = events.filter((event) => event.type === 'permission.decided' && event.decision !== 'allow').length
  const toolCalls = events.filter((event) => event.type === 'tool.started').length
  await app.dispose()
  const changed = (await readFile(join(workspace, task.file), 'utf8')) !== initial
  const quality = await grade(task, workspace, start)
  return {
    task: task.id, variant, repetition, completed, modelCalls: calls, durationMs, toolCalls, deniedCalls, changed,
    publicCheck, repairAttempted, quality, passed: completed && changed && quality.passed, error: timedOut ? 'benchmark timeout' : error,
    answer: last?.content ?? '', workspace, session,
  }
}

function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null }

export function summarize(results) {
  const groups = Object.fromEntries(['previous', 'updated'].map((variant) => {
    const group = results.filter((result) => result.variant === variant)
    return [variant, { runs: group.length, completed: group.filter((r) => r.completed).length, passed: group.filter((r) => r.passed).length }]
  }))
  const keys = [...new Set(results.map((r) => `${r.task}:${r.repetition}`))]
  const pairs = keys.map((key) => {
    const [task, repetition] = key.split(':')
    const previous = results.find((r) => r.task === task && r.repetition === Number(repetition) && r.variant === 'previous')
    const updated = results.find((r) => r.task === task && r.repetition === Number(repetition) && r.variant === 'updated')
    if (!previous || !updated) throw new Error(`Missing paired run: ${key}`)
    return { task, repetition: Number(repetition), previousCalls: previous.modelCalls, updatedCalls: updated.modelCalls,
      previousMs: previous.durationMs, updatedMs: updated.durationMs, previousPassed: previous.passed, updatedPassed: updated.passed }
  })
  const valid = pairs.filter((pair) => pair.previousPassed && pair.updatedPassed)
  const comparable = { pairs: valid.length }
  for (const key of ['previousCalls', 'updatedCalls', 'previousMs', 'updatedMs']) comparable[key] = average(valid.map((pair) => pair[key]))
  return { groups, pairs, comparable }
}

export async function snapshotSource(source, root) {
  // Snapshot outside the source first: the requested output may be inside it.
  const temporary = await mkdtemp(join(tmpdir(), 'mini-dsh-benchmark-source-'))
  try {
    const snapshot = join(temporary, 'source')
    await cp(source, snapshot, { recursive: true, filter: (path) => !isInside(root, path) })
    await cp(snapshot, join(root, 'benchmark-source'), { recursive: true })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

export async function benchmark({ apiKey, model = DEEPSEEK_MODEL, baseUrl, repeats = 1, maxCalls = 20, timeoutMs = 120000, output, fetchImpl, onResult = () => {} }) {
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_FILE is required')
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeats must be an integer from 1 to 10')
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 50) throw new Error('max-calls must be an integer from 1 to 50')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error('timeout-ms must be at least 1000')
  await ensureSandbox()
  // Record the source state before creating output inside the checkout.
  let revision = null, dirty = null
  try {
    revision = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
    dirty = !!(await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo })).stdout.trim()
  } catch { /* Git metadata is optional. */ }
  const root = output ? resolve(output) : await mkdtemp(join(tmpdir(), 'mini-dsh-prompt-benchmark-'))
  if (output) await mkdir(root)
  await snapshotSource(here, root)
  const results = []
  for (let repetition = 1; repetition <= repeats; repetition++) {
    for (let i = 0; i < tasks.length; i++) {
      const order = (repetition + i) % 2 ? ['previous', 'updated'] : ['updated', 'previous']
      for (const variant of order) {
        const directory = join(root, `run-${String(results.length + 1).padStart(3, '0')}`)
        const result = await runOne({ task: tasks[i], variant, repetition, directory, apiKey, model, baseUrl, fetchImpl, maxCalls, timeoutMs, fixtures: join(root, 'benchmark-source', 'fixtures') })
        results.push(result)
        onResult(result)
      }
    }
  }
  const summary = { model, revision, dirty, repeats, maxCalls, timeoutMs, results, ...summarize(results) }
  const summaryPath = join(root, 'summary.json')
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  return { summary, summaryPath }
}
