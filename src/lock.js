import { chmod } from 'node:fs/promises'

// One writer per session, held inside this process.
//
// The lock is a SQLite reserved lock (BEGIN IMMEDIATE) on a sibling file.
// Node's built-in SQLite uses the OS advisory lock (fcntl on Linux and macOS,
// LockFileEx on Windows). The kernel releases it when the process exits,
// including SIGKILL. Readers never open the lock file.
//
// Limitations:
// - Advisory: a program that appends to the log without this lock is not stopped.
// - Requires Node.js 22 with node:sqlite left enabled (the default).
//   `--no-experimental-sqlite` disables writer acquisition.
// - node:sqlite is still marked experimental.
// - POSIX advisory locks on NFS and some network shares are unreliable.
//   Local filesystems are the supported target.
// - The lock file and its rollback journal stay on disk after release.
//   Stale files do not keep the lock.
// - Reacquiring the lock only means the previous process is gone. It does not
//   mean a tool it started has finished.

let sqlite

function loadSqlite() {
  sqlite ??= importSqlite()
  return sqlite
}

async function importSqlite() {
  const emitWarning = process.emitWarning
  process.emitWarning = function (warning, type, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message ?? ''
    const name = typeof type === 'string' ? type : warning?.name
    if (name === 'ExperimentalWarning' && text.includes('SQLite')) return
    return emitWarning.call(process, warning, type, ...rest)
  }
  try { return await import('node:sqlite') }
  finally { process.emitWarning = emitWarning }
}

export function lockPathFor(sessionPath) {
  return `${sessionPath}.lock`
}

export async function acquireWriter(lockPath) {
  let DatabaseSync
  try { ({ DatabaseSync } = await loadSqlite()) }
  catch (error) {
    const wrapped = new Error('Session writer lock requires Node.js 22 with node:sqlite enabled')
    wrapped.code = 'SESSION_LOCK_UNSUPPORTED'
    wrapped.cause = error
    throw wrapped
  }
  const db = new DatabaseSync(lockPath, { timeout: 0 })
  try { await chmod(lockPath, 0o600) } catch { /* the lock, not the mode, is the guarantee */ }
  try {
    db.exec('PRAGMA busy_timeout = 0')
    db.exec('BEGIN IMMEDIATE')
  } catch (error) {
    db.close()
    if (/locked|busy/i.test(error.message)) {
      const busy = new Error(`Session writer is already held (${lockPath})`)
      busy.code = 'SESSION_LOCKED'
      throw busy
    }
    throw error
  }
  let released = false
  return {
    path: lockPath,
    release() {
      if (released) return
      released = true
      try { db.exec('ROLLBACK') } catch { /* process exit releases the lock anyway */ }
      db.close()
    },
  }
}
