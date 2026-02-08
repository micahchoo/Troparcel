'use strict'

const crypto = require('crypto')

/**
 * Identity module — match items across Tropy instances.
 *
 * Items don't share internal SQLite IDs across machines.
 * Instead we derive a stable identity from photo checksums,
 * which are SHA-256 hashes of the original image files and
 * remain constant regardless of where the project lives.
 *
 * For items with multiple photos, we sort the checksums and
 * hash the concatenation.  For items with no photos (rare),
 * we fall back to hashing template + key metadata fields.
 */

/**
 * Compute a stable identity hash for a Tropy item.
 *
 * @param {Object} item  - JSON-LD item from the Tropy API
 * @returns {string|null} hex identity hash, or null if unidentifiable
 */
function computeIdentity(item) {
  let checksums = extractChecksums(item)

  if (checksums.length > 0) {
    return hashChecksums(checksums)
  }

  // Fallback: hash template + title + date
  return hashFallback(item)
}

/**
 * Extract photo checksums from a JSON-LD item.
 * Handles both expanded and compacted JSON-LD forms.
 */
function extractChecksums(item) {
  let checksums = []
  let photos = item.photo || item['https://tropy.org/v1/tropy#photo'] || []

  if (!Array.isArray(photos)) photos = [photos]

  for (let photo of photos) {
    let checksum =
      photo.checksum ||
      photo['https://tropy.org/v1/tropy#checksum']

    if (checksum) {
      checksums.push(typeof checksum === 'object' ? checksum['@value'] || String(checksum) : String(checksum))
    }

    // Also gather selection checksums if present
    let selections = photo.selection || photo['https://tropy.org/v1/tropy#selection'] || []
    if (!Array.isArray(selections)) selections = [selections]
    for (let sel of selections) {
      let sc = sel.checksum || sel['https://tropy.org/v1/tropy#checksum']
      if (sc) {
        checksums.push(typeof sc === 'object' ? sc['@value'] || String(sc) : String(sc))
      }
    }
  }

  return checksums
}

/**
 * Hash a sorted list of checksums into a single identity.
 */
function hashChecksums(checksums) {
  let sorted = checksums.slice().sort()
  return crypto
    .createHash('sha256')
    .update(sorted.join(':'))
    .digest('hex')
    .slice(0, 32)
}

/**
 * Fallback identity when no photo checksums are available.
 * Uses template URI + title + date metadata.
 */
function hashFallback(item) {
  let template = item.template || item['https://tropy.org/v1/tropy#template'] || ''
  if (typeof template === 'object') template = template['@id'] || ''

  let title =
    item['http://purl.org/dc/elements/1.1/title'] ||
    item['http://purl.org/dc/terms/title'] ||
    item['title'] ||
    ''
  if (typeof title === 'object') title = title['@value'] || ''

  let date =
    item['http://purl.org/dc/elements/1.1/date'] ||
    item['http://purl.org/dc/terms/date'] ||
    item['date'] ||
    ''
  if (typeof date === 'object') date = date['@value'] || ''

  let input = `${template}|${title}|${date}`
  if (input === '||') return null

  return crypto
    .createHash('sha256')
    .update(input)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Build a lookup table mapping identity hashes to local item IDs.
 *
 * @param {Array} items - Array of JSON-LD items from the Tropy API
 * @returns {Map<string, Object>} identity → { localId, item }
 */
function buildIdentityIndex(items) {
  let index = new Map()

  for (let item of items) {
    let id = computeIdentity(item)
    if (id) {
      index.set(id, {
        localId: item['@id'] || item.id,
        item
      })
    }
  }

  return index
}

/**
 * Match a remote item (from CRDT) to a local item by identity.
 *
 * @param {string} identity - The identity hash from the CRDT
 * @param {Map} localIndex - Output of buildIdentityIndex()
 * @returns {Object|null} { localId, item } or null
 */
function findLocalMatch(identity, localIndex) {
  return localIndex.get(identity) || null
}

module.exports = {
  computeIdentity,
  extractChecksums,
  buildIdentityIndex,
  findLocalMatch
}
