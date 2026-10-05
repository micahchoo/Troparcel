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

// A collaborator's note, as applied here, ends with a footer naming the
// room entry it came from. It is how a note is found again for an update,
// and how push knows not to send a collaborator's note back. `author` must
// already be HTML-escaped.
const FOOTER_KEY = /\[troparcel:([\w:-]+)\s/

function noteFooter(key, verb, author) {
  return `<p><sub>[troparcel:${key} ${verb} ${author} — safe to delete, do not edit]</sub></p>`
}

/** The room key in a note's footer, or null. */
function footerKey(text) {
  let m = typeof text === 'string' && text.match(FOOTER_KEY)
  return m ? m[1] : null
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
  footerKey
}
