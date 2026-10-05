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


/** Where vaults and backups live unless the `dataDir` option says. */
function defaultRoot() {
  return path.join(os.homedir(), '.troparcel')
}
const MAX_APPLIED_KEYS = 50000
const MAX_ID_MAPPINGS = 50000

class SyncVault {
  constructor() {
    // CRDT-level state
    this.lastCRDTHash = null
    this.lastBackupHash = null

    // Per-identity push state
    this.pushedHashes = new Map()  // identity -> content hash
    this._itemHashes = new WeakMap() // item object -> content hash

    // Applied key tracking (flat Sets — keys are globally unique UUIDs)
    this.appliedNoteKeys = new Set()
    this.appliedSelectionKeys = new Set()
    this.appliedTranscriptionKeys = new Set()
    this.sharedPhotos = new Set() // checksums uploaded to a project room

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

    // Push sequence counter (monotonic per-author).
    // Diagnostic-only: stored in every CRDT entry for ordering/debugging.
    // NOT used for conflict resolution — see hasLocalEdit() below.
    this.pushSeq = 0

    // The three-way merge BASE: per field, the hash of the value this peer
    // last agreed with the room on — what it last pushed OR applied. It is
    // persisted: without it, after a restart every local value looks like
    // a fresh edit and stale local values overwrite the room.
    this.pushedFieldValues = new Map()  // `${identity}:${field}` -> value hash

    // The remote content last applied, per note / transcription key, so an
    // unchanged remote entry is not re-applied and a changed one is.
    this.remoteNoteHashes = new Map()
    this.remoteTxHashes = new Map()

    // Locally-dismissed remote deletions
    // Map<key, pushSeq> — pushSeq-aware: auto-undismiss when author revises content
    this.dismissedKeys = new Map()

    // Track notes that have been retracted (tombstone applied)
    // Prevents re-retraction on every apply cycle
    this.retractedNoteKeys = new Set()

    // Track content hash of last-applied note content per CRDT key.
    // Used to detect local edits before overwriting with remote content.
    this.appliedNoteHashes = new Map()  // crdtKey -> FNV-1a hash of applied HTML

    // Original authors — maps CRDT key -> author userId.
    // Recorded when content is first seen (push or apply).
    // Used for apply-side tombstone validation (defense-in-depth).
    this.originalAuthors = new Map()

    // Template/list push change detection
    this.pushedTemplateHashes = new Map()  // URI -> content hash
    this.pushedListHashes = new Map()      // list name -> content hash

    // List UUID mappings (local list ID <-> CRDT UUID)
    this.listIdToCrdtUuid = new Map()
    this.crdtUuidToListId = new Map()

    // peer userId -> human-readable display name.
    // Populated from awareness state in sync-engine._awarenessHandler.
    // NOT persisted — rediscovered each session via the Yjs awareness
    // handshake (every peer broadcasts its name on join/update).
    // Distinct from `originalAuthors` (which maps CRDT-entry-key -> userId).
    this.userDisplayNames = new Map()
  }

  // --- Display names (from awareness) ---

  /**
   * Register a peer's display name. Called from awareness handler when a
   * peer's user state arrives. Latest write wins (peers may rename mid-session).
   */
  setDisplayName(userId, name) {
    if (!userId || !name) return
    this.userDisplayNames.set(userId, name)
  }

  /**
   * Look up a peer's display name. Returns null if unknown — callers must
   * fall back to the userId itself rather than crashing or rendering 'undefined'.
   */
  getDisplayName(userId) {
    if (!userId) return null
    return this.userDisplayNames.get(userId) || null
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
   *
   * pushSeq is a per-author counter stored in every CRDT entry. It provides
   * diagnostic ordering (which entries were pushed first) and enables future
   * catch-up logic (e.g., "give me everything since pushSeq N").
   *
   * It is NOT used for conflict resolution — that's handled by hasLocalEdit()
   * which compares value hashes to detect whether a field was locally modified.
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
    if (this.pushedFieldValues.get(key) === valueHash) return
    this.pushedFieldValues.set(key, valueHash)
    this._dirty = true
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
    // The adapter returns the same object for an unchanged item, so its
    // hash is computed once.
    let hash = this._itemHashes.get(item)
    if (hash === undefined) {
      hash = this._fastHash(item)
      this._itemHashes.set(item, hash)
    }
    let last = this.pushedHashes.get(identity)
    return { changed: last !== hash, hash }
  }

  /**
   * Record what was pushed for an item. Kept on disk and never capped: a
   * missing entry makes the item look changed, and before 6.1 every start
   * pushed every item again (and a project over 5,000 items, half of them
   * on every cycle).
   */
  markPushed(identity, hash) {
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

  // --- Applied note content tracking (v4) ---

  /**
   * Record the content hash of a note that was just applied (created or updated).
   * Used by hasLocalNoteEdit() to detect user edits between apply cycles.
   */
  markNoteApplied(crdtKey, html) {
    this._evictIfNeeded(this.appliedNoteHashes, MAX_ID_MAPPINGS)
    this.appliedNoteHashes.set(crdtKey, this._fastHash(html))
    this._dirty = true
  }

  /**
   * Check if a note was locally edited since last apply.
   * Returns true if the current local content differs from what we last applied.
   * Returns false (allow overwrite) if never tracked (first apply).
   */
  hasLocalNoteEdit(crdtKey, currentHtml) {
    let lastApplied = this.appliedNoteHashes.get(crdtKey)
    if (!lastApplied) return false  // Never tracked — allow overwrite (first apply)
    return lastApplied !== this._fastHash(currentHtml)
  }

  // --- Original author tracking (v4) ---

  /**
   * Record the original author of a CRDT entry (first write wins).
   * Called during push (when we create entries) and apply (when we first see remote entries).
   */
  trackOriginalAuthor(key, author) {
    if (!key || !author) return
    if (this.originalAuthors.has(key)) return  // First write wins
    this._evictIfNeeded(this.originalAuthors, MAX_ID_MAPPINGS)
    this.originalAuthors.set(key, author)
  }

  /**
   * Get the original author of a CRDT entry.
   * Returns null if unknown (entry was never tracked).
   */
  getOriginalAuthor(key) {
    return this.originalAuthors.get(key) || null
  }

  // --- pushSeq-aware dismissals (v4) ---

  /**
   * Dismiss a key with its current pushSeq.
   * Auto-undismisses when author revises (pushSeq advances past dismissal).
   */
  dismissKey(key, pushSeq) {
    this.dismissedKeys.set(key, pushSeq || 0)
    this._dirty = true
  }

  /**
   * Check if a key is dismissed. Returns false if pushSeq has advanced
   * (author revised the content since dismissal).
   */
  isDismissed(key, currentPushSeq) {
    if (!this.dismissedKeys.has(key)) return false
    let dismissedAt = this.dismissedKeys.get(key)
    return currentPushSeq <= dismissedAt
  }

  /**
   * Check if a note should be skipped (dismissed OR permanently failed).
   * Dismissed keys are NOT counted as failed — different buckets.
   */
  shouldSkipNote(noteKey, currentPushSeq) {
    let prefixedKey = noteKey.startsWith('note:') ? noteKey : noteKey
    if (this.isDismissed(prefixedKey, currentPushSeq)) return true
    // Only check failedNoteKeys if NOT dismissed (dismissed = user choice, not failure)
    if (!this.dismissedKeys.has(prefixedKey) && this.failedNoteKeys.has(noteKey)) {
      return this.failedNoteKeys.get(noteKey) >= 3
    }
    return false
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

  /**
   * Drop the oldest fifth of `map` once it reaches `maxSize`. The id maps
   * come in pairs (local id ↔ CRDT key); evicting one side only would leave
   * the other pointing at nothing, so the partner entries go too.
   */
  _evictIfNeeded(map, maxSize) {
    if (map.size < maxSize) return
    let partner = this._partnerOf(map)
    let toRemove = Math.floor(maxSize * 0.2)
    let iter = map.entries()
    for (let i = 0; i < toRemove; i++) {
      let next = iter.next()
      if (next.done) break
      let [key, value] = next.value
      map.delete(key)
      if (partner && partner.get(value) === key) partner.delete(value)
    }
  }

  _partnerOf(map) {
    let pairs = [
      [this.noteIdToCrdtKey, this.crdtKeyToNoteId],
      [this.txIdToCrdtKey, this.crdtKeyToTxId],
      [this.selIdToCrdtKey, this.crdtKeyToSelId],
      [this.listNameToCrdtKey, this.crdtKeyToListName],
      [this.listIdToCrdtUuid, this.crdtUuidToListId]
    ]
    for (let [a, b] of pairs) {
      if (map === a) return b
      if (map === b) return a
    }
    return null
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

  async persistToFile(room, userId, root = defaultRoot()) {
    if (!room) return
    try {
      let dir = path.join(root, 'vault')
      await fs.promises.mkdir(dir, { recursive: true })
      let suffix = userId ? '_' + this._sanitizeRoom(userId) : ''
      let file = path.join(dir, this._sanitizeRoom(room) + suffix + '.json')
      let tmpFile = file + '.tmp'
      let data = {
        version: 4,
        timestamp: new Date().toISOString(),
        pushSeq: this.pushSeq,
        appliedNoteKeys: Array.from(this.appliedNoteKeys),
        pushedHashes: Array.from(this.pushedHashes),
        appliedSelectionKeys: Array.from(this.appliedSelectionKeys),
        appliedTranscriptionKeys: Array.from(this.appliedTranscriptionKeys),
        sharedPhotos: Array.from(this.sharedPhotos),
        failedNoteKeys: Array.from(this.failedNoteKeys.entries()).map(([k, c]) => ({ key: k, count: c })),
        noteMappings: Array.from(this.crdtKeyToNoteId.entries()).map(([k, v]) => [k, v]),
        txMappings: Array.from(this.crdtKeyToTxId.entries()).map(([k, v]) => [k, v]),
        selMappings: Array.from(this.crdtKeyToSelId.entries()).map(([k, v]) => [k, v]),
        listMappings: Array.from(this.crdtKeyToListName.entries()).map(([k, v]) => [k, v]),
        dismissedKeys: Array.from(this.dismissedKeys.entries()),
        retractedNoteKeys: Array.from(this.retractedNoteKeys),
        appliedNoteHashes: Array.from(this.appliedNoteHashes.entries()),
        originalAuthors: Array.from(this.originalAuthors.entries()),
        // Template/list push hashes + list UUID mappings
        pushedTemplateHashes: Array.from(this.pushedTemplateHashes.entries()),
        pushedListHashes: Array.from(this.pushedListHashes.entries()),
        listUuidMappings: Array.from(this.crdtUuidToListId.entries()),
        fieldBases: Array.from(this.pushedFieldValues.entries()),
        remoteNoteHashes: Array.from(this.remoteNoteHashes.entries()),
        remoteTxHashes: Array.from(this.remoteTxHashes.entries())
      }
      await fs.promises.writeFile(tmpFile, JSON.stringify(data))
      await fs.promises.rename(tmpFile, file)
      this._dirty = false
    } catch (err) {
      throw err
    }
  }

  loadFromFile(room, userId, root = defaultRoot()) {
    if (!room) return false
    try {
      let dir = path.join(root, 'vault')
      let suffix = userId ? '_' + this._sanitizeRoom(userId) : ''
      let file = path.join(dir, this._sanitizeRoom(room) + suffix + '.json')
      let raw
      try {
        raw = fs.readFileSync(file, 'utf8')
      } catch {
        // Fall back to legacy shared vault file (pre-v5.0)
        if (suffix) {
          let legacyFile = path.join(dir, this._sanitizeRoom(room) + '.json')
          raw = fs.readFileSync(legacyFile, 'utf8')
        } else {
          throw new Error('no vault file')
        }
      }
      let data = JSON.parse(raw)
      // Accept all vault versions (1-4) — missing fields default to empty
      if (data.version !== 1 && data.version !== 2 && data.version !== 3 && data.version !== 4) return false

      if (Array.isArray(data.pushedHashes)) {
        for (let [k, v] of data.pushedHashes) this.pushedHashes.set(k, v)
      }
      if (Array.isArray(data.appliedNoteKeys)) {
        for (let k of data.appliedNoteKeys) this.appliedNoteKeys.add(k)
      }
      if (Array.isArray(data.appliedSelectionKeys)) {
        for (let k of data.appliedSelectionKeys) this.appliedSelectionKeys.add(k)
      }
      if (Array.isArray(data.sharedPhotos)) {
        for (let k of data.sharedPhotos) this.sharedPhotos.add(k)
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
      // Restore selection mappings
      if (Array.isArray(data.selMappings)) {
        for (let [uuid, selId] of data.selMappings) {
          this.crdtKeyToSelId.set(uuid, String(selId))
          this.selIdToCrdtKey.set(String(selId), uuid)
        }
      }
      // Restore list mappings
      if (Array.isArray(data.listMappings)) {
        for (let [uuid, listName] of data.listMappings) {
          this.crdtKeyToListName.set(uuid, listName)
          this.listNameToCrdtKey.set(listName, uuid)
        }
      }
      // Restore push sequence
      if (typeof data.pushSeq === 'number') {
        this.pushSeq = data.pushSeq
      }
      // Restore dismissed keys (backward-compat: old Set format → pushSeq 0)
      if (Array.isArray(data.dismissedKeys)) {
        for (let entry of data.dismissedKeys) {
          if (Array.isArray(entry) && entry.length === 2) {
            this.dismissedKeys.set(entry[0], entry[1])
          } else if (typeof entry === 'string') {
            this.dismissedKeys.set(entry, 0)
          }
        }
      }
      // Restore retracted note keys
      if (Array.isArray(data.retractedNoteKeys)) {
        for (let k of data.retractedNoteKeys) this.retractedNoteKeys.add(k)
      }
      // Restore applied note content hashes
      if (Array.isArray(data.appliedNoteHashes)) {
        for (let [k, v] of data.appliedNoteHashes) this.appliedNoteHashes.set(k, v)
      }
      // Restore original authors
      if (Array.isArray(data.originalAuthors)) {
        for (let [k, v] of data.originalAuthors) this.originalAuthors.set(k, v)
      }
      // Restore template/list push hashes
      if (Array.isArray(data.pushedTemplateHashes)) {
        for (let [k, v] of data.pushedTemplateHashes) this.pushedTemplateHashes.set(k, v)
      }
      if (Array.isArray(data.pushedListHashes)) {
        for (let [k, v] of data.pushedListHashes) this.pushedListHashes.set(k, v)
      }
      // Restore list UUID mappings
      if (Array.isArray(data.listUuidMappings)) {
        for (let [uuid, listId] of data.listUuidMappings) {
          this.crdtUuidToListId.set(uuid, listId)
          this.listIdToCrdtUuid.set(listId, uuid)
        }
      }
      for (let [field, list] of [
        ['pushedFieldValues', data.fieldBases],
        ['remoteNoteHashes', data.remoteNoteHashes],
        ['remoteTxHashes', data.remoteTxHashes]
      ]) {
        if (Array.isArray(list)) for (let [k, v] of list) this[field].set(k, v)
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
    this.sharedPhotos.clear()
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
    this.remoteNoteHashes.clear()
    this.remoteTxHashes.clear()
    this.dismissedKeys.clear()
    this.retractedNoteKeys.clear()
    this.appliedNoteHashes.clear()
    this.originalAuthors.clear()
    this.pushedTemplateHashes.clear()
    this.pushedListHashes.clear()
    this.listIdToCrdtUuid.clear()
    this.crdtUuidToListId.clear()
    this.pushSeq = 0
  }
}

module.exports = { SyncVault, defaultRoot }
