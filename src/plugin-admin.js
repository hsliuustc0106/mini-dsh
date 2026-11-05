import { isAbsolute, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUILTIN_PLUGIN_NAMES, loadProfileEntries, readPluginProfile, withPluginProfile } from './live-plugins.js'

// Services the mini-dsh host itself provides. Anything else that is not
// currently registered is an unsupported dependency: installing a package does
// not create it.
const HOST_SERVICES = new Set([
  'workspace', 'session', 'model', 'prompt', 'tools', 'checkpoint', 'permissions',
  'agent', 'agents', 'livePlugins', 'subagents', 'jobs', 'systemPrompt',
  'webControl', 'terminal', 'viewer', 'miniSkillRoots',
])

// Injected by the host when a plugin is mounted. Not a user setting.
const HOST_CONFIG_KEYS = new Set(['workDir'])

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
// Schemastery nodes are callable. Treat functions with a type as schema nodes.
const schemaNode = (value) => object(value) || typeof value === 'function'

function unsupportedDependency(service) {
  return `mini-dsh does not provide ${service}. Installing a package does not make this service available.`
}

function injectNames(plugin) {
  const inject = plugin?.inject
  if (Array.isArray(inject)) return inject.filter((name) => typeof name === 'string' && name)
  if (object(inject)) return Object.keys(inject)
  return []
}

function schemaField(key, schema) {
  if (!schemaNode(schema) || schema.meta?.hidden === true) return null
  const description = typeof schema.meta?.description === 'string' ? schema.meta.description : ''
  const required = schema.meta?.required === true && schema.meta?.default === undefined
  if (schema.type === 'string' || schema.type === 'boolean' || schema.type === 'number') {
    return { key, supported: true, type: schema.type, description, required }
  }
  const choices = schema.type === 'union' && Array.isArray(schema.list) ? schema.list : null
  if (choices?.length && choices.every((item) => item?.type === 'const' && typeof item.value === 'string')) {
    return { key, supported: true, type: 'enum', description, required, options: choices.map((item) => item.value) }
  }
  return {
    key,
    supported: false,
    type: typeof schema.type === 'string' ? schema.type : 'unknown',
    description,
    reason: `${key} is not an editable string, boolean, number, or string choice`,
  }
}

// Supported settings come from a Cordis Config object schema or a plain
// `settings` map. Nested and hidden fields stay visible but are not writable.
export function settingsFromPlugin(plugin) {
  const schema = plugin?.Config
  if (schemaNode(schema) && schema.type === 'object' && object(schema.dict)) {
    const fields = []
    for (const [key, field] of Object.entries(schema.dict)) {
      if (HOST_CONFIG_KEYS.has(key)) continue
      const described = schemaField(key, field)
      if (described) fields.push(described)
    }
    return { fields, schema }
  }
  if (object(plugin?.settings)) {
    const fields = []
    for (const [key, spec] of Object.entries(plugin.settings)) {
      if (HOST_CONFIG_KEYS.has(key)) continue
      if (!object(spec) || !['string', 'boolean', 'number'].includes(spec.type)) {
        fields.push({
          key,
          supported: false,
          type: typeof spec?.type === 'string' ? spec.type : 'unknown',
          reason: `${key} is not an editable string, boolean, or number`,
        })
        continue
      }
      fields.push({
        key,
        supported: true,
        type: spec.type,
        description: typeof spec.description === 'string' ? spec.description : '',
        required: spec.required === true,
      })
    }
    return { fields, schema: null }
  }
  return { fields: null, schema: null }
}

function checkValue(field, value) {
  if (field.type === 'string' || field.type === 'enum') {
    if (typeof value !== 'string') throw new Error(`${field.key} must be a string`)
    if (field.type === 'enum' && !field.options.includes(value)) throw new Error(`${field.key} must be one of ${field.options.join(', ')}`)
    return
  }
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${field.key} must be a boolean`)
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field.key} must be a finite number`)
}

export function nextConfig(plugin, current, submitted) {
  if (!object(submitted)) throw new Error('Plugin settings must be an object')
  const keys = Object.keys(submitted)
  if (!keys.length) throw new Error('No settings to update')
  const { fields, schema } = settingsFromPlugin(plugin)
  if (!fields?.some((field) => field.supported)) throw new Error('Plugin has no supported settings')
  const byKey = new Map(fields.map((field) => [field.key, field]))
  for (const key of keys) {
    if (HOST_CONFIG_KEYS.has(key)) throw new Error(`Setting ${key} is managed by mini-dsh and cannot be changed here`)
    const field = byKey.get(key)
    if (!field?.supported) throw new Error(field?.reason ? `Unsupported setting ${key}: ${field.reason}` : `Unsupported setting ${key}`)
    if (!schema) checkValue(field, submitted[key])
  }
  const merged = { ...(object(current) ? current : {}) }
  for (const key of keys) merged[key] = submitted[key]
  if (!schema) {
    for (const field of fields) {
      if (field.supported && field.required && !Object.hasOwn(merged, field.key)) throw new Error(`${field.key} is required`)
    }
    return merged
  }
  const validate = schema['~standard']?.validate
  if (typeof validate !== 'function') throw new Error('Plugin settings schema cannot be validated')
  const result = validate(merged)
  if (result && typeof result.then === 'function') throw new Error('Async plugin settings are not supported')
  if (result?.issues?.length) {
    throw new Error(result.issues.map((issue) => issue.message).join('; '))
  }
  if (!object(result?.value)) throw new Error('Plugin settings must be an object')
  return result.value
}

async function importPlugin(configPath, row) {
  if (!row || typeof row.module !== 'string' || !row.module) return null
  const modulePath = isAbsolute(row.module) ? row.module : resolve(dirname(configPath), row.module)
  const loaded = await import(pathToFileURL(modulePath).href)
  const plugin = row.export ? loaded[row.export] : loaded.default ?? (typeof loaded.apply === 'function' ? loaded : undefined)
  if (typeof plugin !== 'function' && (!object(plugin) || typeof plugin.apply !== 'function')) {
    throw new Error(`Plugin ${row.name} has no valid ${row.export ?? 'default or named apply'} export`)
  }
  return plugin
}

function resolvePlugin(ctx, configPath, row) {
  const mounted = ctx.livePlugins.mounted.get(row?.name)?.entry?.plugin
  if (mounted) return mounted
  return importPlugin(configPath, row)
}

function dependencyView(ctx, plugin, fiber, missing = []) {
  const absent = new Set(missing)
  const names = new Set([...injectNames(plugin), ...Object.keys(fiber?.inject ?? {})])
  return [...names].map((service) => {
    const available = !absent.has(service) && ctx.reflect.get(service, false) != null
    if (available) return { service, status: 'available' }
    if (HOST_SERVICES.has(service)) {
      return { service, status: 'unavailable', message: `Host service ${service} is not available.` }
    }
    return { service, status: 'unsupported', message: unsupportedDependency(service) }
  })
}

function presentSettings(plugin, config) {
  const described = settingsFromPlugin(plugin)
  if (!described.fields) return []
  const current = object(config) ? config : {}
  return described.fields.map((field) => ({
    ...field,
    value: Object.hasOwn(current, field.key) ? current[field.key] : null,
  }))
}

function toolViews(ctx, name) {
  const views = []
  for (const toolName of [...ctx.tools.items.keys()].sort()) {
    if (!ctx.livePlugins.ownsFiber(name, ctx.tools.owners.get(toolName))) continue
    const effective = ctx.permissions.effective(toolName)
    views.push({ name: toolName, decision: effective.decision, source: effective.source })
  }
  return views
}

async function describePlugin(ctx, configPath, summary, row) {
  const info = ctx.livePlugins.mounted.get(summary.name)
  let plugin = info?.entry?.plugin ?? null
  let settingsError
  if (!plugin && row) {
    try { plugin = await importPlugin(configPath, row) }
    catch (error) { settingsError = error.message }
  }
  const config = object(row?.config) ? row.config : object(info?.entry?.config) ? info.entry.config : {}
  return {
    name: summary.name,
    state: summary.state,
    source: summary.source,
    module: summary.module ?? row?.module,
    error: summary.error,
    missing: summary.missing ?? [],
    dependencies: dependencyView(ctx, plugin, info?.fiber, summary.missing ?? []),
    settings: plugin ? presentSettings(plugin, config) : [],
    settingsError,
    tools: toolViews(ctx, summary.name),
  }
}

export async function installedPlugins(ctx, configPath) {
  const profile = await readPluginProfile(configPath)
  const listed = ctx.livePlugins.list().filter((entry) => !BUILTIN_PLUGIN_NAMES.has(entry.name))
  const mounted = new Set(listed.map((entry) => entry.name))
  const rows = new Map(profile.plugins.filter((entry) => entry?.name).map((entry) => [entry.name, entry]))
  const plugins = []
  for (const summary of listed) plugins.push(await describePlugin(ctx, configPath, summary, rows.get(summary.name)))
  for (const entry of profile.plugins) {
    if (!entry?.name || !entry.module || BUILTIN_PLUGIN_NAMES.has(entry.name) || mounted.has(entry.name)) continue
    plugins.push(await describePlugin(ctx, configPath, {
      name: entry.name,
      state: entry.enabled === false ? 'disabled' : 'not mounted',
      source: 'profile',
      missing: [],
    }, entry))
  }
  return { plugins }
}

function failureDetail(dependencies, fallback) {
  const unsupported = dependencies.filter((item) => item.status === 'unsupported')
  if (unsupported.length) return unsupported.map((item) => item.message).join(' ')
  return fallback
}

async function activationDependencies(ctx, configPath, name, plugin) {
  const row = (await readPluginProfile(configPath)).plugins.find((entry) => entry.name === name)
  const resolved = plugin ?? await importPlugin(configPath, row).catch(() => null)
  const info = ctx.livePlugins.mounted.get(name)
  return dependencyView(ctx, resolved, info?.fiber, info ? [] : injectNames(resolved).filter((service) => ctx.reflect.get(service, false) == null))
}

async function activate(ctx, configPath, name, token, wasActive) {
  const live = ctx.livePlugins
  const snapshot = live.mounted.get(name)?.entry
  if (snapshot) {
    const blockers = live.dependentsBlockingRemoval(name)
    if (blockers.length) {
      const detail = blockers.map((row) => `${row.name} (needs ${row.services.join(', ')})`).join('; ')
      return {
        active: false,
        restartRequired: true,
        message: `Saved. Restart mini-dsh to activate this change. Live reload is blocked because ${detail} still needs this plugin.`,
      }
    }
    await live.unmount(name, token)
  }
  const failClosed = async (error) => {
    const dependencies = await activationDependencies(ctx, configPath, name, snapshot?.plugin)
    const detail = failureDetail(dependencies, error.message)
    if (!wasActive || !snapshot) {
      return { active: false, restartRequired: false, dependencies, message: `Saved, but the plugin is not active. ${detail}` }
    }
    try {
      if (live.mounted.has(name)) await live.unmount(name, token)
      await live.mount(snapshot, token)
    } catch (rollback) {
      const wrapped = new Error(`Change was not activated: ${detail}; restoration failed: ${rollback.message}`)
      wrapped.restoreProfile = true
      throw wrapped
    }
    const wrapped = new Error(`Change was not activated and the previous configuration was restored: ${detail}`)
    wrapped.restoreProfile = true
    throw wrapped
  }
  try {
    const entries = await loadProfileEntries(configPath, [name])
    const report = await live.mount(entries[0], token)
    if (report.state !== 'active') return failClosed(new Error(report.error || `plugin is ${report.state}`))
    return { active: true, restartRequired: false, state: report.state, message: 'Active now.' }
  } catch (error) {
    if (error.restoreProfile) throw error
    return failClosed(error)
  }
}

export async function updatePluginSettings(ctx, configPath, name, submitted) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Plugin name is required')
  if (BUILTIN_PLUGIN_NAMES.has(name)) throw new Error(`Built-in plugin settings cannot be changed here: ${name}`)
  return withPluginProfile(configPath, async (config, commit) => {
    const previous = structuredClone(config)
    const next = structuredClone(config)
    const row = next.plugins.find((entry) => entry?.name === name)
    if (!row) throw new Error(`Plugin is not in the profile: ${name}`)
    const plugin = await resolvePlugin(ctx, configPath, row)
    if (!plugin) throw new Error(`Plugin ${name} has no module`)
    row.config = nextConfig(plugin, row.config, submitted)
    const wasActive = ctx.livePlugins.list().some((entry) => entry.name === name && entry.state === 'active')
    if (row.enabled === false) {
      await commit(next)
      return { name, active: false, restartRequired: false, config: row.config, message: 'Saved. This plugin is disabled, so the change is not active.' }
    }
    let token
    try { token = ctx.livePlugins.beginChange() }
    catch (error) { error.status = 409; throw error }
    try {
      await commit(next)
      const result = await activate(ctx, configPath, name, token, wasActive)
      return { name, config: row.config, ...result }
    } catch (error) {
      if (error.restoreProfile) await commit(previous)
      throw error
    } finally {
      ctx.livePlugins.endChange(token)
    }
  })
}

export async function updatePluginToolPolicies(ctx, configPath, name, policies) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Plugin name is required')
  if (!object(policies)) throw new Error('Tool policies must be an object')
  const entries = Object.entries(policies)
  if (!entries.length) throw new Error('No tool policies to update')
  for (const [tool, decision] of entries) {
    if (!tool || typeof tool !== 'string') throw new Error('Permission tool name is required')
    if (!['allow', 'ask', 'deny'].includes(decision)) throw new Error(`Invalid permission for ${tool}`)
    if (!ctx.tools.items.has(tool) || !ctx.tools.owners.has(tool)) {
      throw new Error(`Unknown tool ${tool} is denied. Refusing to store a policy for a tool that is not registered.`)
    }
    if (!ctx.livePlugins.ownsFiber(name, ctx.tools.owners.get(tool))) {
      throw new Error(`Tool ${tool} is not registered by ${name}. Refusing to change its policy.`)
    }
  }
  await withPluginProfile(configPath, async (config, commit) => {
    const next = structuredClone(config)
    if (!next.plugins.some((entry) => entry?.name === name)) throw new Error(`Plugin is not in the profile: ${name}`)
    let entry = next.plugins.find((item) => item?.name === 'default-tool-permissions')
    if (entry?.enabled === false) {
      throw new Error('default-tool-permissions is disabled in this profile. Refusing to change tool policies.')
    }
    if (!entry) {
      entry = { name: 'default-tool-permissions', config: { policies: {} } }
      next.plugins.push(entry)
    }
    if (entry.config != null && !object(entry.config)) throw new Error('default-tool-permissions config must be an object')
    const current = entry.config?.policies ?? {}
    if (!object(current)) throw new Error('default-tool-permissions policies must be an object')
    entry.config = { ...(entry.config ?? {}), policies: { ...current, ...policies } }
    await commit(next)
  })
  return policies
}
