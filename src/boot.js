import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { composition as defaultComposition } from './composition.js'
import { configurePlugins } from './plugin-config.js'
import { WebControl } from './web-control.js'
import { DshAgent } from './dsh-agent.js'
import { Agent } from './agent.js'

// Cordis FiberState is a const enum, so the published build does not export it.
// These values match @deepseek-ai/cordis 4.0.5.
const LOADING = 1
const UNLOADING = 5
const STATE_NAME = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading']

export class BootError extends Error {
  constructor(message, report = []) {
    super(message)
    this.name = 'BootError'
    this.report = report
  }
}

export async function prepareWorkspace(workspace) {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('An absolute workspace directory is required')
  if (!isAbsolute(workspace)) throw new Error(`Workspace must be an absolute path: ${workspace}`)
  let stat
  try { stat = await lstat(workspace) }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Workspace does not exist: ${workspace}`)
    throw error
  }
  if (!stat.isDirectory()) throw new Error(`Workspace must be a directory: ${workspace}`)
  return workspace
}

export function resolveSessionPath(workspace, session) {
  const selected = session || '.mini-session.jsonl'
  if (typeof selected !== 'string' || !selected.trim()) throw new Error('Session path must be a non-empty string')
  return isAbsolute(selected) ? selected : join(workspace, selected)
}

function statusOf(fiber) {
  if (fiber._error) return 'failed'
  return STATE_NAME[fiber.state] ?? 'unknown'
}

function describe(entry) {
  const missing = Object.keys(entry.fiber.inject ?? {}).filter((name) => entry.fiber.ctx.reflect.get(name, false) == null)
  const error = entry.fiber._error
  return {
    name: entry.name,
    state: statusOf(entry.fiber),
    missing,
    error: error ? String(error.message ?? error) : undefined,
  }
}

function formatProblem(item) {
  const detail = item.error ? `: ${item.error}` : ''
  const waiting = item.missing?.length ? `: waiting for ${item.missing.join(', ')}` : ''
  return `${item.name} ${item.state === 'failed' ? 'failed' : `is ${item.state}`}${item.state === 'failed' ? detail : waiting}`
}

async function settle(fibers) {
  for (let attempt = 0; attempt < fibers.length + 3; attempt++) {
    await Promise.all(fibers.map((entry) => entry.fiber.await().catch(() => {})))
    const busy = fibers.some((entry) => entry.fiber.inertia || entry.fiber.state === LOADING || entry.fiber.state === UNLOADING)
    if (!busy) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new BootError('Plugins did not settle')
}

async function disposeAll(fibers) {
  for (const entry of fibers) {
    try { await entry.fiber.dispose() }
    catch { /* the plugin's own disposer already reported the failure */ }
  }
}

export async function boot(options = {}) {
  const workspace = await prepareWorkspace(options.workspace)
  const sessionPath = resolveSessionPath(workspace, options.session)
  const compose = Array.isArray(options.composition) ? () => options.composition : options.composition ?? defaultComposition
  let entries = await compose({
    workspace,
    sessionPath,
    model: options.model,
    writable: options.writable !== false,
    provider: options.provider,
    approve: options.approve,
    clock: options.clock,
    view: options.view,
    web: options.web,
    skillOptions: options.skillOptions,
    terminal: options.terminal,
  })
  if (!Array.isArray(entries)) throw new Error('Composition must return an array of plugins')
  entries = await configurePlugins(entries, options.pluginConfig, workspace)
  const loops = entries.filter((entry) => entry.dshAgentLoopModule)
  if (loops.length > 1) throw new Error('Only one DSH agent loop can be active')
  if (loops.length) {
    const [loop] = loops
    if (loop.required === false) throw new Error('The DSH agent loop cannot be optional')
    if (loop.config != null && (typeof loop.config !== 'object' || Array.isArray(loop.config) || Object.keys(loop.config).length)) {
      throw new Error('DSH agent-loop configuration is not supported by the mini-dsh bridge')
    }
    const agent = entries.find((entry) => entry.name === 'agent')
    if (!agent || agent.plugin !== Agent) throw new Error('The DSH agent loop requires the default mini-dsh agent')
    agent.plugin = DshAgent
    agent.config = { loopModule: loop.dshAgentLoopModule, loopPlugin: loop.plugin }
    entries = entries.filter((entry) => entry !== loop)
  }
  for (const entry of entries) {
    if (entry.plugin === WebControl) {
      const configPath = options.pluginConfig ? (isAbsolute(options.pluginConfig) ? options.pluginConfig : join(workspace, options.pluginConfig)) : join(workspace, '.mini-dsh', 'plugins.json')
      entry.config = { ...entry.config, pluginConfig: configPath }
    }
  }
  const ctx = new Context()
  const started = []
  try {
    for (const entry of entries) {
      if (!entry?.plugin || typeof entry.name !== 'string' || !entry.name) throw new Error('Composition entries need a name and a plugin')
      started.push({ ...entry, fiber: ctx.plugin(entry.plugin, entry.config) })
    }
    await settle(started)
    const report = started.map(describe)
    const problems = report.filter((item, index) => started[index].required !== false && item.state !== 'active')
    if (problems.length) throw new BootError(problems.map(formatProblem).join('; '), report)
    ctx.livePlugins?.adopt(started, loops.map((entry) => entry.name))
    let disposing
    return {
      ctx,
      workspace,
      sessionPath,
      report,
      // One disposal. A second call waits for the same sequence, so a turn can
      // finish recording before the session fiber releases the writer.
      dispose() {
        disposing ??= disposeAll(started)
        return disposing
      },
    }
  } catch (error) {
    const report = error instanceof BootError && error.report?.length ? error.report : started.map(describe)
    await disposeAll(started)
    if (error instanceof BootError) throw error
    const wrapped = new BootError(error.message, report)
    wrapped.cause = error
    throw wrapped
  }
}
