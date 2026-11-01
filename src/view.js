import { boot } from './boot.js'
import { viewerComposition } from './composition.js'
import { viewerSettings } from './viewer.js'

let app
let shuttingDown = false

async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  try { await app?.dispose() }
  catch (error) {
    console.error(error.message)
    code = 1
  }
  process.exit(code)
}

process.on('SIGINT', () => { shutdown(0) })
process.on('SIGTERM', () => { shutdown(0) })

try {
  app = await boot({
    workspace: process.env.MINI_WORKSPACE || process.cwd(),
    session: process.env.MINI_SESSION,
    writable: false,
    composition: viewerComposition,
    view: viewerSettings(),
  })
  const { session } = app.ctx
  console.log(`mini-dsh trajectory ${app.ctx.viewer.url}`)
  console.log(`Session: ${app.sessionPath} (${session.events.length} events)`)
  if (session.unknown.length) console.error(session.readonlyReason)
} catch (error) {
  console.error(error.message)
  for (const item of error.report ?? []) {
    if (item.state === 'active') continue
    const waiting = item.missing?.length ? ` waiting for ${item.missing.join(', ')}` : ''
    const detail = item.error ? ` (${item.error})` : ''
    console.error(`- ${item.name}: ${item.state}${detail}${waiting}`)
  }
  process.exitCode = 1
  await app?.dispose()
}
