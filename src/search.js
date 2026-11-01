import { execFile } from 'node:child_process'
import { isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const vcs = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']
const maxPaths = 100
const maxMatches = 250
const maxLineBytes = 2000
const maxRawBytes = 20_000_000

function searchPath(path) {
  if (path !== undefined && !path.trim()) throw new Error('path must be a non-empty string when given')
  return path === undefined ? [] : ['--', path]
}

function includeGlob(include) {
  if (include === undefined || include === '') return []
  if (!include.trim()) throw new Error('include must be a non-empty glob when given')
  if (include.startsWith('!')) throw new Error('include must be a positive glob filter')
  let depth = 0
  for (const char of include) {
    if (char === '{') depth++
    else if (char === '}') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) throw new Error('include must be one glob, not a comma-separated list')
  }
  return [`--glob=${include}`]
}

// Do not use a shell: search arguments are data. --no-config also prevents a
// user's ripgrep config from adding a preprocessor to these read-only calls.
async function ripgrep(workspace, name, args) {
  try {
    const { rgPath } = await import('@vscode/ripgrep')
    const search = run(rgPath, ['--no-config', ...args], {
      cwd: workspace, timeout: 30000, maxBuffer: maxRawBytes, windowsHide: true,
    })
    search.child.stdin.end()
    const { stdout } = await search
    return stdout
  } catch (error) {
    if (error.code === 1) return ''
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error(`${name} output exceeded ${maxRawBytes} bytes; narrow pattern, path, or include`)
    }
    if (error.killed) throw new Error(`${name} search timed out or was terminated`)
    const detail = String(error.stderr || error.message).trim().slice(0, 4000)
    throw new Error(`${name} search failed: ${detail}`)
  }
}

function displayPath(path, workspace) {
  if (!isAbsolute(path)) return path
  const result = relative(workspace, path)
  return result === '' ? '.' : result === '..' || result.startsWith(`..${sep}`) ? path : result
}

async function glob(workspace, args) {
  if (!args.pattern.trim()) throw new Error('pattern must be a non-empty string')
  const argv = [
    '--files', '--null', `--glob=${args.pattern}`, '--sort=modified', '--no-ignore', '--hidden',
    ...vcs.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
    ...searchPath(args.path),
  ]
  const output = await ripgrep(workspace, 'glob', argv)
  const paths = output.split('\0').filter(Boolean).map((path) => displayPath(path, workspace))
  if (!paths.length) return 'No files found'
  const shown = paths.slice(0, maxPaths).join('\n')
  return paths.length <= maxPaths ? shown : `${shown}\n\n(Showing ${maxPaths} of ${paths.length} paths. Narrow pattern or path to see more.)`
}

function preview(line) {
  const bytes = Buffer.from(line)
  if (bytes.length <= maxLineBytes) return line
  return `${new TextDecoder().decode(bytes.subarray(0, maxLineBytes), { stream: true })} (line truncated)`
}

async function grep(workspace, args) {
  if (!args.pattern.length) throw new Error('pattern must be a non-empty string')
  const argv = ['--json', `--regexp=${args.pattern}`, ...includeGlob(args.include), ...searchPath(args.path ?? '.')]
  const output = await ripgrep(workspace, 'grep', argv)
  const matches = []
  for (const line of output.split('\n')) {
    if (!line) continue
    const record = JSON.parse(line)
    if (record.type !== 'match') continue
    const data = record.data
    if (typeof data?.path?.text !== 'string' || typeof data?.line_number !== 'number' || !data?.lines) {
      throw new Error('grep received malformed ripgrep output')
    }
    const text = typeof data.lines.text === 'string'
      ? data.lines.text.replace(/\r?\n$/, '')
      : typeof data.lines.bytes === 'string' ? '(line is not valid UTF-8)' : null
    if (text === null) throw new Error('grep received malformed ripgrep output')
    matches.push({ path: displayPath(data.path.text, workspace), number: data.line_number, text: preview(text) })
  }
  if (!matches.length) return 'No matches found'
  const groups = new Map()
  for (const match of matches.slice(0, maxMatches)) {
    if (!groups.has(match.path)) groups.set(match.path, [])
    groups.get(match.path).push(`Line ${match.number}: ${match.text}`)
  }
  const body = [...groups].map(([path, lines]) => `${path}\n${lines.join('\n')}`).join('\n\n')
  if (matches.length > maxMatches) {
    return `Found ${maxMatches} of ${matches.length} matches\n\n${body}\n\n(Narrow pattern, path, or include to see more.)`
  }
  return `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}\n\n${body}`
}

const string = (description) => ({ type: 'string', description })
const parameters = (properties) => ({ type: 'object', properties, required: ['pattern'], additionalProperties: false })

export function searchTools(workspace) {
  return [
    {
      name: 'glob',
      description: 'Find files by glob pattern, including hidden and ignored files. Returns up to 100 paths in modification-time order.',
      parameters: parameters({
        pattern: string('Glob pattern. A pattern without / matches basenames at any depth.'),
        path: string('Directory to search; defaults to the workspace.'),
      }),
      execute: (args) => glob(workspace(), args),
    },
    {
      name: 'grep',
      description: 'Search file contents using a ripgrep regular expression. Returns up to 250 matching lines grouped by file.',
      parameters: parameters({
        pattern: string('Regular expression to search for, using ripgrep syntax.'),
        path: string('File or directory to search; defaults to the workspace.'),
        include: string('One positive glob filter for files, such as *.{js,ts}.'),
      }),
      execute: (args) => grep(workspace(), args),
    },
  ]
}
