'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const Y = require('yjs')

/**
 * SyncVault v4 — state tracker for the sync engine.
 *
 * Prevents redundant work by tracking:
 *   - CRDT snapshot hash: skip apply phase when nothing changed
 *   - Backup content hash: skip saving identical backups
 *   - Per-item push hashes: skip re-pushing unchanged items
 *   - Applied key Sets: unified dedup across cycles
 *   - Note/transcription/selection/list UUID mappings: stable identity
 *   - Push sequence counter: monotonic per-author counter (replaces wall-clock ts)
 *   - Logic-based conflict tracking: "did I edit this since last push?"
 *   - Dismissed keys: locally-dismissed remote deletions
 *
 * Size-bounded: all collections have configurable max sizes with LRU-style
 * eviction to prevent unbounded memory growth.
 */

const MAX_PUSHED_ITEMS = 5000
const MAX_APPLIED_KEYS = 50000
const MAX_ID_MAPPINGS = 50000

class SyncVault {
  constructor() {
    // CRDT-level state
    this.lastCRDTHash = null
    this.lastBackupHash = null

    // Per-identity push state
    this.pushedHashes = new Map()  // identity -> content hash

    // Applied key tracking (flat Sets — keys are globally unique UUIDs)
    this.appliedNoteKeys = new Set()
    this.appliedSelectionKeys = new Set()
    this.appliedTranscriptionKeys = new Set()

    // Stable identity mappings
    // Notes: local resource ID <-> CRDT UUID
    this.noteIdToCrdtKey = new Map()
    this.crdtKeyToNoteId = new Map()
    // Transcriptions
    this.txIdToCrdtKey = new Map()
    this.crdtKeyToTxId = new Map()
    // Selections (v4)
    this.selIdToCrdtKey = new Map()
    this.crdtKeyToSelId = new Map()
    // Lists (v4): listName <-> UUID
    this.listNameToCrdtKey = new Map()
    this.crdtKeyToListName = new Map()

    // Annotation count cache — avoids serializing whole doc
    this._cachedAnnotationCount = 0

    // Persisted failed note keys — tracks keys that permanently failed
    this.failedNoteKeys = new Map()  // key -> retryCount

    // Dirty flag — set when applied keys change, cleared after persist
    this._dirty = false

    // v4: Push sequence counter (monotonic per-author)
    this.pushSeq = 0

    // v4: Logic-based conflict tracking
    // Records value hash of what we last pushed per field
    // Intentionally NOT persisted — rebuilt on first push cycle
    this.pushedFieldValues = new Map()  // `${identity}:${field}` -> value hash

    // v4: Locally-dismissed remote deletions
    this.dismissedKeys = new Set()
  }

  markDirty() {
    this._dirty = true
  }

  get isDirty() {
    return this._dirty
  }

  // --- Push sequence (v4) ---

  /**
   * Get next monotonic push sequence number.
   */
  nextPushSeq() {
    return ++this.pushSeq
  }

  // --- Logic-based conflict checks (v4) ---

  /**
   * Check if a field has been locally edited since last push.
   * Returns true if we should push (field has changed), false if remote wins.
   */
  hasLocalEdit(identity, field, currentValueHash) {
    let key = `${identity}:${field}`
    let lastPushed = this.pushedFieldValues.get(key)
    if (!lastPushed) return true  // Never pushed — assume local edit
    return lastPushed !== currentValueHash
  }

  /**
   * Record that we pushed a field value.
   */
  markFieldPushed(identity, field, valueHash) {
    let key = `${identity}:${field}`
    this.pushedFieldValues.set(key, valueHash)
  }

  // --- CRDT change detection ---

  /**
   * Check if the CRDT has changed since last check using its state vector.
   */
  hasCRDTChanged(doc) {
    let sv
    if (doc instanceof Uint8Array) {
      sv = doc
    } else if (doc && typeof doc.store !== 'undefined') {
      sv = Y.encodeStateVector(doc)
    } else {
      let hash = this.hashObject(doc)
      if (hash === this.lastCRDTHash) return false
      this.lastCRDTHash = hash
      return true
    }
    let hash = crypto
      .createHash('sha256').update(Buffer.from(sv)).digest('hex').slice(0, 16)
    if (hash === this.lastCRDTHash) return false
    this.lastCRDTHash = hash
    return true
  }

  shouldBackup(itemSnapshots) {
    let hash = this.hashObject(itemSnapshots)
    if (hash === this.lastBackupHash) return false
    this.lastBackupHash = hash
    return true
  }

  hasItemChanged(identity, item) {
    let hash = this._fastHash(item)
    let last = this.pushedHashes.get(identity)
    return { changed: last !== hash, hash }
  }

  markPushed(identity, hash) {
    this._evictIfNeeded(this.pushedHashes, MAX_PUSHED_ITEMS)
    this.pushedHashes.set(identity, hash)
  }

  _fastHash(obj) {
    let str = JSON.stringify(obj)
    let hash = 0x811c9dc5
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i)
      hash = (hash * 0x01000193) >>> 0
    }
    return hash.toString(36)
  }

  // --- Stable note identity ---

  getNoteKey(localNoteId, fallbackKey) {
    let id = String(localNoteId)
    let existing = this.noteIdToCrdtKey.get(id)
    if (existing) return existing

    this._evictIfNeeded(this.noteIdToCrdtKey, MAX_ID_MAPPINGS)
    this.noteIdToCrdtKey.set(id, fallbackKey)
    this.crdtKeyToNoteId.set(fallbackKey, id)
    this._dirty = true
    return fallbackKey
  }

  mapAppliedNote(crdtKey, localNoteId) {
    let id = String(localNoteId)
    this._evictIfNeeded(this.crdtKeyToNoteId, MAX_ID_MAPPINGS)
    this.crdtKeyToNoteId.set(crdtKey, id)
    this.noteIdToCrdtKey.set(id, crdtKey)
    this._dirty = true
  }

  getLocalNoteId(crdtKey) {
    return this.crdtKeyToNoteId.get(crdtKey) || null
  }

  // --- Stable transcription identity ---

  getTxKey(localTxId, fallbackKey) {
    let id = String(localTxId)
    let existing = this.txIdToCrdtKey.get(id)
    if (existing) return existing

    this._evictIfNeeded(this.txIdToCrdtKey, MAX_ID_MAPPINGS)
    this.txIdToCrdtKey.set(id, fallbackKey)
    this.crdtKeyToTxId.set(fallbackKey, id)
    return fallbackKey
  }

  mapAppliedTranscription(crdtKey, localTxId) {
    let id = String(localTxId)
    this._evictIfNeeded(this.crdtKeyToTxId, MAX_ID_MAPPINGS)
    this.crdtKeyToTxId.set(crdtKey, id)
    this.txIdToCrdtKey.set(id, crdtKey)
  }

  getLocalTxId(crdtKey) {
    return this.crdtKeyToTxId.get(crdtKey) || null
  }

  // --- Stable selection identity (v4) ---

  getSelectionKey(localSelId, fallbackKey) {
    let id = String(localSelId)
    let existing = this.selIdToCrdtKey.get(id)
    if (existing) return existing

    this._evictIfNeeded(this.selIdToCrdtKey, MAX_ID_MAPPINGS)
    this.selIdToCrdtKey.set(id, fallbackKey)
    this.crdtKeyToSelId.set(fallbackKey, id)
    this._dirty = true
    return fallbackKey
  }

  mapAppliedSelection(uuid, localSelId) {
    let id = String(localSelId)
    this._evictIfNeeded(this.crdtKeyToSelId, MAX_ID_MAPPINGS)
    this.crdtKeyToSelId.set(uuid, id)
    this.selIdToCrdtKey.set(id, uuid)
    this._dirty = true
  }

  getLocalSelId(uuid) {
    return this.crdtKeyToSelId.get(uuid) || null
  }

  // --- Stable list identity (v4) ---

  getListKey(listName) {
    return this.listNameToCrdtKey.get(listName) || null
  }

  mapAppliedList(uuid, listName) {
    this._evictIfNeeded(this.listNameToCrdtKey, MAX_ID_MAPPINGS)
    this.listNameToCrdtKey.set(listName, uuid)
    this.crdtKeyToListName.set(uuid, listName)
    this._dirty = true
  }

  getLocalListName(uuid) {
    return this.crdtKeyToListName.get(uuid) || null
  }

  // --- CRDT-fallback UUID recovery (v4) ---

  recoverFromCRDT(doc, identity, schema) {
    let registry = schema.getUUIDRegistry(doc, identity)
    let recovered = 0
    for (let [uuid, entry] of Object.entries(registry)) {
      if (!entry || !entry.type) continue
      switch (entry.type) {
        case 'note':
          if (entry.localRef && !this.crdtKeyToNoteId.has(uuid)) {
            // Can't recover exact local ID from CRDT — but mark the key as known
            this.appliedNoteKeys.add(uuid)
            recovered++
          }
          break
        case 'selection':
          if (!this.crdtKeyToSelId.has(uuid)) {
            this.appliedSelectionKeys.add(uuid)
            recovered++
          }
          break
        case 'transcription':
          if (!this.crdtKeyToTxId.has(uuid)) {
            this.appliedTranscriptionKeys.add(uuid)
            recovered++
          }
          break
        case 'list':
          if (entry.localRef && !this.crdtKeyToListName.has(uuid)) {
            this.mapAppliedList(uuid, entry.localRef)
            recovered++
          }
          break
      }
    }
    return recovered
  }

  // --- Annotation count cache ---

  updateAnnotationCount(count) {
    this._cachedAnnotationCount = count
  }

  get annotationCount() {
    return this._cachedAnnotationCount
  }

  // --- Hashing ---

  hashObject(obj) {
    let str = this._sortedStringify(obj)
    return crypto
      .createHash('sha256')
      .update(str)
      .digest('hex')
      .slice(0, 16)
  }

  _sortedStringify(obj) {
    return JSON.stringify(obj, (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        let sorted = {}
        for (let k of Object.keys(value).sort()) {
          sorted[k] = value[k]
        }
        return sorted
      }
      return value
    })
  }

  // --- Pruning ---

  _evictIfNeeded(map, maxSize) {
    if (map.size < maxSize) return
    let toRemove = Math.floor(maxSize * 0.2)
    let iter = map.keys()
    for (let i = 0; i < toRemove; i++) {
      let next = iter.next()
      if (next.done) break
      map.delete(next.value)
    }
  }

  pruneAppliedKeys() {
    this._truncateSetInPlace(this.appliedNoteKeys, MAX_APPLIED_KEYS)
    this._truncateSetInPlace(this.appliedSelectionKeys, MAX_APPLIED_KEYS)
    this._truncateSetInPlace(this.appliedTranscriptionKeys, MAX_APPLIED_KEYS)
  }

  _truncateSetInPlace(set, maxSize) {
    if (set.size <= maxSize) return
    let toRemove = set.size - maxSize
    let iter = set.values()
    for (let i = 0; i < toRemove; i++) {
      let next = iter.next()
      if (next.done) break
      set.delete(next.value)
    }
  }

  // --- Persistence ---

  async persistToFile(room) {
    if (!room) return
    try {
      let dir = path.join(os.homedir(), '.troparcel', 'vault')
      await fs.promises.mkdir(dir, { recursive: true })
      let file = path.join(dir, this._sanitizeRoom(room) + '.json')
      let tmpFile = file + '.tmp'
      let data = {
        version: 4,
        timestamp: new Date().toISOString(),
        pushSeq: this.pushSeq,
        appliedNoteKeys: Array.from(this.appliedNoteKeys),
        appliedSelectionKeys: Array.from(this.appliedSelectionKeys),
        appliedTranscriptionKeys: Array.from(this.appliedTranscriptionKeys),
        failedNoteKeys: Array.from(this.failedNoteKeys.entries()).map(([k, c]) => ({ key: k, count: c })),
        noteMappings: Array.from(this.crdtKeyToNoteId.entries()).map(([k, v]) => [k, v]),
        txMappings: Array.from(this.crdtKeyToTxId.entries()).map(([k, v]) => [k, v]),
        selMappings: Array.from(this.crdtKeyToSelId.entries()).map(([k, v]) => [k, v]),
        listMappings: Array.from(this.crdtKeyToListName.entries()).map(([k, v]) => [k, v]),
        dismissedKeys: Array.from(this.dismissedKeys)
        // pushedFieldValues intentionally NOT persisted — rebuilt on first push cycle
      }
      await fs.promises.writeFile(tmpFile, JSON.stringify(data))
      await fs.promises.rename(tmpFile, file)
      this._dirty = false
    } catch (err) {
      throw err
    }
  }

  loadFromFile(room) {
    if (!room) return false
    try {
      let dir = path.join(os.homedir(), '.troparcel', 'vault')
      let file = path.join(dir, this._sanitizeRoom(room) + '.json')
      let raw = fs.readFileSync(file, 'utf8')
      let data = JSON.parse(raw)
      // Accept all vault versions (1-4) — missing fields default to empty
      if (data.version !== 1 && data.version !== 2 && data.version !== 3 && data.version !== 4) return false

      if (Array.isArray(data.appliedNoteKeys)) {
        for (let k of data.appliedNoteKeys) this.appliedNoteKeys.add(k)
      }
      if (Array.isArray(data.appliedSelectionKeys)) {
        for (let k of data.appliedSelectionKeys) this.appliedSelectionKeys.add(k)
      }
      if (Array.isArray(data.appliedTranscriptionKeys)) {
        for (let k of data.appliedTranscriptionKeys) this.appliedTranscriptionKeys.add(k)
      }
      // Restore failed note keys
      if (Array.isArray(data.failedNoteKeys)) {
        for (let k of data.failedNoteKeys) {
          if (typeof k === 'string') {
            this.failedNoteKeys.set(k, 3)
          } else if (Array.isArray(k)) {
            this.failedNoteKeys.set(k[0], k[1] || 3)
          } else if (k && k.key) {
            this.failedNoteKeys.set(k.key, k.count || 3)
          }
        }
      }
      // Restore note mappings
      if (Array.isArray(data.noteMappings)) {
        for (let [crdtKey, noteId] of data.noteMappings) {
          this.crdtKeyToNoteId.set(crdtKey, String(noteId))
          this.noteIdToCrdtKey.set(String(noteId), crdtKey)
        }
      }
      // Restore transcription mappings
      if (Array.isArray(data.txMappings)) {
        for (let [crdtKey, txId] of data.txMappings) {
          this.crdtKeyToTxId.set(crdtKey, String(txId))
          this.txIdToCrdtKey.set(String(txId), crdtKey)
        }
      }
      // v4: Restore selection mappings
      if (Array.isArray(data.selMappings)) {
        for (let [uuid, selId] of data.selMappings) {
          this.crdtKeyToSelId.set(uuid, String(selId))
          this.selIdToCrdtKey.set(String(selId), uuid)
        }
      }
      // v4: Restore list mappings
      if (Array.isArray(data.listMappings)) {
        for (let [uuid, listName] of data.listMappings) {
          this.crdtKeyToListName.set(uuid, listName)
          this.listNameToCrdtKey.set(listName, uuid)
        }
      }
      // v4: Restore push sequence
      if (typeof data.pushSeq === 'number') {
        this.pushSeq = data.pushSeq
      }
      // v4: Restore dismissed keys
      if (Array.isArray(data.dismissedKeys)) {
        for (let k of data.dismissedKeys) this.dismissedKeys.add(k)
      }
      return true
    } catch {
      return false
    }
  }

  _sanitizeRoom(name) {
    return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128) || 'default'
  }

  clear() {
    this.lastCRDTHash = null
    this.lastBackupHash = null
    this.pushedHashes.clear()
    this.appliedNoteKeys.clear()
    this.appliedSelectionKeys.clear()
    this.appliedTranscriptionKeys.clear()
    this.noteIdToCrdtKey.clear()
    this.crdtKeyToNoteId.clear()
    this.txIdToCrdtKey.clear()
    this.crdtKeyToTxId.clear()
    this.selIdToCrdtKey.clear()
    this.crdtKeyToSelId.clear()
    this.listNameToCrdtKey.clear()
    this.crdtKeyToListName.clear()
    this._cachedAnnotationCount = 0
    this.failedNoteKeys.clear()
    this.pushedFieldValues.clear()
    this.dismissedKeys.clear()
    this.pushSeq = 0
  }
}

module.exports = { SyncVault }
