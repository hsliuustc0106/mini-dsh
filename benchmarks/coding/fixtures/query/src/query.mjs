export function parseQuery(input) {
  const result = {}
  for (const [key, value] of new URLSearchParams(input)) result[key] = value
  return result
}
