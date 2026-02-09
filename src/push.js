'use strict'

const identity = require('./identity')
const schema = require('./crdt-schema')

/**
 * Push mixin — local → CRDT write methods.
 *
 * These methods are mixed onto SyncEngine.prototype via Object.assign.
 * All `this` references resolve to the SyncEngine instance at call time.
 */
module.exports = {

  async pushLocal(items) {
    let userId = this._stableUserId
    this._lastPushTs = this.lastSync ? this.lastSync.getTime() : 0
    let pushed = 0
    let skipped = 0

    for (let item of items) {
      let id = identity.computeIdentity(item)
      if (!id) continue

      let changeCheck = this.vault.hasItemChanged(id, item)
      if (!changeCheck.changed) {
        skipped++
        continue
      }
      pushed++

      // P4: Compute checksumMap once per item
      let checksumMap = identity.buildPhotoChecksumMap(item)

      try {
        // Collect keys during push to avoid recomputing them in saveItemSnapshot
        let collectedKeys = {}
        this.doc.transact(() => {
          // Store photo checksums for fuzzy identity matching (merged items)
          let checksums = Array.from(checksumMap.values())
          if (checksums.length > 0) {
            schema.setItemChecksums(this.doc, id, checksums)
          }
          this.pushMetadata(item, id, userId)
          this.pushTags(item, id, userId)
          collectedKeys.noteKeys = this.pushNotes(item, id, userId, checksumMap)
          this.pushPhotoMetadata(item, id, userId)
          collectedKeys.selectionKeys = this.pushSelections(item, id, userId, checksumMap)
          collectedKeys.transcriptionKeys = this.pushTranscriptions(item, id, userId, checksumMap)
          if (this.options.syncLists) {
            this.pushLists(item, id, userId)
          }
          this.pushDeletions(item, id, userId, checksumMap, collectedKeys)
        }, this.LOCAL_ORIGIN)

        this.saveItemSnapshot(item, id, checksumMap, collectedKeys)
        this.vault.markPushed(id, changeCheck.hash)
        // Clear failure count on success (prevents stale counts + memory leak)
        if (this._pushFailCounts && this._pushFailCounts.has(id)) {
          this._pushFailCounts.delete(id)
        }
      } catch (err) {
        this.logger.warn(`Failed to push item ${id}`, { error: err.message })
        // Mark as pushed after repeated failures to prevent infinite retry
        let failCount = (this._pushFailCounts && this._pushFailCounts.get(id)) || 0
        if (!this._pushFailCounts) this._pushFailCounts = new Map()
        this._pushFailCounts.set(id, failCount + 1)
        if (failCount + 1 >= 3) {
          this.vault.markPushed(id, changeCheck.hash)
          this._pushFailCounts.delete(id)
          this.logger.warn(`Item ${id} push permanently skipped after ${failCount + 1} failures`)
        }
      }
    }

    if (pushed > 0) {
      this._log(`pushed ${pushed} item(s) to CRDT`)
    } else {
      this._debug(`pushLocal: ${skipped} item(s) unchanged`)
    }
  },

  pushMetadata(item, itemIdentity, userId) {
    if (!this.options.syncMetadata) return
    let existing = schema.getMetadata(this.doc, itemIdentity)
    let lastPushTs = this._lastPushTs

    for (let [key, value] of Object.entries(item)) {
      if (key.startsWith('@') || key.startsWith('_')) continue
      if (['photo', 'template', 'list', 'lists', 'tag'].includes(key)) continue
      if (!key.includes(':') && !key.includes('/')) continue

      let text = ''
      let type = 'http://www.w3.org/2001/XMLSchema#string'
      let language = null

      if (typeof value === 'string') {
        text = value
      } else if (value && typeof value === 'object') {
        text = value['@value'] || value.text || ''
        type = value['@type'] || value.type || type
        language = value['@language'] || value.language || null
      } else if (value != null) {
        text = String(value)
      }

      // Push empty strings to propagate field clears (text='' means field was cleared)
      // Only skip if we have no text AND there's no existing CRDT value to clear
      let current = existing[key]
      if (!text && !current) continue

      if (current) {
        if (current.text === text && current.type === type) continue
        if (current.author !== userId && current.ts > lastPushTs) continue
      }

      schema.setMetadata(this.doc, itemIdentity, key, { text, type, language }, userId)
    }
  },

  pushTags(item, itemIdentity, userId) {
    if (!this.options.syncTags) return
    let tags = item.tag || item['https://tropy.org/v1/tropy#tag'] || []
    if (!Array.isArray(tags)) tags = [tags]

    let lastPushTs = this._lastPushTs
    let existingTagsList = schema.getTags(this.doc, itemIdentity)
    let existingTags = new Map(existingTagsList.map(t => [t.name, t]))

    for (let tag of tags) {
      let name = typeof tag === 'string' ? tag : (tag.name || tag['@value'] || '')
      let color = typeof tag === 'object' ? tag.color : null

      if (!name) continue

      let existing = existingTags.get(name)
      if (existing && !existing.deleted) {
        if ((existing.color || null) === (color || null)) continue
        if (existing.author !== userId && existing.ts > lastPushTs) continue
      }

      // Don't resurrect tags that were explicitly tombstoned by a remote peer
      // Use >= to prevent resurrection after lastPushTs catches up to tombstone timestamp
      if (existing && existing.deleted && existing.author !== userId && existing.ts >= lastPushTs) {
        continue
      }

      schema.setTag(this.doc, itemIdentity, { name, color }, userId)
    }
  },

  // C1: Uses vault mapping for stable note keys
  pushNotes(item, itemIdentity, userId, checksumMap) {
    if (!this.options.syncNotes) return { noteKeys: new Set(), selectionNoteKeys: new Set() }
    let photos = item.photo || item['https://tropy.org/v1/tropy#photo'] || []
    if (!Array.isArray(photos)) photos = [photos]

    let existingNotes = schema.getNotes(this.doc, itemIdentity)
    let lastPushTs = this._lastPushTs

    // Track all note keys we push, so we can clean up stale entries after
    let pushedNoteKeys = new Set()
    let pushedSelNoteKeys = new Set()

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      let notes = photo.note || photo['https://tropy.org/v1/tropy#note'] || []
      if (!Array.isArray(notes)) notes = [notes]

      for (let note of notes) {
        if (!note) continue
        let text = note['@value'] || note.text || note['https://schema.org/text'] || ''
        let html = note.html || note['https://tropy.org/v1/tropy#html'] || ''
        if (typeof text === 'object') text = text['@value'] || ''
        if (typeof html === 'object') html = html['@value'] || ''

        // Skip notes applied by troparcel (have [author] prefix from sync)
        if (this._isSyncedNote(text, html)) continue

        if (text || html) {
          let contentKey = identity.computeNoteKey(
            { text, html, photo: photo['@id'] || photo.id },
            photoChecksum
          )

          // C1: Use vault to get stable key across edits
          let localNoteId = note['@id'] || note.id
          let noteKey = localNoteId
            ? this.vault.getNoteKey(localNoteId, contentKey)
            : contentKey

          pushedNoteKeys.add(noteKey)

          let existingNote = existingNotes[noteKey]
          if (existingNote && !existingNote.deleted &&
              existingNote.text === text && existingNote.html === html) {
            this.vault.appliedNoteKeys.add(noteKey)
            continue
          }
          if (existingNote && !existingNote.deleted &&
              existingNote.author !== userId && existingNote.ts > lastPushTs) {
            // Don't add to appliedNoteKeys here — the apply side needs to
            // bring the remote (newer) version locally
            continue
          }

          schema.setNote(this.doc, itemIdentity, noteKey, {
            text,
            html,
            language: note.language || null,
            photo: photoChecksum || null
          }, userId)
          this.vault.appliedNoteKeys.add(noteKey)
        }
      }

      // Selection notes
      let selections = photo.selection || photo['https://tropy.org/v1/tropy#selection'] || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel || !photoChecksum) continue

        let selKey = identity.computeSelectionKey(photoChecksum, sel)
        let selNotes = sel.note || sel['https://tropy.org/v1/tropy#note'] || []
        if (!Array.isArray(selNotes)) selNotes = [selNotes]

        let existingSelNotes = schema.getSelectionNotes(this.doc, itemIdentity, selKey)

        for (let note of selNotes) {
          if (!note) continue
          let text = note['@value'] || note.text || note['https://schema.org/text'] || ''
          let html = note.html || note['https://tropy.org/v1/tropy#html'] || ''
          if (typeof text === 'object') text = text['@value'] || ''
          if (typeof html === 'object') html = html['@value'] || ''

          // Skip notes applied by troparcel (have [author] prefix from sync)
          if (this._isSyncedNote(text, html)) continue

          if (text || html) {
            let contentKey = identity.computeNoteKey(
              { text, html, selection: sel['@id'] || sel.id },
              photoChecksum
            )

            let localNoteId = note['@id'] || note.id
            let noteKey = localNoteId
              ? this.vault.getNoteKey(localNoteId, contentKey)
              : contentKey

            let compositeKey = `${selKey}:${noteKey}`
            pushedSelNoteKeys.add(compositeKey)

            let existingSelNote = existingSelNotes[compositeKey]
            if (existingSelNote &&
                existingSelNote.text === text && existingSelNote.html === html) {
              this.vault.appliedNoteKeys.add(compositeKey)
              continue
            }
            if (existingSelNote && !existingSelNote.deleted &&
                existingSelNote.author !== userId && existingSelNote.ts > lastPushTs) {
              // Don't add to appliedNoteKeys — let apply side bring remote version locally
              continue
            }

            schema.setSelectionNote(this.doc, itemIdentity, selKey, noteKey, {
              text,
              html,
              language: note.language || null
            }, userId)
            this.vault.appliedNoteKeys.add(compositeKey)
          }
        }
      }
    }

    // Clean up stale CRDT entries authored by us (content-based key changed).
    // Uses permanent Y.Map.delete() — NOT tombstoning — to avoid bloat.
    this._cleanupStaleNotes(itemIdentity, userId, pushedNoteKeys, pushedSelNoteKeys)

    return { noteKeys: pushedNoteKeys, selectionNoteKeys: pushedSelNoteKeys }
  },

  /**
   * Remove stale CRDT note/selectionNote entries authored by this user
   * that are no longer in the current local note set.
   * Uses Y.Map.delete() for permanent removal (not tombstoning).
   */
  _cleanupStaleNotes(itemIdentity, userId, pushedNoteKeys, pushedSelNoteKeys) {
    // Only clean up stale entries when deletion propagation is enabled.
    // Y.Map.delete() propagates to all peers — without this guard,
    // locally-deleted notes get removed from the CRDT even when the user
    // has syncDeletions=false.
    if (!this.options.syncDeletions) return

    let allNotes = schema.getNotes(this.doc, itemIdentity)
    let removed = 0

    for (let [key, note] of Object.entries(allNotes)) {
      if (note.author !== userId) continue
      if (note.deleted) continue
      if (pushedNoteKeys.has(key)) continue

      // This is a stale entry from us — permanently delete it
      schema.deleteNoteEntry(this.doc, itemIdentity, key)
      removed++
    }

    let allSelNotes = schema.getAllSelectionNotes(this.doc, itemIdentity)
    for (let [key, note] of Object.entries(allSelNotes)) {
      if (note.author !== userId) continue
      if (note.deleted) continue
      if (pushedSelNoteKeys.has(key)) continue

      schema.deleteSelectionNoteEntry(this.doc, itemIdentity, key)
      removed++
    }

    if (removed > 0) {
      this._log(`cleanupStaleNotes: removed ${removed} stale entry(s) for ${itemIdentity.slice(0, 8)}`)
    }
  },

  pushPhotoMetadata(item, itemIdentity, userId) {
    if (!this.options.syncPhotoAdjustments) return
    let lastPushTs = this._lastPushTs

    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let photo of photos) {
      let checksum = photo.checksum
      if (!checksum || !photo.metadata) continue

      let existing = schema.getPhotoMetadata(this.doc, itemIdentity, checksum)

      for (let [key, value] of Object.entries(photo.metadata)) {
        if (key === 'id') continue
        let text = ''
        let type = 'http://www.w3.org/2001/XMLSchema#string'

        if (typeof value === 'object' && value !== null) {
          text = value.text || ''
          type = value.type || type
        } else if (value != null) {
          text = String(value)
        }

        // Push empty strings to propagate field clears (consistent with item metadata)
        let current = existing[key]
        if (!text && !current) continue

        if (current) {
          if (current.text === text && current.type === type) continue
          if (current.author !== userId && current.ts > lastPushTs) continue
        }

        schema.setPhotoMetadata(this.doc, itemIdentity, checksum, key, { text, type }, userId)
      }
    }
  },

  // P4: Accepts checksumMap parameter instead of recomputing
  pushSelections(item, itemIdentity, userId, checksumMap) {
    if (!this.options.syncSelections) return new Set()
    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    let existingSelections = schema.getSelections(this.doc, itemIdentity)
    let lastPushTs = this._lastPushTs
    let pushedSelectionKeys = new Set()

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      if (!photoChecksum) continue

      let selections = photo.selection || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel) continue

        let selKey = identity.computeSelectionKey(photoChecksum, sel)
        pushedSelectionKeys.add(selKey)

        let existingSel = existingSelections[selKey]
        let selUnchanged = existingSel && !existingSel.deleted &&
            existingSel.x === sel.x && existingSel.y === sel.y &&
            existingSel.w === sel.width && existingSel.h === sel.height &&
            (existingSel.angle || 0) === (sel.angle || 0)

        let remoteNewer = existingSel && !existingSel.deleted &&
            existingSel.author !== userId && existingSel.ts > lastPushTs

        if (!selUnchanged && !remoteNewer) {
          schema.setSelection(this.doc, itemIdentity, selKey, {
            x: sel.x,
            y: sel.y,
            width: sel.width,
            height: sel.height,
            angle: sel.angle || 0,
            photo: photoChecksum
          }, userId)
          this.vault.appliedSelectionKeys.add(selKey)
        } else if (selUnchanged) {
          // Content matches — safe to mark as applied
          this.vault.appliedSelectionKeys.add(selKey)
        }
        // When remoteNewer && !selUnchanged: don't mark applied, let apply side update locally

        // Selection metadata
        if (sel.metadata) {
          let existingSelMeta = schema.getSelectionMeta(this.doc, itemIdentity, selKey)

          for (let [key, value] of Object.entries(sel.metadata)) {
            if (key === 'id') continue
            let text = ''
            let type = 'http://www.w3.org/2001/XMLSchema#string'

            if (typeof value === 'object' && value !== null) {
              text = value.text || ''
              type = value.type || type
            } else if (value != null) {
              text = String(value)
            }

            // Push empty strings to propagate field clears (consistent with item metadata)
            let existingSM = existingSelMeta[key]
            if (!text && !existingSM) continue

            if (existingSM) {
              if (existingSM.text === text && existingSM.type === type) continue
              if (existingSM.author !== userId && existingSM.ts > lastPushTs) continue
            }

            schema.setSelectionMeta(this.doc, itemIdentity, selKey, key, { text, type }, userId)
          }
        }
      }
    }
    return pushedSelectionKeys
  },

  // C3: Uses vault mapping for stable transcription keys
  pushTranscriptions(item, itemIdentity, userId, checksumMap) {
    if (!this.options.syncTranscriptions) return new Set()
    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    let pushedTranscriptionKeys = new Set()
    let existingTranscriptions = schema.getTranscriptions(this.doc, itemIdentity)
    let lastPushTs = this._lastPushTs

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      if (!photoChecksum) continue

      // Photo-level transcriptions
      let txs = photo.transcription || []
      if (!Array.isArray(txs)) txs = [txs]

      txs.forEach((tx, idx) => {
        if (!tx) return
        let contentKey = identity.computeTranscriptionKey(photoChecksum, idx)

        // C3: Use vault for stable key
        let localTxId = tx['@id'] || tx.id
        let txKey = localTxId
          ? this.vault.getTxKey(localTxId, contentKey)
          : contentKey

        pushedTranscriptionKeys.add(txKey)
        this.vault.appliedTranscriptionKeys.add(txKey)

        let existingTx = existingTranscriptions[txKey]
        if (existingTx && !existingTx.deleted && existingTx.text === (tx.text || '')) {
          return
        }
        if (existingTx && !existingTx.deleted &&
            existingTx.author !== userId && existingTx.ts > lastPushTs) {
          return
        }

        schema.setTranscription(this.doc, itemIdentity, txKey, {
          text: tx.text || '',
          data: tx.data || null,
          photo: photoChecksum
        }, userId)
      })

      // Selection-level transcriptions
      let selections = photo.selection || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel) continue
        let selKey = identity.computeSelectionKey(photoChecksum, sel)
        let selTxs = sel.transcription || []
        if (!Array.isArray(selTxs)) selTxs = [selTxs]

        selTxs.forEach((tx, idx) => {
          if (!tx) return
          let contentKey = identity.computeTranscriptionKey(photoChecksum, idx, selKey)

          let localTxId = tx['@id'] || tx.id
          let txKey = localTxId
            ? this.vault.getTxKey(localTxId, contentKey)
            : contentKey

          pushedTranscriptionKeys.add(txKey)
          this.vault.appliedTranscriptionKeys.add(txKey)

          let existingTx = existingTranscriptions[txKey]
          if (existingTx && !existingTx.deleted && existingTx.text === (tx.text || '')) {
            return
          }
          if (existingTx && !existingTx.deleted &&
              existingTx.author !== userId && existingTx.ts > lastPushTs) {
            return
          }

          schema.setTranscription(this.doc, itemIdentity, txKey, {
            text: tx.text || '',
            data: tx.data || null,
            photo: photoChecksum,
            selection: selKey
          }, userId)
        })
      }
    }
    return pushedTranscriptionKeys
  },

  // C2: Resolves list IDs to names for cross-instance matching
  pushLists(item, itemIdentity, userId) {
    let listIds = item.lists || []
    if (!Array.isArray(listIds)) return

    let existingLists = schema.getLists(this.doc, itemIdentity)
    let lastPushTs = this._lastPushTs

    for (let listId of listIds) {
      // C2: Use list name (not local ID) as the CRDT key
      let listName = this._listNameCache.get(listId) || this._listNameCache.get(String(listId))
      if (!listName) {
        this._debug(`pushLists: skipping list ${listId} (name not in cache)`)
        continue
      }
      let key = listName

      let existing = existingLists[key]
      if (existing && !existing.deleted && existing.member) continue
      if (existing && existing.author !== userId && existing.ts > lastPushTs) continue

      schema.setListMembership(this.doc, itemIdentity, key, userId)
    }
  },

  // C2: Refresh the listId -> listName cache.
  // Skips if already refreshed within this sync cycle (< 5s ago).
  async _refreshListNameCache() {
    if (!this.options.syncLists) return
    let now = Date.now()
    if (now - this._listCacheRefreshedAt < 5000) return
    try {
      let lists = this.adapter
        ? this.adapter.getAllLists()
        : await this.api.getLists()
      if (Array.isArray(lists)) {
        this._listNameCache.clear()
        for (let l of lists) {
          if (l.id && l.name) {
            this._listNameCache.set(l.id, l.name)
            this._listNameCache.set(String(l.id), l.name)
          }
        }
        this._listCacheRefreshedAt = now
      }
    } catch (err) {
      this.logger.warn('Failed to refresh list name cache', { error: err.message })
    }
  },

  // --- Deletion detection ---

  /**
   * Compute all identity keys for an item's sub-resources (notes, selections,
   * transcriptions, selection notes, list names). Shared by saveItemSnapshot
   * and pushDeletions to avoid duplicated photo traversal code.
   */
  _computeItemKeys(item, checksumMap) {
    let noteKeys = new Set()
    let selectionKeys = new Set()
    let transcriptionKeys = new Set()
    let selectionNoteKeys = new Set()
    let listNames = new Set()

    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)

      // Photo-level notes
      let notes = photo.note || []
      if (!Array.isArray(notes)) notes = [notes]

      for (let note of notes) {
        if (!note) continue
        let text = note['@value'] || note.text || note['https://schema.org/text'] || ''
        let html = note.html || note['https://tropy.org/v1/tropy#html'] || ''
        if (typeof text === 'object') text = text['@value'] || ''
        if (typeof html === 'object') html = html['@value'] || ''
        // Skip synced notes (consistent with pushNotes)
        if (this._isSyncedNote(text, html)) continue
        if (text || html) {
          let contentKey = identity.computeNoteKey(
            { text, html, photo: photo['@id'] || photo.id },
            photoChecksum
          )
          let localNoteId = note['@id'] || note.id
          let key = localNoteId
            ? this.vault.getNoteKey(localNoteId, contentKey)
            : contentKey
          noteKeys.add(key)
        }
      }

      // Photo-level transcriptions
      let txs = photo.transcription || []
      if (!Array.isArray(txs)) txs = [txs]
      txs.forEach((tx, idx) => {
        if (!tx) return
        let contentKey = identity.computeTranscriptionKey(photoChecksum, idx)
        let localTxId = tx['@id'] || tx.id
        let txKey = localTxId
          ? this.vault.getTxKey(localTxId, contentKey)
          : contentKey
        transcriptionKeys.add(txKey)
      })

      // Selections and their sub-resources
      let selections = photo.selection || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel || !photoChecksum) continue
        let selKey = identity.computeSelectionKey(photoChecksum, sel)
        selectionKeys.add(selKey)

        // Selection notes
        let selNotes = sel.note || []
        if (!Array.isArray(selNotes)) selNotes = [selNotes]
        for (let note of selNotes) {
          if (!note) continue
          let text = note['@value'] || note.text || note['https://schema.org/text'] || ''
          let html = note.html || note['https://tropy.org/v1/tropy#html'] || ''
          if (typeof text === 'object') text = text['@value'] || ''
          if (typeof html === 'object') html = html['@value'] || ''
          // Skip synced notes (consistent with pushNotes)
          if (this._isSyncedNote(text, html)) continue
          if (text || html) {
            let contentKey = identity.computeNoteKey(
              { text, html, selection: sel['@id'] || sel.id },
              photoChecksum
            )
            let localNoteId = note['@id'] || note.id
            let noteKey = localNoteId
              ? this.vault.getNoteKey(localNoteId, contentKey)
              : contentKey
            selectionNoteKeys.add(`${selKey}:${noteKey}`)
          }
        }

        // Selection transcriptions
        let selTxs = sel.transcription || []
        if (!Array.isArray(selTxs)) selTxs = [selTxs]
        selTxs.forEach((tx, idx) => {
          if (!tx) return
          let contentKey = identity.computeTranscriptionKey(photoChecksum, idx, selKey)
          let localTxId = tx['@id'] || tx.id
          let txKey = localTxId
            ? this.vault.getTxKey(localTxId, contentKey)
            : contentKey
          transcriptionKeys.add(txKey)
        })
      }
    }

    // List memberships
    let listIds = item.lists || []
    if (Array.isArray(listIds)) {
      for (let listId of listIds) {
        let name = this._listNameCache.get(listId) || this._listNameCache.get(String(listId))
        if (name) listNames.add(name)
      }
    }

    return { noteKeys, selectionKeys, transcriptionKeys, selectionNoteKeys, listNames }
  },

  // P4: Accepts checksumMap parameter.
  // P8: Accepts pre-collected keys from push methods to avoid recomputing.
  saveItemSnapshot(item, itemIdentity, checksumMap, collectedKeys) {
    let tags = Array.from(this._resolveTagNames(item))

    if (collectedKeys &&
        collectedKeys.noteKeys && collectedKeys.selectionKeys &&
        collectedKeys.transcriptionKeys) {
      // Use keys already collected during push — avoids full tree re-traversal
      let listNames = this._resolveListNames(item)
      this.previousSnapshot.set(itemIdentity, {
        tags,
        noteKeys: collectedKeys.noteKeys.noteKeys,
        selectionNoteKeys: collectedKeys.noteKeys.selectionNoteKeys,
        selectionKeys: collectedKeys.selectionKeys,
        transcriptionKeys: collectedKeys.transcriptionKeys,
        listNames
      })
    } else {
      let keys = this._computeItemKeys(item, checksumMap)
      this.previousSnapshot.set(itemIdentity, { tags, ...keys })
    }
  },

  _resolveListNames(item) {
    let listNames = new Set()
    let listIds = item.lists || []
    if (Array.isArray(listIds)) {
      for (let listId of listIds) {
        let name = this._listNameCache.get(listId) || this._listNameCache.get(String(listId))
        if (name) listNames.add(name)
      }
    }
    return listNames
  },

  _resolveTagNames(item) {
    return new Set(
      (item.tag || []).map(t =>
        typeof t === 'string' ? t : (t.name || '')
      ).filter(Boolean)
    )
  },

  pushDeletions(item, itemIdentity, userId, checksumMap, collectedKeys) {
    if (!this.options.syncDeletions) return
    let prev = this.previousSnapshot.get(itemIdentity)
    if (!prev) return

    // Detect removed tags (only when syncTags is enabled)
    if (this.options.syncTags) {
      let currentTags = this._resolveTagNames(item)
      for (let tagName of prev.tags) {
        if (!currentTags.has(tagName)) {
          schema.removeTag(this.doc, itemIdentity, tagName, userId)
        }
      }
    }

    // Reuse keys from push methods when available, otherwise recompute
    let current
    if (collectedKeys && collectedKeys.noteKeys && collectedKeys.selectionKeys && collectedKeys.transcriptionKeys) {
      let listNames = this._resolveListNames(item)
      current = {
        noteKeys: collectedKeys.noteKeys.noteKeys,
        selectionNoteKeys: collectedKeys.noteKeys.selectionNoteKeys,
        selectionKeys: collectedKeys.selectionKeys,
        transcriptionKeys: collectedKeys.transcriptionKeys,
        listNames
      }
    } else {
      current = this._computeItemKeys(item, checksumMap)
    }

    // Tombstone removed notes (only when syncNotes is enabled)
    if (this.options.syncNotes && prev.noteKeys) {
      for (let noteKey of prev.noteKeys) {
        if (!current.noteKeys.has(noteKey)) {
          schema.removeNote(this.doc, itemIdentity, noteKey, userId)
        }
      }
    }

    // Tombstone removed selections (only when syncSelections is enabled)
    if (this.options.syncSelections && prev.selectionKeys) {
      for (let selKey of prev.selectionKeys) {
        if (!current.selectionKeys.has(selKey)) {
          schema.removeSelection(this.doc, itemIdentity, selKey, userId)
        }
      }
    }

    // Tombstone removed transcriptions (only when syncTranscriptions is enabled)
    if (this.options.syncTranscriptions && prev.transcriptionKeys) {
      for (let txKey of prev.transcriptionKeys) {
        if (!current.transcriptionKeys.has(txKey)) {
          schema.removeTranscription(this.doc, itemIdentity, txKey, userId)
        }
      }
    }

    // Tombstone removed selection notes (only when syncNotes is enabled)
    if (this.options.syncNotes && prev.selectionNoteKeys) {
      for (let compositeKey of prev.selectionNoteKeys) {
        if (!current.selectionNoteKeys.has(compositeKey)) {
          let sepIdx = compositeKey.indexOf(':')
          if (sepIdx > 0) {
            let selKey = compositeKey.slice(0, sepIdx)
            let noteKey = compositeKey.slice(sepIdx + 1)
            schema.removeSelectionNote(this.doc, itemIdentity, selKey, noteKey, userId)
          }
        }
      }
    }

    // Tombstone removed list memberships
    if (prev.listNames && this.options.syncLists) {
      for (let listName of prev.listNames) {
        if (!current.listNames.has(listName)) {
          schema.removeListMembership(this.doc, itemIdentity, listName, userId)
        }
      }
    }
  },

  /**
   * Detect notes that were applied by troparcel from remote sync.
   * Uses HTML-only detection — survives ProseMirror round-trip and avoids
   * false positives on user notes starting with [brackets].
   * Checks: blockquote format (v4.1+), bold format (v4.0), legacy format (v3).
   */
  _isSyncedNote(text, html) {
    if (!html) return false
    // v4.1+ blockquote format
    if (html.includes('<blockquote><p><em>troparcel:')) return true
    // v4.0 bold format
    if (html.includes('<p><strong>[troparcel:')) return true
    // Legacy v3 check removed — html.includes('<p><strong>[') was too broad
    // and matched user notes like "[Reference 1] According to..."
    return false
  },

  // --- Manual push (export hook) ---

  pushItems(items) {
    if (!this.doc) return

    let userId = this._stableUserId
    this._lastPushTs = this.lastSync ? this.lastSync.getTime() : 0

    this.doc.transact(() => {
      for (let item of items) {
        let id = identity.computeIdentity(item)
        if (!id) continue
        let checksumMap = identity.buildPhotoChecksumMap(item)
        this.pushMetadata(item, id, userId)
        this.pushTags(item, id, userId)
        this.pushNotes(item, id, userId, checksumMap)
        this.pushPhotoMetadata(item, id, userId)
        this.pushSelections(item, id, userId, checksumMap)
        this.pushTranscriptions(item, id, userId, checksumMap)
        if (this.options.syncLists) {
          this.pushLists(item, id, userId)
        }
      }
    }, this.LOCAL_ORIGIN)
  }
}
