'use strict'

/**
 * Settings apply without restarting Tropy: Tropy watches the plugin config
 * and re-creates plugins when it changes (main/tropy.js 'plugins-reload').
 * Troparcel must stop its old engine and start the new one cleanly.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Run, build, until } = require('./harness')

test('changing Troparcel\'s settings takes effect without a restart', { timeout: 300000 }, async (t) => {
  build()
  let run = new Run('settings')
  run.room = `settings-${Date.now()}`
  t.after(() => run.stop())
  await run.startServer()
  let conn = room => `troparcel://ws/${run.serverUrl.replace('ws://', '')}/${room}`
  let alice = run.tropy('alice', { connection: conn(run.room), userId: 'alice', dataDir: run.dir, debug: true })
  await alice.start()
  // Tropy's log reaches its file late; the server's room list is live.
  let rooms = async () => {
    let res = await fetch(`http://127.0.0.1:${run.serverPort}/api/rooms`)
    let body = await res.json()
    return Object.fromEntries((body.rooms || body).map(r => [r.name, r.connections ?? r.conns ?? r.peers ?? 0]))
  }
  await until('alice to join the first room', async () => (await rooms())[run.room] > 0, { timeout: 60000 })

  // What Preferences > Plugins writes: the plugin's entry in config.json
  let file = path.join(alice.dataDir, 'plugins', 'config.json')
  let config = JSON.parse(fs.readFileSync(file, 'utf8'))
  config[0].options = { ...config[0].options, connection: conn('second-room'), userId: 'alice2' }
  fs.writeFileSync(file, JSON.stringify(config, null, 2))

  await until('alice to move to the second room, and leave the first', async () => {
    let r = await rooms()
    return r['second-room'] > 0 && !(r[run.room] > 0)
  }, { timeout: 60000 })

  await alice.stop()
  // Tropy's log can reach its file after the process has gone
  await until('Tropy\'s log to show the new settings', () => /ready — room \\?"second-room/.test(alice.log()), { timeout: 20000 })
  let log = alice.log()
  assert.match(log, /user: alice2/)
  assert.equal((log.match(/ready — room \\?"second-room/g) || []).length, 1)
  assert.deepEqual(alice.problems(), [])
})
