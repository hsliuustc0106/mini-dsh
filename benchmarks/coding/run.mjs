#!/usr/bin/env node
import { benchmark } from './runner.mjs'
import { DEEPSEEK_MODEL, readApiKey } from '../../src/provider.js'

const args = process.argv.slice(2)
const names = new Set(['--repeats', '--max-calls', '--timeout-ms', '--output'])
const values = {}
for (let index = 0; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1]
  if (!names.has(name) || !value || value.startsWith('--') || Object.hasOwn(values, name)) throw new Error(`Invalid argument: ${name}`)
  values[name] = value
}
const { summary, summaryPath } = await benchmark({
  apiKey: await readApiKey(),
  model: process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_MODEL,
  baseUrl: process.env.DEEPSEEK_BASE_URL || undefined,
  repeats: Number(values['--repeats'] ?? 1),
  maxCalls: Number(values['--max-calls'] ?? 20),
  timeoutMs: Number(values['--timeout-ms'] ?? 120000),
  output: values['--output'],
  onResult: (result) => console.log(`${result.task} ${result.variant} repetition ${result.repetition}: ${result.modelCalls} calls, ${result.durationMs} ms, ${result.passed ? 'passed' : 'failed'}`),
})
console.log(JSON.stringify({ groups: summary.groups, comparable: summary.comparable }, null, 2))
console.log(`Results: ${summaryPath}`)
if (summary.results.some((result) => result.error || result.quality.error)) process.exitCode = 1
