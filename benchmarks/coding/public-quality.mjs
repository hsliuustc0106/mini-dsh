import assert from 'node:assert/strict'

// These examples are public feedback, separate from the final quality checks.
// Assertions run in the host; only the candidate runs in the sandbox.
const cases = [
  ['Nested merges must return independent objects and arrays', async (result) => {
    const defaults = { ui: { colors: ['blue'], size: 1 } }
    const overrides = { ui: { size: 2, options: { visible: true } } }
    const response = await result([defaults, overrides], [{ path: ['ui', 'colors'], action: 'push', value: 'red' }])
    assert.equal(response.plain, true)
    assert.deepEqual(response.value, { ui: { colors: ['blue', 'red'], size: 2, options: { visible: true } } })
    assert.deepEqual(response.argsAfterCall, [defaults, overrides])
    assert.deepEqual(response.argsAfterMutation, [defaults, overrides])
  }],
  ['JSON keys including __proto__ and constructor must remain own data properties', async (result) => {
    const defaults = JSON.parse('{"__proto__":{"left":1},"nested":{"constructor":{"mode":"safe"}}}')
    const overrides = JSON.parse('{"__proto__":{"right":2},"nested":{"constructor":{"enabled":true},"__proto__":{"new":3}}}')
    const expected = JSON.parse('{"__proto__":{"left":1,"right":2},"nested":{"constructor":{"mode":"safe","enabled":true},"__proto__":{"new":3}}}')
    const response = await result([defaults, overrides])
    assert.equal(response.plain, true)
    assert.equal(Object.hasOwn(response.value, '__proto__'), true)
    assert.equal(Object.hasOwn(response.value.nested, '__proto__'), true)
    assert.deepEqual(response.value, expected)
  }],
]

export async function checkPublicConfig(sandbox) {
  const result = async (args, mutations = []) => {
    const response = await sandbox.request('mergeOptions', args, mutations)
    if (!response.ok || response.asynchronous) throw new Error('Candidate failed')
    return response
  }
  const checks = []
  for (const [name, check] of cases) {
    try { await check(result); checks.push({ name, passed: true }) }
    catch { checks.push({ name, passed: false }) }
    if (sandbox.error) throw sandbox.error
  }
  return { checks, passed: checks.every((check) => check.passed) }
}
