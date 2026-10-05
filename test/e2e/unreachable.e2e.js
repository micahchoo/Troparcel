'use strict'

/**
 * No server where the connection points (the setup a fresh install with
 * empty settings had): Troparcel must keep trying quietly. 6.1-dev emitted
 * an EventEmitter 'error' nobody listened to, and Tropy showed an
 * "Unhandled Error" dialog on every attempt.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { Run, build, sleep } = require('./harness')

test('an unreachable server makes no crash dialog', { timeout: 180000 }, async (t) => {
  build()
  let run = new Run('unreachable')
  t.after(() => run.stop())
  let alice = run.tropy('alice', { connection: 'troparcel://ws/127.0.0.1:1/nowhere', userId: 'alice', dataDir: run.dir })
  await alice.start()
  await sleep(15000) // the first attempt and one retry
  await alice.stop()
  await sleep(3000)
  let crashes = alice.problems().filter(p => /ERR_UNHANDLED_ERROR|Unhandled/i.test(p))
  assert.deepEqual(crashes, [])
})
