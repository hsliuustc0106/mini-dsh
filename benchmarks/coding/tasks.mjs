const instructions = 'Only modify the named source file. Use read, glob, grep, write, or edit; shell and skills are unavailable. Independent tests will run after you finish. The solution must be self-contained, with synchronous exports and no top-level await: only URL and URLSearchParams are available from node:url, and process, filesystem, network, and other Node APIs are unavailable.'

export const tasks = [
  {
    id: 'query', file: 'src/query.mjs',
    prompt: `Fix parseQuery in src/query.mjs. It must return a plain object whose own keys are the decoded query parameter names and whose values are arrays of all corresponding decoded values in order. Accept a leading ? and an empty query, preserve empty values, and follow URLSearchParams decoding (including + for spaces). Every name, including __proto__ and constructor, must be an ordinary own key. For example, '?tag=a&tag=b&empty=' yields { tag: ['a', 'b'], empty: [''] }. ${instructions}`,
  },
  {
    id: 'ranges', file: 'src/ranges.mjs',
    prompt: `Implement mergeRanges in src/ranges.mjs. Its input is an array of inclusive [start, end] pairs of safe integers. Return new pairs sorted by start, merging overlapping or adjacent ranges (so [1, 2] and [3, 4] become [1, 4]). Do not mutate the input or its pairs. Return [] for an empty input. Reject a non-array, a malformed pair, a non-safe-integer endpoint, or start > end with TypeError. ${instructions}`,
  },
  {
    id: 'cart', file: 'src/cart.mjs',
    prompt: `Extend cartTotal in src/cart.mjs to accept cartTotal(items, discountPercent = 0). Each item has priceCents and quantity, both nonnegative safe integers. Sum all line totals, apply the percentage discount to the subtotal, and round the final total to the nearest integer cent with Math.round. The discount must be a finite number between 0 and 100 inclusive and may be fractional. Reject invalid items, quantities, prices, or discounts with TypeError. Do not mutate the items. For example, one 101-cent item at 50% costs 51 cents. ${instructions}`,
  },
  {
    id: 'config', file: 'src/config.mjs',
    prompt: `Fix mergeOptions in src/config.mjs to merge defaults and overrides recursively. The inputs are plain objects containing only JSON values. Recursively merge object values when both sides are objects; otherwise the override replaces the default, including null, false, 0, empty strings, and arrays. Return a deep copy: no object or array in the result may be shared with either input, and neither input may be mutated. New keys from either side must be retained. For example, { ui: { theme: 'light', size: 1 } } merged with { ui: { size: 0 } } yields { ui: { theme: 'light', size: 0 } }. ${instructions}`,
  },
]
