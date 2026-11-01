import { Service } from '@deepseek-ai/cordis'

const systemPrompt = 'You are a coding assistant. Inspect relevant files, make focused changes, and run suitable checks. Use tools when needed. Explain results and failures honestly.'

export class Prompt extends Service {
  constructor(ctx) {
    super(ctx, 'prompt')
    this.parts = []
    this.seq = 0
  }

  contribute(part) {
    if (!part || (typeof part.instructions !== 'string' && typeof part.context !== 'function')) {
      throw new Error('Prompt contribution needs instructions or context')
    }
    const entry = { order: part.order ?? 0, seq: this.seq++, instructions: part.instructions, context: part.context }
    this.parts.push(entry)
    return () => {
      const index = this.parts.indexOf(entry)
      if (index >= 0) this.parts.splice(index, 1)
    }
  }

  snapshot() {
    const ordered = [...this.parts].sort((a, b) => a.order - b.order || a.seq - b.seq)
    return {
      instructions: ordered.filter((part) => typeof part.instructions === 'string').map((part) => part.instructions),
      context: ordered.filter((part) => typeof part.context === 'function').map((part) => part.context()),
    }
  }
}

export const instructions = {
  inject: ['prompt'],
  apply(ctx) {
    ctx.effect(() => ctx.prompt.contribute({ order: 0, instructions: systemPrompt }))
  },
}

// Context describes the workspace and the permission policy. It does not enforce them.
export const runtimeContext = {
  inject: ['prompt', 'workspace'],
  apply(ctx) {
    ctx.effect(() => ctx.prompt.contribute({
      order: 0,
      context: () => ({
        workspace: ctx.workspace.root,
        permissions: 'read, glob, and grep are allowed; each write, edit, and shell call requires approval; unknown tools are denied',
        sandbox: false,
      }),
    }))
  },
}
