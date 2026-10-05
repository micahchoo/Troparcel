'use strict'

/**
 * Tombstone purge for a schema-v5 room (see crdt-schema.js for the layout).
 *
 * It requires nothing and only calls methods on the doc it is given, so the
 * server can run it on its own Yjs documents without loading a second copy
 * of Yjs (two copies break Yjs's type checks).
 *
 * Removes tombstones older than maxAgeMs (all of them without a limit),
 * UUID registry entries nothing refers to, and aliases older than the limit.
 */

const SEP = '|'
const TOMBSTONE_SECTIONS = ['tags', 'notes', 'selections', 'selectionNotes', 'transcriptions', 'lists']

function purgeTombstones(doc, maxAgeMs) {
  let cutoff = maxAgeMs ? Date.now() - maxAgeMs : null
  let old = v => v && v.deleted && (!cutoff || !v.deletedAt || v.deletedAt < cutoff)
  let purged = 0
  let uuidsPurged = 0
  let aliasesPurged = 0

  let drop = (map, keys) => { for (let k of keys) map.delete(k); return keys.length }

  for (let section of TOMBSTONE_SECTIONS) {
    let map = doc.getMap(section)
    let doomed = []
    map.forEach((v, k) => { if (old(v)) doomed.push(k) })
    purged += drop(map, doomed)
  }

  let live = new Set()
  for (let section of ['notes', 'selections', 'transcriptions', 'lists']) {
    doc.getMap(section).forEach((_, k) => live.add(k))
  }
  doc.getMap('selectionNotes').forEach((_, k) => {
    let i = k.indexOf(SEP)
    let identity = k.slice(0, i)
    let [sel, note] = k.slice(i + 1).split(':')
    live.add(`${identity}${SEP}${sel}`)
    live.add(`${identity}${SEP}${note}`)
  })
  let uuids = doc.getMap('uuids')
  let orphans = []
  uuids.forEach((_, k) => { if (!live.has(k)) orphans.push(k) })
  uuidsPurged = drop(uuids, orphans)

  let aliases = doc.getMap('aliases')
  let expired = []
  aliases.forEach((v, k) => {
    let createdAt = (v && typeof v === 'object') ? v.createdAt : 0
    if (!cutoff || !createdAt || createdAt < cutoff) expired.push(k)
  })
  aliasesPurged = drop(aliases, expired)

  return { items: doc.getMap('items').size, purged, uuidsPurged, aliasesPurged }
}

module.exports = { purgeTombstones }
