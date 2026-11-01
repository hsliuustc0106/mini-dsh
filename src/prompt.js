import { Service } from '@deepseek-ai/cordis'

const systemPrompt = 'You are a coding assistant. Inspect relevant files, make focused changes, and run suitable checks. Group independent tool calls when useful. Report results and failures concisely and honestly.'

export class Prompt extends Service {
  constructor(ctx) {
    super(ctx, 'prompt')
    this.parts = []
    this.seq = 0
  }

  contribute(part) {
    if (!part || (!['string', 'function'].includes(typeof part.instructions) && typeof part.context !== 'function')) {
      throw new Error('Prompt contribution needs instructions or context')
    }
    const entry = { order: part.order ?? 0, seq: this.seq++, instructions: part.instructions, context: part.context, onUserInput: part.onUserInput }
    this.parts.push(entry)
    return () => {
      const index = this.parts.indexOf(entry)
      if (index >= 0) this.parts.splice(index, 1)
    }
  }

  async resolveUserInput(input) {
    const ordered = [...this.parts].sort((a, b) => a.order - b.order || a.seq - b.seq)
    const contributions = await Promise.all(ordered.filter((part) => typeof part.onUserInput === 'function').map((part) => part.onUserInput(input)))
    return contributions.flat()
  }

  async snapshot() {
    const ordered = [...this.parts].sort((a, b) => a.order - b.order || a.seq - b.seq)
    const instructions = await Promise.all(ordered.filter((part) => part.instructions != null).map((part) =>
      typeof part.instructions === 'function' ? part.instructions() : part.instructions))
    const context = await Promise.all(ordered.filter((part) => typeof part.context === 'function').map((part) => part.context()))
    return {
      instructions: instructions.filter((part) => typeof part === 'string' && part),
      context,
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
        permissions: 'read, glob, grep, and skill are allowed; each write, edit, and shell call requires approval; unknown tools are denied',
        sandbox: false,
      }),
    }))
  },
}
