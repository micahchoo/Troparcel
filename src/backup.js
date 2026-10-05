'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * Backup & Validation — protects local data during remote apply.
 *
 * - Pre-apply snapshots: each apply first writes the items it is about to
 *   change, as JSON, to ~/.troparcel/backups/<room>/. They are a record to
 *   read and restore from by hand; nothing replays them automatically.
 * - Inbound validation: size guards, tombstone flood, empty overwrite
 */

const DEFAULT_OPTIONS = {
  maxBackups: 10,
  maxBackupSize: 10 * 1024 * 1024,    // 10 MB per snapshot
  maxNoteSize: 1 * 1024 * 1024,       // 1 MB
  maxMetadataSize: 64 * 1024,          // 64 KB
  tombstoneFloodThreshold: 0.5         // 50%
}

class BackupManager {
  constructor(room, logger, options = {}) {
    this.room = room
    this.logger = logger
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.backupDir = path.join(this.options.dataDir || path.join(os.homedir(), '.troparcel'),
      'backups', this.sanitizeDir(room))
    this._fileCounter = 0
  }

  /**
   * Sanitize a room name for use as a directory name.
   */
  sanitizeDir(name) {
    return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128) || 'default'
  }

  /**
   * Ensure the backup directory exists.
   */
  async ensureDir() {
    await fs.promises.mkdir(this.backupDir, { recursive: true })
  }

  /**
   * Save a pre-apply snapshot of items that are about to be modified.
   * Uses millisecond timestamps + counter to prevent collisions (R8).
   *
   * @param {Object[]} itemSnapshots - array of { identity, localId, metadata, tags, notes, selections, transcriptions }
   * @returns {string} path to the backup file
   */
  /**
   * Save the items about to change. A snapshot over `maxBackupSize` is
   * split into parts, each under the limit, in a folder of their own: a
   * first sync of a large project changes every item, and is the sync that
   * most needs a backup. An item larger than the limit alone gets a part
   * of its own, over the limit, and a warning. Returns the file or folder.
   */
  async saveSnapshot(itemSnapshots) {
    await this.ensureDir()
    let ts = new Date().toISOString().replace(/[:.]/g, '-')
    this._fileCounter++
    let name = `${ts}-${String(this._fileCounter).padStart(4, '0')}`
    let limit = this.options.maxBackupSize
    let wrap = items => JSON.stringify({ room: this.room, timestamp: new Date().toISOString(), version: '4.0', items })

    let whole = wrap(itemSnapshots)
    let target
    if (whole.length <= limit) {
      target = path.join(this.backupDir, `${name}.json`)
      await fs.promises.writeFile(target, whole)
    } else {
      target = path.join(this.backupDir, name)
      await fs.promises.mkdir(target, { recursive: true })
      let overhead = wrap([]).length
      let part = []
      let size = overhead
      let n = 0
      let flush = async () => {
        if (part.length === 0) return
        n++
        await fs.promises.writeFile(path.join(target, `part-${String(n).padStart(4, '0')}.json`), wrap(part))
        part = []
        size = overhead
      }
      for (let snap of itemSnapshots) {
        let len = JSON.stringify(snap).length + 1
        if (overhead + len > limit) {
          this.logger.warn(`Backup: item ${snap.localId} is larger than the ${limit}-byte limit; saved on its own`)
        }
        if (part.length > 0 && size + len > limit) await flush()
        part.push(snap)
        size += len
      }
      await flush()
    }
    this.logger.info(`Backup saved: ${target}`, { items: itemSnapshots.length })
    await this.pruneOldBackups()
    return target
  }

  /**
   * Remove old backups beyond the retention limit. A split backup (a
   * folder of parts) counts as one.
   */
  async pruneOldBackups() {
    try {
      let entries = (await fs.promises.readdir(this.backupDir, { withFileTypes: true }))
        .filter(e => e.isDirectory() || e.name.endsWith('.json'))
        .map(e => e.name)
        .sort()
      let toDelete = entries.slice(0, Math.max(0, entries.length - this.options.maxBackups))
      await Promise.allSettled(toDelete.map(f =>
        fs.promises.rm(path.join(this.backupDir, f), { recursive: true, force: true })))
      for (let f of toDelete) this.logger.debug(`Pruned old backup: ${f}`)
    } catch (err) {
      this.logger.warn('Failed to prune backups', { error: err.message })
    }
  }

  /**
   * Capture item state directly from the Redux store adapter.
   * Avoids HTTP API calls — faster and works even when API is unreachable.
   *
   * @param {StoreAdapter} adapter
   * @param {number} localId
   * @param {string} itemIdentity
   * @returns {Object} snapshot
   */
  captureItemStateFromStore(adapter, localId, itemIdentity) {
    let item = adapter.getItemFull(localId)
    if (!item) {
      return { identity: itemIdentity, localId, metadata: null, tags: [], photos: [] }
    }
    // Extract metadata properties — skip known structural keys
    let metadata = {}
    let structuralKeys = new Set([
      'id', 'photo', 'template', 'list', 'lists', 'tag', 'tags',
      'photos', 'selections', 'notes', 'transcriptions'
    ])
    for (let [key, value] of Object.entries(item)) {
      if (key.startsWith('@') || key.startsWith('_')) continue
      if (structuralKeys.has(key)) continue
      metadata[key] = value
    }
    return {
      identity: itemIdentity,
      localId,
      metadata,
      tags: item.tag || [],
      photos: item.photo || []
    }
  }

  /**
   * Validate inbound CRDT data before applying it locally.
   * Returns { valid: boolean, warnings: string[] }
   */
  /**
   * Check one item's room entries before apply. Returns `rejected`, the
   * `section|key` of each entry over a size limit: apply skips those
   * entries alone, so one oversized note cannot stop the rest of its item.
   */
  validateInbound(itemIdentity, crdtItem, userId) {
    let warnings = []
    let rejected = new Set()

    // Size guard: notes
    if (crdtItem.notes) {
      for (let [key, note] of Object.entries(crdtItem.notes)) {
        if (note.deleted) continue
        let size = (note.html || '').length + (note.text || '').length
        if (size > this.options.maxNoteSize) {
          rejected.add(`notes|${key}`)
          warnings.push(`Note ${key} exceeds max size (${size} > ${this.options.maxNoteSize})`)
        }
      }
    }

    // Size guard: selection notes
    if (crdtItem.selectionNotes) {
      for (let [key, note] of Object.entries(crdtItem.selectionNotes)) {
        if (note.deleted) continue
        let size = (note.html || '').length + (note.text || '').length
        if (size > this.options.maxNoteSize) {
          rejected.add(`selectionNotes|${key}`)
          warnings.push(`Selection note ${key} exceeds max size (${size} > ${this.options.maxNoteSize})`)
        }
      }
    }

    // Size guard: transcriptions
    if (crdtItem.transcriptions) {
      for (let [key, tx] of Object.entries(crdtItem.transcriptions)) {
        if (tx.deleted) continue
        let size = (tx.text || '').length + JSON.stringify(tx.data || '').length
        if (size > this.options.maxNoteSize) {
          rejected.add(`transcriptions|${key}`)
          warnings.push(`Transcription ${key} exceeds max size (${size} > ${this.options.maxNoteSize})`)
        }
      }
    }

    // Size guard: metadata values
    if (crdtItem.metadata) {
      for (let [key, val] of Object.entries(crdtItem.metadata)) {
        let size = (val.text || '').length
        if (size > this.options.maxMetadataSize) {
          rejected.add(`metadata|${key}`)
          warnings.push(`Metadata ${key} exceeds max size (${size} > ${this.options.maxMetadataSize})`)
        }
      }
    }

    // Tombstone flood detection — informational only (does not block apply)
    // Accumulated tombstones from legitimate deletions are normal over time
    let totalEntries = 0
    let tombstoned = 0
    for (let section of ['tags', 'notes', 'selectionNotes', 'selections', 'transcriptions', 'lists']) {
      let data = crdtItem[section]
      if (data && typeof data === 'object') {
        for (let val of Object.values(data)) {
          totalEntries++
          if (val && val.deleted && (!userId || val.author !== userId)) {
            tombstoned++
          }
        }
      }
    }

    // Require at least 20 entries before the ratio check — deleting 3 of 5
    // tags is normal exploratory cleanup, not a flood.
    if (totalEntries >= 20 && (tombstoned / totalEntries) > this.options.tombstoneFloodThreshold) {
      this.logger.info(
        `Tombstone ratio for ${itemIdentity.slice(0, 8)}: ${tombstoned}/${totalEntries} ` +
        `(${Math.round(tombstoned / totalEntries * 100)}%) — not blocking`
      )
    }

    return {
      valid: warnings.length === 0,
      warnings,
      rejected
    }
  }

  /**
   * Check if a remote value should overwrite a local value.
   * Prevents empty remote from overwriting non-empty local unless tombstoned.
   */
  shouldOverwrite(localValue, remoteValue) {
    // If remote is explicitly tombstoned, allow
    if (remoteValue && remoteValue.deleted) return true
    // If remote is empty/null and local has content, don't overwrite
    if ((!remoteValue || !remoteValue.text) && localValue && localValue.text) return false
    return true
  }

  /**
   * List available backups for this room.
   * @returns {string[]} backup file paths, newest first
   */
  /** Backups, newest first: a .json file, or a folder of parts. */
  listBackups() {
    try {
      return fs.readdirSync(this.backupDir, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.name.endsWith('.json'))
        .map(e => e.name)
        .sort()
        .reverse()
        .map(f => path.join(this.backupDir, f))
    } catch {
      return []
    }
  }
}

module.exports = { BackupManager }
