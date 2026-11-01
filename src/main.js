import { stdin, stdout } from 'node:process'
import { boot } from './boot.js'
import { composition } from './composition.js'
import { environmentProvider } from './provider.js'
import { viewerSettings } from './viewer.js'
import { webControlSettings } from './web-control.js'

const inspect = process.env.MINI_INSPECT === '1'

function fixedClock() {
  const time = process.env.MINI_CLOCK
  if (!time) return undefined
  return () => time
}

let app
try {
  const provider = inspect ? undefined : environmentProvider()
  app = await boot({
    workspace: process.env.MINI_WORKSPACE || process.cwd(),
    session: process.env.MINI_SESSION,
    composition,
    pluginConfig: inspect ? undefined : process.env.MINI_CONFIG,
    writable: !inspect,
    provider,
    terminal: inspect ? undefined : { input: stdin, output: stdout },
    approve: inspect ? undefined : (detail, signal) => app?.ctx.terminal?.approve?.(detail, signal),
    clock: fixedClock(),
    view: process.env.MINI_VIEW === '1' && !inspect ? viewerSettings() : undefined,
    web: process.env.MINI_WEB === '1' && !inspect ? webControlSettings() : undefined,
  })
  const { session } = app.ctx
  if (!session) throw new Error('Terminal needs a session service')
  if (inspect) {
    for (const event of session.events) console.log(JSON.stringify(event))
    if (session.unknown.length) {
      console.error(session.readonlyReason)
      process.exitCode = 1
    }
  } else {
    if (typeof app.ctx.terminal?.run !== 'function') throw new Error('Interactive entry needs a terminal service with run()')
    await app.ctx.terminal.run({ workspace: app.workspace, sessionPath: app.sessionPath, viewerUrl: app.ctx.viewer?.url, webUrl: app.ctx.webControl?.url })
  }
} catch (error) {
  console.error(error.message)
  for (const item of error.report ?? []) {
    if (item.state === 'active') continue
    const waiting = item.missing?.length ? ` waiting for ${item.missing.join(', ')}` : ''
    const detail = item.error ? ` (${item.error})` : ''
    console.error(`- ${item.name}: ${item.state}${detail}${waiting}`)
  }
  process.exitCode = 1
} finally {
  await app?.dispose()
}
