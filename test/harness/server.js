'use strict'

/**
 * A real Troparcel server in a child process, on a free port, with its data
 * in a temp folder. Stopped and removed when the test ends.
 *
 *   let { port, dataDir } = await startServer(t, { AUTH_TOKENS: 'r:0123456789abcdef' })
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    let srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      let { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function until(fn, ms = 10000) {
  let end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(50)
  }
  throw new Error('timed out')
}

async function startServer(t, env = {}) {
  let port = await freePort()
  let dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troparcel-compact-'))
  let proc
  let spawnServer = async () => {
    proc = spawn('node', [path.join(__dirname, '../../server/index.js')], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PERSISTENCE_DIR: dataDir, ...env },
      stdio: 'ignore'
    })
    await until(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false }
    }, 30000) // a loaded machine starts node slowly; startup is not what these tests measure
  }
  process.on('exit', () => { if (proc.exitCode === null) proc.kill('SIGKILL') })
  t.after(async () => {
    // The server may still be writing its database: wait for it to exit,
    // or rmSync meets a file it just created (ENOTEMPTY, seen on CI).
    if (proc.exitCode === null && proc.signalCode === null) {
      let dead = new Promise(r => proc.once('exit', r))
      proc.kill('SIGTERM')
      await dead
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  await spawnServer()

  /** Kill the server as a crash would, then start it again on the same port and data. */
  let outage = async (ms) => {
    let dead = new Promise(r => proc.once('exit', r))
    proc.kill('SIGKILL')
    await dead
    await sleep(ms)
    await spawnServer()
  }
  return { port, dataDir, outage }
}

module.exports = { startServer, until, sleep }
