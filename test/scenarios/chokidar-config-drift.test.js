'use strict'

/**
 * Chokidar Config Drift — regression net for upstream Watcher option changes.
 *
 * Seed: tropy-plugin-5767 (P2, Wave 6).
 *
 * Why this exists:
 *   Troparcel's _startFileWatcher (sync-engine.js, mulch mx-dc627d, seed
 *   b5de) replaced fs.watch+R9 health-check with chokidar.watch(). The
 *   options dict was modeled on tropy/src/common/watch.js Watcher class
 *   (mx-eb5334). If Tropy changes its Watcher options in a future release
 *   — say to address a chokidar deprecation, or to adopt a new flag like
 *   `useFsEvents` on macOS — troparcel won't notice until production
 *   users hit the regression (mx-67d331-style SQLITE_BUSY race
 *   re-emerges).
 *
 * What this test does:
 *   1. Reads the chokidar opts dict literally embedded in
 *      troparcel/src/sync-engine.js (parsed by static text scan — there is
 *      no exported constant; if/when sync-engine refactors to export
 *      WATCH_OPTS, switch this test to import it directly).
 *   2. Reads tropy/src/common/watch.js and extracts the Watcher's chokidar
 *      options literal.
 *   3. Computes the load-bearing intersection (keys both sides set with the
 *      same value), the divergent keys, and the troparcel-only keys.
 *   4. Asserts the load-bearing options agree. Documents known divergences
 *      below so the test won't flap on intentional differences.
 *
 * Known divergences pinned today (NOT regressions):
 *
 *   - `followSymLinks` (Tropy, capital L) vs `followSymlinks` (troparcel,
 *     lowercase l). chokidar's actual option name is `followSymlinks`
 *     (lowercase) — Tropy's Watcher passes the wrong key, which chokidar
 *     silently ignores and falls back to default (true). This is an
 *     UPSTREAM TYPO in tropy/src/common/watch.js with no functional impact
 *     on Tropy (it watches single files via Watcher.watch(path)). Troparcel
 *     correctly uses lowercase. Pinning this divergence so the test
 *     doesn't flap and the typo is documented.
 *
 *   - `usePolling: false`, `depth: 0`, `persistent: false` are
 *     troparcel-only — Tropy's Watcher doesn't set them (chokidar defaults
 *     apply). Troparcel sets them explicitly to bound the watch surface
 *     to a single project file (mx-dc627d).
 *
 *   - Tropy's Watcher additionally sets `ignoreInitial: (since == null)`,
 *     a runtime expression. Troparcel pins it to `true` (we never want the
 *     initial-add fanout for the project file). The assertion below checks
 *     they BOTH set ignoreInitial=true in the no-`since` calling
 *     convention troparcel uses — that's the load-bearing equivalence.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const TROPARCEL_SYNC_ENGINE = path.resolve(
  __dirname, '..', '..', 'src', 'sync-engine.js'
)
const TROPY_WATCH_JS = path.resolve(
  __dirname, '..', '..', '..', 'tropy', 'src', 'common', 'watch.js'
)

// ──────────────────────────────────────────────────────────────────────────
// Source-of-truth extraction
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pull the literal options object troparcel's sync-engine passes to
 * chokidar.watch(). Returns the dict, or throws with a clear message.
 *
 * We parse the source rather than require()-ing sync-engine because
 * sync-engine pulls in y-websocket, ws, the StoreAdapter, etc. — too
 * heavy for a Tier-1 unit test. If/when sync-engine exports WATCH_OPTS
 * as a constant, swap this for `require('../../src/sync-engine').WATCH_OPTS`.
 */
function extractTroparcelWatchOpts() {
  const src = fs.readFileSync(TROPARCEL_SYNC_ENGINE, 'utf-8')
  const re = /chokidar\.watch\([^,]+,\s*(\{[\s\S]*?\})\s*\)/m
  const m = re.exec(src)
  assert.ok(m,
    `Could not find chokidar.watch(...) call in ${TROPARCEL_SYNC_ENGINE}. ` +
    `If the watcher was refactored, update extractTroparcelWatchOpts.`)
  // Safe-eval the literal — it's a pure data dict from our own source.
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${m[1]});`)()
}

/**
 * Pull the chokidar options literal from tropy/src/common/watch.js
 * Watcher#watch — the call to chokidar.watch(path, {...}). Tropy spreads
 * caller `opts` into the dict; we extract only the hard-coded keys
 * (those Tropy sets unconditionally), since troparcel's behavior is
 * compared against the no-extra-opts code path.
 */
function extractTropyWatchOpts() {
  const src = fs.readFileSync(TROPY_WATCH_JS, 'utf-8')
  // Match `chokidar.watch(path, { ...opts, KEY: VALUE, ... })`.
  const re = /chokidar\.watch\([^,]+,\s*(\{[\s\S]*?\})\s*\)/m
  const m = re.exec(src)
  assert.ok(m,
    `Could not find chokidar.watch(...) call in ${TROPY_WATCH_JS}. ` +
    `Tropy's Watcher class may have moved or been refactored — investigate.`)
  // The dict contains `...opts` which we cannot eval. Strip it and parse.
  let body = m[1].replace(/\.\.\.opts,?\s*/, '')
  // Tropy's `ignoreInitial: (since == null)` evaluates to true in
  // troparcel's calling convention (no `since`). Pin it to true for
  // comparison purposes — that's the realized value we actually consume.
  body = body.replace(/ignoreInitial:\s*\(?since == null\)?/, 'ignoreInitial: true')
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${body});`)()
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

test('chokidar drift: troparcel sync-engine.js _startFileWatcher exposes a parseable opts dict', () => {
  const opts = extractTroparcelWatchOpts()
  assert.equal(typeof opts, 'object')
  assert.ok('awaitWriteFinish' in opts, 'awaitWriteFinish key required (mx-67d331)')
  assert.ok('alwaysStat' in opts, 'alwaysStat key required (mx-67d331)')
  assert.ok('ignoreInitial' in opts)
})

test('chokidar drift: tropy/src/common/watch.js Watcher class file still exists', () => {
  const stat = fs.statSync(TROPY_WATCH_JS)
  assert.ok(stat.isFile(), `expected ${TROPY_WATCH_JS} to be a file`)
  const src = fs.readFileSync(TROPY_WATCH_JS, 'utf-8')
  assert.match(src, /export\s+class\s+Watcher\b/,
    'Watcher class export missing — Tropy may have renamed/moved it')
  assert.match(src, /chokidar\.watch\(/,
    'Watcher no longer calls chokidar.watch — investigate before adopting changes')
})

test('chokidar drift: load-bearing options agree between troparcel and tropy Watcher', () => {
  const trop = extractTroparcelWatchOpts()
  const tropy = extractTropyWatchOpts()

  // Load-bearing options — these MUST agree. If they ever diverge,
  // troparcel's race-defeat behavior (mx-67d331) is at risk.
  const LOAD_BEARING = ['awaitWriteFinish', 'alwaysStat', 'ignoreInitial']

  for (const key of LOAD_BEARING) {
    assert.equal(
      trop[key], tropy[key],
      `${key} drifted: troparcel=${JSON.stringify(trop[key])} ` +
      `vs tropy=${JSON.stringify(tropy[key])}. ` +
      `Sources: ${TROPARCEL_SYNC_ENGINE} (line ~590), ${TROPY_WATCH_JS}.`
    )
  }
})

test('chokidar drift: known divergences pinned (will fail when upstream typo is fixed)', () => {
  const tropy = extractTropyWatchOpts()
  // Tropy passes `followSymLinks` (capital L) — chokidar's actual name is
  // `followSymlinks` (lowercase l). When upstream fixes this typo, this
  // assert flips and we should adopt the corrected key (already correct
  // in troparcel — this test forces a code review of the change).
  assert.ok(
    'followSymLinks' in tropy,
    'tropy Watcher used to pass followSymLinks (capital L typo). ' +
    'If this assert fires, upstream fixed the typo — adopt the correct ' +
    '`followSymlinks` (lowercase l) and remove this divergence pin.'
  )
})

test('chokidar drift: troparcel-only keys constrained to single-file watching', () => {
  const trop = extractTroparcelWatchOpts()
  // These are bounded-watch-surface keys troparcel adds beyond what
  // Tropy's Watcher specifies. They are expected; this test pins them so
  // accidental removal is caught.
  assert.equal(trop.usePolling, false, 'usePolling pinned false (no polling overhead)')
  assert.equal(trop.depth, 0, 'depth pinned 0 (single file, no recursion)')
  assert.equal(trop.persistent, false, 'persistent pinned false (do not block exit)')
  assert.equal(trop.followSymlinks, false, 'troparcel uses CORRECT lowercase-l form')
})
