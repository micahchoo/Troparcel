'use strict'

/**
 * StoreAdapter — reads from and writes to Tropy's Redux store.
 *
 * Tropy's plugin context includes `context.window.store`, the full
 * Redux store for the project window.  This adapter replaces the
 * HTTP API for reads (eliminates N+1 enrichment calls) and uses
 * store.dispatch() for writes where the HTTP API has no routes
 * (selections, note updates, list item management).
 *
 * ⚠ TROPY INTERNALS DEPENDENCY ⚠
 * This adapter accesses undocumented Redux internals. If Tropy changes
 * its state shape or action types, state shape validation (_validateStateShape)
 * will log a warning and the engine falls back to the HTTP API.
 *
 * Redux state slices READ:
 *   state.items[id]           → { id, photos:[], tags:[], lists:[], template }
 *   state.photos[id]          → { id, item, checksum, selections:[], notes:[], transcriptions:[] }
 *   state.selections[id]      → { id, photo, x, y, width, height, angle, notes:[], transcriptions:[] }
 *   state.notes[id]           → { id, photo, selection, state (ProseMirror JSON), text, language }
 *   state.metadata[sid]       → { id, [propUri]: { text, type } }
 *   state.tags[id]            → { id, name, color }
 *   state.lists[id]           → { id, name, parent, children:[] }
 *   state.activities[seq]     → presence = action in flight (cleared on completion)
 *   state.transcriptions[id]  → { id, text, data, ... }
 *
 * Redux actions DISPATCHED:
 *   selection.create  → { photo, x, y, width, height, angle }, meta: { cmd: 'project' }
 *   note.create       → { photo?, selection?, text (HTML) },   meta: { cmd: 'project', history: 'add' }
 *   note.delete       → [id],                                  meta: { cmd: 'project', history: 'add' }
 *   list.item.add     → { id: listId, items: [itemId] },       meta: { cmd: 'project', history: 'add', search: true }
 *   list.item.remove  → { id: listId, items: [itemId] },       meta: { cmd: 'project', history: 'add', search: true }
 *
 * Action completion is detected by watching state.activities[action.meta.seq]
 * — when the seq key disappears, the command has finished processing.
 */
class StoreAdapter {
  static EXPECTED_SLICES = [
    'items', 'photos', 'selections', 'notes',
    'metadata', 'tags', 'lists'
  ]

  constructor(store, logger) {
    this.store = store
    this.logger = logger

    // Suppress store.subscribe callback during our own writes
    this._suppressChangeDetection = false

    this._validateStateShape()
  }

  /**
   * Check that the Redux state contains the expected top-level slices.
   * Logs a warning for any missing slices — the adapter will still work
   * (reads return empty, writes fall back to HTTP API) but sync may be
   * incomplete.
   */
  _validateStateShape() {
    try {
      let state = this._getState()
      let missing = StoreAdapter.EXPECTED_SLICES.filter(s => !(s in state))
      if (missing.length > 0) {
        this.logger.warn(
          `StoreAdapter: Redux state missing expected slices: ${missing.join(', ')}. ` +
          'Tropy version may be incompatible — some sync features may not work.'
        )
      }
    } catch (err) {
      this.logger.warn(`StoreAdapter: failed to validate state shape: ${err.message}`)
    }
  }

  _getState() {
    return this.store.getState()
  }

  // ------------------------------------------------------------------ Reads

  /**
   * Return all items as summaries (mirrors ApiClient.getItems format).
   */
  getAllItems() {
    let { items, photos } = this._getState()
    let result = []

    for (let id of Object.keys(items)) {
      let item = items[id]
      result.push({
        id: Number(id),
        template: item.template,
        photos: item.photos || [],
        lists: item.lists || [],
        tags: item.tags || []
      })
    }
    return result
  }

  /**
   * Assemble a fully-enriched item from the normalised Redux state.
   * Returns the same nested shape that SyncEngine.enrichItem() produced.
   */
  getItemFull(itemId) {
    return this._buildItemFull(this._getState(), itemId)
  }

  /**
   * Return all items fully enriched in a single pass (one state read).
   */
  getAllItemsFull() {
    let state = this._getState()
    let result = []
    for (let id of Object.keys(state.items)) {
      let item = this._buildItemFull(state, Number(id))
      if (item) result.push(item)
    }
    return result
  }

  /**
   * Build a fully-enriched item from a pre-read state snapshot.
   */
  _buildItemFull(state, itemId) {
    let item = state.items[itemId]
    if (!item) return null

    let enriched = {
      '@id': itemId,
      template: item.template,
      lists: item.lists || []
    }

    // --- Item metadata ---
    let meta = state.metadata[itemId]
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

    // --- Tags (resolve IDs → objects) ---
    let tagIds = item.tags || []
    enriched.tag = []
    for (let tid of tagIds) {
      let tag = state.tags[tid]
      if (tag) {
        enriched.tag.push({
          id: tid,
          name: tag.name,
          color: tag.color || null
        })
      }
    }

    // --- Photos ---
    enriched.photo = []
    let photoIds = item.photos || []

    for (let pid of photoIds) {
      let photo = state.photos[pid]
      if (!photo) continue

      let ep = {
        '@id': pid,
        checksum: photo.checksum,
        note: [],
        selection: [],
        transcription: [],
        metadata: null
      }

      // Photo metadata
      let photoMeta = state.metadata[pid]
      if (photoMeta) {
        ep.metadata = {}
        for (let [key, value] of Object.entries(photoMeta)) {
          if (key === 'id') continue
          ep.metadata[key] = value
        }
      }

      // Photo notes
      for (let nid of (photo.notes || [])) {
        let note = state.notes[nid]
        if (!note) continue
        let html = this._noteStateToHtml(note)
        ep.note.push({
          '@id': nid,
          text: note.text || '',
          html,
          language: note.language || null,
          photo: pid
        })
      }

      // Photo transcriptions
      if (state.transcriptions) {
        for (let txid of (photo.transcriptions || [])) {
          let tx = state.transcriptions[txid]
          if (tx) ep.transcription.push(tx)
        }
      }

      // Selections
      for (let sid of (photo.selections || [])) {
        let sel = state.selections[sid]
        if (!sel) continue

        let es = {
          '@id': sid,
          x: sel.x,
          y: sel.y,
          width: sel.width,
          height: sel.height,
          angle: sel.angle || 0,
          note: [],
          metadata: null,
          transcription: []
        }

        // Selection metadata
        let selMeta = state.metadata[sid]
        if (selMeta) {
          es.metadata = {}
          for (let [key, value] of Object.entries(selMeta)) {
            if (key === 'id') continue
            es.metadata[key] = value
          }
        }

        // Selection notes
        for (let nid of (sel.notes || [])) {
          let note = state.notes[nid]
          if (!note) continue
          let html = this._noteStateToHtml(note)
          es.note.push({
            '@id': nid,
            text: note.text || '',
            html,
            language: note.language || null,
            selection: sid
          })
        }

        // Selection transcriptions
        if (state.transcriptions) {
          for (let txid of (sel.transcriptions || [])) {
            let tx = state.transcriptions[txid]
            if (tx) es.transcription.push(tx)
          }
        }

        ep.selection.push(es)
      }

      enriched.photo.push(ep)
    }

    return enriched
  }

  /**
   * Return all tags as an array of { id, name, color }.
   */
  getAllTags() {
    let { tags } = this._getState()
    return Object.values(tags || {}).map(t => ({
      id: t.id,
      name: t.name,
      color: t.color || null
    }))
  }

  /**
   * Return all lists as an array of { id, name, parent }.
   */
  getAllLists() {
    let { lists } = this._getState()
    return Object.values(lists || {}).map(l => ({
      id: l.id,
      name: l.name,
      parent: l.parent || null
    }))
  }

  /**
   * Check if the store is still usable (always true when we have a store ref).
   */
  ping() {
    return !!this.store
  }

  // ----------------------------------------------------------- Writes (dispatch)

  /**
   * Create a selection on a photo.
   * Returns { id } of the created selection.
   */
  async createSelection({ photo, x, y, width, height, angle }) {
    let idsBefore = new Set(Object.keys(this._getState().selections))

    let action = this.store.dispatch({
      type: 'selection.create',
      payload: { photo, x, y, width, height, angle: angle || 0 },
      meta: { cmd: 'project' }
    })
    await this._waitForAction(action)

    let state = this._getState()
    let idsAfter = Object.keys(state.selections)
    // Filter new IDs by matching parent photo to handle concurrent UI creations
    let candidates = []
    for (let id of idsAfter) {
      if (!idsBefore.has(id)) {
        let sel = state.selections[id]
        if (sel && sel.photo === photo) {
          candidates.push(id)
        }
      }
    }
    // If multiple candidates match, prefer the last one (most recently created)
    if (candidates.length > 0) {
      let id = candidates[candidates.length - 1]
      return { id: Number(id), '@id': Number(id) }
    }
    return null
  }

  /**
   * Create a note attached to a photo or selection.
   * The note.create command calls fromHTML() internally when state is null.
   * Returns { id } of the created note.
   */
  async createNote({ photo, selection, html, language }) {
    // Guard: note.create requires a valid parent (photo or selection)
    if (!photo && !selection) {
      this.logger.warn('createNote: no photo or selection — skipping')
      return null
    }

    let idsBefore = new Set(Object.keys(this._getState().notes))

    let payload = { text: html || '' }
    if (photo) payload.photo = photo
    if (selection) payload.selection = selection
    if (language) payload.language = language

    let action = this.store.dispatch({
      type: 'note.create',
      payload,
      meta: { cmd: 'project', history: 'add' }
    })
    await this._waitForAction(action)

    let state = this._getState()
    let idsAfter = Object.keys(state.notes)
    // Filter new IDs by matching parent (photo/selection) to handle concurrent UI creations
    let candidates = []
    for (let id of idsAfter) {
      if (!idsBefore.has(id)) {
        let note = state.notes[id]
        if (note) {
          let parentMatch = (photo && note.photo === photo) ||
                            (selection && note.selection === selection)
          if (parentMatch) candidates.push(id)
        }
      }
    }
    if (candidates.length > 0) {
      let id = candidates[candidates.length - 1]
      return { id: Number(id), '@id': Number(id) }
    }
    // Fallback: return any new ID if no parent match (shouldn't happen normally)
    for (let id of idsAfter) {
      if (!idsBefore.has(id)) {
        return { id: Number(id), '@id': Number(id) }
      }
    }
    return null
  }

  /**
   * Update a note's content.
   * Since ProseMirror state is needed for note.update and we only have HTML,
   * we delete the old note and recreate with new content.
   * Returns { id } of the new note.
   */
  async updateNote(id, { html, language }) {
    let state = this._getState()
    let existing = state.notes[id]

    if (!existing) {
      throw new Error(`Note ${id} not found in store`)
    }

    let photo = existing.photo || undefined
    let selection = existing.selection || undefined
    let lang = language || existing.language || null

    // Capture original content for rollback if create fails
    let originalHtml = this._noteStateToHtml(existing)

    try { await this.deleteNote(id) } catch {}

    let result
    try {
      result = await this.createNote({ photo, selection, html, language: lang })
    } catch (createErr) {
      // Create failed — attempt to restore original content
      this.logger.warn(`updateNote: create threw after delete for note ${id}`, { error: createErr.message })
      try {
        result = await this.createNote({ photo, selection, html: originalHtml, language: lang })
      } catch (restoreErr) {
        this.logger.warn(`updateNote: restore also failed for note ${id}`, { error: restoreErr.message })
        throw createErr
      }
      return result
    }
    if (!result) {
      // Create returned null — attempt to restore original content
      this.logger.warn(`updateNote: create returned null after delete, restoring original for note ${id}`)
      try {
        result = await this.createNote({ photo, selection, html: originalHtml, language: lang })
      } catch (restoreErr) {
        this.logger.warn(`updateNote: restore also failed for note ${id}`, { error: restoreErr.message })
        throw new Error(`updateNote: note ${id} deleted but both create and restore failed`)
      }
      if (!result) {
        throw new Error(`updateNote: note ${id} deleted but both create and restore returned null`)
      }
    }
    return result
  }

  /**
   * Delete a note by ID.
   */
  async deleteNote(id) {
    let action = this.store.dispatch({
      type: 'note.delete',
      payload: [id],
      meta: { cmd: 'project', history: 'add' }
    })
    await this._waitForAction(action)
  }

  /**
   * Add items to a list.
   */
  async addItemsToList(listId, itemIds) {
    let action = this.store.dispatch({
      type: 'list.item.add',
      payload: { id: listId, items: Array.isArray(itemIds) ? itemIds : [itemIds] },
      meta: { cmd: 'project', history: 'add', search: true }
    })
    await this._waitForAction(action)
  }

  /**
   * Remove items from a list.
   */
  async removeItemsFromList(listId, itemIds) {
    let action = this.store.dispatch({
      type: 'list.item.remove',
      payload: { id: listId, items: Array.isArray(itemIds) ? itemIds : [itemIds] },
      meta: { cmd: 'project', history: 'add', search: true }
    })
    await this._waitForAction(action)
  }

  // ------------------------------------------------------- Change detection

  /**
   * Subscribe to Redux state changes that are relevant to sync.
   * Calls `callback()` when any tracked slice changes, unless suppressed.
   * Returns an unsubscribe function.
   */
  subscribe(callback) {
    this._prevState = this._getState()
    let slices = [
      'items', 'photos', 'selections', 'notes',
      'metadata', 'tags', 'lists'
    ]

    return this.store.subscribe(() => {
      if (this._suppressChangeDetection) return

      let state = this._getState()
      let changed = false
      for (let slice of slices) {
        if (state[slice] !== this._prevState[slice]) {
          changed = true
          break
        }
      }
      this._prevState = state

      if (changed) {
        try {
          callback()
        } catch (err) {
          this.logger.warn(`subscribe callback error: ${String(err.message || err)}`)
        }
      }
    })
  }

  /**
   * Suppress change detection (call before applying remote changes).
   */
  suppressChanges() {
    this._suppressChangeDetection = true
  }

  /**
   * Resume change detection (call after applying remote changes).
   */
  resumeChanges() {
    // Reset prevState so our own suppressed-phase changes don't trigger
    // the subscriber as "new" on the next external state change
    this._prevState = this._getState()
    this._suppressChangeDetection = false
  }

  // -------------------------------------------------------- Action completion

  /**
   * Wait for a dispatched command to complete.
   * Watches the `activities` slice for the action's seq to be cleared.
   */
  _waitForAction(action, timeout = 15000) {
    if (!action || !action.meta || !action.meta.seq) {
      return Promise.resolve()
    }

    let seq = action.meta.seq

    return new Promise((resolve, reject) => {
      let settled = false

      let timer = setTimeout(() => {
        if (settled) return
        settled = true
        unsub()
        reject(new Error(`waitForAction: ${action.type} seq=${seq} timed out after ${timeout}ms`))
      }, timeout)

      let unsub = this.store.subscribe(() => {
        if (settled) return
        let state = this._getState()
        if (!state.activities || !state.activities[seq]) {
          settled = true
          clearTimeout(timer)
          unsub()
          resolve()
        }
      })

      // Already done?
      if (!settled) {
        let state = this._getState()
        if (!state.activities || !state.activities[seq]) {
          settled = true
          clearTimeout(timer)
          unsub()
          resolve()
        }
      }
    })
  }

  // --------------------------------------------------------- Note HTML helpers

  /**
   * Convert a Redux note (ProseMirror state JSON + text) to HTML.
   */
  _noteStateToHtml(note) {
    if (note.html) return note.html

    if (note.state && note.state.doc) {
      return this._renderDoc(note.state.doc)
    }

    if (note.text) {
      return `<p>${this._esc(note.text)}</p>`
    }

    return ''
  }

  _renderDoc(doc) {
    if (!doc || !doc.content) return ''
    // Handle live ProseMirror Node (doc.content is a Fragment, not an array)
    if (typeof doc.toJSON === 'function') doc = doc.toJSON()
    if (!doc.content) return ''
    let content = doc.content
    if (!Array.isArray(content)) {
      if (Array.isArray(content.content)) content = content.content
      else return ''
    }
    return content.map(n => this._renderNode(n)).join('')
  }

  _renderNode(node) {
    if (!node) return ''
    // Handle live ProseMirror Node objects (content is Fragment, type is NodeType)
    if (typeof node.toJSON === 'function') node = node.toJSON()
    let children = ''
    if (node.content) {
      let c = node.content
      if (!Array.isArray(c)) {
        if (Array.isArray(c.content)) c = c.content
        else c = []
      }
      children = c.map(n => this._renderNode(n)).join('')
    }

    let type = typeof node.type === 'string' ? node.type : (node.type && node.type.name) || ''
    switch (type) {
      case 'paragraph': {
        // Tropy: 'left' → no style, 'right' → 'text-align: end', others → direct
        let align = node.attrs && node.attrs.align
        if (align && align !== 'left') {
          let ta = align === 'right' ? 'end' : align
          return `<p style="text-align: ${ta}">${children}</p>`
        }
        return `<p>${children}</p>`
      }
      case 'blockquote':
        return `<blockquote>${children}</blockquote>`
      case 'ordered_list':
        return `<ol>${children}</ol>`
      case 'bullet_list':
        return `<ul>${children}</ul>`
      case 'list_item':
        return `<li>${children}</li>`
      case 'heading': {
        let l = (node.attrs && node.attrs.level) || 1
        return `<h${l}>${children}</h${l}>`
      }
      case 'horizontal_rule':
        return '<hr>'
      case 'code_block':
        return `<pre><code>${children}</code></pre>`
      case 'hard_break':
        return '<span class="line-break"><br></span>'
      case 'text': {
        let t = this._esc(node.text || '')
        if (node.marks) {
          for (let m of node.marks) {
            let mtype = typeof m.type === 'string' ? m.type : (m.type && m.type.name) || ''
            switch (mtype) {
              case 'bold':
              case 'strong':
                t = `<strong>${t}</strong>`; break
              case 'italic':
              case 'em':
                t = `<em>${t}</em>`; break
              case 'link':
                t = `<a href="${this._esc((m.attrs && m.attrs.href) || '')}">${t}</a>`; break
              case 'superscript':
              case 'sup':
                t = `<sup>${t}</sup>`; break
              case 'subscript':
              case 'sub':
                t = `<sub>${t}</sub>`; break
              case 'strikethrough':
                t = `<span style="text-decoration: line-through">${t}</span>`; break
              case 'underline':
                t = `<span style="text-decoration: underline">${t}</span>`; break
              case 'overline':
                t = `<span style="text-decoration: overline">${t}</span>`; break
            }
          }
        }
        return t
      }
      default:
        return children
    }
  }

  _esc(str) {
    let s = String(str)
    let out = ''
    for (let i = 0; i < s.length; i++) {
      let c = s[i]
      switch (c) {
        case '&': out += '&amp;'; break
        case '<': out += '&lt;'; break
        case '>': out += '&gt;'; break
        case '"': out += '&quot;'; break
        case "'": out += '&#x27;'; break
        default: out += c
      }
    }
    return out
  }
}

module.exports = { StoreAdapter }
