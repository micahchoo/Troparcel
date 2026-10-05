'use strict'

/**
 * A real Troparcel server in a child process, on a free port, with its data
 * in a temp folder. Stopped and removed when the test ends.
 *
 *   let port = await startServer(t, { AUTH_TOKENS: 'r:0123456789abcdef' })
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
  let proc = spawn('node', [path.join(__dirname, '../../server/index.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PERSISTENCE_DIR: dataDir, ...env },
    stdio: 'ignore'
  })
  process.on('exit', () => { if (proc.exitCode === null) proc.kill('SIGKILL') })
  t.after(() => {
    proc.kill('SIGTERM')
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false }
  })
  return port
}

module.exports = { startServer, until, sleep }
