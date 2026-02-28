'use strict'

const Y = require('yjs')
const { YKeyValue } = require('y-utility/y-keyvalue')

/**
 * CRDT Schema v4 — defines how collaborative annotations are structured
 * inside a Yjs document.
 *
 * Breaking change from v3:
 *   - Notes, selections, transcriptions, lists keyed by UUID (not content-addressed)
 *   - Metadata stored via YKeyValue (Y.Array) — no historical value retention
 *   - pushSeq (monotonic per-author counter) replaces wall-clock ts
 *   - User presence via Awareness protocol (no Y.Map "users")
 *   - UUID registry per item for vault recovery
 *   - Alias map for re-imported items
 *   - Schema version stamp in room map
 *   - deletedAt field on tombstones for time-based purging
 *
 * Document layout:
 *
 *   Y.Doc
 *   ├── Y.Map "annotations"                  keyed by item identity hash
 *   │   └── Y.Map per item
 *   │       ├── Y.Array "metadata" (YKeyValue)   {[propUri]: {text, type, lang, author, pushSeq}}
 *   │       ├── Y.Map "tags"                     {[tagName]: {color, author, pushSeq, deleted?}}
 *   │       ├── Y.Map "notes"                    {[uuid]: {html, text, lang, photo, sel, author, pushSeq, deleted?}}
 *   │       ├── Y.Map "photos"                   {[checksum]: Y.Map with Y.Array "metadata" (YKeyValue)}
 *   │       ├── Y.Map "selections"               {[uuid]: {x, y, w, h, angle, photo, author, pushSeq, deleted?}}
 *   │       ├── Y.Array "selectionMeta" (YKeyValue) {[selUUID:propUri]: {text, type, lang, author, pushSeq}}
 *   │       ├── Y.Map "selectionNotes"           {[selUUID:noteUUID]: {html, text, lang, author, pushSeq, deleted?}}
 *   │       ├── Y.Map "transcriptions"           {[uuid]: {text, data, photo, sel, author, pushSeq, deleted?}}
 *   │       ├── Y.Map "lists"                    {[uuid]: {name, member, author, pushSeq, deleted?}}
 *   │       ├── Y.Map "uuids"                    {[uuid]: {type, localRef, author}}
 *   │       ├── Y.Map "aliases"                  {[oldIdentity]: targetIdentity}
 *   │       └── "checksums"                      string (comma-separated)
 *   ├── Y.Map "schema"                           keyed by template URI (v6)
 *   │   └── {uri, name, type, version, creator, description, fields:[], author, pushSeq}
 *   ├── Y.Map "projectLists"                     keyed by UUID (v6)
 *   │   └── {uuid, name, parent, children:[], author, pushSeq}
 *   ├── Y.Map "room"                             {schemaVersion: 4}
 *   └── (Awareness protocol for presence — NOT persisted in Y.Doc)
 *
 * pushSeq: Monotonic per-author counter stored in every entry for diagnostic
 * ordering and future catch-up. NOT used for conflict resolution — see
 * vault.hasLocalEdit() for the logic-based approach.
 *
 * Tombstones: deleted entries carry { deleted: true, author, pushSeq, deletedAt }
 * where deletedAt is wall-clock (only for GC purging, not conflict resolution).
 */

const ITEM_SECTIONS = [
  'metadata', 'tags', 'notes', 'photos', 'selections',
  'selectionMeta', 'selectionNotes', 'transcriptions', 'lists',
  'uuids', 'aliases'
]

// Sections that use YKeyValue (Y.Array) instead of Y.Map
const YKV_SECTIONS = ['metadata', 'selectionMeta']

// Tag keys are normalized to lowercase to avoid collisions with Tropy's
// COLLATE NOCASE unique constraint. Display case is preserved in the value's
// `name` field.
function _normalizeTagKey(name) {
  return name.toLowerCase()
}

// --- YKeyValue cache ---
// Constructing YKeyValue scans the array; cache to avoid repeated scans.
const _kvCache = new WeakMap()

function _cachedYKV(yarray) {
  let cached = _kvCache.get(yarray)
  if (cached) return cached
  let ykv = new YKeyValue(yarray)
  _kvCache.set(yarray, ykv)
  return ykv
}

// --- Internal helpers ---

function _getItemMap(doc, identity) {
  let annotations = doc.getMap('annotations')
  return annotations.get(identity) || null
}

function _ensureItemMap(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) {
    itemMap = new Y.Map()
    annotations.set(identity, itemMap)
  }
  return itemMap
}

/**
 * Get or create a section within an item map.
 * YKV_SECTIONS use Y.Array (for YKeyValue), others use Y.Map.
 */
function _getSection(doc, identity, section) {
  let itemMap = _ensureItemMap(doc, identity)

  if (YKV_SECTIONS.includes(section)) {
    let arr = itemMap.get(section)
    if (!arr || !(arr instanceof Y.Array)) {
      arr = new Y.Array()
      itemMap.set(section, arr)
    }
    return _cachedYKV(arr)
  }

  let sectionMap = itemMap.get(section)
  if (!sectionMap) {
    sectionMap = new Y.Map()
    itemMap.set(section, sectionMap)
  }
  return sectionMap
}

/**
 * Get or create the annotations map for an item.
 * Lazily initializes the nested structure.
 */
function getItemAnnotations(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)

  let isNew = !itemMap
  if (isNew) {
    itemMap = new Y.Map()
    annotations.set(identity, itemMap)
  }

  let result = {}
  for (let section of ITEM_SECTIONS) {
    if (YKV_SECTIONS.includes(section)) {
      let arr = itemMap.get(section)
      if (!arr || !(arr instanceof Y.Array)) {
        arr = new Y.Array()
        itemMap.set(section, arr)
      }
      result[section] = _cachedYKV(arr)
    } else {
      let sectionMap = itemMap.get(section)
      if (!sectionMap) {
        sectionMap = new Y.Map()
        itemMap.set(section, sectionMap)
      }
      result[section] = sectionMap
    }
  }

  return result
}

// --- Metadata (item-level, YKeyValue) ---

function setMetadata(doc, identity, propertyUri, value, author, pushSeq) {
  let ykv = _getSection(doc, identity, 'metadata')
  ykv.set(propertyUri, {
    text: value.text || '',
    type: value.type || 'http://www.w3.org/2001/XMLSchema#string',
    language: value.language || null,
    author,
    pushSeq: pushSeq || 0
  })
}

function getMetadata(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return {}

  let arr = itemMap.get('metadata')
  if (!arr || !(arr instanceof Y.Array)) return {}

  let ykv = _cachedYKV(arr)
  let result = {}
  ykv.map.forEach((entry, key) => { result[key] = entry.val ?? entry })
  return result
}

// --- Tags ---

function setTag(doc, identity, tag, author, pushSeq) {
  let tags = _getSection(doc, identity, 'tags')
  let key = _normalizeTagKey(tag.name)
  let existing = tags.get(key)

  if (!existing || existing.deleted || tag.color !== existing.color) {
    tags.set(key, {
      name: tag.name,
      color: tag.color || null,
      author,
      pushSeq: pushSeq || 0
    })
  }
}

function removeTag(doc, identity, tagName, author, pushSeq) {
  let tags = _getSection(doc, identity, 'tags')
  let key = _normalizeTagKey(tagName)
  let existing = tags.get(key)
  if (existing && !existing.deleted) {
    tags.set(key, {
      ...existing,
      deleted: true,
      author,
      pushSeq: pushSeq || 0,
      deletedAt: Date.now()
    })
  }
}

function getTags(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return []

  let tags = itemMap.get('tags')
  if (!tags) return []

  let result = []
  tags.forEach((value) => {
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

// --- Notes (UUID-keyed) ---

function setNote(doc, identity, uuid, note, author, pushSeq) {
  let notes = _getSection(doc, identity, 'notes')
  notes.set(uuid, {
    uuid,
    text: note.text || '',
    html: note.html || '',
    language: note.language || null,
    photo: note.photo || null,
    selection: note.selection || null,
    author,
    pushSeq: pushSeq || 0
  })
  _registerUUID(doc, identity, uuid, 'note', note.photo || note.selection)
}

function removeNote(doc, identity, uuid, author, pushSeq) {
  let notes = _getSection(doc, identity, 'notes')
  let existing = notes.get(uuid)
  if (existing && !existing.deleted) {
    notes.set(uuid, {
      ...existing,
      deleted: true,
      author,
      pushSeq: pushSeq || 0,
      deletedAt: Date.now()
    })
  }
}

function getNotes(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
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
 * Used to clean up stale entries.
 */
function deleteNoteEntry(doc, identity, noteKey) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return
  let notes = itemMap.get('notes')
  if (!notes) return
  notes.delete(noteKey)
}

// --- Photos (checksum-keyed with YKeyValue metadata) ---

function setPhotoMetadata(doc, identity, checksum, propertyUri, value, author, pushSeq) {
  let photos = _getSection(doc, identity, 'photos')
  let photoMap = photos.get(checksum)

  if (!photoMap) {
    photoMap = new Y.Map()
    photoMap.set('metadata', new Y.Array())
    photos.set(checksum, photoMap)
  }

  let arr = photoMap.get('metadata')
  if (!arr || !(arr instanceof Y.Array)) {
    arr = new Y.Array()
    photoMap.set('metadata', arr)
  }

  let ykv = _cachedYKV(arr)
  ykv.set(propertyUri, {
    text: value.text || '',
    type: value.type || 'http://www.w3.org/2001/XMLSchema#string',
    language: value.language || null,
    author,
    pushSeq: pushSeq || 0
  })
}

function getPhotoMetadata(doc, identity, checksum) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return {}

  let photos = itemMap.get('photos')
  if (!photos) return {}

  let photoMap = photos.get(checksum)
  if (!photoMap) return {}

  let arr = photoMap.get('metadata')
  if (!arr || !(arr instanceof Y.Array)) return {}

  let ykv = _cachedYKV(arr)
  let result = {}
  ykv.map.forEach((entry, key) => { result[key] = entry.val ?? entry })
  return result
}

function getAllPhotoChecksums(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return []

  let photos = itemMap.get('photos')
  if (!photos) return []

  let result = []
  photos.forEach((_, checksum) => {
    result.push(checksum)
  })
  return result
}

// --- Selections (UUID-keyed) ---

function setSelection(doc, identity, uuid, selection, author, pushSeq) {
  let selections = _getSection(doc, identity, 'selections')

  let x = selection.x ?? 0
  let y = selection.y ?? 0
  let w = selection.width ?? selection.w
  let h = selection.height ?? selection.h
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  if (w == null || h == null || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return

  selections.set(uuid, {
    uuid,
    x,
    y,
    w,
    h,
    angle: selection.angle ?? 0,
    photo: selection.photo || null,
    author,
    pushSeq: pushSeq || 0
  })
  _registerUUID(doc, identity, uuid, 'selection', selection.photo)
}

function removeSelection(doc, identity, uuid, author, pushSeq) {
  let selections = _getSection(doc, identity, 'selections')
  let existing = selections.get(uuid)
  if (existing && !existing.deleted) {
    selections.set(uuid, {
      ...existing,
      deleted: true,
      author,
      pushSeq: pushSeq || 0,
      deletedAt: Date.now()
    })
  }
}

function getSelections(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
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

// --- Selection Metadata (YKeyValue, composite key: selUUID:propUri) ---

function setSelectionMeta(doc, identity, selUUID, propertyUri, value, author, pushSeq) {
  let ykv = _getSection(doc, identity, 'selectionMeta')
  let key = `${selUUID}:${propertyUri}`
  ykv.set(key, {
    text: value.text || '',
    type: value.type || 'http://www.w3.org/2001/XMLSchema#string',
    language: value.language || null,
    author,
    pushSeq: pushSeq || 0
  })
}

function getSelectionMeta(doc, identity, selUUID) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return {}

  let arr = itemMap.get('selectionMeta')
  if (!arr || !(arr instanceof Y.Array)) return {}

  let ykv = _cachedYKV(arr)
  let prefix = `${selUUID}:`
  let result = {}
  ykv.map.forEach((entry, key) => {
    if (key.startsWith(prefix)) {
      let propUri = key.slice(prefix.length)
      result[propUri] = entry.val ?? entry
    }
  })
  return result
}

// --- Selection Notes (UUID-keyed, composite key: selUUID:noteUUID) ---

function setSelectionNote(doc, identity, selUUID, noteUUID, note, author, pushSeq) {
  let selectionNotes = _getSection(doc, identity, 'selectionNotes')
  let key = `${selUUID}:${noteUUID}`
  selectionNotes.set(key, {
    noteUUID,
    selUUID,
    text: note.text || '',
    html: note.html || '',
    language: note.language || null,
    author,
    pushSeq: pushSeq || 0
  })
  _registerUUID(doc, identity, noteUUID, 'selectionNote', selUUID)
}

function removeSelectionNote(doc, identity, selUUID, noteUUID, author, pushSeq) {
  let selectionNotes = _getSection(doc, identity, 'selectionNotes')
  let key = `${selUUID}:${noteUUID}`
  let existing = selectionNotes.get(key)
  if (existing && !existing.deleted) {
    selectionNotes.set(key, {
      ...existing,
      deleted: true,
      author,
      pushSeq: pushSeq || 0,
      deletedAt: Date.now()
    })
  }
}

function getSelectionNotes(doc, identity, selUUID) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return {}

  let selectionNotes = itemMap.get('selectionNotes')
  if (!selectionNotes) return {}

  let prefix = `${selUUID}:`
  let result = {}
  selectionNotes.forEach((value, key) => {
    if (key.startsWith(prefix)) {
      if (!value.deleted) result[key] = value
    }
  })
  return result
}

function getAllSelectionNotes(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return {}

  let selectionNotes = itemMap.get('selectionNotes')
  if (!selectionNotes) return {}

  let result = {}
  selectionNotes.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function deleteSelectionNoteEntry(doc, identity, compositeKey) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return
  let selectionNotes = itemMap.get('selectionNotes')
  if (!selectionNotes) return
  selectionNotes.delete(compositeKey)
}

// --- Transcriptions (UUID-keyed) ---

function setTranscription(doc, identity, uuid, transcription, author, pushSeq) {
  let transcriptions = _getSection(doc, identity, 'transcriptions')
  transcriptions.set(uuid, {
    uuid,
    text: transcription.text || '',
    data: transcription.data || null,
    photo: transcription.photo || null,
    selection: transcription.selection || null,
    author,
    pushSeq: pushSeq || 0
  })
  _registerUUID(doc, identity, uuid, 'transcription', transcription.photo || transcription.selection)
}

function removeTranscription(doc, identity, uuid, author, pushSeq) {
  let transcriptions = _getSection(doc, identity, 'transcriptions')
  let existing = transcriptions.get(uuid)
  if (existing && !existing.deleted) {
    transcriptions.set(uuid, {
      ...existing,
      deleted: true,
      author,
      pushSeq: pushSeq || 0,
      deletedAt: Date.now()
    })
  }
}

function getTranscriptions(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
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

// --- Lists (UUID-keyed with name field) ---

function setListMembership(doc, identity, listUUID, listName, author, pushSeq) {
  let lists = _getSection(doc, identity, 'lists')
  lists.set(listUUID, {
    uuid: listUUID,
    name: listName,
    member: true,
    author,
    pushSeq: pushSeq || 0
  })
  _registerUUID(doc, identity, listUUID, 'list', listName)
}

function removeListMembership(doc, identity, listUUID, author, pushSeq) {
  let lists = _getSection(doc, identity, 'lists')
  let existing = lists.get(listUUID)
  if (existing && !existing.deleted) {
    lists.set(listUUID, {
      ...existing,
      member: false,
      deleted: true,
      author,
      pushSeq: pushSeq || 0,
      deletedAt: Date.now()
    })
  }
}

function getLists(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
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

// --- UUID Registry ---

function _registerUUID(doc, identity, uuid, type, localRef) {
  let uuids = _getSection(doc, identity, 'uuids')
  if (!uuids.has(uuid)) {
    uuids.set(uuid, { type, localRef: localRef || null, author: null })
  }
}

function getUUIDRegistry(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return {}
  let uuids = itemMap.get('uuids')
  if (!uuids) return {}
  let result = {}
  uuids.forEach((v, k) => { result[k] = v })
  return result
}

// --- Alias Map ---

function setAlias(doc, oldIdentity, newIdentity) {
  let itemMap = _getItemMap(doc, newIdentity)
  if (!itemMap) {
    // Item may not exist yet — ensure it does
    itemMap = _ensureItemMap(doc, newIdentity)
  }

  let aliases = itemMap.get('aliases')
  if (!aliases) {
    aliases = new Y.Map()
    itemMap.set('aliases', aliases)
  }
  aliases.set(oldIdentity, { target: newIdentity, createdAt: Date.now() })
}

function resolveAlias(doc, identity) {
  let annotations = doc.getMap('annotations')
  // Check if any item's aliases map contains this identity
  let resolved = null
  annotations.forEach((itemMap, itemIdentity) => {
    if (resolved) return
    let aliases = itemMap.get('aliases')
    if (aliases) {
      let entry = aliases.get(identity)
      if (entry) {
        // Backward compat: handle both old string-only and new object format
        resolved = typeof entry === 'string' ? entry : entry.target
      }
    }
  })
  return resolved
}

// --- Tombstone purge ---

/**
 * Remove tombstoned entries older than maxAgeMs from the CRDT document.
 * Uses deletedAt field (wall-clock) for time-based purging.
 * Falls back to unconditional purge when deletedAt is missing.
 */
function purgeTombstones(doc, maxAgeMs) {
  let annotations = doc.getMap('annotations')
  let tombstoneSections = ['tags', 'notes', 'selections', 'selectionNotes', 'transcriptions', 'lists']
  let purged = 0
  let uuidsPurged = 0
  let aliasesPurged = 0
  let items = 0

  let cutoff = maxAgeMs ? Date.now() - maxAgeMs : null

  annotations.forEach((itemMap) => {
    items++
    for (let section of tombstoneSections) {
      let map = itemMap.get(section)
      if (!map) continue

      let toDelete = []
      map.forEach((value, key) => {
        if (value && value.deleted) {
          if (!cutoff || !value.deletedAt || value.deletedAt < cutoff) {
            toDelete.push(key)
          }
        }
      })

      for (let key of toDelete) {
        map.delete(key)
        purged++
      }
    }

    // Prune orphaned UUID registry entries — collect live UUIDs from all sections
    let uuids = itemMap.get('uuids')
    if (uuids && typeof uuids.forEach === 'function') {
      let liveUUIDs = new Set()

      let notes = itemMap.get('notes')
      if (notes) notes.forEach((_, k) => liveUUIDs.add(k))

      let selections = itemMap.get('selections')
      if (selections) selections.forEach((_, k) => liveUUIDs.add(k))

      let selectionNotes = itemMap.get('selectionNotes')
      if (selectionNotes) {
        selectionNotes.forEach((_, k) => {
          // Composite key: selUUID:noteUUID — both parts are live
          let sep = k.indexOf(':')
          if (sep > 0) {
            liveUUIDs.add(k.slice(0, sep))
            liveUUIDs.add(k.slice(sep + 1))
          }
        })
      }

      let transcriptions = itemMap.get('transcriptions')
      if (transcriptions) transcriptions.forEach((_, k) => liveUUIDs.add(k))

      let lists = itemMap.get('lists')
      if (lists) lists.forEach((_, k) => liveUUIDs.add(k))

      let orphaned = []
      uuids.forEach((_, k) => {
        if (!liveUUIDs.has(k)) orphaned.push(k)
      })
      for (let k of orphaned) {
        uuids.delete(k)
        uuidsPurged++
      }
    }

    // Purge expired aliases
    let aliases = itemMap.get('aliases')
    if (aliases && typeof aliases.forEach === 'function') {
      let toDelete = []
      aliases.forEach((value, key) => {
        let createdAt = (value && typeof value === 'object') ? value.createdAt : 0
        if (!cutoff || !createdAt || createdAt < cutoff) {
          toDelete.push(key)
        }
      })
      for (let key of toDelete) {
        aliases.delete(key)
        aliasesPurged++
      }
    }
  })

  return { items, purged, uuidsPurged, aliasesPurged }
}

// --- Item checksums (fuzzy identity matching) ---

function setItemChecksums(doc, identity, checksums) {
  let itemMap = _ensureItemMap(doc, identity)
  let str = checksums.join(',')
  if (itemMap.get('checksums') !== str) {
    itemMap.set('checksums', str)
  }
}

function getItemChecksums(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return []
  let str = itemMap.get('checksums')
  if (!str) return []
  return str.split(',').filter(Boolean)
}

// --- Schema version ---

function checkSchemaVersion(doc) {
  let room = doc.getMap('room')
  let version = room.get('schemaVersion')
  return { version: version || null, compatible: !version || version === 4 }
}

function setSchemaVersion(doc) {
  doc.getMap('room').set('schemaVersion', 4)
}

// --- Snapshot ---

function getItemSnapshot(doc, identity) {
  let itemMap = _getItemMap(doc, identity)
  if (!itemMap) return null

  let item = {}
  for (let section of ITEM_SECTIONS) {
    if (YKV_SECTIONS.includes(section)) {
      let arr = itemMap.get(section)
      if (!arr || !(arr instanceof Y.Array)) {
        item[section] = {}
        continue
      }
      let ykv = _cachedYKV(arr)
      let obj = {}
      ykv.map.forEach((entry, k) => { obj[k] = entry.val ?? entry })
      item[section] = obj
    } else if (section === 'photos') {
      let photosMap = itemMap.get(section)
      let photosObj = {}
      if (photosMap) {
        photosMap.forEach((photoMap, checksum) => {
          let arr = photoMap.get('metadata')
          let meta = {}
          if (arr && arr instanceof Y.Array) {
            let ykv = _cachedYKV(arr)
            ykv.map.forEach((entry, k) => { meta[k] = entry.val ?? entry })
          } else if (arr) {
            // Fallback: plain Y.Map (shouldn't happen in v4 but be safe)
            arr.forEach((v, k) => { meta[k] = v })
          }
          photosObj[checksum] = { metadata: meta }
        })
      }
      item[section] = photosObj
    } else {
      let map = itemMap.get(section)
      if (!map) {
        item[section] = {}
        continue
      }
      let obj = {}
      map.forEach((v, k) => { obj[k] = v })
      item[section] = obj
    }
  }
  return item
}

function getIdentities(doc) {
  let annotations = doc.getMap('annotations')
  let result = []
  annotations.forEach((_, identity) => { result.push(identity) })
  return result
}

function _stripMeta(v) {
  if (v && typeof v === 'object') {
    let { pushSeq, author, ts, ...content } = v
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
      if (YKV_SECTIONS.includes(section)) {
        let arr = itemMap.get(section)
        if (!arr || !(arr instanceof Y.Array)) {
          item[section] = {}
          continue
        }
        let ykv = _cachedYKV(arr)
        let obj = {}
        ykv.map.forEach((entry, k) => { obj[k] = _stripMeta(entry.val ?? entry) })
        item[section] = obj
      } else if (section === 'photos') {
        let photosMap = itemMap.get(section)
        let photosObj = {}
        if (photosMap) {
          photosMap.forEach((photoMap, checksum) => {
            let arr = photoMap.get('metadata')
            let meta = {}
            if (arr && arr instanceof Y.Array) {
              let ykv = _cachedYKV(arr)
              ykv.map.forEach((entry, k) => { meta[k] = _stripMeta(entry.val ?? entry) })
            } else if (arr) {
              arr.forEach((v, k) => { meta[k] = _stripMeta(v) })
            }
            photosObj[checksum] = { metadata: meta }
          })
        }
        item[section] = photosObj
      } else {
        let map = itemMap.get(section)
        if (!map) {
          item[section] = {}
          continue
        }
        let obj = {}
        map.forEach((v, k) => { obj[k] = _stripMeta(v) })
        item[section] = obj
      }
    }
    result[identity] = item
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

// --- Template Schema (root doc, keyed by URI) ---

function getTemplateSchema(doc) {
  let schemaMap = doc.getMap('schema')
  let result = {}
  schemaMap.forEach((val, key) => {
    result[key] = val
  })
  return result
}

function setTemplateSchema(doc, uri, templateDef, author, pushSeq) {
  let schemaMap = doc.getMap('schema')
  schemaMap.set(uri, {
    uri,
    name: templateDef.name,
    type: templateDef.type,
    version: templateDef.version || null,
    creator: templateDef.creator || null,
    description: templateDef.description || null,
    fields: (templateDef.fields || []).map(f => ({
      property: f.property,
      label: f.label || null,
      datatype: f.datatype || null,
      isRequired: !!f.isRequired,
      isConstant: !!f.isConstant,
      hint: f.hint || null,
      value: f.value || null
    })),
    author,
    pushSeq: pushSeq || 0
  })
}

function removeTemplateSchema(doc, uri, author, pushSeq) {
  let schemaMap = doc.getMap('schema')
  schemaMap.set(uri, {
    uri,
    deleted: true,
    author,
    pushSeq: pushSeq || 0,
    deletedAt: Date.now()
  })
}

// --- List Hierarchy (root doc, keyed by UUID) ---

function getListHierarchy(doc) {
  let listsMap = doc.getMap('projectLists')
  let result = {}
  listsMap.forEach((val, key) => {
    result[key] = val
  })
  return result
}

function setListHierarchyEntry(doc, uuid, entry, author, pushSeq) {
  let listsMap = doc.getMap('projectLists')
  listsMap.set(uuid, {
    uuid,
    name: entry.name,
    parent: entry.parent || null,
    children: entry.children || [],
    author,
    pushSeq: pushSeq || 0
  })
}

function removeListHierarchyEntry(doc, uuid, author, pushSeq) {
  let listsMap = doc.getMap('projectLists')
  listsMap.set(uuid, {
    uuid,
    deleted: true,
    author,
    pushSeq: pushSeq || 0,
    deletedAt: Date.now()
  })
}

// --- Root doc observers ---

function observeSchema(doc, callback, skipOrigin) {
  let schemaMap = doc.getMap('schema')
  let handler = (event, transaction) => {
    if (skipOrigin != null && transaction.origin === skipOrigin) return
    let changed = []
    event.changes.keys.forEach((change, key) => {
      changed.push({ uri: key, action: change.action })
    })
    if (changed.length > 0) callback(changed)
  }
  schemaMap.observe(handler)
  return () => schemaMap.unobserve(handler)
}

function observeProjectLists(doc, callback, skipOrigin) {
  let listsMap = doc.getMap('projectLists')
  let handler = (event, transaction) => {
    if (skipOrigin != null && transaction.origin === skipOrigin) return
    let changed = []
    event.changes.keys.forEach((change, key) => {
      changed.push({ uuid: key, action: change.action })
    })
    if (changed.length > 0) callback(changed)
  }
  listsMap.observe(handler)
  return () => listsMap.unobserve(handler)
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
  // Metadata (YKeyValue)
  setMetadata,
  getMetadata,
  // Tags
  setTag,
  removeTag,
  getTags,
  getActiveTags,
  getDeletedTags,
  // Notes (UUID-keyed)
  setNote,
  removeNote,
  deleteNoteEntry,
  getNotes,
  getActiveNotes,
  // Photos (YKeyValue metadata)
  setPhotoMetadata,
  getPhotoMetadata,
  getAllPhotoChecksums,
  // Selections (UUID-keyed)
  setSelection,
  removeSelection,
  getSelections,
  getActiveSelections,
  // Selection metadata (YKeyValue)
  setSelectionMeta,
  getSelectionMeta,
  // Selection notes (UUID-keyed)
  setSelectionNote,
  removeSelectionNote,
  deleteSelectionNoteEntry,
  getSelectionNotes,
  getAllSelectionNotes,
  // Transcriptions (UUID-keyed)
  setTranscription,
  removeTranscription,
  getTranscriptions,
  getActiveTranscriptions,
  // Lists (UUID-keyed)
  setListMembership,
  removeListMembership,
  getLists,
  getActiveLists,
  // UUID registry
  getUUIDRegistry,
  // Aliases
  setAlias,
  resolveAlias,
  // Item checksums (fuzzy matching)
  setItemChecksums,
  getItemChecksums,
  // Schema version
  checkSchemaVersion,
  setSchemaVersion,
  // Snapshot
  getSnapshot,
  getItemSnapshot,
  getIdentities,
  // Tombstone purge
  purgeTombstones,
  // Room
  setRoomConfig,
  getRoomConfig,
  // Template schema (root doc)
  getTemplateSchema,
  setTemplateSchema,
  removeTemplateSchema,
  // List hierarchy (root doc)
  getListHierarchy,
  setListHierarchyEntry,
  removeListHierarchyEntry,
  // Observers
  observeAnnotations,
  observeAnnotationsDeep,
  observeSchema,
  observeProjectLists
}
