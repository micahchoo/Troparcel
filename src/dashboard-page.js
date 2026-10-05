'use strict'

/**
 * The dashboard page (dashboard.js serves it). Self-contained: no fonts or
 * scripts from elsewhere. It asks api/status every 2 s and sends buttons
 * as JSON POSTs to api/<action>.
 */
function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Troparcel</title>
<style>
  :root {
    --bg: #f3f4f6; --surface: #ffffff; --fg: #1d2127; --muted: #5b6370; --rule: #d8dce2;
    --accent: #2f5d8a; --ok: #2e7d4f; --warn: #a35c00; --bad: #b3261e; --code: #e9ecf1;
    --body: system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #121417; --surface: #1a1d22; --fg: #e8e9eb; --muted: #9aa1ab; --rule: #2c3138;
      --accent: #86acd6; --ok: #6fc28f; --warn: #e3a54f; --bad: #f08c84; --code: #20242a; color-scheme: dark; }
  }
  * { box-sizing: border-box }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 var(--body); padding: 32px 16px 64px; }
  main { max-width: 46rem; margin: 0 auto; display: grid; gap: 18px; }
  header h1 { font-size: 1.6rem; margin: 0 0 4px; }
  .state { display: flex; align-items: center; gap: 10px; font-size: 1.05rem; font-weight: 600; }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: var(--muted); flex: none }
  .dot.ok { background: var(--ok) } .dot.warn { background: var(--warn) } .dot.bad { background: var(--bad) }
  .sub { color: var(--muted); margin: 2px 0 0 21px; }
  section { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 16px 18px; min-width: 0; }
  section h2 { font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
  section.attention { border-color: var(--warn); }
  p { margin: 0 0 8px } p:last-child { margin: 0 }
  ul { margin: 0; padding-left: 1.1rem; display: grid; gap: 4px }
  .feed { list-style: none; padding: 0; gap: 6px }
  .feed li { display: flex; gap: 12px } .feed time { color: var(--muted); min-width: 4.5rem; font-variant-numeric: tabular-nums }
  .conflict { border-top: 1px solid var(--rule); padding-top: 10px; margin-top: 10px; display: grid; gap: 6px }
  .conflict:first-of-type { border-top: 0; padding-top: 0; margin-top: 0 }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px }
  @media (max-width: 520px) { .pair { grid-template-columns: 1fr } }
  .value { background: var(--code); border-radius: 6px; padding: 8px 10px; overflow-wrap: anywhere }
  .value b { display: block; font-size: 0.75rem; color: var(--muted); font-weight: 600; margin-bottom: 2px }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center }
  button { font: 600 0.9rem var(--body); border: 1px solid var(--rule); background: var(--surface); color: var(--fg);
    border-radius: 6px; padding: 7px 12px; cursor: pointer }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg) }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
  button:disabled { opacity: 0.6; cursor: default }
  .code { font: 0.88rem var(--mono); background: var(--code); border-radius: 6px; padding: 9px 11px; overflow-x: auto;
    white-space: nowrap; flex: 1; min-width: 0 }
  label { display: grid; gap: 4px; font-weight: 600 } label span { font-weight: 400; color: var(--muted); font-size: 0.88rem }
  input, select { font: 0.95rem var(--body); padding: 8px 10px; border-radius: 6px; border: 1px solid var(--rule);
    background: var(--bg); color: var(--fg); width: 100% }
  form { display: grid; gap: 12px }
  .or { color: var(--muted); text-align: center; margin: 4px 0 }
  .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--fg); color: var(--bg);
    padding: 9px 14px; border-radius: 6px; font-weight: 600 }
  .muted { color: var(--muted) }
  footer { color: var(--muted); font-size: 0.85rem; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap }
</style>
</head>
<body>
<main id="app"><p class="muted">Loading…</p></main>
<div class="toast" id="toast" hidden></div>
<script>
const $ = (t, a = {}, ...kids) => {
  const el = document.createElement(t)
  for (const [k, v] of Object.entries(a)) {
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid))
  return el
}
const ago = at => {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return s + ' s ago'
  if (s < 3600) return Math.round(s / 60) + ' min ago'
  return Math.round(s / 3600) + ' h ago'
}
const field = uri => {
  const name = String(uri).split(/[\\/#]/).pop()
  return name.charAt(0).toUpperCase() + name.slice(1)
}
let busy = false
let typing = false
function toast(text) {
  const t = document.getElementById('toast')
  t.textContent = text; t.hidden = false
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true }, 3200)
}
async function act(name, input = {}) {
  busy = true
  try {
    const res = await fetch('api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    const body = await res.json()
    toast(body.ok ? (body.message || 'Done') : (body.error || 'That did not work'))
  } catch {
    toast('Troparcel did not answer. Is Tropy still open?')
  } finally {
    busy = false
    refresh()
  }
}
function stateOf(s) {
  if (!s.configured) return ['', 'Not set up yet', 'Fill in the two fields below to join a group, or start a new room.']
  if (!s.engine) return ['warn', 'Starting…', s.problems && s.problems[0] ? s.problems[0].text : 'Waiting for the project to load.']
  const e = s.engine
  const where = e.transport === 'file' ? 'shared folder' : 'server'
  if (e.state === 'connected' || e.state === 'syncing') {
    const last = e.lastSync ? 'last synced ' + ago(new Date(e.lastSync).getTime()) : 'syncing'
    return ['ok', 'In sync', 'Room “' + e.room + '” on a ' + where + ', ' + last + '.']
  }
  if (e.state === 'connecting') return ['warn', 'Connecting…', 'Room “' + e.room + '”. Your changes are kept and sent once connected.']
  return ['bad', 'Offline: working on this computer only', 'Your changes are kept and sent once Troparcel can reach the ' + where + ' again.']
}
function setup(s) {
  const conn = $('input', { id: 'conn', placeholder: 'troparcel://…  or the path of a shared folder', value: s.options.connection || '', oninput: () => { typing = true } })
  const name = $('input', { id: 'name', placeholder: 'e.g. Ada L.', value: s.options.userId || '', oninput: () => { typing = true } })
  const join = $('form', { onsubmit: e => { e.preventDefault(); typing = false; act('setup', { connection: conn.value.trim(), userId: name.value.trim() }) } },
    $('label', {}, 'Connection', $('span', {}, 'The invite someone in your group sent you.'), conn),
    $('label', {}, 'Your name', $('span', {}, 'How others see your work. Use one nobody else in the group uses.'), name),
    $('div', { class: 'row' }, $('button', { class: 'primary', type: 'submit' }, 'Join'))
  )
  const kids = [$('h2', {}, 'Join a group'), join]
  if (s.syncRoots && s.syncRoots.length) {
    const root = $('select', { id: 'root' }, s.syncRoots.map(([label, p]) => $('option', { value: p }, label + ' (' + p + ')')))
    const room = $('input', { id: 'room', placeholder: 'e.g. tropy-letters', oninput: () => { typing = true } })
    kids.push($('p', { class: 'or' }, 'or'), $('h2', {}, 'Start a new room in a shared folder'),
      $('form', { onsubmit: e => { e.preventDefault(); typing = false; act('create-room', { root: root.value, room: room.value.trim(), userId: name.value.trim() }) } },
        $('label', {}, 'Where', $('span', {}, 'A folder your sync client keeps in step on every computer.'), root),
        $('label', {}, 'Room name', $('span', {}, 'A new folder of this name is made there. Share it with your group in that app.'), room),
        $('div', { class: 'row' }, $('button', { class: 'primary', type: 'submit' }, 'Start the room'))))
  }
  return $('section', {}, kids)
}
function attention(e) {
  const parts = []
  for (const c of e.conflicts || []) {
    parts.push($('div', { class: 'conflict' },
      $('p', {}, $('b', {}, field(c.field)), ' on ', $('b', {}, c.title), ': you and ' + (c.remoteAuthor || 'a collaborator') + ' changed it at the same time.'),
      $('div', { class: 'pair' },
        $('div', { class: 'value' }, $('b', {}, 'Yours'), c.localValue || '(empty)'),
        $('div', { class: 'value' }, $('b', {}, (c.remoteAuthor || 'Theirs') + '’s'), c.remoteValue || '(empty)')),
      $('div', { class: 'row' },
        $('button', { onclick: () => act('resolve', { identity: c.identity, field: c.field, choice: 'theirs' }) }, 'Use theirs'),
        $('button', { onclick: () => act('resolve', { identity: c.identity, field: c.field, choice: 'mine' }) }, 'Keep mine'))))
  }
  if (e.unmatched && e.unmatched.count) {
    const n = e.unmatched.count
    parts.push($('div', { class: 'conflict' },
      $('p', {}, $('b', {}, n + (n === 1 ? ' item' : ' items')), ' from the group ' + (n === 1 ? 'has' : 'have') + ' no match in your project.'),
      $('p', { class: 'muted' }, 'Troparcel matches items by their photo files. Your copies of these photos differ from your collaborators’: re-saved, converted, or imported with other settings. Import the original files, or ask the group to switch to a project room, where the photos travel too.'),
      e.unmatched.examples.length ? $('ul', {}, e.unmatched.examples.map(x => $('li', {}, (x.title || 'An untitled item') + ' (from ' + x.from + ')'))) : null))
  }
  for (const p of (e.problems || []).slice(0, 3)) {
    parts.push($('div', { class: 'conflict' }, $('p', {}, p.text + (p.count > 1 ? ' (' + p.count + ' times)' : '')), $('p', { class: 'muted' }, ago(p.at))))
  }
  if (!parts.length) return null
  return $('section', { class: 'attention' }, $('h2', {}, 'Needs your attention'), parts)
}
function render(s) {
  const app = document.getElementById('app')
  if (typing && app.querySelector('input:focus')) return
  const [cls, title, sub] = stateOf(s)
  const kids = [$('header', {}, $('h1', {}, 'Troparcel'),
    $('div', { class: 'state' }, $('span', { class: 'dot ' + cls }), title), $('p', { class: 'sub' }, sub))]
  if (!s.configured) kids.push(setup(s))
  const e = s.engine
  if (e) {
    kids.push($('section', {}, $('h2', {}, 'People'),
      e.peers && e.peers.length
        ? $('p', {}, 'Online now: ' + e.peers.join(', ') + '.')
        : $('p', {}, e.transport === 'file'
          ? 'A shared folder cannot tell who is online. Changes arrive as fast as your sync client copies them, usually within a minute.'
          : 'Nobody else is online. Their changes arrive when they next open Tropy.')))
    const need = attention(e)
    if (need) kids.push(need)
    if (e.photosWaiting) kids.push($('section', {}, $('h2', {}, 'Photos on their way'),
      $('p', {}, e.photosWaiting + (e.photosWaiting === 1 ? ' item waits' : ' items wait') + ' for photos a collaborator has not finished uploading.')))
    kids.push($('section', {}, $('h2', {}, 'Recent'),
      e.recent && e.recent.length
        ? $('ul', { class: 'feed' }, e.recent.slice(0, 12).map(r => $('li', {}, $('time', {}, ago(r.at)), $('span', {}, r.text))))
        : $('p', { class: 'muted' }, 'Nothing has arrived yet in this session.')))
  }
  if (s.configured && s.invite) {
    const code = $('div', { class: 'code', id: 'invite' }, s.invite.text)
    kids.push($('section', {}, $('h2', {}, 'Invite someone'),
      $('p', {}, s.invite.how),
      $('div', { class: 'row' }, code, $('button', { onclick: () => copy(s.invite.text) }, 'Copy')),
      s.invite.secret ? $('p', { class: 'muted' }, 'It contains the room’s password' + (s.invite.encrypted ? ' and encryption key' : '') + ': send it only to the group.') : null))
  }
  if (e && e.syncMode !== 'auto') {
    kids.push($('section', {}, $('h2', {}, 'Sync by hand'),
      $('p', { class: 'muted' }, 'Mode is “' + e.syncMode + '”: changes move only when you say.'),
      $('div', { class: 'row' },
        e.syncMode !== 'pull' ? $('button', { onclick: () => act('share') }, 'Share my changes now') : null,
        e.syncMode !== 'push' ? $('button', { onclick: () => act('receive') }, 'Receive changes now') : null)))
  }
  kids.push($('footer', {}, $('span', {}, 'Troparcel ' + s.version), $('span', {}, 'This page is only on your computer.')))
  app.replaceChildren(...kids)
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied') } catch {
    const r = document.createRange(); r.selectNodeContents(document.getElementById('invite'))
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Selected: press Ctrl+C')
  }
}
async function refresh() {
  if (busy) return
  try {
    const res = await fetch('api/status', { cache: 'no-store' })
    render(await res.json())
  } catch {
    document.getElementById('app').replaceChildren($('header', {}, $('h1', {}, 'Troparcel'),
      $('div', { class: 'state' }, $('span', { class: 'dot bad' }), 'Tropy is closed'),
      $('p', { class: 'sub' }, 'This page shows Troparcel while Tropy is open. Open Tropy, then reload.')))
  }
}
refresh()
setInterval(refresh, 2000)
</script>
</body>
</html>`
}

module.exports = { page }
