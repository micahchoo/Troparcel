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
 * The Redux state is normalised:
 *   state.items[id]      → { id, photos:[], tags:[], lists:[], template }
 *   state.photos[id]     → { id, item, checksum, selections:[], notes:[], transcriptions:[] }
 *   state.selections[id] → { id, photo, x, y, width, height, angle, notes:[], transcriptions:[] }
 *   state.notes[id]      → { id, photo, selection, state (ProseMirror), text, language }
 *   state.metadata[sid]  → { id, [propUri]: value }
 *   state.tags[id]       → { id, name, color }
 *   state.lists[id]      → { id, name, parent, children:[] }
 */
class StoreAdapter {
  constructor(store, logger) {
    this.store = store
    this.logger = logger

    // Suppress store.subscribe callback during our own writes
    this._suppressChangeDetection = false
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

    let idsAfter = Object.keys(this._getState().selections)
    for (let id of idsAfter) {
      if (!idsBefore.has(id)) {
        return { id: Number(id), '@id': Number(id) }
      }
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
      meta: { cmd: 'project' }
    })
    await this._waitForAction(action)

    let idsAfter = Object.keys(this._getState().notes)
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

    await this.deleteNote(id)

    return this.createNote({
      photo,
      selection,
      html,
      language: language || existing.language || null
    })
  }

  /**
   * Delete a note by ID.
   */
  async deleteNote(id) {
    let action = this.store.dispatch({
      type: 'note.delete',
      payload: { id },
      meta: { cmd: 'project' }
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
    let prevState = this._getState()
    let slices = [
      'items', 'photos', 'selections', 'notes',
      'metadata', 'tags', 'lists'
    ]

    return this.store.subscribe(() => {
      if (this._suppressChangeDetection) return

      let state = this._getState()
      let changed = false
      for (let slice of slices) {
        if (state[slice] !== prevState[slice]) {
          changed = true
          break
        }
      }
      prevState = state

      if (changed) {
        try {
          callback()
        } catch (err) {
          this.logger.warn(`subscribe callback error: ${err.message}`)
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
      let timer = setTimeout(() => {
        unsub()
        reject(new Error(`waitForAction: ${action.type} seq=${seq} timed out after ${timeout}ms`))
      }, timeout)

      let unsub = this.store.subscribe(() => {
        let state = this._getState()
        if (!state.activities || !state.activities[seq]) {
          clearTimeout(timer)
          unsub()
          resolve()
        }
      })

      // Already done?
      let state = this._getState()
      if (!state.activities || !state.activities[seq]) {
        clearTimeout(timer)
        unsub()
        resolve()
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
      case 'paragraph':
        return `<p>${children}</p>`
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
      case 'hard_break':
        return '<br>'
      case 'text': {
        let t = this._esc(node.text || '')
        if (node.marks) {
          for (let m of node.marks) {
            switch (m.type) {
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
                t = `<s>${t}</s>`; break
              case 'underline':
                t = `<u>${t}</u>`; break
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
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
}

module.exports = { StoreAdapter }
