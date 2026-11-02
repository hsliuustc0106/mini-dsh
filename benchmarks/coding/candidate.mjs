import { createInterface } from 'node:readline'
import { writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { deserialize, serialize } from 'node:v8'
import 'ses'
import { ModuleSource } from '@endo/module-source'

// The container protects the host. SES also keeps candidate code away from
// this worker's stdin, stdout, and mutable intrinsics.
// Allow assignments that shadow inherited keys such as `constructor`, while
// keeping the intrinsic prototypes frozen.
lockdown({ overrideTaming: 'severe' })
const getPrototypeOf = Object.getPrototypeOf, objectPrototype = Object.prototype
const arrayPrototype = Array.prototype
const symbols = Object.getOwnPropertySymbols, enumerable = Object.prototype.propertyIsEnumerable
const descriptor = Object.getOwnPropertyDescriptor
function dataStructure(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return true
  seen.add(value)
  return Object.keys(value).every((key) => {
    const property = descriptor(value, key)
    return property && Object.hasOwn(property, 'value') && dataStructure(property.value, seen)
  })
}
function plainStructure(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return true
  seen.add(value)
  if (getPrototypeOf(value) !== (Array.isArray(value) ? arrayPrototype : objectPrototype)) return false
  if (symbols(value).some((key) => enumerable.call(value, key))) return false
  return Object.values(value).every((item) => plainStructure(item, seen))
}
// Sent before evaluating candidate code, so the host can distinguish a
// candidate that stops responding from a worker that could not start.
writeSync(1, 'mini-dsh-worker-ready\n')
let candidate, loadError
try {
  const source = new ModuleSource(await readFile(process.argv[2], 'utf8'))
  const safeURL = harden(URL), safeParams = harden(URLSearchParams)
  const quiet = () => {}
  const console = harden(Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((name) => [name, quiet])))
  const compartment = new Compartment({
    globals: { URL: safeURL, URLSearchParams: safeParams, console },
    modules: {
      candidate: { source },
      'node:url': { source: { imports: [], exports: ['URL', 'URLSearchParams'], execute(env) { env.URL = safeURL; env.URLSearchParams = safeParams } } },
    },
    resolveHook: (specifier) => specifier,
    __options__: true,
  })
  candidate = (await compartment.import('candidate')).namespace
} catch (error) { loadError = error }

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, args, mutations = [] } = deserialize(Buffer.from(line, 'base64'))
  let response, asynchronous = false, thrownByCandidate = false
  try {
    if (loadError) throw loadError
    if (typeof candidate[method] !== 'function') throw new Error(`Missing export: ${method}`)
    let returned
    try { returned = candidate[method](...args) }
    catch (error) { thrownByCandidate = true; throw error }
    asynchronous = !!returned && typeof returned.then === 'function'
    const value = asynchronous ? await returned : returned
    const prototype = value && typeof value === 'object'
      ? getPrototypeOf(value) === null ? 'null' : getPrototypeOf(value) === objectPrototype ? 'object' : 'other'
      : null
    // V8 serialization normalizes custom prototypes and accessors; preserve
    // this information before serializing the candidate's result.
    const dataProperties = dataStructure(value)
    const plain = plainStructure(value)
    const plainChildren = value && typeof value === 'object' && !symbols(value).some((key) => enumerable.call(value, key)) && Object.values(value).every((item) => plainStructure(item))
    const argsAfterCall = structuredClone(args)
    for (const { path, action, value: replacement } of mutations) {
      const parent = path.slice(0, -1).reduce((object, key) => object[key], value)
      const key = path.at(-1)
      if (action === 'push') parent[key].push(replacement)
      else parent[key] = replacement
    }
    response = { id, ok: true, value, prototype, plain, plainChildren, dataProperties, asynchronous, argsAfterCall, argsAfterMutation: args }
  } catch (error) {
    response = { id, ok: false, asynchronous, error: { name: String(error?.name), message: String(error?.message ?? error).slice(0, 500), isTypeError: thrownByCandidate && error instanceof TypeError } }
  }
  try { process.stdout.write(`mini-dsh-response:${serialize(response).toString('base64')}\n`) }
  catch { process.stdout.write(`mini-dsh-response:${serialize({ id, ok: false, error: { name: 'Error', message: 'Result is not serializable' } }).toString('base64')}\n`) }
}
