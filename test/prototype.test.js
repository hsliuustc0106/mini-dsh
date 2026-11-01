import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '../src/boot.js'
import { viewerComposition } from '../src/composition.js'
import { prototypePage, reducePrototype, scriptedWrite } from '../src/prototype.js'
import { project } from '../src/trajectory.js'
import { renderPage } from '../src/viewer.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = join(root, 'fixtures/write-hello/session.jsonl')

function idle() {
  return { phase: 'idle', turns: [] }
}

function request(url, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('the scripted hello.txt call grants once and denies closed', () => {
  const write = scriptedWrite()
  assert.deepEqual(write, {
    callId: 'write-hello',
    name: 'write',
    arguments: { path: 'hello.txt', content: 'hello\n' },
  })
  const start = idle()
  assert.equal(reducePrototype(start, { type: 'send', prompt: '  \n', workspace: '/work' }), start)
  assert.equal(reducePrototype(start, { type: 'allow' }), start)
  assert.equal(reducePrototype(start, { type: 'deny' }), start)
  assert.equal(reducePrototype(start, { type: 'approve' }), start)

  const sent = reducePrototype(start, { type: 'send', prompt: 'Write hello.txt', workspace: '/work' })
  assert.equal(sent.phase, 'awaiting')
  assert.equal(sent.turns.length, 1)
  assert.equal(sent.turns[0].decision, null)
  assert.deepEqual(sent.turns[0].call, write)
  assert.equal(sent.turns[0].before[0].message.content, 'Write hello.txt')
  assert.equal(sent.turns[0].before[1].provider, 'simulated')
  assert.equal(JSON.stringify(sent).includes('tool.started'), false)
  assert.equal(JSON.stringify(sent).includes('permission.decided'), false)
  assert.equal(JSON.stringify(sent).includes('sk-'), false)
  assert.equal(reducePrototype(sent, { type: 'send', prompt: 'Again', workspace: '/work' }), sent)
  assert.equal(reducePrototype(sent, { type: 'approve' }), sent)

  const allowed = reducePrototype(sent, { type: 'allow' })
  assert.equal(allowed.phase, 'idle')
  assert.equal(allowed.turns.length, 1)
  assert.equal(allowed.turns[0].decision, 'allow')
  assert.deepEqual(allowed.turns[0].after.map((event) => event.type), [
    'permission.decided', 'tool.started', 'tool.finished', 'message', 'message',
  ])
  const decision = allowed.turns[0].after[0]
  assert.equal(decision.decision, 'allow')
  assert.equal('reason' in decision, false)
  assert.equal(decision.workspace, '/work')
  assert.deepEqual(decision.arguments, write.arguments)
  assert.equal(decision.callId, 'write-hello')
  assert.equal(allowed.turns[0].after[2].result, 'File written.')
  assert.equal(allowed.turns[0].after.at(-1).message.content, 'Wrote hello.txt.')
  for (const event of [...allowed.turns[0].before, ...allowed.turns[0].after]) assert.equal(event.simulated, true)
  assert.equal(reducePrototype(allowed, { type: 'allow' }), allowed)
  assert.equal(reducePrototype(allowed, { type: 'deny' }), allowed)

  const denied = reducePrototype(sent, { type: 'deny' })
  assert.equal(denied.turns[0].decision, 'deny')
  assert.equal(denied.turns[0].after.some((event) => event.type === 'tool.started' || event.type === 'tool.finished'), false)
  assert.equal(denied.turns[0].after[0].decision, 'deny')
  assert.equal(denied.turns[0].after[0].reason, 'denied')
  assert.deepEqual(denied.turns[0].after[0].arguments, write.arguments)
  assert.equal(denied.turns[0].after[1].message.content, 'Error: denied')
  assert.equal(reducePrototype(denied, { type: 'allow' }), denied)

  const again = reducePrototype(allowed, { type: 'send', prompt: 'Once more', workspace: '/work' })
  assert.equal(again.phase, 'awaiting')
  assert.equal(again.turns.length, 2)
  assert.equal(again.turns[0].decision, 'allow')
  assert.equal(again.turns[1].decision, null)

  const html = prototypePage(renderPage(project([])), '/work')
  const open = html.lastIndexOf('<script>')
  const head = html.slice(open + '<script>'.length, html.indexOf('// prototype-workspace', open))
  const shipped = new Function(`${head}; return { reducePrototype, scriptedWrite };`)()
  const fromPage = shipped.reducePrototype(idle(), { type: 'send', prompt: 'Write hello.txt', workspace: '/work' })
  assert.deepEqual(fromPage, sent)
  assert.deepEqual(shipped.reducePrototype(fromPage, { type: 'deny' }), denied)
})

test('the prototype page sits beside the ledger and does not add a control route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-proto-'))
  const sessionPath = join(dir, 'session.jsonl')
  const original = await readFile(fixture)
  await writeFile(sessionPath, original)
  const app = await boot({
    workspace: dir,
    session: sessionPath,
    writable: false,
    composition: viewerComposition,
    view: { port: 0, refreshMs: 0 },
  })
  try {
    const url = app.ctx.viewer.url
    const home = await request(`${url}/`)
    const page = await request(`${url}/prototype`)
    const posted = await request(`${url}/prototype`, { method: 'POST' })
    assert.equal(home.status, 200)
    assert.equal(home.body.includes('<form'), false)
    assert.equal(home.body.includes('<textarea'), false)
    assert.equal(home.body.includes('id="prompt"'), false)
    assert.equal(home.body.includes('Allow once'), false)
    assert.equal(home.body.includes('Approve'), false)
    assert.match(home.body, /href="\/prototype"/)
    assert.equal(page.status, 200)
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
    assert.match(page.body, /Simulated prototype/)
    assert.match(page.body, /id="prompt"/)
    assert.match(page.body, />Send</)
    assert.match(page.body, /Allow once/)
    assert.match(page.body, /'Deny'/)
    assert.match(page.body, /Read, glob, grep, and skill are allowed/)
    assert.match(page.body, /Scripted call:/)
    assert.match(page.body, /write-hello/)
    assert.match(page.body, /hello\.txt/)
    assert.match(page.body, /Turn 1 · Write hello\.txt/)
    assert.match(page.body, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(page.body, /prototype-snapshot/)
    assert.equal(page.body.includes('new EventSource'), false)
    assert.equal(page.body.includes('<form'), false)
    assert.equal(page.body.includes('innerHTML'), false)
    assert.equal(page.body.includes('sk-'), false)
    assert.equal(page.body.includes('DEEPSEEK'), false)
    assert.equal(page.body.includes('Authorization'), false)
    assert.equal(posted.status, 405)
    assert.equal(posted.headers.allow, 'GET')
    assert.equal(await readFile(sessionPath, 'utf8'), original.toString())
    await assert.rejects(access(join(dir, 'hello.txt')))
    await assert.rejects(access(`${sessionPath}.lock`))
    const html = renderPage(project([]))
    assert.equal(html.includes('id="prompt"'), false)
  } finally {
    await app.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
