#!/usr/bin/env node
'use strict'

/**
 * Read a timeline written by the test observer (test/e2e/observer):
 *
 *   node test/e2e/timeline.js .e2e/<run>/<name>/timeline.jsonl
 *
 * prints when the project opened, when loads ran, each command type with
 * count / total / max duration, errored actions, undo history and nav
 * changes. As a module: `read(file)` gives the lines, `summarize(lines)`
 * the text.
 */

const fs = require('node:fs')

function read(file) {
  let lines = []
  for (let text of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!text) continue
    try { lines.push(JSON.parse(text)) } catch { /* a line cut by a kill */ }
  }
  return lines
}

const at = (t) => `${(t / 1000).toFixed(2).padStart(7)}s`

function summarize(lines) {
  let out = []
  let say = (s = '') => out.push(s)
  let actions = lines.filter(l => l.kind === 'action')
  let ends = lines.filter(l => l.kind === 'activity' && l.phase === 'end')
  let starts = lines.filter(l => l.kind === 'activity' && l.phase === 'start')
  let counts = lines.filter(l => l.kind === 'counts')
  let last = lines[lines.length - 1]
  if (!last) return 'empty timeline'

  say(`${lines.length} lines, ${actions.length} actions, ${at(last.t).trim()} observed`)
  let attach = lines.find(l => l.kind === 'attach')
  if (attach) say(`${at(attach.t)}  store attached${attach.activities.length ? `, running: ${attach.activities.map(a => a.type).join(', ')}` : ''}`)
  let open = actions.find(a => a.type === 'project.open')
  if (open) say(`${at(open.t)}  project.open dispatched`)
  let opened = counts.find(c => c.project)
  let openedAction = actions.find(a => a.type === 'project.opened')
  if (openedAction) say(`${at(openedAction.t)}  project.opened`)
  else if (opened) say(`${at(opened.t)}  project path present`)
  else say('         project never opened')

  let loadStarts = starts.filter(s => /\.load$/.test(s.type))
  let loadEnds = ends.filter(e => /\.load$/.test(e.type))
  if (loadStarts.length) {
    say(`${at(loadStarts[0].t)}  first load started (${loadStarts[0].type})`)
    let lastEnd = loadEnds[loadEnds.length - 1]
    if (lastEnd) say(`${at(lastEnd.t)}  last load finished (${lastEnd.type}); ${loadEnds.length} of ${loadStarts.length} loads done`)
  }

  say()
  say('commands                      count   total ms     max ms')
  let byType = new Map()
  for (let e of ends) {
    let s = byType.get(e.type) || { count: 0, total: 0, max: 0 }
    s.count++
    s.total += e.ms || 0
    s.max = Math.max(s.max, e.ms || 0)
    byType.set(e.type, s)
  }
  for (let [type, s] of [...byType].sort((a, b) => b[1].total - a[1].total)) {
    say(`  ${type.padEnd(26)} ${String(s.count).padStart(6)} ${String(s.total).padStart(10)} ${String(s.max).padStart(10)}`)
  }
  let ended = new Set(ends.map(e => e.id))
  let open_ = starts.filter(s => !ended.has(s.id))
  if (open_.length) say(`  still running at the end: ${open_.map(s => `${s.type}#${s.id}`).join(', ')}`)

  let errors = actions.filter(a => a.error)
  say()
  say(errors.length ? 'errored actions' : 'errored actions: none')
  for (let e of errors) say(`${at(e.t)}  ${e.type}#${e.seq}: ${e.message}`)

  let changes = (pick) => {
    let prev, out = []
    for (let c of counts) {
      let v = pick(c)
      if (prev !== undefined && v !== prev) out.push([c, prev, v])
      prev = v
    }
    return out
  }
  let undo = changes(c => `${c.undo}/${c.redo}`)
  say()
  say(undo.length ? 'undo history (past/future)' : `undo history: no change (${counts.length ? `${counts[0].undo}/${counts[0].redo}` : '?'})`)
  for (let [c, from, to] of undo) say(`${at(c.t)}  ${from} -> ${to}`)

  let nav = changes(c => JSON.stringify([c.mode, c.query]))
  say()
  say(nav.length ? 'nav (mode, query)' : 'nav: no change')
  for (let [c, from, to] of nav) say(`${at(c.t)}  ${from} -> ${to}`)

  let end = counts[counts.length - 1]
  if (end) {
    say()
    let after = actions.filter(a => a.t > end.t).length
    say(`last counts at ${at(end.t).trim()}${after ? `, ${after} later actions not reflected (the window ended inside the 100 ms throttle)` : ''}:`)
    say(`  ${['items', 'photos', 'selections', 'notes', 'transcriptions', 'tags', 'lists'].map(k => `${k} ${end[k]}`).join(', ')}`)
  }
  return out.join('\n')
}

if (require.main === module) {
  let file = process.argv[2]
  if (!file) {
    console.error('usage: node test/e2e/timeline.js <timeline.jsonl>')
    process.exit(2)
  }
  console.log(summarize(read(file)))
}

module.exports = { read, summarize }
