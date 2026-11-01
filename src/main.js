import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline'
import { boot } from './boot.js'
import { composition } from './composition.js'
import { fakeProvider } from './provider.js'
import { viewerSettings } from './viewer.js'

const inspect = process.env.MINI_INSPECT === '1'

function fixedClock() {
  const time = process.env.MINI_CLOCK
  if (!time) return undefined
  return () => time
}

async function loadProvider() {
  const file = process.env.MINI_REPLIES
  if (!file) return undefined
  const path = resolve(file)
  let parsed
  try { parsed = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    throw new Error(error instanceof SyntaxError ? `MINI_REPLIES is not JSON: ${path}` : `MINI_REPLIES could not be read: ${path}`)
  }
  if (!Array.isArray(parsed)) throw new Error('MINI_REPLIES must be a JSON array')
  return fakeProvider(parsed)
}

// Lines are queued as they arrive, including during boot and between prompts.
// A closed input resolves the pending read with no answer.
function openTerminal(input, output) {
  const cli = createInterface({ input, output })
  cli.setPrompt('')
  const lines = []
  const waiting = []
  let closed = false
  const deliver = (line) => {
    const next = waiting.shift()
    if (next) next(line)
    else lines.push(line)
  }
  cli.on('line', deliver)
  cli.on('close', () => {
    closed = true
    while (waiting.length) waiting.shift()(undefined)
  })
  return {
    ask(prompt, signal) {
      output.write(prompt)
      if (signal?.aborted) return Promise.resolve(undefined)
      if (lines.length) return Promise.resolve(lines.shift())
      if (closed) return Promise.resolve(undefined)
      return new Promise((resolve) => {
        const finish = (line) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(line)
        }
        const onAbort = () => {
          const index = waiting.indexOf(finish)
          if (index >= 0) waiting.splice(index, 1)
          resolve(undefined)
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        waiting.push(finish)
      })
    },
    close() {
      if (!closed) cli.close()
    },
  }
}

// One answer for this exact call. Only y or yes is a grant. EOF and abort are not.
function oneShotApproval(terminal) {
  return async (detail, signal) => {
    const answer = await terminal.ask(`Approve ${detail.name} ${JSON.stringify(detail.arguments)}? [y/N] `, signal)
    if (answer == null || signal?.aborted) return undefined
    return /^(y|yes)$/i.test(answer.trim())
  }
}

let app
let terminal
try {
  const provider = inspect ? undefined : await loadProvider()
  if (!inspect) terminal = openTerminal(stdin, stdout)
  app = await boot({
    workspace: process.env.MINI_WORKSPACE || process.cwd(),
    session: process.env.MINI_SESSION,
    composition,
    writable: !inspect,
    provider,
    approve: terminal ? oneShotApproval(terminal) : undefined,
    clock: fixedClock(),
    view: process.env.MINI_VIEW === '1' && !inspect ? viewerSettings() : undefined,
  })
  const { session } = app.ctx
  if (inspect) {
    for (const event of session.events) console.log(JSON.stringify(event))
    if (session.unknown.length) {
      console.error(session.readonlyReason)
      process.exitCode = 1
    }
  } else if (!session.writable) {
    // A pending approval or a started tool with no result stays unknown.
    // Refuse another turn instead of retrying the call.
    console.error(session.readonlyReason)
    console.error('Inspect the workspace, then start a new session by setting MINI_SESSION to a new file.')
    process.exitCode = 1
  } else {
    console.log('Mini harness. /quit exits; workspace:', app.workspace)
    console.log('Session:', `${app.sessionPath} (${session.events.length} events)`)
    if (app.ctx.viewer?.url) console.log('Trajectory:', app.ctx.viewer.url)
    for (;;) {
      const input = await terminal.ask('\nYou> ')
      if (input == null || input.trim() === '/quit') break
      if (!input.trim()) continue
      try { await app.ctx.agent.turn(input, ({ type, content }) => console.log(`\n${type}> ${content}`)) }
      catch (error) { console.error(`Error: ${error.message}`); break }
    }
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
  terminal?.close()
  await app?.dispose()
}
