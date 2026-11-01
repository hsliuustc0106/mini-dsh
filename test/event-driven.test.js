import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSession } from '../src/log.js'
import { project } from '../src/trajectory.js'
import { renderPage } from '../src/viewer.js'

// The append-only session log is the source of truth. Projecting a full log
// and then a shorter or different one must drop any stream fragment, ask, or
// tool result that the later log does not contain. A second mutable store
// fails these checks.

const fixture = new URL('../fixtures/write-hello/session.jsonl', import.meta.url)
const clock = '2026-01-01T00:00:00.000Z'

function recorded(records) {
  return records.map((event, index) => ({ ...event, seq: index + 1, time: clock }))
}

function cards(view) {
  return view.turns.flatMap((turn) => turn.cards)
}

function toolCard(view) {
  return cards(view).find((card) => card.kind === 'tool')
}

test('trajectory and the viewer recompute stream, ask, and tool facts from the log', async () => {
  const events = (await readSession(fixture)).events
  const snapshot = structuredClone(events)
  assert.equal(events[8].type, 'message')
  assert.equal(events[9].type, 'permission.decided')
  assert.equal(events[10].type, 'tool.started')
  assert.equal(events[15].text, 'Wrote he')

  const full = project(events)
  const beforeAsk = project(events.slice(0, 9))
  const started = project(events.slice(0, 11))
  const midReply = project(events.slice(0, 16))

  assert.equal(toolCard(full).decision, 'allow')
  assert.equal(toolCard(full).status, 'ok')
  assert.equal(toolCard(full).result, 'File written.')
  assert.equal(cards(full).find((card) => card.kind === 'assistant').content, 'Wrote hello.txt.')
  assert.deepEqual(full.overview.at(-1).tokens.map((token) => token.text), ['Wrote he', 'llo.txt.'])

  assert.equal(toolCard(beforeAsk).decision, undefined)
  assert.equal(toolCard(beforeAsk).result, undefined)
  assert.equal(toolCard(beforeAsk).status, 'unknown')
  assert.equal(beforeAsk.overview.some((span) => span.kind === 'tool'), false)
  assert.equal(JSON.stringify(beforeAsk).includes('File written.'), false)
  assert.equal(JSON.stringify(beforeAsk).includes('Wrote hello.txt.'), false)

  assert.equal(toolCard(started).decision, 'allow')
  assert.equal(toolCard(started).result, undefined)
  assert.equal(toolCard(started).status, 'unknown')
  assert.deepEqual(started.overview.find((span) => span.kind === 'tool').status, 'unknown')
  assert.equal(started.overview.find((span) => span.kind === 'tool').endTime, null)
  assert.equal(JSON.stringify(started).includes('File written.'), false)

  const partial = cards(midReply).find((card) => card.partial)
  assert.equal(partial.content, 'Wrote he')
  assert.equal(partial.status, 'unknown')
  assert.equal(cards(midReply).some((card) => card.content === 'Wrote hello.txt.'), false)
  assert.deepEqual(midReply.overview.at(-1).tokens.map((token) => token.text), ['Wrote he'])
  assert.equal(midReply.overview.at(-1).status, 'unknown')

  const denied = project(recorded([
    { type: 'message', message: { role: 'user', content: 'Do not write' } },
    { type: 'model.request', provider: 'fake', body: { model: 'fake' } },
    { type: 'stream.started' },
    { type: 'stream.delta', stream: 3, text: 'No' },
    { type: 'stream.ended', stream: 3, finish: 'tool_calls' },
    { type: 'message', message: { role: 'assistant', content: 'No', tool_calls: [
      { id: 'write-hello', type: 'function', function: { name: 'write', arguments: '{"path":"no.txt","content":"x"}' } },
    ] } },
    { type: 'permission.decided', callId: 'write-hello', name: 'write', arguments: { path: 'no.txt', content: 'x' }, workspace: '/tmp/elsewhere', decision: 'deny', reason: 'denied' },
    { type: 'message', message: { role: 'tool', tool_call_id: 'write-hello', content: 'Error: denied' } },
  ]))
  assert.equal(denied.turns[0].cards.find((card) => card.kind === 'assistant').content, 'No')
  assert.deepEqual(denied.overview.find((span) => span.kind === 'model').tokens.map((token) => token.text), ['No'])
  assert.equal(toolCard(denied).decision, 'deny')
  assert.equal(toolCard(denied).status, 'deny')
  assert.equal(toolCard(denied).result, 'Error: denied')
  assert.equal(denied.overview.some((span) => span.kind === 'tool'), false)
  assert.equal(JSON.stringify(denied).includes('File written.'), false)
  assert.equal(JSON.stringify(denied).includes('Wrote he'), false)

  assert.deepEqual(project(events), full)
  assert.deepEqual(events, snapshot)

  const finishedPage = renderPage(full)
  const openPage = renderPage(started)
  const partialPage = renderPage(midReply)
  const deniedPage = renderPage(denied)
  assert.match(finishedPage, /File written\./)
  assert.match(finishedPage, /Wrote hello\.txt\./)
  assert.equal(openPage.includes('File written.'), false)
  assert.match(openPage, /Outcome unknown/)
  assert.equal(partialPage.includes('Wrote hello.txt.'), false)
  assert.match(partialPage, /Wrote he/)
  assert.equal(deniedPage.includes('File written.'), false)
  assert.match(deniedPage, /Denied/)
  assert.equal(renderPage(project(events)), finishedPage)
})
