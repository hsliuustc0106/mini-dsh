import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { boot } from './boot.js'
import { uninstallPlugin } from './live-plugins.js'

let app, temp
try {
  if (process.argv.length !== 3) throw new Error('Usage: npm run plugin:uninstall -- <plugin-name>')
  const workspace = resolve(process.env.MINI_WORKSPACE || process.cwd())
  const selected = process.env.MINI_CONFIG || join(workspace, '.mini-dsh', 'plugins.json')
  const configPath = isAbsolute(selected) ? selected : resolve(workspace, selected)
  const expectedProfile = await readFile(configPath, 'utf8')
  temp = await mkdtemp(join(tmpdir(), 'mini-dsh-uninstall-'))
  // This starts trusted profile plugins in a separate Cordis context. It does
  // not connect to or coordinate with an already-running mini-dsh process.
  app = await boot({ workspace, pluginConfig: configPath, session: join(temp, 'session.jsonl') })
  if (!app.ctx.livePlugins) throw new Error('Profile does not provide the live plugin inspection service')
  const result = await uninstallPlugin(process.argv[2], workspace, {
    configPath, livePlugins: app.ctx.livePlugins, expectedProfile, requireMounted: true, offline: true,
  })
  console.log(`Uninstalled ${result.name} from ${result.configPath}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await app?.dispose()
  if (temp) await rm(temp, { recursive: true, force: true })
}
