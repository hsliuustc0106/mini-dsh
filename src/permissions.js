import { Service } from '@deepseek-ai/cordis'

// Only `true` is a grant. Approval is not a sandbox: an allowed command still
// runs with the user's OS permissions, and the workspace is only its cwd.

function names(items) {
  if (items.length < 2) return items[0] ?? ''
  if (items.length === 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}

function untilAbort(signal) {
  if (!signal) return new Promise(() => {})
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true }))
}

async function answerFor(ask, detail, signal) {
  if (typeof ask !== 'function' || signal?.aborted) return undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => (signal?.aborted ? undefined : ask(detail, signal))),
      untilAbort(signal),
    ])
  } catch {
    return undefined
  }
}

export class Permissions extends Service {
  static inject = ['workspace']
  constructor(ctx, config = {}) {
    super(ctx, 'permissions')
    this.ask = config?.ask
    this.policies = new Map()
    // User-facing overrides sit above plugin and default registrations. A
    // missing policy is still a denial; an overlay never appears on its own.
    this.overlays = new Map()
  }

  // Plugins own their registrations through ctx.effect. A missing policy is
  // denied, so registering a tool alone never grants its execution.
  register(name, decision) {
    if (typeof name !== 'string' || !name) throw new Error('Permission tool name is required')
    if (!['allow', 'ask', 'deny'].includes(decision)) throw new Error(`Invalid permission for ${name}`)
    if (this.policies.has(name)) throw new Error(`Duplicate permission: ${name}`)
    const entry = { decision }
    this.policies.set(name, entry)
    return () => { if (this.policies.get(name) === entry) this.policies.delete(name) }
  }

  // A reversible user override. The caller disposes it with ctx.effect. It does
  // not remove the plugin or default registration underneath.
  overlay(name, decision) {
    if (typeof name !== 'string' || !name) throw new Error('Permission tool name is required')
    if (!['allow', 'ask', 'deny'].includes(decision)) throw new Error(`Invalid permission for ${name}`)
    const stack = this.overlays.get(name) ?? []
    if (!this.overlays.has(name)) this.overlays.set(name, stack)
    const entry = { decision }
    stack.push(entry)
    return () => {
      const current = this.overlays.get(name)
      if (!current) return
      const index = current.lastIndexOf(entry)
      if (index >= 0) current.splice(index, 1)
      if (!current.length) this.overlays.delete(name)
    }
  }

  effective(name) {
    const overlay = this.overlays.get(name)?.at(-1)?.decision
    if (overlay) return { decision: overlay, source: 'overlay' }
    const policy = this.policies.get(name)?.decision
    if (policy) return { decision: policy, source: 'policy' }
    return { decision: 'deny', source: 'default' }
  }

  describe(toolNames) {
    const allowed = [], asked = [], denied = []
    const installed = toolNames ? new Set(toolNames) : undefined
    const known = new Set([...this.policies.keys(), ...this.overlays.keys()])
    for (const name of known) {
      if (installed && !installed.has(name)) continue
      const decision = this.effective(name).decision
      if (decision === 'allow') allowed.push(name)
      if (decision === 'ask') asked.push(name)
      if (decision === 'deny') denied.push(name)
    }
    const parts = []
    if (allowed.length) parts.push(`${names(allowed)} ${allowed.length === 1 ? 'is' : 'are'} allowed`)
    if (asked.length) parts.push(`each ${names(asked)} call requires approval`)
    if (denied.length) parts.push(`${names(denied)} ${denied.length === 1 ? 'is' : 'are'} denied`)
    parts.push('unknown tools are denied')
    return parts.join('; ')
  }

  async decide(call, signal, ask = this.ask) {
    const detail = {
      callId: call.callId,
      name: call.name,
      arguments: structuredClone(call.arguments ?? null),
      workspace: this.ctx.workspace.root,
    }
    const effective = this.effective(call.name)
    const policy = effective.decision
    if (policy === 'allow' && effective.source !== 'default') return { ...detail, decision: 'allow' }
    if (policy === 'deny' && effective.source !== 'default') return { ...detail, decision: 'deny', reason: 'denied by policy' }
    if (effective.source === 'default') return { ...detail, decision: 'deny', reason: 'unknown tool' }
    const answer = await answerFor(ask, structuredClone(detail), signal)
    if (signal?.aborted || answer !== true) {
      const reason = answer === false && !signal?.aborted ? 'denied' : 'approval unavailable'
      return { ...detail, decision: 'deny', reason }
    }
    return { ...detail, decision: 'allow' }
  }
}

export const defaultToolPermissions = {
  inject: ['permissions'],
  apply(ctx, config = {}) {
    const configured = config?.policies ?? {}
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
      throw new Error('default-tool-permissions: policies must be an object')
    }
    const policies = new Map([
      ...['read', 'glob', 'grep', 'skill', 'subagent'].map((name) => [name, 'allow']),
      ...['write', 'edit', 'shell'].map((name) => [name, 'ask']),
    ])
    for (const [name, decision] of Object.entries(configured)) {
      if (!name || !['allow', 'ask', 'deny'].includes(decision)) {
        throw new Error(`default-tool-permissions: invalid policy for ${name}`)
      }
      policies.set(name, decision)
    }
    for (const [name, decision] of policies) {
      ctx.effect(() => ctx.permissions.register(name, decision))
    }
  },
}
