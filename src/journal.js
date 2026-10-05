'use strict'

/**
 * What Troparcel did recently, kept for the dashboard: a few hundred
 * events in memory, newest first. Nothing here is saved or shared.
 *
 *   let journal = new Journal()
 *   journal.event('alice added 3 notes, on one item')
 *   journal.problem('Cannot reach the server at …')
 *   journal.conflict({ identity, field, localValue, remoteValue, author })
 *   journal.recent()          // [{ at, text }]
 *   journal.openConflicts()   // one per item and field, latest kept
 *
 * Problems are written for the person reading the dashboard, where each
 * one happens; technical detail stays in Tropy's log. (Recording every
 * log warning showed people lines like "applyTemplates failed".)
 */
class Journal {
  constructor(size = 200) {
    this.size = size
    this._events = []
    this._problems = []
    this._conflicts = new Map() // identity|field → conflict
  }

  event(text, detail = {}) {
    this._push(this._events, { at: Date.now(), text, ...detail })
  }

  problem(text) {
    // Repeated problems (a server down for an hour) are one line with a count.
    let last = this._problems[0]
    if (last && last.text === text) {
      last.count++
      last.at = Date.now()
      return
    }
    this._push(this._problems, { at: Date.now(), text, count: 1 })
  }

  conflict({ identity, field, ...detail }) {
    this._conflicts.set(`${identity}|${field}`, { at: Date.now(), identity, field, ...detail })
  }

  resolve(identity, field) {
    this._conflicts.delete(`${identity}|${field}`)
  }

  recent(n = 30) {
    return this._events.slice(0, n)
  }

  problems(n = 20) {
    return this._problems.slice(0, n)
  }

  openConflicts() {
    return [...this._conflicts.values()].sort((a, b) => b.at - a.at)
  }

  _push(list, entry) {
    list.unshift(entry)
    if (list.length > this.size) list.length = this.size
  }
}

module.exports = { Journal }
