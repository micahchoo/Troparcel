'use strict'

const identity = require('./identity')
const schema = require('./crdt-schema')
const { sanitizeHtml, escapeHtml } = require('./sanitize')
const {
  ATTRIBUTION_PREFIX, CONTRIB_URI, SYNC_URI, isLocalOnlyTag, isTropyPresetTemplate, noteFooter
} = require('./local-only')

// Tropy's tag colours are preset names (src/constants/sass.js#TAG.COLORS).
const ATTRIBUTION_PALETTE = [
  'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray', 'brown'
]

const TEXT = 'http://www.w3.org/2001/XMLSchema#string'
const TROPY_COLORS = new Set([
  'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray', 'brown',
  'apricot', 'dark-green', 'light-blue', 'lavender'
])

/** A peer's tag colour if Tropy knows it, else Tropy's default. */
function tropyColor(color) {
  return TROPY_COLORS.has(color) ? color : undefined
}

/** The text of a metadata value in either shape Troparcel reads. */
function textOf(v) {
  if (v == null) return null
  if (typeof v === 'object') return v['@value'] ?? v.text ?? ''
  return String(v)
}

function typeOf(v) {
  return (v && typeof v === 'object') ? (v['@type'] || v.type || null) : null
}

function arrayOf(v) {
  if (v == null) return []
  return Array.isArray(v) ? v.filter(Boolean) : [v]
}

function attributionColor(username) {
  let hash = 0
  for (let i = 0; i < username.length; i++) {
    hash = ((hash << 5) - hash) + username.charCodeAt(i)
    hash |= 0
  }
  return ATTRIBUTION_PALETTE[Math.abs(hash) % ATTRIBUTION_PALETTE.length]
}

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

    await this.applyTags(itemIdentity, localId, userId, tagMap, local.item)

    await this.applyNotes(itemIdentity, local, userId)

    if (this.options.syncPhotoAdjustments) {
      await this.applyPhotoMetadata(itemIdentity, local, userId)
    }

    await this.applySelections(itemIdentity, local, userId)

    await this.applySelectionNotes(itemIdentity, local, userId)

    if (this.options.syncPhotoAdjustments) {
      await this.applySelectionMetadata(itemIdentity, local, userId)
    }

    await this.applyTranscriptions(itemIdentity, local, userId)

    if (this.options.syncLists) {
      await this.applyLists(itemIdentity, local, userId, listMap)
    }

    await this._applyAttribution(itemIdentity, localId, userId)

    if (s) {
      s.itemsProcessed++
      let after = s.notesCreated + s.notesUpdated + s.tagsAdded +
        s.selectionsCreated + s.metadataUpdated + s.transcriptionsCreated +
        s.listsAdded + s.notesRetracted
      if (after > before) {
        s.itemsChanged++
        s.receivedItemIds.add(localId)
      }
    }
  },

  /** A peer's display name from awareness, or its userId when unknown. */
  _resolveDisplayName(userId) {
    if (!userId) return userId
    return (this.vault && this.vault.getDisplayName(userId)) || userId
  },

  /**
   * Show the owner who contributed to an item: an "@name" tag per peer and
   * the troparcel contributors/lastSync fields. Local-only (local-only.js).
   */
  async _applyAttribution(itemIdentity, localId, userId) {
    let contributors = new Set()
    let add = v => { if (v && v.author && v.author !== userId && !v.deleted) contributors.add(v.author) }

    Object.values(schema.getNotes(this.doc, itemIdentity)).forEach(add)
    Object.values(schema.getActiveSelections(this.doc, itemIdentity)).forEach(add)
    Object.values(schema.getActiveTranscriptions(this.doc, itemIdentity)).forEach(add)
    schema.getActiveTags(this.doc, itemIdentity).forEach(add)
    Object.values(schema.getMetadata(this.doc, itemIdentity)).forEach(add)

    if (contributors.size === 0) return

    let names = Array.from(contributors, c => this._resolveDisplayName(c)).sort()
    let item = this.adapter.getItemFull(localId)
    let has = new Set((item && item.tag || []).map(t => t.name))
    for (let name of names) {
      let tagName = `${ATTRIBUTION_PREFIX}${name}`
      if (!has.has(tagName)) this._assignments.tag(tagName, attributionColor(name), localId)
    }

    let contribText = names.join(', ')
    let current = item && item[CONTRIB_URI]
    if ((current && current['@value']) === contribText) return
    try {
      await this.adapter.saveMetadata(localId, {
        [CONTRIB_URI]: { text: contribText, type: TEXT },
        [SYNC_URI]: { text: new Date().toISOString(), type: TEXT }
      })
    } catch (err) {
      this.logger.warn(`attribution metadata on item ${localId}: ${err.message}`)
    }
  },

  /**
   * Three-way merge of one set of metadata fields (an item's, a photo's or
   * a selection's) and write of the remote side's wins.
   *
   * The base is the value both sides last agreed on: what this peer last
   * pushed OR applied (vault.markFieldPushed). A remote value replaces the
   * local one only when the local one is still the base. Unknown base
   * (first meeting) keeps the local value; push then offers it to the room.
   */
  async _applyFields(itemIdentity, localId, field, remoteMeta, localMeta, userId) {
    let batch = {}
    for (let [prop, value] of Object.entries(remoteMeta)) {
      if (value.author === userId) continue
      let remoteText = value.text || ''
      let remoteHash = this.vault._fastHash(`${remoteText}|${value.type || ''}`)
      let localText = textOf(localMeta[prop])

      if (localText === remoteText) {
        this.vault.markFieldPushed(itemIdentity, field(prop), remoteHash)
        continue
      }
      if (localText != null) {
        let localHash = this.vault._fastHash(`${localText}|${typeOf(localMeta[prop]) || value.type || ''}`)
        if (this.vault.hasLocalEdit(itemIdentity, field(prop), localHash)) {
          this._logConflict('metadata', itemIdentity, field(prop), {
            localValue: localText.slice(0, 50),
            remoteValue: remoteText.slice(0, 50),
            remoteAuthor: value.author,
            resolution: 'local-wins'
          })
          continue
        }
      }
      batch[prop] = { text: remoteText, type: value.type || TEXT }
    }

    let props = Object.keys(batch)
    if (props.length === 0) return
    try {
      await this.adapter.saveMetadata(localId, batch)
      for (let prop of props) {
        this.vault.markFieldPushed(itemIdentity, field(prop),
          this.vault._fastHash(`${batch[prop].text}|${batch[prop].type}`))
      }
      if (this._applyStats) this._applyStats.metadataUpdated += props.length
      this._debug(`metadata: ${props.length} field(s) on ${localId}`)
    } catch (err) {
      this.logger.warn(`Failed to save metadata on ${localId}: ${err.message}`)
    }
  },

  async applyMetadata(itemIdentity, localId, userId, localItem) {
    if (!this.options.syncMetadata) return
    await this._applyFields(itemIdentity, localId, prop => prop,
      schema.getMetadata(this.doc, itemIdentity), localItem, userId)
  },

  async applyTags(itemIdentity, localId, userId, tagMap, localItem) {
    if (!this.options.syncTags) return

    let localTagNames = new Set()
    for (let t of (localItem.tag || [])) {
      if (t && t.name) localTagNames.add(t.name.toLowerCase())
    }

    for (let tag of schema.getActiveTags(this.doc, itemIdentity)) {
      if (tag.author === userId) continue
      if (isLocalOnlyTag(tag.name)) continue
      let key = tag.name.toLowerCase()
      if (localTagNames.has(key)) continue

      this._assignments.tag(tag.name, tropyColor(tag.color), localId)
      localTagNames.add(key)
      if (this._applyStats) this._applyStats.tagsAdded++
    }

    if (!this.options.syncDeletions) return

    // Tags: no ownership guard — accept all tombstones (add-wins recovers)
    for (let tag of schema.getDeletedTags(this.doc, itemIdentity)) {
      if (tag.author === userId) continue
      let key = tag.name.toLowerCase()
      if (!localTagNames.has(key)) continue
      let existing = tagMap.get(key) || this.adapter.findTag(tag.name)
      if (!existing) continue
      try {
        await this.adapter.removeTags(localId, [existing.id])
      } catch (err) {
        this.logger.warn(`Failed to remove tag "${tag.name}" from item ${localId}: ${err.message}`)
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
    return noteFooter(escapeHtml(noteKey), 'from', authorLabel)
  },

  _findLocalNoteByUUID(noteKey) {
    return this.adapter.findNoteByKey(noteKey)
  },

  async _applyRemoteNote(noteKey, note, parent, existingTexts, userId, label) {
    let safeHtml = note.html
      ? sanitizeHtml(note.html)
      : `<p>${escapeHtml(note.text)}</p>`

    let authorLabel = escapeHtml(note.author || 'unknown')
    safeHtml = `${safeHtml}${this._makeFooter(noteKey, authorLabel)}`

    // Find existing local note by UUID (embedded in footer), then vault hint
    let existingLocalId = this._findLocalNoteByUUID(noteKey)
    if (!existingLocalId) {
      let vaultId = this.vault.getLocalNoteId(noteKey)
      if (vaultId && this.adapter.getNote(vaultId)) existingLocalId = vaultId
    }

    if (existingLocalId) {
      let localNote = this.adapter.getNote(existingLocalId)
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
          return false
        }
      }

      try {
        let { id } = await this.adapter.updateNote(existingLocalId, { html: safeHtml })
        this._recordAppliedNote(noteKey, id)
        if (this._applyStats) this._applyStats.notesUpdated++
        this._debug(`${label} updated: ${noteKey.slice(0, 8)}`)
        return true
      } catch (err) {
        this.logger.warn(`${label} update failed for ${noteKey.slice(0, 8)}, creating it instead: ${err.message}`)
      }
    }

    // Content-based dedup fallback — avoid creating duplicate if footer was stripped
    if (existingTexts.has(safeHtml.trim())) {
      this.vault.appliedNoteKeys.add(noteKey)
      if (this._applyStats) this._applyStats.notesDeduped++
      return false
    }

    try {
      let { id } = await this.adapter.createNote({
        html: safeHtml,
        language: note.language,
        photo: parent.photo || null,
        selection: parent.selection || null
      })
      this._recordAppliedNote(noteKey, id)
      existingTexts.add(safeHtml.trim())
      if (this._applyStats) this._applyStats.notesCreated++
      this._debug(`${label} created: ${noteKey.slice(0, 8)} by ${note.author}`)
      return true
    } catch (err) {
      this.logger.warn(`Failed to create ${label} ${noteKey.slice(0, 8)}: ${err.message}`)
      if (this._applyStats) this._applyStats.notesFailed++
      this._failedNoteKeys.add(noteKey)
    }
    return false
  },

  /**
   * Remember an applied note as Tropy STORED it. Tropy parses the HTML into
   * its editor's schema and serialises it back differently, so the hash
   * that later detects a local edit must come from the note, not the HTML
   * that was sent.
   */
  _recordAppliedNote(noteKey, localId) {
    this.vault.mapAppliedNote(noteKey, localId)
    this.vault.appliedNoteKeys.add(noteKey)
    let stored = this.adapter.getNote(localId)
    if (stored) this.vault.markNoteApplied(noteKey, this.adapter._noteStateToHtml(stored))
  },

  /** Photo of `photos` whose checksum is `checksum`, or the first photo. */
  _photoIdFor(photos, checksum) {
    let photo = checksum
      ? photos.find(p => p.checksum === checksum)
      : photos[0]
    return photo ? Number(photo['@id'] || photo.id) : null
  },

  /**
   * Apply one remote note unless its content is what was last applied.
   * Remembering the remote content (not guessing from the local text) is
   * what lets a SHORTENED note through.
   */
  async _applyNoteIfChanged(noteKey, note, parent, existingTexts, userId, label) {
    let remoteHash = this.vault._fastHash(`${note.html || ''}|${note.text || ''}`)
    if (this.vault.remoteNoteHashes.get(noteKey) === remoteHash &&
        this._findLocalNoteByUUID(noteKey)) {
      this._debug(`${label} ${noteKey.slice(0, 8)}: unchanged`)
      return
    }
    let applied = await this._applyRemoteNote(noteKey, note, parent, existingTexts, userId, label)
    if (applied || this.vault.appliedNoteKeys.has(noteKey)) {
      this.vault.remoteNoteHashes.set(noteKey, remoteHash)
      this.vault.markDirty()
    }
  },

  async applyNotes(itemIdentity, local, userId) {
    if (!this.options.syncNotes) return
    let photos = arrayOf(local.item.photo)
    let existingNoteTexts = this._buildExistingNoteTexts(photos.flatMap(p => p.note || []))

    for (let [noteKey, note] of Object.entries(schema.getNotes(this.doc, itemIdentity))) {
      if (note.deleted) {
        await this._retractNote(noteKey, note, userId, 'note')
        continue
      }
      if (note.author) this.vault.trackOriginalAuthor(noteKey, note.author)
      if (note.author === userId) continue
      if (!note.html && !note.text) continue

      let photo = this._photoIdFor(photos, note.photo)
      if (!photo) {
        this._debug(`note ${noteKey.slice(0, 8)}: no local photo ${String(note.photo).slice(0, 8)}`)
        continue
      }
      await this._applyNoteIfChanged(noteKey, note, { photo }, existingNoteTexts, userId, 'note')
    }
  },

  /**
   * A collaborator retracted their note: strike it through locally rather
   * than delete it, so the owner sees what went. Only the note's original
   * author may retract it.
   */
  async _retractNote(noteKey, note, userId, label) {
    if (note.author === userId) return
    let originalAuthor = this.vault.getOriginalAuthor(noteKey)
    if (originalAuthor && note.author !== originalAuthor) {
      this._debug(`ownership: rejected tombstone for ${label} ${noteKey.slice(0, 8)} — ${note.author} is not ${originalAuthor}`)
      return
    }
    if (this.vault.isDismissed(noteKey, note.pushSeq || 0)) return
    if (this.vault.retractedNoteKeys.has(noteKey)) return

    let localId = this._findLocalNoteByUUID(noteKey) || this.vault.getLocalNoteId(noteKey)
    if (!localId) return
    if (!this.adapter.getNote(localId)) {
      this.vault.retractedNoteKeys.add(noteKey)
      this.vault.markDirty()
      return
    }

    let authorLabel = escapeHtml(note.author || 'unknown')
    let contentHtml = note.html
      ? sanitizeHtml(note.html)
      : (note.text ? `<p>${escapeHtml(note.text)}</p>` : '')
    let retractedHtml = `${this._applyStrikethrough(contentHtml)}${noteFooter(escapeHtml(noteKey), 'retracted by', authorLabel)}`

    try {
      let { id } = await this.adapter.updateNote(localId, { html: retractedHtml })
      this.vault.mapAppliedNote(noteKey, id)
      this.vault.retractedNoteKeys.add(noteKey)
      this.vault.markDirty()
      if (this._applyStats) this._applyStats.notesRetracted++
      this._debug(`${label} retracted: ${noteKey.slice(0, 8)} by ${note.author}`)
    } catch (err) {
      this.logger.warn(`Failed to retract ${label} ${noteKey.slice(0, 8)}: ${err.message}`)
    }
  },

  async applyPhotoMetadata(itemIdentity, local, userId) {
    for (let photo of arrayOf(local.item.photo)) {
      let localId = photo['@id'] || photo.id
      if (!photo.checksum || !localId) continue
      await this._applyFields(itemIdentity, localId,
        prop => `photo:${photo.checksum}:${prop}`,
        schema.getPhotoMetadata(this.doc, itemIdentity, photo.checksum),
        photo.metadata || {}, userId)
    }
  },

  // Selections match by UUID, then by region (fingerprint) on the same photo.
  async applySelections(itemIdentity, local, userId) {
    if (!this.options.syncSelections) return
    let remoteSelections = schema.getActiveSelections(this.doc, itemIdentity)
    let photos = arrayOf(local.item.photo)

    // Region fingerprint → local selection id, over every local selection
    let byFingerprint = new Map()
    for (let p of photos) {
      if (!p.checksum) continue
      for (let ls of arrayOf(p.selection)) {
        byFingerprint.set(identity.computeSelectionFingerprint(p.checksum, ls), ls['@id'] || ls.id)
      }
    }

    for (let [selUUID, sel] of Object.entries(remoteSelections)) {
      if (sel.author) this.vault.trackOriginalAuthor(selUUID, sel.author)
      if (sel.author === userId) continue
      if (this.vault.appliedSelectionKeys.has(selUUID)) continue

      let x = Number(sel.x), y = Number(sel.y), w = Number(sel.w), h = Number(sel.h)
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
        this._log(`Skipping selection ${selUUID}: invalid region`, { x, y, w, h })
        continue
      }

      let photo = this._photoIdFor(photos, sel.photo)
      if (!photo || !sel.photo) continue

      let existing = byFingerprint.get(identity.computeSelectionFingerprint(sel.photo, sel))
      try {
        if (existing) {
          this.vault.mapAppliedSelection(selUUID, existing)
        } else {
          let { id } = await this.adapter.createSelection({
            photo, x, y, width: w, height: h, angle: sel.angle || 0
          })
          this.vault.mapAppliedSelection(selUUID, id)
          if (this._applyStats) this._applyStats.selectionsCreated++
          this._debug(`selection created: ${selUUID.slice(0, 8)} on photo ${photo}`)
        }
        this.vault.appliedSelectionKeys.add(selUUID)
      } catch (err) {
        this.logger.warn(`Failed to create selection on photo ${photo}: ${err.message}`)
      }
    }
  },

  /** CRDT UUID of a local selection (minted on first sight). */
  _selectionUUID(localSelId) {
    return this.vault.getSelectionKey(localSelId, identity.generateSelectionUUID())
  },

  async applySelectionNotes(itemIdentity, local, userId) {
    if (!this.options.syncNotes) return
    let all = schema.getAllSelectionNotes(this.doc, itemIdentity)

    for (let photo of arrayOf(local.item.photo)) {
      if (!photo.checksum) continue
      for (let sel of arrayOf(photo.selection)) {
        let localSelId = sel['@id'] || sel.id
        if (!localSelId) continue
        let selUUID = this._selectionUUID(localSelId)
        let existingTexts = this._buildExistingNoteTexts(sel.note || [])

        for (let [compositeKey, note] of Object.entries(all)) {
          if (!compositeKey.startsWith(`${selUUID}:`)) continue
          if (note.deleted) {
            await this._retractNote(compositeKey, note, userId, 'selection note')
            continue
          }
          if (note.author) this.vault.trackOriginalAuthor(compositeKey, note.author)
          if (note.author === userId) continue
          if (!note.html && !note.text) continue
          await this._applyNoteIfChanged(compositeKey, note,
            { selection: Number(localSelId) }, existingTexts, userId, 'selection note')
        }
      }
    }
  },

  async applySelectionMetadata(itemIdentity, local, userId) {
    for (let photo of arrayOf(local.item.photo)) {
      if (!photo.checksum) continue
      for (let sel of arrayOf(photo.selection)) {
        let localSelId = sel['@id'] || sel.id
        if (!localSelId) continue
        let selUUID = this._selectionUUID(localSelId)
        await this._applyFields(itemIdentity, localSelId,
          prop => `selmeta:${selUUID}:${prop}`,
          schema.getSelectionMeta(this.doc, itemIdentity, selUUID),
          sel.metadata || {}, userId)
      }
    }
  },

  /**
   * Transcriptions are versions in Tropy: a remote transcription, new or
   * changed, is added as the newest version on its photo or selection.
   * Nothing is deleted, so a bad remote text never destroys local work.
   */
  async applyTranscriptions(itemIdentity, local, userId) {
    if (!this.options.syncTranscriptions) return
    let photos = arrayOf(local.item.photo)

    let selUUIDToLocalId = new Map()
    for (let p of photos) {
      for (let s of arrayOf(p.selection)) {
        let localSelId = s['@id'] || s.id
        if (localSelId) selUUIDToLocalId.set(this._selectionUUID(localSelId), localSelId)
      }
    }

    for (let [txKey, tx] of Object.entries(schema.getActiveTranscriptions(this.doc, itemIdentity))) {
      if (tx.author) this.vault.trackOriginalAuthor(txKey, tx.author)
      if (tx.author === userId) continue
      if (!tx.text && !tx.data) continue

      let hash = this.vault._fastHash(`${tx.text || ''}|${tx.data || ''}`)
      if (this.vault.remoteTxHashes.get(txKey) === hash) continue

      let photo = this._photoIdFor(photos, tx.photo)
      if (!photo || !tx.photo) continue
      let selection = tx.selection ? (selUUIDToLocalId.get(tx.selection) || null) : null
      if (tx.selection && !selection) continue

      try {
        let { id } = await this.adapter.createTranscription({
          photo, selection: selection ? Number(selection) : null,
          text: tx.text, data: tx.data
        })
        this.vault.mapAppliedTranscription(txKey, id)
        this.vault.appliedTranscriptionKeys.add(txKey)
        this.vault.remoteTxHashes.set(txKey, hash)
        this.vault.markDirty()
        if (this._applyStats) this._applyStats.transcriptionsCreated++
        this._debug(`transcription ${txKey.slice(0, 8)} by ${tx.author}`)
      } catch (err) {
        this.logger.warn(`Failed to add transcription ${txKey.slice(0, 8)}: ${err.message}`)
      }
    }
  },

  // List memberships match lists by name.
  async applyLists(itemIdentity, local, userId, listMap) {
    let localId = local.localId
    let localListNames = new Set()
    for (let listId of (local.item.lists || [])) {
      let name = this._listNameCache.get(listId) || this._listNameCache.get(String(listId))
      if (name) localListNames.add(name)
    }

    for (let [listUUID, list] of Object.entries(schema.getActiveLists(this.doc, itemIdentity))) {
      if (list.author === userId) continue
      let listName = list.name || listUUID
      if (localListNames.has(listName)) continue
      this.vault.mapAppliedList(listUUID, listName)

      let localList = listMap.get(listName)
      if (!localList) continue
      this._assignments.list(localList.id, localId)
      localListNames.add(listName)
      if (this._applyStats) this._applyStats.listsAdded++
    }

    if (!this.options.syncDeletions) return
    // Lists: no ownership guard — accept all tombstones (add-wins recovers)
    for (let [listUUID, list] of Object.entries(schema.getLists(this.doc, itemIdentity))) {
      if (!list.deleted || list.author === userId) continue
      let listName = list.name || listUUID
      let localList = listMap.get(listName)
      if (!localList || !localListNames.has(listName)) continue
      try {
        await this.adapter.removeItemsFromList(localList.id, [localId])
      } catch (err) {
        this.logger.warn(`Failed to remove item ${localId} from list "${listName}": ${err.message}`)
      }
    }
  },

  // --- Project structure: templates and the list tree ---

  async applyTemplates() {
    let userId = this._stableUserId
    let local = this.adapter.readTemplates()
    // Tropy always has its preset templates; none means the ontology has not
    // loaded yet, and creating one now would collide with what is on disk.
    if (Object.keys(local).length === 0) {
      this._projectDirty = true
      return
    }
    let applied = 0

    for (let [uri, tmpl] of Object.entries(schema.getTemplateSchema(this.doc))) {
      if (tmpl.deleted || tmpl.author === userId) continue
      if (local[uri] || isTropyPresetTemplate(uri)) continue

      try {
        await this.adapter.createTemplate(uri, {
          name: tmpl.name,
          type: tmpl.type || 'https://tropy.org/v1/tropy#Item',
          creator: tmpl.creator || '',
          description: tmpl.description || '',
          isProtected: !!tmpl.isProtected,
          domain: tmpl.domain || null,
          fields: (tmpl.fields || []).map((f, idx) => ({
            property: f.property,
            label: f.label || '',
            datatype: f.datatype || 'http://www.w3.org/2001/XMLSchema#string',
            isRequired: !!f.isRequired,
            isConstant: !!f.isConstant,
            hint: f.hint || '',
            value: f.value || '',
            position: idx
          }))
        })
        applied++
        this._debug(`template created: ${tmpl.name} (${uri})`)
      } catch (err) {
        this.logger.warn(`Failed to create template "${tmpl.name}": ${err.message}`)
      }
    }

    if (applied > 0) this._log(`applied ${applied} template(s)`)
  },

  async applyListHierarchy() {
    let userId = this._stableUserId
    let localLists = this.adapter.readLists()

    let localByName = new Map()
    for (let [id, list] of Object.entries(localLists)) {
      if (Number(id) === 0 || !list.name) continue
      localByName.set(list.name, Number(id))
    }

    let remote = Object.entries(schema.getListHierarchy(this.doc))
      .filter(([, e]) => !e.deleted && e.author !== userId)
      .map(([uuid, e]) => ({ uuid, ...e }))

    let applied = 0
    for (let entry of this._topoSortLists(remote)) {
      let mapped = this.vault.crdtUuidToListId.get(entry.uuid)
      if (mapped != null && localLists[mapped]) continue

      let existing = localByName.get(entry.name)
      if (existing != null) {
        this.vault.listIdToCrdtUuid.set(existing, entry.uuid)
        this.vault.crdtUuidToListId.set(entry.uuid, existing)
        continue
      }

      let parent = entry.parent ? (this.vault.crdtUuidToListId.get(entry.parent) ?? 0) : 0
      try {
        let { id } = await this.adapter.createList({ name: entry.name, parent })
        this.vault.listIdToCrdtUuid.set(id, entry.uuid)
        this.vault.crdtUuidToListId.set(entry.uuid, id)
        localByName.set(entry.name, id)
        applied++
        this._debug(`list created: "${entry.name}" (${entry.uuid})`)
      } catch (err) {
        this.logger.warn(`Failed to create list "${entry.name}": ${err.message}`)
      }
    }

    if (applied > 0) this._log(`applied ${applied} list(s)`)
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
