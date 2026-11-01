import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { observeStream } from './log.js'
import { DEEPSEEK_MODEL, readApiKey } from './provider.js'

// One live terminal turn. Not part of npm test. Exits 0 without a key.
const root = fileURLToPath(new URL('..', import.meta.url))
const token = 'mini-dsh-smoke'
const prompt = 'Read smoke.txt with the read tool. The path must be smoke.txt.\n'

const apiKey = await readApiKey()
if (!apiKey) {
  console.error('DeepSeek smoke skipped: set DEEPSEEK_API_KEY or DEEPSEEK_API_KEY_FILE.')
  process.exit(0)
}

const dir = await mkdtemp(join(tmpdir(), 'mini-smoke-'))
const sessionPath = join(dir, 'session.jsonl')
try {
  await writeFile(join(dir, 'smoke.txt'), `${token}\n`)
  const { stdout } = await runTurn(dir, sessionPath, apiKey)
  const saved = await readFile(sessionPath, 'utf8')
  if (saved.includes(apiKey) || saved.includes('Authorization') || saved.includes('Bearer')) {
    throw new Error('session log contains credential material')
  }
  const events = saved.trim().split('\n').map((line) => JSON.parse(line))
  checkTurn(events, dir, process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_MODEL)
  const requests = events.filter((event) => event.type === 'model.request')
  console.log(`DeepSeek smoke passed (${events.length} events, model ${requests[0].body.model}).`)
  if (stdout.includes(apiKey)) throw new Error('terminal output contains the API key')
} catch (error) {
  console.error(redact(error.stack ? `${error.message}` : String(error), apiKey))
  process.exitCode = 1
} finally {
  await rm(dir, { recursive: true, force: true })
}

function redact(text, secret) {
  if (typeof text !== 'string') return ''
  if (!secret) return text
  return text.split(secret).join('[redacted]')
}

function childEnv(dir, sessionPath, apiKey) {
  const env = { ...process.env }
  for (const name of ['MINI_REPLIES', 'MINI_INSPECT', 'MINI_VIEW', 'MINI_VIEW_PORT', 'MINI_WEB', 'MINI_WEB_PORT', 'MINI_CLOCK', 'MINI_CONFIG', 'DEEPSEEK_API_KEY_FILE']) {
    delete env[name]
  }
  env.MINI_WORKSPACE = dir
  env.MINI_SESSION = sessionPath
  env.DEEPSEEK_API_KEY = apiKey
  env.DEEPSEEK_TOOL_CHOICE = 'read'
  return env
}

function runTurn(dir, sessionPath, apiKey) {
  const child = spawn(process.execPath, ['src/main.js'], {
    cwd: root,
    env: childEnv(dir, sessionPath, apiKey),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let approvals = 0
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  const deadline = Date.now() + 180000

  const until = (ready) => new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const marks = stdout.split('? [y/N] ').length - 1
      if (marks > approvals) {
        approvals += 1
        child.stdin.write('n\n')
      }
      if (ready()) {
        clearInterval(timer)
        resolve()
      } else if (child.exitCode != null || child.signalCode != null) {
        clearInterval(timer)
        reject(new Error(`main.js exited early (${child.exitCode ?? child.signalCode})\n${stderr}\n${stdout}`))
      } else if (Date.now() > deadline) {
        clearInterval(timer)
        reject(new Error(`timed out waiting for the live turn\n${stderr}\n${stdout}`))
      }
    }, 30)
  })

  const finish = async () => {
    try {
      await until(() => stdout.split('\nYou> ').length >= 2)
      child.stdin.write(prompt)
      await until(() => stdout.split('\nYou> ').length >= 3)
      child.stdin.write('/quit\n')
      const status = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve(null), 30000)),
      ])
      if (!status) throw new Error(`main.js did not exit\n${stderr}\n${stdout}`)
      if (status.code !== 0) throw new Error(`main.js exited ${status.code}\n${stderr}\n${stdout}`)
      if (stderr.trim()) throw new Error(`main.js wrote to stderr\n${stderr}\n${stdout}`)
      return { stdout, stderr }
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
      await exited
    }
  }
  return finish().catch((error) => {
    throw new Error(redact(error.message, apiKey).slice(0, 4000))
  })
}

function checkTurn(events, workspace, model) {
  const labels = events.map((event) => event.type === 'message' ? `message:${event.message.role}` : event.type)
  const requests = events.filter((event) => event.type === 'model.request')
  if (requests.length < 2) throw new Error(`expected two model requests, saw ${labels.join(', ')}`)
  const first = requests[0]
  if (first.provider !== 'deepseek') throw new Error(`provider was ${first.provider}`)
  const body = first.body
  if (body.model !== model) throw new Error(`model was ${body.model}`)
  if (body.stream !== true) throw new Error('request stream was not true')
  const ends = events.filter((event) => event.type === 'stream.ended')
  if (!ends.length || !events.some((event) => event.type === 'stream.delta')) {
    throw new Error('live turn recorded no stream')
  }
  for (const ended of ends) {
    const next = events.find((event) => event.seq === ended.seq + 1)
    const observed = observeStream(events, ended.stream)
    if (!observed.complete || next?.type !== 'message' || next.message.role !== 'assistant') {
      throw new Error('stream end was not followed by the observed assistant message')
    }
    if ((next.message.content ?? '') !== observed.text) throw new Error('assistant message does not match streamed text')
    if (next.message.tool_calls?.length) {
      const recorded = JSON.stringify(next.message.tool_calls)
      if (recorded !== JSON.stringify(observed.tool_calls)) throw new Error('assistant tool calls do not match streamed fragments')
    }
  }
  if (body.thinking?.type !== 'disabled') throw new Error('thinking was not disabled')
  if (body.messages?.[0]?.role !== 'system' || !body.messages[0].content.includes('"sandbox":false')) {
    throw new Error('request context did not record sandbox false')
  }
  if (!body.messages.some((message) => message.role === 'user' && message.content.includes('smoke.txt'))) {
    throw new Error('user message was not in the recorded request')
  }
  const names = (body.tools ?? []).map((tool) => tool.function?.name)
  for (const name of ['read', 'write', 'edit', 'shell', 'glob', 'grep']) {
    if (!names.includes(name)) throw new Error(`recorded tools omitted ${name}`)
  }
  if (body.tool_choice?.function?.name !== 'read') throw new Error('first request did not name the read tool')
  if (requests[1].body.tool_choice) throw new Error('follow-up request still forced a tool')
  if (!JSON.stringify(requests[1].body).includes(token)) throw new Error('follow-up request omitted the tool result')

  const decision = events.find((event) => event.type === 'permission.decided' && event.name === 'read')
  if (!decision || decision.decision !== 'allow') throw new Error('read was not allowed')
  if (decision.workspace !== workspace) throw new Error('permission workspace did not match the turn workspace')
  const allowedOther = events.find((event) => event.type === 'permission.decided' && event.name !== 'read' && event.decision === 'allow')
  if (allowedOther) throw new Error(`smoke allowed ${allowedOther.name}`)

  const started = events.find((event) => event.type === 'tool.started' && event.name === 'read')
  const finished = events.find((event) => event.type === 'tool.finished' && event.callId === started?.callId)
  if (!started || !finished || !(started.seq < finished.seq)) throw new Error('read tool events were not recorded in order')
  if (started.workspace !== workspace) throw new Error('tool start workspace did not match')
  if (!String(finished.result).includes(token)) throw new Error('tool result did not contain the file text')
  if (!events.some((event) => event.type === 'message' && event.message.role === 'assistant' && event.message.tool_calls?.length)) {
    throw new Error('assistant tool call was not recorded')
  }
  const last = events.at(-1)
  if (last.type !== 'message' || last.message.role !== 'assistant' || last.message.tool_calls?.length) {
    throw new Error('turn did not finish with an assistant reply')
  }
}
