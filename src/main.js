import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { boot } from './boot.js'
import { composition } from './composition.js'

let app
try {
  app = await boot({
    workspace: process.env.MINI_WORKSPACE || process.cwd(),
    session: process.env.MINI_SESSION,
    composition,
    model: {
      key: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    },
  })
  const { session } = app.ctx
  if (!session.writable) {
    console.error(session.readonlyReason)
    console.error('Inspect the workspace, then start a new session by setting MINI_SESSION to a new file.')
    process.exitCode = 1
  } else {
    const cli = createInterface({ input: stdin, output: stdout })
    console.log('Mini harness. /quit exits; workspace:', app.workspace)
    console.log('Session:', app.sessionPath)
    try {
      for (;;) {
        const input = await cli.question('\nYou> ')
        if (input.trim() === '/quit') break
        if (!input.trim()) continue
        try { await app.ctx.agent.turn(input, ({ type, content }) => console.log(`\n${type}> ${content}`)) }
        catch (error) { console.error(`Error: ${error.message}`); break }
      }
    } finally { cli.close() }
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
