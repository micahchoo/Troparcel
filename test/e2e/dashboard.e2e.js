'use strict'

/**
 * The dashboard in real Tropy: a newcomer sets up through it, it reports
 * the connection, a conflict is settled from it, and only this computer,
 * with the secret address, can use it.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { Run, SyntheticPeer, build, until, sleep } = require('./harness')

/** A GET with a Host header of our choosing (fetch will not send one). */
function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    let u = new URL(url)
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Host: host } }, res => {
      res.resume()
      resolve(res.statusCode)
    }).on('error', reject)
  })
}

const TITLE = 'http://purl.org/dc/elements/1.1/title'

/** The dashboard address a Tropy saved in its data folder. */
async function dashboardOf(dir) {
  let file = path.join(dir, 'dashboard.json')
  let saved = await until('the dashboard to start', () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }, { timeout: 30000 })
  let base = `http://127.0.0.1:${saved.port}/${saved.secret}/`
  return {
    base,
    status: async () => (await fetch(base + 'api/status')).json(),
    act: async (name, input) => (await fetch(base + 'api/' + name, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
    })).json()
  }
}

test('the dashboard: setup, status, conflicts, and only for this computer', { timeout: 400000 }, async (t) => {
  build()
  let run = new Run('dashboard')
  run.room = `dash-${Date.now()}`
  t.after(() => run.stop())
  await run.startServer()
  let connection = `troparcel://ws/${run.serverUrl.replace('ws://', '')}/${run.room}`
  let rooms = async () => {
    let body = await (await fetch(`http://127.0.0.1:${run.serverPort}/api/rooms`)).json()
    return Object.fromEntries(body.rooms.map(r => [r.name, r.connections]))
  }

  await t.test('a newcomer sets Troparcel up from the dashboard, no restart', async () => {
    let dir = path.join(run.dir, 'dave-data')
    let dave = run.tropy('dave', { dataDir: dir }) // not set up: no connection, no name
    await dave.start()
    let dash = await dashboardOf(dir)
    let s = await dash.status()
    assert.equal(s.configured, false)

    let bad = await dash.act('setup', { connection: 'nonsense', userId: 'dave' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /That is not an invite/)

    let ok = await dash.act('setup', { connection, userId: 'dave' })
    assert.equal(ok.ok, true, JSON.stringify(ok))
    await until('dave to join the room', async () => (await rooms())[run.room] > 0, { timeout: 60000 })
    let after = await until('the dashboard to report it', async () => {
      try { let st = await (await dashboardOf(dir)).status(); return st.engine ? st : null } catch { return null }
    }, { timeout: 30000 })
    assert.equal(after.configured, true)
    assert.equal(after.engine.room, run.room)
    assert.equal(after.engine.user, 'dave')
    let config = JSON.parse(fs.readFileSync(path.join(dave.dataDir, 'plugins', 'config.json'), 'utf8'))
    assert.equal(config[0].options.connection, connection)
    await dave.stop()
  })

  let dir = path.join(run.dir, 'alice-data')
  // alice shares her changes only every 8 s, so carol's can cross hers: a real conflict
  let alice = run.tropy('alice', { connection, userId: 'alice', dataDir: dir, localDebounce: 8000, remoteDebounce: 200, safetyNetInterval: 600 })
  await alice.start()
  await alice.importPhotos([run.photo(1)])
  let [item] = await alice.api.items()
  let photo = (await alice.api.item(item.id)).photos[0]
  let checksum = (await alice.api.photo(photo)).checksum
  await alice.driver.exportItems([item.id], 0) // File > Export > Troparcel opens the dashboard
  let dash = await dashboardOf(dir)

  await t.test('it reports the connection and the room', async () => {
    let s = await until('connected', async () => { let st = await dash.status(); return st.engine && st.engine.state === 'connected' ? st : null }, { timeout: 30000 })
    assert.equal(s.engine.room, run.room)
    assert.match(s.invite.text, /^troparcel:\/\/ws\//)
  })

  await t.test('a conflict appears there, and "use theirs" settles it', async () => {
    await alice.api.saveData(item.id, { [TITLE]: 'Letter, page 1 (alice)' })
    await sleep(10000) // alice's value reaches the room and becomes her base
    await alice.api.saveData(item.id, { [TITLE]: 'Letter, first page (alice again)' })
    let carol = run.peer('carol')
    await carol.connected()
    carol.write((s, me, seq) => s.setMetadata(carol.doc, SyntheticPeer.identityOf([checksum]), TITLE, { text: 'Letter to Castlereagh (carol)' }, me, seq))
    let c = await until('the conflict to show', async () => (await dash.status()).engine.conflicts[0], { timeout: 30000 })
    assert.equal(c.field, TITLE)
    assert.match(c.remoteValue, /carol/)

    let res = await dash.act('resolve', { identity: c.identity, field: c.field, choice: 'theirs' })
    assert.equal(res.ok, true, JSON.stringify(res))
    await until('alice to have carol\'s title', async () =>
      ((await alice.api.data(item.id))[TITLE] || {}).text === 'Letter to Castlereagh (carol)', { timeout: 20000 })
    assert.deepEqual((await dash.status()).engine.conflicts, [])
  })

  await t.test('only this computer, with the secret address, gets in', async () => {
    assert.equal(await getWithHost(dash.base + 'api/status', 'evil.example:80'), 403)
    let noSecret = await fetch(dash.base.replace(/\/[^/]+\/$/, '/guess/') + 'api/status')
    assert.equal(noSecret.status, 404)
    let form = await fetch(dash.base + 'api/share', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=b' })
    assert.equal(form.status, 415)
  })

  await t.test('Tropy logged no warnings or errors', () => {
    assert.deepEqual(alice.problems().filter(p => !/conflict/i.test(p)), [])
  })
})
