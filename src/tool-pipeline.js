// Teaching subset of the DSH tool pipeline. Decisions that mini-dsh does not
// implement fail closed. Model-facing text is what the JSONL log stores.

import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

const OUTCOME = Symbol('mini-dsh.tool-outcome')

export function errorText(message) {
  const text = typeof message === 'string' && message ? message : 'tool execution failed'
  return text.startsWith('Error:') ? text : `Error: ${text}`
}

export function errorOutcome(message) {
  const text = errorText(message)
  return { isError: true, text, content: [{ type: 'text', text }], contexts: [] }
}

function isThenable(value) {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function')
}

/**
 * Replace model-facing text with text ContentBlocks.
 * `undefined` keeps the outcome. Anything else must be synchronous lossless text blocks.
 */
export function installContent(outcome, blocks, label) {
  if (blocks === undefined) return outcome
  if (isThenable(blocks)) throw new Error(`${label} must be synchronous`)
  const text = textBlocks(blocks, label)
  let content
  try { content = snapshotJsonValue(blocks) }
  catch { content = undefined }
  if (content === undefined) throw new Error(`${label} must be lossless JSON`)
  return { ...outcome, text, content }
}

/** Run one definition-owned content callback. A throw is labeled for the caller. */
export function applyContentCallback(outcome, transform, execView, resultView, label) {
  if (typeof transform !== 'function') return outcome
  let blocks
  try {
    blocks = transform(execView, resultView)
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'content callback failed'
    throw new Error(`${label} failed: ${message}`)
  }
  return installContent(outcome, blocks, label)
}

export function textBlocks(blocks, label) {
  if (!Array.isArray(blocks) || blocks.some((block) => !block || block.type !== 'text' || typeof block.text !== 'string')) {
    throw new Error(`${label}: only text output blocks are supported`)
  }
  return blocks.map((block) => block.text).join('\n')
}

export function markOutcome(outcome) {
  Object.defineProperty(outcome, OUTCOME, { value: true })
  return outcome
}

export function isOutcome(value) {
  return Boolean(value && typeof value === 'object' && value[OUTCOME])
}

function ownKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : null
}

function rejectUnknown(value, allowed, label) {
  const keys = ownKeys(value)
  if (!keys) throw new Error(`Unsupported ${label}`)
  for (const key of keys) {
    if (!allowed.has(key)) throw new Error(`Unsupported ${label} field '${key}'`)
  }
}

const PRE_FIELDS = {
  allow: ['kind'],
  deny: ['kind', 'reason', 'info'],
  cancel: ['kind'],
  ask: ['kind', 'reason', 'displayReason'],
}

/** Normalize one `tools/pre-execute` decision. `ask` has no approval service here. */
export function normalizePreDecision(decision) {
  const kind = decision?.kind
  const allowed = PRE_FIELDS[kind]
  if (!allowed) throw new Error(`Unsupported pre-execute decision: ${kind ?? String(decision)}`)
  rejectUnknown(decision, new Set(allowed), 'pre-execute')
  if (kind === 'allow') return { kind: 'allow' }
  if (kind === 'cancel') return { kind: 'deny', reason: 'cancelled before dispatch' }
  if (kind === 'ask') return { kind: 'deny', reason: 'tools/pre-execute ask is not supported' }
  if (typeof decision.reason !== 'string' || !decision.reason) throw new Error('pre-execute deny requires a reason')
  if (decision.info !== undefined) throw new Error('pre-execute deny info is not supported')
  return { kind: 'deny', reason: decision.reason }
}

export function additionalContexts(value) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('post-execute additionalContexts must be an array')
  return value.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('post-execute context must be a user message')
    }
    if (message.role !== undefined && message.role !== 'user') {
      throw new Error(`Unsupported post-execute context role: ${message.role}`)
    }
    const content = typeof message.content === 'string'
      ? message.content
      : textBlocks(message.content, 'post-execute context')
    if (!content) throw new Error('post-execute context has no text content')
    return content
  })
}

/**
 * Apply one post-execute decision to a normalized outcome.
 * `replaceValue(value)` revalidates and re-renders a canonical value.
 */
export function applyPostDecision(decision, raw, replaceValue) {
  const kind = decision?.kind
  if (kind === 'accept') {
    rejectUnknown(decision, new Set(['kind', 'content', 'value', 'additionalContexts']), 'post-execute')
    if (decision.content !== undefined && decision.value !== undefined) {
      throw new Error('post-execute accept cannot replace content and value')
    }
    let text = raw.text
    let content = raw.content
    let value = raw.value
    let isError = raw.isError
    if (decision.content !== undefined) {
      text = textBlocks(decision.content, 'post-execute content')
      content = decision.content
    }
    if (decision.value !== undefined) {
      const replaced = replaceValue(decision.value)
      text = replaced.text
      content = replaced.content
      value = replaced.value
      isError = false
    }
    return {
      isError,
      text,
      content,
      ...(value !== undefined ? { value } : {}),
      contexts: [...(raw.contexts ?? []), ...additionalContexts(decision.additionalContexts)],
    }
  }
  if (kind === 'block') {
    rejectUnknown(decision, new Set(['kind', 'feedback', 'additionalContexts']), 'post-execute')
    const feedback = textBlocks(decision.feedback, 'post-execute feedback')
    return {
      isError: true,
      text: errorText(feedback),
      content: [{ type: 'text', text: errorText(feedback) }],
      contexts: additionalContexts(decision.additionalContexts),
    }
  }
  throw new Error(`Unsupported post-execute decision: ${kind ?? String(decision)}`)
}

/** Accept a `tools/execute` wrapper result, or the marked outcome from the tool body. */
export function coerceExecuteResult(value, replaceValue) {
  if (isOutcome(value)) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tools/execute returned an unsupported result')
  }
  if (value.isError === true) {
    rejectUnknown(value, new Set(['isError', 'error', 'content']), 'tools/execute')
    const message = typeof value.error?.message === 'string' && value.error.message
      ? value.error.message
      : 'tool execution failed'
    const text = value.content === undefined ? errorText(message) : errorText(textBlocks(value.content, 'tools/execute content'))
    return { isError: true, text, content: [{ type: 'text', text }], contexts: [] }
  }
  if (value.isError === false) {
    rejectUnknown(value, new Set(['isError', 'content', 'value']), 'tools/execute')
    if (value.content !== undefined && value.value !== undefined) {
      throw new Error('tools/execute cannot return content and value')
    }
    if (value.value !== undefined) {
      const replaced = replaceValue(value.value)
      return { isError: false, text: replaced.text, content: replaced.content, value: replaced.value, contexts: [] }
    }
    if (value.content === undefined) throw new Error('tools/execute success requires content or value')
    const text = textBlocks(value.content, 'tools/execute content')
    return { isError: false, text, content: value.content, contexts: [] }
  }
  throw new Error('tools/execute returned an unsupported result')
}

export function fuseSignals(primary, extra) {
  if (!extra || extra === primary) return primary
  const controller = new AbortController()
  const link = (source) => {
    if (source.aborted) {
      controller.abort(source.reason)
      return
    }
    source.addEventListener('abort', () => controller.abort(source.reason), { once: true })
  }
  link(primary)
  link(extra)
  return controller.signal
}
