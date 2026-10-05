'use strict'

/**
 * End-to-end harness: real Tropy instances (Flatpak, under Xvfb), each with
 * its own data folder and project, talking to a real Troparcel server.
 *
 * Nothing here touches the owner's own Tropy profile: every instance gets
 * `--data` and `--logs` inside one run folder under `.e2e/`. The folder is
 * inside the repo because the Flatpak sandbox cannot see /tmp.
 *
 * Observation goes through Tropy's HTTP API, the only window into a running
 * Tropy from outside. Legacy `/project/<collection>` URLs work on 1.17 and
 * are redirected (308, method kept) on 1.18.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')
const { createServer } = require('node:net')
const { DatabaseSync } = require('node:sqlite')

const ROOT = path.resolve(__dirname, '..', '..')
const SCHEMA = fs.readFileSync(path.join(__dirname, 'project.sql'), 'utf8')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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

async function until(what, fn, { timeout = 30000, every = 250 } = {}) {
  let deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err
    }
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what} (last: ${
    last instanceof Error ? last.message : JSON.stringify(last)})`)
}

/** Create an empty managed project exactly as Tropy 1.17 does. */
function createProject(dir, name) {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  let db = new DatabaseSync(path.join(dir, 'project.tpy'))
  db.enableDefensive(false) // the schema dump writes sqlite_master
  db.exec(SCHEMA)
  db.exec('PRAGMA journal_mode=WAL')
  db.prepare('INSERT INTO project (project_id, name, base, store) VALUES (?, ?, ?, ?)')
    .run(crypto.randomUUID(), name, 'project', 'assets')
  db.close()
  return dir
}

/** Kill every process whose command line contains `marker`. */
function killMatching(marker, signal = 'SIGTERM') {
  let killed = 0
  for (let pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
    let cmd
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { continue }
    if (cmd.includes(marker)) {
      try { process.kill(Number(pid), signal); killed++ } catch { /* gone */ }
    }
  }
  return killed
}

class Api {
  constructor(port) {
    this.base = `http://localhost:${port}`
  }

  async get(url) {
    let res = await fetch(this.base + url)
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
    return res.json()
  }

  async post(url, body, form = false) {
    let res = await fetch(this.base + url, {
      method: 'POST',
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`POST ${url} → ${res.status} ${await res.text()}`)
    let text = await res.text()
    return text ? JSON.parse(text) : null
  }

  status() { return this.get('/') }
  items() { return this.get('/project/items') }
  item(id) { return this.get(`/project/items/${id}`) }
  photos(item) { return this.get(`/project/items/${item}/photos`) }
  photo(id) { return this.get(`/project/photos/${id}`) }
  tags(item) { return this.get(`/project/items/${item}/tags`) }
  lists() { return this.get('/project/lists') }
  allTags() { return this.get('/project/tags') }
  data(id) { return this.get(`/project/data/${id}`) }
  note(id) { return this.get(`/project/notes/${id}?format=text`) }
  transcriptions(item) { return this.get(`/project/items/${item}/transcriptions`) }

  importFiles(files) {
    let body = new URLSearchParams()
    for (let f of files) body.append('file', f)
    return fetch(this.base + '/project/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    }).then(r => r.json())
  }

  createTag(name, items) { return this.post('/project/tags', { name, item: items }) }
  saveData(id, data) { return this.post(`/project/data/${id}`, data) }
  createNote(photo, html) { return this.post('/project/notes', { photo, html }) }
  createTranscription(photo, text) { return this.post('/project/transcriptions', { photo, text }) }

  /** Notes on an item's photos, as plain text. */
  async notesOf(item) {
    let texts = []
    for (let pid of (await this.item(item)).photos) {
      for (let nid of ((await this.photo(pid)).notes || [])) {
        let res = await fetch(`${this.base}/project/notes/${nid}?format=text`)
        if (res.ok) texts.push(await res.text())
      }
    }
    return texts
  }
}

class TropyInstance {
  constructor(run, name, options, extraEntries = []) {
    this.extraEntries = extraEntries
    this.run = run
    this.name = name
    this.dir = path.join(run.dir, name)
    this.dataDir = path.join(this.dir, 'data')
    this.logDir = path.join(this.dir, 'logs')
    this.project = path.join(this.dir, `${name}.tropy`)
    // What happened inside the project window, one JSON object per line
    // (test/e2e/observer); read it with `node test/e2e/timeline.js <file>`.
    this.timelineFile = path.join(this.dir, 'timeline.jsonl')
    this.options = options
    this.proc = null
  }

  /**
   * Plugin entries, in order: Troparcel (#0), the test driver (#1), the
   * test observer (#2, writes `timelineFile`), then any `extraEntries` given
   * to run.tropy() — e.g. a second Troparcel entry that publishes IIIF (#3).
   * File > Export names an entry by that number.
   */
  installPlugin() {
    let dest = path.join(this.dataDir, 'plugins', 'troparcel')
    fs.mkdirSync(dest, { recursive: true })
    for (let f of ['index.js', 'package.json', 'icon.svg']) {
      // TROPARCEL_BUNDLE: install that bundle instead of ./index.js
      let src = f === 'index.js' && process.env.TROPARCEL_BUNDLE ? process.env.TROPARCEL_BUNDLE : path.join(ROOT, f)
      fs.copyFileSync(src, path.join(dest, f))
    }
    for (let [from, name] of [['driver', 'troparcel-test-driver'], ['observer', 'troparcel-test-observer']]) {
      let dir = path.join(this.dataDir, 'plugins', name)
      fs.mkdirSync(dir, { recursive: true })
      for (let f of ['index.js', 'package.json']) {
        fs.copyFileSync(path.join(__dirname, from, f), path.join(dir, f))
      }
    }
    fs.writeFileSync(path.join(this.dataDir, 'plugins', 'config.json'), JSON.stringify([
      { plugin: 'troparcel', name: 'Troparcel', options: this.options },
      { plugin: 'troparcel-test-driver', name: 'Test driver', options: { port: this.driverPort } },
      { plugin: 'troparcel-test-observer', name: 'Test observer', options: { file: this.timelineFile } },
      ...this.extraEntries
    ], null, 2))
  }

  async start() {
    fs.mkdirSync(this.logDir, { recursive: true })
    if (!fs.existsSync(this.project)) createProject(this.project, `Project ${this.name}`)
    this.driverPort = await freePort()
    this.driver = new Driver(this.driverPort)
    this.installPlugin()
    this.port = await freePort()
    this.api = new Api(this.port)

    let out = fs.openSync(path.join(this.dir, 'stdout.log'), 'a')
    // Without Wayland, Tropy can only draw on the Xvfb display: nothing
    // (no window, no error dialog) reaches the owner's desktop. The Flatpak
    // launcher asks Electron for Wayland when XDG_SESSION_TYPE says so.
    let env = { ...process.env, XDG_SESSION_TYPE: 'x11' }
    delete env.WAYLAND_DISPLAY
    let tropy = [
      'dbus-run-session', '--',
      'flatpak', 'run', '--nosocket=wayland', '--socket=x11', '--env=TROPARCEL_NO_BROWSER=1',
      'org.tropy.Tropy',
      `--data=${this.dataDir}`, `--logs=${this.logDir}`,
      `--port=${this.port}`, this.project
    ]
    // `display` set (e.g. ':91'): run on that X display, to record it.
    // Otherwise a private Xvfb, which nobody sees.
    if (this.display) env.DISPLAY = this.display
    this.proc = this.display
      ? spawn(tropy[0], tropy.slice(1), { detached: true, env, stdio: ['ignore', out, out] })
      : spawn('xvfb-run', ['-a', ...tropy], { detached: true, env, stdio: ['ignore', out, out] })
    let pid = this.proc.pid
    let dataDir = this.dataDir
    process.on('exit', () => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
      killMatching(`--data=${dataDir}`, 'SIGKILL')
    })

    await until(`${this.name} to open its project`, async () => {
      let s = await this.api.status()
      return s.project ? s : null
    }, { timeout: 60000, every: 500 })

    // A fresh data folder seeds its ontology after the project opens; an
    // import before the default template exists fails inside Tropy.
    await until(`${this.name} to load its templates`, () => {
      try {
        return this.savedTemplates().some(tp => tp.id === 'https://tropy.org/v1/templates/generic')
      } catch { return false }
    }, { timeout: 60000, every: 500 })
    await sleep(2000)
    return this
  }

  /**
   * Import photos one by one, retrying each until its item exists. A fresh
   * data folder loads the ontology after the project opens, and an import
   * that arrives first fails inside Tropy ("reading 'fields'") and is lost.
   */
  async importPhotos(files) {
    for (let file of files) {
      let before = (await this.api.items()).length
      await until(`${this.name} to import ${path.basename(file)}`, async () => {
        if ((await this.api.items()).length > before) return true
        await this.api.importFiles([file])
        await sleep(1500)
        return (await this.api.items()).length > before
      }, { timeout: 60000, every: 500 })
    }
  }

  async stop() {
    if (!this.proc) return
    try { process.kill(-this.proc.pid, 'SIGTERM') } catch { /* gone */ }
    killMatching(`--data=${this.dataDir}`, 'SIGTERM')
    await sleep(2000)
    killMatching(`--data=${this.dataDir}`, 'SIGKILL')
    this.proc = null
  }

  /** Template ids saved in this instance's ontology database. */
  savedTemplates() {
    let db = new DatabaseSync(path.join(this.dataDir, 'ontology.db'), { readOnly: true })
    try {
      return db.prepare('SELECT template_id AS id, name FROM templates').all()
    } finally {
      db.close()
    }
  }

  /** Warnings and errors from Tropy's log (level 40+), Troparcel's or not. */
  problems() {
    let out = []
    for (let f of fs.readdirSync(this.logDir)) {
      for (let line of fs.readFileSync(path.join(this.logDir, f), 'utf8').split('\n')) {
        try {
          let j = JSON.parse(line)
          if (j.level >= 40 && !/^SLOW|gio set|custom-icon/.test(`${j.msg || ''}${j.stack || ''}`)) {
            out.push(`${j.level} ${j.msg || ''} ${String(j.stack || (j.err && j.err.stack) || '').split('\n')[0]}`)
          }
        } catch { /* not JSON */ }
      }
    }
    return out
  }

  /** Troparcel's lines from Tropy's log. */
  log() {
    let out = ''
    for (let f of fs.readdirSync(this.logDir)) {
      out += fs.readFileSync(path.join(this.logDir, f), 'utf8')
    }
    return out.split('\n').filter(l => /troparcel/i.test(l)).join('\n')
  }
}

/**
 * A peer with no Tropy: a Yjs document on the server, written through
 * crdt-schema exactly as a Troparcel instance would. It can write what
 * Tropy's HTTP API cannot create (selections, transcriptions on 1.17,
 * templates, lists), so every kind of entity is exercised end to end.
 */
/** The test driver plugin in one Tropy (test/e2e/driver): its state, its commands. */
class Driver {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}`
  }

  async state(p = '') {
    let res = await fetch(`${this.base}/state?path=${encodeURIComponent(p)}`)
    if (!res.ok) throw new Error(`driver: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async post(route, body) {
    let res = await fetch(this.base + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`driver ${route}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  dispatch(action) { return this.post('/dispatch', { action }) }

  /** File > Export with plugin entry #plugin (see installPlugin). */
  exportItems(items, plugin) { return this.post('/export', { items, plugin }) }
}

class SyntheticPeer {
  constructor(serverUrl, room, userId) {
    let Y = require('yjs')
    let { WebsocketProvider } = require('y-websocket')
    this.userId = userId
    this.schema = require('../../src/crdt-schema')
    this.doc = new Y.Doc()
    this.provider = new WebsocketProvider(serverUrl, room, this.doc, {
      WebSocketPolyfill: require('ws'), connect: true
    })
    this.seq = 0
  }

  connected() {
    return until('synthetic peer to connect', () => this.provider.wsconnected && this.provider.synced)
  }

  /** Identity of the item whose photos have these checksums. */
  static identityOf(checksums) {
    return require('../../src/identity').computeIdentity({ photo: checksums.map(checksum => ({ checksum })) })
  }

  write(fn) {
    this.doc.transact(() => fn(this.schema, this.userId, ++this.seq))
  }

  destroy() {
    this.provider.destroy()
    this.doc.destroy()
  }
}

class Run {
  constructor(label = 'run') {
    // E2E_DIR moves the runs, e.g. off a busy disk: each Tropy writes its
    // database there, and a timing measures that disk as much as Troparcel.
    this.dir = path.join(process.env.E2E_DIR || path.join(ROOT, '.e2e'), `${label}-${Date.now()}`)
    this.photosDir = path.join(this.dir, 'photos')
    this.instances = []
    this.server = null
    fs.mkdirSync(this.photosDir, { recursive: true })
  }

  /** Start the server; started again, it keeps its port, so connection strings still work. */
  async startServer() {
    this.serverPort = this.serverPort || await freePort()
    let out = fs.openSync(path.join(this.dir, 'server.log'), 'a')
    this.server = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(this.serverPort),
        HOST: '127.0.0.1',
        PERSISTENCE_DIR: path.join(this.dir, 'server-data')
      },
      stdio: ['ignore', out, out]
    })
    let server = this.server
    process.on('exit', () => { if (server.exitCode === null) server.kill('SIGKILL') })
    await until('server', async () =>
      (await fetch(`http://127.0.0.1:${this.serverPort}/health`)).ok)
    this.serverUrl = `ws://127.0.0.1:${this.serverPort}`
    return this
  }

  /** Stop the server, as a crash or a network outage would. Its data stays. */
  async stopServer() {
    let server = this.server
    if (!server) return
    this.server = null
    let exited = new Promise(r => server.once('exit', r))
    server.kill('SIGKILL')
    await exited
  }

  peer(userId) {
    let p = new SyntheticPeer(this.serverUrl, this.room, userId)
    this.peers = (this.peers || []).concat(p)
    return p
  }

  tropy(name, options, extraEntries) {
    let t = new TropyInstance(this, name, options, extraEntries)
    this.instances.push(t)
    return t
  }

  photo(seed) {
    return require('./png').writePng(path.join(this.photosDir, `photo-${seed}.png`), seed)
  }

  async stop() {
    for (let p of this.peers || []) p.destroy()
    await Promise.all(this.instances.map(t => t.stop()))
    if (this.server) {
      this.server.kill('SIGTERM')
      this.server = null
    }
  }
}

/** Bundle the plugin: into ./index.js, or into TROPARCEL_BUNDLE when set. */
function build() {
  let out = process.env.TROPARCEL_BUNDLE ? [`--outfile=${process.env.TROPARCEL_BUNDLE}`] : []
  execFileSync('node', ['esbuild.config.mjs', ...out], { cwd: ROOT, stdio: 'ignore' })
}

module.exports = { Run, SyntheticPeer, build, until, sleep }
