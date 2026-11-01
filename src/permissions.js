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

  describe(toolNames) {
    const allowed = [], asked = [], denied = []
    const installed = toolNames ? new Set(toolNames) : undefined
    for (const [name, entry] of this.policies) {
      if (installed && !installed.has(name)) continue
      if (entry.decision === 'allow') allowed.push(name)
      if (entry.decision === 'ask') asked.push(name)
      if (entry.decision === 'deny') denied.push(name)
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
    const policy = this.policies.get(call.name)?.decision
    if (policy === 'allow') return { ...detail, decision: 'allow' }
    if (policy === 'deny') return { ...detail, decision: 'deny', reason: 'denied by policy' }
    if (policy !== 'ask') return { ...detail, decision: 'deny', reason: 'unknown tool' }
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
  apply(ctx) {
    for (const name of ['read', 'glob', 'grep', 'skill']) {
      ctx.effect(() => ctx.permissions.register(name, 'allow'))
    }
    for (const name of ['write', 'edit', 'shell']) {
      ctx.effect(() => ctx.permissions.register(name, 'ask'))
    }
  },
}
