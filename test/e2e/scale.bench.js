'use strict'

/**
 * How long a first sync takes in real Tropy. Not a test: run it and read it.
 *
 *   node test/e2e/scale.bench.js [items=2000]
 *
 * bob runs a real Tropy and imports N photos. carol, a peer without a Tropy,
 * writes one note per item into the room in one transaction. The bench
 * counts bob's saved notes (project.tpy) every 2 s until all N are there.
 *
 * Read the rate column: if it falls as the count rises, each note costs
 * more than the last, and a first sync grows with N².
 */

const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { Run, SyntheticPeer, build, until, sleep } = require('./harness')

const N = Number(process.argv[2]) || 2000
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
    let problems = bob.problems()
    console.log(problems.length ? `Tropy logged:\n  ${problems.join('\n  ')}` : 'Tropy logged no warnings or errors')
    console.log(`logs and project: ${path.relative(process.cwd(), run.dir)}`)
  } finally {
    await run.stop()
  }
}

main().then(() => process.exit(0), err => { console.error(err); process.exit(1) })
