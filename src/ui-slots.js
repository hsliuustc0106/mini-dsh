import { Service } from '@deepseek-ai/cordis'

// Shell-owned slots. Client plugins cannot declare slots; they contribute
// with ctx.slots.inject / ctx.slots.register. `kind` is the runtime field
// (the slot guide's cardinality).
export const CLIENT_SLOT_CATALOG = Object.freeze([
  Object.freeze({ name: 'conversation.session.header.actions', kind: 'list', scope: 'root', surface: 'header' }),
  Object.freeze({ name: 'conversation.input.dock', kind: 'list', scope: 'root', surface: 'composer' }),
  Object.freeze({ name: 'conversation.input.activity', kind: 'single', scope: 'root', surface: 'composer' }),
])

export const SUPPORTED_REGISTER_KEYS = Object.freeze(['name', 'id', 'order', 'priority', 'inject'])
export const SUPPORTED_CLIENT_SERVICE = 'slots'
export const SUPPORTED_CLIENT_PACKAGE = '@deepseek-ai/dsh-client-ui-slots'
const SUPPORTED_TAGS = new Set(['button', 'span', 'div', 'p'])
const SUPPORTED_PROPS = new Set(['children', 'className', 'type', 'aria-label', 'title', 'disabled'])
const MAX_DEPTH = 8
const MAX_NODES = 40
const MAX_TEXT = 1000

export const hostDeclare = Symbol('mini-dsh.hostDeclareSlot')

export const CLIENT_COMPATIBILITY = Object.freeze({
  lifecycle: Object.freeze([
    'Client plugins mount in a Cordis context owned by the web UI. The host agent context does not provide slots.',
    'inject may list only slots. Any other service fails closed before the plugin starts.',
    'ctx.slots.inject(name, callback) runs while that shell declaration is live, disposes when it collapses, and runs again on the next declaration.',
    'The inject controller is an effect on the caller fiber. Unmounting the plugin cancels a wait or its registrations.',
    'The callback returns one synchronous disposer, or an iterable of disposers (a generator may yield several). A throw rolls earlier disposers back.',
    'ctx.slots.register into an undeclared slot throws. The returned disposer removes that entry only.',
  ]),
  slots: Object.freeze({
    declared: CLIENT_SLOT_CATALOG,
    kinds: Object.freeze(['list', 'single']),
    scopes: Object.freeze(['root']),
    registerKeys: SUPPORTED_REGISTER_KEYS,
    componentReturns: Object.freeze(['string', 'null', 'plain element { type, props }', 'array of those']),
    elementTags: Object.freeze([...SUPPORTED_TAGS]),
    elementProps: Object.freeze([...SUPPORTED_PROPS]),
  }),
  unsupported: Object.freeze([
    'Native desktop shell (tray, pet, screen capture, OS notifications, __DSH_DESKTOP_BRIDGE__)',
    'Browser ModuleLoader bundles (window.__ModuleLoader__.load)',
    'DSH client runtime services other than slots (sessions, workspaces, locale, conversationViews, settings)',
    'dsh.client.inject packages other than @deepseek-ai/dsh-client-ui-slots',
    'Slot kinds chain and keyed, and scopes session and session-maybe',
    'Client-owned declarations, children, renderSlot, renderSlotChain, and factories',
    'Stores, locale namespaces, slot-level inject faces, and inject.hooks',
    'React hooks and function-typed elements',
    'Event-handler props (onClick and any other function on an element)',
    'root and any slot outside the shell catalog',
    'Mounting a client plugin in the host agent context',
    'Web Plugins panel management of client plugins',
    'Writing slot output to the JSONL session log',
  ]),
})

const catalog = new Map(CLIENT_SLOT_CATALOG.map((row) => [row.name, row]))

export function unsupportedClient(feature) {
  const error = new Error(`Unsupported client slot feature: ${feature}`)
  error.code = 'UNSUPPORTED_CLIENT'
  return error
}

function rollback(disposers) {
  for (const dispose of disposers.splice(0).reverse()) {
    try { dispose() }
    catch { /* the original failure is the one that surfaces */ }
  }
}

function collectDisposers(result) {
  const disposers = []
  const take = (value) => {
    if (typeof value !== 'function') throw new Error('Slot inject callback must return a synchronous disposer')
    disposers.push(value)
  }
  try {
    if (typeof result === 'function') {
      take(result)
      return disposers
    }
    if (result != null && typeof result === 'object' && Symbol.iterator in result) {
      for (const item of result) take(item)
      return disposers
    }
    throw unsupportedClient('inject callback result (expected a synchronous disposer or iterable of disposers)')
  } catch (error) {
    rollback(disposers)
    throw error
  }
}

function projectNode(value, depth, budget) {
  if (value == null || value === false) return null
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) throw unsupportedClient('element text length')
    budget.count += 1
    if (budget.count > MAX_NODES) throw unsupportedClient('element node count')
    return { type: 'text', text: value }
  }
  if (typeof value === 'number' || typeof value === 'boolean') throw unsupportedClient('component return')
  if (Array.isArray(value)) {
    if (depth > MAX_DEPTH) throw unsupportedClient('element depth')
    const children = value.map((item) => projectNode(item, depth + 1, budget)).filter(Boolean)
    return children.length ? { type: 'fragment', children } : null
  }
  if (typeof value !== 'object') throw unsupportedClient('component return')
  if (depth > MAX_DEPTH) throw unsupportedClient('element depth')
  const type = value.type
  if (value.$$typeof != null && typeof type !== 'string') throw unsupportedClient('React component element')
  if (typeof type !== 'string' || !SUPPORTED_TAGS.has(type)) throw unsupportedClient(`element <${String(type)}>`)
  const props = value.props ?? {}
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw unsupportedClient('element props')
  budget.count += 1
  if (budget.count > MAX_NODES) throw unsupportedClient('element node count')
  const out = { type, props: {} }
  for (const [key, prop] of Object.entries(props)) {
    if (key === 'children') continue
    if (!SUPPORTED_PROPS.has(key)) throw unsupportedClient(`element prop ${key}`)
    if (typeof prop === 'function') throw unsupportedClient(`element prop ${key}`)
    if (key === 'disabled') {
      if (typeof prop !== 'boolean') throw unsupportedClient('element prop disabled')
      out.props.disabled = prop
      continue
    }
    if (typeof prop !== 'string') throw unsupportedClient(`element prop ${key}`)
    if (prop.length > MAX_TEXT) throw unsupportedClient(`element prop ${key}`)
    if (key === 'className' && !/^[A-Za-z0-9 _-]*$/.test(prop)) throw unsupportedClient('element prop className')
    if (key === 'type' && prop !== 'button') throw unsupportedClient('element prop type')
    out.props[key] = prop
  }
  if (props.children != null) {
    const children = projectNode(props.children, depth + 1, budget)
    if (children) out.children = children.type === 'fragment' ? children.children : [children]
  }
  return out
}

function injectedProps(entry) {
  if (!entry.inject) return {}
  const extra = entry.inject()
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw unsupportedClient('inject result')
  if (Object.hasOwn(extra, 'hooks')) throw unsupportedClient('inject.hooks')
  for (const [key, value] of Object.entries(extra)) {
    if (value == null || ['string', 'number', 'boolean', 'function'].includes(typeof value)) continue
    throw unsupportedClient(`inject.${key}`)
  }
  return extra
}

function renderEntry(entry) {
  const node = entry.component({ ...injectedProps(entry) })
  return projectNode(node, 0, { count: 0 })
}

function groupsOf(rec) {
  const sorted = [...rec.entries].sort((a, b) => a.priority - b.priority || a.seq - b.seq)
  if (rec.spec.kind === 'single') return sorted.length ? [sorted] : []
  const groups = new Map()
  for (const entry of sorted) {
    if (!groups.has(entry.id)) groups.set(entry.id, [])
    groups.get(entry.id).push(entry)
  }
  return [...groups.values()].sort((a, b) => a[0].order - b[0].order || a[0].seq - b[0].seq)
}

export function declareShellSlots(slots) {
  const releases = new Map()
  for (const row of CLIENT_SLOT_CATALOG) releases.set(row.name, slots[hostDeclare](row.name))
  return {
    collapse(name) {
      const release = releases.get(name)
      if (!release) throw new Error(`Shell slot is not declared: ${name}`)
      release()
      releases.delete(name)
    },
    declare(name) {
      if (!catalog.has(name)) throw unsupportedClient(`slot ${name}`)
      if (releases.has(name)) throw new Error(`slot "${name}" is already declared`)
      releases.set(name, slots[hostDeclare](name))
    },
    dispose() {
      for (const release of [...releases.values()].reverse()) release()
      releases.clear()
    },
  }
}

// React-free slot registry for the web UI's client context. Registrations are
// caller-fiber effects. The host agent context never provides this service.
export class Slots extends Service {
  constructor(ctx) {
    super(ctx, 'slots')
    this.owner = ctx.fiber
    this.records = new Map()
    this.listeners = new Set()
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('Slot listener must be a function')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify() {
    for (const listener of [...this.listeners]) {
      try { listener() }
      catch { /* a projection listener cannot roll back a registration */ }
    }
  }

  record(name) {
    let rec = this.records.get(name)
    if (!rec) {
      rec = { name, spec: undefined, epoch: 0, entries: [], seq: 0, declarationListeners: new Set() }
      this.records.set(name, rec)
    }
    return rec
  }

  [hostDeclare](name) {
    const known = catalog.get(name)
    if (!known) throw unsupportedClient(`slot ${name}`)
    const rec = this.record(name)
    if (rec.spec) throw new Error(`slot "${name}" is already declared`)
    rec.spec = { kind: known.kind, scope: known.scope }
    rec.epoch += 1
    const epoch = rec.epoch
    this.notify()
    for (const listener of [...rec.declarationListeners]) listener()
    return () => {
      if (!rec.spec || rec.epoch !== epoch) return
      rec.spec = undefined
      rec.epoch += 1
      for (const listener of [...rec.declarationListeners]) listener()
      rec.entries = []
      this.notify()
    }
  }

  inject(name, callback) {
    if (typeof name !== 'string' || !name) throw new Error('Slot name is required')
    if (typeof callback !== 'function') throw new Error('Slot inject callback must be a function')
    if (!catalog.has(name)) throw unsupportedClient(`slot ${name}`)
    const caller = this.ctx
    return caller.effect(() => {
      const rec = this.record(name)
      let disposed = false
      let stop = () => {}
      const onDeclaration = () => {
        stop()
        stop = () => {}
        if (disposed || !rec.spec) return
        const epoch = rec.epoch
        let disposers = []
        try {
          disposers = collectDisposers(callback())
        } catch (error) {
          disposed = true
          rec.declarationListeners.delete(onDeclaration)
          throw error
        }
        if (rec.epoch !== epoch || !rec.spec) {
          rollback(disposers)
          return
        }
        stop = () => {
          stop = () => {}
          rollback(disposers)
        }
      }
      rec.declarationListeners.add(onDeclaration)
      if (rec.spec) onDeclaration()
      return () => {
        disposed = true
        rec.declarationListeners.delete(onDeclaration)
        stop()
      }
    }, `slots.inject(${name})`)
  }

  register(options, component) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Slot registration needs an options object')
    for (const key of Object.keys(options)) {
      if (!SUPPORTED_REGISTER_KEYS.includes(key)) throw unsupportedClient(`register.${key}`)
    }
    if (typeof options.name !== 'string' || !options.name) throw new Error('Slot registration needs a name')
    if (!catalog.has(options.name)) throw unsupportedClient(`slot ${options.name}`)
    const rec = this.records.get(options.name)
    if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared`)
    if (typeof component !== 'function') throw new Error('Slot component must be a function')
    const priority = options.priority ?? 0
    const order = options.order ?? 0
    if (typeof priority !== 'number' || !Number.isFinite(priority)) throw new Error('Slot priority must be a finite number')
    if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error('Slot order must be a finite number')
    if (options.inject !== undefined && typeof options.inject !== 'function') throw unsupportedClient('register.inject must be a function')
    if (rec.spec.kind === 'list') {
      if (typeof options.id !== 'string' || !options.id) throw new Error(`list slot "${options.name}" requires options.id`)
      if (rec.entries.some((entry) => entry.id === options.id && entry.priority === priority)) {
        throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}" at priority ${priority}`)
      }
    } else if (rec.spec.kind === 'single') {
      if (options.id !== undefined) throw new Error(`single slot "${options.name}" does not take options.id`)
      if (rec.entries.some((entry) => entry.priority === priority)) {
        throw new Error(`single slot "${options.name}" already has a registration at priority ${priority}`)
      }
    } else {
      throw unsupportedClient(`kind ${rec.spec.kind}`)
    }
    const entry = {
      component,
      id: options.id,
      order,
      priority,
      inject: options.inject,
      seq: rec.seq++,
    }
    rec.entries.push(entry)
    this.notify()
    let removed = false
    return () => {
      if (removed) return
      removed = true
      const index = rec.entries.indexOf(entry)
      if (index >= 0) rec.entries.splice(index, 1)
      this.notify()
    }
  }

  render(name) {
    const known = catalog.get(name)
    if (!known) throw unsupportedClient(`slot ${name}`)
    const rec = this.records.get(name)
    if (!rec?.spec) return { name, declared: false, kind: known.kind, nodes: [], errors: [] }
    const nodes = []
    const errors = []
    for (const group of groupsOf(rec)) {
      for (const entry of group) {
        try {
          const node = renderEntry(entry)
          if (node) nodes.push({ id: entry.id ?? null, order: entry.order, priority: entry.priority, node })
          break
        } catch (error) {
          errors.push({ id: entry.id ?? null, priority: entry.priority, error: error.message })
        }
      }
    }
    return { name, declared: true, kind: rec.spec.kind, nodes, errors }
  }

  projection() {
    return Object.fromEntries(CLIENT_SLOT_CATALOG.map((row) => [row.name, this.render(row.name)]))
  }
}
