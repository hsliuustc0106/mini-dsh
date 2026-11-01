import { Service } from '@deepseek-ai/cordis'
import { createInterface } from 'node:readline'

// The terminal owns input, approval prompts, and the interactive loop. Its
// readline and all pending reads leave with its plugin fiber.
export class Terminal extends Service {
  static inject = ['agent', 'session']

  constructor(ctx, { input, output }) {
    super(ctx, 'terminal')
    this.output = output
    this.cli = createInterface({ input, output })
    this.cli.setPrompt('')
    this.lines = []
    this.waiting = []
    this.closed = false
    this.cli.on('line', (line) => {
      const next = this.waiting.shift()
      if (next) next(line)
      else this.lines.push(line)
    })
    this.cli.on('close', () => {
      this.closed = true
      while (this.waiting.length) this.waiting.shift()(undefined)
    })
    ctx.effect(() => () => this.close())
  }

  ask(prompt, signal) {
    this.output.write(prompt)
    if (signal?.aborted) return Promise.resolve(undefined)
    if (this.lines.length) return Promise.resolve(this.lines.shift())
    if (this.closed) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const finish = (line) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(line)
      }
      const onAbort = () => {
        const index = this.waiting.indexOf(finish)
        if (index >= 0) this.waiting.splice(index, 1)
        resolve(undefined)
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(finish)
    })
  }

  // Only y or yes grants this exact call. EOF and abort do not.
  async approve(detail, signal) {
    const answer = await this.ask(`Approve ${detail.name} ${JSON.stringify(detail.arguments)}? [y/N] `, signal)
    if (answer == null || signal?.aborted) return undefined
    return /^(y|yes)$/i.test(answer.trim())
  }

  close() {
    if (!this.closed) this.cli.close()
  }

  async run({ workspace, sessionPath, viewerUrl, webUrl }) {
    const { session, agent } = this.ctx
    if (!session.writable) {
      console.error(session.readonlyReason)
      console.error('Inspect the workspace, then start a new session by setting MINI_SESSION to a new file.')
      process.exitCode = 1
      return
    }
    console.log('Mini harness. /quit exits; workspace:', workspace)
    console.log('Session:', `${sessionPath} (${session.events.length} events)`)
    if (viewerUrl) {
      console.log('Trajectory:', viewerUrl)
      console.log('Simulated prototype:', `${viewerUrl}/prototype`)
    }
    if (webUrl) console.log('Web:', webUrl)
    for (;;) {
      const input = await this.ask('\nYou> ')
      if (input == null || input.trim() === '/quit') break
      if (!input.trim()) continue
      try { await agent.turn(input, ({ type, content }) => console.log(`\n${type}> ${content}`)) }
      catch (error) { console.error(`Error: ${error.message}`); if (error.code !== 'BUSY') break }
    }
  }
}
