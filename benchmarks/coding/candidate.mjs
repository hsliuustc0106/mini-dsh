import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { deserialize, serialize } from 'node:v8'

// This process runs inside the container. It reports values, never test verdicts.
const getPrototypeOf = Object.getPrototypeOf, objectPrototype = Object.prototype
const arrayPrototype = Array.prototype
const symbols = Object.getOwnPropertySymbols, enumerable = Object.prototype.propertyIsEnumerable
function plainStructure(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return true
  seen.add(value)
  if (getPrototypeOf(value) !== (Array.isArray(value) ? arrayPrototype : objectPrototype)) return false
  if (symbols(value).some((key) => enumerable.call(value, key))) return false
  return Object.values(value).every((item) => plainStructure(item, seen))
}
let candidate, loadError
try { candidate = await import(pathToFileURL(process.argv[2]).href) } catch (error) { loadError = error }

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, args, mutations = [] } = deserialize(Buffer.from(line, 'base64'))
  let response, asynchronous = false
  try {
    if (loadError) throw loadError
    if (typeof candidate[method] !== 'function') throw new Error(`Missing export: ${method}`)
    const returned = candidate[method](...args)
    asynchronous = !!returned && typeof returned.then === 'function'
    const value = asynchronous ? await returned : returned
    const prototype = value && typeof value === 'object'
      ? getPrototypeOf(value) === null ? 'null' : getPrototypeOf(value) === objectPrototype ? 'object' : 'other'
      : null
    // V8 serialization normalizes custom prototypes; preserve this information.
    const plain = plainStructure(value)
    const plainChildren = value && typeof value === 'object' && !symbols(value).some((key) => enumerable.call(value, key)) && Object.values(value).every((item) => plainStructure(item))
    const argsAfterCall = structuredClone(args)
    for (const { path, action, value: replacement } of mutations) {
      const parent = path.slice(0, -1).reduce((object, key) => object[key], value)
      const key = path.at(-1)
      if (action === 'push') parent[key].push(replacement)
      else parent[key] = replacement
    }
    response = { id, ok: true, value, prototype, plain, plainChildren, asynchronous, argsAfterCall, argsAfterMutation: args }
  } catch (error) {
    response = { id, ok: false, asynchronous, error: { name: String(error?.name), message: String(error?.message ?? error).slice(0, 500) } }
  }
  try { process.stdout.write(`mini-dsh-response:${serialize(response).toString('base64')}\n`) }
  catch { process.stdout.write(`mini-dsh-response:${serialize({ id, ok: false, error: { name: 'Error', message: 'Result is not serializable' } }).toString('base64')}\n`) }
}
