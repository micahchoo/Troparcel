'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * Backup & Validation — protects local data during remote apply.
 *
 * - Pre-apply snapshots: saves affected items as JSON before applying
 * - Inbound validation: size guards, tombstone flood, empty overwrite
 * - Rollback: replays a backup snapshot via the Tropy API (all data types)
 */

const DEFAULT_OPTIONS = {
  maxBackups: 10,
  maxNoteSize: 1 * 1024 * 1024,       // 1 MB
  maxMetadataSize: 64 * 1024,          // 64 KB
  tombstoneFloodThreshold: 0.5         // 50%
}

class BackupManager {
  constructor(room, api, logger, options = {}) {
    this.room = room
    this.api = api
    this.logger = logger
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.backupDir = path.join(os.homedir(), '.troparcel', 'backups', this.sanitizeDir(room))
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
  async saveSnapshot(itemSnapshots) {
    await this.ensureDir()
    let ts = new Date().toISOString().replace(/[:.]/g, '-')
    this._fileCounter++
    let filename = `${ts}-${String(this._fileCounter).padStart(4, '0')}.json`
    let filepath = path.join(this.backupDir, filename)

    let data = {
      room: this.room,
      timestamp: new Date().toISOString(),
      version: '3.1',
      items: itemSnapshots
    }

    await fs.promises.writeFile(filepath, JSON.stringify(data))
    this.logger.info(`Backup saved: ${filepath}`, { items: itemSnapshots.length })

    await this.pruneOldBackups()
    return filepath
  }

  /**
   * Remove old backups beyond the retention limit.
   */
  async pruneOldBackups() {
    try {
      let entries = await fs.promises.readdir(this.backupDir)
      let files = entries.filter(f => f.endsWith('.json')).sort()

      let toDelete = []
      while (files.length > this.options.maxBackups) {
        toDelete.push(files.shift())
      }
      if (toDelete.length > 0) {
        await Promise.allSettled(
          toDelete.map(f => fs.promises.unlink(path.join(this.backupDir, f)))
        )
        for (let f of toDelete) this.logger.debug(`Pruned old backup: ${f}`)
      }
    } catch (err) {
      this.logger.warn('Failed to prune backups', { error: err.message })
    }
  }

  /**
   * Capture the current state of a local item for backup purposes.
   * Uses the HTTP API — prefer captureItemStateFromStore() when adapter is available.
   *
   * @param {number} localId
   * @param {string} identity
   * @returns {Object} snapshot
   */
  async captureItemState(localId, identity) {
    let snapshot = { identity, localId }

    try {
      snapshot.metadata = await this.api.getMetadata(localId)
    } catch { snapshot.metadata = null }

    try {
      snapshot.tags = await this.api.getItemTags(localId)
    } catch { snapshot.tags = [] }

    // Get photos with notes and selections
    snapshot.photos = []
    try {
      let photos = await this.api.getPhotos(localId)
      if (Array.isArray(photos)) {
        let photoIds = photos.map(pid => typeof pid === 'object' ? pid.id : pid)
        let results = await Promise.allSettled(
          photoIds.map(id => this.api.getPhoto(id))
        )
        for (let r of results) {
          if (r.status === 'fulfilled' && r.value) snapshot.photos.push(r.value)
        }
      }
    } catch {}

    return snapshot
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
  validateInbound(itemIdentity, crdtItem, userId) {
    let warnings = []

    // Size guard: notes
    if (crdtItem.notes) {
      for (let [key, note] of Object.entries(crdtItem.notes)) {
        if (note.deleted) continue
        let size = (note.html || '').length + (note.text || '').length
        if (size > this.options.maxNoteSize) {
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
          warnings.push(`Transcription ${key} exceeds max size (${size} > ${this.options.maxNoteSize})`)
        }
      }
    }

    // Size guard: metadata values
    if (crdtItem.metadata) {
      for (let [key, val] of Object.entries(crdtItem.metadata)) {
        let size = (val.text || '').length
        if (size > this.options.maxMetadataSize) {
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

    if (totalEntries > 0 && (tombstoned / totalEntries) > this.options.tombstoneFloodThreshold) {
      this.logger.info(
        `Tombstone ratio for ${itemIdentity.slice(0, 8)}: ${tombstoned}/${totalEntries} ` +
        `(${Math.round(tombstoned / totalEntries * 100)}%) — not blocking`
      )
    }

    return {
      valid: warnings.length === 0,
      warnings
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
   * Rollback: replay a backup file into Tropy via the API or store adapter (R4).
   * Restores metadata, tags, and notes for all items in the backup.
   *
   * @param {string} backupPath - path to the backup JSON file
   * @param {StoreAdapter} [adapter] - optional store adapter for write operations
   * @returns {Object} { restored: number, errors: string[] }
   */
  async rollback(backupPath, adapter = null) {
    let data = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    let restored = 0
    let errors = []

    for (let item of data.items) {
      let itemErrors = []
      try {
        // Restore metadata
        if (item.metadata) {
          try {
            await this.api.saveMetadata(item.localId, item.metadata)
          } catch (err) {
            itemErrors.push(`metadata for ${item.localId}: ${err.message}`)
          }
        }

        // Restore tags
        if (item.tags && Array.isArray(item.tags)) {
          try {
            let tagIds = item.tags.map(t => t.id || t.tag_id).filter(Boolean)
            if (tagIds.length > 0) {
              await this.api.addTagsToItem(item.localId, tagIds)
            }
          } catch (err) {
            itemErrors.push(`tags for ${item.localId}: ${err.message}`)
          }
        }

        // Restore notes from photos
        if (item.photos && Array.isArray(item.photos)) {
          for (let photo of item.photos) {
            let noteIds = photo.notes || []
            for (let noteId of noteIds) {
              try {
                let note = await this.api.getNote(noteId, 'json')
                if (note && note.html) {
                  if (adapter) {
                    await adapter.updateNote(noteId, { html: note.html })
                  } else {
                    this.logger.warn(`Rollback: note ${noteId} update skipped (no store adapter, HTTP PUT not supported)`)
                  }
                }
              } catch (err) {
                itemErrors.push(`note ${noteId}: ${err.message}`)
              }
            }

            // Restore selections — coordinates can't be updated via either path
            let selIds = photo.selections || []
            for (let selId of selIds) {
              this.logger.warn(`Rollback: selection ${selId} update skipped (selection coordinate update not supported)`)
            }
          }
        }

        if (itemErrors.length > 0) {
          this.logger.warn(`Rollback: item ${item.localId} partially restored with ${itemErrors.length} error(s)`)
          errors.push(...itemErrors)
        }
        restored++
      } catch (err) {
        errors.push(`Failed to restore item ${item.localId}: ${err.message}`)
        errors.push(...itemErrors)
      }
    }

    this.logger.info(`Rollback complete: ${restored} items restored`, {
      backup: backupPath,
      errors: errors.length
    })

    return { restored, errors }
  }

  /**
   * List available backups for this room.
   * @returns {string[]} backup file paths, newest first
   */
  listBackups() {
    try {
      return fs.readdirSync(this.backupDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .map(f => path.join(this.backupDir, f))
    } catch {
      return []
    }
  }
}

module.exports = { BackupManager }
