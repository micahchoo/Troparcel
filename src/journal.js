'use strict'

/**
 * What Troparcel did recently, kept for the dashboard: a few hundred
 * events in memory, newest first. Nothing here is saved or shared.
 *
 *   let journal = new Journal()
 *   journal.event('Received 3 notes from alice')
 *   journal.problem('Cannot reach the server at …')
 *   journal.conflict({ identity, field, localValue, remoteValue, author })
 *   journal.recent()          // [{ at, text }]
 *   journal.openConflicts()   // one per item and field, latest kept
 *
 * `watch(logger)` returns a logger that also records its warnings and
 * errors as problems, so every warning Troparcel writes reaches the page.
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

  /** A logger that also records warnings and errors here. */
  watch(logger) {
    let journal = this
    let text = args => args.map(a => (typeof a === 'string' ? a : (a && a.message) || '')).filter(Boolean).join(' ')
      .replace(/^\[troparcel\]\s*/, '')
    return new Proxy(logger, {
      get(target, prop) {
        if (prop === 'warn' || prop === 'error') {
          return (...args) => {
            journal.problem(text(args))
            return target[prop](...args)
          }
        }
        let value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
}

module.exports = { Journal }
