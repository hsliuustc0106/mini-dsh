import { Context } from '@deepseek-ai/cordis'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { Agent } from './agent.js'
import { coding } from './coding.js'
import { Model, Session, Tools } from './services.js'

const ctx = new Context()
const fibers = []
fibers.push(ctx.plugin(Agent))
fibers.push(ctx.plugin(coding))
fibers.push(ctx.plugin(Tools))
fibers.push(ctx.plugin(Session, { path: process.env.MINI_SESSION || '.mini-session.jsonl' }))
fibers.push(ctx.plugin(Model, { key: process.env.DEEPSEEK_API_KEY, baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', model: process.env.DEEPSEEK_MODEL || 'deepseek-chat' }))
await new Promise(setImmediate)
if (!ctx.session || !ctx.agent) throw new Error('Plugin startup failed')
await ctx.session.load()
const cli = createInterface({ input: stdin, output: stdout })
console.log('Mini harness. /quit exits; session:', ctx.session.path)
try {
  for (;;) {
    const input = await cli.question('\nYou> ')
    if (input.trim() === '/quit') break
    if (!input.trim()) continue
    try { await ctx.agent.turn(input, ({ type, content }) => console.log(`\n${type}> ${content}`)) }
    catch (error) { console.error(`Error: ${error.message}`); break }
  }
} finally { cli.close(); await Promise.all(fibers.map((fiber) => fiber.dispose())) }
