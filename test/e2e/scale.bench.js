'use strict'

/**
 * How long a first sync takes in real Tropy. Not a test: run it and read it.
 *
 *   node test/e2e/scale.bench.js [items=2000] [--restart]
 *
 * bob runs a real Tropy and imports N photos. carol, a peer without a Tropy,
 * writes one note per item into the room in one transaction. The bench
 * counts bob's saved notes (project.tpy) every 2 s until all N are there.
 *
 * Run it off a busy disk with E2E_DIR (each Tropy writes its database there).
 *
 * Read the rate column: if it falls as the count rises, each note costs
 * more than the last, and a first sync grows with N².
 *
 * With --restart, bob's Tropy is then closed and opened again on the same
 * project and room: the ROADMAP Phase 3 exit test. Start is the time from
 * Tropy opening the project to Troparcel's first full cycle; memory is the
 * resident size of bob's Tropy processes once idle.
 */

const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { execFileSync } = require('node:child_process')
const { Run, SyntheticPeer, build, until, sleep } = require('./harness')

const N = Number(process.argv[2]) || 2000
const RESTART = process.argv.includes('--restart')
// Tropy parses the import form with qs, which turns more than 20 repeated
// keys into an object, and the import then fails. The route takes no JSON.
const BATCH = 20

function savedNotes(tropy) {
  let db = new DatabaseSync(tropy.project + '/project.tpy', { readOnly: true })
  try {
    return db.prepare('SELECT count(*) AS n FROM notes').get().n
  } finally {
    db.close()
  }
}

/**
 * Seconds, in bob's last session, from Tropy first opening the project to
 * Troparcel's first full cycle. Tropy opens project.tpy more than once a
 * session; the plugin's first line ("Troparcel — …") marks a new session.
 */
function startSeconds(tropy) {
  let lines = []
  for (let f of fs.readdirSync(tropy.logDir)) {
    for (let line of fs.readFileSync(path.join(tropy.logDir, f), 'utf8').split('\n')) {
      try { lines.push(JSON.parse(line)) } catch { /* not JSON */ }
    }
  }
  lines.sort((a, b) => a.time - b.time)
  let opened = null
  let ready = null
  for (let { msg = '', time } of lines) {
    if (msg.startsWith('Troparcel —')) { opened = null; ready = null }
    else if (opened == null && /^open db .*project\.tpy$/.test(msg)) opened = time
    else if (ready == null && opened != null && /initial sync complete/.test(msg)) ready = time
  }
  return opened && ready ? (ready - opened) / 1000 : null
}

/** Resident memory, in MB, of every process of this Tropy instance. */
function residentMB(tropy) {
  let out = execFileSync('ps', ['-eo', 'rss=,args='], { encoding: 'utf8' })
  let kb = 0
  for (let line of out.split('\n')) {
    if (line.includes(`--data=${tropy.dataDir}`) || line.includes(tropy.dataDir)) kb += Number(line.trim().split(/\s+/)[0]) || 0
  }
  return kb / 1024
}

async function main() {
  build()
  let run = new Run(`scale-${N}`)
  run.room = `scale-${Date.now()}`
  process.on('SIGINT', () => run.stop().then(() => process.exit(130)))
  try {
    await run.startServer()
    let bob = run.tropy('bob', {
      connection: `troparcel://ws/${run.serverUrl.replace('ws://', '')}/${run.room}`,
      userId: 'bob',
      dataDir: run.dir
    })
    await bob.start()

    let files = Array.from({ length: N }, (_, i) => run.photo(i + 1))
    let t0 = Date.now()
    for (let i = 0; i < N; i += BATCH) {
      await bob.api.importFiles(files.slice(i, i + BATCH))
      await until(`bob to import ${Math.min(i + BATCH, N)} photos`, async () =>
        (await bob.api.items()).length >= Math.min(i + BATCH, N), { timeout: 300000, every: 1000 })
    }
    console.log(`import of ${N} photos: ${((Date.now() - t0) / 1000).toFixed(0)} s`)
    // Let Troparcel finish pushing the new items before the notes arrive.
    await sleep(15000)

    let carol = run.peer('carol')
    await carol.connected()
    carol.write((s, me, seq) => {
      files.forEach((file, i) => {
        let checksum = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
        let item = SyntheticPeer.identityOf([checksum])
        s.setNote(carol.doc, item, `n_carol-${i}`,
          { text: `Note ${i}`, html: `<p>Note ${i}</p>`, photo: checksum }, me, seq)
      })
    })

    let start = Date.now()
    let last = { t: start, n: 0 }
    console.log('  time    notes   rate (notes/s over the last sample)')
    while (true) {
      await sleep(2000)
      let n = savedNotes(bob)
      let now = Date.now()
      if (n !== last.n || n === N) {
        let rate = (n - last.n) / ((now - last.t) / 1000)
        console.log(`${((now - start) / 1000).toFixed(0).padStart(5)} s  ${String(n).padStart(6)}   ${rate.toFixed(1)}`)
        last = { t: now, n }
      }
      if (n >= N) break
      if (now - last.t > 120000) throw new Error(`no progress for 2 minutes at ${n} notes`)
    }
    console.log(`\nfirst sync of ${N} notes: ${((Date.now() - start) / 1000).toFixed(0)} s`)
    if (RESTART) {
      await sleep(10000)
      console.log(`memory after the first sync: ${residentMB(bob).toFixed(0)} MB`)
      await bob.stop()
      await bob.start()
      await until('Troparcel to finish its first cycle', () => startSeconds(bob) != null,
        { timeout: 600000, every: 1000 })
      console.log(`start with ${N} items: ${startSeconds(bob).toFixed(1)} s (project opened → first full cycle)`)
      await sleep(15000)
      let session = bob.log().split('\n').map(l => { try { return JSON.parse(l) } catch { return {} } })
      let last = session.map(j => j.msg || '').filter(Boolean)
      let from = last.map(m => m.startsWith('Troparcel —')).lastIndexOf(true)
      let mine = last.slice(from)
      console.log(`  its first cycle saw: ${(mine.find(m => /initial sync complete/.test(m)) || '').replace(/^.*complete — /, '')}`)
      console.log(`  items pushed again after the restart: ${mine.filter(m => /pushed \d+ item/.test(m)).map(m => m.match(/pushed (\d+)/)[1]).join(', ') || 'none'}`)
      console.log(`memory when idle after a restart: ${residentMB(bob).toFixed(0)} MB`)
    }
    let problems = bob.problems()
    console.log(problems.length ? `Tropy logged:\n  ${problems.join('\n  ')}` : 'Tropy logged no warnings or errors')
    console.log(`logs and project: ${path.relative(process.cwd(), run.dir)}`)
  } finally {
    await run.stop()
  }
}

main().then(() => process.exit(0), err => { console.error(err); process.exit(1) })
