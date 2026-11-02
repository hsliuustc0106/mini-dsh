import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { grade, runOne, summarize } from '../benchmarks/coding/runner.mjs'
import { tasks } from '../benchmarks/coding/tasks.mjs'

const fixtures = fileURLToPath(new URL('../benchmarks/coding/fixtures/', import.meta.url))
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
      const before = await grade(task, workspace)
      assert.equal(before.passed, false, `${task.id} starting fixture unexpectedly passed`)
      assert.ok(before.checks.length >= 4, `${task.id} grader failed: ${before.error}`)
      await writeFile(join(workspace, task.file), solutions[task.id])
      const after = await grade(task, workspace)
      assert.equal(after.passed, true, `${task.id}: ${JSON.stringify(after)}`)
    }
    const query = tasks.find((task) => task.id === 'query')
    const queryWorkspace = join(dir, query.id)
    const nullPrototypeSolution = solutions.query.replace('const result = {}', 'const result = Object.create(null)')
    await writeFile(join(queryWorkspace, query.file), nullPrototypeSolution)
    assert.equal((await grade(query, queryWorkspace)).passed, true, 'a null-prototype query object is valid')
    await writeFile(join(queryWorkspace, query.file), 'process.exit(0)')
    const interrupted = await grade(query, queryWorkspace)
    assert.equal(interrupted.passed, false)
    assert.match(interrupted.error, /did not return a result/)
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
      const result = await runOne({ task: tasks[0], variant, repetition: 1, directory: join(dir, variant), apiKey: 'fixture-api-key', fetchImpl })
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
