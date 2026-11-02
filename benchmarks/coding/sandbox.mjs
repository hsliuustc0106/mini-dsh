import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { deserialize, serialize } from 'node:v8'

const run = promisify(execFile)
const worker = join(dirname(fileURLToPath(import.meta.url)), 'candidate.mjs')
const image = 'node:22-alpine'
const prefix = 'mini-dsh-response:'

const restrictions = [
  '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--pids-limit', '32', '--memory', '256m', '--cpus', '1', '--user', '65534:65534',
]

// Fail before making model calls if the container runtime or image is unavailable.
export async function ensureSandbox() {
  try {
    await run('docker', ['run', '--rm', ...restrictions, image, 'node', '--version'], { timeout: 120000, maxBuffer: 100000 })
  } catch (error) {
    throw new Error(`A working Docker sandbox is required for the benchmark: ${String(error.message ?? error).slice(0, 500)}`)
  }
}

// The host owns all assertions; this protocol transports only candidate values.
// Its child can print anything, so a printed quality verdict is never accepted.
export function candidateProtocol(child, cleanup = async () => {}) {
  let buffer = '', outputBytes = 0, nextId = 0, failure, pending
  const fail = (error) => {
    failure ??= error
    if (pending) { pending.reject(failure); pending = undefined }
  }
  const timer = setTimeout(() => fail(new Error('Candidate timed out')), 15000)
  child.on('error', fail)
  child.on('exit', (code, signal) => fail(new Error(`Candidate did not return a result (exit ${code ?? signal})`)))
  child.stdin.on('error', fail)
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length
    if (outputBytes > 1000000) return fail(new Error('Candidate output exceeded the limit'))
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith(prefix) || !pending) continue
      try {
        const response = deserialize(Buffer.from(line.slice(prefix.length), 'base64'))
        if (response.id !== pending.id) continue
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

export async function startSandbox(file) {
  // Mount only copies of the candidate and protocol worker, never the workspace.
  const directory = await mkdtemp(join(tmpdir(), 'mini-dsh-sandbox-'))
  const candidate = join(directory, 'candidate.mjs'), protocol = join(directory, 'worker.mjs')
  const name = `mini-dsh-quality-${randomUUID()}`
  try {
    await copyFile(file, candidate)
    await copyFile(worker, protocol)
    await Promise.all([chmod(candidate, 0o644), chmod(protocol, 0o644)])
    const child = spawn('docker', [
      'run', '--rm', '-i', '--name', name, ...restrictions,
      '--mount', `type=bind,source=${candidate},target=/candidate.mjs,readonly`,
      '--mount', `type=bind,source=${protocol},target=/worker.mjs,readonly`,
      image, 'node', '/worker.mjs', '/candidate.mjs',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    return candidateProtocol(child, async () => {
      // Killing the Docker client alone does not necessarily stop its container.
      try { await run('docker', ['rm', '-f', name], { timeout: 10000 }) } catch { /* Already stopped. */ }
      await rm(directory, { recursive: true, force: true })
    })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
