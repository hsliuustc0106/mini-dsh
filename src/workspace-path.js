import { isAbsolute, join } from 'node:path'

// Relative plugin/tool paths resolve against the boot workspace only — never
// process.cwd(). Missing or non-absolute workspace fails closed.
export function resolveAgainstWorkspace(workspaceRoot, value, label = 'path') {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot || !isAbsolute(workspaceRoot)) {
    throw new Error('Workspace must be an absolute path')
  }
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`)
  return isAbsolute(value) ? value : join(workspaceRoot, value)
}

// Path-aware DSH tools (e.g. workDir) default to the workspace root. An explicit
// relative workDir joins the workspace; absolute workDir is kept. No chdir.
export function applyWorkspacePluginConfig(config, workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot || !isAbsolute(workspaceRoot)) {
    throw new Error('Workspace must be an absolute path')
  }
  if (config != null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new Error('Plugin config must be an object')
  }
  const next = { ...(config ?? {}) }
  if (!Object.hasOwn(next, 'workDir') || next.workDir == null || next.workDir === '') {
    next.workDir = workspaceRoot
  } else {
    next.workDir = resolveAgainstWorkspace(workspaceRoot, next.workDir, 'workDir')
  }
  return next
}
