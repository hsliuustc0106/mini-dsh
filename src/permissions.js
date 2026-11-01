import { Service } from '@deepseek-ai/cordis'

// Allow read-only tools. Ask for each exact write, edit, or shell call. Deny anything else.
// Only `true` is a grant. Approval is not a sandbox: an allowed command still
// runs with the user's OS permissions, and the workspace is only its cwd.

const ASKED = new Set(['write', 'edit', 'shell'])
const ALLOWED = new Set(['read', 'glob', 'grep'])

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
  }

  async decide(call, signal, ask = this.ask) {
    const detail = {
      callId: call.callId,
      name: call.name,
      arguments: structuredClone(call.arguments ?? null),
      workspace: this.ctx.workspace.root,
    }
    if (ALLOWED.has(call.name)) return { ...detail, decision: 'allow' }
    if (!ASKED.has(call.name)) return { ...detail, decision: 'deny', reason: 'unknown tool' }
    const answer = await answerFor(ask, structuredClone(detail), signal)
    if (signal?.aborted || answer !== true) {
      const reason = answer === false && !signal?.aborted ? 'denied' : 'approval unavailable'
      return { ...detail, decision: 'deny', reason }
    }
    return { ...detail, decision: 'allow' }
  }
}
