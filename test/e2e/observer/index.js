'use strict'

/**
 * Test only. Installed by test/e2e/harness.js as plugin entry #2, never
 * shipped. In a project window it appends one JSON object per line to the
 * file named by its `file` option:
 *
 *   { kind: 'start' }                     the plugin was created
 *   { kind: 'attach', activities }        the project store exists
 *   { kind: 'action', type, seq, ... }    every action that reached the store
 *   { kind: 'activity', phase, ms, ... }  a command started or finished
 *   { kind: 'counts', items, ... }        what the state holds (throttled)
 *   { kind: 'unload' }                    the plugin was unloaded (not on a kill)
 *
 * Every line has `t` (ms since the plugin started) and `at` (epoch ms).
 *
 * Actions are read by a saga that takes '*', not by wrapping
 * store.dispatch: a saga's `put` goes through the middleware chain without
 * touching store.dispatch, so a wrapper would miss most of what Tropy does.
 *
 * It must change nothing in Tropy and log nothing at warn or above (the
 * e2e suite fails on any Tropy log line at level 40+): every failure here
 * is swallowed.
 */

const fs = require('fs')
const path = require('path')

const COUNT_EVERY = 100 // ms; at most one counts line per period, always the last
const TAKE_ALL = { '@@redux-saga/IO': true, combinator: false, type: 'TAKE', payload: { pattern: '*' } }
const ENTITIES = ['items', 'photos', 'selections', 'notes', 'transcriptions', 'tags', 'lists']
const WATCHED = [...ENTITIES, 'project', 'nav', 'history']

const size = (o) => o == null ? 0 : Object.keys(o).length

class TestObserver {
  constructor(options, context) {
    let logger = context.logger || {}
    let win = context.window
    let prefs = typeof logger.chindings === 'string' && logger.chindings.includes('"name":"prefs"')
    if (prefs || !options.file || !win || (win.type && win.type !== 'project')) return

    this.started = Date.now()
    this.slices = {}
    this.activities = {}
    this.counts = null
    this.countedAt = 0
    this.timer = null
    try {
      fs.mkdirSync(path.dirname(options.file), { recursive: true })
      // Synchronous appends: the harness kills Tropy, and a line still
      // queued in a stream would be lost exactly when it matters.
      this.out = fs.openSync(options.file, 'a')
    } catch {
      return
    }
    this.write({ kind: 'start', window: win.type || null })

    // The window creates plugins before it imports its view, which creates
    // the store. Catch the assignment so no early action is missed.
    if (win.store) {
      this.attach(win.store)
    } else {
      let self = this
      this.win = win
      Object.defineProperty(win, 'store', {
        configurable: true,
        enumerable: true,
        get() { return undefined },
        set(store) {
          Object.defineProperty(win, 'store', { value: store, writable: true, configurable: true, enumerable: true })
          self.attach(store)
        }
      })
    }
  }

  write(line) {
    if (this.out == null) return
    try {
      let now = Date.now()
      fs.writeSync(this.out, JSON.stringify({ t: now - this.started, at: now, ...line }) + '\n')
    } catch { /* never disturb Tropy */ }
  }

  attach(store) {
    try {
      if (!store || this.store || this.out == null) return
      this.store = store
      let state = store.getState()
      this.activities = { ...(state.activities || {}) }
      this.write({
        kind: 'attach',
        activities: Object.values(this.activities).map(a => ({ id: a.id, type: a.type }))
      })
      this.writeCounts()
      this.unsubscribe = store.subscribe(() => this.changed())

      let record = (action) => this.action(action)
      if (store.saga && typeof store.saga.run === 'function') {
        this.task = store.saga.run(function* observe() {
          while (true) {
            let action = yield TAKE_ALL
            record(action)
          }
        })
      } else {
        // No saga middleware to listen on: wrap dispatch, and see only what
        // is dispatched from outside a saga.
        let dispatch = store.dispatch
        this.restore = () => { store.dispatch = dispatch }
        store.dispatch = function (action) {
          let result = dispatch.apply(this, arguments)
          record(action)
          return result
        }
      }
    } catch { /* never disturb Tropy */ }
  }

  action(action) {
    try {
      if (!action || typeof action !== 'object') return
      let meta = action.meta || {}
      let line = { kind: 'action', type: action.type, seq: meta.seq }
      for (let k of ['cmd', 'rel', 'done', 'history', 'plugin']) {
        if (meta[k] != null) line[k] = meta[k]
      }
      let size
      try {
        let json = JSON.stringify(action.payload)
        size = json === undefined ? 0 : json.length
      } catch { size = -1 }
      line.size = size
      if (action.error) {
        line.error = true
        let p = action.payload
        line.message = String((p && p.message) || (action.error && action.error.message) || p || '')
      }
      this.write(line)
    } catch { /* never disturb Tropy */ }
  }

  changed() {
    try {
      let state = this.store.getState()
      if (state.activities !== this.slices.activities) {
        this.slices.activities = state.activities
        this.diffActivities(state.activities || {})
      }
      let moved = false
      for (let k of WATCHED) {
        if (state[k] !== this.slices[k]) { this.slices[k] = state[k]; moved = true }
      }
      // Throttle, leading and trailing: write now if the last counts line
      // is old enough, else once the period is over, with the state then.
      if (moved && this.timer == null) {
        let wait = this.countedAt + COUNT_EVERY - Date.now()
        if (wait <= 0) this.writeCounts()
        else this.timer = setTimeout(() => { this.timer = null; this.writeCounts() }, wait)
      }
    } catch { /* never disturb Tropy */ }
  }

  diffActivities(next) {
    let now = Date.now()
    for (let id of Object.keys(next)) {
      if (!(id in this.activities)) {
        this.write({ kind: 'activity', phase: 'start', id: Number(id), type: next[id].type })
      }
    }
    for (let id of Object.keys(this.activities)) {
      if (!(id in next)) {
        let a = this.activities[id]
        this.write({
          kind: 'activity', phase: 'end', id: Number(id), type: a.type,
          ms: typeof a.init === 'number' ? now - a.init : null
        })
      }
    }
    this.activities = { ...next }
  }

  writeCounts() {
    try {
      let s = this.store.getState()
      let counts = {}
      for (let k of ENTITIES) counts[k] = size(s[k])
      counts.project = !!(s.project && s.project.path)
      counts.mode = s.nav ? s.nav.mode : null
      counts.query = s.nav ? s.nav.query : null
      counts.undo = s.history && s.history.past ? s.history.past.length : null
      counts.redo = s.history && s.history.future ? s.history.future.length : null
      let key = JSON.stringify(counts)
      if (key === this.counts) return // an unchanged line uses no period
      this.counts = key
      this.countedAt = Date.now()
      this.write({ kind: 'counts', ...counts })
    } catch { /* never disturb Tropy */ }
  }

  unload() {
    try {
      if (this.win && !this.store) delete this.win.store
      if (this.timer != null) { clearTimeout(this.timer); this.timer = null }
      if (this.store) this.writeCounts()
      if (this.unsubscribe) this.unsubscribe()
      if (this.task) this.task.cancel()
      if (this.restore) this.restore()
      this.write({ kind: 'unload' })
      if (this.out != null) fs.closeSync(this.out)
      this.out = null
    } catch { /* never disturb Tropy */ }
  }
}

module.exports = TestObserver
