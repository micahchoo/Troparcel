'use strict'

/**
 * What Troparcel writes into the owner's project for the owner alone.
 *
 * Tropy has no panel a plugin can draw in, so Troparcel shows who wrote
 * what, and what arrived, with Tropy's own things: tags, metadata, a list.
 * These are made on apply and must never be pushed, or each peer would
 * send the others their own attribution back. push.js asks these
 * predicates before it writes anything to the room.
 */

// "@alice" on an item means alice contributed to it.
const ATTRIBUTION_PREFIX = '@'

const NS = 'https://troparcel.org/ns/'
const CONTRIB_URI = `${NS}contributors`
const SYNC_URI = `${NS}lastSync`

// Items that received a collaborator's change are added to this list.
const RECEIVED_LIST = 'Troparcel: received'

// The templates Tropy ships (db/migrate/ontology/*.default-templates.sql).
// Every Tropy already has them, so they are never shared. Templates a user
// makes are `https://tropy.org/v1/templates/id#<random>`, and are shared.
const TROPY_PRESET_TEMPLATES = new Set(
  ['correspondence', 'dc', 'generic', 'photo', 'selection']
    .map(name => `https://tropy.org/v1/templates/${name}`))

function isTropyPresetTemplate(uri) {
  return !uri || TROPY_PRESET_TEMPLATES.has(uri)
}

// A collaborator's note, as applied here, ends with one small line naming
// its author: "— alice", or "— withdrawn by alice" once retracted. The line
// is a link whose address holds the room entry's key (troparcel:n_…): how
// Troparcel finds the note again for an update, and how push knows not to
// send a collaborator's note back. `author` must already be HTML-escaped.
//
// Troparcel 6.0 wrote the key as text, "[troparcel:n_… from alice — safe
// to delete, do not edit]"; notes from then are still recognised.
const KEY_PATTERNS = [
  /\[troparcel:([\w:-]+)\s/,               // 6.0, in the text
  /href=\\?["']troparcel:([\w:-]+)/,       // in HTML
  /"href":"troparcel:([\w:-]+)"/            // in the editor's state
]

function noteFooter(key, kind, author) {
  let words = kind === 'withdrawn' ? `— withdrawn by ${author}` : `— ${author}`
  return `<p><sub><a href="troparcel:${key}">${words}</a></sub></p>`
}

/** The room key in a footer, in text, HTML or JSON; or null. */
function footerKey(text) {
  if (typeof text !== 'string') return null
  for (let p of KEY_PATTERNS) {
    let m = text.match(p)
    if (m) return m[1]
  }
  return null
}

/** The room key of a note as Tropy holds it ({ text, html?, state? }). */
function footerKeyOfNote(note) {
  if (!note) return null
  return footerKey(note.text) || footerKey(note.html) || (note.state ? footerKey(JSON.stringify(note.state)) : null)
}

function isLocalOnlyTag(name) {
  return typeof name === 'string' && name.startsWith(ATTRIBUTION_PREFIX)
}

function isLocalOnlyProperty(uri) {
  return typeof uri === 'string' && uri.startsWith(NS)
}

function isLocalOnlyList(name) {
  return name === RECEIVED_LIST
}

module.exports = {
  ATTRIBUTION_PREFIX,
  CONTRIB_URI,
  SYNC_URI,
  RECEIVED_LIST,
  isLocalOnlyTag,
  isLocalOnlyProperty,
  isLocalOnlyList,
  isTropyPresetTemplate,
  noteFooter,
  footerKey,
  footerKeyOfNote
}
