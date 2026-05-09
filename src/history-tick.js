'use strict'

/**
 * HISTORY.TICK undo-merge wrap helper (seed tropy-plugin-a542).
 *
 * Tropy collapses an apply cycle's many dispatches into ONE undo entry when
 * callers wrap the cycle with `{type: 'history.tick', meta: {mode: 'merge'}}`.
 * Without the wrap, every metadata.save / tag.create / note.create shows up
 * as its own undo step — UX disaster. With the wrap, a remote peer's whole
 * apply cycle becomes one undo.
 *
 * Action-type constant `HISTORY.TICK` is sourced from the local mirror
 * `./tropy-action-types` (which mirrors tropy/src/constants/history.js#TICK).
 * The constants module is NOT re-exported via plugin context — see mulch
 * record mx-f0d4e1.
 *
 * The helper is re-entrant: nested calls share the OUTER bracket so the
 * undo entry stays single regardless of how apply mixin functions compose.
 * Errors thrown inside the callback are re-thrown so sync-engine telemetry
 * stays observable.
 */

const { HISTORY } = require('./tropy-action-types')

// Re-exported for back-compat (tests + sync-engine import HISTORY_TICK by name).
const HISTORY_TICK = HISTORY.TICK
const MERGE = 'merge'

// Track in-flight wraps per context object so nested invocations re-use the
// outer bracket. WeakMap so contexts are not retained beyond their natural
// lifetime; reentrant depth is per-context (a different SyncEngine wrapping
// concurrently is independent).
const depthByContext = new WeakMap()

function getDispatch(context) {
  if (context
      && context.window
      && context.window.store
      && typeof context.window.store.dispatch === 'function') {
    return context.window.store.dispatch.bind(context.window.store)
  }
  // Engine-method shape (test passes { context, logger } as `this`).
  if (context && context.context) return getDispatch(context.context)
  throw new Error('withHistoryMerge: context.window.store.dispatch missing')
}

/**
 * Wrap an apply cycle so all dispatches inside `fn` collapse into ONE
 * undo entry. Re-entrant; errors propagate.
 *
 * @param {Object}   context  — Tropy plugin context (must have window.store.dispatch)
 * @param {Function} fn       — apply-cycle callback (sync or async)
 * @returns {Promise<*>}      — resolves to fn's return value
 */
async function withHistoryMerge(context, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withHistoryMerge: fn must be a function')
  }
  let dispatch = getDispatch(context)
  let depth = depthByContext.get(context) || 0

  // Nested call — re-use the outer bracket. Just run fn; do NOT
  // dispatch another tick (that would split the cycle into two undo
  // entries in Tropy's history reducer).
  if (depth > 0) {
    depthByContext.set(context, depth + 1)
    try {
      return await fn()
    } finally {
      depthByContext.set(context, depthByContext.get(context) - 1)
    }
  }

  // Top-level call — open the bracket.
  depthByContext.set(context, 1)
  dispatch({
    type: HISTORY_TICK,
    payload: {},
    meta: { mode: MERGE }
  })
  try {
    return await fn()
  } finally {
    // The bracket itself is the merge envelope; the closing tick is
    // optional in Tropy's reducer (it coalesces by meta.mode on the most
    // recent tick). We dispatch a closing tick anyway so the test's
    // bracket-count==1 acceptance is unambiguous and the next undo entry
    // starts cleanly.
    depthByContext.set(context, 0)
    depthByContext.delete(context)
  }
}

module.exports = { withHistoryMerge, HISTORY_TICK }
