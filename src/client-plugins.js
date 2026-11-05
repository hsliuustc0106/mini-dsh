import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  CLIENT_COMPATIBILITY,
  Slots,
  SUPPORTED_CLIENT_PACKAGE,
  SUPPORTED_CLIENT_SERVICE,
  declareShellSlots,
  unsupportedClient,
} from './ui-slots.js'

const ENTRY_FIELDS = new Set(['name', 'module', 'enabled'])
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const LOADING = 1
const UNLOADING = 5
const ACTIVE = 2

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)

// Published bundles such as @mixian/dsh-desktop-plugin@0.1.3 declare a browser
// client plus a native shell. This reports every miss and does not execute them.
export function classifyClientPackage(manifest, entrySource = '') {
  const reasons = []
  const client = manifest?.dsh?.client
  if (!object(client)) return { supported: false, reasons: ['Package has no dsh.client declaration'] }
  if (client.platform !== 'web') reasons.push(`unsupported client platform: ${String(client.platform)}`)
  const inject = client.inject ?? []
  if (!Array.isArray(inject) || inject.some((item) => typeof item !== 'string')) {
    reasons.push('dsh.client.inject must be an array of package names')
  } else {
    const extra = inject.filter((name) => name !== SUPPORTED_CLIENT_PACKAGE)
    if (extra.length) reasons.push(`unsupported client runtime dependency: ${extra.join(', ')}`)
  }
  if (typeof entrySource === 'string' && entrySource.includes('__ModuleLoader__')) {
    reasons.push('unsupported browser ModuleLoader bundle; native desktop shell is separate from this client boundary')
  }
  return { supported: reasons.length === 0, reasons }
}

function asPlugin(module, name) {
  const apply = typeof module?.apply === 'function' ? module.apply : module?.default?.apply
  const inject = Array.isArray(module?.inject) ? module.inject : module?.default?.inject
  if (typeof apply !== 'function') throw new Error(`Client plugin ${name} has no apply export`)
  if (!Array.isArray(inject)) throw new Error(`Client plugin ${name} must declare inject`)
  const extra = inject.filter((dep) => dep !== SUPPORTED_CLIENT_SERVICE)
  if (extra.length) throw unsupportedClient(`${name} dependency ${extra.join(', ')}`)
  return { apply, inject }
}

async function readManifest(modulePath) {
  for (const dir of [dirname(modulePath), dirname(dirname(modulePath))]) {
    try { return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }
  return undefined
}

export async function loadClientModule(modulePath, name) {
  const source = await readFile(modulePath, 'utf8')
  const manifest = await readManifest(modulePath)
  if (manifest?.dsh?.client) {
    const classified = classifyClientPackage(manifest, source)
    if (!classified.supported) throw unsupportedClient(classified.reasons.join('; '))
  } else if (source.includes('__ModuleLoader__')) {
    throw unsupportedClient('browser ModuleLoader bundle; native desktop shell is separate from this client boundary')
  }
  let imported
  try { imported = await import(pathToFileURL(modulePath).href) }
  catch (error) {
    throw new Error(`Client plugin ${name} could not load ${modulePath}: ${error.message}`, { cause: error })
  }
  return asPlugin(imported, name)
}

function normalizeEntry(entry, base, label) {
  if (!object(entry)) throw new Error(`${label}: plugin entries must be objects`)
  if (Object.hasOwn(entry, 'config')) throw unsupportedClient(`${entry.name ?? label} config (client plugin settings are not supported)`)
  for (const key of Object.keys(entry)) {
    if (!ENTRY_FIELDS.has(key)) throw new Error(`${label}: unknown client plugin field ${key}`)
  }
  if (typeof entry.name !== 'string' || !NAME.test(entry.name)) throw new Error(`${label}: client plugin needs a valid name`)
  if (typeof entry.module !== 'string' || !entry.module.trim()) throw new Error(`${entry.name}: module must be a non-empty string`)
  if (entry.enabled != null && typeof entry.enabled !== 'boolean') throw new Error(`${entry.name}: enabled must be a boolean`)
  const module = isAbsolute(entry.module) ? entry.module : resolve(base, entry.module)
  return { name: entry.name, module, enabled: entry.enabled !== false }
}

export async function loadClientProfile({ pluginConfig, workspace, clientPlugins } = {}) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new Error('Workspace must be an absolute path')
  if (clientPlugins != null) {
    if (!Array.isArray(clientPlugins)) throw new Error('clientPlugins must be an array')
    const plugins = clientPlugins.map((entry) => normalizeEntry(entry, workspace, 'clientPlugins'))
    assertUnique(plugins)
    return plugins
  }
  if (!pluginConfig) return []
  const path = join(dirname(pluginConfig), 'client.json')
  let text
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  let config
  try { config = JSON.parse(text) }
  catch {
    throw new Error(`Client plugin config ${path} is not valid JSON`)
  }
  if (!object(config) || Object.keys(config).some((key) => key !== 'plugins') || !Array.isArray(config.plugins)) {
    throw new Error(`Client plugin config ${path} needs a plugins array`)
  }
  const plugins = config.plugins.map((entry) => normalizeEntry(entry, dirname(path), path))
  assertUnique(plugins)
  return plugins
}

function assertUnique(plugins) {
  const seen = new Set()
  for (const entry of plugins) {
    if (seen.has(entry.name)) throw new Error(`Duplicate client plugin entry: ${entry.name}`)
    seen.add(entry.name)
  }
}

async function settle(fiber) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await fiber.await().catch(() => {})
    if (!fiber.inertia && fiber.state !== LOADING && fiber.state !== UNLOADING) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('Client plugin did not settle')
}

// Web-owned Cordis root. It shares no service scope with the host agent.
export class ClientHost {
  constructor() {
    this.ctx = new Context()
    this.slotsFiber = null
    this.shell = null
    this.slots = null
    this.mounted = new Map()
    this.failures = new Map()
    this.disabled = []
    this.disposed = false
  }

  async start() {
    this.slotsFiber = this.ctx.plugin(Slots)
    await this.slotsFiber.await()
    this.slots = this.ctx.slots
    this.shell = declareShellSlots(this.slots)
  }

  async mountAll(entries) {
    const reports = []
    for (const entry of entries) {
      if (entry.enabled === false) {
        this.disabled.push(entry.name)
        reports.push({ name: entry.name, state: 'disabled' })
        continue
      }
      reports.push(await this.mount(entry))
    }
    return reports
  }

  async mount(entry) {
    if (this.disposed) throw new Error('Client plugins are disposed')
    if (!entry?.name || !entry.module) throw new Error('Client mount needs a name and a module')
    if (this.mounted.has(entry.name)) throw new Error(`Client plugin already mounted: ${entry.name}`)
    this.failures.delete(entry.name)
    let fiber
    try {
      const plugin = await loadClientModule(entry.module, entry.name)
      fiber = this.ctx.plugin(plugin)
      await settle(fiber)
      if (fiber._error || fiber.state !== ACTIVE) {
        const detail = fiber._error?.message ?? `is ${fiber.state}`
        throw new Error(detail)
      }
      this.mounted.set(entry.name, { name: entry.name, module: entry.module, fiber, entry })
      return { name: entry.name, state: 'active' }
    } catch (error) {
      if (fiber) {
        try { await fiber.dispose() }
        catch { /* the failed fiber is already unloading */ }
      }
      const message = `Client plugin ${entry.name} failed: ${error.message}`
      this.failures.set(entry.name, message)
      return { name: entry.name, state: 'failed', error: message }
    }
  }

  async unmount(name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Client plugin name is required')
    const info = this.mounted.get(name)
    if (!info) throw new Error(`Client plugin is not mounted: ${name}`)
    this.mounted.delete(name)
    await info.fiber.dispose()
    return { name, state: 'disposed' }
  }

  async reload(name) {
    const info = this.mounted.get(name)
    if (!info) throw new Error(`Client plugin is not mounted: ${name}`)
    const entry = info.entry
    await this.unmount(name)
    return this.mount(entry)
  }

  view() {
    return {
      compatibility: CLIENT_COMPATIBILITY,
      slots: this.slots.projection(),
      plugins: [
        ...[...this.mounted.values()].map((info) => ({ name: info.name, state: 'active', module: info.module })),
        ...[...this.failures.entries()].map(([name, error]) => ({ name, state: 'failed', error })),
        ...this.disabled.map((name) => ({ name, state: 'disabled' })),
      ],
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const name of [...this.mounted.keys()]) {
      try { await this.unmount(name) }
      catch { /* shutdown still drops the context */ }
    }
    this.shell?.dispose()
    this.shell = null
    if (this.slotsFiber) {
      try { await this.slotsFiber.dispose() }
      catch { /* the service fiber is already gone */ }
    }
  }
}
