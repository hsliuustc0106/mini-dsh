import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as resolveImport } from 'import-meta-resolve'
import { isScalar, parseDocument, visit } from 'yaml'
import { composition } from './composition.js'
import { applyWorkspacePluginConfig } from './workspace-path.js'
import { acquireWriter } from './lock.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const INSERT_KEYS = new Set(['id', 'name', 'config', 'disabled', 'group', 'isolate'])
const REPLACE_KEYS = new Set(['id', 'name', 'config', 'disabled'])
const JS_TAG = 'tag:yaml.org,2002:js'
// Teaching runtime id for engines.dsh / @deepseek-ai/dsh* peer checks (#75).
export const MINI_DSH_RUNTIME = '0.1.0'
// @tt-a1i/archify-dsh@1.0.0 only (#78). The published path expression is recognized
// and never evaluated; it is not part of the teaching-scoped !!js grammar.
const ARCHIFY = '@tt-a1i/archify-dsh'
const ARCHIFY_EXPRESSION = "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@tt-a1i/archify-dsh/package.json')), 'skills')"
const jsExpression = Symbol('unsupported JavaScript expression')

async function archifyEntry(root, data) {
  const row = data?.[0]?.insert?.[0]
  const config = row?.config
  if (!Array.isArray(data) || data.length !== 1 || !object(data[0]) || Object.keys(data[0]).join() !== 'insert' ||
      !Array.isArray(data[0].insert) || data[0].insert.length !== 1 || !object(row) ||
      Object.keys(row).sort().join() !== 'config,id,name' || row.id !== 'archify-skill-filesystem' ||
      row.name !== '@deepseek-ai/dsh-skill-filesystem' || !object(config) ||
      Object.keys(config).sort().join() !== 'bundledSkillDir,includeDefaultRoots,providerName' ||
      config.providerName !== 'archify-plugin' || config.includeDefaultRoots !== false ||
      config.bundledSkillDir?.[jsExpression] !== ARCHIFY_EXPRESSION) {
    throw new Error('Unsupported Archify bundle: expected the published 1.0.0 skill provider and path expression; profile unchanged')
  }
  const packageRoot = await realpath(root)
  const skillRoot = await realpath(join(root, 'skills'))
  if (skillRoot !== join(packageRoot, 'skills')) throw new Error('Archify skill directory must be inside the package')
  await readFile(join(skillRoot, 'archify', 'SKILL.md'), 'utf8')
  return { name: row.id, module: fileURLToPath(new URL('./dsh-skill-root.js', import.meta.url)), config: { bundledSkillDir: skillRoot } }
}

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

async function readLocalPackageManifest(spec) {
  const input = spec.startsWith('.') ? resolve(process.cwd(), spec) : (isAbsolute(spec) ? spec : null)
  if (!input) return null
  try {
    return JSON.parse(await readFile(join(input, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function dshHomePath(...parts) {
  const root = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  return join(root, ...parts.map(String))
}

// Teaching-scoped !!js: allow only a closed expression grammar evaluated at install time.
// Loader ctx.* expressions and arbitrary JS stay unsupported and fail closed.
export function evaluateJsExpression(source, label) {
  const text = String(source).trim()
  if (!text) throw new Error(`Unsupported !!js expression${label ? ` in ${label}` : ''}: empty`)
  if (text === 'process.cwd()') return process.cwd()
  if (text === 'process.platform') return process.platform
  {
    const match = text.match(/^dshHomePath\(\s*(?:'([^']*)'|"([^"]*)")\s*\)$/)
    if (match) return dshHomePath(match[1] ?? match[2])
  }
  {
    const match = text.match(/^process\.platform\s*===\s*(?:'([^']*)'|"([^"]*)")$/)
    if (match) return process.platform === (match[1] ?? match[2])
  }
  {
    const match = text.match(/^process\.platform\s*!==\s*(?:'([^']*)'|"([^"]*)")$/)
    if (match) return process.platform !== (match[1] ?? match[2])
  }
  throw new Error(
    `Unsupported !!js expression${label ? ` in ${label}` : ''}: ${text}. ` +
    'mini-dsh evaluates only process.cwd(), process.platform, process.platform ===/!== <string>, and dshHomePath(<string>) at install time.'
  )
}

function materializeJsTags(document, file) {
  const errors = []
  visit(document, {
    Node(_, node) {
      if (!isScalar(node) || node.tag !== JS_TAG) return
      try {
        node.value = evaluateJsExpression(node.value, file)
        node.tag = undefined
        node.type = typeof node.value === 'string' ? 'QUOTE_DOUBLE' : 'PLAIN'
      } catch (error) {
        errors.push(error)
      }
    },
  })
  if (errors.length) throw errors[0]
}

function parseBundlePatch(text, file) {
  const document = parseDocument(text)
  if (document.errors.length) {
    throw new Error(`Unsupported or invalid bundle YAML in ${file}: ${document.errors[0].message}`)
  }
  const foreign = document.warnings.filter((warning) => {
    if (warning.code !== 'TAG_RESOLVE_FAILED') return true
    return !String(warning.message).includes('tag:yaml.org,2002:js')
  })
  if (foreign.length) {
    throw new Error(`Unsupported or invalid bundle YAML in ${file}: ${foreign[0].message}`)
  }
  materializeJsTags(document, file)
  const data = document.toJS()
  if (!Array.isArray(data)) throw new Error('Bundle patch must be an array')
  return data
}

// Minimal semver range check for engines.dsh / peer @deepseek-ai/dsh* declarations.
export function satisfiesVersion(version, range) {
  if (typeof version !== 'string' || typeof range !== 'string') return false
  const v = version.trim()
  const r = range.trim()
  if (!v || !r) return false
  if (r === '*' || r === 'x' || r === 'X') return true
  if (r.startsWith('workspace:')) return false
  if (r === v) return true
  const parse = (text) => {
    const match = text.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
    if (!match) return null
    return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] ?? '' }
  }
  const cmp = (a, b) => {
    if (a.major !== b.major) return a.major - b.major
    if (a.minor !== b.minor) return a.minor - b.minor
    if (a.patch !== b.patch) return a.patch - b.patch
    if (a.pre === b.pre) return 0
    if (!a.pre) return 1
    if (!b.pre) return -1
    return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0
  }
  const ver = parse(v)
  if (!ver) return false
  if (r.startsWith('^')) {
    const base = parse(r.slice(1))
    if (!base) return false
    if (cmp(ver, base) < 0) return false
    if (base.major === 0) {
      if (base.minor === 0) return ver.major === 0 && ver.minor === 0 && ver.patch === base.patch && !ver.pre
      return ver.major === 0 && ver.minor === base.minor && cmp(ver, base) >= 0 && !ver.pre
    }
    return ver.major === base.major && cmp(ver, base) >= 0 && !ver.pre
  }
  if (r.startsWith('~')) {
    const base = parse(r.slice(1))
    if (!base) return false
    return ver.major === base.major && ver.minor === base.minor && cmp(ver, base) >= 0 && !ver.pre
  }
  const ge = r.match(/^>=\s*(.+)$/)
  if (ge) {
    const base = parse(ge[1])
    return Boolean(base) && cmp(ver, base) >= 0
  }
  return false
}

export function assertPackageCompatible(pkg, runtime = MINI_DSH_RUNTIME) {
  const name = pkg.name ?? '<unknown>'
  const engines = pkg.engines
  if (engines !== undefined) {
    if (!object(engines)) throw new Error('Invalid package engines: expected an object')
    if (Object.hasOwn(engines, 'dsh')) {
      if (typeof engines.dsh !== 'string' || !engines.dsh.trim()) {
        throw new Error('Invalid package engines.dsh: expected a non-empty version range')
      }
      // mini-dsh is not a DSH runtime identity: reject empty/workspace:/unparseable ranges,
      // but do not refuse ordinary DSH engines.dsh ranges against MINI_DSH_RUNTIME.
      const range = engines.dsh.trim()
      if (range.startsWith('workspace:')) {
        throw new Error(`Package ${name} has invalid engines.dsh ${engines.dsh}`)
      }
      if (range !== '*' && range !== 'x' && range !== 'X' && !satisfiesVersion(runtime, range) && !/^[\^~>=*0-9v]/.test(range)) {
        throw new Error(`Package ${name} has invalid engines.dsh ${engines.dsh}`)
      }
      // Well-formed engines.dsh is recorded by succeeding; range vs DSH product is not gated here.
    }
  }
  const peers = pkg.peerDependencies
  if (!object(peers)) return
  const client = []
  const malformed = []
  for (const [peer, range] of Object.entries(peers)) {
    if (peer.startsWith('@deepseek-ai/dsh-client')) {
      client.push(`${peer}@${range}`)
      continue
    }
    if (peer !== '@deepseek-ai/dsh' && !peer.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof range !== 'string' || !range.trim() || range.trim().startsWith('workspace:')) {
      malformed.push(`${peer}@${range}`)
    }
  }
  if (client.length) {
    throw new Error(
      `Package ${name} requires DSH client peers unsupported by mini-dsh: ${client.join(', ')}. ` +
      'Install on a DSH desktop/client host instead; mini-dsh leaves the profile unchanged.'
    )
  }
  if (malformed.length) {
    throw new Error(`Package ${name} has invalid @deepseek-ai/dsh* peerDependencies: ${malformed.join(', ')}`)
  }
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
    const desktop = /@mixian\/dsh-desktop-plugin|dsh-client-/i.test(text)
      ? ' Packages such as @mixian/dsh-desktop-plugin need a DSH desktop/client peer tree that mini-dsh does not ship; their install path stays fail-closed here.'
      : ''
    return new Error(
      `npm dependency resolution failed (ERESOLVE).${hint}${desktop} ` +
      'mini-dsh leaves the profile unchanged and does not accept --force or --legacy-peer-deps ' +
      'as proof of compatibility; install a package whose peer dependencies resolve cleanly ' +
      `(or pin a compatible set).${text ? ` npm said: ${text.slice(0, 1500)}` : ''}`
    )
  }
  const tail = text ? `: ${text.slice(-1500)}` : ''
  return new Error(`npm install failed (${signal ?? code})${tail}`)
}

function assertDisabled(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`${label}: disabled must be a boolean literal (or !!js that evaluates to one)`)
  }
}

function rowFromInsert(row, patchPath) {
  if (!object(row) || typeof row.id !== 'string' || typeof row.name !== 'string') {
    throw new Error('Unsupported bundle plugin row: insert rows need id and name')
  }
  if (Object.keys(row).some((key) => !INSERT_KEYS.has(key))) {
    throw new Error(
      `Unsupported bundle plugin row ${row.id}: allowed keys are id, name, config, disabled, group, isolate`
    )
  }
  if (row.group === true || row.name === 'cordis:group') {
    if (row.isolate !== undefined) {
      throw new Error(
        `Unsupported bundle plugin row ${row.id}: isolate realms are not implemented in mini-dsh (fail closed)`
      )
    }
    if (row.name !== 'cordis:group' || row.group !== true) {
      throw new Error(`Unsupported bundle plugin row ${row.id}: group rows need name: cordis:group and group: true`)
    }
    if (!Array.isArray(row.config)) {
      throw new Error(`Unsupported bundle plugin row ${row.id}: group config must be a nested entry list`)
    }
    return { group: true, id: row.id, children: row.config }
  }
  if (row.isolate !== undefined) {
    throw new Error(
      `Unsupported bundle plugin row ${row.id}: isolate realms are not implemented in mini-dsh (fail closed)`
    )
  }
  if (Object.hasOwn(row, 'disabled')) assertDisabled(row.disabled, `Unsupported bundle plugin row ${row.id}`)
  // Nested preset/agent-preset rows keep config.plugins as config data for that plugin module.
  if (object(row.config) && Array.isArray(row.config.plugins)) {
    for (const child of row.config.plugins) {
      if (!object(child) || typeof child.id !== 'string' || typeof child.name !== 'string') {
        throw new Error(`Unsupported nested preset row under ${row.id}: each plugins entry needs id and name`)
      }
      if (child.isolate !== undefined || child.group === true || child.name === 'cordis:group') {
        throw new Error(
          `Unsupported nested preset row ${child.id} under ${row.id}: group/isolate inside nested presets are not implemented`
        )
      }
    }
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

function applyReplace(plugins, op, patchPath, layerIds) {
  if (!object(op) || typeof op.id !== 'string' || !op.id || Object.keys(op).some((key) => !REPLACE_KEYS.has(key))) {
    throw new Error('Unsupported bundle patch operation: id-targeted replace allows id plus optional name, config, and boolean disabled')
  }
  if (!Object.keys(op).some((key) => key !== 'id')) {
    throw new Error(`Unsupported bundle patch operation: replace for ${op.id} needs name, config, or disabled`)
  }
  if (Object.hasOwn(op, 'disabled')) assertDisabled(op.disabled, `Unsupported bundle patch operation: disabled for ${op.id}`)
  if (Object.hasOwn(op, 'name') && (typeof op.name !== 'string' || !op.name)) {
    throw new Error(`Unsupported bundle patch operation: name for ${op.id} must be a non-empty string`)
  }
  // Profile layering (#75): a later patch layer may retarget rows contributed by earlier
  // layers in this install, including prior patch files of the same bundle. Cross-install
  // hijacks of profile rows from other packages remain refused.
  if (!layerIds.has(op.id)) {
    const known = plugins.some((entry) => entry.name === op.id)
    throw new Error(
      known
        ? `Bundle patch cannot replace pre-existing plugin id: ${op.id} (only rows from earlier layers in this install)`
        : `Bundle patch targets unknown plugin id: ${op.id}`
    )
  }
  const index = plugins.findIndex((entry) => entry.name === op.id)
  const next = { ...plugins[index] }
  // Field updates: `config` is replaced wholesale (not deep-merged); name/disabled update in place.
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

function applyRemove(plugins, op, layerIds, inserted) {
  if (!object(op) || Object.keys(op).length !== 1 || !Array.isArray(op.remove)) {
    throw new Error('Unsupported bundle patch operation: remove must be the only key and an array of ids')
  }
  for (const id of op.remove) {
    if (typeof id !== 'string' || !id) throw new Error('Unsupported bundle patch operation: remove ids must be non-empty strings')
    if (!layerIds.has(id)) {
      const known = plugins.some((entry) => entry.name === id)
      throw new Error(
        known
          ? `Bundle patch cannot remove pre-existing plugin id: ${id} (only rows from earlier layers in this install)`
          : `Bundle patch removes unknown plugin id: ${id}`
      )
    }
    const index = plugins.findIndex((entry) => entry.name === id)
    if (index >= 0) plugins.splice(index, 1)
    layerIds.delete(id)
    inserted.delete(id)
  }
}

function pushEntry(plugins, builtin, inserted, layerIds, entry, workspace) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.name)) throw new Error(`Invalid or duplicate plugin name: ${entry.name}`)
  if (builtin.has(entry.name) || plugins.some((item) => item.name === entry.name)) {
    throw new Error(`Invalid or duplicate plugin name: ${entry.name}`)
  }
  entry.config = applyWorkspacePluginConfig(entry.config, workspace)
  plugins.push(entry)
  inserted.add(entry.name)
  layerIds.add(entry.name)
}

function applyInsertRows(plugins, builtin, inserted, layerIds, rows, patchPath, workspace) {
  for (const row of rows) {
    const entry = rowFromInsert(row, patchPath)
    if (entry.group) {
      // Teaching flatten: expand cordis:group children into the flat profile.
      // isolate was already refused in rowFromInsert.
      applyInsertRows(plugins, builtin, inserted, layerIds, entry.children, patchPath, workspace)
      continue
    }
    pushEntry(plugins, builtin, inserted, layerIds, entry, workspace)
  }
}

// Install in a staging directory so failed installs never alter the active profile.
export async function installPlugin(spec, workspace, options = {}) {
  if (typeof spec !== 'string' || !spec || spec.startsWith('-')) throw new Error('Provide one npm package spec')
  if (!isAbsolute(workspace)) throw new Error('Workspace must be an absolute path')
  const home = join(workspace, '.mini-dsh')
  const configPath = options.configPath ?? join(home, 'plugins.json')
  if (!isAbsolute(configPath)) throw new Error('Plugin config path must be absolute')
  await mkdir(home, { recursive: true })
  const localPkg = await readLocalPackageManifest(spec)
  if (localPkg) assertPackageCompatible(localPkg, options.runtime ?? MINI_DSH_RUNTIME)
  const stage = await mkdtemp(join(home, '.install-'))
  try {
    await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true }))
    const input = spec.startsWith('.') ? resolve(process.cwd(), spec) : spec
    await new Promise((ok, fail) => {
      // Always capture npm output so ERESOLVE can be turned into an actionable error.
      // Pass --no-force / --no-legacy-peer-deps so a user .npmrc cannot override (#75 / #74 P2).
      const child = spawn('npm', [
        'install',
        '--no-audit',
        '--no-fund',
        '--save',
        '--no-force',
        '--no-legacy-peer-deps',
        '--',
        input,
      ], {
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
    assertPackageCompatible(pkg, options.runtime ?? MINI_DSH_RUNTIME)
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
      // layerIds: rows contributed by earlier patch files / inserts in THIS install (profile layering).
      const layerIds = new Set()
      const patch = pkg.dsh?.bundle?.patch
      if (patch !== undefined) {
        const patches = Array.isArray(patch) ? patch : [patch]
        if (!patches.length || patches.some((item) => typeof item !== 'string' || !item)) throw new Error('Invalid dsh.bundle.patch')
        for (const file of patches) {
          const patchPath = resolve(root, file)
          if (packageName === ARCHIFY && pkg.version === '1.0.0') {
            if (patches.length !== 1 || file !== './cordis.patch.yml') {
              throw new Error('Unsupported Archify bundle patch; profile unchanged')
            }
            // Capture !!js as data. Do not call evaluateJsExpression or any other JS evaluator.
            const document = parseDocument(await readFile(patchPath, 'utf8'), {
              customTags: [{ tag: JS_TAG, resolve: (value) => ({ [jsExpression]: value }) }],
            })
            if (document.errors.length || document.warnings.length) {
              throw new Error(`Unsupported or invalid bundle YAML in ${file}: ${(document.errors[0] ?? document.warnings[0]).message}`)
            }
            const data = document.toJS()
            if (!Array.isArray(data)) throw new Error('Bundle patch must be an array')
            pushEntry(plugins, builtin, inserted, layerIds, await archifyEntry(root, data), workspace)
            continue
          }
          const data = parseBundlePatch(await readFile(patchPath, 'utf8'), file)
          for (const op of data) {
            if (!object(op)) throw new Error('Unsupported bundle patch operation')
            if (Array.isArray(op.insert)) {
              if (Object.keys(op).length !== 1) throw new Error('Unsupported bundle patch operation: insert must be the only key')
              applyInsertRows(plugins, builtin, inserted, layerIds, op.insert, patchPath, workspace)
              continue
            }
            if (Array.isArray(op.remove)) {
              applyRemove(plugins, op, layerIds, inserted)
              continue
            }
            if (Object.hasOwn(op, 'id') && !Object.hasOwn(op, 'insert') && !Object.hasOwn(op, 'remove')) {
              applyReplace(plugins, op, patchPath, layerIds)
              const row = plugins.find((entry) => entry.name === op.id)
              if (row) row.config = applyWorkspacePluginConfig(row.config, workspace)
              continue
            }
            const key = Object.keys(op)[0] ?? 'unknown'
            throw new Error(
              `Unsupported bundle patch operation: ${key}. ` +
              'Supported: ordered patch-file layers with insert (including cordis:group flatten without isolate), ' +
              'same-install-layer remove, id-targeted replace of name/config/disabled for earlier layers in this install, ' +
              'nested preset config.plugins without group/isolate, teaching-scoped !!js, and engines.dsh / @deepseek-ai/dsh* version checks. ' +
              'Not supported: replacing or removing pre-existing profile rows from other packages, isolate realms, or Loader ctx.* !!js.'
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
        layerIds.add(name)
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
