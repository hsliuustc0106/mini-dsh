import { Service } from '@deepseek-ai/cordis'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import Ajv from 'ajv'
import { appendFile, mkdir, open, readFile, truncate } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { resolveAgainstWorkspace } from './workspace-path.js'
import { acquireWriter, lockPathFor } from './lock.js'
import { AGENT_SCOPE } from './agents.js'
import { currentDelegationAgent } from './delegation.js'
import { assertEvent, createEvent, projectSessionMessages, readSession, unknownOutcomes, unknownReason, unknownStreams } from './log.js'
import {
  applyContentCallback, applyPostDecision, coerceExecuteResult, deferredContextText, errorOutcome, fuseSignals, markOutcome, modelFacingContent, normalizePreDecision,
} from './tool-pipeline.js'

export function validateArguments(schema, value) {
  if (!schema || schema.type !== 'object') throw new Error('Tool schema must be an object')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be an object')
  const properties = schema.properties ?? {}
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(value, name) || value[name] == null) throw new Error(`${name} is required`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) throw new Error(`${key} is not allowed`)
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key) || !spec?.type) continue
    if (typeof value[key] !== spec.type) throw new Error(`${key} must be a ${spec.type}`)
  }
}

function taggedAgent(ctx) {
  const agent = ctx[AGENT_SCOPE]
  if (!agent || typeof agent !== 'object' || Array.isArray(agent) || typeof agent.id !== 'string' || !agent.id) return undefined
  return agent
}

// A tagged caller selects that agent. Otherwise the bound mini-dsh agent is
// the target: agent.ctx does not provide tools, so a normal plugin cannot
// call through it. No tag and no bound agent fails closed.
function resolveAgent(ctx, method) {
  const tagged = taggedAgent(ctx)
  if (tagged) return tagged
  const agents = ctx.reflect.get('agents', false)
  const agent = agents?.primary
  if (agent && typeof agent.id === 'string' && agent.id) return agent
  throw new Error(`${method} requires agent.ctx`)
}

function compileNameList(value, label) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !name)) {
    throw new Error(`tools.restrict() ${label} must be an array of tool names`)
  }
  if (label === 'deny' && value.length === 0) throw new Error('tools.restrict() deny is empty')
  const seen = new Set()
  for (const name of value) {
    if (seen.has(name)) throw new Error(`tools.restrict() ${label} lists ${JSON.stringify(name)} more than once`)
    seen.add(name)
  }
  return value
}

function admits(mask, name) {
  if (mask.allow && !mask.allow.has(name)) return false
  if (mask.deny && mask.deny.has(name)) return false
  return true
}

const RUN_CODE_NAME = 'run_code'

const PROGRAM_NOT_EXECUTED = 'run_code program is stored and was not executed'

const RUN_CODE_DESCRIPTION = 'Code Mode entry. Call this tool with code and a short description. code is stored and is not executed. A JSON array of { name, arguments } objects is dispatched as nested tool calls. Any other text fails closed.'

const RUN_CODE_PARAMETERS = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'Program text. It is stored and is not executed. A JSON array of { name, arguments } tool calls is dispatched. Any other text fails closed.' },
    description: { type: 'string', description: 'Short summary of what this program does.' },
  },
  required: ['code', 'description'],
  additionalProperties: false,
}

const SUPPORTED_PRESENTATION = new Set(['native', 'code'])

export function assertRunCodeArguments(args) {
  if (typeof args?.code !== 'string' || args.code.trim() === '') throw new Error('code must be a non-empty string')
  if (typeof args?.description !== 'string' || args.description.trim() === '') throw new Error('description must be a non-empty string')
}

// Data only. JSON.parse does not run the program. Any other shape fails closed.
export function parseNestedDispatch(code) {
  let value
  try { value = JSON.parse(code) }
  catch { throw new Error(PROGRAM_NOT_EXECUTED) }
  if (!Array.isArray(value)) throw new Error(PROGRAM_NOT_EXECUTED)
  return value.map((call) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) throw new Error(PROGRAM_NOT_EXECUTED)
    for (const key of Object.keys(call)) {
      if (key !== 'name' && key !== 'arguments') throw new Error(PROGRAM_NOT_EXECUTED)
    }
    if (typeof call.name !== 'string' || !call.name) throw new Error(PROGRAM_NOT_EXECUTED)
    if (call.name === RUN_CODE_NAME) throw new Error('run_code nested dispatch cannot call run_code')
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new Error(PROGRAM_NOT_EXECUTED)
    }
    let snapshot
    try { snapshot = snapshotJsonValue(call.arguments) }
    catch { snapshot = undefined }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error(PROGRAM_NOT_EXECUTED)
    return { name: call.name, arguments: snapshot }
  })
}

function createRunCodeTool(tools) {
  return {
    name: RUN_CODE_NAME,
    description: RUN_CODE_DESCRIPTION,
    parameters: RUN_CODE_PARAMETERS,
    async execute(args, execution) {
      assertRunCodeArguments(args)
      const calls = parseNestedDispatch(args.code)
      return tools.dispatchRunCode(calls, execution)
    },
  }
}

function runCodeSchema() {
  return {
    type: 'function',
    function: { name: RUN_CODE_NAME, description: RUN_CODE_DESCRIPTION, parameters: RUN_CODE_PARAMETERS },
  }
}

function unsupportedPresentation(mode) {
  const shown = typeof mode === 'string' ? JSON.stringify(mode) : typeof mode
  return new Error(`tools.presentAs is not supported (${shown}); only "native" and "code" presentation are available`)
}

export class Tools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.items = new Map()
    this.outputs = new Map()
    this.owners = new Map()
    this.contracts = new Map()
    this.guards = []
    this.masks = []
    this.presentations = new Map()
    this.runCode = createRunCodeTool(this)
  }
  async dispatchRunCode(calls, execution) {
    const agent = this.ctx.reflect.get('agent', false)
    if (!agent || typeof agent.dispatchNested !== 'function' || typeof execution?.deferContext !== 'function') {
      throw new Error('run_code nested dispatch is unavailable')
    }
    return agent.dispatchNested({
      parentId: execution.callId,
      calls,
      signal: execution.signal,
      deferContext: (message) => execution.deferContext(message),
    })
  }
  register(tool, options) {
    if (typeof tool?.name !== 'string' || !tool.name) throw new Error('Tool name is required')
    if (tool.name === RUN_CODE_NAME) throw new Error('Tool run_code is reserved')
    if (typeof tool.description !== 'string') throw new Error(`Tool ${tool.name} needs a description`)
    if (!tool.parameters || tool.parameters.type !== 'object') throw new Error(`Tool ${tool.name} needs an object schema`)
    if (typeof tool.execute !== 'function') throw new Error(`Tool ${tool.name} needs execute`)
    if (options != null && Object.keys(options).length) throw new Error(`Tool ${tool.name}: registration options are not supported`)
    if (this.items.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`)
    // Presentation helpers from defineTool are accepted and ignored (no UI).
    // projectContent / finalizeContent / deferLoading are registered below.
    if (tool.projectContent !== undefined && typeof tool.projectContent !== 'function') {
      throw new Error(`Tool ${tool.name}: projectContent must be a function when provided`)
    }
    if (tool.finalizeContent !== undefined && typeof tool.finalizeContent !== 'function') {
      throw new Error(`Tool ${tool.name}: finalizeContent must be a function when provided`)
    }
    if (tool.deferLoading !== undefined && tool.deferLoading !== true) {
      throw new Error(`Tool ${tool.name}: deferLoading must be true when provided`)
    }
    const ignoredToolFields = new Set(['presentCall', 'presentResult', 'isConcurrencySafe'])
    const supportedToolFields = new Set([
      'name', 'description', 'parameters', 'execute', 'output', 'timeoutMs',
      'projectContent', 'finalizeContent', 'deferLoading', ...ignoredToolFields,
    ])
    for (const key of Object.keys(tool)) {
      if (!supportedToolFields.has(key)) throw new Error(`Tool ${tool.name}: unsupported tool field '${key}'`)
    }
    for (const key of ignoredToolFields) {
      if (tool[key] !== undefined && typeof tool[key] !== 'function') {
        throw new Error(`Tool ${tool.name}: ${key} must be a function when provided`)
      }
    }
    if (tool.timeoutMs !== undefined && (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0 || tool.timeoutMs > 2147483647)) {
      throw new Error(`Tool ${tool.name}: timeoutMs must be positive and at most 2147483647`)
    }
    let output
    if (tool.output != null) {
      if (typeof tool.output !== 'object' || Array.isArray(tool.output)) {
        throw new Error(`Tool ${tool.name}: DSH output needs a schema and renderer`)
      }
      const ignoredOutputFields = new Set(['presentationMeta'])
      const supportedOutputFields = new Set(['schema', 'render', ...ignoredOutputFields])
      for (const key of Object.keys(tool.output)) {
        if (!supportedOutputFields.has(key)) throw new Error(`Tool ${tool.name}: unsupported output field '${key}'`)
      }
      if (tool.output.presentationMeta !== undefined && typeof tool.output.presentationMeta !== 'function') {
        throw new Error(`Tool ${tool.name}: presentationMeta must be a function when provided`)
      }
      const schema = tool.output.schema
      if (!schema || typeof schema !== 'object' || Array.isArray(schema) || typeof tool.output.render !== 'function') {
        throw new Error(`Tool ${tool.name}: DSH output needs a schema and renderer`)
      }
      let validate
      try {
        this.outputSchemas ??= new Ajv({ strict: true, addUsedSchema: false, ownProperties: true })
        validate = this.outputSchemas.compile(schema)
      }
      catch (error) { throw new Error(`Tool ${tool.name}: unsupported DSH output schema: ${error.message}`) }
      if (validate.$async) throw new Error(`Tool ${tool.name}: asynchronous DSH output schemas are not supported`)
      output = { schema, validate, render: tool.output.render.bind(tool.output) }
    }
    // The traceable service proxy makes this.ctx the caller, so the owner fiber
    // is the plugin that registered the tool. Dispose drops that same identity.
    const owner = this.ctx.fiber
    const contract = {
      projectContent: typeof tool.projectContent === 'function' ? tool.projectContent.bind(tool) : undefined,
      finalizeContent: typeof tool.finalizeContent === 'function' ? tool.finalizeContent.bind(tool) : undefined,
      deferLoading: tool.deferLoading === true,
    }
    return this.ctx.effect(() => {
      this.items.set(tool.name, tool)
      this.owners.set(tool.name, owner)
      this.contracts.set(tool.name, contract)
      if (output) this.outputs.set(tool.name, output)
      return () => {
        if (this.items.get(tool.name) !== tool) return
        this.items.delete(tool.name)
        if (this.owners.get(tool.name) === owner) this.owners.delete(tool.name)
        if (this.contracts.get(tool.name) === contract) this.contracts.delete(tool.name)
        this.outputs.delete(tool.name)
        if (output) this.outputSchemas.removeSchema(output.schema)
      }
    })
  }
  // No agent: the full registry, which never includes reserved run_code.
  // Code mode: only that reserved entry. Otherwise native schemas after masks.
  // The mini-dsh loop passes the initiating agent, and that list is what JSONL records.
  schemas(agent) {
    if (agent === undefined) return this.project()
    if (!agent || typeof agent !== 'object' || Array.isArray(agent) || typeof agent.id !== 'string' || !agent.id) {
      throw new Error('tools.schemas() agent must have an id')
    }
    if (this.presentationMode(agent.id) === 'code') return [runCodeSchema()]
    return this.project(agent.id)
  }
  presentationMode(agentId) {
    const mode = this.presentations.get(agentId)
    if (mode !== undefined && !SUPPORTED_PRESENTATION.has(mode)) throw unsupportedPresentation(mode)
    return mode
  }
  // Direct model calls. Code mode resolves only reserved run_code; every other
  // name is absent. run_code is absent unless this agent presented as code.
  // The program text is not executed here.
  callable(name, agent) {
    const agentId = agent && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : undefined
    const mode = agentId ? this.presentationMode(agentId) : undefined
    if (name === RUN_CODE_NAME) return mode === 'code' ? this.runCode : undefined
    if (mode === 'code') return undefined
    return typeof name === 'string' ? this.items.get(name) : undefined
  }
  // Nested calls from an admitted run_code. Code mode still hides these names
  // from the model. restrict() denies them later, on the guard path.
  dispatchable(name, agent) {
    if (typeof name !== 'string' || !name || name === RUN_CODE_NAME) return undefined
    const agentId = agent && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : undefined
    if (!agentId || this.presentationMode(agentId) !== 'code') return undefined
    return this.items.get(name)
  }
  project(agentId) {
    return [...this.items.values()]
      .filter((tool) => agentId === undefined || this.visibleTo(agentId, tool.name))
      .map(({ name, description, parameters }) => {
        const fn = { name, description, parameters }
        if (this.contracts.get(name)?.deferLoading === true) fn.deferLoading = true
        return { type: 'function', function: fn }
      })
  }
  visibleTo(agentId, name) {
    for (const mask of this.masks) {
      if (mask.agentId === agentId && !admits(mask, name)) return false
    }
    return true
  }
  // One presentation for the calling agent. native and code register through
  // ctx.effect and leave with the caller fiber. Other modes do not register.
  presentAs(mode) {
    if (!SUPPORTED_PRESENTATION.has(mode)) throw unsupportedPresentation(mode)
    const agent = resolveAgent(this.ctx, 'tools.presentAs()')
    if (this.presentations.has(agent.id)) {
      throw new Error(`tools.presentAs(${JSON.stringify(mode)}) conflicts with a presentation already declared for this agent`)
    }
    const agentId = agent.id
    return this.ctx.effect(() => {
      if (this.presentations.has(agentId)) {
        throw new Error(`tools.presentAs(${JSON.stringify(mode)}) conflicts with a presentation already declared for this agent`)
      }
      this.presentations.set(agentId, mode)
      return () => {
        if (this.presentations.get(agentId) === mode) this.presentations.delete(agentId)
      }
    })
  }
  // Mask global tools for the calling agent. The denial is a tools.guard entry,
  // so checkGuards rejects a hidden call and a later guard cannot allow it.
  restrict(filter) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      throw new Error('tools.restrict() requires { allow?: string[], deny?: string[] }')
    }
    for (const key of Object.keys(filter)) {
      if (key !== 'allow' && key !== 'deny') throw new Error(`tools.restrict() field '${key}' is not supported`)
    }
    if (filter.allow === undefined && filter.deny === undefined) {
      throw new Error('tools.restrict() requires allow and/or deny')
    }
    const allow = filter.allow === undefined ? undefined : compileNameList(filter.allow, 'allow')
    const deny = filter.deny === undefined ? undefined : compileNameList(filter.deny, 'deny')
    const agent = resolveAgent(this.ctx, 'tools.restrict()')
    const named = [...(allow ?? []), ...(deny ?? [])]
    if (named.includes(RUN_CODE_NAME)) {
      throw new Error('tools.restrict() cannot name reserved run_code')
    }
    const unknown = named.filter((name) => !this.items.has(name))
    if (unknown.length) {
      throw new Error(`tools.restrict() names unknown tool ${unknown.map((name) => JSON.stringify(name)).join(', ')}`)
    }
    const mask = { agentId: agent.id }
    if (allow !== undefined) mask.allow = new Set(allow)
    if (deny !== undefined) mask.deny = new Set(deny)
    return this.ctx.effect(() => {
      this.masks.push(mask)
      const removeGuard = this.guard((view) => {
        if (view?.agent?.id !== mask.agentId) return undefined
        if (view?.name === RUN_CODE_NAME) return undefined
        if (typeof view.name !== 'string' || admits(mask, view.name)) return undefined
        return `tool ${view.name} is restricted`
      })
      return () => {
        const index = this.masks.indexOf(mask)
        if (index >= 0) this.masks.splice(index, 1)
        removeGuard()
      }
    })
  }
  // Monotonic denial after tools/pre-execute. A returned string cannot be
  // turned back into permission by a later waterfall listener. The registration
  // leaves with the calling fiber.
  guard(guard) {
    if (typeof guard !== 'function') throw new Error('tools.guard requires a function')
    const entry = { guard }
    return this.ctx.effect(() => {
      this.guards.push(entry)
      return () => {
        const index = this.guards.indexOf(entry)
        if (index >= 0) this.guards.splice(index, 1)
      }
    })
  }
  // `parallel` only when the classifier returns exactly true. Omission, invalid
  // arguments, a throw, or any other return stays exclusive (an ordering barrier).
  executionMode(call) {
    const name = typeof call?.name === 'string' ? call.name : call?.function?.name
    const tool = typeof name === 'string' ? this.items.get(name) : undefined
    if (typeof tool?.isConcurrencySafe !== 'function') return { kind: 'exclusive' }
    let args = call.arguments ?? call.function?.arguments
    if (typeof args === 'string') {
      try { args = JSON.parse(args) }
      catch { return { kind: 'exclusive' } }
    }
    try { validateArguments(tool.parameters, args) }
    catch { return { kind: 'exclusive' } }
    try {
      return tool.isConcurrencySafe(args) === true ? { kind: 'parallel' } : { kind: 'exclusive' }
    } catch {
      return { kind: 'exclusive' }
    }
  }
  createExecution({ callId, name, args, tool }) {
    const snapshot = snapshotJsonValue(args)
    if (snapshot === undefined) throw new Error('Tool arguments must be lossless JSON')
    deepFreeze(snapshot)
    const caller = new AbortController()
    const view = {}
    // Text deferred during this call. executeOnly attaches it to the outcome;
    // the agent commits those strings as tools.context after the tool batch.
    const deferred = []
    const canDefer = this.outputs.has(name)
    Object.defineProperties(view, {
      callId: { value: callId, enumerable: true },
      name: { value: name, enumerable: true },
      arguments: { value: snapshot, enumerable: true },
      agent: { value: currentDelegationAgent(), enumerable: true },
      deferContext: { value(context) { pushDeferred(canDefer, deferred, context) } },
    })
    let signal = caller.signal
    Object.defineProperty(view, 'signal', {
      enumerable: true,
      configurable: true,
      get() { return signal },
      set(value) {
        if (!value || typeof value.addEventListener !== 'function' || typeof value.aborted !== 'boolean') {
          throw new Error('tools/execute signal must be an AbortSignal')
        }
        signal = value
      },
    })
    const contract = this.contracts.get(name)
    return {
      callId, name, args: snapshot, tool, callerSignal: caller.signal, view,
      projectContent: contract?.projectContent,
      finalizeContent: contract?.finalizeContent,
      abort(reason) { if (!caller.signal.aborted) caller.abort(reason) },
      deferred,
    }
  }
  async preExecute(exec) {
    const decision = await this.ctx.waterfall('tools/pre-execute', exec.view, async () => ({ kind: 'allow' }))
    exec.view.signal = exec.callerSignal
    return normalizePreDecision(decision)
  }
  checkGuards(exec) {
    const agentId = exec?.view?.agent?.id
    if (typeof agentId === 'string') this.presentationMode(agentId)
    for (const entry of this.guards) {
      let reason
      try { reason = entry.guard(exec.view) }
      catch (error) { throw new Error(`tools.guard failed closed: ${error.message}`) }
      if (reason != null && typeof reason.then === 'function') throw new Error('tools.guard must be synchronous')
      if (reason === undefined) continue
      if (typeof reason !== 'string' || !reason) throw new Error('tools.guard must return a denial reason or undefined')
      return reason
    }
    return undefined
  }
  replaceValue(exec, value) {
    const output = this.outputs.get(exec.name)
    if (!output) throw new Error('post-execute value replacement requires an output schema')
    return this.renderOutput(exec.name, exec.args, value, output)
  }
  renderOutput(name, args, value, output) {
    let snapshot
    try { snapshot = snapshotJsonValue(value) }
    catch { /* A plugin result must be inspectable JSON. */ }
    if (snapshot === undefined) throw new Error(`Tool ${name}: expected a lossless JSON result`)
    if (!output.validate(snapshot)) throw new Error(`Tool ${name}: output does not match schema: ${this.outputSchemas.errorsText(output.validate.errors)}`)
    const blocks = output.render(args, deepFreeze(snapshot))
    const facing = modelFacingContent(blocks, `Tool ${name}`)
    if (facing.kind === 'text') return { text: facing.text, value: snapshot, content: blocks, model: facing.text }
    return { text: facing.text, value: snapshot, content: facing.blocks, model: facing.blocks }
  }
  // Around-dispatch waterfall. Tool failures become outcomes so post-execute
  // still runs; they do not skip the body checkpoint the agent already wrote.
  async executeOnly(exec) {
    try {
      const returned = await this.ctx.waterfall('tools/execute', exec.view, async () => {
        const signal = fuseSignals(exec.callerSignal, exec.view.signal)
        return markOutcome(await this.invoke(exec.tool, exec.args, {
          callId: exec.callId,
          signal,
          agent: exec.view.agent,
          deferred: exec.deferred,
        }))
      })
      return attachDeferred(coerceExecuteResult(returned, (value) => this.replaceValue(exec, value)), exec.deferred)
    } catch (error) {
      return attachDeferred(errorOutcome(error.message), exec.deferred)
    }
  }
  async settle(exec, raw) {
    const viewed = executionView(exec)
    const project = exec.projectContent
    exec.projectContent = undefined
    let stage = raw
    let runPost = true
    if (typeof project === 'function') {
      try {
        stage = applyContentCallback(stage, project, viewed, publishResult(stage), `Tool ${exec.name}: projectContent`)
      } catch (error) {
        stage = errorOutcome(error.message)
        runPost = false
      }
    }
    let final = stage
    if (runPost) {
      try {
        const decision = await this.ctx.waterfall(
          'tools/post-execute',
          exec.view,
          publishResult(stage),
          async () => ({ kind: 'accept' }),
        )
        final = applyPostDecision(decision, stage, (value) => this.replaceValue(exec, value))
      } catch (error) {
        final = errorOutcome(error.message)
      }
    }
    const finalize = exec.finalizeContent
    exec.finalizeContent = undefined
    if (typeof finalize === 'function') {
      try {
        final = applyContentCallback(final, finalize, viewed, publishResult(final), `Tool ${exec.name}: finalizeContent`)
      } catch (error) {
        final = errorOutcome(error.message)
      }
    }
    this.emitResult(exec, final)
    return {
      text: final.text,
      model: final.model ?? final.text,
      contexts: (final.contexts ?? []).map((content) => ({ type: 'tools.context', callId: exec.callId, content })),
    }
  }
  emitResult(exec, final) {
    const payload = {
      callId: exec.callId,
      name: exec.name,
      isError: Boolean(final.isError),
      content: Array.isArray(final.model) ? final.model : [{ type: 'text', text: final.text }],
      ...(final.isError ? { error: { message: final.text.replace(/^Error:\s?/, '') } } : {}),
      ...(final.value !== undefined && !final.isError ? { value: final.value } : {}),
    }
    let frozen = payload
    try {
      const snapshot = snapshotJsonValue(payload)
      if (snapshot !== undefined) frozen = deepFreeze(snapshot)
    } catch { /* observation still receives the plain payload */ }
    const identity = {
      callId: exec.callId,
      name: exec.name,
      arguments: exec.args,
      agent: { id: exec.view?.agent?.id ?? 'mini-dsh' },
    }
    try { this.ctx.emit('tools/result', identity, frozen) }
    catch { /* Listener failures are contained and do not change the recorded result. */ }
  }
  async run(name, args, options) {
    const tool = this.items.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    validateArguments(tool.parameters, args)
    const outcome = await this.invoke(tool, args, options)
    if (outcome.passthrough) return outcome.raw
    if (Array.isArray(outcome.model)) throw new Error(`Tool ${name}: tools.run() does not return non-text content`)
    return outcome.text
  }
  async invoke(tool, args, { callId, signal, agent, deferred } = {}) {
    const output = this.outputs.get(tool.name)
    const controller = new AbortController()
    let unlink = () => {}
    if (signal?.aborted) controller.abort(signal.reason)
    else if (signal) {
      const onAbort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      unlink = () => signal.removeEventListener('abort', onAbort)
    }
    // The agent passes the call's deferred list. tools.run() has no log, so a
    // deferred message there fails closed instead of being dropped.
    const execution = {
      name: tool.name,
      callId,
      signal: controller.signal,
      agent,
      deferContext(context) {
        // Nested child contexts ride the parent run_code call. Other tools
        // still need an output schema, and tools.run() has nowhere to store them.
        if (!output && tool.name !== RUN_CODE_NAME) throw new Error('deferContext requires an output schema')
        if (!deferred) throw new Error('tools.run() does not store deferContext')
        pushDeferred(true, deferred, context)
      },
    }
    let timedOut = false
    const timer = output && tool.timeoutMs !== undefined ? setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`tool call timed out after ${tool.timeoutMs}ms`))
    }, tool.timeoutMs) : undefined
    try {
      let result
      if (output) {
        try { result = await tool.execute(args, execution) }
        catch (error) { if (!timedOut) throw error }
        if (timedOut) throw new Error(`tool call timed out after ${tool.timeoutMs}ms`)
      } else result = await tool.execute(args, execution)
      if (!output) {
        return {
          isError: false,
          passthrough: true,
          raw: result,
          text: String(result),
          model: String(result),
          content: [{ type: 'text', text: String(result) }],
          contexts: [],
        }
      }
      const rendered = this.renderOutput(tool.name, args, result, output)
      return { isError: false, text: rendered.text, model: rendered.model, value: rendered.value, content: rendered.content, contexts: [] }
    } finally {
      clearTimeout(timer)
      unlink()
    }
  }
}

function pushDeferred(enabled, bucket, context) {
  if (!enabled) throw new Error('deferContext requires an output schema')
  bucket.push(deferredContextText(context))
}

function attachDeferred(outcome, deferred) {
  if (!deferred?.length) return outcome
  return { ...outcome, contexts: [...deferred, ...(outcome.contexts ?? [])] }
}

function executionView(exec) {
  const view = { callId: exec.callId, name: exec.name, arguments: exec.args }
  const agentId = exec.view?.agent?.id
  if (typeof agentId === 'string' && agentId) view.agent = { id: agentId }
  try {
    const snapshot = snapshotJsonValue(view)
    if (snapshot !== undefined) return deepFreeze(snapshot)
  } catch { /* the callback still receives the call identity */ }
  return deepFreeze({ callId: exec.callId, name: exec.name })
}

function publicResult(raw) {
  if (raw.isError) {
    return {
      isError: true,
      error: { message: String(raw.text ?? '').replace(/^Error:\s?/, '') },
      content: raw.content ?? [{ type: 'text', text: raw.text }],
    }
  }
  return {
    isError: false,
    content: raw.content ?? [{ type: 'text', text: raw.text }],
    ...(raw.value !== undefined ? { value: raw.value } : {}),
  }
}

function publishResult(raw) {
  const view = publicResult(raw)
  try {
    const snapshot = snapshotJsonValue(view)
    if (snapshot !== undefined) return deepFreeze(snapshot)
  } catch { /* listeners still receive a plain view; the recorded text comes from the decision */ }
  return view
}

export class Workspace extends Service {
  constructor(ctx, config) {
    super(ctx, 'workspace')
    if (typeof config?.root !== 'string' || !isAbsolute(config.root)) throw new Error('Workspace must be an absolute path')
    this.root = config.root
  }
  // Relative paths join this.root; absolute paths pass through. Never process.cwd().
  resolve(path, label = 'path') {
    return resolveAgainstWorkspace(this.root, path, label)
  }
}

export class Session extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'session')
    if (typeof config.path !== 'string' || !isAbsolute(config.path)) throw new Error('Session path must be absolute')
    this.config = config
    this.path = config.path
    this.workspace = config.workspace
    this.wantWriter = config.writable !== false
    this.clock = config.clock ?? (() => new Date().toISOString())
    this.events = []
    this.incompleteTail = Buffer.alloc(0)
    this.unknown = []
    this.unknownStreams = []
    this.writable = false
    this.readonlyReason = 'Session is not open'
    this.listeners = new Set()
    this.queue = Promise.resolve()
    this.ctx.effect(() => () => this.release())
  }

  async [Service.init]() {
    await this.load()
  }

  load() {
    this.opening ??= this.open()
    return this.opening
  }

  async open() {
    const first = await readSession(this.path)
    this.events = first.events
    this.incompleteTail = Buffer.from(first.incompleteTail)
    const unknown = unknownOutcomes(first.events)
    const streams = unknownStreams(first.events)
    if (unknown.length || streams.length || !this.wantWriter) {
      this.finishReadOnly(unknown, streams)
      return
    }
    await mkdir(dirname(this.path), { recursive: true })
    this.lock = await acquireWriter(lockPathFor(this.path))
    try {
      const parsed = await readSession(this.path)
      this.events = parsed.events
      this.incompleteTail = Buffer.from(parsed.incompleteTail)
      const unknownNow = unknownOutcomes(parsed.events)
      const streamsNow = unknownStreams(parsed.events)
      if (unknownNow.length || streamsNow.length) {
        this.finishReadOnly(unknownNow, streamsNow)
        await this.release()
        return
      }
      if (parsed.incompleteTail.length) await preserveTail(this.path, parsed)
      this.handle = await open(this.path, 'a', 0o600)
      this.unknown = []
      this.unknownStreams = []
      this.writable = true
      this.readonlyReason = undefined
      if (!this.events.length && this.workspace) await this._append({ type: 'session.opened', workspace: this.workspace })
    } catch (error) {
      await this.release()
      this.writable = false
      if (!this.readonlyReason || this.readonlyReason === 'Session is not open') this.readonlyReason = error.message
      throw error
    }
  }

  finishReadOnly(unknown, streams = []) {
    this.unknown = unknown
    this.unknownStreams = streams
    this.writable = false
    this.readonlyReason = unknown.length || streams.length ? unknownReason(unknown, streams) : 'Session opened read-only'
  }

  // tools.context is deferred tool text or hook output stored on the log. It
  // is projected after the tool batch and before the next non-tool message,
  // and it is not recomputed by re-running the tool or hooks when the session
  // is reopened.
  get messages() {
    return projectSessionMessages(this.events)
  }

  history(after = 0) {
    assertCursor(after, 'history')
    return this.events.filter((event) => event.seq > after)
  }

  // Subscribe before copying history so a publish during the copy is queued
  // and delivered once, after the prefix, with no sequence gap.
  follow(after = 0, listener) {
    if (typeof listener !== 'function') throw new Error('follow requires a listener')
    assertCursor(after, 'follow')
    let cursor = after
    const queued = []
    let queueing = true
    const onLive = (event) => { if (queueing) queued.push(event); else emit(event) }
    this.listeners.add(onLive)
    try {
      for (const event of this.history(after)) emit(event)
      queueing = false
      for (const event of queued) emit(event)
    } catch (error) {
      this.listeners.delete(onLive)
      throw error
    }
    return () => this.listeners.delete(onLive)

    function emit(event) {
      if (event.seq <= cursor) return
      if (event.seq !== cursor + 1) throw new Error(`Session follow gap: expected sequence ${cursor + 1}, received ${event.seq}`)
      cursor = event.seq
      listener(event)
    }
  }

  async refresh() {
    if (this.writable) return []
    const parsed = await readSession(this.path)
    if (parsed.events.length < this.events.length) throw new Error('Session log shrank')
    for (let index = 0; index < this.events.length; index++) {
      if (parsed.events[index].seq !== this.events[index].seq) throw new Error('Session log diverged')
    }
    const fresh = parsed.events.slice(this.events.length)
    this.incompleteTail = Buffer.from(parsed.incompleteTail)
    this.unknown = unknownOutcomes(parsed.events)
    this.unknownStreams = unknownStreams(parsed.events)
    if (this.unknown.length || this.unknownStreams.length) this.readonlyReason = unknownReason(this.unknown, this.unknownStreams)
    else if (!this.wantWriter) this.readonlyReason = 'Session opened read-only'
    for (const event of fresh) {
      this.events.push(event)
      this.publish(event)
    }
    return fresh
  }

  append(input) {
    const run = this.queue.then(() => this._append(input))
    this.queue = run.then(() => {}, () => {})
    return run
  }

  async _append(input) {
    if (!this.writable) {
      const error = new Error(this.readonlyReason || 'Session is read-only')
      error.code = 'READONLY'
      throw error
    }
    const event = createEvent(input, this.events.length + 1, this.clock)
    assertEvent(event, event.seq)
    const next = [...this.events, event]
    unknownOutcomes(next)
    unknownStreams(next)
    const line = JSON.stringify(event) + '\n'
    try { await this.writeLine(line) }
    catch (error) {
      this.writable = false
      this.readonlyReason = `Session write failed: ${error.message}`
      const wrapped = new Error(this.readonlyReason)
      wrapped.code = 'CHECKPOINT'
      wrapped.cause = error
      throw wrapped
    }
    this.events.push(event)
    this.publish(event)
    return event
  }

  async writeLine(line) {
    if (this.config.write) return this.config.write(line)
    const buffer = Buffer.from(line)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesWritten } = await this.handle.write(buffer.subarray(offset))
      if (!bytesWritten) throw new Error('incomplete log write')
      offset += bytesWritten
    }
  }

  publish(event) {
    for (const listener of [...this.listeners]) {
      try { listener(event) }
      catch (error) { this.ctx.logger.error(error) }
    }
  }

  async release() {
    const handle = this.handle
    const lock = this.lock
    this.handle = undefined
    this.lock = undefined
    this.writable = false
    try { if (handle) await handle.close() }
    finally { lock?.release() }
  }
}

async function preserveTail(sessionPath, parsed) {
  const sidecar = `${sessionPath}.incomplete`
  const tail = parsed.incompleteTail
  let previous = Buffer.alloc(0)
  try { previous = await readFile(sidecar) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const already = previous.length >= tail.length && previous.subarray(-tail.length).equals(tail)
  if (!already) await appendFile(sidecar, tail, { mode: 0o600 })
  await truncate(sessionPath, parsed.size - tail.length)
}

function assertCursor(after, name) {
  if (!Number.isInteger(after) || after < 0) throw new Error(`${name} after must be a non-negative integer`)
}

// A failed log write blocks later model and tool work. Process crash is the
// durability target: the write syscall completing is the checkpoint. This does
// not promise durability across power loss or a kernel crash.
export class Checkpoint extends Service {
  static inject = ['session']
  constructor(ctx) {
    super(ctx, 'checkpoint')
    this.blocked = null
  }

  async commit(event) {
    if (this.blocked) {
      const error = new Error(`Checkpoint failed; dependent work is blocked: ${this.blocked}`)
      error.code = 'CHECKPOINT'
      throw error
    }
    try { return await this.ctx.session.append(event) }
    catch (error) {
      if (error.code === 'CHECKPOINT') this.blocked = error.message
      throw error
    }
  }

  async guard(event, work) {
    await this.commit(event)
    return work()
  }
}

// Providers register here. Each prepare() is one dispatch of a JSON body.
// The body is what gets recorded and sent. Credentials never belong in it.
// dispatch() yields that call's chunks once.
export class Model extends Service {
  constructor(ctx) { super(ctx, 'model'); this.providers = new Map() }
  register(provider) {
    if (typeof provider?.name !== 'string' || !provider.name) throw new Error('Provider name is required')
    if (typeof provider.prepare !== 'function' || typeof provider.dispatch !== 'function') throw new Error('Provider needs prepare and dispatch')
    if (this.providers.has(provider.name)) throw new Error(`Duplicate provider: ${provider.name}`)
    this.providers.set(provider.name, provider)
    return () => { if (this.providers.get(provider.name) === provider) this.providers.delete(provider.name) }
  }
  prepare(input) {
    if (this.providers.size !== 1) throw new Error('A single model provider is required')
    const provider = [...this.providers.values()][0]
    const body = structuredClone(provider.prepare(input))
    let used = false
    return {
      provider: provider.name,
      body,
      dispatch(signal) {
        if (used) throw new Error('Prepared model call was already used')
        used = true
        return provider.dispatch(structuredClone(body), signal)
      },
    }
  }
}
