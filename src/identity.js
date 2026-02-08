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
 * Compute a stable identity key for a selection across instances.
 *
 * Selections don't have checksums — they're regions on a photo.
 * We key them by the photo's checksum + normalized coordinates,
 * so the same region on the same photo matches across machines.
 *
 * @param {string} photoChecksum - checksum of the parent photo
 * @param {Object} sel - selection with x, y, width/w, height/h
 * @returns {string} stable selection key
 */
function computeSelectionKey(photoChecksum, sel) {
  let x = Math.round(sel.x || 0)
  let y = Math.round(sel.y || 0)
  let w = Math.round(sel.width || sel.w || 0)
  let h = Math.round(sel.height || sel.h || 0)

  return crypto
    .createHash('sha256')
    .update(`sel:${photoChecksum}:${x}:${y}:${w}:${h}`)
    .digest('hex')
    .slice(0, 24)
}

/**
 * Compute a stable key for a note across instances.
 *
 * Notes are identified by their content hash + parent association
 * (photo or selection). This lets us match notes across machines
 * even though they have different local SQLite IDs.
 *
 * For existing notes with a known noteId, we use a deterministic
 * hash so updates are idempotent.
 *
 * @param {Object} note - note with text/html/photo/selection fields
 * @param {string} [photoChecksum] - checksum of parent photo (for cross-instance matching)
 * @returns {string} stable note key
 */
function computeNoteKey(note, photoChecksum) {
  // Use content + parent for a stable key
  let text = note.text || ''
  let html = note.html || ''
  let parent = photoChecksum || note.photo || note.selection || 'orphan'

  // Use first 200 chars of content to avoid huge hashes but still differentiate
  let content = (html || text).slice(0, 200)

  return crypto
    .createHash('sha256')
    .update(`note:${parent}:${content}`)
    .digest('hex')
    .slice(0, 24)
}

/**
 * Compute a stable key for a transcription across instances.
 *
 * @param {string} photoChecksum - checksum of the parent photo
 * @param {number} idx - transcription index on that photo
 * @param {string} [selKey] - selection key if transcription is on a selection
 * @returns {string} stable transcription key
 */
function computeTranscriptionKey(photoChecksum, idx, selKey) {
  let parent = selKey ? `${photoChecksum}:${selKey}` : photoChecksum
  return crypto
    .createHash('sha256')
    .update(`tx:${parent}:${idx}`)
    .digest('hex')
    .slice(0, 24)
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

/**
 * Build a photo checksum lookup from an enriched item.
 * Returns Map<localPhotoId, checksum>
 */
function buildPhotoChecksumMap(item) {
  let map = new Map()
  let photos = item.photo || item['https://tropy.org/v1/tropy#photo'] || []
  if (!Array.isArray(photos)) photos = [photos]

  for (let photo of photos) {
    let id = photo['@id'] || photo.id
    let checksum = photo.checksum || photo['https://tropy.org/v1/tropy#checksum']
    if (id && checksum) {
      if (typeof checksum === 'object') checksum = checksum['@value'] || String(checksum)
      map.set(id, String(checksum))
    }
  }
  return map
}

module.exports = {
  computeIdentity,
  extractChecksums,
  buildIdentityIndex,
  findLocalMatch,
  computeSelectionKey,
  computeNoteKey,
  computeTranscriptionKey,
  buildPhotoChecksumMap
}
