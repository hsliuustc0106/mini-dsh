import { installPlugin } from './install-plugin.js'

try {
  if (process.argv.length !== 3) throw new Error('Usage: npm run plugin:install -- <npm-package-spec>')
  const workspace = process.env.MINI_WORKSPACE || process.cwd()
  const result = await installPlugin(process.argv[2], workspace)
  console.log(`Installed ${result.packageName}: ${result.installedNames.join(', ')}`)
  console.log(`Profile: ${result.configPath}`)
  console.log('If mini-dsh is already running, use the web Plugins panel (or restart) to activate. New tools are denied until a permission policy is configured.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
