import { createServer } from 'node:http'
import { Service } from '@deepseek-ai/cordis'
import { prototypePage } from './prototype.js'
import { project } from './trajectory.js'

const HOST = '127.0.0.1'

export function viewerSettings(env = process.env) {
  const raw = env.MINI_VIEW_PORT
  let port = 7483
  if (raw != null && raw !== '') {
    if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error(`MINI_VIEW_PORT is invalid: ${raw}`)
    port = Number(raw)
  }
  return { port }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function barText(span) {
  if (span.status === 'unknown' || span.status === 'error' || span.status === 'open') return `${span.kind} ${span.status}`
  return span.kind
}

function grow(span) {
  return Math.max(span.durationMs ?? 0, 1)
}

// The page is a view of one projection. It has no prompt and no approval control.
export function renderPage(projection) {
  const unknownStreams = projection.unknownStreams ?? []
  const unknown = [
    projection.unknown.length ? `unknown tool outcome for ${projection.unknown.join(', ')}` : '',
    unknownStreams.length ? `unknown stream outcome for ${unknownStreams.join(', ')}` : '',
  ].filter(Boolean).join('; ')
  const banner = unknown
    ? `<p class="banner">${esc(unknown)}. These records may still be in progress. If the session has stopped, inspect the workspace and start a new session.</p>`
    : ''
  const bars = projection.overview.map((span) => {
    const state = span.status !== 'ok' ? ` ${span.status}` : ''
    const title = [span.kind, span.provider, span.name, span.callId, span.status, span.time, span.endTime].filter(Boolean).join(' · ')
    return `<button type="button" class="bar ${esc(span.kind)}${esc(state)}" data-seq="${span.seq}" style="flex:${grow(span)} ${grow(span)} 4.5rem" title="${esc(title)}">${esc(barText(span))}</button>`
  }).join('')
  const overview = `<div class="overview">${bars || '<p class="empty">No timing spans yet.</p>'}</div>${tokenStrip(projection)}`
  const conversation = projection.turns.length
    ? projection.turns.map(conversationTurn).join('')
    : '<p class="empty">No conversation turns yet.</p>'
  const sections = []
  if (projection.preamble.length) sections.push(section('Session', null, projection.preamble))
  for (const turn of projection.turns) sections.push(section(`Turn ${turn.id}`, turn.input, turn.rows))
  const ledger = sections.length ? sections.join('') : '<p class="empty">No session events.</p>'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mini-dsh trajectory</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 15px/1.45 ui-sans-serif, system-ui, sans-serif; color: #1c1915; background: #f4f1ea; }
  main { max-width: 1160px; margin: 0 auto; padding: 28px 24px 64px; }
  .page-header { display: flex; align-items: end; justify-content: space-between; gap: 16px; padding-bottom: 20px; border-bottom: 1px solid #dcd4c8; }
  .wordmark { display: inline-block; margin: 0; padding-bottom: 2px; border-bottom: 3px solid #8a4518; font: 700 32px/1 Georgia, "Iowan Old Style", serif; letter-spacing: -0.045em; white-space: nowrap; }
  .meta { color: #655e56; margin: 6px 0 0; }
  .session-meta { text-align: right; font-size: 13px; }
  .eyebrow, h2 { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #6d655c; }
  .timing { padding: 20px 0 22px; border-bottom: 1px solid #dcd4c8; }
  .timing-heading, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .legend { display: flex; gap: 14px; padding: 0; margin: 0; list-style: none; color: #4e473f; font-size: 12px; }
  .legend i { display: inline-block; width: 0.7rem; height: 0.7rem; margin-right: 6px; border-radius: 2px; vertical-align: -1px; }
  .swatch.input { background: #2f5d8c; }
  .swatch.model { background: #a56b12; }
  .swatch.tool { background: #2c6e45; }
  .overview { display: flex; gap: 4px; align-items: stretch; min-height: 36px; overflow-x: auto; padding: 2px; }
  .bar { border: 0; border-radius: 5px; color: #fff; padding: 7px 10px; text-align: left; cursor: pointer; min-width: 4.5rem; white-space: nowrap; font-size: 12px; }
  .bar.input { background: #2f5d8c; }
  .bar.model { background: #a56b12; }
  .bar.tool { background: #2c6e45; }
  .bar.unknown { background: repeating-linear-gradient(135deg, #8c3030, #8c3030 8px, #a85050 8px, #a85050 16px); }
  .bar.error, .bar.deny { background: #8c3030; }
  .bar.open { background: #6e6246; }
  .stream-heading { margin: 12px 0 6px; color: #6d655c; font-size: 12px; }
  .tokens { display: flex; gap: 4px; align-items: center; overflow-x: auto; padding: 2px 2px 5px; margin: 0; list-style: none; }
  .tokens li { flex: none; }
  .stream-label { color: #786451; font: 700 11px ui-monospace, monospace; margin: 0 5px 0 7px; }
  .token { display: inline-flex; gap: 6px; align-items: baseline; border: 1px solid #e3dbd0; background: #fffdf8; border-radius: 5px; padding: 4px 7px; cursor: pointer; font: 12px/1.3 ui-monospace, monospace; white-space: pre; }
  .token time { color: #786f65; font-size: 11px; font-variant-numeric: tabular-nums; }
  .trajectory-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(250px, 310px); gap: 28px; align-items: start; padding-top: 24px; }
  .section-heading { margin-bottom: 14px; }
  .section-note { color: #786f65; font-size: 12px; }
  .conversation-turn + .conversation-turn { margin-top: 26px; }
  .turn-number { margin: 0 0 10px; color: #786f65; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
  .cards { display: grid; gap: 8px; }
  .card { background: #fffdf8; border: 1px solid #e3dbd0; border-left: 3px solid #a56b12; border-radius: 8px; padding: 12px 14px; min-width: 0; }
  .card.user { border-left-color: #2f5d8c; }
  .card.tool { border-left-color: #2c6e45; }
  .card.unknown, .card.error, .card.deny { border-left-color: #a3443c; }
  .card-header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
  .role { font-size: 10px; font-weight: 800; letter-spacing: 0.1em; color: #685d50; }
  .card-title { font-size: 13px; overflow-wrap: anywhere; }
  .state { border-radius: 4px; padding: 2px 6px; background: #edf3ec; color: #315b3d; font-size: 11px; font-weight: 600; }
  .unknown .state, .error .state, .deny .state { background: #f8e6e2; color: #8a322c; }
  .card-header .event-link { margin-left: auto; }
  .card-content { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
  .tool-fields { display: grid; gap: 8px; }
  .tool-field { min-width: 0; }
  .field-label { display: block; margin: 0 0 3px; color: #786f65; font-size: 11px; font-weight: 600; }
  .tool-field pre { max-height: 140px; overflow: auto; padding: 8px 10px; border-radius: 5px; background: #f5f2ec; }
  .card-events { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .event-link { border: 1px solid #dfd6c8; border-radius: 5px; background: #fffdf8; color: #5d5143; padding: 3px 7px; cursor: pointer; font: 11px/1.3 ui-sans-serif, system-ui, sans-serif; }
  .ledger { margin-top: 28px; border-top: 1px solid #dcd4c8; padding-top: 14px; }
  .ledger > summary { color: #514a41; cursor: pointer; font-size: 13px; font-weight: 700; }
  .ledger > summary span { margin-left: 5px; color: #786f65; font-weight: 400; }
  .turn { margin: 0; }
  .turn h2 { margin: 16px 0 8px; }
  ol { list-style: none; padding: 0; margin: 0; }
  .row { font: inherit; }
  .row { width: 100%; display: grid; grid-template-columns: 3.2rem 9.5rem 1fr auto; gap: 8px; text-align: left; background: #fffdf8; border: 1px solid #e3dbd0; border-radius: 8px; padding: 8px 10px; margin: 6px 0; cursor: pointer; }
  .selected { outline: 2px solid #1c1915; outline-offset: 1px; }
  button:focus-visible, summary:focus-visible { outline: 2px solid #1c1915; outline-offset: 2px; }
  .row.unknown, .row.error, .row.deny { border-color: #c9847c; }
  .seq, time { color: #6d655c; font-variant-numeric: tabular-nums; }
  .summary { overflow-wrap: anywhere; }
  .detail { position: sticky; top: 20px; max-height: calc(100vh - 40px); overflow: auto; background: #fffdf8; border: 1px solid #e3dbd0; border-radius: 8px; padding: 16px; }
  .detail h3 { font-size: 13px; overflow-wrap: anywhere; }
  .detail p { font-size: 13px; color: #655e56; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, monospace; }
  .banner { background: #f8e6e2; border: 1px solid #e3b2aa; border-radius: 8px; padding: 10px 12px; }
  .empty { color: #655e56; }
  @media (max-width: 760px) {
    main { padding: 22px 16px 48px; }
    .trajectory-layout { grid-template-columns: minmax(0, 1fr); gap: 20px; }
    .detail { position: static; max-height: 55vh; }
    .row { grid-template-columns: 3rem 1fr; }
    .row time { display: none; }
    .timing-heading { align-items: start; flex-direction: column; }
  }
</style>
</head>
<body>
<main>
  <header class="page-header">
    <div>
      <p class="wordmark">mini-dsh</p>
      <p class="meta">Trajectory</p>
    </div>
    <div class="session-meta"><p class="eyebrow">Local session · read-only</p><p class="meta">${projection.count} events · <a href="/prototype">Simulated prototype</a></p></div>
  </header>
  ${banner}
  <section class="timing" aria-label="timing overview">
    <div class="timing-heading"><h2>Timeline</h2>
    <ul class="legend"><li><i class="swatch input"></i>input</li><li><i class="swatch model"></i>model</li><li><i class="swatch tool"></i>tool</li></ul>
    </div>
    ${overview}
  </section>
  <div class="trajectory-layout">
    <div>
      <section aria-label="conversation">
        <div class="section-heading"><h2>Conversation</h2><span class="section-note">${projection.turns.length} ${projection.turns.length === 1 ? 'turn' : 'turns'}</span></div>
        ${conversation}
      </section>
      <details class="ledger" id="ledger">
        <summary>Event ledger <span>${projection.count} recorded events</span></summary>
        ${ledger}
      </details>
    </div>
    <section class="detail" aria-label="recorded detail" aria-live="polite">
      <h2>Recorded detail</h2>
      <p id="detail-empty">Select an event on a card, timeline, or ledger to inspect its recorded detail.</p>
      <h3 id="detail-title" hidden></h3>
      <pre id="detail-body" hidden></pre>
    </section>
  </div>
  <p id="notice" class="empty"></p>
</main>
<script type="application/json" id="projection">${jsonForHtml(projection)}</script>
<script>
  const data = JSON.parse(document.getElementById('projection').textContent)
  let cursor = data.cursor
  const rows = [...data.preamble, ...data.turns.flatMap((turn) => turn.rows)]
  function show(seq) {
    const row = rows.find((item) => item.seq === seq)
    if (!row) return
    document.getElementById('detail-empty').hidden = true
    const title = document.getElementById('detail-title')
    const body = document.getElementById('detail-body')
    title.hidden = false
    body.hidden = false
    title.textContent = '#' + row.seq + ' ' + row.label
    body.textContent = JSON.stringify(row.detail, null, 2)
    for (const node of document.querySelectorAll('[data-seq]')) {
      node.classList.toggle('selected', Number(node.dataset.seq) === seq)
    }
  }
  document.body.addEventListener('click', (event) => {
    const node = event.target.closest('[data-seq]')
    if (!node) return
    const seq = Number(node.dataset.seq)
    history.replaceState(null, '', '#seq=' + seq)
    show(seq)
    if (matchMedia('(max-width: 760px)').matches) document.querySelector('.detail').scrollIntoView({ block: 'nearest' })
  })
  const ledger = document.getElementById('ledger')
  try { ledger.open = sessionStorage.getItem('mini-dsh-ledger-open') === 'true' } catch { /* storage is optional */ }
  ledger.addEventListener('toggle', () => {
    try { sessionStorage.setItem('mini-dsh-ledger-open', String(ledger.open)) } catch { /* storage is optional */ }
  })
  const initial = Number((location.hash.match(/seq=(\\d+)/) || [])[1])
  if (initial) show(initial)
  const source = new EventSource('/events?after=' + cursor)
  source.onmessage = (message) => {
    const event = JSON.parse(message.data)
    if (event.seq !== cursor + 1) {
      document.getElementById('notice').textContent = 'Session follow gap: expected sequence ' + (cursor + 1) + ', received ' + event.seq
      source.close()
      return
    }
    cursor = event.seq
    source.close()
    location.reload()
  }
  source.addEventListener('gap', (message) => {
    let text = 'Session follow gap'
    try { text = JSON.parse(message.data).error || text } catch { /* the server text is the notice */ }
    document.getElementById('notice').textContent = text
    source.close()
  })
</script>
</body>
</html>`
}

function shortTime(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? value.slice(11, 23) : value ?? ''
}

function tokenStrip(projection) {
  const streams = projection.overview.filter((span) => span.kind === 'model' && span.tokens?.length)
  if (!streams.length) return ''
  const count = streams.reduce((sum, span) => sum + span.tokens.length, 0)
  const items = streams.map((span) => {
    const tokens = span.tokens.map((token) => `<li><button type="button" class="token" data-seq="${token.seq}" title="${esc(token.time)}"><time datetime="${esc(token.time)}">${esc(shortTime(token.time))}</time><span>${esc(token.text)}</span></button></li>`).join('')
    return `<li class="stream-label">model #${span.seq}</li>${tokens}`
  }).join('')
  return `<p class="stream-heading">Stream fragments · ${count} <span class="section-note">(select a fragment to inspect)</span></p><ol class="tokens">${items}</ol>`
}

function eventButton(label, seq) {
  return `<button type="button" class="event-link" data-seq="${seq}">${esc(label)} #${seq}</button>`
}

function displayValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function cardHtml(card) {
  const state = card.partial ? 'Partial · outcome unknown'
    : card.status === 'unknown' ? (card.decision === 'deny' ? 'Denied · outcome unknown' : 'Outcome unknown')
      : card.status === 'deny' ? 'Denied'
        : card.status === 'error' ? 'Error' : 'Completed'
  const status = card.status ? ` ${esc(card.status)}` : ''
  const title = card.kind === 'tool' ? `<strong class="card-title">${esc(card.name || card.callId)}</strong>` : ''
  const badge = card.kind === 'tool' || card.partial ? `<span class="state">${esc(state)}</span>` : ''
  const header = `<header class="card-header"><span class="role">${esc(card.kind.toUpperCase())}</span>${title}${badge}${eventButton(card.partial ? 'Stream' : 'Event', card.seq)}</header>`
  if (card.kind !== 'tool') return `<article class="card ${esc(card.kind)}${status}">${header}<p class="card-content">${esc(card.content)}</p></article>`
  const args = card.arguments == null ? '' : `<div class="tool-field"><span class="field-label">Arguments</span><pre>${esc(displayValue(card.arguments))}</pre></div>`
  const result = card.result == null ? '' : `<div class="tool-field"><span class="field-label">Result</span><pre>${esc(displayValue(card.result))}</pre></div>`
  const links = [
    card.decisionSeq && eventButton('Decision', card.decisionSeq),
    card.startSeq && card.startSeq !== card.seq && eventButton('Started', card.startSeq),
    card.resultSeq && eventButton('Result', card.resultSeq),
  ].filter(Boolean).join('')
  return `<article class="card tool${status}">${header}<div class="tool-fields">${args}${result}</div>${links ? `<div class="card-events">${links}</div>` : ''}</article>`
}

function conversationTurn(turn) {
  return `<section class="conversation-turn"><h3 class="turn-number">Turn ${turn.id}</h3><div class="cards">${turn.cards.map(cardHtml).join('')}</div></section>`
}

function section(title, input, rows) {
  const heading = input == null ? esc(title) : `${esc(title)} · ${esc(input)}`
  const items = rows.map((row) => `<li><button type="button" class="row${row.status !== 'ok' ? ` ${esc(row.status)}` : ''}" data-seq="${row.seq}" data-kind="${esc(row.kind)}" data-status="${esc(row.status)}"><span class="seq">#${row.seq}</span><span class="label">${esc(row.label)}</span><span class="summary">${esc(row.summary)}</span><time datetime="${esc(row.time)}">${esc(row.time)}</time></button></li>`).join('')
  return `<section class="turn"><h2>${heading}</h2><ol>${items}</ol></section>`
}

function prototypeWorkspace(session) {
  if (typeof session?.workspace === 'string' && session.workspace) return session.workspace
  const opened = session?.events?.find((event) => event.type === 'session.opened')
  return typeof opened?.workspace === 'string' ? opened.workspace : ''
}

function send(res, status, type, body) {
  const payload = Buffer.from(body)
  res.writeHead(status, {
    'content-type': type,
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function cursorFrom(req, url) {
  const header = req.headers['last-event-id']
  const raw = header != null && header !== '' ? header : (url.searchParams.get('after') ?? '0')
  if (!/^\d+$/.test(String(raw))) throw new Error('after must be a non-negative integer')
  return Number(raw)
}

export class TrajectoryViewer extends Service {
  static inject = ['session']

  constructor(ctx, config = {}) {
    super(ctx, 'viewer')
    if (config?.host != null && config.host !== HOST) throw new Error('Trajectory viewer listens on 127.0.0.1 only')
    const port = config?.port ?? 0
    const refreshMs = config?.refreshMs ?? 250
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Viewer port is invalid')
    if (!Number.isInteger(refreshMs) || refreshMs < 0) throw new Error('Viewer refresh interval is invalid')
    this.host = HOST
    this.port = port
    this.refreshMs = refreshMs
    this.server = null
    this.url = null
    this.timer = null
    this.closed = false
    this.streams = new Set()
    this.stops = new Set()
    this.pulled = Promise.resolve()
    this.ctx.effect(() => () => this.close(), 'trajectory-viewer')
  }

  async [Service.init]() {
    await this.listen()
    if (this.closed || this.ctx.session.writable || this.refreshMs === 0) return
    this.timer = setInterval(() => {
      this.pull().catch((error) => this.ctx.logger.error(error))
    }, this.refreshMs)
    this.timer.unref()
  }

  listen() {
    if (this.closed) return Promise.resolve()
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.ctx.logger.error(error)
        if (res.headersSent || res.writableEnded) return
        send(res, 500, 'text/plain; charset=utf-8', 'Trajectory viewer failed\n')
      })
    })
    server.requestTimeout = 0
    this.server = server
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        if (this.server === server) this.server = undefined
        server.close(() => reject(error))
      }
      server.once('error', fail)
      server.listen(this.port, this.host, () => {
        server.off('error', fail)
        if (this.closed) {
          this.close().then(resolve, reject)
          return
        }
        this.url = `http://${this.host}:${server.address().port}`
        resolve()
      })
    })
  }

  // Read-only sessions learn about another process by rereading the log.
  // Refresh stays serialized so two readers cannot double-publish one record.
  pull() {
    if (this.ctx.session.writable) return Promise.resolve([])
    const run = this.pulled.then(() => this.ctx.session.refresh())
    this.pulled = run.then(() => {}, () => {})
    return run
  }

  async snapshot() {
    await this.pull()
    return project(this.ctx.session.events)
  }

  async handle(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'content-length': '0' })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', `http://${this.host}`)
    if (url.pathname === '/') {
      send(res, 200, 'text/html; charset=utf-8', renderPage(await this.snapshot()))
      return
    }
    if (url.pathname === '/trajectory') {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await this.snapshot()))
      return
    }
    if (url.pathname === '/events') {
      await this.stream(req, res, url)
      return
    }
    // GET only. A later live approval route would need a secret the page
    // cannot forge; this server does not accept a prompt or a decision.
    if (url.pathname === '/prototype') {
      send(res, 200, 'text/html; charset=utf-8', prototypePage(renderPage(await this.snapshot()), prototypeWorkspace(this.ctx.session)))
      return
    }
    send(res, 404, 'text/plain; charset=utf-8', 'Not found\n')
  }

  // History and later records share one cursor. Last-Event-ID wins on reconnect
  // so a replay of the original query cannot skip or repeat a sequence.
  async stream(req, res, url) {
    let after
    try { after = cursorFrom(req, url) }
    catch (error) {
      send(res, 400, 'text/plain; charset=utf-8', `${error.message}\n`)
      return
    }
    await this.pull()
    const tip = this.ctx.session.events.at(-1)?.seq ?? 0
    if (after > tip) {
      send(res, 409, 'application/json; charset=utf-8', JSON.stringify({ error: `after ${after} is ahead of session sequence ${tip}` }))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    // Headers alone can stay corked until a body write. A follower parked at
    // the current tip would otherwise never see the response.
    res.flushHeaders()
    res.socket?.setNoDelay(true)
    res.socket?.uncork()
    res.on('error', () => {})
    let stop
    try {
      stop = this.ctx.session.follow(after, (event) => {
        if (res.writableEnded || res.destroyed) return
        // Small writes stay corked until the next chunk. Uncork so a follower
        // sees this sequence before another event is recorded.
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
        res.socket?.uncork()
      })
    } catch (error) {
      res.write(`event: gap\ndata: ${JSON.stringify({ error: error.message })}\n\n`)
      res.end()
      return
    }
    const done = () => {
      stop()
      this.stops.delete(done)
      this.streams.delete(res)
    }
    this.stops.add(done)
    this.streams.add(res)
    res.on('close', done)
  }

  close() {
    if (this.closing) return this.closing
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const stop of this.stops) stop()
    this.stops.clear()
    for (const res of this.streams) {
      if (!res.writableEnded) res.end()
    }
    this.streams.clear()
    const server = this.server
    this.server = undefined
    this.url = null
    if (!server) return Promise.resolve()
    this.closing = new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    return this.closing
  }
}
