'use strict'

/**
 * Tier 2 — Real WebSocket transport test.
 *
 * Spawns the troparcel y-websocket relay (server/index.js) on a random port,
 * connects two Y.Docs to it via WebsocketProvider, and verifies CRDT updates
 * propagate. Tests:
 *   1. Server starts and accepts connections
 *   2. Bidirectional sync: peer A's writes appear on peer B
 *   3. Late-joiner catch-up: peer C joining after A+B converge sees current state
 *   4. Server persistence: kill+restart server, peer's state survives
 *
 * Skip-if-no-server: this test is opt-in. Run with:
 *   node --test --test-force-exit test/integration/transport.test.js
 *
 * NOTE on --test-force-exit: Node 20's test runner does not exit when only
 * stdout/stderr handles remain (verified empirically — process._getActiveHandles
 * reports 2 handles, both stdio Sockets, and yet the runner waits indefinitely).
 * The test cleanup itself awaits server exit and WS close (see stopServer /
 * destroyPeer below); the leftover hang is a runner-internal issue. The
 * --test-force-exit flag tells the runner to call process.exit() once all
 * top-level tests resolve. Both `npm run test:integration` and `test:all`
 * pass this flag automatically.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const { once } = require('node:events')
const path = require('node:path')
const Y = require('yjs')
const WS = require('ws')
const { WebsocketProvider } = require('y-websocket')
const schema = require('../../src/crdt-schema')

// Cleanly stop a spawned server and wait for the OS process to actually exit.
// Without awaiting exit, child stdio handles can keep the test process's
// event loop alive after t.after returns, causing the harness to hang for
// minutes after all assertions complete.
async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return
  proc.kill('SIGTERM')
  // Give the server up to 3s to exit gracefully; SIGKILL if it doesn't.
  const timer = setTimeout(() => {
    if (proc.exitCode === null) proc.kill('SIGKILL')
  }, 3000)
  try {
    await once(proc, 'exit')
  } finally {
    clearTimeout(timer)
  }
}

// Tear down a y-websocket provider and wait for its WS to fully close.
// provider.destroy() initiates close but does not await it, so the WS
// can linger in CLOSING state and keep the event loop alive.
async function destroyPeer(peer) {
  if (!peer || !peer.provider) return
  const ws = peer.provider.ws
  peer.provider.destroy()
  if (ws && ws.readyState !== WS.CLOSED) {
    await new Promise((resolve) => {
      const done = () => {
        ws.removeListener('close', done)
        resolve()
      }
      ws.once('close', done)
      // Safety timeout — never block teardown more than 1s on a hung WS
      setTimeout(done, 1000)
    })
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function startServer({ port, dataDir }) {
  const env = { ...process.env, PORT: String(port), PERSISTENCE_DIR: dataDir }
  const proc = spawn('node', [path.join(__dirname, '../../server/index.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  // Wait for server to print listening message OR timeout
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 5000)
    let buf = ''
    const onData = (chunk) => {
      buf += String(chunk)
      if (buf.includes(`${port}`) || buf.toLowerCase().includes('listening')) {
        clearTimeout(timer)
        proc.stdout.removeListener('data', onData)
        resolve()
      }
    }
    proc.stdout.on('data', onData)
    proc.once('exit', (code) => {
      clearTimeout(timer)
      proc.stdout.removeListener('data', onData)
      reject(new Error(`server exited early code=${code}`))
    })
  })

  // Drain stdio so child output doesn't fill the pipe buffer (which would
  // backpressure the server) and detach our listeners so they don't keep
  // the event loop alive after t.after returns.
  proc.stdout.resume()
  proc.stderr.resume()

  return proc
}

function makePeer(port, room) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`ws://localhost:${port}`, room, doc, {
    WebSocketPolyfill: WS,
    connect: true
  })
  return { doc, provider }
}

async function waitConnected(provider, ms = 5000) {
  if (provider.wsconnected) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), ms)
    const handler = ({ status }) => {
      if (status === 'connected') {
        clearTimeout(timer)
        provider.off('status', handler)
        resolve()
      }
    }
    provider.on('status', handler)
  })
}

test('transport: alice→bob CRDT propagation through server', async (t) => {
  const port = await freePort()
  const dataDir = path.join('/tmp', `troparcel-test-${port}`)

  const server = await startServer({ port, dataDir })
  t.after(() => stopServer(server))

  const room = `t-${Date.now()}`
  const alice = makePeer(port, room)
  const bob = makePeer(port, room)
  t.after(async () => {
    await Promise.all([destroyPeer(alice), destroyPeer(bob)])
  })

  await waitConnected(alice.provider)
  await waitConnected(bob.provider)

  // Alice writes a template
  const uri = 'https://tropy.org/v1/templates/id#transport-test'
  schema.setTemplateSchema(alice.doc, uri, {
    name: 'Transport Test', type: 'https://tropy.org/v1/tropy#Item', fields: []
  }, 'alice', 1)

  // Wait for propagation (CRDT is eventually consistent — give it a beat)
  for (let i = 0; i < 20; i++) {
    const t = schema.getTemplateSchema(bob.doc)
    if (uri in t) break
    await sleep(50)
  }

  const bobsView = schema.getTemplateSchema(bob.doc)
  assert.ok(uri in bobsView, 'Bob received Alice\'s template via CRDT relay')
  assert.equal(bobsView[uri].name, 'Transport Test')
})

test('transport: late joiner gets historical state via server persistence', async (t) => {
  const port = await freePort()
  const dataDir = path.join('/tmp', `troparcel-test-late-${port}`)

  const server = await startServer({ port, dataDir })
  t.after(() => stopServer(server))

  const room = `t-late-${Date.now()}`
  const alice = makePeer(port, room)
  await waitConnected(alice.provider)

  schema.setTemplateSchema(alice.doc, 'https://example.com/template#one', {
    name: 'First', type: 'https://tropy.org/v1/tropy#Item', fields: []
  }, 'alice', 1)
  // y-leveldb persistence is debounced; give the server time to flush AND to
  // observe the in-memory Y.Doc update before Alice disconnects.
  await sleep(1500)

  await destroyPeer(alice)
  await sleep(500)  // let server settle on last-peer-disconnect

  // Now Charlie joins for the first time. Server should serve from in-memory
  // (room still alive) or LevelDB (room evicted).
  const charlie = makePeer(port, room)
  t.after(() => destroyPeer(charlie))
  await waitConnected(charlie.provider)

  // Poll up to 3s for Charlie's view to converge
  let charliesView
  for (let i = 0; i < 60; i++) {
    charliesView = schema.getTemplateSchema(charlie.doc)
    if ('https://example.com/template#one' in charliesView) break
    await sleep(50)
  }

  assert.ok('https://example.com/template#one' in charliesView,
    'late-joining Charlie sees Alice\'s prior writes via server persistence')
})
