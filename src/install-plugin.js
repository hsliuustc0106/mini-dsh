import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as resolveImport } from 'import-meta-resolve'
import { parseDocument } from 'yaml'
import { composition } from './composition.js'
import { applyWorkspacePluginConfig } from './workspace-path.js'
import { acquireWriter } from './lock.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const INSERT_KEYS = new Set(['id', 'name', 'config', 'disabled'])
const REPLACE_KEYS = new Set(['id', 'name', 'config', 'disabled'])

async function lockProfile(configPath) {
  // Resolving the directory makes different symlinked paths share one lock.
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

function resolveModule(spec, parentPath) {
  return fileURLToPath(resolveImport(spec, pathToFileURL(parentPath).href))
}

// npm suggests --force / --legacy-peer-deps; those bypass peer contracts and are
// not accepted here as proof that a plugin is compatible with mini-dsh.
export function npmInstallError(detail, code, signal) {
  const text = detail.trim()
  const eresolve = /ERESOLVE|unable to resolve dependency tree|peer .* from /i.test(text)
  if (eresolve) {
    const peer = text.match(/peer\s+(\S+)\s+from\s+(\S+)/i)
    const hint = peer
      ? ` Conflicting peer ${peer[1]} required by ${peer[2]}.`
      : ''
    return new Error(
      `npm dependency resolution failed (ERESOLVE).${hint} ` +
      'mini-dsh leaves the profile unchanged and does not accept --force or --legacy-peer-deps ' +
      'as proof of compatibility; install a package whose peer dependencies resolve cleanly ' +
      `(or pin a compatible set).${text ? ` npm said: ${text.slice(0, 1500)}` : ''}`
    )
  }
  const tail = text ? `: ${text.slice(-1500)}` : ''
  return new Error(`npm install failed (${signal ?? code})${tail}`)
}

function rowFromInsert(row, patchPath) {
  if (!object(row) || Object.keys(row).some((key) => !INSERT_KEYS.has(key)) || typeof row.id !== 'string' || typeof row.name !== 'string') {
    throw new Error('Unsupported bundle plugin row: insert rows need id and name; optional config and boolean disabled only')
  }
  if (Object.hasOwn(row, 'disabled') && typeof row.disabled !== 'boolean') {
    throw new Error(`Unsupported bundle plugin row ${row.id}: disabled must be a boolean literal`)
  }
  let path
  try { path = resolveModule(row.name, patchPath) }
  catch (error) { throw new Error(`Cannot resolve bundle plugin ${row.name}: ${error.message}`) }
  return {
    name: row.id,
    module: path,
    ...(Object.hasOwn(row, 'config') ? { config: row.config } : {}),
    ...(row.disabled === true ? { enabled: false } : {}),
  }
}

function applyReplace(plugins, op, patchPath, inserted) {
  if (!object(op) || typeof op.id !== 'string' || !op.id || Object.keys(op).some((key) => !REPLACE_KEYS.has(key))) {
    throw new Error('Unsupported bundle patch operation: id-targeted replace allows id plus optional name, config, and boolean disabled')
  }
  if (!Object.keys(op).some((key) => key !== 'id')) {
    throw new Error(`Unsupported bundle patch operation: replace for ${op.id} needs name, config, or disabled`)
  }
  if (Object.hasOwn(op, 'disabled') && typeof op.disabled !== 'boolean') {
    throw new Error(`Unsupported bundle patch operation: disabled for ${op.id} must be a boolean literal`)
  }
  if (Object.hasOwn(op, 'name') && (typeof op.name !== 'string' || !op.name)) {
    throw new Error(`Unsupported bundle patch operation: name for ${op.id} must be a non-empty string`)
  }
  // Option 1 (#67 Review): replace may only target rows inserted earlier in THIS install.
  // Rewriting a pre-existing profile row from another package is refused with no write.
  if (!inserted.has(op.id)) {
    const known = plugins.some((entry) => entry.name === op.id)
    throw new Error(
      known
        ? `Bundle patch cannot replace pre-existing plugin id: ${op.id} (only rows inserted earlier in this install)`
        : `Bundle patch targets unknown plugin id: ${op.id}`
    )
  }
  const index = plugins.findIndex((entry) => entry.name === op.id)
  const next = { ...plugins[index] }
  if (Object.hasOwn(op, 'config')) next.config = op.config
  if (Object.hasOwn(op, 'name')) {
    try { next.module = resolveModule(op.name, patchPath) }
    catch (error) { throw new Error(`Cannot resolve bundle plugin ${op.name}: ${error.message}`) }
  }
  if (Object.hasOwn(op, 'disabled')) {
    if (op.disabled) next.enabled = false
    else delete next.enabled
  }
  plugins[index] = next
}

// Install in a staging directory so failed installs never alter the active profile.
export async function installPlugin(spec, workspace, options = {}) {
  if (typeof spec !== 'string' || !spec || spec.startsWith('-')) throw new Error('Provide one npm package spec')
  if (!isAbsolute(workspace)) throw new Error('Workspace must be an absolute path')
  const home = join(workspace, '.mini-dsh')
  const configPath = options.configPath ?? join(home, 'plugins.json')
  if (!isAbsolute(configPath)) throw new Error('Plugin config path must be absolute')
  await mkdir(home, { recursive: true })
  const stage = await mkdtemp(join(home, '.install-'))
  try {
    await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true }))
    const input = spec.startsWith('.') ? resolve(process.cwd(), spec) : spec
    await new Promise((ok, fail) => {
      // Always capture npm output so ERESOLVE can be turned into an actionable error.
      // --force / --legacy-peer-deps are intentionally never passed.
      const child = spawn('npm', ['install', '--no-audit', '--no-fund', '--save', '--', input], {
        cwd: stage,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, npm_config_legacy_peer_deps: '', npm_config_force: '' },
      })
      let detail = ''
      const take = (chunk) => { detail = (detail + chunk.toString()).slice(-8000) }
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      child.once('error', fail)
      child.once('close', (code, signal) => code === 0 ? ok() : fail(npmInstallError(detail, code, signal)))
    })
    const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'))
    const packages = Object.keys(manifest.dependencies ?? {})
    if (packages.length !== 1) throw new Error('Expected npm to install exactly one direct package')
    const packageName = packages[0]
    const root = join(stage, 'node_modules', ...packageName.split('/'))
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const lock = await lockProfile(configPath)
    try {
      let config
      try { config = JSON.parse(await readFile(configPath, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error; config = { plugins: [] } }
      if (!object(config) || Object.keys(config).some((key) => key !== 'plugins') || !Array.isArray(config.plugins)) {
        throw new Error(`Invalid plugin configuration: ${configPath}`)
      }
      const plugins = config.plugins.map((entry) => ({ ...entry }))
      const builtin = new Set(composition({ terminal: {}, view: true, web: true }).map((entry) => entry.name))
      const inserted = new Set()
      const patch = pkg.dsh?.bundle?.patch
      if (patch !== undefined) {
        const patches = Array.isArray(patch) ? patch : [patch]
        if (!patches.length || patches.some((item) => typeof item !== 'string' || !item)) throw new Error('Invalid dsh.bundle.patch')
        for (const file of patches) {
          const patchPath = resolve(root, file)
          const document = parseDocument(await readFile(patchPath, 'utf8'))
          if (document.errors.length || document.warnings.length) {
            throw new Error(`Unsupported or invalid bundle YAML in ${file}: ${(document.errors[0] ?? document.warnings[0]).message}`)
          }
          const data = document.toJS()
          if (!Array.isArray(data)) throw new Error('Bundle patch must be an array')
          for (const op of data) {
            if (!object(op)) throw new Error('Unsupported bundle patch operation')
            if (Array.isArray(op.insert)) {
              if (Object.keys(op).length !== 1) throw new Error('Unsupported bundle patch operation: insert must be the only key')
              for (const row of op.insert) {
                const entry = rowFromInsert(row, patchPath)
                if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.name)) throw new Error(`Invalid or duplicate plugin name: ${entry.name}`)
                if (builtin.has(entry.name) || plugins.some((item) => item.name === entry.name)) {
                  throw new Error(`Invalid or duplicate plugin name: ${entry.name}`)
                }
                entry.config = applyWorkspacePluginConfig(entry.config, workspace)
                plugins.push(entry)
                inserted.add(entry.name)
              }
              continue
            }
            if (Object.hasOwn(op, 'id') && !Object.hasOwn(op, 'insert')) {
              applyReplace(plugins, op, patchPath, inserted)
              const row = plugins.find((entry) => entry.name === op.id)
              if (row) row.config = applyWorkspacePluginConfig(row.config, workspace)
              continue
            }
            const key = Object.keys(op)[0] ?? 'unknown'
            throw new Error(
              `Unsupported bundle patch operation: ${key}. ` +
              'Supported: insert arrays, and id-targeted replace of name/config/disabled for rows inserted earlier in this install. ' +
              'Not supported: replacing pre-existing profile rows, remove, preset, group, isolate, !!js, profile layering, or version checks.'
            )
          }
        }
        if (!inserted.size) throw new Error('Bundle contains no plugin rows')
      } else {
        const name = packageName.replace(/^@/, '').replaceAll('/', '-')
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || builtin.has(name) || plugins.some((item) => item.name === name)) {
          throw new Error(`Invalid or duplicate plugin name: ${name}`)
        }
        const entry = {
          name,
          module: resolveModule(packageName, join(stage, 'package.json')),
          config: applyWorkspacePluginConfig({}, workspace),
        }
        plugins.push(entry)
        inserted.add(name)
      }
      // Live activation names: unique ids from this install that should mount now.
      // Omit disabled rows; do not re-list an id when a same-install replace touches it.
      const names = [...inserted].filter((id) => {
        const row = plugins.find((entry) => entry.name === id)
        return row && row.enabled !== false
      })
      // Keep the staging directory as the installed package: absolute paths in
      // the profile stay valid, including npm's local package links.
      config.plugins = plugins
      const temp = join(dirname(configPath), `.plugins-${basename(stage)}.json`)
      try {
        await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
        await rename(temp, configPath)
      } catch (error) { await rm(temp, { force: true }); throw error }
      return { packageName, configPath, names, installedNames: [...inserted] }
    } finally { lock.release() }
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}
