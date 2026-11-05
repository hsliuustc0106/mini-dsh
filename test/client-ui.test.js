import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { boot } from '../src/boot.js'
import { ClientHost, classifyClientPackage, loadClientProfile } from '../src/client-plugins.js'
import { fakeProvider } from '../src/provider.js'
import { CLIENT_COMPATIBILITY } from '../src/ui-slots.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const example = join(root, 'examples/plugins/header-action.mjs')
const exampleConfig = join(root, 'examples/plugins/config.json')

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-client-ui-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function texts(slot) {
  const out = []
  const walk = (node) => {
    if (!node) return
    if (node.type === 'text') out.push(node.text)
    for (const child of node.children ?? []) walk(child)
  }
  for (const item of slot?.nodes ?? []) walk(item.node)
  return out
}

async function host() {
  const client = new ClientHost()
  await client.start()
  return client
}

test('client compatibility reports the supported slot contract and the fail-closed list', () => {
  assert.deepEqual(CLIENT_COMPATIBILITY.slots.kinds, ['list', 'single'])
  assert.deepEqual(CLIENT_COMPATIBILITY.slots.declared.map((row) => row.name), [
    'conversation.session.header.actions',
    'conversation.input.dock',
    'conversation.input.activity',
  ])
  assert.match(CLIENT_COMPATIBILITY.lifecycle.join('\n'), /ctx\.slots\.inject/)
  const unsupported = CLIENT_COMPATIBILITY.unsupported.join('\n')
  for (const phrase of ['ModuleLoader', 'desktop shell', 'chain', 'keyed', 'inject.hooks', 'sessions', 'JSONL']) {
    assert.match(unsupported, new RegExp(phrase))
  }
})

test('a desktop client bundle is classified unsupported and is not executed', async (t) => {
  const manifest = {
    name: '@mixian/dsh-desktop-plugin',
    version: '0.1.3',
    dsh: {
      client: {
        platform: 'web',
        inject: [
          '@deepseek-ai/dsh-client-runtime',
          '@deepseek-ai/dsh-client-ui-slots',
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-conversation',
        ],
      },
    },
  }
  const source = 'window.__ModuleLoader__.load({ id: "@mixian/dsh-desktop-plugin", factory() { globalThis.__desktopRan = true } })\n'
  const classified = classifyClientPackage(manifest, source)
  assert.equal(classified.supported, false)
  assert.match(classified.reasons.join('\n'), /dsh-client-runtime/)
  assert.match(classified.reasons.join('\n'), /ModuleLoader/)
  const dir = await directory(t)
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(dir, 'client.js'), source)
  const client = await host()
  t.after(() => client.dispose())
  const report = await client.mount({ name: 'desktop', module: join(dir, 'client.js') })
  assert.equal(report.state, 'failed')
  assert.match(report.error, /dsh-client-runtime/)
  assert.match(report.error, /ModuleLoader/)
  assert.equal(globalThis.__desktopRan, undefined)
  assert.deepEqual(texts(client.view().slots['conversation.session.header.actions']), [])
})

test('an unmodified header action renders, disposes, and comes back on reload', async (t) => {
  const client = await host()
  t.after(() => client.dispose())
  const other = await host()
  t.after(() => other.dispose())
  const mounted = await client.mount({ name: 'header-action', module: example })
  await other.mount({ name: 'header-action', module: example })
  assert.equal(mounted.state, 'active')
  const slot = () => client.view().slots['conversation.session.header.actions']
  assert.deepEqual(texts(slot()), ['Review'])
  assert.equal(slot().nodes[0].node.type, 'button')
  assert.equal(slot().nodes[0].id, 'review')
  await client.unmount('header-action')
  assert.deepEqual(texts(slot()), [])
  assert.deepEqual(texts(other.view().slots['conversation.session.header.actions']), ['Review'])
  const again = await client.mount({ name: 'header-action', module: example })
  assert.equal(again.state, 'active')
  assert.deepEqual(texts(slot()), ['Review'])
  assert.equal(slot().nodes.length, 1)
  const reloaded = await client.reload('header-action')
  assert.equal(reloaded.state, 'active')
  assert.deepEqual(texts(slot()), ['Review'])
  assert.equal(globalThis.slots, undefined)
})

test('declaration collapse waits and reruns inject without leaving a disposed contribution', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'lifecycle.mjs'), `
    let runs = 0
    export function runsSeen() { return runs }
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.session.header.actions', () => {
        runs += 1
        return ctx.slots.register({
          name: 'conversation.session.header.actions', id: 'review', order: 100,
        }, () => 'Review ' + runs)
      })
    }
  `)
  const client = await host()
  t.after(() => client.dispose())
  client.shell.collapse('conversation.session.header.actions')
  const mounted = await client.mount({ name: 'lifecycle', module: join(dir, 'lifecycle.mjs') })
  assert.equal(mounted.state, 'active')
  const slot = () => client.view().slots['conversation.session.header.actions']
  assert.equal(slot().declared, false)
  assert.deepEqual(texts(slot()), [])
  client.shell.declare('conversation.session.header.actions')
  assert.deepEqual(texts(slot()), ['Review 1'])
  client.shell.collapse('conversation.session.header.actions')
  assert.deepEqual(texts(slot()), [])
  client.shell.declare('conversation.session.header.actions')
  assert.deepEqual(texts(slot()), ['Review 2'])
  const reloaded = await client.reload('lifecycle')
  assert.equal(reloaded.state, 'active')
  assert.deepEqual(texts(slot()), ['Review 3'])
  assert.equal(slot().nodes.length, 1)
  await client.unmount('lifecycle')
  assert.deepEqual(texts(slot()), [])
})

test('list order, priority shadowing, single slots, and generator rollback fail closed', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'first.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'first', order: 10,
      }, () => 'First'))
    }
  `)
  await writeFile(join(dir, 'shadow.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.session.header.actions', function* () {
        yield ctx.slots.register({
          name: 'conversation.session.header.actions', id: 'review', priority: 10, order: 100,
        }, () => 'Shadow')
        yield ctx.slots.register({
          name: 'conversation.session.header.actions', id: 'review', priority: 0, order: 100,
        }, () => 'Winner')
      })
    }
  `)
  await writeFile(join(dir, 'clash.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'review', priority: 0, order: 100,
      }, () => 'Clash'))
    }
  `)
  await writeFile(join(dir, 'rollback.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', function* () {
        yield ctx.slots.register({ name: 'conversation.input.dock', id: 'same', order: 1 }, () => 'Kept')
        yield ctx.slots.register({ name: 'conversation.input.dock', id: 'same', order: 2 }, () => 'Duplicate')
      })
    }
  `)
  await writeFile(join(dir, 'single.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.input.activity', function* () {
        yield ctx.slots.register({ name: 'conversation.input.activity', priority: 5 }, () => 'Later')
        yield ctx.slots.register({ name: 'conversation.input.activity', priority: 1 }, () => 'Sooner')
      })
    }
  `)
  const client = await host()
  t.after(() => client.dispose())
  await client.mount({ name: 'shadow', module: join(dir, 'shadow.mjs') })
  await client.mount({ name: 'first', module: join(dir, 'first.mjs') })
  const slot = () => client.view().slots['conversation.session.header.actions']
  assert.deepEqual(texts(slot()), ['First', 'Winner'])
  const clash = await client.mount({ name: 'clash', module: join(dir, 'clash.mjs') })
  assert.equal(clash.state, 'failed')
  assert.match(clash.error, /already has an entry/)
  assert.deepEqual(texts(slot()), ['First', 'Winner'])
  await client.unmount('shadow')
  assert.deepEqual(texts(slot()), ['First'])

  const rolled = await client.mount({ name: 'rollback', module: join(dir, 'rollback.mjs') })
  assert.equal(rolled.state, 'failed')
  assert.deepEqual(texts(client.view().slots['conversation.input.dock']), [])

  const single = await client.mount({ name: 'single', module: join(dir, 'single.mjs') })
  assert.equal(single.state, 'active')
  const activity = client.view().slots['conversation.input.activity']
  assert.deepEqual(texts(activity), ['Sooner'])
  assert.equal(activity.nodes.length, 1)
})

test('unsupported dependencies, slots, and element props are reported without dropping siblings', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'needs-sessions.mjs'), `export const inject = ['slots', 'sessions']\nexport function apply() {}\n`)
  await writeFile(join(dir, 'missing-inject.mjs'), `export function apply() {}\n`)
  await writeFile(join(dir, 'bad-slot.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.view', () => {})
    }
  `)
  await writeFile(join(dir, 'locale.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'locale', locale: 'desktop',
      }, () => 'Locale'))
    }
  `)
  await writeFile(join(dir, 'hooks.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'hooks',
        inject: () => ({ hooks: {} }),
      }, () => 'Hooks'))
    }
  `)
  await writeFile(join(dir, 'click.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      if (ctx.get('tools') || ctx.get('agent') || ctx.get('session')) throw new Error('host service leaked')
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'click', order: 50,
      }, () => ({ type: 'button', props: { onClick() {}, children: 'Click' } })))
    }
  `)
  await writeFile(join(dir, 'ok.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'ok', order: 1,
      }, () => 'Ok'))
    }
  `)
  const client = await host()
  t.after(() => client.dispose())
  for (const [name, file, pattern] of [
    ['needs-sessions', 'needs-sessions.mjs', /sessions/],
    ['missing-inject', 'missing-inject.mjs', /must declare inject/],
    ['bad-slot', 'bad-slot.mjs', /conversation\.view/],
    ['locale', 'locale.mjs', /register\.locale/],
  ]) {
    const report = await client.mount({ name, module: join(dir, file) })
    assert.equal(report.state, 'failed', name)
    assert.match(report.error, pattern)
  }
  await client.mount({ name: 'ok', module: join(dir, 'ok.mjs') })
  await client.mount({ name: 'click', module: join(dir, 'click.mjs') })
  await client.mount({ name: 'hooks', module: join(dir, 'hooks.mjs') })
  const header = client.view().slots['conversation.session.header.actions']
  assert.deepEqual(texts(header), ['Ok'])
  assert.match(header.errors.map((item) => item.error).join('\n'), /onClick/)
  const dock = client.view().slots['conversation.input.dock']
  assert.deepEqual(texts(dock), [])
  assert.match(dock.errors.map((item) => item.error).join('\n'), /inject\.hooks/)
  assert.equal(client.view().plugins.find((plugin) => plugin.name === 'ok').state, 'active')
  assert.equal(client.view().plugins.find((plugin) => plugin.name === 'needs-sessions').state, 'failed')
})

test('the web page renders the unmodified plugin and a reload drops it without writing the session', async (t) => {
  const dir = await directory(t)
  const app = await boot({
    workspace: dir,
    pluginConfig: exampleConfig,
    web: { port: 0 },
    provider: fakeProvider([]),
  })
  t.after(() => app.dispose())
  assert.equal(app.ctx.get('slots'), undefined)
  assert.equal(app.ctx.tools.items.has('greet'), true)
  const url = app.ctx.webControl.url
  const denied = await fetch(`${url}/client-ui`, { headers: { origin: 'http://attacker.example' } })
  assert.equal(denied.status, 403)
  const page = await fetch(url)
  assert.match(await page.text(), /id="client-slots"/)
  const first = await fetch(`${url}/client-ui`, { headers: { origin: url } })
  const body = await first.json()
  assert.equal(first.status, 200)
  assert.match(body.compatibility.unsupported.join('\n'), /JSONL/)
  assert.deepEqual(texts(body.slots['conversation.session.header.actions']), ['Review'])
  const second = await (await fetch(`${url}/client-ui`, { headers: { origin: url } })).json()
  assert.deepEqual(texts(second.slots['conversation.session.header.actions']), ['Review'])
  assert.equal(JSON.stringify(app.ctx.session.events).includes('Review'), false)
  await app.ctx.webControl.client.unmount('header-action')
  const cleared = await (await fetch(`${url}/client-ui`, { headers: { origin: url } })).json()
  assert.deepEqual(texts(cleared.slots['conversation.session.header.actions']), [])
  assert.equal(app.ctx.tools.items.has('greet'), true)
  const restored = await app.ctx.webControl.client.mount({ name: 'header-action', module: example })
  assert.equal(restored.state, 'active')
  const again = await (await fetch(`${url}/client-ui`, { headers: { origin: url } })).json()
  assert.deepEqual(texts(again.slots['conversation.session.header.actions']), ['Review'])
  assert.equal(JSON.stringify(app.ctx.session.events).includes('Review'), false)
})

test('client.json resolves beside the profile, and a bad profile fails closed', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [] }))
  await writeFile(join(dir, 'local.mjs'), `
    export const inject = ['slots']
    export function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'local', order: 1,
      }, () => 'Local'))
    }
  `)
  await writeFile(join(dir, 'client.json'), JSON.stringify({
    plugins: [
      { name: 'local', module: './local.mjs' },
      { name: 'skipped', module: './missing.mjs', enabled: false },
    ],
  }))
  const listed = await loadClientProfile({ pluginConfig: join(dir, 'plugins.json'), workspace: dir })
  assert.equal(listed[0].module, join(dir, 'local.mjs'))
  const quiet = await boot({ workspace: dir, pluginConfig: join(dir, 'plugins.json'), provider: fakeProvider([]) })
  await quiet.dispose()
  const app = await boot({
    workspace: dir,
    pluginConfig: join(dir, 'plugins.json'),
    web: { port: 0 },
    provider: fakeProvider([]),
  })
  try {
    const body = await (await fetch(`${app.ctx.webControl.url}/client-ui`, { headers: { origin: app.ctx.webControl.url } })).json()
    assert.deepEqual(texts(body.slots['conversation.input.dock']), ['Local'])
    assert.equal(body.plugins.find((plugin) => plugin.name === 'skipped').state, 'disabled')
    assert.equal(app.ctx.get('slots'), undefined)
  } finally { await app.dispose() }

  await writeFile(join(dir, 'client.json'), '{')
  await assert.rejects(
    boot({ workspace: dir, pluginConfig: join(dir, 'plugins.json'), web: { port: 0 }, provider: fakeProvider([]) }),
    /not valid JSON/,
  )
  await writeFile(join(dir, 'client.json'), JSON.stringify({ plugins: [{ name: 'local', module: './local.mjs', config: { a: 1 } }] }))
  await assert.rejects(
    boot({ workspace: dir, pluginConfig: join(dir, 'plugins.json'), web: { port: 0 }, provider: fakeProvider([]) }),
    /config/,
  )
})

test('a host plugin that injects slots fails closed and does not start the client boundary', async (t) => {
  const dir = await directory(t)
  await writeFile(join(dir, 'ui-host.mjs'), `export const inject = ['slots']\nexport function apply() {}\n`)
  await writeFile(join(dir, 'plugins.json'), JSON.stringify({ plugins: [{ name: 'ui-host', module: './ui-host.mjs' }] }))
  await assert.rejects(
    boot({ workspace: dir, pluginConfig: join(dir, 'plugins.json'), provider: fakeProvider([]) }),
    /slots/,
  )
})

test('the browser script paints a slot contribution and removes it when the projection is empty', async () => {
  class Element {
    constructor(tag) {
      this.tag = tag
      this.children = []
      this.listeners = new Map()
      this.attributes = {}
      this.hidden = false
      this.value = ''
      this.disabled = false
      this._text = ''
    }
    get textContent() { return this._text + this.children.map((child) => child.textContent ?? '').join('') }
    set textContent(value) { this._text = String(value ?? ''); this.children = [] }
    append(...children) { this.children.push(...children) }
    replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children) }
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    setAttribute(name, value) { this.attributes[name] = String(value) }
  }
  const ids = ['chat', 'trajectory', 'events', 'timeline', 'prompt', 'send', 'notice', 'hint', 'workspace', 'chat-tab', 'trajectory-tab', 'plugins-panel', 'plugins-toggle', 'plugins-form', 'plugin-spec', 'plugin-install', 'plugin-result', 'plugin-list', 'client-slots', 'client-dock', 'client-activity']
  const elements = Object.fromEntries(ids.map((id) => [id, new Element(id)]))
  elements.trajectory.hidden = true
  elements['client-slots'].hidden = true
  const document = {
    getElementById: (id) => elements[id],
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ textContent: text }),
  }
  let source
  class EventSource {
    constructor() { source = this; this.listeners = new Map() }
    addEventListener(type, listener) { this.listeners.set(type, listener) }
    emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }) }
  }
  const payload = {
    slots: {
      'conversation.session.header.actions': {
        nodes: [{ id: 'review', node: { type: 'button', props: { type: 'button' }, children: [{ type: 'text', text: '<b>Review</b>' }] } }],
        errors: [],
      },
      'conversation.input.dock': { nodes: [], errors: [] },
      'conversation.input.activity': { nodes: [], errors: [] },
    },
  }
  const script = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8')
  runInNewContext(script, {
    document,
    EventSource,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback,
    fetch: async (url) => {
      if (url === '/client-ui') return { ok: true, json: async () => payload }
      if (url === '/plugins') return { ok: true, json: async () => ({ plugins: [] }) }
      if (url === '/trajectory') return { ok: true, json: async () => ({ cursor: 0, overview: [] }) }
      throw new Error(`unexpected fetch ${url}`)
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const slot = elements['client-slots']
  assert.equal(slot.hidden, false)
  assert.equal(slot.textContent, '<b>Review</b>')
  assert.equal(slot.children[0].tag, 'button')
  assert.equal(slot.children[0].type, 'button')
  assert.equal(slot.children.some((child) => child.tag === 'img' || child.tag === 'b'), false)
  source.emit('client-ui', {
    slots: {
      'conversation.session.header.actions': { nodes: [], errors: [] },
      'conversation.input.dock': { nodes: [], errors: [] },
      'conversation.input.activity': { nodes: [], errors: [] },
    },
  })
  assert.equal(slot.hidden, true)
  assert.equal(slot.textContent, '')
})
