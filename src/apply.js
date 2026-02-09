'use strict'

const identity = require('./identity')
const schema = require('./crdt-schema')
const { sanitizeHtml, escapeHtml } = require('./sanitize')

/**
 * Apply mixin — CRDT → local write methods.
 *
 * These methods are mixed onto SyncEngine.prototype via Object.assign.
 * All `this` references resolve to the SyncEngine instance at call time.
 */
module.exports = {

  // P6: Write delay only between items, not between individual fields.
  // Skipped when store adapter is available — dispatch is synchronous via saga.
  _writeDelay() {
    if (this.adapter) return Promise.resolve()
    return new Promise(r => setTimeout(r, this.options.writeDelay))
  },

  /**
   * Wrap block-level content in strikethrough spans.
   * Uses CSS style to match Tropy's ProseMirror schema (which only
   * recognizes style="text-decoration: line-through", not <s> tags).
   */
  _applyStrikethrough(html) {
    let open = '<span style="text-decoration: line-through">'
    return html
      .replace(/(<(?:p|li|h[1-6])>)/gi, `$1${open}`)
      .replace(/(<\/(?:p|li|h[1-6])>)/gi, '</span>$1')
  },

  async applyRemoteAnnotations(itemIdentity, local, tagMap, listMap) {
    let localId = local.localId
    let userId = this._stableUserId

    this._debug(`applyAnnotations: item ${localId}, identity ${itemIdentity.slice(0, 8)}...`)

    // Snapshot stats before this item to detect if anything changed
    let s = this._applyStats
    let before = s ? (s.notesCreated + s.notesUpdated + s.tagsAdded +
      s.selectionsCreated + s.metadataUpdated + s.transcriptionsCreated +
      s.listsAdded + s.notesRetracted) : 0

    // Apply metadata (batched — no per-field delay)
    await this.applyMetadata(itemIdentity, localId, userId, local.item)

    // P6: Single delay between major phases
    await this._writeDelay()

    await this.applyTags(itemIdentity, localId, userId, tagMap, local.item)
    await this._writeDelay()

    await this.applyNotes(itemIdentity, local, userId)
    await this._writeDelay()

    if (this.options.syncPhotoAdjustments) {
      await this.applyPhotoMetadata(itemIdentity, local, userId)
      await this._writeDelay()
    }

    await this.applySelections(itemIdentity, local, userId)
    await this._writeDelay()

    await this.applySelectionNotes(itemIdentity, local, userId)
    await this._writeDelay()

    if (this.options.syncPhotoAdjustments) {
      await this.applySelectionMetadata(itemIdentity, local, userId)
      await this._writeDelay()
    }

    await this.applyTranscriptions(itemIdentity, local, userId)

    if (this.options.syncLists) {
      await this._writeDelay()
      await this.applyLists(itemIdentity, local, userId, listMap)
    }

    if (s) {
      s.itemsProcessed++
      let after = s.notesCreated + s.notesUpdated + s.tagsAdded +
        s.selectionsCreated + s.metadataUpdated + s.transcriptionsCreated +
        s.listsAdded + s.notesRetracted
      if (after > before) s.itemsChanged++
    }
  },

  // P6: No per-field delay within metadata apply
  async applyMetadata(itemIdentity, localId, userId, localItem) {
    if (!this.options.syncMetadata) return
    let remoteMeta = schema.getMetadata(this.doc, itemIdentity)
    let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0
    let batch = {}
    for (let [prop, value] of Object.entries(remoteMeta)) {
      if (value.author === userId) continue

      // Diff: skip if local already has same value
      let localVal = localItem[prop]
      if (localVal != null) {
        let localText = typeof localVal === 'object'
          ? (localVal['@value'] || localVal.text || '')
          : String(localVal)
        if (localText === (value.text || '')) continue
        // Only skip older remote values when local has a value (protects local edits)
        if (value.ts && value.ts < lastPushTs) continue
      }

      batch[prop] = { text: value.text, type: value.type }
    }

    let batchKeys = Object.keys(batch)
    if (batchKeys.length > 0) {
      try {
        await this.api.saveMetadata(localId, batch)
        if (this._applyStats) this._applyStats.metadataUpdated += batchKeys.length
        this._debug(`metadata: ${batchKeys.length} field(s) on item ${localId}`)
      } catch (err) {
        this.logger.warn(`Failed to save metadata batch on ${localId}`, {
          error: err.message
        })
      }
    }
  },

  async applyTags(itemIdentity, localId, userId, tagMap, localItem) {
    if (!this.options.syncTags) return

    // Build set of tag names already on this item
    let localTagNames = new Set()
    let localTags = localItem.tag || []
    for (let t of localTags) {
      if (t && t.name) localTagNames.add(t.name)
    }

    let activeTags = schema.getActiveTags(this.doc, itemIdentity)
    for (let tag of activeTags) {
      if (tag.author === userId) continue

      // Diff: skip if item already has this tag
      if (localTagNames.has(tag.name)) continue

      let existing = tagMap.get(tag.name)
      if (!existing) {
        try {
          let created = await this.api.createTag(tag.name, tag.color, [localId])
          localTagNames.add(tag.name)
          // Update tagMap so subsequent items in this batch can use addTagsToItem
          if (created && (created.id || created.tag_id)) {
            tagMap.set(tag.name, created)
          }
          if (this._applyStats) this._applyStats.tagsAdded++
          this._debug(`tag created: "${tag.name}" on item ${localId}`)
          continue
        } catch (err) {
          this.logger.warn(`Failed to create tag "${tag.name}"`, { error: err.message })
          continue
        }
      }

      try {
        await this.api.addTagsToItem(localId, [existing.id || existing.tag_id])
        localTagNames.add(tag.name)
        if (this._applyStats) this._applyStats.tagsAdded++
        this._debug(`tag added: "${tag.name}" on item ${localId}`)
      } catch (err) {
        this.logger.warn(`Failed to add tag "${tag.name}" to item ${localId}`, { error: err.message })
      }
    }

    if (!this.options.syncDeletions) return

    let deletedTags = schema.getDeletedTags(this.doc, itemIdentity)
    for (let tag of deletedTags) {
      if (tag.author === userId) continue

      // Diff: skip if item doesn't have this tag anyway
      if (!localTagNames.has(tag.name)) continue

      let existing = tagMap.get(tag.name)
      if (existing) {
        try {
          await this.api.removeTagsFromItem(localId, [existing.id || existing.tag_id])
        } catch (err) {
          this.logger.warn(`Failed to remove tag "${tag.name}" from item ${localId}`, { error: err.message })
        }
      }
    }
  },

  /**
   * Build a dedup set from existing local notes (text + html with prefix stripping).
   */
  _buildExistingNoteTexts(notes) {
    let set = new Set()
    for (let n of notes) {
      if (n && n.text) {
        set.add(n.text.trim())
        let stripped = n.text
          .replace(/^troparcel:\s*[^\n]*\n?/, '')
          .replace(/^\[(?:troparcel:)?[^\]]{1,80}\]\s*/, '')
          .trim()
        if (stripped) set.add(stripped)
      }
      if (n && n.html) {
        set.add(n.html.trim())
        let strippedHtml = n.html
          .replace(/^<blockquote><p><em>troparcel:[^<]*<\/em><\/p><\/blockquote>/, '')
          .replace(/^<p><strong>\[[^\]]*\]<\/strong><\/p>/, '')
          .trim()
        if (strippedHtml) set.add(strippedHtml)
      }
    }
    return set
  },

  /**
   * Apply a single remote note: sanitize, dedup, update-or-create.
   * Shared by applyNotes and applySelectionNotes.
   *
   * @param {string} noteKey - vault key for this note
   * @param {Object} note - remote note data
   * @param {Object} parent - { photo, selection } — which parent to attach to
   * @param {Set} existingTexts - dedup set (mutated on create)
   * @param {string} userId - local user ID
   * @param {string} label - label for log messages (e.g. "note" or "sel note")
   * @returns {boolean} true if note was created/updated, false if skipped
   */
  async _applyRemoteNote(noteKey, note, parent, existingTexts, userId, label) {
    let safeHtml = note.html
      ? sanitizeHtml(note.html)
      : `<p>${escapeHtml(note.text)}</p>`

    let authorLabel = escapeHtml(note.author || 'unknown')
    safeHtml = `<blockquote><p><em>troparcel: ${authorLabel}</em></p></blockquote>${safeHtml}`

    // Content-based dedup — match exact HTML to avoid cross-domain false positives
    if (existingTexts.has(safeHtml.trim())) {
      this.vault.appliedNoteKeys.add(noteKey)
      if (this._applyStats) this._applyStats.notesDeduped++
      return false
    }

    // C1: Check if we've already applied this note (update instead of re-create)
    let existingLocalId = this.vault.getLocalNoteId(noteKey)
    if (existingLocalId) {
      try {
        if (this.adapter) {
          let result = await this.adapter.updateNote(existingLocalId, { html: safeHtml })
          if (result && (result.id || result['@id'])) {
            this.vault.appliedNoteKeys.add(noteKey)
            this.vault.mapAppliedNote(noteKey, result.id || result['@id'])
          }
        } else {
          await this.api.updateNote(existingLocalId, { html: safeHtml })
          this.vault.appliedNoteKeys.add(noteKey)
        }
        if (this._applyStats) this._applyStats.notesUpdated++
        this._debug(`${label} updated: ${noteKey.slice(0, 8)}`)
        return true
      } catch (err) {
        // Note might have been deleted locally — fall through to create
        this.logger.warn(`${label} update failed for ${noteKey.slice(0, 8)}, falling through to create`, { error: String(err.message || err) })
      }
    }

    try {
      let created
      let payload = {
        html: safeHtml,
        language: note.language,
        photo: parent.photo || null,
        selection: parent.selection || null
      }
      if (this.adapter) {
        created = await this.adapter.createNote(payload)
      } else {
        created = await this.api.createNote(payload)
      }
      if (created && (created.id || created['@id'])) {
        this.vault.mapAppliedNote(noteKey, created.id || created['@id'])
        this.vault.appliedNoteKeys.add(noteKey)
        existingTexts.add(safeHtml.trim())
        if (this._applyStats) this._applyStats.notesCreated++
        this._debug(`${label} created: ${noteKey.slice(0, 8)} by ${note.author}`)
        return true
      } else {
        this.logger.warn({ ...parent, noteKey: noteKey.slice(0, 8), author: note.author },
          `${label}.create returned null`)
        if (this._applyStats) this._applyStats.notesFailed++
        this._failedNoteKeys.add(noteKey)
      }
    } catch (err) {
      this.logger.warn(`Failed to create ${label}`, {
        error: err.message, ...parent, noteKey: noteKey.slice(0, 8)
      })
      if (this._applyStats) this._applyStats.notesFailed++
      this._failedNoteKeys.add(noteKey)
    }
    return false
  },

  // C1: Stores vault mapping when applying remote notes
  async applyNotes(itemIdentity, local, userId) {
    if (!this.options.syncNotes) return
    let localId = local.localId

    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    // Build index of existing local notes for content-based dedup
    let allLocalNotes = []
    for (let p of photos) {
      for (let n of (p.note || [])) allLocalNotes.push(n)
    }
    let existingNoteTexts = this._buildExistingNoteTexts(allLocalNotes)

    // Also process tombstoned notes to update previously-applied notes as retracted
    let allNotes = schema.getNotes(this.doc, itemIdentity)
    let remoteNotes = {}
    let tombstonedNotes = {}
    for (let [key, val] of Object.entries(allNotes)) {
      if (val.deleted) {
        tombstonedNotes[key] = val
      } else {
        remoteNotes[key] = val
      }
    }

    for (let [noteKey, note] of Object.entries(remoteNotes)) {
      if (note.author === userId) continue
      if (!note.html && !note.text) continue
      if (this.vault.appliedNoteKeys.has(noteKey)) {
        // Verify the mapped local note still exists (user may have deleted it)
        let mappedId = this.vault.getLocalNoteId(noteKey)
        if (mappedId && this.adapter) {
          let state = this.adapter._getState()
          if (!state.notes[mappedId]) {
            // Local note was deleted — allow re-apply from remote
            this.vault.appliedNoteKeys.delete(noteKey)
            this._debug(`note ${noteKey.slice(0, 8)}: local note ${mappedId} deleted, allowing re-apply`)
          } else {
            continue
          }
        } else {
          continue
        }
      }

      // Find the right photo by checksum
      let photoId = null
      if (note.photo) {
        for (let p of photos) {
          if (p.checksum === note.photo) {
            photoId = p['@id'] || p.id
            break
          }
        }
        // Skip note if specified photo checksum not found locally
        if (!photoId) continue
      } else {
        // No checksum specified — use first photo
        photoId = photos[0] && (photos[0]['@id'] || photos[0].id)
        if (!photoId) continue
      }

      await this._applyRemoteNote(
        noteKey, note,
        { photo: Number(photoId) || null },
        existingNoteTexts, userId, 'note'
      )
    }

    // Handle tombstoned notes: apply strikethrough to show retracted content
    for (let [noteKey, note] of Object.entries(tombstonedNotes)) {
      if (note.author === userId) continue
      let existingLocalId = this.vault.getLocalNoteId(noteKey)
      if (!existingLocalId) continue

      let authorLabel = escapeHtml(note.author || 'unknown')
      // Tombstone preserves original text/html via ...existing spread
      let contentHtml = note.html
        ? sanitizeHtml(note.html)
        : (note.text ? `<p>${escapeHtml(note.text)}</p>` : '')
      let retractedHtml = `<blockquote><p><em>troparcel: ${authorLabel} [retracted]</em></p></blockquote>${this._applyStrikethrough(contentHtml)}`

      try {
        let retracted = false
        if (this.adapter) {
          let result = await this.adapter.updateNote(existingLocalId, { html: retractedHtml })
          if (result && (result.id || result['@id'])) {
            this.vault.mapAppliedNote(noteKey, result.id || result['@id'])
            retracted = true
          }
        } else {
          // API fallback: note.update returns 404, so mark as applied to stop retrying
          this._debug(`note retraction skipped (no adapter) for ${noteKey.slice(0, 8)}`)
          this.vault.appliedNoteKeys.add(noteKey)
        }
        if (retracted) {
          this.vault.appliedNoteKeys.add(noteKey)
          if (this._applyStats) this._applyStats.notesRetracted++
          this._debug(`note retracted: ${noteKey.slice(0, 8)} by ${note.author}`)
        }
      } catch (err) {
        this.logger.warn(`Failed to retract note ${noteKey.slice(0, 8)}`, { error: String(err.message || err) })
      }
    }
  },

  async applyPhotoMetadata(itemIdentity, local, userId) {
    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]
    let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0

    for (let photo of photos) {
      let checksum = photo.checksum
      let localPhotoId = photo['@id'] || photo.id
      if (!checksum || !localPhotoId) continue

      let remoteMeta = schema.getPhotoMetadata(this.doc, itemIdentity, checksum)
      let localMeta = photo.metadata || {}

      // P6: Batch metadata writes per photo
      let batch = {}
      for (let [prop, value] of Object.entries(remoteMeta)) {
        if (value.author === userId) continue

        // Diff: skip if local already has same value
        let localVal = localMeta[prop]
        if (localVal != null) {
          let localText = typeof localVal === 'object'
            ? (localVal['@value'] || localVal.text || '')
            : String(localVal)
          if (localText === (value.text || '')) continue
          // Skip older remote values when local has a value (protects local edits)
          if (value.ts && value.ts < lastPushTs) continue
        }

        batch[prop] = { text: value.text, type: value.type }
      }

      let photoBatchKeys = Object.keys(batch)
      if (photoBatchKeys.length > 0) {
        try {
          await this.api.saveMetadata(localPhotoId, batch)
          if (this._applyStats) this._applyStats.metadataUpdated += photoBatchKeys.length
        } catch (err) {
          this.logger.warn(`Failed to save photo metadata batch`, { error: err.message })
        }
      }
    }
  },

  async applySelections(itemIdentity, local, userId) {
    if (!this.options.syncSelections) return
    let remoteSelections = schema.getActiveSelections(this.doc, itemIdentity)

    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    // Pre-build Set of existing local selection keys for O(1) dedup
    let existingSelKeys = new Set()
    for (let p of photos) {
      if (!p.checksum) continue
      let localSels = p.selection || []
      if (!Array.isArray(localSels)) localSels = [localSels]
      for (let ls of localSels) {
        if (ls) existingSelKeys.add(identity.computeSelectionKey(p.checksum, ls))
      }
    }

    for (let [selKey, sel] of Object.entries(remoteSelections)) {
      if (sel.author === userId) continue
      if (this.vault.appliedSelectionKeys.has(selKey)) continue

      let x = Number(sel.x)
      let y = Number(sel.y)
      let w = Number(sel.w)
      let h = Number(sel.h)
      if (!Number.isFinite(x) || !Number.isFinite(y) ||
          !Number.isFinite(w) || !Number.isFinite(h) ||
          w <= 0 || h <= 0) {
        this._log(`Skipping selection ${selKey}: invalid coordinates`, { x, y, w, h })
        continue
      }

      let localPhotoId = null
      for (let p of photos) {
        if (p.checksum === sel.photo) {
          localPhotoId = p['@id'] || p.id
          break
        }
      }
      if (!localPhotoId) continue

      // Pre-built Set lookup instead of O(n²) nested loop
      let alreadyExists = existingSelKeys.has(selKey)

      if (!alreadyExists) {
        try {
          if (this.adapter) {
            await this.adapter.createSelection({
              photo: Number(localPhotoId),
              x,
              y,
              width: w,
              height: h,
              angle: sel.angle || 0
            })
          } else {
            await this.api.createSelection({
              photo: Number(localPhotoId),
              x,
              y,
              width: w,
              height: h,
              angle: sel.angle || 0
            })
          }
          this.vault.appliedSelectionKeys.add(selKey)
          if (this._applyStats) this._applyStats.selectionsCreated++
          this._debug(`selection created: ${selKey.slice(0, 8)} on photo ${localPhotoId}`)
        } catch (err) {
          this.logger.warn(`Failed to create selection on photo ${localPhotoId}`, {
            error: err.message
          })
          // Don't mark applied on failure — allow retry on next cycle
        }
      } else {
        this.vault.appliedSelectionKeys.add(selKey)
      }
    }
  },

  async applySelectionNotes(itemIdentity, local, userId) {
    if (!this.options.syncNotes) return
    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    // Build tombstone index grouped by selKey prefix (avoids O(n²) inner loop)
    let allSelNotes = schema.getAllSelectionNotes(this.doc, itemIdentity)
    let tombstonesBySelKey = new Map()
    for (let [compositeKey, note] of Object.entries(allSelNotes)) {
      if (!note.deleted) continue
      let sepIdx = compositeKey.indexOf(':')
      if (sepIdx > 0) {
        let prefix = compositeKey.slice(0, sepIdx)
        if (!tombstonesBySelKey.has(prefix)) tombstonesBySelKey.set(prefix, [])
        tombstonesBySelKey.get(prefix).push([compositeKey, note])
      }
    }

    for (let photo of photos) {
      let checksum = photo.checksum
      if (!checksum) continue

      let localSels = photo.selection || []
      if (!Array.isArray(localSels)) localSels = [localSels]

      for (let sel of localSels) {
        if (!sel) continue

        let existingTexts = this._buildExistingNoteTexts(sel.note || [])

        let selKey = identity.computeSelectionKey(checksum, sel)
        let remoteNotes = schema.getSelectionNotes(this.doc, itemIdentity, selKey)

        for (let [compositeKey, note] of Object.entries(remoteNotes)) {
          if (note.author === userId) continue
          if (!note.html && !note.text) continue
          if (this.vault.appliedNoteKeys.has(compositeKey)) {
            // Verify the mapped local note still exists
            let mappedId = this.vault.getLocalNoteId(compositeKey)
            if (mappedId && this.adapter) {
              let state = this.adapter._getState()
              if (!state.notes[mappedId]) {
                this.vault.appliedNoteKeys.delete(compositeKey)
                this._debug(`sel note ${compositeKey.slice(0, 8)}: local note ${mappedId} deleted, allowing re-apply`)
              } else {
                continue
              }
            } else {
              continue
            }
          }

          let localSelId = sel['@id'] || sel.id
          if (!localSelId) continue

          await this._applyRemoteNote(
            compositeKey, note,
            { selection: Number(localSelId) || null },
            existingTexts, userId, 'sel note'
          )
        }

        // Handle tombstoned selection notes: apply strikethrough
        let selTombstones = tombstonesBySelKey.get(selKey) || []
        for (let [compositeKey, note] of selTombstones) {
          if (note.author === userId) continue
          let existingLocalId = this.vault.getLocalNoteId(compositeKey)
          if (!existingLocalId) continue

          let authorLabel = escapeHtml(note.author || 'unknown')
          let contentHtml = note.html
            ? sanitizeHtml(note.html)
            : (note.text ? `<p>${escapeHtml(note.text)}</p>` : '')
          let retractedHtml = `<blockquote><p><em>troparcel: ${authorLabel} [retracted]</em></p></blockquote>${this._applyStrikethrough(contentHtml)}`

          try {
            let retracted = false
            if (this.adapter) {
              let result = await this.adapter.updateNote(existingLocalId, { html: retractedHtml })
              if (result && (result.id || result['@id'])) {
                this.vault.mapAppliedNote(compositeKey, result.id || result['@id'])
                retracted = true
              }
            } else {
              // API fallback: note.update returns 404, so mark as applied to stop retrying
              this._debug(`sel note retraction skipped (no adapter) for ${compositeKey.slice(0, 8)}`)
              this.vault.appliedNoteKeys.add(compositeKey)
            }
            if (retracted) {
              this.vault.appliedNoteKeys.add(compositeKey)
              if (this._applyStats) this._applyStats.notesRetracted++
              this._debug(`sel note retracted: ${compositeKey.slice(0, 8)} by ${note.author}`)
            }
          } catch (err) {
            this.logger.warn(`Failed to retract sel note ${compositeKey.slice(0, 8)}`, { error: String(err.message || err) })
          }
        }
      }
    }
  },

  async applySelectionMetadata(itemIdentity, local, userId) {
    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]
    let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0

    for (let photo of photos) {
      let checksum = photo.checksum
      if (!checksum) continue

      let localSels = photo.selection || []
      if (!Array.isArray(localSels)) localSels = [localSels]

      for (let sel of localSels) {
        if (!sel) continue
        let selKey = identity.computeSelectionKey(checksum, sel)
        let localSelId = sel['@id'] || sel.id
        if (!localSelId) continue

        let remoteMeta = schema.getSelectionMeta(this.doc, itemIdentity, selKey)
        let localMeta = sel.metadata || {}

        // P6: Batch writes
        let batch = {}
        for (let [prop, value] of Object.entries(remoteMeta)) {
          if (value.author === userId) continue

          // Diff: skip if local already has same value
          let localVal = localMeta[prop]
          if (localVal != null) {
            let localText = typeof localVal === 'object'
              ? (localVal['@value'] || localVal.text || '')
              : String(localVal)
            if (localText === (value.text || '')) continue
            // Skip older remote values when local has a value (protects local edits)
            if (value.ts && value.ts < lastPushTs) continue
          }

          batch[prop] = { text: value.text, type: value.type }
        }

        let selBatchKeys = Object.keys(batch)
        if (selBatchKeys.length > 0) {
          try {
            await this.api.saveMetadata(localSelId, batch)
            if (this._applyStats) this._applyStats.metadataUpdated += selBatchKeys.length
          } catch (err) {
            this.logger.warn(`Failed to save selection metadata`, { error: err.message })
          }
        }
      }
    }
  },

  // C3: Stores vault mapping when applying remote transcriptions
  async applyTranscriptions(itemIdentity, local, userId) {
    if (!this.options.syncTranscriptions) return
    let remoteTranscriptions = schema.getActiveTranscriptions(this.doc, itemIdentity)

    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    // Pre-build lookup maps to avoid O(photos × selections) per transcription
    let photoByChecksum = new Map()
    let selKeyToLocalId = new Map()
    for (let p of photos) {
      if (p.checksum) {
        photoByChecksum.set(p.checksum, p['@id'] || p.id)
        let sels = p.selection || []
        if (!Array.isArray(sels)) sels = [sels]
        for (let s of sels) {
          if (!s) continue
          let sk = identity.computeSelectionKey(p.checksum, s)
          selKeyToLocalId.set(sk, s['@id'] || s.id)
        }
      }
    }

    for (let [txKey, tx] of Object.entries(remoteTranscriptions)) {
      if (tx.author === userId) continue
      if (!tx.text && !tx.data) continue
      if (this.vault.appliedTranscriptionKeys.has(txKey)) continue

      let localPhotoId = photoByChecksum.get(tx.photo) || null
      if (!localPhotoId) continue

      let localSelId = tx.selection ? (selKeyToLocalId.get(tx.selection) || null) : null

      // C3: Check for existing mapping (update vs create)
      // Note: HTTP PUT for transcriptions returns 404 (no route).
      // With adapter unavailable, fall through to delete + recreate.
      let existingLocalId = this.vault.getLocalTxId(txKey)
      if (existingLocalId) {
        try {
          // Capture original for rollback
          let originalTx = null
          try { originalTx = await this.api.getTranscription(existingLocalId) } catch {}

          // Delete old, recreate with new content (update not supported via HTTP)
          try { await this.api.deleteTranscription(existingLocalId) } catch (delErr) {
            this.logger.warn(`Failed to delete transcription ${existingLocalId}`, { error: String(delErr.message || delErr) })
          }
          let created = await this.api.createTranscription({
            text: tx.text,
            data: tx.data,
            photo: Number(localPhotoId) || null,
            selection: localSelId ? Number(localSelId) : null
          })
          if (created && (created.id || created['@id'])) {
            this.vault.mapAppliedTranscription(txKey, created.id || created['@id'])
            this.vault.appliedTranscriptionKeys.add(txKey)
          } else if (originalTx) {
            // Create returned null — attempt to restore original
            this.logger.warn(`Transcription update returned null for ${txKey.slice(0, 8)}, restoring original`)
            try {
              let restored = await this.api.createTranscription({
                text: originalTx.text || '',
                data: originalTx.data || null,
                photo: Number(localPhotoId) || null,
                selection: localSelId ? Number(localSelId) : null
              })
              if (restored && (restored.id || restored['@id'])) {
                this.vault.mapAppliedTranscription(txKey, restored.id || restored['@id'])
              }
            } catch (restoreErr) {
              this.logger.warn(`Transcription restore also failed for ${txKey.slice(0, 8)}`, { error: String(restoreErr.message || restoreErr) })
            }
          }
          continue
        } catch (err) {
          this.logger.warn(`Failed to update transcription ${txKey.slice(0, 8)}`, { error: String(err.message || err) })
        }
      }

      try {
        let created = await this.api.createTranscription({
          text: tx.text,
          data: tx.data,
          photo: Number(localPhotoId) || null,
          selection: localSelId ? Number(localSelId) : null
        })
        if (created && (created.id || created['@id'])) {
          this.vault.mapAppliedTranscription(txKey, created.id || created['@id'])
          this.vault.appliedTranscriptionKeys.add(txKey)
          if (this._applyStats) this._applyStats.transcriptionsCreated++
          this._debug(`transcription created: ${txKey.slice(0, 8)} by ${tx.author}`)
        }
      } catch (err) {
        this.logger.warn(`Failed to create transcription`, {
          error: err.message
        })
        // Don't mark applied on failure — allow retry on next cycle
      }
    }
  },

  // C2: Matches lists by name for cross-instance compatibility
  async applyLists(itemIdentity, local, userId, listMap) {
    let remoteLists = schema.getActiveLists(this.doc, itemIdentity)
    let localId = local.localId

    // I5: Build set of lists this item already belongs to
    let localListNames = new Set()
    for (let listId of (local.item.lists || [])) {
      let name = this._listNameCache.get(listId) || this._listNameCache.get(String(listId))
      if (name) localListNames.add(name)
    }

    for (let [listKey, list] of Object.entries(remoteLists)) {
      if (list.author === userId) continue
      if (localListNames.has(listKey)) continue  // Already in list

      // C2: Match by name
      let localList = listMap.get(listKey)
      if (localList) {
        try {
          if (this.adapter) {
            await this.adapter.addItemsToList(localList.id, [localId])
          } else {
            await this.api.addItemsToList(localList.id, [localId])
          }
          localListNames.add(listKey)
          if (this._applyStats) this._applyStats.listsAdded++
          this._debug(`list add: item ${localId} → "${listKey}"`)
        } catch (err) {
          this.logger.warn(`Failed to add item ${localId} to list "${listKey}"`, { error: err.message })
        }
      }
    }

    if (this.options.syncDeletions) {
      let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0
      let allLists = schema.getLists(this.doc, itemIdentity)
      for (let [listKey, list] of Object.entries(allLists)) {
        if (!list.deleted) continue
        if (list.author === userId) continue
        // Skip stale tombstones — don't undo a local add that happened after the deletion
        if (list.ts && list.ts <= lastPushTs) continue

        let localList = listMap.get(listKey)
        if (localList) {
          try {
            if (this.adapter) {
              await this.adapter.removeItemsFromList(localList.id, [localId])
            } else {
              await this.api.removeItemsFromList(localList.id, [localId])
            }
          } catch (err) {
            this.logger.warn(`Failed to remove item ${localId} from list "${listKey}"`, { error: err.message })
          }
        }
      }
    }
  }
}
