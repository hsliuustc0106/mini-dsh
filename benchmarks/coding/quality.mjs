import assert from 'node:assert/strict'

function equalQuery({ value: actual, prototype, plainChildren }, expected) {
  assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual))
  assert.ok(prototype === 'object' || prototype === 'null')
  assert.ok(plainChildren)
  assert.deepEqual({ ...actual }, expected)
}

// Assertions and expected values stay in the host process, outside the candidate.
const cases = {
  query: [
    ['repeated keys and empty values', async ({ result }) => equalQuery(await result('parseQuery', ['?tag=a&tag=b&empty=']), { tag: ['a', 'b'], empty: [''] })],
    ['percent and plus decoding', async ({ result }) => equalQuery(await result('parseQuery', ['first+name=Ada+Lovelace&x=%E2%9C%93&x=a%26b']), { 'first name': ['Ada Lovelace'], x: ['✓', 'a&b'] })],
    ['empty input', async ({ result }) => equalQuery(await result('parseQuery', ['']), {})],
    ['prototype-like keys are own properties', async ({ result }) => equalQuery(await result('parseQuery', ['__proto__=x&constructor=a&__proto__=y']), JSON.parse('{"__proto__":["x","y"],"constructor":["a"]}'))],
  ],
  ranges: [
    ['overlap and adjacency', async ({ value }) => assert.deepEqual(await value('mergeRanges', [[8, 10], [1, 3], [3, 5], [6, 7]]), [[1, 10]])],
    ['disjoint, negative, singleton, and empty', async ({ value }) => {
      assert.deepEqual(await value('mergeRanges', [[4, 4], [-3, -2], [9, 11]]), [[-3, -2], [4, 4], [9, 11]])
      assert.deepEqual(await value('mergeRanges', []), [])
    }],
    ['input is not mutated or reused', async ({ result }) => {
      const input = [[4, 6], [1, 2]]
      const response = await result('mergeRanges', [input], [{ path: [0, 0], value: 99 }])
      assert.deepEqual(response.argsAfterCall, [input])
      assert.deepEqual(response.argsAfterMutation, [input])
    }],
    ['invalid ranges raise TypeError', async ({ value }) => {
      for (const input of [null, [1], [[1]], [[1, 2, 3]], [[2, 1]], [[0, 1.5]], [[0, Infinity]], [[0, Number.MAX_SAFE_INTEGER + 1]]]) {
        await assert.rejects(() => value('mergeRanges', input), TypeError)
      }
    }],
  ],
  cart: [
    ['subtotal and empty cart', async ({ value }) => {
      assert.equal(await value('cartTotal', [{ priceCents: 125, quantity: 2 }, { priceCents: 10, quantity: 3 }]), 280)
      assert.equal(await value('cartTotal', []), 0)
    }],
    ['discount and final rounding', async ({ value }) => {
      assert.equal(await value('cartTotal', [{ priceCents: 101, quantity: 1 }], 50), 51)
      assert.equal(await value('cartTotal', [{ priceCents: 199, quantity: 2 }], 12.5), 348)
      assert.equal(await value('cartTotal', [{ priceCents: 199, quantity: 2 }], 100), 0)
    }],
    ['invalid inputs raise TypeError', async ({ value }) => {
      for (const items of [null, [{}], [{ priceCents: -1, quantity: 1 }], [{ priceCents: 1, quantity: 1.5 }], [{ priceCents: Infinity, quantity: 1 }]]) await assert.rejects(() => value('cartTotal', items), TypeError)
      for (const discount of [-1, 101, NaN, Infinity, '5', null]) await assert.rejects(() => value('cartTotal', [], discount), TypeError)
    }],
    ['input is not mutated', async ({ result }) => {
      const items = [{ priceCents: 0, quantity: 5 }, { priceCents: 7, quantity: 0 }]
      const response = await result('cartTotal', [items, 10])
      assert.equal(response.value, 0)
      assert.deepEqual(response.argsAfterCall, [items, 10])
    }],
  ],
  config: [
    ['nested merge keeps defaults and new keys', async ({ value }) => assert.deepEqual(await value('mergeOptions', { ui: { theme: 'light', size: 1 }, a: 1 }, { ui: { size: 0 }, b: 2 }), { ui: { theme: 'light', size: 0 }, a: 1, b: 2 })],
    ['falsy values, null and arrays replace defaults', async ({ value }) => assert.deepEqual(await value('mergeOptions', { a: true, b: 3, c: 'x', d: { x: 1 }, e: [1, 2] }, { a: false, b: 0, c: '', d: null, e: [3] }), { a: false, b: 0, c: '', d: null, e: [3] })],
    ['nested inputs and result do not share mutable values', async ({ result }) => {
      const defaults = { onlyDefault: { list: [{ n: 1 }] }, shared: { a: [1] } }
      const overrides = { shared: { b: [{ n: 2 }] }, onlyOverride: { list: [3] } }
      const mutations = [
        { path: ['onlyDefault', 'list', 0, 'n'], value: 9 },
        { path: ['shared', 'a'], action: 'push', value: 4 },
        { path: ['shared', 'b', 0, 'n'], value: 9 },
        { path: ['onlyOverride', 'list'], action: 'push', value: 4 },
      ]
      const response = await result('mergeOptions', [defaults, overrides], mutations)
      assert.deepEqual(response.argsAfterCall, [defaults, overrides])
      assert.deepEqual(response.argsAfterMutation, [defaults, overrides])
    }],
    ['object replacement in both directions', async ({ value }) => assert.deepEqual(await value('mergeOptions', { a: 1, b: { x: 1 }, c: [1] }, { a: { x: 2 }, b: 7, c: { y: 3 } }), { a: { x: 2 }, b: 7, c: { y: 3 } })],
    ['JSON keys that resemble prototype properties are retained', async ({ result }) => {
      const defaults = JSON.parse('{"__proto__":{"a":1},"constructor":{"mode":"safe"}}')
      const overrides = JSON.parse('{"__proto__":{"b":2},"constructor":{"added":true}}')
      const expected = JSON.parse('{"__proto__":{"a":1,"b":2},"constructor":{"mode":"safe","added":true}}')
      const response = await result('mergeOptions', [defaults, overrides])
      assert.equal(Object.hasOwn(response.value, '__proto__'), true)
      assert.deepEqual(JSON.parse(JSON.stringify(response.value)), expected)
    }],
  ],
}

export async function checkQuality(task, sandbox) {
  if (!cases[task]) throw new Error(`Unknown task: ${task}`)
  const result = async (method, args, mutations) => {
    const response = await sandbox.request(method, args, mutations)
    if (response.asynchronous) throw new Error('Candidate must return synchronously')
    if (!response.ok) {
      const ErrorType = response.error?.isTypeError ? TypeError : Error
      const error = new ErrorType(response.error?.message ?? 'Candidate failed')
      error.name = response.error?.name ?? 'Error'
      throw error
    }
    if (task === 'config') assert.equal(response.dataProperties, true, 'Candidate result has an enumerable accessor property')
    return response
  }
  const value = async (method, ...args) => {
    const response = await result(method, args)
    assert.ok(response.plain, 'Candidate result has a non-plain prototype')
    return response.value
  }
  const checks = []
  for (const [name, check] of cases[task]) {
    try { await check({ result, value }); checks.push({ name, passed: true }) }
    catch (error) { checks.push({ name, passed: false, error: String(error.message ?? error).slice(0, 500) }) }
    if (sandbox.error) throw sandbox.error
  }
  return { checks, passed: checks.every((check) => check.passed) }
}
