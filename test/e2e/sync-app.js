'use strict'

/**
 * A sync app, as the soak's folder mode needs one: Nextcloud or Dropbox
 * between computers, simulated in one process. Each member has a folder of
 * their own (their computer's copy of the shared folder). What a member's
 * Troparcel writes there reaches every other member's folder, late, in no
 * particular order, and the way real clients deliver it:
 *
 *   - most often whole: a temporary file, then a rename (Nextcloud, Syncthing);
 *   - sometimes in place, in pieces a reader can catch half-written;
 *   - now and then as a stale "conflicted copy" next to the real file;
 *   - with the source's modification time kept, to the second, as
 *     Nextcloud keeps it.
 *
 *   let app = new SyncApp(new Map([['alice', dirA], ['bob', dirB]]))
 *   app.start()
 *   app.pause('bob')   // bob's laptop is offline: nothing in or out
 *   app.resume('bob')
 *   app.stop()
 *
 * Only files a member wrote themselves travel: what the app delivered into
 * a folder is never picked up there again, as a real client knows which
 * files it downloaded.
 */

const fs = require('node:fs')
const path = require('node:path')

const rand = n => Math.floor(Math.random() * n)
const sleep = ms => new Promise(r => setTimeout(r, ms))

class SyncApp {
  constructor(folders, { minDelay = 500, maxDelay = 10000, chunked = 0.2, conflicted = 0.01 } = {}) {
    this.folders = folders            // member → folder
    this.minDelay = minDelay
    this.maxDelay = maxDelay
    this.chunked = chunked
    this.conflicted = conflicted
    this.paused = new Set()
    this.delivered = new Map()        // absolute path → true, for files this app wrote
    this.seen = new Map()             // absolute source path → "mtime:size"
    this.pending = new Map()          // `${src}→${member}` → timer
    this.stale = new Map()            // absolute source path → an earlier version
    this.latest = new Map()           // absolute source path → the version last seen
    this.counts = { deliveries: 0, chunked: 0, conflicted: 0 }
    this._timer = null
    this._writes = new Set()
  }

  start() {
    this._timer = setInterval(() => this._scan(), 250)
  }

  pause(member) { this.paused.add(member) }
  resume(member) { this.paused.delete(member) }
  pauseAll() { for (let m of this.folders.keys()) this.paused.add(m) }
  resumeAll() { this.paused.clear() }

  async stop() {
    clearInterval(this._timer)
    for (let t of this.pending.values()) clearTimeout(t)
    this.pending.clear()
    await Promise.all(this._writes)
  }

  /** Every file a member wrote, relative to their folder. */
  _own(member) {
    let root = this.folders.get(member)
    let out = []
    let walk = (dir) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (let e of entries) {
        let abs = path.join(dir, e.name)
        if (e.isDirectory()) walk(abs)
        else if (!this.delivered.has(abs) && !/\.(tmp|part)$/.test(e.name) && !e.name.includes('.sync-')) {
          out.push(path.relative(root, abs))
        }
      }
    }
    walk(root)
    return out
  }

  _scan() {
    for (let [member, root] of this.folders) {
      if (this.paused.has(member)) continue
      for (let rel of this._own(member)) {
        let src = path.join(root, rel)
        let stat
        try { stat = fs.statSync(src) } catch { continue }
        let mark = `${stat.mtimeMs}:${stat.size}`
        if (this.seen.get(src) === mark) continue
        // Keep the version before this one: a conflicted copy is stale.
        let now
        try { now = fs.readFileSync(src) } catch { continue }
        if (this.latest.has(src)) this.stale.set(src, this.latest.get(src))
        this.latest.set(src, now)
        this.seen.set(src, mark)
        for (let other of this.folders.keys()) {
          if (other !== member) this._schedule(src, rel, other)
        }
      }
    }
  }

  /** Deliver src to `member` later; a newer change before then rides along. */
  _schedule(src, rel, member) {
    let key = `${src}→${member}`
    if (this.pending.has(key)) return
    let delay = this.minDelay + rand(this.maxDelay - this.minDelay)
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key)
      if (this.paused.has(member)) {
        // Offline: try again once it is back, as a client retries.
        let retry = setInterval(() => {
          if (this.paused.has(member) || this.pending.has(key)) return
          clearInterval(retry)
          this._schedule(src, rel, member)
        }, 1000)
        return
      }
      let p = this._deliver(src, rel, member).catch(() => { /* source vanished mid-copy */ })
      this._writes.add(p)
      p.finally(() => this._writes.delete(p))
    }, delay))
  }

  async _deliver(src, rel, member) {
    let bytes = fs.readFileSync(src)
    let mtime = Math.floor(fs.statSync(src).mtimeMs / 1000)
    let dest = path.join(this.folders.get(member), rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    this.counts.deliveries++

    let stale = this.stale.get(src)
    if (stale && Math.random() < this.conflicted) {
      let ext = path.extname(dest)
      let copy = `${dest.slice(0, -ext.length)} (conflicted copy ${Date.now()})${ext}`
      this.delivered.set(copy, true)
      fs.writeFileSync(copy, stale)
      this.counts.conflicted++
    }

    this.delivered.set(dest, true)
    if (Math.random() < this.chunked) {
      this.counts.chunked++
      let fd = fs.openSync(dest, 'w')
      try {
        let pieces = 2 + rand(3)
        let size = Math.ceil(bytes.length / pieces)
        for (let at = 0; at < bytes.length; at += size) {
          fs.writeSync(fd, bytes, at, Math.min(size, bytes.length - at), at)
          await sleep(50 + rand(250))
        }
      } finally {
        fs.closeSync(fd)
      }
    } else {
      let tmp = path.join(path.dirname(dest), `.sync-${process.pid}-${rand(1e9)}.tmp`)
      fs.writeFileSync(tmp, bytes)
      fs.renameSync(tmp, dest)
    }
    fs.utimesSync(dest, mtime, mtime)
  }
}

module.exports = { SyncApp }
