import { createServer } from 'node:http'
import { Service } from '@deepseek-ai/cordis'
import { unknownReason } from './log.js'
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
  const banner = projection.unknown.length || unknownStreams.length
    ? `<p class="banner">${esc(unknownReason(projection.unknown, unknownStreams))}</p>`
    : ''
  const bars = projection.overview.map((span) => {
    const state = span.status !== 'ok' ? ` ${span.status}` : ''
    const title = [span.kind, span.provider, span.name, span.callId, span.status, span.time, span.endTime].filter(Boolean).join(' · ')
    return `<button type="button" class="bar ${esc(span.kind)}${esc(state)}" data-seq="${span.seq}" style="flex:${grow(span)} ${grow(span)} 4.5rem" title="${esc(title)}">${esc(barText(span))}</button>`
  }).join('')
  const overview = `<div class="overview" role="list">${bars || '<p class="empty">No timing spans yet.</p>'}</div>${tokenStrip(projection)}`
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
  main { max-width: 920px; margin: 0 auto; padding: 28px 16px 64px; }
  .wordmark { display: inline-block; margin: 0; padding-bottom: 2px; border-bottom: 3px solid #8a4518; font: 700 32px/1 Georgia, "Iowan Old Style", serif; letter-spacing: -0.045em; }
  .meta { color: #655e56; margin: 6px 0 0; }
  h2 { margin: 22px 0 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #6d655c; }
  .legend { display: flex; gap: 14px; padding: 0; margin: 8px 0 0; list-style: none; color: #4e473f; }
  .legend i { display: inline-block; width: 0.7rem; height: 0.7rem; margin-right: 6px; border-radius: 2px; vertical-align: -1px; }
  .swatch.input { background: #2f5d8c; }
  .swatch.model { background: #a56b12; }
  .swatch.tool { background: #2c6e45; }
  .overview { display: flex; gap: 6px; align-items: stretch; min-height: 64px; }
  .bar { border: 0; border-radius: 8px; color: #fff; padding: 8px; text-align: left; cursor: pointer; min-width: 4.5rem; }
  .bar.input { background: #2f5d8c; }
  .bar.model { background: #a56b12; }
  .bar.tool { background: #2c6e45; }
  .bar.unknown { background: repeating-linear-gradient(135deg, #8c3030, #8c3030 8px, #a85050 8px, #a85050 16px); }
  .bar.error, .bar.deny { background: #8c3030; }
  .bar.open { background: #6e6246; }
  .tokens { display: flex; flex-wrap: wrap; gap: 6px; padding: 0; margin: 8px 0 0; list-style: none; }
  .token { display: inline-flex; gap: 6px; align-items: baseline; border: 1px solid #e3dbd0; background: #fffdf8; border-radius: 8px; padding: 4px 8px; cursor: pointer; font: inherit; }
  .token time { color: #6d655c; font-size: 12px; font-variant-numeric: tabular-nums; }
  .turn { margin: 0; }
  .input-line { margin: 0 0 8px; }
  ol { list-style: none; padding: 0; margin: 0; }
  .row, .bar { font: inherit; }
  .row { width: 100%; display: grid; grid-template-columns: 3.2rem 9.5rem 1fr auto; gap: 8px; text-align: left; background: #fffdf8; border: 1px solid #e3dbd0; border-radius: 8px; padding: 8px 10px; margin: 6px 0; cursor: pointer; }
  .row.selected, .bar.selected { outline: 2px solid #1c1915; }
  .row.unknown, .row.error, .row.deny { border-color: #c9847c; }
  .seq, time { color: #6d655c; font-variant-numeric: tabular-nums; }
  .summary { overflow-wrap: anywhere; }
  .detail { background: #fffdf8; border: 1px solid #e3dbd0; border-radius: 8px; padding: 12px; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, monospace; }
  .banner { background: #f8e6e2; border: 1px solid #e3b2aa; border-radius: 8px; padding: 10px 12px; }
  .empty { color: #655e56; }
  @media (max-width: 640px) {
    .row { grid-template-columns: 3rem 1fr; }
    time { display: none; }
  }
</style>
</head>
<body>
<main>
  <header>
    <p class="wordmark">mini-dsh</p>
    <p class="meta">${projection.count} events</p>
  </header>
  ${banner}
  <section aria-label="timing overview">
    <h2>Timing</h2>
    ${overview}
    <ul class="legend"><li><i class="swatch input"></i>input</li><li><i class="swatch model"></i>model</li><li><i class="swatch tool"></i>tool</li></ul>
  </section>
  <section aria-label="ledger">
    <h2>Ledger</h2>
    ${ledger}
  </section>
  <section class="detail" aria-label="recorded detail" aria-live="polite">
    <h2>Detail</h2>
    <p id="detail-empty">Select a row to inspect the recorded request, arguments, result, or error.</p>
    <h3 id="detail-title" hidden></h3>
    <pre id="detail-body" hidden></pre>
  </section>
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

function tokenStrip(projection) {
  const tokens = projection.overview.filter((span) => span.kind === 'model').flatMap((span) => span.tokens ?? [])
  if (!tokens.length) return ''
  const items = tokens.map((token) => `<li><button type="button" class="token" data-seq="${token.seq}"><time datetime="${esc(token.time)}">${esc(token.time)}</time><span>${esc(token.text)}</span></button></li>`).join('')
  return `<ol class="tokens">${items}</ol>`
}

function section(title, input, rows) {
  const heading = input == null ? esc(title) : `${esc(title)} · ${esc(input)}`
  const items = rows.map((row) => `<li><button type="button" class="row${row.status !== 'ok' ? ` ${esc(row.status)}` : ''}" data-seq="${row.seq}" data-kind="${esc(row.kind)}" data-status="${esc(row.status)}"><span class="seq">#${row.seq}</span><span class="label">${esc(row.label)}</span><span class="summary">${esc(row.summary)}</span><time datetime="${esc(row.time)}">${esc(row.time)}</time></button></li>`).join('')
  return `<section class="turn"><h2>${heading}</h2><ol>${items}</ol></section>`
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
