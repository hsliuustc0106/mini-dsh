// Simulated hello.txt composer beside the read-only ledger.
// Send, Allow once, and Deny change only this page. They do not append the
// session, call a model, read an API key, or write a file.
//
// A later live control route is a different mode. It would leave `npm run view`
// read-only, keep the API key on the server, grant only one explicit allow for
// that exact call, and deny when the decision is missing, repeated, or failed.
// Loopback is not enough for a browser: another page can call 127.0.0.1, so
// that route would check a secret this static page cannot forge. This file
// does not add the route.

export function scriptedWrite() {
  return {
    callId: 'write-hello',
    name: 'write',
    arguments: { path: 'hello.txt', content: 'hello\n' },
  }
}

// One simulated turn. Only `allow` grants the scripted write. Every other
// action while a card is open, including a second allow, leaves the state.
// `fresh` stays inside this function so the page script can carry the reducer.
export function reducePrototype(state, action) {
  function fresh(write) {
    return {
      callId: write.callId,
      name: write.name,
      arguments: { path: write.arguments.path, content: write.arguments.content },
    }
  }
  if (!action || typeof action.type !== 'string') return state
  if (action.type === 'send') {
    const prompt = typeof action.prompt === 'string' ? action.prompt : ''
    if (!prompt.trim() || state.phase === 'awaiting') return state
    const workspace = typeof action.workspace === 'string' ? action.workspace : ''
    const call = fresh(scriptedWrite())
    return {
      phase: 'awaiting',
      turns: [...state.turns, {
        id: state.turns.length + 1,
        prompt,
        workspace,
        call,
        decision: null,
        before: [
          { type: 'message', simulated: true, message: { role: 'user', content: prompt } },
          {
            type: 'model.request',
            simulated: true,
            provider: 'simulated',
            body: {
              model: 'simulated',
              note: 'Not sent. The prototype does not call a model or attach an API key.',
              messages: [{ role: 'user', content: prompt }],
            },
          },
          {
            type: 'message',
            simulated: true,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: call.callId,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              }],
            },
          },
        ],
        after: [],
      }],
    }
  }
  if (action.type !== 'allow' && action.type !== 'deny') return state
  if (state.phase !== 'awaiting') return state
  const current = state.turns[state.turns.length - 1]
  if (!current || current.decision) return state
  const call = fresh(current.call)
  const decision = action.type === 'allow' ? 'allow' : 'deny'
  const decided = {
    type: 'permission.decided',
    simulated: true,
    callId: call.callId,
    name: call.name,
    arguments: call.arguments,
    workspace: current.workspace,
    decision,
  }
  const after = decision === 'allow'
    ? [
      decided,
      { type: 'tool.started', simulated: true, callId: call.callId, name: call.name, arguments: call.arguments, workspace: current.workspace },
      { type: 'tool.finished', simulated: true, callId: call.callId, result: 'File written.' },
      { type: 'message', simulated: true, message: { role: 'tool', tool_call_id: call.callId, content: 'File written.' } },
      { type: 'message', simulated: true, message: { role: 'assistant', content: 'Wrote hello.txt.' } },
    ]
    : [
      { ...decided, reason: 'denied' },
      { type: 'message', simulated: true, message: { role: 'tool', tool_call_id: call.callId, content: 'Error: denied' } },
    ]
  const turns = state.turns.slice(0, -1).concat({ ...current, decision, after })
  return { phase: 'idle', turns }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function clientScript(workspace) {
  return `
${scriptedWrite.toString()}
${reducePrototype.toString()}
const workspace = ${jsonForHtml(workspace)}; // prototype-workspace
let state = { phase: 'idle', turns: [] };
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const simulated = document.getElementById('simulated');

function commit(action) {
  const next = reducePrototype(state, action);
  if (next === state) return;
  const previous = state.phase;
  state = next;
  if (action.type === 'send') prompt.value = '';
  renderSim(previous);
}

send.addEventListener('click', () => commit({ type: 'send', prompt: prompt.value, workspace }));
prompt.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  commit({ type: 'send', prompt: prompt.value, workspace });
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function summary(event) {
  if (event.type === 'message') {
    const message = event.message;
    if (message.tool_calls?.length) {
      const call = message.tool_calls[0];
      return call.function.name + ' ' + call.function.arguments;
    }
    return message.role + ': ' + (message.content ?? '');
  }
  if (event.type === 'permission.decided') return event.decision + ' ' + event.name;
  if (event.type === 'tool.started') return event.name + ' ' + event.arguments.path;
  if (event.type === 'tool.finished') return event.result;
  if (event.type === 'model.request') return 'simulated, not sent';
  return event.type;
}

function eventList(events) {
  const list = document.createElement('ol');
  for (const event of events) {
    const item = document.createElement('li');
    const row = el('div', 'row sim');
    row.append(el('span', 'label', event.type));
    row.append(el('span', 'summary', summary(event)));
    item.append(row);
    list.append(item);
  }
  return list;
}

function card(turn) {
  const article = el('article', 'card');
  article.dataset.call = turn.call.callId;
  article.append(el('p', 'kicker', 'Simulated approval'));
  article.append(el('p', 'tool-name', turn.call.name));
  const args = document.createElement('pre');
  args.textContent = JSON.stringify(turn.call.arguments, null, 2);
  article.append(args);
  article.append(el('p', 'workspace', 'Workspace: ' + (turn.workspace || 'unavailable')));
  if (turn.decision) {
    const text = turn.decision === 'allow'
      ? 'Allowed once. The session log was not updated and hello.txt was not written.'
      : 'Denied. The tool did not run.';
    article.append(el('p', 'decision', text));
    return article;
  }
  article.append(el('p', 'empty', 'Read, glob, grep, and skill are allowed and do not ask. Only Allow once grants this call. Deny, or leaving it, does not.'));
  const actions = el('div', 'actions');
  const allow = el('button', 'allow', 'Allow once');
  const deny = el('button', 'deny', 'Deny');
  allow.type = 'button';
  deny.type = 'button';
  const choose = (type) => {
    if (allow.disabled) return;
    allow.disabled = true;
    deny.disabled = true;
    commit({ type });
  };
  allow.addEventListener('click', () => choose('allow'));
  deny.addEventListener('click', () => choose('deny'));
  actions.append(allow, deny);
  article.append(actions);
  return article;
}

function renderSim(previous) {
  const waiting = state.phase === 'awaiting';
  prompt.disabled = waiting;
  send.disabled = waiting;
  simulated.replaceChildren();
  for (const turn of state.turns) {
    const section = el('section', 'sim-turn');
    section.append(el('h2', null, 'Simulated turn ' + turn.id));
    section.append(el('p', 'empty', 'Not in the session log.'));
    section.append(eventList(turn.before));
    section.append(card(turn));
    if (turn.after.length) section.append(eventList(turn.after));
    simulated.append(section);
  }
  if (previous === 'awaiting' && state.phase === 'idle') prompt.focus();
  if (waiting) simulated.querySelector('.actions')?.scrollIntoView({ block: 'nearest' });
}

renderSim('idle');
`
}

const prototypeCss = `
  body.prototype main { max-width: 1120px; }
  .note { background: #efe6d4; border: 1px solid #d9c7a4; border-radius: 8px; padding: 10px 12px; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, 24rem); gap: 22px; align-items: start; }
  body.prototype .trajectory-layout { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  body.prototype .detail { position: static; max-height: 55vh; }
  .rail { position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow: auto; }
  .composer { display: flex; gap: 8px; align-items: flex-end; }
  .composer textarea { flex: 1; min-width: 0; min-height: 4.4rem; margin: 0; padding: 8px 10px; border: 1px solid #e3dbd0; border-radius: 8px; background: #fffdf8; color: inherit; font: inherit; resize: vertical; }
  #send, .actions button { font: inherit; border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
  #send { background: #1c1915; color: #fff; min-height: 2.6rem; }
  .actions { display: flex; gap: 8px; }
  .actions .allow { background: #2c6e45; color: #fff; }
  .actions .deny { background: #8c3030; color: #fff; }
  button:disabled { opacity: 0.45; cursor: default; }
  .rail .card { background: #fffdf8; border: 1px solid #e3dbd0; border-radius: 8px; padding: 12px; margin: 8px 0; }
  .rail .card pre { margin: 8px 0; }
  .kicker, .tool-name { margin: 0 0 6px; }
  .kicker { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #6d655c; }
  .tool-name { font-weight: 700; }
  .rail .row { grid-template-columns: 8.4rem 1fr; cursor: default; }
  @media (max-width: 800px) {
    .split { grid-template-columns: 1fr; }
    .rail { position: static; }
  }
`

// The viewer HTML stays the ledger. This wraps it and drops the live follow
// so a later session event cannot reload the page and erase the simulation.
export function prototypePage(viewerHtml, workspace) {
  if (typeof viewerHtml !== 'string') throw new Error('Prototype expects the viewer page')
  const root = typeof workspace === 'string' ? workspace : ''
  const follow = "  const source = new EventSource('/events?after=' + cursor)\n  source.onmessage = (message) => {"
  if (!viewerHtml.includes('<main>') || !viewerHtml.includes(follow)) {
    throw new Error('Viewer page changed; the prototype could not sit beside it')
  }
  const call = scriptedWrite()
  const rail = `<aside class="rail" aria-label="simulated composer">
  <h2>Prompt</h2>
  <p class="empty">Scripted call: ${esc(call.name)} ${esc(call.callId)} ${esc(JSON.stringify(call.arguments))}. The text you send is the simulated user message. The tool call is that script, not a model reply. Read, glob, grep, and skill are allowed and do not ask.</p>
  <div class="composer">
    <textarea id="prompt" rows="3" aria-label="Prompt" placeholder="Write hello.txt" spellcheck="false"></textarea>
    <button type="button" id="send">Send</button>
  </div>
  <p class="empty">Enter sends. Shift+Enter inserts a newline. One turn at a time.</p>
  <p class="empty">Workspace ${esc(root || 'unavailable')}</p>
  <div id="simulated" aria-live="polite"></div>
</aside>`
  let page = viewerHtml
    .replace('<title>mini-dsh trajectory</title>', '<title>mini-dsh simulated prototype</title>')
    .replace('<body>', '<body class="prototype">')
    .replace('</style>', `${prototypeCss}</style>`)
    .replace(/<main>([\s\S]*)<\/main>/, (_, inner) => `<main>
  <p class="note">Simulated prototype. Send, Allow once, and Deny stay in this page. They do not call a model, write the session log, or create hello.txt.</p>
  <div class="split"><div class="viewer">${inner}</div>${rail}</div>
</main>`)
    .replace(follow, "  const source = { close() {}, addEventListener() {} } // prototype-snapshot\n  source.onmessage = (message) => {")
  return page.replace('</body>', `<script>${clientScript(root)}</script>\n</body>`)
}
