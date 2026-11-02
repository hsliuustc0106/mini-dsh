import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { deserialize, serialize } from 'node:v8'

const run = promisify(execFile)
const worker = join(dirname(fileURLToPath(import.meta.url)), 'candidate.mjs')
const repo = join(dirname(worker), '../..')
const image = 'node:22-alpine'
const prefix = 'mini-dsh-response:'
const readyLine = 'mini-dsh-worker-ready'

const restrictions = [
  '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', '32', '--memory', '256m', '--cpus', '1', '--user', '65534:65534',
]

// Copy only the compartment runtime and its locked dependencies into the
// container. The project checkout and its other dependencies stay outside.
async function stageRuntime(destination) {
  const { packages } = JSON.parse(await readFile(join(repo, 'package-lock.json'), 'utf8'))
  const queue = ['node_modules/ses', 'node_modules/@endo/module-source']
  const copied = new Set()
  await mkdir(destination, { recursive: true, mode: 0o755 })
  while (queue.length) {
    const path = queue.shift()
    if (copied.has(path)) continue
    const metadata = packages[path]
    if (!metadata || !path.startsWith('node_modules/')) throw new Error(`Missing sandbox dependency: ${path}`)
    copied.add(path)
    const source = join(repo, path), target = join(destination, path.slice('node_modules/'.length))
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { recursive: true, filter: (file) => file !== join(source, 'node_modules') })
    for (const name of Object.keys(metadata.dependencies ?? {})) {
      let parent = path, dependency
      while (true) {
        const possible = parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`
        if (packages[possible]) { dependency = possible; break }
        if (!parent) throw new Error(`Missing sandbox dependency: ${name}`)
        const nested = parent.lastIndexOf('/node_modules/')
        parent = nested < 0 ? '' : parent.slice(0, nested)
      }
      queue.push(dependency)
    }
  }
  await chmod(destination, 0o755)
}

// Verify the actual runtime mount before making any model calls.
export async function ensureSandbox() {
  const directory = await mkdtemp(join(tmpdir(), 'mini-dsh-sandbox-check-'))
  try {
    const dependencies = join(directory, 'node_modules')
    await stageRuntime(dependencies)
    await run('docker', [
      'run', '--rm', ...restrictions,
      '--mount', `type=bind,source=${dependencies},target=/node_modules,readonly`,
      image, 'node', '--input-type=module', '-e', "await import('ses'); await import('@endo/module-source')",
    ], { timeout: 120000, maxBuffer: 100000 })
  } catch (error) {
    throw new Error(`A working Docker sandbox is required for the benchmark: ${String(error.message ?? error).slice(0, 500)}`)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

// The host owns all assertions; this protocol transports only candidate values.
// Its child can print anything, so a printed quality verdict is never accepted.
export class CandidateFailure extends Error {}

export function candidateProtocol(child, cleanup = async () => {}, { timeoutMs = 15000 } = {}) {
  let buffer = '', outputBytes = 0, nextId = 0, failure, pending, ready = false
  const fail = (error) => {
    failure ??= error
    if (pending) { pending.reject(failure); pending = undefined }
  }
  const timer = setTimeout(() => fail(ready ? new CandidateFailure('Candidate timed out') : new Error('Sandbox worker did not start')), timeoutMs)
  child.on('error', fail)
  child.on('exit', (code, signal) => {
    const message = `Candidate did not return a result (exit ${code ?? signal})`
    fail(ready && ![125, 126, 127].includes(code) ? new CandidateFailure(message) : new Error(message))
  })
  // An exited child can report EPIPE before its exit status; wait for that
  // status so Docker startup failures are not mistaken for candidate errors.
  child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') fail(error) })
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length
    if (outputBytes > 1000000) return fail(ready ? new CandidateFailure('Candidate output exceeded the limit') : new Error('Sandbox output exceeded the limit'))
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line === readyLine) { ready = true; continue }
      if (!line.startsWith(prefix) || !pending) continue
      try {
        const response = deserialize(Buffer.from(line.slice(prefix.length), 'base64'))
        if (response.id !== pending.id) continue
        ready = true
        const current = pending
        pending = undefined
        current.resolve(response)
      } catch { /* Ignore output that is not a protocol response. */ }
    }
  })
  // Drain stderr without trusting or retaining output produced by the candidate.
  child.stderr.resume()
  return {
    get error() { return failure },
    request(method, args, mutations = []) {
      if (failure) return Promise.reject(failure)
      if (pending) return Promise.reject(new Error('Concurrent candidate requests are not supported'))
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending = { id, resolve, reject }
        child.stdin.write(`${serialize({ id, method, args, mutations }).toString('base64')}\n`)
      })
    },
    async close() {
      clearTimeout(timer)
      child.stdin.end()
      child.kill('SIGKILL')
      await cleanup()
    },
  }
}

export async function startSandbox(file, workerFile = worker, options = {}) {
  // Mount only copies of the candidate, worker, and their runtime dependencies.
  const directory = await mkdtemp(join(tmpdir(), 'mini-dsh-sandbox-'))
  const candidate = join(directory, 'candidate.mjs'), protocol = join(directory, 'worker.mjs')
  const dependencies = join(directory, 'node_modules')
  const name = `mini-dsh-quality-${randomUUID()}`
  try {
    await copyFile(file, candidate)
    await copyFile(workerFile, protocol)
    await stageRuntime(dependencies)
    await Promise.all([chmod(candidate, 0o644), chmod(protocol, 0o644)])
    const child = spawn('docker', [
      'run', '--rm', '-i', '--name', name, ...restrictions,
      '--mount', `type=bind,source=${candidate},target=/candidate.mjs,readonly`,
      '--mount', `type=bind,source=${protocol},target=/worker.mjs,readonly`,
      '--mount', `type=bind,source=${dependencies},target=/node_modules,readonly`,
      image, 'node', '/worker.mjs', '/candidate.mjs',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    return candidateProtocol(child, async () => {
      // Killing the Docker client alone does not necessarily stop its container.
      try { await run('docker', ['rm', '-f', name], { timeout: 10000 }) } catch { /* Already stopped. */ }
      await rm(directory, { recursive: true, force: true })
    }, options)
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
