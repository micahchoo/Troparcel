'use strict'

/**
 * Real Tropy on displays you can record: the footage behind the explainer.
 *
 *   const { Studio } = require('./studio')
 *   let studio = await Studio.open(['alice', 'bob'], { photos, connection })
 *   await studio.shot('alice', 'file.png')
 *   studio.record('alice', 'alice.mp4'); …; await studio.stopRecording()
 *   await studio.click('bob', x, y); await studio.type('alice', 'text')
 *
 * Each Tropy runs on its own Xvfb display (1280×800), its window filling
 * it. Nothing is rebuilt: the bundle in index.js is used as it is.
 */

const { spawn, execFileSync } = require('node:child_process')
const { Run, until, sleep } = require('./harness')

const W = 1280
const H = 800

class Studio {
  static async open(names, { photos = [], connection, options = {}, first = 91, label = 'studio' } = {}) {
    let studio = new Studio()
    studio.run = new Run(label)
    studio.run.room = `${label}-${Date.now()}`
    studio.displays = new Map()
    studio.recorders = []
    studio.xvfb = []
    await studio.run.startServer()
    // An overlay room unless told otherwise: in a project room, importing a
    // photo the room already brought opens Tropy's duplicate dialog.
    studio.connection = connection || `troparcel://ws/${studio.run.serverUrl.replace('ws://', '')}/${studio.run.room}`
    studio.options = options
    // Flatpak Tropy has a private /tmp: give it copies inside the run folder.
    studio.photos = photos.map(p => {
      let dest = require('node:path').join(studio.run.photosDir, require('node:path').basename(p))
      require('node:fs').copyFileSync(p, dest)
      return dest
    })
    try {
      let n = first
      for (let name of names) await studio.add(name, n++, studio.photos)
    } catch (err) {
      await studio.close()
      throw err
    }
    return studio
  }

  /** Start `name`'s Tropy on display :n, importing `photos` (paths). */
  async add(name, n, photos = []) {
    let step = m => process.env.STUDIO_DEBUG && console.log(`[studio] ${name}: ${m}`)
    let display = `:${n}`
    let x = spawn('Xvfb', [display, '-screen', '0', `${W}x${H}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' })
    this.xvfb.push(x)
    await sleep(800)
    let tropy = this.run.tropy(name, {
      connection: this.connection, userId: name, dataDir: this.run.dir,
      localDebounce: 300, remoteDebounce: 200, safetyNetInterval: 5, ...this.options
    })
    tropy.display = display
    step('starting Tropy')
    await tropy.start()
    step(`importing ${photos.length} photo(s)`)
    if (photos.length) await tropy.importPhotos(photos)
    this.displays.set(name, display)
    step('fitting the window')
    await this.fit(name)
    step('ready')
    return tropy
  }

  tropy(name) {
    return this.run.instances.find(t => t.name === name)
  }

  xdo(name, args) {
    return execFileSync('xdotool', args, { env: { ...process.env, DISPLAY: this.displays.get(name) } }).toString()
  }

  /** Make the Tropy window fill its display. */
  async fit(name) {
    let id = await until(`${name}'s window`, () => {
      try { return this.xdo(name, ['search', '--onlyvisible', '--name', '^Tropy$']).trim().split('\n')[0] || null } catch { return null }
    }, { timeout: 30000, every: 500 })
    this.xdo(name, ['windowmove', id, '0', '0'])
    this.xdo(name, ['windowsize', id, String(W), String(H)])
    await sleep(500)
  }

  async click(name, x, y) {
    this.xdo(name, ['mousemove', String(x), String(y)])
    await sleep(250)
    this.xdo(name, ['click', '1'])
    await sleep(300)
  }

  async type(name, text, delay = 60) {
    this.xdo(name, ['type', '--delay', String(delay), text])
    await sleep(300)
  }

  async key(name, ...keys) {
    this.xdo(name, ['key', ...keys])
    await sleep(300)
  }

  shot(name, file) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', `${W}x${H}`,
      '-i', this.displays.get(name), '-frames:v', '1', file])
  }

  record(name, file, fps = 24) {
    let rec = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', String(fps),
      '-video_size', `${W}x${H}`, '-i', this.displays.get(name),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', file],
    { stdio: ['pipe', 'ignore', 'inherit'] })
    rec.startedAt = Date.now()
    this.recorders.push(rec)
    return rec
  }

  async stopRecording() {
    await Promise.all(this.recorders.map(rec => new Promise(resolve => {
      rec.once('exit', resolve)
      rec.stdin.write('q')
    })))
    this.recorders = []
  }

  async close() {
    await this.stopRecording()
    await this.run.stop()
    for (let x of this.xvfb) x.kill()
  }
}

module.exports = { Studio, W, H }
