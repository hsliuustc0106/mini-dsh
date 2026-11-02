import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

function equalQuery(actual, expected) {
  assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual))
  assert.ok(Object.getPrototypeOf(actual) === Object.prototype || Object.getPrototypeOf(actual) === null)
  assert.deepEqual({ ...actual }, expected)
}

// These checks live outside each model workspace and run after the turn.
const cases = {
  query: [
    ['repeated keys and empty values', ({ parseQuery }) => equalQuery(parseQuery('?tag=a&tag=b&empty='), { tag: ['a', 'b'], empty: [''] })],
    ['percent and plus decoding', ({ parseQuery }) => equalQuery(parseQuery('first+name=Ada+Lovelace&x=%E2%9C%93&x=a%26b'), { 'first name': ['Ada Lovelace'], x: ['✓', 'a&b'] })],
    ['empty input', ({ parseQuery }) => equalQuery(parseQuery(''), {})],
    ['prototype-like keys are own properties', ({ parseQuery }) => equalQuery(parseQuery('__proto__=x&constructor=a&__proto__=y'), JSON.parse('{"__proto__":["x","y"],"constructor":["a"]}'))],
  ],
  ranges: [
    ['overlap and adjacency', ({ mergeRanges }) => assert.deepEqual(mergeRanges([[8, 10], [1, 3], [3, 5], [6, 7]]), [[1, 10]])],
    ['disjoint, negative, singleton, and empty', ({ mergeRanges }) => {
      assert.deepEqual(mergeRanges([[4, 4], [-3, -2], [9, 11]]), [[-3, -2], [4, 4], [9, 11]])
      assert.deepEqual(mergeRanges([]), [])
    }],
    ['input is not mutated or reused', ({ mergeRanges }) => {
      const input = [[4, 6], [1, 2]], before = structuredClone(input)
      const result = mergeRanges(input)
      assert.deepEqual(input, before)
      result[0][0] = 99
      assert.deepEqual(input, before)
    }],
    ['invalid ranges raise TypeError', ({ mergeRanges }) => {
      for (const input of [null, [1], [[1]], [[1, 2, 3]], [[2, 1]], [[0, 1.5]], [[0, Infinity]], [[0, Number.MAX_SAFE_INTEGER + 1]]]) {
        assert.throws(() => mergeRanges(input), TypeError)
      }
    }],
  ],
  cart: [
    ['subtotal and empty cart', ({ cartTotal }) => {
      assert.equal(cartTotal([{ priceCents: 125, quantity: 2 }, { priceCents: 10, quantity: 3 }]), 280)
      assert.equal(cartTotal([]), 0)
    }],
    ['discount and final rounding', ({ cartTotal }) => {
      assert.equal(cartTotal([{ priceCents: 101, quantity: 1 }], 50), 51)
      assert.equal(cartTotal([{ priceCents: 199, quantity: 2 }], 12.5), 348)
      assert.equal(cartTotal([{ priceCents: 199, quantity: 2 }], 100), 0)
    }],
    ['invalid inputs raise TypeError', ({ cartTotal }) => {
      for (const items of [null, [{}], [{ priceCents: -1, quantity: 1 }], [{ priceCents: 1, quantity: 1.5 }], [{ priceCents: Infinity, quantity: 1 }]]) assert.throws(() => cartTotal(items), TypeError)
      for (const discount of [-1, 101, NaN, Infinity, '5', null]) assert.throws(() => cartTotal([], discount), TypeError)
    }],
    ['input is not mutated', ({ cartTotal }) => {
      const items = [{ priceCents: 0, quantity: 5 }, { priceCents: 7, quantity: 0 }], before = structuredClone(items)
      assert.equal(cartTotal(items, 10), 0)
      assert.deepEqual(items, before)
    }],
  ],
  config: [
    ['nested merge keeps defaults and new keys', ({ mergeOptions }) => assert.deepEqual(mergeOptions({ ui: { theme: 'light', size: 1 }, a: 1 }, { ui: { size: 0 }, b: 2 }), { ui: { theme: 'light', size: 0 }, a: 1, b: 2 })],
    ['falsy values, null and arrays replace defaults', ({ mergeOptions }) => assert.deepEqual(mergeOptions({ a: true, b: 3, c: 'x', d: { x: 1 }, e: [1, 2] }, { a: false, b: 0, c: '', d: null, e: [3] }), { a: false, b: 0, c: '', d: null, e: [3] })],
    ['nested inputs and result do not share mutable values', ({ mergeOptions }) => {
      const defaults = { onlyDefault: { list: [{ n: 1 }] }, shared: { a: [1] } }
      const overrides = { shared: { b: [{ n: 2 }] }, onlyOverride: { list: [3] } }
      const before = structuredClone([defaults, overrides]), result = mergeOptions(defaults, overrides)
      assert.deepEqual([defaults, overrides], before)
      result.onlyDefault.list[0].n = 9
      result.shared.a.push(4)
      result.shared.b[0].n = 9
      result.onlyOverride.list.push(4)
      assert.deepEqual([defaults, overrides], before)
    }],
    ['object replacement in both directions', ({ mergeOptions }) => assert.deepEqual(mergeOptions({ a: 1, b: { x: 1 }, c: [1] }, { a: { x: 2 }, b: 7, c: { y: 3 } }), { a: { x: 2 }, b: 7, c: { y: 3 } })],
    ['JSON keys that resemble prototype properties are retained', ({ mergeOptions }) => {
      const defaults = JSON.parse('{"__proto__":{"a":1},"constructor":{"mode":"safe"}}')
      const overrides = JSON.parse('{"__proto__":{"b":2},"constructor":{"added":true}}')
      const expected = JSON.parse('{"__proto__":{"a":1,"b":2},"constructor":{"mode":"safe","added":true}}')
      const result = mergeOptions(defaults, overrides)
      assert.equal(Object.hasOwn(result, '__proto__'), true)
      assert.deepEqual(JSON.parse(JSON.stringify(result)), expected)
    }],
  ],
}

const [task, file] = process.argv.slice(2)
if (!cases[task] || !file) throw new Error('Usage: quality.mjs TASK SOURCE_FILE')
let module, loadError
try { module = await import(pathToFileURL(file).href) } catch (error) { loadError = error }
const checks = []
for (const [name, check] of cases[task]) {
  try {
    if (loadError) throw loadError
    await check(module)
    checks.push({ name, passed: true })
  } catch (error) {
    checks.push({ name, passed: false, error: String(error.message ?? error).slice(0, 500) })
  }
}
process.stdout.write(`mini-dsh-quality:${JSON.stringify({ checks })}\n`)
