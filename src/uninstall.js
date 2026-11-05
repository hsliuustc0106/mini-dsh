import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { boot } from './boot.js'
import { requireInspectedProfile, uninstallPlugin } from './live-plugins.js'

let app, temp
try {
  const args = process.argv.slice(2)
  if (args.length < 1 || args.length > 2 || args[0].startsWith('-') || (args.length === 2 && args[1] !== '--cascade')) {
    throw new Error('Usage: npm run plugin:uninstall -- <plugin-name> [--cascade]')
  }
  const workspace = resolve(process.env.MINI_WORKSPACE || process.cwd())
  const selected = process.env.MINI_CONFIG || join(workspace, '.mini-dsh', 'plugins.json')
  const configPath = isAbsolute(selected) ? selected : resolve(workspace, selected)
  const expectedProfile = await readFile(configPath, 'utf8')
  temp = await mkdtemp(join(tmpdir(), 'mini-dsh-uninstall-'))
  // This starts trusted profile plugins in a separate Cordis context. It does
  // not connect to or coordinate with an already-running mini-dsh process.
  app = await boot({ workspace, pluginConfig: configPath, session: join(temp, 'session.jsonl') })
  if (!app.ctx.livePlugins) throw new Error('Profile does not provide the live plugin inspection service')
  if (await readFile(configPath, 'utf8') !== expectedProfile) throw new Error('Plugin profile changed during inspection; retry uninstall')
  let expectedNames
  if (args[1] === '--cascade') {
    const config = JSON.parse(expectedProfile)
    requireInspectedProfile(config, app.ctx.livePlugins)
    expectedNames = app.ctx.livePlugins.removalPlan(args[0])
    for (const name of expectedNames) {
      if (!config.plugins.some((entry) => entry.name === name)) throw new Error(`Plugin ${name} is not in the profile`)
    }
    console.log(`Will uninstall (dependents first): ${expectedNames.join(', ')}`)
    process.stdout.write('Type yes to confirm: ')
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
    let answer
    try { for await (const line of reader) { answer = line; break } }
    finally { reader.close() }
    if (answer?.trim().toLowerCase() !== 'yes') throw new Error('Uninstall cancelled; profile was not changed')
  }
  const result = await uninstallPlugin(args[0], workspace, {
    configPath, livePlugins: app.ctx.livePlugins, expectedProfile, requireMounted: true, offline: true,
    expectedNames,
  })
  console.log(`Uninstalled ${result.names.join(', ')} from ${result.configPath}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await app?.dispose()
  if (temp) await rm(temp, { recursive: true, force: true })
}
