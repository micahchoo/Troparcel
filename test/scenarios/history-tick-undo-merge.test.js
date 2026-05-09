'use strict'

/**
 * HISTORY.TICK undo-merge — TDD anchor for seed tropy-plugin-2b6d
 * (which depends on tropy-plugin-a542's implementation of the
 * HISTORY.TICK wrap helper).
 *
 * STATUS: skip — pending `tropy-plugin-a542` implementation. When the wrap
 * helper lands (likely on SyncEngine or as a free function), the implementor
 * flips skip→active and points the test at the real entry point.
 *
 * Background (see troparcel/docs/architecture/subsystems/plugin-entry.md
 * §a542 + §2b6d):
 *
 *   Tropy collapses an apply cycle's many dispatches into ONE undo entry
 *   when callers wrap the cycle with `{type: 'history.tick', meta: {mode:
 *   'merge'}}`. Without the wrap, every `metadata.save` / `tag.create` /
 *   `note.create` shows up as its own undo step — UX disaster. With the
 *   wrap, a remote peer's whole apply cycle is one undo.
 *
 *   The dispatch path is `context.window.store.dispatch(...)` — the same
 *   pathway already used for note.create etc. in store-adapter.js. The
 *   action literal is `'history.tick'` (per tropy/src/constants/history.js:4
 *   — troparcel mirrors it locally per the b4eb decision).
 *
 * What this file pre-locks:
 *   1. Wrap entry — the implementor exposes a function that takes a
 *      callback (the apply cycle) and brackets it with TICK actions.
 *   2. Single undo entry — ALL writes inside the callback share one
 *      `meta: {mode: 'merge'}` envelope, so Tropy's history reducer
 *      coalesces them.
 *   3. Spy-able shape — the test mocks `context.window.store.dispatch`
 *      and asserts on call args; no real Redux store, no electron.
 *
 * Mock surface (matches the plugin-entry.md §2b6d test plan):
 *   context = { logger, dialog, json, sharp,
 *               window: { store: { getState, dispatch (spy), subscribe } } }
 *
 * Mulch context: mx-864ee7 (W5.T1 study), and the plugin-entry.md doc.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const PENDING = 'pending tropy-plugin-a542 implementation'

// ---------------------------------------------------------------------------
// Mock context factory — no electron, no real store, no ipc.
// ---------------------------------------------------------------------------
function makeMockContext() {
  const dispatchedActions = []
  const subscribers = new Set()
  const silentLogger = {
    trace: () => {}, debug: () => {}, info: () => {},
    warn: () => {}, error: () => {},
    child: () => silentLogger
  }
  const store = {
    // Minimal Tropy-shaped state — enough for the plugin's readiness check
    // to short-circuit (project.path present means _waitForStore exits).
    getState: () => ({
      project: { path: '/mock/project.tpy', name: 'mock' },
      flash: [],
      history: { past: [], future: [] }
    }),
    dispatch: (action) => {
      dispatchedActions.push(action)
      // Notify subscribers so plugin code that uses subscribe() doesn't hang.
      for (const fn of subscribers) {
        try { fn() } catch { /* ignore */ }
      }
      return action
    },
    subscribe: (fn) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    }
  }
  return {
    context: {
      logger: silentLogger,
      dialog: { notify: () => {} },
      json: null,
      sharp: null,
      window: {
        type: 'project',
        args: { type: 'project' },
        store
      }
    },
    dispatchedActions
  }
}

// ---------------------------------------------------------------------------
// Locate the wrap helper. Pre-a542 it does not exist — every test in this
// file is skipped until the implementor wires this up.
//
// Three plausible homes (the implementor picks one):
//   - SyncEngine.prototype.applyWithHistoryMerge(fn)  → engine method
//   - apply mixin: this._withHistoryMerge(fn)         → mixin function
//   - free helper: require('../../src/history').withHistoryMerge(ctx, fn)
//
// This test resolves whichever exists; if none, it explains.
// ---------------------------------------------------------------------------
function resolveWrap() {
  // Try the free-helper module first (cleanest seam).
  try {
    const mod = require('../../src/history-tick')
    if (mod && typeof mod.withHistoryMerge === 'function') {
      return { kind: 'free', fn: mod.withHistoryMerge }
    }
  } catch { /* module not present yet */ }
  // Try the SyncEngine method.
  try {
    const { SyncEngine } = require('../../src/sync-engine')
    if (SyncEngine && typeof SyncEngine.prototype.applyWithHistoryMerge === 'function') {
      return { kind: 'engine', fn: SyncEngine.prototype.applyWithHistoryMerge }
    }
  } catch { /* not present */ }
  return null
}

// ---------------------------------------------------------------------------

test('HISTORY.TICK wrap: helper exists and is callable',
  { skip: PENDING },
  () => {
    const wrap = resolveWrap()
    assert.ok(wrap,
      'a542 must expose either:\n' +
      '  • src/history-tick.js → withHistoryMerge(context, fn)  OR\n' +
      '  • SyncEngine.prototype.applyWithHistoryMerge(fn)\n' +
      'so 2b6d can target one stable surface.')
  })

test('HISTORY.TICK wrap: a single apply cycle dispatches ONE merge envelope',
  { skip: PENDING },
  async () => {
    const { context, dispatchedActions } = makeMockContext()
    const wrap = resolveWrap()

    // Run an apply cycle that itself dispatches 3 writes.
    await invokeWrap(wrap, context, () => {
      context.window.store.dispatch({ type: 'tag.create', payload: { id: 1 } })
      context.window.store.dispatch({ type: 'tag.save',   payload: { id: 1, name: '@alice' } })
      context.window.store.dispatch({ type: 'item.tags.add', payload: { id: [42], tags: [1] } })
    })

    // Acceptance criterion: tropy collapses these into ONE undo entry. The
    // load-bearing observation is the `meta: {mode: 'merge'}` envelope on
    // the wrapped writes (or surrounding TICK actions). The exact wire
    // shape is the implementor's call — these assertions accept either:
    //
    //   (a) every nested write carries `meta.mode === 'merge'`     OR
    //   (b) the cycle is bracketed by ONE history.tick action with
    //       `meta.mode === 'merge'` (and nested writes are unmodified).
    //
    // What we forbid: zero merge envelopes (= UX failure, multiple undos),
    // and N merge envelopes for N writes (= no coalescing, same failure).
    const tickActions = dispatchedActions.filter(a => a.type === 'history.tick')
    const mergedWrites = dispatchedActions.filter(
      a => a.meta && a.meta.mode === 'merge' && a.type !== 'history.tick')

    const mergeBracketCount = tickActions.filter(
      a => a.meta && a.meta.mode === 'merge').length

    const looksBracketed = mergeBracketCount === 1
    const looksTagged    = mergedWrites.length === 3

    assert.ok(looksBracketed || looksTagged,
      `expected exactly one merge envelope for the apply cycle; got ` +
      `${mergeBracketCount} bracketing ticks and ${mergedWrites.length}/3 ` +
      `merge-tagged writes. Dispatched: ${
        JSON.stringify(dispatchedActions.map(a => a.type))}`)

    // The 3 underlying writes must all be present, regardless of which
    // shape the implementor chose.
    const writeTypes = dispatchedActions
      .filter(a => a.type !== 'history.tick')
      .map(a => a.type)
    assert.deepEqual(writeTypes, ['tag.create', 'tag.save', 'item.tags.add'],
      'all 3 writes must reach the store, in order')
  })

test('HISTORY.TICK wrap: nested calls do NOT double-bracket',
  { skip: PENDING },
  async () => {
    const { context, dispatchedActions } = makeMockContext()
    const wrap = resolveWrap()

    // Apply mixin functions sometimes nest (e.g. applyMetadata called
    // from inside applyRemoteAnnotations). The wrap must be re-entrant
    // without producing N undo entries.
    await invokeWrap(wrap, context, async () => {
      context.window.store.dispatch({ type: 'tag.create', payload: { id: 1 } })
      await invokeWrap(wrap, context, () => {
        context.window.store.dispatch({ type: 'note.create', payload: { id: 9 } })
      })
      context.window.store.dispatch({ type: 'item.tags.add', payload: { id: [1], tags: [1] } })
    })

    const tickActions = dispatchedActions.filter(a => a.type === 'history.tick')
    const mergedWrites = dispatchedActions.filter(
      a => a.meta && a.meta.mode === 'merge' && a.type !== 'history.tick')

    const mergeBracketCount = tickActions.filter(
      a => a.meta && a.meta.mode === 'merge').length

    // Exactly ONE undo bracket OR all 3 writes tagged — never 2 brackets,
    // never partial tagging.
    const ok =
      (mergeBracketCount === 1 && mergedWrites.length === 0) ||
      (mergeBracketCount === 0 && mergedWrites.length === 3)
    assert.ok(ok,
      `nested wrap must coalesce; got ${mergeBracketCount} brackets ` +
      `and ${mergedWrites.length}/3 tagged writes.`)
  })

test('HISTORY.TICK wrap: callback throws → wrap still re-throws (no swallow)',
  { skip: PENDING },
  async () => {
    const { context } = makeMockContext()
    const wrap = resolveWrap()

    let caught = null
    try {
      await invokeWrap(wrap, context, () => {
        throw new Error('boom')
      })
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'wrap must propagate callback errors — silent swallow' +
      ' would make apply-cycle failures invisible to sync-engine telemetry')
    assert.equal(caught.message, 'boom')
  })

// ---------------------------------------------------------------------------

/** Invoke whichever wrap surface the implementor exposed. */
function invokeWrap(wrap, context, fn) {
  if (wrap.kind === 'free') {
    return wrap.fn(context, fn)
  }
  // Engine-method shape — bind a minimal `this` with `context` field.
  return wrap.fn.call({ context, logger: context.logger }, fn)
}
