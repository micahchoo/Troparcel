'use strict'

const Y = require('yjs')

/**
 * CRDT Schema v3 — defines how collaborative annotations are structured
 * inside a Yjs document.
 *
 * Breaking change from v2: all per-item collections are now Y.Maps
 * (instead of Y.Arrays) for proper update/delete support via tombstones.
 *
 * Document layout:
 *
 *   Y.Doc
 *   ├── Y.Map "annotations"                keyed by item identity hash
 *   │   └── Y.Map per item
 *   │       ├── Y.Map "metadata"           {[propUri]: {text, type, lang, author, ts}}
 *   │       ├── Y.Map "tags"               {[tagName]: {color, author, ts, deleted?}}
 *   │       ├── Y.Map "notes"              {[noteKey]: {html, text, lang, photo, sel, author, ts, deleted?}}
 *   │       ├── Y.Map "photos"             {[checksum]: Y.Map with "metadata" sub-map}
 *   │       ├── Y.Map "selections"         {[selKey]: {x, y, w, h, angle, photo, author, ts, deleted?}}
 *   │       ├── Y.Map "selectionMeta"      {[selKey:propUri]: {text, type, lang, author, ts}}
 *   │       ├── Y.Map "selectionNotes"     {[selKey:noteKey]: {html, text, lang, author, ts, deleted?}}
 *   │       ├── Y.Map "transcriptions"     {[txKey]: {text, data, photo, sel, author, ts, deleted?}}
 *   │       └── Y.Map "lists"              {[listName]: {member, author, ts, deleted?}}
 *   ├── Y.Map "users"
 *   └── Y.Map "room"
 *
 * Tombstones: deleted entries are marked { deleted: true, author, ts }
 * rather than removed from the map. A subsequent add clears the tombstone.
 */

const ITEM_SECTIONS = [
  'metadata', 'tags', 'notes', 'photos', 'selections',
  'selectionMeta', 'selectionNotes', 'transcriptions', 'lists'
]

/**
 * Get or create the annotations map for an item.
 * Lazily initializes the nested Y.Map structure.
 *
 * @param {Y.Doc} doc
 * @param {string} identity - item identity hash
 * @returns {Object} map of section name → Y.Map
 */
function getItemAnnotations(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)

  let isNew = !itemMap
  if (isNew) {
    itemMap = new Y.Map()
  }

  let result = {}
  for (let section of ITEM_SECTIONS) {
    let sectionMap = itemMap.get(section)
    if (!sectionMap) {
      sectionMap = new Y.Map()
      itemMap.set(section, sectionMap)
    }
    result[section] = sectionMap
  }

  if (isNew) {
    annotations.set(identity, itemMap)
  }

  return result
}

/**
 * Get or create a single section's Y.Map for an item (write path).
 * Only ensures the requested section exists — avoids checking all 9 sections.
 *
 * @param {Y.Doc} doc
 * @param {string} identity - item identity hash
 * @param {string} section - section name (e.g. 'metadata', 'tags')
 * @returns {Y.Map} the section's Y.Map
 */
function _getSection(doc, identity, section) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)

  if (!itemMap) {
    itemMap = new Y.Map()
    itemMap.set(section, new Y.Map())
    annotations.set(identity, itemMap)
    return itemMap.get(section)
  }

  let sectionMap = itemMap.get(section)
  if (!sectionMap) {
    sectionMap = new Y.Map()
    itemMap.set(section, sectionMap)
  }
  return sectionMap
}

// --- Metadata (item-level) ---

function setMetadata(doc, identity, propertyUri, value, author) {
  let metadata = _getSection(doc, identity, 'metadata')
  metadata.set(propertyUri, {
    text: value.text || '',
    type: value.type || 'http://www.w3.org/2001/XMLSchema#string',
    language: value.language || null,
    author,
    ts: Date.now()
  })
}

function getMetadata(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return {}

  let metadata = itemMap.get('metadata')
  if (!metadata) return {}

  let result = {}
  metadata.forEach((value, key) => {
    result[key] = value
  })
  return result
}

// --- Tags ---

function setTag(doc, identity, tag, author) {
  let tags = _getSection(doc, identity, 'tags')
  let existing = tags.get(tag.name)

  // If previously tombstoned, clear it (add-wins)
  // Or if new/updated, set it
  if (!existing || existing.deleted || tag.color !== existing.color) {
    tags.set(tag.name, {
      name: tag.name,
      color: tag.color || null,
      author,
      ts: Date.now()
    })
  }
}

function removeTag(doc, identity, tagName, author) {
  let tags = _getSection(doc, identity, 'tags')
  let existing = tags.get(tagName)
  if (existing && !existing.deleted) {
    tags.set(tagName, {
      ...existing,
      deleted: true,
      author,
      ts: Date.now()
    })
  }
}

function getTags(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return []

  let tags = itemMap.get('tags')
  if (!tags) return []

  let result = []
  tags.forEach((value, key) => {
    result.push(value)
  })
  return result
}

function getActiveTags(doc, identity) {
  return getTags(doc, identity).filter(t => !t.deleted)
}

function getDeletedTags(doc, identity) {
  return getTags(doc, identity).filter(t => t.deleted)
}

// --- Notes ---

function setNote(doc, identity, noteKey, note, author) {
  let notes = _getSection(doc, identity, 'notes')
  notes.set(noteKey, {
    noteKey,
    text: note.text || '',
    html: note.html || '',
    language: note.language || null,
    photo: note.photo || null,
    selection: note.selection || null,
    author,
    ts: Date.now()
  })
}

function removeNote(doc, identity, noteKey, author) {
  let notes = _getSection(doc, identity, 'notes')
  let existing = notes.get(noteKey)
  if (existing && !existing.deleted) {
    notes.set(noteKey, {
      ...existing,
      deleted: true,
      author,
      ts: Date.now()
    })
  }
}

function getNotes(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return {}

  let notes = itemMap.get('notes')
  if (!notes) return {}

  let result = {}
  notes.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function getActiveNotes(doc, identity) {
  let all = getNotes(doc, identity)
  let result = {}
  for (let [key, val] of Object.entries(all)) {
    if (!val.deleted) result[key] = val
  }
  return result
}

/**
 * Permanently delete a note entry from the CRDT (Y.Map.delete).
 * Unlike removeNote (which creates a tombstone), this removes the entry entirely.
 * Used to clean up stale content-based keys when note content changes.
 */
function deleteNoteEntry(doc, identity, noteKey) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return
  let notes = itemMap.get('notes')
  if (!notes) return
  notes.delete(noteKey)
}

// --- Photos ---

function setPhotoMetadata(doc, identity, checksum, propertyUri, value, author) {
  let photos = _getSection(doc, identity, 'photos')
  let photoMap = photos.get(checksum)

  if (!photoMap) {
    photoMap = new Y.Map()
    photoMap.set('metadata', new Y.Map())
    photos.set(checksum, photoMap)
  }

  let metadata = photoMap.get('metadata')
  if (!metadata) {
    metadata = new Y.Map()
    photoMap.set('metadata', metadata)
  }

  metadata.set(propertyUri, {
    text: value.text || '',
    type: value.type || 'http://www.w3.org/2001/XMLSchema#string',
    language: value.language || null,
    author,
    ts: Date.now()
  })
}

function getPhotoMetadata(doc, identity, checksum) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return {}

  let photos = itemMap.get('photos')
  if (!photos) return {}

  let photoMap = photos.get(checksum)
  if (!photoMap) return {}

  let metadata = photoMap.get('metadata')
  if (!metadata) return {}

  let result = {}
  metadata.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function getAllPhotoChecksums(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return []

  let photos = itemMap.get('photos')
  if (!photos) return []

  let result = []
  photos.forEach((_, checksum) => {
    result.push(checksum)
  })
  return result
}

// --- Selections ---

function setSelection(doc, identity, selKey, selection, author) {
  let selections = _getSection(doc, identity, 'selections')

  // Use ?? instead of || so that 0 is preserved (valid for x, y, angle)
  let x = selection.x ?? 0
  let y = selection.y ?? 0
  let w = selection.width ?? selection.w
  let h = selection.height ?? selection.h
  if (!Number.isFinite(x) || !Number.isFinite(y)) return  // invalid coordinates
  if (w == null || h == null || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return

  selections.set(selKey, {
    selKey,
    x,
    y,
    w,
    h,
    angle: selection.angle ?? 0,
    photo: selection.photo || null,
    author,
    ts: Date.now()
  })
}

function removeSelection(doc, identity, selKey, author) {
  let selections = _getSection(doc, identity, 'selections')
  let existing = selections.get(selKey)
  if (existing && !existing.deleted) {
    selections.set(selKey, {
      ...existing,
      deleted: true,
      author,
      ts: Date.now()
    })
  }
}

function getSelections(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return {}

  let selections = itemMap.get('selections')
  if (!selections) return {}

  let result = {}
  selections.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function getActiveSelections(doc, identity) {
  let all = getSelections(doc, identity)
  let result = {}
  for (let [key, val] of Object.entries(all)) {
    if (!val.deleted) result[key] = val
  }
  return result
}

// --- Selection Metadata ---

function setSelectionMeta(doc, identity, selKey, propertyUri, value, author) {
  let selectionMeta = _getSection(doc, identity, 'selectionMeta')
  let key = `${selKey}:${propertyUri}`
  selectionMeta.set(key, {
    text: value.text || '',
    type: value.type || 'http://www.w3.org/2001/XMLSchema#string',
    language: value.language || null,
    author,
    ts: Date.now()
  })
}

function getSelectionMeta(doc, identity, selKey) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return {}

  let selectionMeta = itemMap.get('selectionMeta')
  if (!selectionMeta) return {}

  let prefix = `${selKey}:`
  let result = {}
  selectionMeta.forEach((value, key) => {
    if (key.startsWith(prefix)) {
      let propUri = key.slice(prefix.length)
      result[propUri] = value
    }
  })
  return result
}

// --- Selection Notes ---

function setSelectionNote(doc, identity, selKey, noteKey, note, author) {
  let selectionNotes = _getSection(doc, identity, 'selectionNotes')
  let key = `${selKey}:${noteKey}`
  selectionNotes.set(key, {
    noteKey,
    selKey,
    text: note.text || '',
    html: note.html || '',
    language: note.language || null,
    author,
    ts: Date.now()
  })
}

function removeSelectionNote(doc, identity, selKey, noteKey, author) {
  let selectionNotes = _getSection(doc, identity, 'selectionNotes')
  let key = `${selKey}:${noteKey}`
  let existing = selectionNotes.get(key)
  if (existing && !existing.deleted) {
    selectionNotes.set(key, {
      ...existing,
      deleted: true,
      author,
      ts: Date.now()
    })
  }
}

function getSelectionNotes(doc, identity, selKey) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return {}

  let selectionNotes = itemMap.get('selectionNotes')
  if (!selectionNotes) return {}

  let prefix = `${selKey}:`
  let result = {}
  selectionNotes.forEach((value, key) => {
    if (key.startsWith(prefix)) {
      if (!value.deleted) result[key] = value
    }
  })
  return result
}

/**
 * Get ALL selection notes for an item (all selection keys, including deleted).
 * Used for stale entry cleanup.
 */
function getAllSelectionNotes(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return {}

  let selectionNotes = itemMap.get('selectionNotes')
  if (!selectionNotes) return {}

  let result = {}
  selectionNotes.forEach((value, key) => {
    result[key] = value
  })
  return result
}

/**
 * Permanently delete a selection note entry from the CRDT (Y.Map.delete).
 * Used to clean up stale content-based keys.
 */
function deleteSelectionNoteEntry(doc, identity, compositeKey) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return
  let selectionNotes = itemMap.get('selectionNotes')
  if (!selectionNotes) return
  selectionNotes.delete(compositeKey)
}

// --- Transcriptions ---

function setTranscription(doc, identity, txKey, transcription, author) {
  let transcriptions = _getSection(doc, identity, 'transcriptions')
  transcriptions.set(txKey, {
    txKey,
    text: transcription.text || '',
    data: transcription.data || null,
    photo: transcription.photo || null,
    selection: transcription.selection || null,
    author,
    ts: Date.now()
  })
}

function removeTranscription(doc, identity, txKey, author) {
  let transcriptions = _getSection(doc, identity, 'transcriptions')
  let existing = transcriptions.get(txKey)
  if (existing && !existing.deleted) {
    transcriptions.set(txKey, {
      ...existing,
      deleted: true,
      author,
      ts: Date.now()
    })
  }
}

function getTranscriptions(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return {}

  let transcriptions = itemMap.get('transcriptions')
  if (!transcriptions) return {}

  let result = {}
  transcriptions.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function getActiveTranscriptions(doc, identity) {
  let all = getTranscriptions(doc, identity)
  let result = {}
  for (let [key, val] of Object.entries(all)) {
    if (!val.deleted) result[key] = val
  }
  return result
}

// --- Lists ---

function setListMembership(doc, identity, listName, author) {
  let lists = _getSection(doc, identity, 'lists')
  lists.set(listName, {
    name: listName,
    member: true,
    author,
    ts: Date.now()
  })
}

function removeListMembership(doc, identity, listName, author) {
  let lists = _getSection(doc, identity, 'lists')
  let existing = lists.get(listName)
  if (existing && !existing.deleted) {
    lists.set(listName, {
      ...existing,
      member: false,
      deleted: true,
      author,
      ts: Date.now()
    })
  }
}

function getLists(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return {}

  let lists = itemMap.get('lists')
  if (!lists) return {}

  let result = {}
  lists.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function getActiveLists(doc, identity) {
  let all = getLists(doc, identity)
  let result = {}
  for (let [key, val] of Object.entries(all)) {
    if (!val.deleted && val.member) result[key] = val
  }
  return result
}

// --- Tombstone purge ---

/**
 * Remove all tombstoned entries from the CRDT document.
 * Unlike tombstoning (which marks entries as deleted), this permanently
 * removes them from the Y.Map. The deletion propagates to all peers.
 *
 * Sections that support tombstones: tags, notes, selections,
 * selectionNotes, transcriptions, lists.
 *
 * @param {Y.Doc} doc
 * @returns {{ items: number, purged: number }} count of items scanned and entries purged
 */
function purgeTombstones(doc) {
  let annotations = doc.getMap('annotations')
  let tombstoneSections = ['tags', 'notes', 'selections', 'selectionNotes', 'transcriptions', 'lists']
  let purged = 0
  let items = 0

  annotations.forEach((itemMap, identity) => {
    items++
    for (let section of tombstoneSections) {
      let map = itemMap.get(section)
      if (!map) continue

      let toDelete = []
      map.forEach((value, key) => {
        if (value && value.deleted) {
          toDelete.push(key)
        }
      })

      for (let key of toDelete) {
        map.delete(key)
        purged++
      }
    }
  })

  return { items, purged }
}

// --- Item checksums (for fuzzy identity matching across merges) ---

/**
 * Store an item's photo checksums in the CRDT.
 * Used for fuzzy identity matching when items are merged/split.
 */
function setItemChecksums(doc, identity, checksums) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) {
    itemMap = new Y.Map()
    annotations.set(identity, itemMap)
  }
  let str = checksums.join(',')
  if (itemMap.get('checksums') !== str) {
    itemMap.set('checksums', str)
  }
}

/**
 * Get an item's stored photo checksums from the CRDT.
 * Returns an array of checksum strings.
 */
function getItemChecksums(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return []
  let str = itemMap.get('checksums')
  if (!str) return []
  return str.split(',').filter(Boolean)
}

// --- Snapshot ---

/**
 * Get a snapshot of a single item from the CRDT, preserving author/ts.
 * Used for validation where author info is needed.
 */
function getItemSnapshot(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return null

  let item = {}
  for (let section of ITEM_SECTIONS) {
    let map = itemMap.get(section)
    if (!map) {
      item[section] = {}
      continue
    }

    if (section === 'photos') {
      let photosObj = {}
      map.forEach((photoMap, checksum) => {
        let metaMap = photoMap.get('metadata')
        let meta = {}
        if (metaMap) {
          metaMap.forEach((v, k) => { meta[k] = v })
        }
        photosObj[checksum] = { metadata: meta }
      })
      item[section] = photosObj
    } else {
      let obj = {}
      map.forEach((v, k) => { obj[k] = v })
      item[section] = obj
    }
  }
  return item
}

/**
 * Get all item identities in the CRDT.
 */
function getIdentities(doc) {
  let annotations = doc.getMap('annotations')
  let result = []
  annotations.forEach((_, identity) => { result.push(identity) })
  return result
}

function _stripMeta(v) {
  if (v && typeof v === 'object') {
    let { ts, author, ...content } = v
    return content
  }
  return v
}

function getSnapshot(doc) {
  let annotations = doc.getMap('annotations')
  let result = {}

  annotations.forEach((itemMap, identity) => {
    let item = {}
    for (let section of ITEM_SECTIONS) {
      let map = itemMap.get(section)
      if (!map) {
        item[section] = {}
        continue
      }

      if (section === 'photos') {
        let photosObj = {}
        map.forEach((photoMap, checksum) => {
          let metaMap = photoMap.get('metadata')
          let meta = {}
          if (metaMap) {
            metaMap.forEach((v, k) => { meta[k] = _stripMeta(v) })
          }
          photosObj[checksum] = { metadata: meta }
        })
        item[section] = photosObj
      } else {
        let obj = {}
        map.forEach((v, k) => { obj[k] = _stripMeta(v) })
        item[section] = obj
      }
    }
    result[identity] = item
  })

  return result
}

// --- Users ---

function registerUser(doc, clientId, userId) {
  let users = doc.getMap('users')
  users.set(String(clientId), {
    userId: userId || `user-${clientId}`,
    name: userId || `user-${clientId}`,
    joinedAt: Date.now(),
    lastSeen: Date.now()
  })
}

function deregisterUser(doc, clientId) {
  let users = doc.getMap('users')
  users.delete(String(clientId))
}

function heartbeat(doc, clientId) {
  let users = doc.getMap('users')
  let user = users.get(String(clientId))
  if (user) {
    users.set(String(clientId), { ...user, lastSeen: Date.now() })
  }
}

function getUsers(doc) {
  let users = doc.getMap('users')
  let result = []
  users.forEach((user, clientId) => {
    result.push({ clientId, ...user })
  })
  return result
}

// --- Room config ---

function setRoomConfig(doc, config) {
  let room = doc.getMap('room')
  for (let [key, value] of Object.entries(config)) {
    room.set(key, value)
  }
}

function getRoomConfig(doc) {
  let room = doc.getMap('room')
  let result = {}
  room.forEach((value, key) => {
    result[key] = value
  })
  return result
}

// --- Observers ---

function observeAnnotations(doc, callback) {
  let annotations = doc.getMap('annotations')

  let handler = (events) => {
    let changed = new Set()
    events.forEach((event) => {
      if (event.target === annotations) {
        event.changes.keys.forEach((change, key) => {
          changed.add(key)
        })
      }
    })
    if (changed.size > 0) callback(Array.from(changed))
  }

  annotations.observeDeep(handler)
  return () => annotations.unobserveDeep(handler)
}

function observeAnnotationsDeep(doc, callback, skipOrigin) {
  let annotations = doc.getMap('annotations')

  let handler = (events, transaction) => {
    if (skipOrigin != null && transaction.origin === skipOrigin) return

    let changes = []

    for (let event of events) {
      let path = event.path
      if (path.length >= 2) {
        let identity = path[0]
        let type = path[1]
        changes.push({ identity, type, event })
      } else if (event.target === annotations) {
        event.changes.keys.forEach((change, key) => {
          changes.push({ identity: key, type: 'item', event })
        })
      }
    }

    if (changes.length > 0) callback(changes)
  }

  annotations.observeDeep(handler)
  return () => annotations.unobserveDeep(handler)
}

module.exports = {
  ITEM_SECTIONS,
  getItemAnnotations,
  // Metadata
  setMetadata,
  getMetadata,
  // Tags
  setTag,
  removeTag,
  getTags,
  getActiveTags,
  getDeletedTags,
  // Notes
  setNote,
  removeNote,
  deleteNoteEntry,
  getNotes,
  getActiveNotes,
  // Photos
  setPhotoMetadata,
  getPhotoMetadata,
  getAllPhotoChecksums,
  // Selections
  setSelection,
  removeSelection,
  getSelections,
  getActiveSelections,
  // Selection metadata
  setSelectionMeta,
  getSelectionMeta,
  // Selection notes
  setSelectionNote,
  removeSelectionNote,
  deleteSelectionNoteEntry,
  getSelectionNotes,
  getAllSelectionNotes,
  // Transcriptions
  setTranscription,
  removeTranscription,
  getTranscriptions,
  getActiveTranscriptions,
  // Lists
  setListMembership,
  removeListMembership,
  getLists,
  getActiveLists,
  // Item checksums (fuzzy matching)
  setItemChecksums,
  getItemChecksums,
  // Snapshot
  getSnapshot,
  getItemSnapshot,
  getIdentities,
  // Tombstone purge
  purgeTombstones,
  // Users
  registerUser,
  deregisterUser,
  heartbeat,
  getUsers,
  // Room
  setRoomConfig,
  getRoomConfig,
  // Observers
  observeAnnotations,
  observeAnnotationsDeep
}
