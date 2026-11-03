import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as resolveImport } from 'import-meta-resolve'
import { parseDocument } from 'yaml'
import { composition } from './composition.js'
import { acquireWriter } from './lock.js'

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)

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
      const child = spawn('npm', ['install', '--no-audit', '--no-fund', '--save', '--', input], { cwd: stage, stdio: options.captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
      let detail = ''
      if (options.captureOutput) {
        child.stdout.on('data', () => {})
        child.stderr.on('data', (chunk) => { detail = (detail + chunk.toString()).slice(-4000) })
      }
      child.once('error', fail)
      child.once('close', (code, signal) => code === 0 ? ok() : fail(new Error(`npm install failed (${signal ?? code})${detail ? `: ${detail.trim()}` : ''}`)))
    })
    const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'))
    const packages = Object.keys(manifest.dependencies ?? {})
    if (packages.length !== 1) throw new Error('Expected npm to install exactly one direct package')
    const packageName = packages[0]
    const root = join(stage, 'node_modules', ...packageName.split('/'))
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const patch = pkg.dsh?.bundle?.patch
    const rows = []
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
          if (!object(op) || Object.keys(op).length !== 1 || !Array.isArray(op.insert)) throw new Error('Unsupported bundle patch operation: only insert arrays are supported')
          for (const row of op.insert) {
            if (!object(row) || Object.keys(row).some((key) => !['id', 'name', 'config'].includes(key)) || typeof row.id !== 'string' || typeof row.name !== 'string') throw new Error('Unsupported bundle plugin row')
            let path
            try { path = resolveModule(row.name, patchPath) }
            catch (error) { throw new Error(`Cannot resolve bundle plugin ${row.name}: ${error.message}`) }
            rows.push({ name: row.id, module: path, ...(Object.hasOwn(row, 'config') ? { config: row.config } : {}) })
          }
        }
      }
    } else {
      rows.push({ name: packageName.replace(/^@/, '').replaceAll('/', '-'), module: resolveModule(packageName, join(stage, 'package.json')) })
    }
    if (!rows.length) throw new Error('Bundle contains no plugin rows')
    const lock = await lockProfile(configPath)
    try {
      let config
      try { config = JSON.parse(await readFile(configPath, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error; config = { plugins: [] } }
      if (!object(config) || Object.keys(config).some((key) => key !== 'plugins') || !Array.isArray(config.plugins)) throw new Error(`Invalid plugin configuration: ${configPath}`)
      const names = new Set([...composition({ terminal: {}, view: true, web: true }).map((entry) => entry.name), ...config.plugins.map((entry) => entry.name)])
      for (const row of rows) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(row.name) || names.has(row.name)) throw new Error(`Invalid or duplicate plugin name: ${row.name}`)
        names.add(row.name)
      }
      // Keep the staging directory as the installed package: absolute paths in
      // the profile stay valid, including npm's local package links.
      config.plugins.push(...rows)
      const temp = join(dirname(configPath), `.plugins-${basename(stage)}.json`)
      try {
        await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
        await rename(temp, configPath)
      } catch (error) { await rm(temp, { force: true }); throw error }
      return { packageName, configPath, names: rows.map((row) => row.name) }
    } finally { lock.release() }
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}
