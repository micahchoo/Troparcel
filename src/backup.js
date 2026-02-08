'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

/**
 * Backup & Validation — protects local data during remote apply.
 *
 * - Pre-apply snapshots: saves affected items as JSON before applying
 * - Inbound validation: size guards, tombstone flood, empty overwrite
 * - Rollback: replays a backup snapshot via the Tropy API
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
  ensureDir() {
    fs.mkdirSync(this.backupDir, { recursive: true })
  }

  /**
   * Save a pre-apply snapshot of items that are about to be modified.
   *
   * @param {Object[]} itemSnapshots - array of { identity, localId, metadata, tags, notes, selections, transcriptions }
   * @returns {string} path to the backup file
   */
  saveSnapshot(itemSnapshots) {
    this.ensureDir()
    let ts = new Date().toISOString().replace(/[:.]/g, '-')
    let filename = `${ts}.json`
    let filepath = path.join(this.backupDir, filename)

    let data = {
      room: this.room,
      timestamp: new Date().toISOString(),
      version: '3.0',
      items: itemSnapshots
    }

    fs.writeFileSync(filepath, JSON.stringify(data, null, 2))
    this.logger.info(`Backup saved: ${filepath}`, { items: itemSnapshots.length })

    this.pruneOldBackups()
    return filepath
  }

  /**
   * Remove old backups beyond the retention limit.
   */
  pruneOldBackups() {
    try {
      let files = fs.readdirSync(this.backupDir)
        .filter(f => f.endsWith('.json'))
        .sort()

      while (files.length > this.options.maxBackups) {
        let oldest = files.shift()
        fs.unlinkSync(path.join(this.backupDir, oldest))
        this.logger.debug(`Pruned old backup: ${oldest}`)
      }
    } catch (err) {
      this.logger.debug('Failed to prune backups', { error: err.message })
    }
  }

  /**
   * Capture the current state of a local item for backup purposes.
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
        for (let pid of photos) {
          let photoId = typeof pid === 'object' ? pid.id : pid
          try {
            let photo = await this.api.getPhoto(photoId)
            if (photo) snapshot.photos.push(photo)
          } catch {}
        }
      }
    } catch {}

    return snapshot
  }

  /**
   * Validate inbound CRDT data before applying it locally.
   * Returns { valid: boolean, warnings: string[] }
   */
  validateInbound(itemIdentity, crdtItem) {
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

    // Tombstone flood protection
    let totalEntries = 0
    let tombstoned = 0
    for (let section of ['tags', 'notes', 'selectionNotes', 'selections', 'transcriptions', 'lists']) {
      let data = crdtItem[section]
      if (data && typeof data === 'object') {
        for (let val of Object.values(data)) {
          totalEntries++
          if (val && val.deleted) tombstoned++
        }
      }
    }

    if (totalEntries > 0 && (tombstoned / totalEntries) > this.options.tombstoneFloodThreshold) {
      warnings.push(
        `Tombstone flood: ${tombstoned}/${totalEntries} entries deleted ` +
        `(${Math.round(tombstoned / totalEntries * 100)}% > ${this.options.tombstoneFloodThreshold * 100}% threshold)`
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
   * Rollback: replay a backup file into Tropy via the API.
   *
   * @param {string} backupPath - path to the backup JSON file
   * @returns {Object} { restored: number, errors: string[] }
   */
  async rollback(backupPath) {
    let data = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    let restored = 0
    let errors = []

    for (let item of data.items) {
      try {
        // Restore metadata
        if (item.metadata) {
          await this.api.saveMetadata(item.localId, item.metadata)
        }
        restored++
      } catch (err) {
        errors.push(`Failed to restore item ${item.localId}: ${err.message}`)
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
