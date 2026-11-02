import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { benchmark, grade, runOne, snapshotSource, summarize } from '../benchmarks/coding/runner.mjs'
import { candidateProtocol, startSandbox } from '../benchmarks/coding/sandbox.mjs'
import { tasks } from '../benchmarks/coding/tasks.mjs'

const fixtures = fileURLToPath(new URL('../benchmarks/coding/fixtures/', import.meta.url))
const worker = fileURLToPath(new URL('../benchmarks/coding/candidate.mjs', import.meta.url))
const repo = fileURLToPath(new URL('../', import.meta.url))
const dockerTests = process.env.BENCHMARK_TEST_DOCKER === '1'
// Only test-owned fixture code runs locally. The benchmark itself has no local fallback.
const start = dockerTests ? startSandbox : (file) => candidateProtocol(spawn(process.execPath, [worker, file], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] }))
const solutions = {
  query: `export function parseQuery(input) {
    const result = {}
    for (const [key, value] of new URLSearchParams(input)) {
      if (!Object.hasOwn(result, key)) Object.defineProperty(result, key, { value: [], enumerable: true })
      result[key].push(value)
    }
    return result
  }`,
  ranges: `export function mergeRanges(ranges) {
    if (!Array.isArray(ranges) || ranges.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isSafeInteger) || p[0] > p[1])) throw new TypeError()
    const sorted = ranges.map(p => [...p]).sort((a, b) => a[0] - b[0]), result = []
    for (const [start, end] of sorted) {
      const last = result.at(-1)
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
      else result.push([start, end])
    }
    return result
  }`,
  cart: `export function cartTotal(items, discountPercent = 0) {
    if (!Array.isArray(items) || typeof discountPercent !== 'number' || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100 || items.some(item => !item || !Number.isSafeInteger(item.priceCents) || item.priceCents < 0 || !Number.isSafeInteger(item.quantity) || item.quantity < 0)) throw new TypeError()
    return Math.round(items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0) * (1 - discountPercent / 100))
  }`,
  config: `const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
    const clone = x => Array.isArray(x) ? x.map(clone) : object(x) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clone(v)])) : x
    export function mergeOptions(defaults, overrides) {
      const result = clone(defaults)
      for (const [key, value] of Object.entries(overrides)) {
        const current = Object.hasOwn(defaults, key) ? defaults[key] : undefined
        Object.defineProperty(result, key, { value: object(value) && object(current) ? mergeOptions(current, value) : clone(value), enumerable: true, writable: true, configurable: true })
      }
      return result
    }`,
}

test('quality checks reject every starting fixture and accept independently implemented fixes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-benchmark-grade-'))
  try {
    for (const task of tasks) {
      const workspace = join(dir, task.id)
      await cp(join(fixtures, task.id), workspace, { recursive: true })
      const before = await grade(task, workspace, start)
      assert.equal(before.passed, false, `${task.id} starting fixture unexpectedly passed`)
      assert.ok(before.checks.length >= 4, `${task.id} grader failed: ${before.error}`)
      await writeFile(join(workspace, task.file), solutions[task.id])
      const after = await grade(task, workspace, start)
      assert.equal(after.passed, true, `${task.id}: ${JSON.stringify(after)}`)
      if (task.id === 'ranges' || task.id === 'cart') {
        const renamed = solutions[task.id].replace('throw new TypeError()', "throw Object.assign(new Error('invalid'), { name: 'TypeError' })")
        await writeFile(join(workspace, task.file), renamed)
        const report = await grade(task, workspace, start)
        assert.equal(report.checks.find((check) => check.name.includes('raise TypeError')).passed, false, `${task.id} must reject a renamed Error`)
        const getter = solutions[task.id].replace('throw new TypeError()', 'return { get value() { throw new TypeError() } }')
        await writeFile(join(workspace, task.file), getter)
        const postprocessing = await grade(task, workspace, start)
        assert.equal(postprocessing.checks.find((check) => check.name.includes('raise TypeError')).passed, false, `${task.id} must reject an error thrown after return`)
      }
      if (task.id === 'ranges' || task.id === 'config') {
        const aliased = task.id === 'ranges'
          ? 'export function mergeRanges(ranges) { return ranges.toSorted((a, b) => a[0] - b[0]) }'
          : solutions.config.replace('const result = clone(defaults)', 'const result = { ...defaults }')
        await writeFile(join(workspace, task.file), aliased)
        const report = await grade(task, workspace, start)
        assert.equal(report.checks.find((check) => check.name.includes('not mutated') || check.name.includes('do not share')).passed, false, `${task.id} must reject shared values`)
      }
    }
    const query = tasks.find((task) => task.id === 'query')
    const queryWorkspace = join(dir, query.id)
    const nullPrototypeSolution = solutions.query.replace('const result = {}', 'const result = Object.create(null)')
    await writeFile(join(queryWorkspace, query.file), nullPrototypeSolution)
    assert.equal((await grade(query, queryWorkspace, start)).passed, true, 'a null-prototype query object is valid')
    await writeFile(join(queryWorkspace, query.file), solutions.query.replace('const result = {}', 'const result = new (class Query {})()'))
    assert.equal((await grade(query, queryWorkspace, start)).passed, false, 'a custom prototype is not a plain object')
    await writeFile(join(queryWorkspace, query.file), solutions.query.replace('return result', "result[Symbol('extra')] = true; return result"))
    assert.equal((await grade(query, queryWorkspace, start)).passed, false, 'unexpected enumerable symbol keys are rejected')
    await writeFile(join(queryWorkspace, query.file), solutions.query.replace('export function', 'export async function'))
    assert.equal((await grade(query, queryWorkspace, start)).passed, false, 'task functions must return synchronously')
    await writeFile(join(queryWorkspace, query.file), `await Promise.resolve(); ${solutions.query}`)
    assert.equal((await grade(query, queryWorkspace, start)).passed, false, 'top-level await is unavailable in the compartment')
    await writeFile(join(queryWorkspace, query.file), 'process.exit(0)')
    const interrupted = await grade(query, queryWorkspace, start)
    assert.equal(interrupted.passed, false)
    assert.ok(interrupted.checks.every((check) => !check.passed))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('paired runs use real agent instrumentation and confine model file operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-benchmark-loop-'))
  const outside = join(dir, 'outside.txt')
  await writeFile(outside, 'outside sentinel')
  try {
    const captured = []
    for (const variant of ['previous', 'updated']) {
      let calls = 0
      const fetchImpl = async (_url, options) => {
        captured.push({ variant, body: JSON.parse(options.body) })
        const tools = [
          { name: 'read', arguments: { path: outside } },
          { name: 'read', arguments: { path: 'not-present.txt' } },
          { name: 'write', arguments: { path: outside, content: 'changed' } },
          { name: 'shell', arguments: { command: 'echo forbidden' } },
          { name: 'write', arguments: { path: tasks[0].file, content: solutions.query } },
        ].map((call, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
        const delta = calls++ === 0 ? { tool_calls: tools } : { content: 'Done.' }
        const payload = { choices: [{ index: 0, delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] }
        return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      const result = await runOne({ task: tasks[0], variant, repetition: 1, directory: join(dir, variant), apiKey: 'fixture-api-key', fetchImpl, start })
      assert.equal(result.modelCalls, 2)
      assert.equal(result.deniedCalls, 3)
      assert.equal(result.toolCalls, 2)
      assert.equal(result.passed, true, JSON.stringify(result.quality))
      const log = await readFile(result.session, 'utf8')
      assert.equal(log.includes('fixture-api-key'), false)
      assert.equal(log.includes('outside sentinel'), false)
      assert.match(log, /ENOENT/)
    }
    assert.equal(await readFile(outside, 'utf8'), 'outside sentinel')
    const first = captured.filter((entry) => entry.body.messages.length === 2)
    assert.equal(first.length, 2)
    assert.deepEqual(first[0].body.tools, first[1].body.tools)
    assert.deepEqual(first[0].body.messages[1], first[1].body.messages[1])
    const oldPrompt = first.find((entry) => entry.variant === 'previous').body.messages[0].content
    const newPrompt = first.find((entry) => entry.variant === 'updated').body.messages[0].content
    assert.match(oldPrompt, /Use tools when needed/)
    assert.doesNotMatch(oldPrompt, /Use glob to find files and grep to search contents/)
    assert.match(newPrompt, /Use glob to find files and grep to search contents/)
    const contextOf = (system) => JSON.parse(system.split('\n\nRuntime context:\n')[1]).map((part) => ({ ...part, workspace: '<workspace>' }))
    assert.deepEqual(contextOf(oldPrompt), contextOf(newPrompt))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('performance comparisons use only pairs that both pass quality checks', () => {
  const results = [
    { task: 'a', repetition: 1, variant: 'previous', modelCalls: 4, durationMs: 1000, completed: true, passed: true },
    { task: 'a', repetition: 1, variant: 'updated', modelCalls: 2, durationMs: 800, completed: true, passed: true },
    { task: 'b', repetition: 1, variant: 'previous', modelCalls: 3, durationMs: 500, completed: true, passed: true },
    { task: 'b', repetition: 1, variant: 'updated', modelCalls: 1, durationMs: 100, completed: true, passed: false },
  ]
  const report = summarize(results)
  assert.equal(report.groups.updated.passed, 1)
  assert.deepEqual(report.comparable, { pairs: 1, previousCalls: 4, updatedCalls: 2, previousMs: 1000, updatedMs: 800 })
})

test('candidate output cannot supply a passing quality verdict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-benchmark-forgery-'))
  try {
    await cp(join(fixtures, 'query'), dir, { recursive: true })
    const file = join(dir, tasks[0].file)
    const forged = 'mini-dsh-quality:{"checks":[{"name":"forged","passed":true}]}'
    await writeFile(file, `console.log(${JSON.stringify(forged)}); process.exit(0)`)
    const exited = await grade(tasks[0], dir, start)
    assert.equal(exited.passed, false)
    assert.ok(exited.checks.every((check) => !check.passed))
    await writeFile(file, `console.log(${JSON.stringify(forged)}); export function parseQuery() { return {} }`)
    const wrong = await grade(tasks[0], dir, start)
    assert.equal(wrong.passed, false)
    assert.equal(wrong.checks.length, 4)
    assert.ok(wrong.checks.some((check) => !check.passed))
    // The old protocol exploit watched stdin and sent its own responses, even
    // though it did not export parseQuery. Neither stream is available here.
    await writeFile(file, `
      import { deserialize, serialize } from 'node:v8'
      process.stdin.on('data', chunk => {
        const { id, args } = deserialize(Buffer.from(String(chunk).trim(), 'base64'))
        const value = Object.create(null)
        for (const [key, item] of new URLSearchParams(args[0])) (value[key] ??= []).push(item)
        const response = { id, ok: true, value, prototype: 'null', plainChildren: true, asynchronous: false }
        process.stdout.write('mini-dsh-response:' + serialize(response).toString('base64') + '\\n')
      })
    `)
    const protocolForgery = await grade(tasks[0], dir, start)
    assert.equal(protocolForgery.passed, false)
    assert.ok(protocolForgery.checks.every((check) => !check.passed))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('candidate compartment exposes no process or protocol escape through endowments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-benchmark-compartment-'))
  let sandbox
  try {
    const file = join(dir, 'probe.mjs')
    await writeFile(file, `
      import { URLSearchParams as Params } from 'node:url'
      export function probe(input) {
        const escaped = []
        for (const fn of [globalThis.constructor.constructor, Params.constructor, console.log.constructor, input.constructor.constructor]) {
          try { escaped.push(!!fn('return process')()) } catch { escaped.push(false) }
        }
        return { process: typeof process, require: typeof require, buffer: typeof Buffer, escaped, parsed: [...new Params('a=1&a=2')] }
      }
    `)
    sandbox = await start(file)
    const response = await sandbox.request('probe', [[]])
    assert.equal(response.ok, true, JSON.stringify(response))
    assert.deepEqual(response.value, { process: 'undefined', require: 'undefined', buffer: 'undefined', escaped: [false, false, false, false], parsed: [['a', '1'], ['a', '2']] })
  } finally {
    if (sandbox) await sandbox.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('source snapshots work when output is nested inside the source tree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-benchmark-snapshot-'))
  try {
    const root = join(dir, 'source'), output = join(root, 'fixtures', 'query', 'results')
    await cp(join(fixtures, 'query'), join(root, 'fixtures', 'query'), { recursive: true })
    await mkdir(output)
    await snapshotSource(root, output)
    assert.equal(await readFile(join(output, 'benchmark-source', 'fixtures', 'query', 'src', 'query.mjs'), 'utf8'), await readFile(join(root, 'fixtures', 'query', 'src', 'query.mjs'), 'utf8'))
    await assert.rejects(readFile(join(output, 'benchmark-source', 'fixtures', 'query', 'results', 'benchmark-source')), { code: 'ENOENT' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('benchmark runs when its output is inside a fixture', { skip: !dockerTests }, async () => {
  const parent = await mkdtemp(join(fixtures, 'query', '.mini-benchmark-output-'))
  try {
    let sourceDirty = null
    try { sourceDirty = !!(await promisify(execFile)('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo })).stdout.trim() } catch { /* Git metadata is optional. */ }
    const output = join(parent, 'results')
    const fetchImpl = async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    const { summary, summaryPath } = await benchmark({ apiKey: 'fixture-api-key', output, fetchImpl })
    assert.equal(summary.results.length, 8)
    assert.ok(summary.results.every((result) => !result.error && !result.quality.error))
    assert.equal(summary.dirty, sourceDirty)
    assert.equal(JSON.parse(await readFile(summaryPath, 'utf8')).results.length, 8)
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test('benchmark fails before model calls when Docker is unavailable', async () => {
  const cli = fileURLToPath(new URL('../benchmarks/coding/run.mjs', import.meta.url))
  const run = promisify(execFile)
  await assert.rejects(run(process.execPath, [cli], { env: { PATH: '', DEEPSEEK_API_KEY: 'dummy-key' }, timeout: 10000 }), /working Docker sandbox is required/)
})

test('Docker isolates candidate code from host secrets, processes, files, and network', { skip: !dockerTests }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-benchmark-isolation-'))
  const hostFile = join(dir, 'host-secret')
  const file = join(dir, 'probe.mjs')
  const probeWorker = join(dir, 'worker.mjs')
  const server = createServer((socket) => socket.end())
  let signals = 0, sandbox
  const onSignal = () => { signals++ }
  const oldKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'dummy-host-only-secret'
  process.on('SIGUSR1', onSignal)
  try {
    await writeFile(hostFile, 'dummy-host-only-secret')
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await writeFile(file, `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs'
      import { createConnection } from 'node:net'
      export async function probe() {
        let signaled = false, hostEnv = false, writable = false
        try { process.kill(${process.pid}, 'SIGUSR1'); signaled = true } catch {}
        try { hostEnv = readFileSync('/proc/${process.pid}/environ', 'utf8').includes('dummy-host-only-secret') } catch {}
        try { writeFileSync('/candidate.mjs', 'changed'); writable = true } catch {}
        const network = await new Promise(resolve => {
          const socket = createConnection({ host: '127.0.0.1', port: ${port} })
          socket.on('connect', () => { socket.destroy(); resolve(true) })
          socket.on('error', () => resolve(false))
          socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
        })
        return { key: process.env.DEEPSEEK_API_KEY ?? null, hostFile: existsSync(${JSON.stringify(hostFile)}), hostEnv, signaled, writable, network, uid: process.getuid() }
      }
    `)
    // This trusted worker deliberately runs outside SES to probe the container
    // boundary itself, with the same Docker configuration as production.
    await writeFile(probeWorker, `
      import { createInterface } from 'node:readline'
      import { deserialize, serialize } from 'node:v8'
      const { probe } = await import('file:///candidate.mjs')
      for await (const line of createInterface({ input: process.stdin })) {
        const { id } = deserialize(Buffer.from(line, 'base64'))
        process.stdout.write('mini-dsh-response:' + serialize({ id, ok: true, value: await probe() }).toString('base64') + '\\n')
      }
    `)
    sandbox = await startSandbox(file, probeWorker)
    const response = await sandbox.request('probe', [])
    assert.equal(response.ok, true, JSON.stringify(response))
    assert.deepEqual(response.value, { key: null, hostFile: false, hostEnv: false, signaled: false, writable: false, network: false, uid: 65534 })
    assert.equal(signals, 0)
  } finally {
    if (sandbox) await sandbox.close()
    process.off('SIGUSR1', onSignal)
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = oldKey
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
