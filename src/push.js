'use strict'

const identity = require('./identity')
const schema = require('./crdt-schema')

/**
 * Push mixin — local → CRDT write methods (Schema v4).
 *
 * v4 changes:
 *   - UUID-based keying for notes, selections, transcriptions, lists
 *   - pushSeq (monotonic counter) replaces Date.now() timestamps
 *   - Logic-based conflict checks replace ts > lastPushTs comparisons
 *
 * These methods are mixed onto SyncEngine.prototype via Object.assign.
 * All `this` references resolve to the SyncEngine instance at call time.
 */
module.exports = {

  async pushLocal(items, pushSeq) {
    let userId = this._stableUserId
    let pushed = 0
    let skipped = 0

    // Deduplicate by identity — multiple local items can share the same
    // photo checksums (duplicates). Without dedup, vault.pushedHashes
    // flip-flops between item hashes, causing infinite re-pushes.
    let deduped = new Map()
    for (let item of items) {
      let id = identity.computeIdentity(item)
      if (!id) continue
      deduped.set(id, item)
    }

    for (let [id, item] of deduped) {
      let changeCheck = this.vault.hasItemChanged(id, item)
      if (!changeCheck.changed) {
        skipped++
        continue
      }
      pushed++

      // P4: Compute checksumMap once per item
      let checksumMap = identity.buildPhotoChecksumMap(item)
      this._debug(`pushLocal: ${id.slice(0, 8)} — ${checksumMap.size} photo(s), first checksum: ${[...checksumMap.values()][0]?.slice(0, 12) || 'none'}...`)

      try {
        // Collect keys during push to avoid recomputing them in saveItemSnapshot
        let collectedKeys = {}
        this.doc.transact(() => {
          // Store photo checksums for fuzzy identity matching (merged items)
          let checksums = Array.from(checksumMap.values())
          if (checksums.length > 0) {
            schema.setItemChecksums(this.doc, id, checksums)
          }
          this.pushMetadata(item, id, userId, pushSeq)
          this.pushTags(item, id, userId, pushSeq)
          collectedKeys.noteKeys = this.pushNotes(item, id, userId, checksumMap, pushSeq)
          this.pushPhotoMetadata(item, id, userId, pushSeq)
          collectedKeys.selectionKeys = this.pushSelections(item, id, userId, checksumMap, pushSeq)
          collectedKeys.transcriptionKeys = this.pushTranscriptions(item, id, userId, checksumMap, pushSeq)
          if (this.options.syncLists) {
            this.pushLists(item, id, userId, pushSeq)
          }
          this.pushDeletions(item, id, userId, checksumMap, collectedKeys, pushSeq)
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

  pushMetadata(item, itemIdentity, userId, pushSeq) {
    if (!this.options.syncMetadata) return
    let existing = schema.getMetadata(this.doc, itemIdentity)

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
        // Logic-based: skip if remote author differs AND we haven't edited this field
        if (current.author !== userId) {
          let valueHash = this.vault._fastHash(`${text}|${type}`)
          if (!this.vault.hasLocalEdit(itemIdentity, key, valueHash)) {
            this._logConflict('metadata', itemIdentity, key, {
              local: text?.slice(0, 50),
              remote: current.text?.slice(0, 50),
              remoteAuthor: current.author
            })
            continue
          }
        }
      }

      schema.setMetadata(this.doc, itemIdentity, key, { text, type, language }, userId, pushSeq)
      this.vault.markFieldPushed(itemIdentity, key, this.vault._fastHash(`${text}|${type}`))
    }
  },

  pushTags(item, itemIdentity, userId, pushSeq) {
    if (!this.options.syncTags) return
    let tags = item.tag || item['https://tropy.org/v1/tropy#tag'] || []
    if (!Array.isArray(tags)) tags = [tags]

    let existingTagsList = schema.getTags(this.doc, itemIdentity)
    let existingTags = new Map(existingTagsList.map(t => [t.name.toLowerCase(), t]))

    for (let tag of tags) {
      let name = typeof tag === 'string' ? tag : (tag.name || tag['@value'] || '')
      let color = typeof tag === 'object' ? tag.color : null

      if (!name) continue

      let existing = existingTags.get(name.toLowerCase())
      if (existing && !existing.deleted) {
        if ((existing.color || null) === (color || null)) continue
        // Logic-based: skip if remote author differs AND we haven't edited this tag
        if (existing.author !== userId) {
          let valueHash = this.vault._fastHash(`tag:${name.toLowerCase()}:${color || ''}`)
          if (!this.vault.hasLocalEdit(itemIdentity, `tag:${name.toLowerCase()}`, valueHash)) {
            continue
          }
        }
      }

      // Don't resurrect tags that were explicitly tombstoned by a remote peer
      if (existing && existing.deleted && existing.author !== userId) {
        continue
      }

      schema.setTag(this.doc, itemIdentity, { name, color }, userId, pushSeq)
      this.vault.markFieldPushed(itemIdentity, `tag:${name.toLowerCase()}`, this.vault._fastHash(`tag:${name.toLowerCase()}:${color || ''}`))
    }
  },

  // UUID-based note keying (schema v4)
  pushNotes(item, itemIdentity, userId, checksumMap, pushSeq) {
    if (!this.options.syncNotes) return { noteKeys: new Set(), selectionNoteKeys: new Set() }
    let photos = item.photo || item['https://tropy.org/v1/tropy#photo'] || []
    if (!Array.isArray(photos)) photos = [photos]

    let existingNotes = schema.getNotes(this.doc, itemIdentity)

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
          // v4: UUID-based key — vault generates on first call, reuses thereafter
          let localNoteId = note['@id'] || note.id
          let noteUUID = localNoteId
            ? this.vault.getNoteKey(localNoteId, identity.generateNoteUUID())
            : identity.generateNoteUUID()

          pushedNoteKeys.add(noteUUID)

          let existingNote = existingNotes[noteUUID]
          if (existingNote && !existingNote.deleted &&
              existingNote.text === text && existingNote.html === html) {
            this.vault.appliedNoteKeys.add(noteUUID)
            continue
          }
          // Logic-based conflict: skip if remote author differs and we haven't edited
          if (existingNote && !existingNote.deleted && existingNote.author !== userId) {
            let valueHash = this.vault._fastHash(`note:${html || text}`)
            if (!this.vault.hasLocalEdit(itemIdentity, `note:${noteUUID}`, valueHash)) {
              continue
            }
          }

          schema.setNote(this.doc, itemIdentity, noteUUID, {
            text,
            html,
            language: note.language || null,
            photo: photoChecksum || null
          }, userId, pushSeq)
          this.vault.appliedNoteKeys.add(noteUUID)
          this.vault.markFieldPushed(itemIdentity, `note:${noteUUID}`, this.vault._fastHash(`note:${html || text}`))
        }
      }

      // Selection notes
      let selections = photo.selection || photo['https://tropy.org/v1/tropy#selection'] || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel || !photoChecksum) continue

        // v4: Use vault for selection UUID
        let localSelId = sel['@id'] || sel.id
        let selUUID = localSelId
          ? this.vault.getSelectionKey(localSelId, identity.generateSelectionUUID())
          : identity.computeSelectionFingerprint(photoChecksum, sel)

        let selNotes = sel.note || sel['https://tropy.org/v1/tropy#note'] || []
        if (!Array.isArray(selNotes)) selNotes = [selNotes]

        let existingSelNotes = schema.getSelectionNotes(this.doc, itemIdentity, selUUID)

        for (let note of selNotes) {
          if (!note) continue
          let text = note['@value'] || note.text || note['https://schema.org/text'] || ''
          let html = note.html || note['https://tropy.org/v1/tropy#html'] || ''
          if (typeof text === 'object') text = text['@value'] || ''
          if (typeof html === 'object') html = html['@value'] || ''

          // Skip notes applied by troparcel (have [author] prefix from sync)
          if (this._isSyncedNote(text, html)) continue

          if (text || html) {
            let localNoteId = note['@id'] || note.id
            let noteUUID = localNoteId
              ? this.vault.getNoteKey(localNoteId, identity.generateNoteUUID())
              : identity.generateNoteUUID()

            let compositeKey = `${selUUID}:${noteUUID}`
            pushedSelNoteKeys.add(compositeKey)

            let existingSelNote = existingSelNotes[compositeKey]
            if (existingSelNote &&
                existingSelNote.text === text && existingSelNote.html === html) {
              this.vault.appliedNoteKeys.add(compositeKey)
              continue
            }
            if (existingSelNote && !existingSelNote.deleted && existingSelNote.author !== userId) {
              let valueHash = this.vault._fastHash(`selnote:${html || text}`)
              if (!this.vault.hasLocalEdit(itemIdentity, `selnote:${compositeKey}`, valueHash)) {
                continue
              }
            }

            schema.setSelectionNote(this.doc, itemIdentity, selUUID, noteUUID, {
              text,
              html,
              language: note.language || null
            }, userId, pushSeq)
            this.vault.appliedNoteKeys.add(compositeKey)
          }
        }
      }
    }

    // Clean up stale CRDT entries authored by us
    this._cleanupStaleNotes(itemIdentity, userId, pushedNoteKeys, pushedSelNoteKeys)

    return { noteKeys: pushedNoteKeys, selectionNoteKeys: pushedSelNoteKeys }
  },

  /**
   * Remove stale CRDT note/selectionNote entries authored by this user
   * that are no longer in the current local note set.
   * Uses Y.Map.delete() for permanent removal (not tombstoning).
   *
   * Entries that are in previousSnapshot.noteKeys are left for pushDeletions
   * to tombstone — Y.Map.delete() would prevent tombstone creation.
   */
  _cleanupStaleNotes(itemIdentity, userId, pushedNoteKeys, pushedSelNoteKeys) {
    // Only clean up stale entries when deletion propagation is enabled.
    if (!this.options.syncDeletions) return

    let prev = this.previousSnapshot.get(itemIdentity)
    let prevNoteKeys = prev && prev.noteKeys ? prev.noteKeys : null
    let prevSelNoteKeys = prev && prev.selectionNoteKeys ? prev.selectionNoteKeys : null

    let allNotes = schema.getNotes(this.doc, itemIdentity)
    let removed = 0

    for (let [key, note] of Object.entries(allNotes)) {
      if (note.author !== userId) continue
      if (note.deleted) continue
      if (pushedNoteKeys.has(key)) continue
      // Leave for pushDeletions to tombstone
      if (prevNoteKeys && prevNoteKeys.has(key)) continue

      schema.deleteNoteEntry(this.doc, itemIdentity, key)
      removed++
    }

    let allSelNotes = schema.getAllSelectionNotes(this.doc, itemIdentity)
    for (let [key, note] of Object.entries(allSelNotes)) {
      if (note.author !== userId) continue
      if (note.deleted) continue
      if (pushedSelNoteKeys.has(key)) continue
      if (prevSelNoteKeys && prevSelNoteKeys.has(key)) continue

      schema.deleteSelectionNoteEntry(this.doc, itemIdentity, key)
      removed++
    }

    if (removed > 0) {
      this._log(`cleanupStaleNotes: removed ${removed} stale entry(s) for ${itemIdentity.slice(0, 8)}`)
    }
  },

  pushPhotoMetadata(item, itemIdentity, userId, pushSeq) {
    if (!this.options.syncPhotoAdjustments) return

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

        let current = existing[key]
        if (!text && !current) continue

        if (current) {
          if (current.text === text && current.type === type) continue
          if (current.author !== userId) {
            let valueHash = this.vault._fastHash(`${text}|${type}`)
            if (!this.vault.hasLocalEdit(itemIdentity, `photo:${checksum}:${key}`, valueHash)) {
              continue
            }
          }
        }

        schema.setPhotoMetadata(this.doc, itemIdentity, checksum, key, { text, type }, userId, pushSeq)
        this.vault.markFieldPushed(itemIdentity, `photo:${checksum}:${key}`, this.vault._fastHash(`${text}|${type}`))
      }
    }
  },

  // UUID-based selection keying (schema v4)
  pushSelections(item, itemIdentity, userId, checksumMap, pushSeq) {
    if (!this.options.syncSelections) return new Set()
    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    let existingSelections = schema.getSelections(this.doc, itemIdentity)
    let pushedSelectionKeys = new Set()

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      if (!photoChecksum) continue

      let selections = photo.selection || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel) continue

        // v4: UUID-based key
        let localSelId = sel['@id'] || sel.id
        let selUUID = localSelId
          ? this.vault.getSelectionKey(localSelId, identity.generateSelectionUUID())
          : identity.generateSelectionUUID()

        pushedSelectionKeys.add(selUUID)

        let existingSel = existingSelections[selUUID]
        let selUnchanged = existingSel && !existingSel.deleted &&
            existingSel.x === sel.x && existingSel.y === sel.y &&
            existingSel.w === sel.width && existingSel.h === sel.height &&
            (existingSel.angle || 0) === (sel.angle || 0)

        // Logic-based conflict check
        let remoteNewer = false
        if (existingSel && !existingSel.deleted && existingSel.author !== userId) {
          let valueHash = this.vault._fastHash(`sel:${sel.x}:${sel.y}:${sel.width}:${sel.height}`)
          remoteNewer = !this.vault.hasLocalEdit(itemIdentity, `sel:${selUUID}`, valueHash)
        }

        if (!selUnchanged && !remoteNewer) {
          schema.setSelection(this.doc, itemIdentity, selUUID, {
            x: sel.x,
            y: sel.y,
            width: sel.width,
            height: sel.height,
            angle: sel.angle || 0,
            photo: photoChecksum
          }, userId, pushSeq)
          this.vault.appliedSelectionKeys.add(selUUID)
          this.vault.markFieldPushed(itemIdentity, `sel:${selUUID}`,
            this.vault._fastHash(`sel:${sel.x}:${sel.y}:${sel.width}:${sel.height}`))
        } else if (selUnchanged) {
          this.vault.appliedSelectionKeys.add(selUUID)
        }

        // Selection metadata
        if (sel.metadata) {
          let existingSelMeta = schema.getSelectionMeta(this.doc, itemIdentity, selUUID)

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

            let existingSM = existingSelMeta[key]
            if (!text && !existingSM) continue

            if (existingSM) {
              if (existingSM.text === text && existingSM.type === type) continue
              if (existingSM.author !== userId) {
                let valueHash = this.vault._fastHash(`${text}|${type}`)
                if (!this.vault.hasLocalEdit(itemIdentity, `selmeta:${selUUID}:${key}`, valueHash)) {
                  continue
                }
              }
            }

            schema.setSelectionMeta(this.doc, itemIdentity, selUUID, key, { text, type }, userId, pushSeq)
            this.vault.markFieldPushed(itemIdentity, `selmeta:${selUUID}:${key}`, this.vault._fastHash(`${text}|${type}`))
          }
        }
      }
    }
    return pushedSelectionKeys
  },

  // UUID-based transcription keying (schema v4)
  pushTranscriptions(item, itemIdentity, userId, checksumMap, pushSeq) {
    if (!this.options.syncTranscriptions) return new Set()
    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    let pushedTranscriptionKeys = new Set()
    let existingTranscriptions = schema.getTranscriptions(this.doc, itemIdentity)

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      if (!photoChecksum) continue

      // Photo-level transcriptions
      let txs = photo.transcription || []
      if (!Array.isArray(txs)) txs = [txs]

      txs.forEach((tx, idx) => {
        if (!tx) return

        // Size guard: skip oversized transcriptions (ALTO XML can be very large)
        let txSize = (tx.text || '').length + JSON.stringify(tx.data || '').length
        if (txSize > this.options.maxNoteSize) {
          this.logger.warn(`Skipping oversized transcription (${txSize} bytes > ${this.options.maxNoteSize}) on photo ${photoChecksum.slice(0, 12)}`)
          return
        }

        // v4: UUID-based key
        let localTxId = tx['@id'] || tx.id
        let txUUID = localTxId
          ? this.vault.getTxKey(localTxId, identity.generateTranscriptionUUID())
          : identity.generateTranscriptionUUID()

        pushedTranscriptionKeys.add(txUUID)
        this.vault.appliedTranscriptionKeys.add(txUUID)

        let existingTx = existingTranscriptions[txUUID]
        if (existingTx && !existingTx.deleted && existingTx.text === (tx.text || '')) {
          return
        }
        if (existingTx && !existingTx.deleted && existingTx.author !== userId) {
          let valueHash = this.vault._fastHash(`tx:${tx.text || ''}`)
          if (!this.vault.hasLocalEdit(itemIdentity, `tx:${txUUID}`, valueHash)) {
            return
          }
        }

        schema.setTranscription(this.doc, itemIdentity, txUUID, {
          text: tx.text || '',
          data: tx.data || null,
          photo: photoChecksum
        }, userId, pushSeq)
        this.vault.markFieldPushed(itemIdentity, `tx:${txUUID}`, this.vault._fastHash(`tx:${tx.text || ''}`))
      })

      // Selection-level transcriptions
      let selections = photo.selection || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel) continue
        // v4: Use vault for selection UUID
        let localSelId = sel['@id'] || sel.id
        let selUUID = localSelId
          ? this.vault.getSelectionKey(localSelId, identity.generateSelectionUUID())
          : identity.computeSelectionFingerprint(photoChecksum, sel)

        let selTxs = sel.transcription || []
        if (!Array.isArray(selTxs)) selTxs = [selTxs]

        selTxs.forEach((tx, idx) => {
          if (!tx) return

          // Size guard: skip oversized transcriptions
          let txSize = (tx.text || '').length + JSON.stringify(tx.data || '').length
          if (txSize > this.options.maxNoteSize) {
            this.logger.warn(`Skipping oversized selection transcription (${txSize} bytes > ${this.options.maxNoteSize})`)
            return
          }

          let localTxId = tx['@id'] || tx.id
          let txUUID = localTxId
            ? this.vault.getTxKey(localTxId, identity.generateTranscriptionUUID())
            : identity.generateTranscriptionUUID()

          pushedTranscriptionKeys.add(txUUID)
          this.vault.appliedTranscriptionKeys.add(txUUID)

          let existingTx = existingTranscriptions[txUUID]
          if (existingTx && !existingTx.deleted && existingTx.text === (tx.text || '')) {
            return
          }
          if (existingTx && !existingTx.deleted && existingTx.author !== userId) {
            let valueHash = this.vault._fastHash(`tx:${tx.text || ''}`)
            if (!this.vault.hasLocalEdit(itemIdentity, `tx:${txUUID}`, valueHash)) {
              return
            }
          }

          schema.setTranscription(this.doc, itemIdentity, txUUID, {
            text: tx.text || '',
            data: tx.data || null,
            photo: photoChecksum,
            selection: selUUID
          }, userId, pushSeq)
          this.vault.markFieldPushed(itemIdentity, `tx:${txUUID}`, this.vault._fastHash(`tx:${tx.text || ''}`))
        })
      }
    }
    return pushedTranscriptionKeys
  },

  // UUID-based list keying (schema v4)
  pushLists(item, itemIdentity, userId, pushSeq) {
    let listIds = item.lists || []
    if (!Array.isArray(listIds)) return

    let existingLists = schema.getLists(this.doc, itemIdentity)

    for (let listId of listIds) {
      // C2: Use list name (not local ID) for cross-instance matching
      let listName = this._listNameCache.get(listId) || this._listNameCache.get(String(listId))
      if (!listName) {
        this._debug(`pushLists: skipping list ${listId} (name not in cache)`)
        continue
      }

      // v4: UUID-based key with name field
      let listUUID = this.vault.getListKey(listName)

      if (!listUUID) {
        // Check CRDT for existing entry with same name (from other peers)
        let found = Object.entries(existingLists).find(([_, v]) => v.name === listName && !v.deleted)
        if (found) {
          listUUID = found[0]
          this.vault.mapAppliedList(listUUID, listName)
        } else {
          listUUID = identity.generateListUUID()
          this.vault.mapAppliedList(listUUID, listName)
        }
      }

      let existing = existingLists[listUUID]
      if (existing && !existing.deleted && existing.member) continue
      if (existing && existing.author !== userId) {
        let valueHash = this.vault._fastHash(`list:${listName}`)
        if (!this.vault.hasLocalEdit(itemIdentity, `list:${listUUID}`, valueHash)) {
          continue
        }
      }

      schema.setListMembership(this.doc, itemIdentity, listUUID, listName, userId, pushSeq)
      this.vault.markFieldPushed(itemIdentity, `list:${listUUID}`, this.vault._fastHash(`list:${listName}`))
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
   * Compute all identity keys for an item's sub-resources.
   * v4: Uses UUID-based keys from vault instead of content-addressed keys.
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
        if (this._isSyncedNote(text, html)) continue
        if (text || html) {
          let localNoteId = note['@id'] || note.id
          let noteUUID = localNoteId
            ? this.vault.getNoteKey(localNoteId, identity.generateNoteUUID())
            : identity.generateNoteUUID()
          noteKeys.add(noteUUID)
        }
      }

      // Photo-level transcriptions
      let txs = photo.transcription || []
      if (!Array.isArray(txs)) txs = [txs]
      txs.forEach((tx, idx) => {
        if (!tx) return
        let localTxId = tx['@id'] || tx.id
        let txUUID = localTxId
          ? this.vault.getTxKey(localTxId, identity.generateTranscriptionUUID())
          : identity.generateTranscriptionUUID()
        transcriptionKeys.add(txUUID)
      })

      // Selections and their sub-resources
      let selections = photo.selection || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel || !photoChecksum) continue
        let localSelId = sel['@id'] || sel.id
        let selUUID = localSelId
          ? this.vault.getSelectionKey(localSelId, identity.generateSelectionUUID())
          : identity.generateSelectionUUID()
        selectionKeys.add(selUUID)

        // Selection notes
        let selNotes = sel.note || []
        if (!Array.isArray(selNotes)) selNotes = [selNotes]
        for (let note of selNotes) {
          if (!note) continue
          let text = note['@value'] || note.text || note['https://schema.org/text'] || ''
          let html = note.html || note['https://tropy.org/v1/tropy#html'] || ''
          if (typeof text === 'object') text = text['@value'] || ''
          if (typeof html === 'object') html = html['@value'] || ''
          if (this._isSyncedNote(text, html)) continue
          if (text || html) {
            let localNoteId = note['@id'] || note.id
            let noteUUID = localNoteId
              ? this.vault.getNoteKey(localNoteId, identity.generateNoteUUID())
              : identity.generateNoteUUID()
            selectionNoteKeys.add(`${selUUID}:${noteUUID}`)
          }
        }

        // Selection transcriptions
        let selTxs = sel.transcription || []
        if (!Array.isArray(selTxs)) selTxs = [selTxs]
        selTxs.forEach((tx, idx) => {
          if (!tx) return
          let localTxId = tx['@id'] || tx.id
          let txUUID = localTxId
            ? this.vault.getTxKey(localTxId, identity.generateTranscriptionUUID())
            : identity.generateTranscriptionUUID()
          transcriptionKeys.add(txUUID)
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

  pushDeletions(item, itemIdentity, userId, checksumMap, collectedKeys, pushSeq) {
    if (!this.options.syncDeletions) return
    let prev = this.previousSnapshot.get(itemIdentity)
    if (!prev) return

    // Detect removed tags (only when syncTags is enabled)
    if (this.options.syncTags) {
      let currentTags = this._resolveTagNames(item)
      let currentTagsLower = new Set([...currentTags].map(n => n.toLowerCase()))
      for (let tagName of prev.tags) {
        if (!currentTagsLower.has(tagName.toLowerCase())) {
          schema.removeTag(this.doc, itemIdentity, tagName, userId, pushSeq)
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
          schema.removeNote(this.doc, itemIdentity, noteKey, userId, pushSeq)
        }
      }
    }

    // Tombstone removed selections (only when syncSelections is enabled)
    if (this.options.syncSelections && prev.selectionKeys) {
      for (let selKey of prev.selectionKeys) {
        if (!current.selectionKeys.has(selKey)) {
          schema.removeSelection(this.doc, itemIdentity, selKey, userId, pushSeq)
        }
      }
    }

    // Tombstone removed transcriptions (only when syncTranscriptions is enabled)
    if (this.options.syncTranscriptions && prev.transcriptionKeys) {
      for (let txKey of prev.transcriptionKeys) {
        if (!current.transcriptionKeys.has(txKey)) {
          schema.removeTranscription(this.doc, itemIdentity, txKey, userId, pushSeq)
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
            schema.removeSelectionNote(this.doc, itemIdentity, selKey, noteKey, userId, pushSeq)
          }
        }
      }
    }

    // Tombstone removed list memberships
    if (prev.listNames && this.options.syncLists) {
      for (let listName of prev.listNames) {
        if (!current.listNames.has(listName)) {
          // Find the UUID for this list name
          let listUUID = this.vault.getListKey(listName)
          if (listUUID) {
            schema.removeListMembership(this.doc, itemIdentity, listUUID, userId, pushSeq)
          }
        }
      }
    }
  },

  /**
   * Detect notes that were applied by troparcel from remote sync.
   */
  _isSyncedNote(text, html) {
    if (!html && !text) return false
    // v5.0+: identifier at bottom of note
    if (html && html.includes('[troparcel:')) return true
    if (text && text.includes('[troparcel:')) return true
    // Legacy: identifier at top (v4.0-v4.12)
    if (html && html.includes('<blockquote><p><em>troparcel:')) return true
    if (html && html.includes('<p><strong>[troparcel:')) return true
    return false
  },

  // --- Manual push (export hook) ---

  // Expand compacted JSON-LD metadata keys back to full URIs.
  _expandJsonLdItem(item, context) {
    if (!context) return item
    let expanded = {}
    for (let [key, value] of Object.entries(item)) {
      if (key.startsWith('@')) { expanded[key] = value; continue }
      if (key.includes('/')) { expanded[key] = value; continue }
      if (['photo', 'template', 'list', 'lists', 'tag', 'note',
           'selection', 'transcription', 'id', 'type'].includes(key)) {
        expanded[key] = value; continue
      }
      if (key.includes(':')) {
        let [prefix, name] = key.split(':', 2)
        let vocab = context[prefix]
        if (typeof vocab === 'string' && vocab.includes('/')) {
          expanded[vocab + name] = value
        } else {
          expanded[key] = value
        }
        continue
      }
      let ctxEntry = context[key]
      if (ctxEntry) {
        let fullUri = typeof ctxEntry === 'string' ? ctxEntry
          : (ctxEntry['@id'] || null)
        if (fullUri) {
          if (typeof ctxEntry === 'object' && ctxEntry['@type'] && typeof value === 'string') {
            expanded[fullUri] = { '@value': value, '@type': ctxEntry['@type'] }
          } else {
            expanded[fullUri] = value
          }
          continue
        }
      }
      if (context['@vocab']) {
        expanded[context['@vocab'] + key] = value
        continue
      }
      expanded[key] = value
    }
    return expanded
  },

  pushItems(items, context) {
    if (!this.doc) return

    let userId = this._stableUserId
    let pushSeq = this.vault.nextPushSeq()

    this.doc.transact(() => {
      for (let item of items) {
        let normalized = context ? this._expandJsonLdItem(item, context) : item
        let id = identity.computeIdentity(normalized)
        if (!id) {
          this._debug(`pushItems: skipped photo-less item ${(normalized['@id'] || normalized.id || '?').toString().slice(0, 20)}`)
          continue
        }
        let checksumMap = identity.buildPhotoChecksumMap(normalized)
        this.pushMetadata(normalized, id, userId, pushSeq)
        this.pushTags(normalized, id, userId, pushSeq)
        this.pushNotes(normalized, id, userId, checksumMap, pushSeq)
        this.pushPhotoMetadata(normalized, id, userId, pushSeq)
        this.pushSelections(normalized, id, userId, checksumMap, pushSeq)
        this.pushTranscriptions(normalized, id, userId, checksumMap, pushSeq)
        if (this.options.syncLists) {
          this.pushLists(normalized, id, userId, pushSeq)
        }
      }
    }, this.LOCAL_ORIGIN)
  }
}
