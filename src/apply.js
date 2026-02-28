'use strict'

const crypto = require('crypto')
const identity = require('./identity')
const schema = require('./crdt-schema')
const { sanitizeHtml, escapeHtml } = require('./sanitize')

const ATTRIBUTION_PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9A6324', '#800000', '#aaffc3', '#808000'
]

function attributionColor(username) {
  let hash = 0
  for (let i = 0; i < username.length; i++) {
    hash = ((hash << 5) - hash) + username.charCodeAt(i)
    hash |= 0
  }
  return ATTRIBUTION_PALETTE[Math.abs(hash) % ATTRIBUTION_PALETTE.length]
}

const CONTRIB_URI = 'https://troparcel.org/ns/contributors'
const SYNC_URI = 'https://troparcel.org/ns/lastSync'

/**
 * Apply mixin — CRDT → local write methods (Schema v4).
 *
 * v4 changes:
 *   - UUID-based note/selection/transcription/list keys
 *   - Logic-based conflict checks replace ts < lastPushTs comparisons
 *   - Selection matching via fingerprint (since UUIDs don't carry positional info)
 *   - List matching via name field on UUID-keyed entries
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

    // V3: Attribution tags + contributor metadata
    if (this.adapter) {
      this._applyAttribution(itemIdentity, localId, userId)
    }

    if (s) {
      s.itemsProcessed++
      let after = s.notesCreated + s.notesUpdated + s.tagsAdded +
        s.selectionsCreated + s.metadataUpdated + s.transcriptionsCreated +
        s.listsAdded + s.notesRetracted
      if (after > before) s.itemsChanged++
    }
  },

  /**
   * V3: Attribution tags + contributor metadata.
   * Collects all non-self authors from CRDT annotations for this item,
   * dispatches @user tags and troparcel: metadata. All local-only.
   */
  _applyAttribution(itemIdentity, localId, userId) {
    let contributors = new Set()

    // Collect authors from all annotation types
    let notes = schema.getNotes(this.doc, itemIdentity)
    for (let [, v] of Object.entries(notes)) {
      if (v.author && v.author !== userId && !v.deleted) contributors.add(v.author)
    }
    let sels = schema.getActiveSelections(this.doc, itemIdentity)
    for (let [, v] of Object.entries(sels)) {
      if (v.author && v.author !== userId) contributors.add(v.author)
    }
    let txs = schema.getActiveTranscriptions(this.doc, itemIdentity)
    for (let [, v] of Object.entries(txs)) {
      if (v.author && v.author !== userId) contributors.add(v.author)
    }
    let tags = schema.getActiveTags(this.doc, itemIdentity)
    for (let t of tags) {
      if (t.author && t.author !== userId) contributors.add(t.author)
    }

    if (contributors.size === 0) return

    // Track this item for V4 auto-lists
    if (this._applyStats) this._applyStats.appliedItemIds.add(localId)

    // Dispatch @user tags per contributor
    let state = this.adapter._getState()
    for (let contributor of contributors) {
      let tagName = `@${contributor}`
      let tagId = this.vault.attributionTagIds.get(tagName)

      if (!tagId) {
        let existingTag = Object.values(state.tags || {}).find(t => t.name === tagName)
        if (existingTag) {
          tagId = existingTag.id
          this.vault.attributionTagIds.set(tagName, tagId)
        }
      }

      if (!tagId) {
        tagId = crypto.randomUUID()
        this.adapter.dispatchSuppressed({
          type: 'tag.create',
          payload: { id: tagId, color: attributionColor(contributor) },
          meta: { cmd: 'project', history: 'add' }
        })
        this.vault.attributionTagIds.set(tagName, tagId)
        // Set tag name after create (Tropy expects name in tag.create payload)
        this.adapter.dispatchSuppressed({
          type: 'tag.save',
          payload: { id: tagId, name: tagName },
          meta: { cmd: 'project' }
        })
      }

      // Assign tag to item
      this.adapter.dispatchSuppressed({
        type: 'item.tags.add',
        payload: { id: [localId], tags: [tagId] },
        meta: { cmd: 'project' }
      })
    }

    // Dispatch contributor metadata
    let contribText = Array.from(contributors).sort().join(', ')
    this.adapter.dispatchSuppressed({
      type: 'metadata.save',
      payload: {
        id: localId,
        data: {
          [CONTRIB_URI]: { text: contribText, type: 'text' },
          [SYNC_URI]: { text: new Date().toISOString(), type: 'text' }
        }
      },
      meta: { cmd: 'project' }
    })
  },

  // Logic-based conflict check replaces ts < lastPushTs
  async applyMetadata(itemIdentity, localId, userId, localItem) {
    if (!this.options.syncMetadata) return
    let remoteMeta = schema.getMetadata(this.doc, itemIdentity)
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
        // Logic-based: skip if we have a local edit for this field
        let valueHash = this.vault._fastHash(`${localText}|${value.type || ''}`)
        if (this.vault.hasLocalEdit(itemIdentity, prop, valueHash)) {
          this._logConflict('metadata-apply', itemIdentity, prop, {
            localValue: localText?.slice(0, 50),
            remoteValue: (value.text || '').slice(0, 50),
            remoteAuthor: value.author,
            resolution: 'local-wins'
          })
          continue
        }
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
        this.logger.warn({
          error: err.message
        }, `Failed to save metadata batch on ${localId}`)
      }
    }
  },

  async applyTags(itemIdentity, localId, userId, tagMap, localItem) {
    if (!this.options.syncTags) return

    // Build set of tag names already on this item (lowercase for case-insensitive matching)
    let localTagNames = new Set()
    let localTags = localItem.tag || []
    for (let t of localTags) {
      if (t && t.name) localTagNames.add(t.name.toLowerCase())
    }

    let activeTags = schema.getActiveTags(this.doc, itemIdentity)

    for (let tag of activeTags) {
      if (tag.author === userId) continue

      // Diff: skip if item already has this tag (case-insensitive)
      if (localTagNames.has(tag.name.toLowerCase())) continue

      let existing = tagMap.get(tag.name.toLowerCase())
      if (!existing) {
        try {
          let created = await this.api.createTag(tag.name, tag.color, [localId])
          localTagNames.add(tag.name.toLowerCase())
          // Update tagMap so subsequent items in this batch can use addTagsToItem
          if (created && (created.id || created.tag_id)) {
            tagMap.set(tag.name.toLowerCase(), created)
          }
          if (this._applyStats) this._applyStats.tagsAdded++
          this._debug(`tag created: "${tag.name}" on item ${localId}`)
          continue
        } catch (err) {
          this.logger.warn({ error: err.message }, `Failed to create tag "${tag.name}"`)
          continue
        }
      }

      try {
        await this.api.addTagsToItem(localId, [existing.id || existing.tag_id])
        localTagNames.add(tag.name.toLowerCase())
        if (this._applyStats) this._applyStats.tagsAdded++
        this._debug(`tag added: "${tag.name}" on item ${localId}`)
      } catch (err) {
        this.logger.warn({ error: err.message }, `Failed to add tag "${tag.name}" to item ${localId}`)
      }
    }

    if (!this.options.syncDeletions) return

    let deletedTags = schema.getDeletedTags(this.doc, itemIdentity)
    // Tags: no ownership guard — accept all tombstones (add-wins recovers)
    for (let tag of deletedTags) {
      if (tag.author === userId) continue

      // Diff: skip if item doesn't have this tag anyway (case-insensitive)
      if (!localTagNames.has(tag.name.toLowerCase())) continue

      let existing = tagMap.get(tag.name.toLowerCase())
      if (existing) {
        try {
          await this.api.removeTagsFromItem(localId, [existing.id || existing.tag_id])
        } catch (err) {
          this.logger.warn({ error: err.message }, `Failed to remove tag "${tag.name}" from item ${localId}`)
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
          // Legacy top-of-note identifiers
          .replace(/^troparcel:\s*[^\n]*\n?/, '')
          .replace(/^\[(?:troparcel:)?[^\]]{1,80}\]\s*/, '')
          // v5.0+: bottom-of-note identifier (plain text form)
          .replace(/\n?\[troparcel:[^\]]*\]\s*$/, '')
          .trim()
        if (stripped) set.add(stripped)
      }
      if (n && n.html) {
        set.add(n.html.trim())
        let strippedHtml = n.html
          // Legacy top-of-note identifiers
          .replace(/^<blockquote><p><em>troparcel:[^<]*<\/em><\/p><\/blockquote>/, '')
          .replace(/^<p><strong>\[[^\]]*\]<\/strong><\/p>/, '')
          // v5.0+: bottom-of-note identifier
          .replace(/<p><sub>\[troparcel:[^\]]*\]<\/sub><\/p>\s*$/, '')
          .trim()
        if (strippedHtml) set.add(strippedHtml)
      }
    }
    return set
  },

  /**
   * Apply a single remote note: sanitize, find-by-UUID, update-or-create.
   * Shared by applyNotes and applySelectionNotes.
   *
   * The CRDT UUID is embedded in a visible footer at the bottom of each
   * synced note so we can always find the local note by scanning content.
   * Vault ID mappings are a fast-path hint; the UUID in the footer is the
   * source of truth for matching remote→local.
   *
   * Why a visible footer (not invisible metadata):
   *   - HTML comments (<!-- -->) are stripped by our sanitizer (security)
   *   - data-* attributes are blocked by our sanitizer (XSS prevention)
   *   - ProseMirror's DOMParser ignores unknown attributes and elements
   *   - Tropy's editor schema has no custom attrs that survive roundtrip
   *   - The only content that reliably survives: text inside safe tags
   *
   * The footer uses <sub> to minimize visual impact while staying within
   * ProseMirror's supported node types. Users are told it's safe to delete
   * (the vault mapping takes over once established).
   */
  _makeFooter(noteKey, authorLabel) {
    return `<p><sub>[troparcel:${escapeHtml(noteKey)} from ${authorLabel} — safe to delete, do not edit]</sub></p>`
  },

  _extractNoteKey(html) {
    let m = html && html.match(/\[troparcel:([\w:-]+)\s/)
    return m ? m[1] : null
  },

  /**
   * Scan all local notes to find one whose content embeds the given CRDT UUID.
   * Returns the local note ID or null.
   */
  _findLocalNoteByUUID(noteKey) {
    if (!this.adapter) return null
    let state = this.adapter._getState()
    for (let [id, note] of Object.entries(state.notes)) {
      if (!note) continue
      // Check plain text first (fast)
      if (note.text && note.text.includes(`troparcel:${noteKey}`)) return Number(id)
      // Check ProseMirror state for the UUID string
      let json = note.state && JSON.stringify(note.state)
      if (json && json.includes(`troparcel:${noteKey}`)) return Number(id)
    }
    return null
  },

  async _applyRemoteNote(noteKey, note, parent, existingTexts, userId, label) {
    let safeHtml = note.html
      ? sanitizeHtml(note.html)
      : `<p>${escapeHtml(note.text)}</p>`

    let authorLabel = escapeHtml(note.author || 'unknown')
    safeHtml = `${safeHtml}${this._makeFooter(noteKey, authorLabel)}`

    // Find existing local note by UUID (embedded in footer)
    let existingLocalId = this._findLocalNoteByUUID(noteKey)

    // Fast-path: vault hint (may be stale, but check anyway)
    if (!existingLocalId) {
      let vaultId = this.vault.getLocalNoteId(noteKey)
      if (vaultId && this.adapter) {
        let state = this.adapter._getState()
        if (state.notes[vaultId]) existingLocalId = vaultId
      }
    }

    if (existingLocalId) {
      // Check if user has locally edited the note since last apply
      if (this.adapter) {
        let state = this.adapter._getState()
        let localNote = state.notes[existingLocalId]
        if (localNote) {
          let localHtml = this.adapter._noteStateToHtml(localNote)
          if (this.vault.hasLocalNoteEdit(noteKey, localHtml)) {
            this._logConflict('note-apply', noteKey, `note:${noteKey}`, {
              localLength: localHtml.length,
              remoteLength: safeHtml.length,
              remoteAuthor: note.author,
              resolution: 'local-wins'
            })
            this.vault.appliedNoteKeys.add(noteKey)
            if (this._applyStats) this._applyStats.notesSkipped = (this._applyStats.notesSkipped || 0) + 1
            return false
          }
        }
      }

      // Update existing note in place
      try {
        if (this.adapter) {
          let result = await this.adapter.updateNote(existingLocalId, { html: safeHtml })
          if (result && (result.id || result['@id'])) {
            let newId = result.id || result['@id']
            this.vault.mapAppliedNote(noteKey, newId)
            this.vault.appliedNoteKeys.add(noteKey)
            this.vault.markNoteApplied(noteKey, safeHtml)
          }
        } else {
          await this.api.updateNote(existingLocalId, { html: safeHtml })
          this.vault.appliedNoteKeys.add(noteKey)
          this.vault.markNoteApplied(noteKey, safeHtml)
        }
        if (this._applyStats) this._applyStats.notesUpdated++
        this._debug(`${label} updated: ${noteKey.slice(0, 8)}`)
        return true
      } catch (err) {
        this.logger.warn({ error: String(err.message || err) }, `${label} update failed for ${noteKey.slice(0, 8)}, falling through to create`)
      }
    }

    // Content-based dedup fallback — avoid creating duplicate if footer was stripped
    if (existingTexts.has(safeHtml.trim())) {
      this.vault.appliedNoteKeys.add(noteKey)
      if (this._applyStats) this._applyStats.notesDeduped++
      return false
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
        this.vault.markNoteApplied(noteKey, safeHtml)
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
      this.logger.warn({
        error: err.message, ...parent, noteKey: noteKey.slice(0, 8)
      }, `Failed to create ${label}`)
      if (this._applyStats) this._applyStats.notesFailed++
      this._failedNoteKeys.add(noteKey)
    }
    return false
  },

  // UUID-based note matching (schema v4)
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
        // Track original author (defense-in-depth)
        if (val.author) this.vault.trackOriginalAuthor(key, val.author)
      }
    }

    for (let [noteKey, note] of Object.entries(remoteNotes)) {
      if (note.author === userId) continue
      if (!note.html && !note.text) continue

      // UUID scan: check if a local note already has this UUID in its footer.
      // If found, _applyRemoteNote will update it in place (no duplicate).
      // If not found, _applyRemoteNote will create a new note.
      // This replaces content-hash tracking — the UUID in the footer is
      // the single source of truth for matching CRDT notes to local notes.
      let localNoteId = this._findLocalNoteByUUID(noteKey)
      if (localNoteId) {
        // Note exists locally — check if CRDT content actually changed
        let state = this.adapter ? this.adapter._getState() : null
        let localNote = state && state.notes[localNoteId]
        if (localNote) {
          let localText = localNote.text || ''
          let remoteText = note.text || ''
          let remoteHtml = note.html || ''
          // Quick check: if the remote content is already in the local note, skip
          if (localText.includes(remoteText) && remoteText.length > 0 &&
              !localText.includes('[retracted')) {
            this.vault.appliedNoteKeys.add(noteKey)
            continue
          }
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

      // Defense-in-depth: reject tombstones from non-original-authors
      let originalAuthor = this.vault.getOriginalAuthor(noteKey)
      if (originalAuthor && note.author !== originalAuthor) {
        this._debug(`ownership: rejected tombstone for note ${noteKey.slice(0, 8)} — deleter ${note.author} !== original ${originalAuthor}`)
        continue
      }

      if (this.vault.isDismissed(noteKey, note.pushSeq || 0)) continue
      if (this.vault.retractedNoteKeys.has(noteKey)) continue

      // Find local note by UUID in footer, fall back to vault mapping
      let existingLocalId = this._findLocalNoteByUUID(noteKey)
      if (!existingLocalId) existingLocalId = this.vault.getLocalNoteId(noteKey)
      if (!existingLocalId) continue

      // Verify local note still exists
      if (this.adapter) {
        let state = this.adapter._getState()
        if (!state.notes[existingLocalId]) {
          this.vault.retractedNoteKeys.add(noteKey)
          this.vault.markDirty()
          this._debug(`note ${noteKey.slice(0, 8)}: local note ${existingLocalId} already deleted, marking retracted`)
          continue
        }
      }

      let authorLabel = escapeHtml(note.author || 'unknown')
      let contentHtml = note.html
        ? sanitizeHtml(note.html)
        : (note.text ? `<p>${escapeHtml(note.text)}</p>` : '')
      let retractedHtml = `${this._applyStrikethrough(contentHtml)}<p><sub>[troparcel:${escapeHtml(noteKey)} retracted by ${authorLabel} — safe to delete, do not edit]</sub></p>`

      try {
        let retracted = false
        if (this.adapter) {
          let result = await this.adapter.updateNote(existingLocalId, { html: retractedHtml })
          if (result && (result.id || result['@id'])) {
            let newId = result.id || result['@id']
            // Verify old note was actually deleted (updateNote does delete+create)
            if (String(newId) !== String(existingLocalId)) {
              let state = this.adapter._getState()
              if (state.notes[existingLocalId]) {
                try { await this.adapter.deleteNote(existingLocalId) } catch {}
              }
            }
            this.vault.mapAppliedNote(noteKey, newId)
            retracted = true
          }
        } else {
          this._debug(`note retraction skipped (no adapter) for ${noteKey.slice(0, 8)}`)
          this.vault.retractedNoteKeys.add(noteKey)
        }
        if (retracted) {
          this.vault.retractedNoteKeys.add(noteKey)
          this.vault.markDirty()
          if (this._applyStats) this._applyStats.notesRetracted++
          this._debug(`note retracted: ${noteKey.slice(0, 8)} by ${note.author}`)
        }
      } catch (err) {
        this.logger.warn({ error: String(err.message || err) }, `Failed to retract note ${noteKey.slice(0, 8)}`)
      }
    }
  },

  // Logic-based conflict check replaces ts < lastPushTs
  async applyPhotoMetadata(itemIdentity, local, userId) {
    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

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
          // Logic-based: skip if we have a local edit
          let valueHash = this.vault._fastHash(`${localText}|${value.type || ''}`)
          if (this.vault.hasLocalEdit(itemIdentity, `photo:${checksum}:${prop}`, valueHash)) {
            this._logConflict('photo-meta-apply', itemIdentity, `photo:${checksum}:${prop}`, {
              localValue: localText?.slice(0, 50),
              remoteValue: (value.text || '').slice(0, 50),
              remoteAuthor: value.author,
              resolution: 'local-wins'
            })
            continue
          }
        }

        batch[prop] = { text: value.text, type: value.type }
      }

      let photoBatchKeys = Object.keys(batch)
      if (photoBatchKeys.length > 0) {
        try {
          await this.api.saveMetadata(localPhotoId, batch)
          if (this._applyStats) this._applyStats.metadataUpdated += photoBatchKeys.length
        } catch (err) {
          this.logger.warn({ error: err.message }, `Failed to save photo metadata batch`)
        }
      }
    }
  },

  // UUID-based selection matching with fingerprint fallback (schema v4)
  async applySelections(itemIdentity, local, userId) {
    if (!this.options.syncSelections) return
    let remoteSelections = schema.getActiveSelections(this.doc, itemIdentity)

    // Track original authors for selections (defense-in-depth)
    for (let [selUUID, sel] of Object.entries(remoteSelections)) {
      if (sel.author) this.vault.trackOriginalAuthor(selUUID, sel.author)
    }

    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    // Pre-build Set of existing local selection fingerprints for dedup
    let existingSelFingerprints = new Set()
    for (let p of photos) {
      if (!p.checksum) continue
      let localSels = p.selection || []
      if (!Array.isArray(localSels)) localSels = [localSels]
      for (let ls of localSels) {
        if (ls) existingSelFingerprints.add(identity.computeSelectionFingerprint(p.checksum, ls))
      }
    }

    for (let [selUUID, sel] of Object.entries(remoteSelections)) {
      if (sel.author === userId) continue
      if (this.vault.appliedSelectionKeys.has(selUUID)) continue

      let x = Number(sel.x)
      let y = Number(sel.y)
      let w = Number(sel.w)
      let h = Number(sel.h)
      if (!Number.isFinite(x) || !Number.isFinite(y) ||
          !Number.isFinite(w) || !Number.isFinite(h) ||
          w <= 0 || h <= 0) {
        this._log(`Skipping selection ${selUUID}: invalid coordinates`, { x, y, w, h })
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

      // Fingerprint-based dedup: check if a local selection with same coordinates exists
      let fingerprint = identity.computeSelectionFingerprint(sel.photo, sel)
      let alreadyExists = existingSelFingerprints.has(fingerprint)

      if (!alreadyExists) {
        try {
          let created
          if (this.adapter) {
            created = await this.adapter.createSelection({
              photo: Number(localPhotoId),
              x,
              y,
              width: w,
              height: h,
              angle: sel.angle || 0
            })
          } else {
            created = await this.api.createSelection({
              photo: Number(localPhotoId),
              x,
              y,
              width: w,
              height: h,
              angle: sel.angle || 0
            })
          }
          if (created && (created.id || created['@id'])) {
            let localSelId = created.id || created['@id']
            this.vault.mapAppliedSelection(selUUID, localSelId)
          }
          this.vault.appliedSelectionKeys.add(selUUID)
          if (this._applyStats) this._applyStats.selectionsCreated++
          this._debug(`selection created: ${selUUID.slice(0, 8)} on photo ${localPhotoId}`)
        } catch (err) {
          this.logger.warn({
            error: err.message
          }, `Failed to create selection on photo ${localPhotoId}`)
        }
      } else {
        // Match existing local selection by fingerprint
        for (let p of photos) {
          if (p.checksum !== sel.photo) continue
          let localSels = p.selection || []
          if (!Array.isArray(localSels)) localSels = [localSels]
          for (let ls of localSels) {
            if (!ls) continue
            let lsFp = identity.computeSelectionFingerprint(p.checksum, ls)
            if (lsFp === fingerprint) {
              let localSelId = ls['@id'] || ls.id
              if (localSelId) {
                this.vault.mapAppliedSelection(selUUID, localSelId)
              }
              break
            }
          }
        }
        this.vault.appliedSelectionKeys.add(selUUID)
      }
    }
  },

  // UUID-based selection note matching (schema v4)
  async applySelectionNotes(itemIdentity, local, userId) {
    if (!this.options.syncNotes) return
    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    // Build tombstone index grouped by selUUID prefix
    let allSelNotes = schema.getAllSelectionNotes(this.doc, itemIdentity)
    let tombstonesBySelUUID = new Map()
    for (let [compositeKey, note] of Object.entries(allSelNotes)) {
      if (note.deleted) {
        let sepIdx = compositeKey.indexOf(':')
        if (sepIdx > 0) {
          let prefix = compositeKey.slice(0, sepIdx)
          if (!tombstonesBySelUUID.has(prefix)) tombstonesBySelUUID.set(prefix, [])
          tombstonesBySelUUID.get(prefix).push([compositeKey, note])
        }
      } else if (note.author) {
        // Track original author (defense-in-depth)
        this.vault.trackOriginalAuthor(compositeKey, note.author)
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

        // v4: Look up selection UUID via vault
        let localSelId = sel['@id'] || sel.id
        let selUUID = localSelId
          ? this.vault.getSelectionKey(localSelId, identity.generateSelectionUUID())
          : identity.computeSelectionFingerprint(checksum, sel)

        let remoteNotes = schema.getSelectionNotes(this.doc, itemIdentity, selUUID)

        for (let [compositeKey, note] of Object.entries(remoteNotes)) {
          if (note.author === userId) continue
          if (!note.html && !note.text) continue

          // UUID scan: find local note by embedded UUID
          let localSelNoteId = this._findLocalNoteByUUID(compositeKey)
          if (localSelNoteId) {
            let state = this.adapter ? this.adapter._getState() : null
            let localNote = state && state.notes[localSelNoteId]
            if (localNote) {
              let localText = localNote.text || ''
              let remoteText = note.text || ''
              if (localText.includes(remoteText) && remoteText.length > 0 &&
                  !localText.includes('[retracted')) {
                this.vault.appliedNoteKeys.add(compositeKey)
                continue
              }
            }
          }

          if (!localSelId) continue

          await this._applyRemoteNote(
            compositeKey, note,
            { selection: Number(localSelId) || null },
            existingTexts, userId, 'sel note'
          )
        }

        // Handle tombstoned selection notes: apply strikethrough
        let selTombstones = tombstonesBySelUUID.get(selUUID) || []
        for (let [compositeKey, note] of selTombstones) {
          if (note.author === userId) continue

          // Defense-in-depth: reject tombstones from non-original-authors
          let originalAuthor = this.vault.getOriginalAuthor(compositeKey)
          if (originalAuthor && note.author !== originalAuthor) {
            this._debug(`ownership: rejected tombstone for sel note ${compositeKey.slice(0, 8)} — deleter ${note.author} !== original ${originalAuthor}`)
            continue
          }

          if (this.vault.isDismissed(compositeKey, note.pushSeq || 0)) continue
          if (this.vault.retractedNoteKeys.has(compositeKey)) continue

          let existingLocalId = this._findLocalNoteByUUID(compositeKey)
          if (!existingLocalId) existingLocalId = this.vault.getLocalNoteId(compositeKey)
          if (!existingLocalId) continue

          if (this.adapter) {
            let state = this.adapter._getState()
            if (!state.notes[existingLocalId]) {
              this.vault.retractedNoteKeys.add(compositeKey)
              this.vault.markDirty()
              this._debug(`sel note ${compositeKey.slice(0, 8)}: local note ${existingLocalId} already deleted, marking retracted`)
              continue
            }
          }

          let authorLabel = escapeHtml(note.author || 'unknown')
          let contentHtml = note.html
            ? sanitizeHtml(note.html)
            : (note.text ? `<p>${escapeHtml(note.text)}</p>` : '')
          let retractedHtml = `${this._applyStrikethrough(contentHtml)}<p><sub>[troparcel:${escapeHtml(compositeKey)} retracted by ${authorLabel} — safe to delete, do not edit]</sub></p>`

          try {
            let retracted = false
            if (this.adapter) {
              let result = await this.adapter.updateNote(existingLocalId, { html: retractedHtml })
              if (result && (result.id || result['@id'])) {
                let newId = result.id || result['@id']
                if (String(newId) !== String(existingLocalId)) {
                  let state = this.adapter._getState()
                  if (state.notes[existingLocalId]) {
                    try { await this.adapter.deleteNote(existingLocalId) } catch {}
                  }
                }
                this.vault.mapAppliedNote(compositeKey, newId)
                retracted = true
              }
            } else {
              this._debug(`sel note retraction skipped (no adapter) for ${compositeKey.slice(0, 8)}`)
              this.vault.retractedNoteKeys.add(compositeKey)
            }
            if (retracted) {
              this.vault.retractedNoteKeys.add(compositeKey)
              this.vault.markDirty()
              if (this._applyStats) this._applyStats.notesRetracted++
              this._debug(`sel note retracted: ${compositeKey.slice(0, 8)} by ${note.author}`)
            }
          } catch (err) {
            this.logger.warn({ error: String(err.message || err) }, `Failed to retract sel note ${compositeKey.slice(0, 8)}`)
          }
        }
      }
    }
  },

  // Logic-based conflict check + UUID-based selection matching (schema v4)
  async applySelectionMetadata(itemIdentity, local, userId) {
    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let photo of photos) {
      let checksum = photo.checksum
      if (!checksum) continue

      let localSels = photo.selection || []
      if (!Array.isArray(localSels)) localSels = [localSels]

      for (let sel of localSels) {
        if (!sel) continue

        // v4: Look up selection UUID via vault
        let localSelId = sel['@id'] || sel.id
        let selUUID = localSelId
          ? this.vault.getSelectionKey(localSelId, identity.generateSelectionUUID())
          : identity.computeSelectionFingerprint(checksum, sel)

        if (!localSelId) continue

        let remoteMeta = schema.getSelectionMeta(this.doc, itemIdentity, selUUID)
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
            // Logic-based: skip if we have a local edit
            let valueHash = this.vault._fastHash(`${localText}|${value.type || ''}`)
            if (this.vault.hasLocalEdit(itemIdentity, `selmeta:${selUUID}:${prop}`, valueHash)) {
              this._logConflict('sel-meta-apply', itemIdentity, `selmeta:${selUUID}:${prop}`, {
                localValue: localText?.slice(0, 50),
                remoteValue: (value.text || '').slice(0, 50),
                remoteAuthor: value.author,
                resolution: 'local-wins'
              })
              continue
            }
          }

          batch[prop] = { text: value.text, type: value.type }
        }

        let selBatchKeys = Object.keys(batch)
        if (selBatchKeys.length > 0) {
          try {
            await this.api.saveMetadata(localSelId, batch)
            if (this._applyStats) this._applyStats.metadataUpdated += selBatchKeys.length
          } catch (err) {
            this.logger.warn({ error: err.message }, `Failed to save selection metadata`)
          }
        }
      }
    }
  },

  // UUID-based transcription matching (schema v4)
  async applyTranscriptions(itemIdentity, local, userId) {
    if (!this.options.syncTranscriptions) return
    let remoteTranscriptions = schema.getActiveTranscriptions(this.doc, itemIdentity)

    // Track original authors for transcriptions (defense-in-depth)
    for (let [txKey, tx] of Object.entries(remoteTranscriptions)) {
      if (tx.author) this.vault.trackOriginalAuthor(txKey, tx.author)
    }

    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    // Pre-build lookup maps
    let photoByChecksum = new Map()
    let selUUIDToLocalId = new Map()
    for (let p of photos) {
      if (p.checksum) {
        photoByChecksum.set(p.checksum, p['@id'] || p.id)
        let sels = p.selection || []
        if (!Array.isArray(sels)) sels = [sels]
        for (let s of sels) {
          if (!s) continue
          let localSelId = s['@id'] || s.id
          if (localSelId) {
            // v4: Look up selection UUID via vault
            let selUUID = this.vault.getSelectionKey(localSelId, identity.generateSelectionUUID())
            selUUIDToLocalId.set(selUUID, localSelId)
          }
        }
      }
    }

    for (let [txKey, tx] of Object.entries(remoteTranscriptions)) {
      if (tx.author === userId) continue
      if (!tx.text && !tx.data) continue
      if (this.vault.appliedTranscriptionKeys.has(txKey)) continue

      let localPhotoId = photoByChecksum.get(tx.photo) || null
      if (!localPhotoId) continue

      let localSelId = tx.selection ? (selUUIDToLocalId.get(tx.selection) || null) : null

      // C3: Check for existing mapping (update vs create)
      let existingLocalId = this.vault.getLocalTxId(txKey)
      if (existingLocalId) {
        try {
          let originalTx = null
          try { originalTx = await this.api.getTranscription(existingLocalId) } catch {}

          try { await this.api.deleteTranscription(existingLocalId) } catch (delErr) {
            this.logger.warn({ error: String(delErr.message || delErr) }, `Failed to delete transcription ${existingLocalId}`)
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
              this.logger.warn({ error: String(restoreErr.message || restoreErr) }, `Transcription restore also failed for ${txKey.slice(0, 8)}`)
            }
          }
          continue
        } catch (err) {
          this.logger.warn({ error: String(err.message || err) }, `Failed to update transcription ${txKey.slice(0, 8)}`)
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
        this.logger.warn({
          error: err.message
        }, `Failed to create transcription`)
      }
    }
  },

  // UUID-based list matching with name field (schema v4)
  async applyLists(itemIdentity, local, userId, listMap) {
    let remoteLists = schema.getActiveLists(this.doc, itemIdentity)
    let localId = local.localId

    // Build set of lists this item already belongs to
    let localListNames = new Set()
    for (let listId of (local.item.lists || [])) {
      let name = this._listNameCache.get(listId) || this._listNameCache.get(String(listId))
      if (name) localListNames.add(name)
    }

    for (let [listUUID, list] of Object.entries(remoteLists)) {
      if (list.author === userId) continue
      // v4: Lists carry name field
      let listName = list.name || listUUID
      if (localListNames.has(listName)) continue  // Already in list

      // Store UUID mapping
      this.vault.mapAppliedList(listUUID, listName)

      // Match by name
      let localList = listMap.get(listName)
      if (localList) {
        try {
          if (this.adapter) {
            await this.adapter.addItemsToList(localList.id, [localId])
          } else {
            await this.api.addItemsToList(localList.id, [localId])
          }
          localListNames.add(listName)
          if (this._applyStats) this._applyStats.listsAdded++
          this._debug(`list add: item ${localId} → "${listName}"`)
        } catch (err) {
          this.logger.warn({ error: err.message }, `Failed to add item ${localId} to list "${listName}"`)
        }
      }
    }

    if (this.options.syncDeletions) {
      let allLists = schema.getLists(this.doc, itemIdentity)
      for (let [listUUID, list] of Object.entries(allLists)) {
        if (!list.deleted) continue
        // Lists: no ownership guard — accept all tombstones (add-wins recovers)
        if (list.author === userId) continue

        let listName = list.name || listUUID
        let localList = listMap.get(listName)
        if (localList) {
          try {
            if (this.adapter) {
              await this.adapter.removeItemsFromList(localList.id, [localId])
            } else {
              await this.api.removeItemsFromList(localList.id, [localId])
            }
          } catch (err) {
            this.logger.warn({ error: err.message }, `Failed to remove item ${localId} from list "${listName}"`)
          }
        }
      }
    }
  },

  // --- V5: Project-level schema + list hierarchy apply ---

  async applyTemplates() {
    if (!this.adapter) return
    let userId = this._stableUserId

    let remoteTemplates = schema.getTemplateSchema(this.doc)
    let localTemplates = this.adapter.readTemplates()

    let applied = 0
    for (let [uri, tmpl] of Object.entries(remoteTemplates)) {
      if (tmpl.deleted) continue
      if (tmpl.author === userId) continue

      // Skip if template already exists locally
      if (localTemplates[uri]) continue

      let fields = (tmpl.fields || []).map((f, idx) => ({
        property: f.property,
        label: f.label || '',
        datatype: f.datatype || 'http://www.w3.org/2001/XMLSchema#string',
        isRequired: f.isRequired || false,
        isConstant: f.isConstant || false,
        hint: f.hint || '',
        value: f.value || '',
        position: idx
      }))

      // Caller (applyPendingRemote/applyRemoteFromCRDT) already suppresses —
      // use store.dispatch directly, NOT dispatchSuppressed (which would
      // call resumeChanges and break the outer suppression).
      this.adapter.store.dispatch({
        type: 'ontology.template.create',
        payload: {
          [uri]: {
            name: tmpl.name,
            type: tmpl.type || 'https://tropy.org/v1/tropy#Item',
            creator: tmpl.creator || '',
            description: tmpl.description || '',
            fields
          }
        },
        meta: { cmd: 'ontology', history: 'add' }
      })
      applied++
      this._debug(`template created: ${tmpl.name} (${uri})`)
    }

    if (applied > 0) {
      this._log(`applied ${applied} template(s)`)
    }
  },

  async applyListHierarchy() {
    if (!this.adapter) return
    let userId = this._stableUserId

    let remoteLists = schema.getListHierarchy(this.doc)
    let localLists = this.adapter.readLists()

    // Build name→local lookup (skip root list id=0)
    let localByName = new Map()
    for (let [id, list] of Object.entries(localLists)) {
      if (Number(id) === 0) continue
      if (list.name) localByName.set(list.name, { ...list, id: Number(id) })
    }

    // Filter active remote lists (not self-authored, not tombstoned)
    let activeRemote = []
    for (let [uuid, entry] of Object.entries(remoteLists)) {
      if (entry.deleted) continue
      if (entry.author === userId) continue
      activeRemote.push({ uuid, ...entry })
    }
    if (activeRemote.length === 0) return

    // Topological sort: parents before children
    let sorted = this._topoSortLists(activeRemote)

    let applied = 0
    for (let entry of sorted) {
      // Already mapped to a local list?
      let existingLocalId = this.vault.crdtUuidToListId.get(entry.uuid)
      if (existingLocalId != null && localLists[existingLocalId]) continue

      // Exists locally by name? Map UUID and skip creation.
      let existing = localByName.get(entry.name)
      if (existing) {
        this.vault.listIdToCrdtUuid.set(existing.id, entry.uuid)
        this.vault.crdtUuidToListId.set(entry.uuid, existing.id)
        continue
      }

      // Resolve parent UUID → local parent ID (0 = root)
      let localParent = 0
      if (entry.parent) {
        let parentLocalId = this.vault.crdtUuidToListId.get(entry.parent)
        if (parentLocalId != null) localParent = parentLocalId
      }

      // Dispatch list creation and wait for completion.
      // Caller already suppresses — use store.dispatch directly.
      let idsBefore = new Set(Object.keys(this.adapter.readLists()))
      let action = this.adapter.store.dispatch({
        type: 'list.create',
        payload: { name: entry.name, parent: localParent },
        meta: { cmd: 'project', history: 'add' }
      })
      await this.adapter._waitForAction(action)

      // Find the newly created list by diffing state
      let listsAfter = this.adapter.readLists()
      for (let [id, list] of Object.entries(listsAfter)) {
        if (!idsBefore.has(id) && list.name === entry.name) {
          let localId = Number(id)
          this.vault.listIdToCrdtUuid.set(localId, entry.uuid)
          this.vault.crdtUuidToListId.set(entry.uuid, localId)
          localByName.set(entry.name, { ...list, id: localId })
          break
        }
      }

      applied++
      this._debug(`list created: "${entry.name}" (${entry.uuid})`)
    }

    if (applied > 0) {
      this._log(`applied ${applied} list(s)`)
    }
  },

  _topoSortLists(entries) {
    let byUuid = new Map()
    for (let e of entries) byUuid.set(e.uuid, e)

    let result = []
    let visited = new Set()

    function visit(entry) {
      if (visited.has(entry.uuid)) return
      visited.add(entry.uuid)
      if (entry.parent && byUuid.has(entry.parent)) {
        visit(byUuid.get(entry.parent))
      }
      result.push(entry)
    }

    for (let entry of entries) visit(entry)
    return result
  }
}
