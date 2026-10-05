'use strict'

const Y = require('yjs')
const { YKeyValue } = require('y-utility/y-keyvalue')
const { purgeTombstones } = require('./purge')

/**
 * CRDT schema v5 — how a room's annotations are laid out in one Yjs doc.
 *
 * Every section is a TOP-LEVEL shared type, and every entry's key is
 * `<item identity>|<key>`. Nothing is a shared type nested under a key.
 *
 * Why: Yjs resolves two peers setting the same map key concurrently by
 * keeping one value. When that value is a nested map, the other peer's map
 * is discarded with everything written into it. Schema v4 kept a map per
 * item, and maps per section inside it, all created on first write — so
 * whenever two peers first wrote the same item or section before seeing
 * each other's update (every first sync of a shared collection), one
 * peer's annotations for that item were lost. Measured: 200 of 200 runs.
 * Top-level types are merged by name and can never compete.
 *
 *   Y.Map   items           identity → { checksums: [...] }
 *   Y.Map   tags            identity|lowercase name → { name, color, author, pushSeq, deleted? }
 *   Y.Map   notes           identity|n_uuid → { uuid, text, html, language, photo, author, ... }
 *   Y.Map   selections      identity|s_uuid → { uuid, x, y, w, h, angle, photo, author, ... }
 *   Y.Map   selectionNotes  identity|s_uuid:n_uuid → { noteUUID, selUUID, text, html, ... }
 *   Y.Map   transcriptions  identity|t_uuid → { uuid, text, data, photo, selection, ... }
 *   Y.Map   lists           identity|l_uuid → { uuid, name, member, author, ... }
 *   Y.Map   uuids           identity|uuid → { type, localRef }
 *   Y.Map   aliases         old identity → { target, createdAt }
 *   Y.Array metadata        YKeyValue: identity|property → { text, type, language, author, pushSeq }
 *   Y.Array photoMetadata   YKeyValue: identity|checksum|property → { ... }
 *   Y.Array selectionMeta   YKeyValue: identity|s_uuid:property → { ... }
 *   Y.Map   schema          template URI → template definition
 *   Y.Map   projectLists    l_uuid → { uuid, name, parent, children }
 *   Y.Map   room            { schemaVersion: 5 }
 *
 * Values are plain JSON, written whole. Metadata uses YKeyValue so the doc
 * does not keep every value a field ever had.
 *
 * Tombstones: { deleted: true, author, pushSeq, deletedAt }. deletedAt is
 * wall-clock, used only to purge old tombstones.
 */

const SCHEMA_VERSION = 5
const SEP = '|'

const MAP_SECTIONS = [
  'tags', 'notes', 'selections', 'selectionNotes', 'transcriptions', 'lists', 'uuids'
]
const KV_SECTIONS = ['metadata', 'photoMetadata', 'selectionMeta']

// The sections an item snapshot reports, under their v4 names.
const ITEM_SECTIONS = [
  'metadata', 'tags', 'notes', 'photos', 'selections',
  'selectionMeta', 'selectionNotes', 'transcriptions', 'lists',
  'uuids', 'aliases'
]

const TEXT = 'http://www.w3.org/2001/XMLSchema#string'

const keyOf = (identity, rest) => `${identity}${SEP}${rest}`

function split(key) {
  let i = key.indexOf(SEP)
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)]
}

// --- Section access and the per-item index -------------------------------

const _kv = new WeakMap()      // Y.Array → YKeyValue
const _index = new WeakMap()   // Y.Map | YKeyValue → Map<identity, Set<rest>>

function _map(doc, section) {
  return doc.getMap(section)
}

function _kvOf(doc, section) {
  let arr = doc.getArray(section)
  let kv = _kv.get(arr)
  if (!kv) {
    kv = new YKeyValue(arr)
    _kv.set(arr, kv)
  }
  return kv
}

function _indexAdd(idx, key) {
  let [identity, rest] = split(key)
  let set = idx.get(identity)
  if (!set) idx.set(identity, set = new Set())
  set.add(rest)
}

function _indexDelete(idx, key) {
  let [identity, rest] = split(key)
  let set = idx.get(identity)
  if (set) {
    set.delete(rest)
    if (set.size === 0) idx.delete(identity)
  }
}

/** identity → keys, kept current by an observer (remote writes) and by the
 *  setters below (local writes, visible before the transaction ends). */
function _indexOf(doc, section) {
  if (KV_SECTIONS.includes(section)) {
    let kv = _kvOf(doc, section)
    let idx = _index.get(kv)
    if (!idx) {
      idx = new Map()
      for (let key of kv.map.keys()) _indexAdd(idx, key)
      kv.on('change', changes => {
        for (let [key, change] of changes) {
          if (change.action === 'delete') _indexDelete(idx, key)
          else _indexAdd(idx, key)
        }
      })
      _index.set(kv, idx)
    }
    return idx
  }
  let map = _map(doc, section)
  let idx = _index.get(map)
  if (!idx) {
    idx = new Map()
    map.forEach((_, key) => _indexAdd(idx, key))
    map.observe(event => {
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'delete') _indexDelete(idx, key)
        else _indexAdd(idx, key)
      })
    })
    _index.set(map, idx)
  }
  return idx
}

function _set(doc, section, identity, rest, value) {
  let key = keyOf(identity, rest)
  _ensureItem(doc, identity)
  if (KV_SECTIONS.includes(section)) _kvOf(doc, section).set(key, value)
  else _map(doc, section).set(key, value)
  _indexAdd(_indexOf(doc, section), key)
}

function _get(doc, section, identity, rest) {
  let key = keyOf(identity, rest)
  if (KV_SECTIONS.includes(section)) {
    let e = _kvOf(doc, section).map.get(key)
    return e ? (e.val ?? e) : undefined
  }
  return _map(doc, section).get(key)
}

function _delete(doc, section, identity, rest) {
  let key = keyOf(identity, rest)
  if (KV_SECTIONS.includes(section)) _kvOf(doc, section).delete(key)
  else _map(doc, section).delete(key)
  _indexDelete(_indexOf(doc, section), key)
}

/** { rest: value } for one item in one section. */
function _entries(doc, section, identity) {
  let out = {}
  let rests = _indexOf(doc, section).get(identity)
  if (!rests) return out
  for (let rest of rests) {
    let v = _get(doc, section, identity, rest)
    if (v !== undefined) out[rest] = v
  }
  return out
}

function _ensureItem(doc, identity) {
  let items = _map(doc, 'items')
  if (!items.has(identity)) items.set(identity, { checksums: [] })
}

const active = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => !v.deleted))

/**
 * Only an entry's author may tombstone a note, selection or transcription.
 * Anyone may delete their own copy; writing that over someone else's entry
 * would erase it from the room for everyone who joins later.
 */
function _mayRetract(existing, author) {
  return existing && !existing.deleted && (!existing.author || existing.author === author)
}

function _tombstone(existing, author, pushSeq) {
  return { ...existing, deleted: true, author, pushSeq: pushSeq || 0, deletedAt: Date.now() }
}

// --- Metadata (item-level) -------------------------------------------------

function _metaValue(value, author, pushSeq) {
  return {
    text: value.text || '',
    type: value.type || TEXT,
    language: value.language || null,
    author,
    pushSeq: pushSeq || 0
  }
}

function setMetadata(doc, identity, propertyUri, value, author, pushSeq) {
  _set(doc, 'metadata', identity, propertyUri, _metaValue(value, author, pushSeq))
}

function getMetadata(doc, identity) {
  return _entries(doc, 'metadata', identity)
}

// --- Tags (keyed by lowercase name: Tropy compares tag names NOCASE) --------

function setTag(doc, identity, tag, author, pushSeq) {
  let key = tag.name.toLowerCase()
  let existing = _get(doc, 'tags', identity, key)
  if (!existing || existing.deleted || tag.color !== existing.color) {
    _set(doc, 'tags', identity, key, {
      name: tag.name, color: tag.color || null, author, pushSeq: pushSeq || 0
    })
  }
}

function removeTag(doc, identity, tagName, author, pushSeq) {
  let key = tagName.toLowerCase()
  let existing = _get(doc, 'tags', identity, key)
  if (existing && !existing.deleted) _set(doc, 'tags', identity, key, _tombstone(existing, author, pushSeq))
}

function getTags(doc, identity) {
  return Object.values(_entries(doc, 'tags', identity))
}

function getActiveTags(doc, identity) {
  return getTags(doc, identity).filter(t => !t.deleted)
}

function getDeletedTags(doc, identity) {
  return getTags(doc, identity).filter(t => t.deleted)
}

// --- Notes -----------------------------------------------------------------

function setNote(doc, identity, uuid, note, author, pushSeq) {
  _set(doc, 'notes', identity, uuid, {
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
  let existing = _get(doc, 'notes', identity, uuid)
  if (_mayRetract(existing, author)) _set(doc, 'notes', identity, uuid, _tombstone(existing, author, pushSeq))
}

function getNotes(doc, identity) {
  return _entries(doc, 'notes', identity)
}

function getActiveNotes(doc, identity) {
  return active(getNotes(doc, identity))
}

/** Remove a note entry outright (not a tombstone). */
function deleteNoteEntry(doc, identity, noteKey) {
  _delete(doc, 'notes', identity, noteKey)
}

// --- Photo metadata (keyed by photo checksum) ------------------------------

function setPhotoMetadata(doc, identity, checksum, propertyUri, value, author, pushSeq) {
  _set(doc, 'photoMetadata', identity, `${checksum}${SEP}${propertyUri}`,
    _metaValue(value, author, pushSeq))
}

function getPhotoMetadata(doc, identity, checksum) {
  let prefix = `${checksum}${SEP}`
  let out = {}
  for (let [rest, v] of Object.entries(_entries(doc, 'photoMetadata', identity))) {
    if (rest.startsWith(prefix)) out[rest.slice(prefix.length)] = v
  }
  return out
}

function getAllPhotoChecksums(doc, identity) {
  let out = new Set()
  for (let rest of Object.keys(_entries(doc, 'photoMetadata', identity))) {
    out.add(split(rest)[0])
  }
  return [...out]
}

// --- Selections --------------------------------------------------------------

function setSelection(doc, identity, uuid, selection, author, pushSeq) {
  let x = selection.x ?? 0
  let y = selection.y ?? 0
  let w = selection.width ?? selection.w
  let h = selection.height ?? selection.h
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return

  _set(doc, 'selections', identity, uuid, {
    uuid, x, y, w, h,
    angle: selection.angle ?? 0,
    photo: selection.photo || null,
    author,
    pushSeq: pushSeq || 0
  })
  _registerUUID(doc, identity, uuid, 'selection', selection.photo)
}

function removeSelection(doc, identity, uuid, author, pushSeq) {
  let existing = _get(doc, 'selections', identity, uuid)
  if (_mayRetract(existing, author)) _set(doc, 'selections', identity, uuid, _tombstone(existing, author, pushSeq))
}

function getSelections(doc, identity) {
  return _entries(doc, 'selections', identity)
}

function getActiveSelections(doc, identity) {
  return active(getSelections(doc, identity))
}

// --- Selection metadata (key: selUUID:propertyUri) --------------------------

function setSelectionMeta(doc, identity, selUUID, propertyUri, value, author, pushSeq) {
  _set(doc, 'selectionMeta', identity, `${selUUID}:${propertyUri}`, _metaValue(value, author, pushSeq))
}

function getSelectionMeta(doc, identity, selUUID) {
  let prefix = `${selUUID}:`
  let out = {}
  for (let [rest, v] of Object.entries(_entries(doc, 'selectionMeta', identity))) {
    if (rest.startsWith(prefix)) out[rest.slice(prefix.length)] = v
  }
  return out
}

// --- Selection notes (key: selUUID:noteUUID) --------------------------------

function setSelectionNote(doc, identity, selUUID, noteUUID, note, author, pushSeq) {
  _set(doc, 'selectionNotes', identity, `${selUUID}:${noteUUID}`, {
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
  let rest = `${selUUID}:${noteUUID}`
  let existing = _get(doc, 'selectionNotes', identity, rest)
  if (_mayRetract(existing, author)) _set(doc, 'selectionNotes', identity, rest, _tombstone(existing, author, pushSeq))
}

/** Active notes on one selection, keyed selUUID:noteUUID. */
function getSelectionNotes(doc, identity, selUUID) {
  let prefix = `${selUUID}:`
  let out = {}
  for (let [rest, v] of Object.entries(_entries(doc, 'selectionNotes', identity))) {
    if (rest.startsWith(prefix) && !v.deleted) out[rest] = v
  }
  return out
}

function getAllSelectionNotes(doc, identity) {
  return _entries(doc, 'selectionNotes', identity)
}

function deleteSelectionNoteEntry(doc, identity, compositeKey) {
  _delete(doc, 'selectionNotes', identity, compositeKey)
}

// --- Transcriptions -----------------------------------------------------------

function setTranscription(doc, identity, uuid, transcription, author, pushSeq) {
  _set(doc, 'transcriptions', identity, uuid, {
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
  let existing = _get(doc, 'transcriptions', identity, uuid)
  if (_mayRetract(existing, author)) _set(doc, 'transcriptions', identity, uuid, _tombstone(existing, author, pushSeq))
}

function getTranscriptions(doc, identity) {
  return _entries(doc, 'transcriptions', identity)
}

function getActiveTranscriptions(doc, identity) {
  return active(getTranscriptions(doc, identity))
}

// --- List membership -----------------------------------------------------------

function setListMembership(doc, identity, listUUID, listName, author, pushSeq) {
  _set(doc, 'lists', identity, listUUID, {
    uuid: listUUID, name: listName, member: true, author, pushSeq: pushSeq || 0
  })
  _registerUUID(doc, identity, listUUID, 'list', listName)
}

function removeListMembership(doc, identity, listUUID, author, pushSeq) {
  let existing = _get(doc, 'lists', identity, listUUID)
  if (existing && !existing.deleted) {
    _set(doc, 'lists', identity, listUUID, { ..._tombstone(existing, author, pushSeq), member: false })
  }
}

function getLists(doc, identity) {
  return _entries(doc, 'lists', identity)
}

function getActiveLists(doc, identity) {
  return Object.fromEntries(Object.entries(getLists(doc, identity)).filter(([, v]) => !v.deleted && v.member))
}

// --- UUID registry ---------------------------------------------------------------

function _registerUUID(doc, identity, uuid, type, localRef) {
  if (_get(doc, 'uuids', identity, uuid) === undefined) {
    _set(doc, 'uuids', identity, uuid, { type, localRef: localRef || null })
  }
}

function getUUIDRegistry(doc, identity) {
  return _entries(doc, 'uuids', identity)
}

// --- Aliases: an item whose photo set changed has a new identity ------------------

function setAlias(doc, oldIdentity, newIdentity) {
  _ensureItem(doc, newIdentity)
  _map(doc, 'aliases').set(oldIdentity, { target: newIdentity, createdAt: Date.now() })
}

function resolveAlias(doc, identity) {
  let entry = _map(doc, 'aliases').get(identity)
  if (!entry) return null
  return typeof entry === 'string' ? entry : entry.target
}

// --- Items ------------------------------------------------------------------------

function setItemChecksums(doc, identity, checksums) {
  let items = _map(doc, 'items')
  let current = items.get(identity)
  let sorted = [...checksums].sort()
  if (!current || JSON.stringify(current.checksums) !== JSON.stringify(sorted)) {
    items.set(identity, { ...(current || {}), checksums: sorted })
  }
}

function getItemChecksums(doc, identity) {
  let item = _map(doc, 'items').get(identity)
  return item ? (item.checksums || []) : []
}

function getIdentities(doc) {
  return Array.from(_map(doc, 'items').keys())
}

// --- Tombstone purge: src/purge.js (shared with the server) -------------------------

// --- Schema version and migration from v4 --------------------------------------------

function checkSchemaVersion(doc) {
  let version = doc.getMap('room').get('schemaVersion')
  return { version: version || null, compatible: !version || version === SCHEMA_VERSION }
}

function setSchemaVersion(doc) {
  let room = doc.getMap('room')
  if (room.get('schemaVersion') !== SCHEMA_VERSION) room.set('schemaVersion', SCHEMA_VERSION)
}

/**
 * Copy a v4 room (one nested map per item under `annotations`) into the v5
 * sections. Idempotent; entries already present in v5 are kept. The v4
 * data is left in place for peers that have not upgraded, but is no longer
 * read. Returns the number of items copied.
 */
function migrateFromV4(doc) {
  let annotations = doc.getMap('annotations')
  if (annotations.size === 0) return 0
  let copied = 0

  annotations.forEach((itemMap, identity) => {
    if (!(itemMap instanceof Y.Map)) return
    _ensureItem(doc, identity)
    let checksums = itemMap.get('checksums')
    if (typeof checksums === 'string' && checksums) {
      setItemChecksums(doc, identity, checksums.split(',').filter(Boolean))
    }

    for (let section of MAP_SECTIONS) {
      let m = itemMap.get(section)
      if (!(m instanceof Y.Map)) continue
      m.forEach((v, rest) => {
        // v4 could hold mixed-case tag keys; v5 keys are lowercase
        if (section === 'tags') rest = rest.toLowerCase()
        if (_get(doc, section, identity, rest) === undefined) _set(doc, section, identity, rest, v)
      })
    }
    for (let section of ['metadata', 'selectionMeta']) {
      let arr = itemMap.get(section)
      if (!(arr instanceof Y.Array)) continue
      for (let [rest, e] of new YKeyValue(arr).map) {
        if (_get(doc, section, identity, rest) === undefined) _set(doc, section, identity, rest, e.val ?? e)
      }
    }
    let photos = itemMap.get('photos')
    if (photos instanceof Y.Map) {
      photos.forEach((photoMap, checksum) => {
        let arr = photoMap instanceof Y.Map ? photoMap.get('metadata') : null
        if (!(arr instanceof Y.Array)) return
        for (let [prop, e] of new YKeyValue(arr).map) {
          let rest = `${checksum}${SEP}${prop}`
          if (_get(doc, 'photoMetadata', identity, rest) === undefined) {
            _set(doc, 'photoMetadata', identity, rest, e.val ?? e)
          }
        }
      })
    }
    let aliases = itemMap.get('aliases')
    if (aliases instanceof Y.Map) {
      aliases.forEach((v, oldIdentity) => {
        if (!_map(doc, 'aliases').has(oldIdentity)) {
          _map(doc, 'aliases').set(oldIdentity, typeof v === 'string' ? { target: v, createdAt: Date.now() } : v)
        }
      })
    }
    copied++
  })
  return copied
}

// --- Snapshots --------------------------------------------------------------------------

/** Everything the room holds about one item, as plain JSON (v4 shape). */
function getItemSnapshot(doc, identity) {
  if (!_map(doc, 'items').has(identity)) return null
  let photos = {}
  for (let checksum of getAllPhotoChecksums(doc, identity)) {
    photos[checksum] = { metadata: getPhotoMetadata(doc, identity, checksum) }
  }
  let aliases = {}
  _map(doc, 'aliases').forEach((v, k) => {
    if ((typeof v === 'string' ? v : v.target) === identity) aliases[k] = v
  })
  return {
    metadata: getMetadata(doc, identity),
    tags: _entries(doc, 'tags', identity),
    notes: getNotes(doc, identity),
    photos,
    selections: getSelections(doc, identity),
    selectionMeta: _entries(doc, 'selectionMeta', identity),
    selectionNotes: getAllSelectionNotes(doc, identity),
    transcriptions: getTranscriptions(doc, identity),
    lists: getLists(doc, identity),
    uuids: getUUIDRegistry(doc, identity),
    aliases
  }
}

function _stripMeta(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    let { pushSeq, author, ts, ...content } = v
    return content
  }
  return v
}

/** Every item's snapshot, without authorship fields (for comparing rooms). */
function getSnapshot(doc) {
  let out = {}
  for (let identity of getIdentities(doc)) {
    let snap = getItemSnapshot(doc, identity)
    for (let section of Object.keys(snap)) {
      if (section === 'photos') {
        for (let p of Object.values(snap.photos)) {
          p.metadata = Object.fromEntries(Object.entries(p.metadata).map(([k, v]) => [k, _stripMeta(v)]))
        }
      } else {
        snap[section] = Object.fromEntries(Object.entries(snap[section]).map(([k, v]) => [k, _stripMeta(v)]))
      }
    }
    out[identity] = snap
  }
  return out
}

// --- Room config -------------------------------------------------------------------------

function setRoomConfig(doc, config) {
  let room = doc.getMap('room')
  for (let [key, value] of Object.entries(config)) room.set(key, value)
}

function getRoomConfig(doc) {
  return doc.getMap('room').toJSON()
}

// --- Templates (keyed by URI) ---------------------------------------------------------------

function getTemplateSchema(doc) {
  return doc.getMap('schema').toJSON()
}

function setTemplateSchema(doc, uri, templateDef, author, pushSeq) {
  doc.getMap('schema').set(uri, {
    uri,
    name: templateDef.name,
    type: templateDef.type,
    version: templateDef.version || null,
    creator: templateDef.creator || null,
    description: templateDef.description || null,
    isProtected: !!templateDef.isProtected,
    domain: templateDef.domain || null,
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
  doc.getMap('schema').set(uri, { uri, deleted: true, author, pushSeq: pushSeq || 0, deletedAt: Date.now() })
}

// --- List tree (keyed by list UUID) -------------------------------------------------------------

function getListHierarchy(doc) {
  return doc.getMap('projectLists').toJSON()
}

function setListHierarchyEntry(doc, uuid, entry, author, pushSeq) {
  doc.getMap('projectLists').set(uuid, {
    uuid,
    name: entry.name,
    parent: entry.parent || null,
    children: entry.children || [],
    author,
    pushSeq: pushSeq || 0
  })
}

function removeListHierarchyEntry(doc, uuid, author, pushSeq) {
  doc.getMap('projectLists').set(uuid, { uuid, deleted: true, author, pushSeq: pushSeq || 0, deletedAt: Date.now() })
}

// --- Observers ---------------------------------------------------------------------------------

function _observeKeys(map, callback, skipOrigin) {
  let handler = (event, transaction) => {
    if (skipOrigin != null && transaction.origin === skipOrigin) return
    let changed = []
    event.changes.keys.forEach((change, key) => changed.push({ key, action: change.action }))
    if (changed.length > 0) callback(changed)
  }
  map.observe(handler)
  return () => map.unobserve(handler)
}

function observeSchema(doc, callback, skipOrigin) {
  return _observeKeys(doc.getMap('schema'), changes =>
    callback(changes.map(c => ({ uri: c.key, action: c.action }))), skipOrigin)
}

function observeProjectLists(doc, callback, skipOrigin) {
  return _observeKeys(doc.getMap('projectLists'), changes =>
    callback(changes.map(c => ({ uuid: c.key, action: c.action }))), skipOrigin)
}

/**
 * Call `callback([{ identity, type }])` when any item's annotations change,
 * except in transactions whose origin is `skipOrigin` (our own writes).
 */
function observeAnnotationsDeep(doc, callback, skipOrigin) {
  let offs = []
  for (let section of ['items', ...MAP_SECTIONS]) {
    offs.push(_observeKeys(_map(doc, section), changes =>
      callback(changes.map(c => ({
        identity: section === 'items' ? c.key : split(c.key)[0], type: section
      }))), skipOrigin))
  }
  for (let section of KV_SECTIONS) {
    let arr = doc.getArray(section)
    let handler = (event, transaction) => {
      if (skipOrigin != null && transaction.origin === skipOrigin) return
      let ids = new Set()
      event.changes.added.forEach(item => {
        for (let v of item.content.getContent()) if (v && v.key) ids.add(split(v.key)[0])
      })
      // A deletion alone (a value replaced) always comes with an addition.
      if (ids.size > 0) callback([...ids].map(identity => ({ identity, type: section })))
    }
    arr.observe(handler)
    offs.push(() => arr.unobserve(handler))
  }
  return () => offs.forEach(off => off())
}

module.exports = {
  SCHEMA_VERSION,
  ITEM_SECTIONS,
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
  // Photo metadata
  setPhotoMetadata,
  getPhotoMetadata,
  getAllPhotoChecksums,
  // Selections
  setSelection,
  removeSelection,
  getSelections,
  getActiveSelections,
  setSelectionMeta,
  getSelectionMeta,
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
  // List membership
  setListMembership,
  removeListMembership,
  getLists,
  getActiveLists,
  // Registry, aliases, items
  getUUIDRegistry,
  setAlias,
  resolveAlias,
  setItemChecksums,
  getItemChecksums,
  getIdentities,
  // Version, migration, maintenance
  checkSchemaVersion,
  setSchemaVersion,
  migrateFromV4,
  purgeTombstones,
  // Snapshots
  getSnapshot,
  getItemSnapshot,
  // Room
  setRoomConfig,
  getRoomConfig,
  // Templates and list tree
  getTemplateSchema,
  setTemplateSchema,
  removeTemplateSchema,
  getListHierarchy,
  setListHierarchyEntry,
  removeListHierarchyEntry,
  // Observers
  observeAnnotationsDeep,
  observeSchema,
  observeProjectLists
}
