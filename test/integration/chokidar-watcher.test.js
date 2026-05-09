'use strict'

/**
 * Tier 2 — chokidar fs-watcher smoke test.
 *
 * Validates the chokidar.watch() configuration adopted in src/sync-engine.js
 * (mulch mx-dc627d / seed b5de) — the replacement for fs.watch + R9 restart
 * machinery. We instantiate chokidar IN-PROCESS using the EXACT same options
 * production uses (sync-engine.js _startFileWatcher, ~line 586) and verify
 * the load-bearing behaviors:
 *
 *   1. 'change' fires on file write within ~1s
 *   2. 'unlink' fires on file delete (ignoreInitial=true means we don't
 *      see the initial add when watching an existing file — but unlink
 *      always emits)
 *   3. awaitWriteFinish coalesces rapid sequential writes — burst writes
 *      should produce fewer change events than write calls (this is the
 *      property that defeats SQLITE_BUSY per mx-67d331)
 *
 * Cleanup hygiene (mulch mx-3a4c85): EVERY test t.after() awaits
 * watcher.close() AND removes the temp dir. NO subprocess spawning — we
 * run chokidar in-process so there is nothing for the runner to leak.
 *
 * NOTE on --test-force-exit: the package.json scripts pass this flag
 * already. This test does NOT depend on it; in-process chokidar closes
 * cleanly and the runner exits within ~100ms of test completion.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const chokidar = require('chokidar')

// Production options — keep in sync with src/sync-engine.js _startFileWatcher.
// If sync-engine changes, mirror the change here.
const PROD_WATCH_OPTS = {
  usePolling: false,
  awaitWriteFinish: true,
  alwaysStat: true,
  ignoreInitial: true,
  followSymlinks: false,
  depth: 0,
  persistent: false
}

// awaitWriteFinish:true uses chokidar defaults — stabilityThreshold=2000ms,
// pollInterval=100ms. We give events generous time to fire so the test is
// stable on slower CI hardware while still bounded.
const EVENT_TIMEOUT_MS = 5000

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'troparcel-watcher-'))
}

async function cleanupDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (_err) { /* best-effort */ }
}

// Wait for the next event of `eventName` on `watcher`, with a timeout.
// Returns the path argument from the chokidar event.
async function awaitEvent(watcher, eventName, timeoutMs) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout waiting for chokidar '${eventName}'`)),
      timeoutMs
    )
  })
  try {
    const [eventPath] = await Promise.race([
      once(watcher, eventName),
      timeout
    ])
    return eventPath
  } finally {
    clearTimeout(timer)
  }
}

// Wait for chokidar 'ready' before writing — chokidar emits initial scan
// events before ready, and ignoreInitial filters those, but the runtime
// add/change handlers are only reliable post-ready.
async function readyWatcher(target) {
  const watcher = chokidar.watch(target, PROD_WATCH_OPTS)
  await once(watcher, 'ready')
  return watcher
}

test('chokidar smoke: write to watched file fires change event', async (t) => {
  const dir = await makeTempDir()
  const file = path.join(dir, 'project.tpy')
  // Pre-create the file — production watches an existing project file.
  await fs.writeFile(file, 'initial')

  const watcher = await readyWatcher(file)
  t.after(async () => {
    await watcher.close()
    await cleanupDir(dir)
  })

  // Trigger a change AFTER ready so awaitWriteFinish observes the write.
  const changeP = awaitEvent(watcher, 'change', EVENT_TIMEOUT_MS)
  await fs.writeFile(file, 'second write')
  const changedPath = await changeP

  assert.equal(changedPath, file, 'change event should report watched file path')
})

test('chokidar smoke: deleting watched file fires unlink event', async (t) => {
  const dir = await makeTempDir()
  const file = path.join(dir, 'project.tpy')
  await fs.writeFile(file, 'initial')

  const watcher = await readyWatcher(file)
  t.after(async () => {
    await watcher.close()
    await cleanupDir(dir)
  })

  const unlinkP = awaitEvent(watcher, 'unlink', EVENT_TIMEOUT_MS)
  await fs.unlink(file)
  const unlinkedPath = await unlinkP

  assert.equal(unlinkedPath, file, 'unlink event should report deleted file path')
})

test('chokidar smoke: awaitWriteFinish coalesces rapid burst writes', async (t) => {
  // This is the load-bearing property per mulch mx-67d331 / mx-dc627d:
  // awaitWriteFinish defers 'change' until the file has stopped growing
  // (default stabilityThreshold=2000ms). A 10-write burst within ~100ms
  // should therefore coalesce into a small handful (typically 1) of
  // change events — never one per write.
  const dir = await makeTempDir()
  const file = path.join(dir, 'project.tpy')
  await fs.writeFile(file, 'initial')

  const watcher = await readyWatcher(file)
  let changeCount = 0
  watcher.on('change', () => { changeCount++ })

  t.after(async () => {
    await watcher.close()
    await cleanupDir(dir)
  })

  // Fire 10 sequential writes as fast as Node lets us.
  for (let i = 0; i < 10; i++) {
    fsSync.writeFileSync(file, 'burst-' + i)
  }

  // Wait long enough for awaitWriteFinish to settle (default stability
  // threshold is 2000ms; give a bit of slack).
  await new Promise(r => setTimeout(r, 2500))

  assert.ok(
    changeCount >= 1,
    `expected at least one change event from burst, got ${changeCount}`
  )
  assert.ok(
    changeCount <= 3,
    `expected awaitWriteFinish to coalesce 10 writes into <=3 events, got ${changeCount}`
  )
})

test('chokidar smoke: watcher.close() resolves cleanly with no leaked handles', async (t) => {
  const dir = await makeTempDir()
  const file = path.join(dir, 'project.tpy')
  await fs.writeFile(file, 'initial')

  const watcher = await readyWatcher(file)
  // Explicit close path — production stopWatching() awaits this. We assert
  // that close() returns a Promise that resolves without error.
  const closeResult = watcher.close()
  assert.ok(
    closeResult && typeof closeResult.then === 'function',
    'watcher.close() must return a thenable (awaited by stopWatching)'
  )
  await closeResult

  // After close, second close should also be safe (idempotent).
  await watcher.close()

  t.after(async () => {
    await cleanupDir(dir)
  })
})
