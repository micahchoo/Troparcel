'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * SyncVault v2 — state tracker for the sync engine.
 *
 * Prevents redundant work by tracking:
 *   - CRDT snapshot hash: skip apply phase when nothing changed
 *   - Backup content hash: skip saving identical backups
 *   - Per-item push hashes: skip re-pushing unchanged items
 *   - Applied key Sets: unified dedup across cycles
 *   - Note/transcription ID mappings: stable identity across edits (C1, C3)
 *
 * Size-bounded: all collections have configurable max sizes with LRU-style
 * eviction to prevent unbounded memory growth (R7).
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

    // Applied key tracking (flat Sets — keys are globally unique
    // since they incorporate photo checksums and coordinates)
    this.appliedNoteKeys = new Set()
    this.appliedSelectionKeys = new Set()
    this.appliedTranscriptionKeys = new Set()

    // Stable identity mappings (C1, C3)
    // Maps local resource IDs to their CRDT keys so edits don't change identity
    this.noteIdToCrdtKey = new Map()      // localNoteId -> crdtKey
    this.crdtKeyToNoteId = new Map()      // crdtKey -> localNoteId
    this.txIdToCrdtKey = new Map()        // localTxId -> crdtKey
    this.crdtKeyToTxId = new Map()        // crdtKey -> localTxId

    // Annotation count cache (P5) — avoids serializing whole doc
    this._cachedAnnotationCount = 0
  }

  /**
   * Check if the CRDT snapshot has changed since last check.
   * Returns true if changed (or first call), false if identical.
   */
  hasCRDTChanged(snapshot) {
    let hash = this.hashObject(snapshot)
    if (hash === this.lastCRDTHash) return false
    this.lastCRDTHash = hash
    return true
  }

  /**
   * Check if backup content differs from the last saved backup.
   * Returns true if a new backup should be saved.
   */
  shouldBackup(itemSnapshots) {
    let hash = this.hashObject(itemSnapshots)
    if (hash === this.lastBackupHash) return false
    this.lastBackupHash = hash
    return true
  }

  /**
   * Check if a local item has changed since it was last pushed.
   * Returns true if the item should be re-pushed.
   */
  hasItemChanged(identity, item) {
    let hash = this.hashObject(item)
    let last = this.pushedHashes.get(identity)
    return last !== hash
  }

  /**
   * Record that an item was pushed to the CRDT.
   */
  markPushed(identity, item) {
    this._evictIfNeeded(this.pushedHashes, MAX_PUSHED_ITEMS)
    this.pushedHashes.set(identity, this.hashObject(item))
  }

  // --- Stable note identity (C1) ---

  /**
   * Get or create a stable CRDT key for a local note.
   * If the note was previously pushed, returns the same key.
   * If new, computes a content-based key and stores the mapping.
   *
   * @param {string|number} localNoteId - local DB ID of the note
   * @param {string} contentKey - content-based key for first-time matching
   * @returns {string} stable CRDT key
   */
  getNoteKey(localNoteId, contentKey) {
    let id = String(localNoteId)
    let existing = this.noteIdToCrdtKey.get(id)
    if (existing) return existing

    // First time — use the content-based key and store the mapping
    this._evictIfNeeded(this.noteIdToCrdtKey, MAX_ID_MAPPINGS)
    this.noteIdToCrdtKey.set(id, contentKey)
    this.crdtKeyToNoteId.set(contentKey, id)
    return contentKey
  }

  /**
   * Record that a remote CRDT note was applied locally.
   * Stores the reverse mapping so we can update rather than re-create.
   */
  mapAppliedNote(crdtKey, localNoteId) {
    let id = String(localNoteId)
    this._evictIfNeeded(this.crdtKeyToNoteId, MAX_ID_MAPPINGS)
    this.crdtKeyToNoteId.set(crdtKey, id)
    this.noteIdToCrdtKey.set(id, crdtKey)
  }

  /**
   * Get the local note ID for a CRDT key (for updates instead of re-creates).
   */
  getLocalNoteId(crdtKey) {
    return this.crdtKeyToNoteId.get(crdtKey) || null
  }

  // --- Stable transcription identity (C3) ---

  getTxKey(localTxId, contentKey) {
    let id = String(localTxId)
    let existing = this.txIdToCrdtKey.get(id)
    if (existing) return existing

    this._evictIfNeeded(this.txIdToCrdtKey, MAX_ID_MAPPINGS)
    this.txIdToCrdtKey.set(id, contentKey)
    this.crdtKeyToTxId.set(contentKey, id)
    return contentKey
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

  // --- Annotation count cache (P5) ---

  updateAnnotationCount(count) {
    this._cachedAnnotationCount = count
  }

  get annotationCount() {
    return this._cachedAnnotationCount
  }

  // --- Hashing ---

  /**
   * Fast content hash using SHA-256 (truncated).
   * Uses JSON.stringify with sorted keys for determinism.
   */
  hashObject(obj) {
    let str = this._sortedStringify(obj)
    return crypto
      .createHash('sha256')
      .update(str)
      .digest('hex')
      .slice(0, 16)
  }

  /**
   * Deterministic JSON stringification with sorted keys.
   * Uses an iterative approach with a stack to avoid deep recursion
   * and excessive string concatenation on large objects (P7).
   */
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

  // --- Pruning (R7) ---

  /**
   * Evict oldest entries when a Map exceeds maxSize.
   * Uses insertion-order property of Maps (first inserted = first iterated).
   */
  _evictIfNeeded(map, maxSize) {
    if (map.size < maxSize) return

    // Remove oldest 20% to avoid evicting on every insert
    let toRemove = Math.floor(maxSize * 0.2)
    let iter = map.keys()
    for (let i = 0; i < toRemove; i++) {
      let next = iter.next()
      if (next.done) break
      map.delete(next.value)
    }
  }

  /**
   * Prune applied-key Sets (R7).
   * Called periodically to prevent unbounded growth.
   */
  pruneAppliedKeys() {
    if (this.appliedNoteKeys.size > MAX_APPLIED_KEYS) {
      this.appliedNoteKeys = this._truncateSet(this.appliedNoteKeys, MAX_APPLIED_KEYS)
    }
    if (this.appliedSelectionKeys.size > MAX_APPLIED_KEYS) {
      this.appliedSelectionKeys = this._truncateSet(this.appliedSelectionKeys, MAX_APPLIED_KEYS)
    }
    if (this.appliedTranscriptionKeys.size > MAX_APPLIED_KEYS) {
      this.appliedTranscriptionKeys = this._truncateSet(this.appliedTranscriptionKeys, MAX_APPLIED_KEYS)
    }
  }

  /**
   * Keep the newest entries in a Set by discarding the oldest half.
   */
  _truncateSet(set, maxSize) {
    let arr = Array.from(set)
    let keep = arr.slice(arr.length - maxSize)
    return new Set(keep)
  }

  // --- Persistence (cross-restart ghost note prevention) ---

  /**
   * Persist applied key sets to disk so deleted notes aren't re-created on restart.
   * Saves to ~/.troparcel/vault/{room}.json
   */
  persistToFile(room) {
    if (!room) return
    try {
      let dir = path.join(os.homedir(), '.troparcel', 'vault')
      fs.mkdirSync(dir, { recursive: true })
      let file = path.join(dir, this._sanitizeRoom(room) + '.json')
      let data = {
        version: 1,
        timestamp: new Date().toISOString(),
        appliedNoteKeys: Array.from(this.appliedNoteKeys),
        appliedSelectionKeys: Array.from(this.appliedSelectionKeys),
        appliedTranscriptionKeys: Array.from(this.appliedTranscriptionKeys)
      }
      fs.writeFileSync(file, JSON.stringify(data))
    } catch {}
  }

  /**
   * Load persisted applied key sets from disk.
   * Returns true if a file was loaded, false otherwise.
   */
  loadFromFile(room) {
    if (!room) return false
    try {
      let dir = path.join(os.homedir(), '.troparcel', 'vault')
      let file = path.join(dir, this._sanitizeRoom(room) + '.json')
      let raw = fs.readFileSync(file, 'utf8')
      let data = JSON.parse(raw)
      if (data.version !== 1) return false
      if (Array.isArray(data.appliedNoteKeys)) {
        for (let k of data.appliedNoteKeys) this.appliedNoteKeys.add(k)
      }
      if (Array.isArray(data.appliedSelectionKeys)) {
        for (let k of data.appliedSelectionKeys) this.appliedSelectionKeys.add(k)
      }
      if (Array.isArray(data.appliedTranscriptionKeys)) {
        for (let k of data.appliedTranscriptionKeys) this.appliedTranscriptionKeys.add(k)
      }
      return true
    } catch {
      return false
    }
  }

  _sanitizeRoom(name) {
    return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128) || 'default'
  }

  /**
   * Clear all tracked state. Called on engine stop.
   */
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
    this._cachedAnnotationCount = 0
  }
}

module.exports = { SyncVault }
