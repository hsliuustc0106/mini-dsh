import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { applyWorkspacePluginConfig, resolveAgainstWorkspace } from '../src/workspace-path.js'

const rootDir = dirname(fileURLToPath(import.meta.url))
const worker = join(rootDir, '..', 'scripts', 'workspace-cwd-worker.mjs')

function runWorker(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err })
      else reject(new Error(`worker ${mode} exited ${code}: ${err || out}`))
    })
  })
}

test('resolveAgainstWorkspace joins relative paths and rejects a missing workspace', () => {
  const root = '/tmp/mini-ws-root'
  assert.equal(resolveAgainstWorkspace(root, 'a/b.txt'), join(root, 'a/b.txt'))
  assert.equal(resolveAgainstWorkspace(root, '/abs/file'), '/abs/file')
  assert.throws(() => resolveAgainstWorkspace('relative', 'x'), /Workspace must be an absolute path/)
  assert.throws(() => resolveAgainstWorkspace('', 'x'), /Workspace must be an absolute path/)
  assert.throws(() => resolveAgainstWorkspace(root, ''), /path must be a non-empty string/)
})

test('applyWorkspacePluginConfig defaults and resolves workDir against the workspace only', () => {
  const root = '/tmp/mini-ws-root'
  assert.deepEqual(applyWorkspacePluginConfig(undefined, root), { workDir: root })
  assert.deepEqual(applyWorkspacePluginConfig({}, root), { workDir: root })
  assert.deepEqual(applyWorkspacePluginConfig({ workDir: 'protos' }, root), { workDir: join(root, 'protos') })
  assert.deepEqual(applyWorkspacePluginConfig({ workDir: '/other', flag: true }, root), { workDir: '/other', flag: true })
  assert.throws(() => applyWorkspacePluginConfig({}, 'rel'), /Workspace must be an absolute path/)
  assert.throws(() => applyWorkspacePluginConfig([], root), /Plugin config must be an object/)
})

test('live mount supplies workspace workDir when cwd differs', async () => {
  await runWorker('live')
})

test('when cwd differs from workspace, protobuf uses workspace workDir; install→use→uninstall→restart', async () => {
  await runWorker('protobuf')
})
