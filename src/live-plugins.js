import { Service } from '@deepseek-ai/cordis'
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { applyWorkspacePluginConfig } from './workspace-path.js'
import { pathToFileURL } from 'node:url'
import { acquireWriter } from './lock.js'

// Cordis 4.0.5 keeps FiberState as a const enum, so the published build does not
// export the names. live-plugins (like boot.js) pins these numeric values and
// private fields (`_error`, `inertia`, reflect._getImpl) against
// @deepseek-ai/cordis@4.0.5 only.
// Bump Cordis only with a matching update to these constants and the pin test.
const LOADING = 1
const UNLOADING = 5
const STATE_NAME = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading']

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)

export const BUILTIN_PLUGIN_NAMES = new Set([
  'viewer', 'web-control', 'terminal', 'agent', 'agents', 'coding', 'skills', 'instructions',
  'runtime-context', 'default-tool-permissions', 'permissions', 'checkpoint', 'tools',
  'prompt', 'model', 'provider', 'session', 'workspace', 'live-plugins',
])

export const CORDIS_PIN = '4.0.5'

function fiberOwns(pluginFiber, candidateFiber) {
  let fiber = candidateFiber
  const seen = new Set()
  while (fiber && !seen.has(fiber.uid)) {
    seen.add(fiber.uid)
    if (fiber.uid === pluginFiber.uid) return true
    const parent = fiber.parent
    if (!parent) return false
    if (parent === pluginFiber.ctx) return true
    fiber = parent.fiber
  }
  return false
}

function requiredInject(spec) {
  if (spec == null) return true
  if (typeof spec === 'object' && spec.required === false) return false
  return true
}

function statusOf(fiber) {
  if (fiber._error) return 'failed'
  return STATE_NAME[fiber.state] ?? 'unknown'
}

function describe(name, fiber) {
  const missing = Object.keys(fiber.inject ?? {}).filter((key) => fiber.ctx.reflect.get(key, false) == null)
  const error = fiber._error
  return {
    name,
    state: statusOf(fiber),
    missing,
    error: error ? String(error.message ?? error) : undefined,
  }
}

async function settle(fiber) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await fiber.await().catch(() => {})
    if (!fiber.inertia && fiber.state !== LOADING && fiber.state !== UNLOADING) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('Plugin did not settle')
}

async function lockProfile(configPath) {
  const path = join(await realpath(dirname(configPath)), `${basename(configPath)}.install.lock`)
  const deadline = Date.now() + 30000
  for (;;) {
    try { return await acquireWriter(path) }
    catch (error) {
      if (error.code !== 'SESSION_LOCKED') throw error
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for plugin profile lock: ${configPath}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

export async function readPluginProfile(configPath) {
  let config
  try { config = JSON.parse(await readFile(configPath, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return { plugins: [] }
    throw error
  }
  if (!object(config) || Object.keys(config).some((key) => key !== 'plugins') || !Array.isArray(config.plugins)) {
    throw new Error(`Invalid plugin configuration: ${configPath}`)
  }
  return config
}

export async function loadProfileEntries(configPath, names) {
  // Activation names must already be unique; dedupe defensively so a stale
  // duplicate list cannot trip rows.length !== names.length into a false miss.
  const unique = [...new Set(names)]
  if (unique.length !== names.length) {
    throw new Error(`Plugin activation names must be unique: ${names.join(', ')}`)
  }
  const wanted = new Set(unique)
  const config = await readPluginProfile(configPath)
  const rows = config.plugins.filter((entry) => wanted.has(entry.name))
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((entry) => entry.name))
    const missing = unique.filter((name) => !found.has(name))
    throw new Error(`Profile is missing plugin entries: ${missing.join(', ')}`)
  }
  const entries = []
  for (const row of rows) {
    if (row.enabled === false) throw new Error(`Plugin ${row.name} is disabled in the profile`)
    if (typeof row.module !== 'string' || !row.module) throw new Error(`Plugin ${row.name} has no module path`)
    const modulePath = isAbsolute(row.module) ? row.module : resolve(dirname(configPath), row.module)
    let plugin
    try {
      const module = await import(pathToFileURL(modulePath).href)
      plugin = row.export ? module[row.export] : module.default ?? (typeof module.apply === 'function' ? module : undefined)
    } catch (error) {
      throw new Error(`Plugin ${row.name} could not load ${modulePath}: ${error.message}`, { cause: error })
    }
    if (typeof plugin !== 'function' && (!object(plugin) || typeof plugin.apply !== 'function')) {
      throw new Error(`Plugin ${row.name} has no valid ${row.export ?? 'default or named apply'} export`)
    }
    if (plugin.name === 'AgentLoop') {
      throw new Error(`Live mounting the DSH agent loop (${row.name}) is not supported; restart with it in the profile`)
    }
    entries.push({
      name: row.name,
      plugin,
      ...(Object.hasOwn(row, 'config') ? { config: row.config } : {}),
      ...(Object.hasOwn(row, 'required') ? { required: row.required } : {}),
      module: modulePath,
    })
  }
  return entries
}

export async function uninstallPlugin(name, workspace, options = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Plugin name is required')
  if (BUILTIN_PLUGIN_NAMES.has(name)) throw new Error(`Built-in plugin cannot be uninstalled: ${name}`)
  if (!isAbsolute(workspace)) throw new Error('Workspace must be an absolute path')
  const configPath = options.configPath ?? join(workspace, '.mini-dsh', 'plugins.json')
  if (!isAbsolute(configPath)) throw new Error('Plugin config path must be absolute')
  const live = options.livePlugins
  if (live?.changing) throw new Error('A plugin change is already in progress')
  if (live?.busy()) throw new Error('Cannot uninstall plugins while a turn is in progress')
  if (live) live.changing = true
  let lock
  try {
    lock = await lockProfile(configPath)
    if (options.expectedProfile !== undefined && await readFile(configPath, 'utf8') !== options.expectedProfile) {
      throw new Error('Plugin profile changed during inspection; retry uninstall')
    }
    const config = await readPluginProfile(configPath)
    if (!config.plugins.some((entry) => entry.name === name)) throw new Error(`Plugin is not in the profile: ${name}`)
    if (options.requireMounted) {
      for (const entry of config.plugins) {
        if (entry.enabled !== false && !BUILTIN_PLUGIN_NAMES.has(entry.name) && !live?.mounted.has(entry.name)) {
          throw new Error(`Cannot inspect ${entry.name} in the live graph; profile was not changed`)
        }
      }
    }
    let names = [name]
    if (options.expectedNames) {
      if (!live) throw new Error('Removing dependents requires a live dependency graph')
      names = live.removalPlan(name)
      if (JSON.stringify(names) !== JSON.stringify(options.expectedNames)) throw new Error('Dependencies changed; review the removal list again')
      for (const item of names) if (!config.plugins.some((entry) => entry.name === item)) throw new Error(`Dependent ${item} is not in the profile`)
    }
    const remove = new Set(names)
    config.plugins = config.plugins.filter((entry) => !remove.has(entry.name))
    const temp = join(dirname(configPath), `.plugins-uninstall-${process.pid}-${randomUUID()}.json`)
    const snapshots = []
    try {
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
      for (const item of names) {
        if (!live?.mounted.has(item)) continue
        const entry = live.mounted.get(item).entry
        try { await live.unmount(item) }
        finally { if (!live.mounted.has(item)) snapshots.push(entry) }
      }
      await rename(temp, configPath)
    } catch (error) {
      await rm(temp, { force: true })
      const failures = []
      for (const entry of snapshots.reverse()) {
        try { await live.mount(entry) }
        catch (rollback) { failures.push(`${entry.name}: ${rollback.message}`) }
      }
      if (failures.length) throw new Error(`Uninstall failed: ${error.message}; restoration failed: ${failures.join('; ')}. Restart using the unchanged profile.`, { cause: error })
      throw error
    }
    return { name, names, configPath }
  } finally {
    lock?.release()
    if (live) live.changing = false
  }
}

// Tracks profile/runtime plugins so install can mount and uninstall can dispose
// without a process restart. Built-ins stay owned by boot().
export class LivePlugins extends Service {
  static inject = ['session', 'agent', 'workspace']

  constructor(ctx) {
    super(ctx, 'livePlugins')
    // After init, service `this.ctx` is the root context. Keep the constructing
    // fiber so live mounts' ctx.effect cleanups run when this service disposes.
    this.owner = ctx.fiber
    this.mounted = new Map()
    this.bootBuiltins = new Map()
  }

  adopt(started = []) {
    for (const entry of started) {
      if (!entry?.name) continue
      if (BUILTIN_PLUGIN_NAMES.has(entry.name)) {
        this.bootBuiltins.set(entry.name, { fiber: entry.fiber, required: entry.required })
        continue
      }
      if (this.mounted.has(entry.name)) continue
      // Boot-started fibers stay owned by boot(); live mounts use ctx.effect below.
      this.mounted.set(entry.name, { fiber: entry.fiber, module: entry.module, source: 'boot', required: entry.required, entry })
    }
  }

  list() {
    return [...this.mounted.entries()].map(([name, info]) => ({
      ...describe(name, info.fiber),
      source: info.source,
      module: info.module,
    }))
  }

  busy() {
    return Boolean(this.ctx.agent.busy)
  }

  // Services registered under this plugin's fiber (including nested Service plugins).
  servicesProvidedBy(name) {
    const info = this.mounted.get(name)
    if (!info?.fiber) return []
    const names = []
    for (const key of Object.getOwnPropertySymbols(this.ctx.reflect.store)) {
      const entry = this.ctx.reflect.store[key]
      if (entry?.name && entry.fiber && fiberOwns(info.fiber, entry.fiber)) names.push(entry.name)
    }
    return names
  }

  // Required (non-optional) mounted plugins that would lose a required inject if
  // `name` were disposed. Optional profile rows (`required: false`) do not block.
  dependentsBlockingRemoval(name) {
    const provided = new Set(this.servicesProvidedBy(name))
    if (!provided.size) return []
    const affected = []
    for (const [other, info] of [...this.bootBuiltins, ...this.mounted]) {
      if (other === name) continue
      if (info.required === false) continue
      const missing = []
      for (const [service, spec] of Object.entries(info.fiber?.inject ?? {})) {
        if (!requiredInject(spec)) continue
        // A same-named service in another isolation scope does not satisfy
        // this fiber. Only block if its actual visible provider is removed.
        const impl = info.fiber.ctx.reflect._getImpl(service, false)
        if (provided.has(service) && impl?.fiber && fiberOwns(this.mounted.get(name).fiber, impl.fiber)) missing.push(service)
      }
      if (missing.length) affected.push({ name: other, services: missing })
    }
    return affected
  }

  removalPlan(name) {
    if (BUILTIN_PLUGIN_NAMES.has(name)) throw new Error(`Built-in plugin cannot be uninstalled: ${name}`)
    const ordered = [], visiting = new Set(), visited = new Set()
    const visit = (current) => {
      if (visited.has(current)) return
      if (visiting.has(current)) throw new Error(`Cannot remove cyclic plugin dependencies involving ${current}`)
      visiting.add(current)
      for (const dependent of this.dependentsBlockingRemoval(current)) {
        if (BUILTIN_PLUGIN_NAMES.has(dependent.name)) throw new Error(`Cannot remove ${name}: built-in ${dependent.name} needs ${dependent.services.join(', ')}`)
        visit(dependent.name)
      }
      visiting.delete(current)
      visited.add(current)
      ordered.push(current)
    }
    visit(name)
    return ordered
  }

  async mount(entry) {
    if (!entry?.plugin || typeof entry.name !== 'string' || !entry.name) throw new Error('Mount needs a name and a plugin')
    if (BUILTIN_PLUGIN_NAMES.has(entry.name)) throw new Error(`Built-in plugin cannot be mounted at runtime: ${entry.name}`)
    if (this.mounted.has(entry.name)) throw new Error(`Plugin already mounted: ${entry.name}`)
    if (this.busy()) throw new Error('Cannot mount plugins while a turn is in progress')
    if (entry.plugin?.name === 'AgentLoop' || entry.dshAgentLoopModule) {
      throw new Error(`Live mounting the DSH agent loop (${entry.name}) is not supported; restart with it in the profile`)
    }

    // Tie the child fiber to this service via the constructing fiber's effect
    // list: disposing livePlugins runs the cleanup. Manual unmount calls the
    // same disposer (not fiber.dispose) so service teardown does not double-dispose.
    // Child plugins still start under root so injected services like tools resolve.
    const workspaceRoot = this.ctx.workspace?.root
    if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) {
      throw new Error('Workspace must be an absolute path')
    }
    const config = applyWorkspacePluginConfig(entry.config, workspaceRoot)

    let fiber
    const release = this.owner.effect(() => {
      fiber = this.ctx.root.plugin(entry.plugin, config)
      return () => fiber.dispose()
    }, `live-plugin:${entry.name}`)

    try {
      await settle(fiber)
      // A turn may have started while the fiber was settling; roll back if so.
      if (this.busy()) {
        release()
        throw new Error('Cannot mount plugins while a turn is in progress')
      }
      const report = describe(entry.name, fiber)
      if (entry.required !== false && report.state !== 'active') {
        release()
        await this.record('plugin.failed', { name: entry.name, state: report.state, error: report.error, missing: report.missing })
        const detail = report.error ? `: ${report.error}` : report.missing?.length ? `: waiting for ${report.missing.join(', ')}` : ''
        throw new Error(`Plugin ${entry.name} ${report.state === 'failed' ? 'failed' : `is ${report.state}`}${detail}`)
      }
      this.mounted.set(entry.name, { fiber, release, module: entry.module, source: 'live', required: entry.required, entry })
      await this.record('plugin.mounted', { name: entry.name, state: report.state })
      return report
    } catch (error) {
      if (!this.mounted.has(entry.name)) {
        try { release() } catch { /* already released on busy/failed paths */ }
      }
      throw error
    }
  }

  async mountAll(entries) {
    const reports = []
    for (const entry of entries) reports.push(await this.mount(entry))
    return reports
  }

  async unmount(name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Plugin name is required')
    if (BUILTIN_PLUGIN_NAMES.has(name)) throw new Error(`Built-in plugin cannot be unmounted: ${name}`)
    if (this.busy()) throw new Error('Cannot unmount plugins while a turn is in progress')
    const info = this.mounted.get(name)
    if (!info) throw new Error(`Plugin is not mounted: ${name}`)
    const blockers = this.dependentsBlockingRemoval(name)
    if (blockers.length) {
      const detail = blockers.map((row) => `${row.name} (needs ${row.services.join(', ')})`).join('; ')
      const error = new Error(
        `Cannot uninstall ${name}: required by ${detail}. ` +
        'Remove or disable those plugins first so the saved profile can still boot.'
      )
      error.code = 'PLUGIN_DEPENDENTS'
      error.dependents = blockers
      throw error
    }
    this.mounted.delete(name)
    if (info.release) await Promise.resolve(info.release())
    else await Promise.resolve(info.fiber.dispose())
    await this.record('plugin.unmounted', { name })
    return { name, state: 'disposed' }
  }

  async record(type, fields) {
    // Best-effort: profile/runtime changes still apply if the session append fails.
    if (!this.ctx.session?.writable) return
    try { await this.ctx.session.append({ type, ...fields }) }
    catch (error) {
      this.ctx.logger?.warn?.(error) ?? this.ctx.logger?.error?.(error)
    }
  }
}
