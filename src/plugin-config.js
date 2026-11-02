import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const fields = new Set(['name', 'enabled', 'module', 'export', 'config', 'required', 'before'])
const own = (object, key) => Object.hasOwn(object, key)
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)

function validate(config) {
  if (!object(config)) throw new Error('Plugin config must be an object')
  for (const key of Object.keys(config)) if (key !== 'plugins') throw new Error(`Unknown plugin config field: ${key}`)
  if (!Array.isArray(config.plugins)) throw new Error('Plugin config needs a plugins array')
  const seen = new Set()
  for (const entry of config.plugins) {
    if (!object(entry)) throw new Error('Plugin entries must be objects')
    for (const key of Object.keys(entry)) if (!fields.has(key)) throw new Error(`Unknown plugin entry field: ${key}`)
    if (typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.name)) {
      throw new Error('Plugin entry needs a valid name')
    }
    if (seen.has(entry.name)) throw new Error(`Duplicate plugin entry: ${entry.name}`)
    seen.add(entry.name)
    for (const key of ['enabled', 'required']) {
      if (own(entry, key) && typeof entry[key] !== 'boolean') throw new Error(`${entry.name}: ${key} must be a boolean`)
    }
    for (const key of ['module', 'export', 'before']) {
      if (own(entry, key) && (typeof entry[key] !== 'string' || !entry[key].trim())) {
        throw new Error(`${entry.name}: ${key} must be a non-empty string`)
      }
    }
    if (own(entry, 'export') && !own(entry, 'module')) throw new Error(`${entry.name}: export requires module`)
  }
}

// Profile files are opt-in and trusted: importing a plugin executes its module.
// Apply a named overlay to the existing composition instead of replacing its
// runtime workspace, session, provider, and approval settings by accident.
export async function configurePlugins(entries, file, workspace) {
  if (file == null || file === '') return entries
  if (typeof file !== 'string' || !file.trim()) throw new Error('Plugin config path must be a non-empty string')
  const path = isAbsolute(file) ? file : resolve(workspace, file)
  let config
  try { config = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    const detail = error instanceof SyntaxError ? 'is not valid JSON' : `could not be read (${error.code ?? error.message})`
    throw new Error(`Plugin config ${path} ${detail}`)
  }
  validate(config)
  const result = entries.map((entry) => ({ ...entry }))
  const modules = []
  const names = new Set()
  for (const entry of result) {
    if (names.has(entry.name)) throw new Error(`Duplicate composition entry: ${entry.name}`)
    names.add(entry.name)
  }

  for (const change of config.plugins) {
    const index = result.findIndex((entry) => entry.name === change.name)
    if (index < 0 && !change.module) throw new Error(`Unknown plugin: ${change.name}`)
    if (change.enabled === false) {
      if (index >= 0) result.splice(index, 1)
      continue
    }
    if (index >= 0 && change.before) throw new Error(`${change.name}: before is only valid for a new plugin`)
    if (change.module) {
      const modulePath = isAbsolute(change.module) ? change.module : resolve(dirname(path), change.module)
      modules.push({ name: change.name, path: modulePath, export: change.export })
    }
    const updated = {
      ...(index >= 0 ? result[index] : { name: change.name }),
      ...(own(change, 'config') ? { config: change.config } : {}),
      ...(own(change, 'required') ? { required: change.required } : {}),
    }
    if (index >= 0) {
      result[index] = updated
      continue
    }
    // Consumers are disposed before shared services; the agent drains first.
    const anchor = change.before ?? 'default-tool-permissions'
    let insertAt = result.findIndex((entry) => entry.name === anchor)
    if (insertAt < 0 && change.before) throw new Error(`${change.name}: unknown before target ${anchor}`)
    if (insertAt < 0) insertAt = result.findIndex((entry) => entry.name === 'permissions')
    if (insertAt < 0) insertAt = result.findIndex((entry) => entry.name === 'session')
    if (insertAt < 0) insertAt = result.length
    result.splice(insertAt, 0, updated)
  }
  // Validate the whole overlay before evaluating any user-supplied module.
  for (const item of modules) {
    let plugin
    try {
      const module = await import(pathToFileURL(item.path).href)
      plugin = item.export ? module[item.export] : module.default ?? (typeof module.apply === 'function' ? module : undefined)
    }
    catch (error) {
      throw new Error(`Plugin ${item.name} could not load ${item.path}: ${error.message}`, { cause: error })
    }
    if (typeof plugin !== 'function' && (!object(plugin) || typeof plugin.apply !== 'function')) {
      throw new Error(`Plugin ${item.name} has no valid ${item.export ?? 'default or named apply'} export`)
    }
    result.find((entry) => entry.name === item.name).plugin = plugin
  }
  return result
}
