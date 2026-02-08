'use strict'

const Y = require('yjs')

/**
 * CRDT Schema — defines how collaborative annotations are structured
 * inside a Yjs document.
 *
 * Document layout:
 *
 *   Y.Doc
 *   ├── Y.Map "annotations"           keyed by item identity hash
 *   │   └── Y.Map per item
 *   │       ├── Y.Map "metadata"      keyed by property URI
 *   │       │   └── plain object { text, type, language, author, ts }
 *   │       ├── Y.Array "tags"        [{ name, color, author, ts }]
 *   │       ├── Y.Array "notes"       [{ text, html, language, author, ts, noteId }]
 *   │       └── Y.Array "selections"  [{ x, y, w, h, author, ts }]
 *   ├── Y.Map "users"                 keyed by clientId
 *   │   └── { userId, name, joinedAt, lastSeen }
 *   └── Y.Map "room"                  room-level config
 *       └── { name, created, version }
 *
 * Per-property metadata uses Y.Map so two users editing different
 * fields merge cleanly. Tags and notes use Y.Array so additions
 * from multiple users are preserved. Individual array entries are
 * opaque objects (last-writer-wins within a single entry).
 */

/**
 * Get or create the annotations map for an item.
 * Lazily initializes the nested Y.Map structure.
 *
 * @param {Y.Doc} doc
 * @param {string} identity - item identity hash
 * @returns {{ metadata: Y.Map, tags: Y.Array, notes: Y.Array, selections: Y.Array }}
 */
function getItemAnnotations(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)

  if (!itemMap) {
    itemMap = new Y.Map()
    itemMap.set('metadata', new Y.Map())
    itemMap.set('tags', new Y.Array())
    itemMap.set('notes', new Y.Array())
    itemMap.set('selections', new Y.Array())
    annotations.set(identity, itemMap)
  }

  return {
    metadata: itemMap.get('metadata'),
    tags: itemMap.get('tags'),
    notes: itemMap.get('notes'),
    selections: itemMap.get('selections')
  }
}

/**
 * Set a metadata property on an item.
 * Each property is stored individually in the metadata Y.Map,
 * allowing concurrent edits to different fields to merge.
 */
function setMetadata(doc, identity, propertyUri, value, author) {
  let { metadata } = getItemAnnotations(doc, identity)
  metadata.set(propertyUri, {
    text: value.text || '',
    type: value.type || 'http://www.w3.org/2001/XMLSchema#string',
    language: value.language || null,
    author,
    ts: Date.now()
  })
}

/**
 * Get all metadata for an item as a plain object.
 * Returns { [propertyUri]: { text, type, language, author, ts } }
 */
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

/**
 * Add a tag to an item. Skips if a tag with the same name already exists.
 */
function addTag(doc, identity, tag, author) {
  let { tags } = getItemAnnotations(doc, identity)

  // Deduplicate by name
  let existing = tags.toArray()
  if (existing.some(t => t.name === tag.name)) return

  tags.push([{
    name: tag.name,
    color: tag.color || null,
    author,
    ts: Date.now()
  }])
}

/**
 * Get all tags for an item.
 */
function getTags(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return []

  let tags = itemMap.get('tags')
  return tags ? tags.toArray() : []
}

/**
 * Add a note to an item. Uses a noteId for deduplication.
 */
function addNote(doc, identity, note, author) {
  let { notes } = getItemAnnotations(doc, identity)

  // Deduplicate by noteId or text content
  let existing = notes.toArray()
  if (note.noteId && existing.some(n => n.noteId === note.noteId)) {
    // Update existing note in place
    let idx = existing.findIndex(n => n.noteId === note.noteId)
    if (idx >= 0) {
      notes.delete(idx, 1)
      notes.insert(idx, [{
        noteId: note.noteId,
        text: note.text || '',
        html: note.html || '',
        language: note.language || null,
        photo: note.photo || null,
        selection: note.selection || null,
        author,
        ts: Date.now()
      }])
    }
    return
  }

  notes.push([{
    noteId: note.noteId || `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: note.text || '',
    html: note.html || '',
    language: note.language || null,
    photo: note.photo || null,
    selection: note.selection || null,
    author,
    ts: Date.now()
  }])
}

/**
 * Get all notes for an item.
 */
function getNotes(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return []

  let notes = itemMap.get('notes')
  return notes ? notes.toArray() : []
}

/**
 * Add a selection annotation to an item.
 */
function addSelection(doc, identity, selection, author) {
  let { selections } = getItemAnnotations(doc, identity)

  // Deduplicate by selectionId
  let existing = selections.toArray()
  if (selection.selectionId && existing.some(s => s.selectionId === selection.selectionId)) {
    return
  }

  selections.push([{
    selectionId: selection.selectionId || `sel-${Date.now()}`,
    x: selection.x,
    y: selection.y,
    width: selection.width,
    height: selection.height,
    photo: selection.photo || null,
    author,
    ts: Date.now()
  }])
}

/**
 * Get all selections for an item.
 */
function getSelections(doc, identity) {
  let annotations = doc.getMap('annotations')
  let itemMap = annotations.get(identity)
  if (!itemMap) return []

  let selections = itemMap.get('selections')
  return selections ? selections.toArray() : []
}

/**
 * Get a snapshot of all annotations in the document.
 * Returns { [identity]: { metadata, tags, notes, selections } }
 */
function getSnapshot(doc) {
  let annotations = doc.getMap('annotations')
  let result = {}

  annotations.forEach((itemMap, identity) => {
    let metadata = itemMap.get('metadata')
    let tags = itemMap.get('tags')
    let notes = itemMap.get('notes')
    let selections = itemMap.get('selections')

    result[identity] = {
      metadata: metadata ? (() => {
        let m = {}
        metadata.forEach((v, k) => { m[k] = v })
        return m
      })() : {},
      tags: tags ? tags.toArray() : [],
      notes: notes ? notes.toArray() : [],
      selections: selections ? selections.toArray() : []
    }
  })

  return result
}

/**
 * Register the local user in the users map.
 */
function registerUser(doc, clientId, userId) {
  let users = doc.getMap('users')
  users.set(String(clientId), {
    userId: userId || `user-${clientId}`,
    name: userId || `user-${clientId}`,
    joinedAt: Date.now(),
    lastSeen: Date.now()
  })
}

/**
 * Update the local user's lastSeen timestamp.
 */
function heartbeat(doc, clientId) {
  let users = doc.getMap('users')
  let user = users.get(String(clientId))
  if (user) {
    users.set(String(clientId), { ...user, lastSeen: Date.now() })
  }
}

/**
 * Get all connected users.
 */
function getUsers(doc) {
  let users = doc.getMap('users')
  let result = []
  users.forEach((user, clientId) => {
    result.push({ clientId, ...user })
  })
  return result
}

/**
 * Set room configuration.
 */
function setRoomConfig(doc, config) {
  let room = doc.getMap('room')
  for (let [key, value] of Object.entries(config)) {
    room.set(key, value)
  }
}

/**
 * Get room configuration.
 */
function getRoomConfig(doc) {
  let room = doc.getMap('room')
  let result = {}
  room.forEach((value, key) => {
    result[key] = value
  })
  return result
}

/**
 * Observe changes to annotations. Calls back with a list of
 * changed item identities whenever any annotation is modified.
 *
 * @param {Y.Doc} doc
 * @param {function(string[])} callback - receives array of changed identity hashes
 * @returns {function} unsubscribe function
 */
function observeAnnotations(doc, callback) {
  let annotations = doc.getMap('annotations')

  let handler = (events) => {
    let changed = []
    events.forEach((event) => {
      // Top-level changes (new items added)
      if (event.target === annotations) {
        event.changes.keys.forEach((change, key) => {
          if (!changed.includes(key)) changed.push(key)
        })
      }
    })
    if (changed.length > 0) callback(changed)
  }

  annotations.observeDeep(handler)

  return () => annotations.unobserveDeep(handler)
}

/**
 * Observe deep changes at the per-item level.
 * More granular than observeAnnotations — fires for metadata/tag/note changes.
 *
 * @param {Y.Doc} doc
 * @param {function(Array<{identity, type, key}>)} callback
 * @param {*} [skipOrigin] - if set, skip events whose transaction.origin matches this value.
 *                           Used to ignore changes we made ourselves (#13 in audit).
 * @returns {function} unsubscribe function
 */
function observeAnnotationsDeep(doc, callback, skipOrigin) {
  let annotations = doc.getMap('annotations')

  let handler = (events, transaction) => {
    // Skip changes originating from our own transactions
    if (skipOrigin != null && transaction.origin === skipOrigin) return

    let changes = []

    for (let event of events) {
      let path = event.path
      // path[0] is identity, path[1] is 'metadata'|'tags'|'notes'|'selections'
      if (path.length >= 2) {
        let identity = path[0]
        let type = path[1]
        changes.push({ identity, type, event })
      } else if (event.target === annotations) {
        // New item added at top level
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
  getItemAnnotations,
  setMetadata,
  getMetadata,
  addTag,
  getTags,
  addNote,
  getNotes,
  addSelection,
  getSelections,
  getSnapshot,
  registerUser,
  heartbeat,
  getUsers,
  setRoomConfig,
  getRoomConfig,
  observeAnnotations,
  observeAnnotationsDeep
}
