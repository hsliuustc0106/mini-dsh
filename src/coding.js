import { readFile, writeFile } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { searchTools } from './search.js'

const run = promisify(exec)
const parameters = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })
const string = { type: 'string' }

function field(args, name) {
  if (!args || typeof args !== 'object' || typeof args[name] !== 'string') throw new Error(`${name} must be a string`)
  return args[name]
}

function workspaceRoot(ctx) {
  const root = ctx.workspace.root
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Workspace must be an absolute path')
  return root
}

// Relative paths and the shell working directory use the boot workspace.
// Absolute paths are unchanged. The workspace is not a sandbox.
function workspacePath(root, value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a string`)
  return isAbsolute(value) ? value : join(root, value)
}

export const coding = {
  inject: ['tools', 'workspace'],
  apply(ctx) {
    const tools = [
      { name: 'read', description: 'Read a UTF-8 file. Relative paths start at the workspace.', parameters: parameters({ path: string }, ['path']),
        execute: async (args) => (await readFile(workspacePath(workspaceRoot(ctx), field(args, 'path'), 'path'), 'utf8')).slice(0, 30000) },
      { name: 'write', description: 'Write a UTF-8 file, replacing its contents. Relative paths start at the workspace.', parameters: parameters({ path: string, content: string }, ['path', 'content']),
        execute: async (args) => { await writeFile(workspacePath(workspaceRoot(ctx), field(args, 'path'), 'path'), field(args, 'content')); return 'File written.' } },
      { name: 'edit', description: 'Replace exactly one occurrence of old_text in a UTF-8 file. Relative paths start at the workspace.', parameters: parameters({ path: string, old_text: string, new_text: string }, ['path', 'old_text', 'new_text']),
        execute: async (args) => {
          const path = workspacePath(workspaceRoot(ctx), field(args, 'path'), 'path')
          const oldText = field(args, 'old_text'), newText = field(args, 'new_text')
          if (!oldText) throw new Error('old_text must not be empty')
          const text = await readFile(path, 'utf8'), index = text.indexOf(oldText)
          if (index < 0 || text.indexOf(oldText, index + 1) !== -1) throw new Error('old_text must occur exactly once')
          await writeFile(path, text.slice(0, index) + newText + text.slice(index + oldText.length))
          return 'File edited.'
        } },
      { name: 'shell', description: 'Run a shell command with the workspace as its working directory. Approval is not a sandbox; the command has your OS permissions.', parameters: parameters({ command: string }, ['command']),
        execute: async (args) => {
          try {
            const result = await run(field(args, 'command'), { cwd: workspaceRoot(ctx), timeout: 30000, maxBuffer: 1024 * 1024 })
            return (result.stdout + result.stderr).slice(0, 30000) || '(no output)'
          } catch (error) { return `Command failed: ${error.message}\n${error.stdout || ''}${error.stderr || ''}`.slice(0, 30000) }
        } },
      ...searchTools(() => workspaceRoot(ctx)),
    ]
    for (const tool of tools) ctx.effect(() => ctx.tools.register(tool))
  },
}
