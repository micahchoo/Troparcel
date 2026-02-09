'use strict'

const identity = require('./identity')

/**
 * Enrich mixin — HTTP API item enrichment (fallback path).
 *
 * These methods are mixed onto SyncEngine.prototype via Object.assign.
 * All `this` references resolve to the SyncEngine instance at call time.
 *
 * Only used when the Redux store is unavailable (temp engines in export/import
 * hooks, or before the store has loaded). When store is available, items are
 * read directly via StoreAdapter.getAllItemsFull().
 */
module.exports = {

  /**
   * Enrich all summaries with bounded parallelism (P1).
   */
  async _enrichAll(summaries) {
    let items = []
    // Process in batches of 5 to avoid overwhelming the API
    let batchSize = 5
    for (let i = 0; i < summaries.length; i += batchSize) {
      let batch = summaries.slice(i, i + batchSize)
      let results = await Promise.all(
        batch.map(s => this.enrichItem(s).catch(err => {
          this.logger.warn(`Failed to enrich item ${s.id}`, { error: err.message })
          return null
        }))
      )
      for (let r of results) {
        if (r) items.push(r)
      }
    }
    return items
  },

  /**
   * P1: Parallel sub-resource fetching within an item.
   * P3: Notes fetched as HTML only (not json+html separately).
   */
  async enrichItem(summary) {
    let enriched = {
      '@id': summary.id,
      template: summary.template,
      lists: summary.lists || []
    }

    // Fetch metadata and tags in parallel
    let [meta, tags] = await Promise.all([
      this.api.getMetadata(summary.id).catch(() => null),
      this.api.getItemTags(summary.id).catch(() => null)
    ])

    if (meta) {
      for (let [key, value] of Object.entries(meta)) {
        if (key === 'id') continue
        if (typeof value === 'object' && value !== null) {
          enriched[key] = {
            '@value': value.text || '',
            '@type': value.type || ''
          }
        } else if (value != null) {
          enriched[key] = value
        }
      }
    }

    if (tags && Array.isArray(tags)) {
      enriched.tag = tags.map(t => ({
        id: t.id || t.tag_id,
        name: t.name,
        color: t.color || null
      }))
    }

    // Fetch photos — then parallelize per-photo sub-resources
    enriched.photo = []
    let photoIds = summary.photos || []

    // Fetch all photos in parallel
    let photoResults = await Promise.all(
      photoIds.map(pid => this.api.getPhoto(pid).catch(() => null))
    )

    for (let photo of photoResults) {
      if (!photo) continue

      let enrichedPhoto = {
        '@id': photo.id,
        checksum: photo.checksum,
        note: [],
        selection: [],
        transcription: [],
        metadata: null
      }

      // Fetch all sub-resources for this photo in parallel
      let subFetches = []

      // Photo metadata
      if (this.options.syncPhotoAdjustments) {
        subFetches.push(
          this.api.getMetadata(photo.id).catch(() => null)
            .then(m => { enrichedPhoto.metadata = m })
        )
      }

      // P3: Fetch notes as HTML only (not json+html separately)
      let noteIds = photo.notes || []
      for (let noteId of noteIds) {
        subFetches.push(
          this.api.getNote(noteId, 'html').catch(() => null).then(html => {
            if (html != null) {
              enrichedPhoto.note.push({
                '@id': noteId,
                text: typeof html === 'string' ? html.replace(/<[^>]*>/g, '') : '',
                html: typeof html === 'string' ? html : '',
                language: null,
                photo: photo.id
              })
            }
          })
        )
      }

      // Fetch selections
      let selectionIds = photo.selections || []
      for (let selId of selectionIds) {
        subFetches.push(
          this._enrichSelection(selId, photo.checksum).then(sel => {
            if (sel) enrichedPhoto.selection.push(sel)
          })
        )
      }

      // Photo transcriptions
      let txIds = photo.transcriptions || []
      for (let txId of txIds) {
        subFetches.push(
          this.api.getTranscription(txId, 'json').catch(() => null).then(tx => {
            if (tx) enrichedPhoto.transcription.push(tx)
          })
        )
      }

      await Promise.all(subFetches)
      enriched.photo.push(enrichedPhoto)
    }

    return enriched
  },

  async _enrichSelection(selId, photoChecksum) {
    try {
      let sel = await this.api.getSelection(selId)
      if (!sel) return null

      let enrichedSel = {
        '@id': sel.id,
        x: sel.x,
        y: sel.y,
        width: sel.width,
        height: sel.height,
        angle: sel.angle || 0,
        note: [],
        metadata: null,
        transcription: []
      }

      let subFetches = []

      // Selection metadata
      subFetches.push(
        this.api.getMetadata(selId).catch(() => null)
          .then(m => { enrichedSel.metadata = m })
      )

      // Selection notes (P3: HTML only)
      let selNoteIds = sel.notes || []
      for (let noteId of selNoteIds) {
        subFetches.push(
          this.api.getNote(noteId, 'html').catch(() => null).then(html => {
            if (html != null) {
              enrichedSel.note.push({
                '@id': noteId,
                text: typeof html === 'string' ? html.replace(/<[^>]*>/g, '') : '',
                html: typeof html === 'string' ? html : '',
                language: null,
                selection: sel.id
              })
            }
          })
        )
      }

      // Selection transcriptions
      let selTxIds = sel.transcriptions || []
      for (let txId of selTxIds) {
        subFetches.push(
          this.api.getTranscription(txId, 'json').catch(() => null).then(tx => {
            if (tx) enrichedSel.transcription.push(tx)
          })
        )
      }

      await Promise.all(subFetches)
      return enrichedSel
    } catch (err) {
      this.logger.warn('Failed to enrich selection', { error: String(err) })
      return null
    }
  }
}
