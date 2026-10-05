'use strict'

const {
  TAG, ITEM, METADATA, NOTE, NAV, SELECTION, TRANSCRIPTION, LIST, ONTOLOGY
} = require('./tropy-action-types')
const { footerKey, footerKeyOfNote } = require('./local-only')

/**
 * StoreAdapter — the one module that knows how to talk to Tropy.
 *
 * Tropy gives a plugin its project window's Redux store and nothing else
 * that can change a project. None of that is a published interface, so
 * every state shape Troparcel reads and every action it dispatches lives
 * here, and only here. The shapes are Tropy's own action creators
 * (src/actions/*.js, src/slices/transcriptions.js), checked against 1.17.3
 * and main; `npm run e2e` checks them against a running Tropy.
 *
 * Three rules every write follows:
 *
 *   1. It is a COMMAND: `meta.cmd` set, `meta.done` unset. Tropy's command
 *      saga runs only then, and only the command writes the database. An
 *      action with `done: true` changes the window and is lost on restart.
 *   2. It carries NO `meta.history`. A collaborator's change is not the
 *      owner's to undo; with no history the command adds no undo entry.
 *   3. It resolves when its EFFECT is visible in the store, and rejects if
 *      the command finishes without it or the effect never comes.
 *
 * `probe()` checks the state shape before anything is written. If it
 * fails, the engine syncs nothing and says why, rather than dispatching
 * actions a different Tropy might misread.
 */
class StoreAdapter {
  static REQUIRED_SLICES = [
    'project', 'items', 'photos', 'selections', 'notes', 'metadata',
    'tags', 'lists', 'ontology', 'activities', 'nav', 'transcriptions'
  ]

  static TIMEOUT = 15000

  constructor(store, logger) {
    this.store = store
    this.logger = logger
    this._suppressChangeDetection = false
  }

  /**
   * Does this store look like the Tropy Troparcel was written for?
   * @returns {{ ok: boolean, problems: string[] }}
   */
  probe() {
    let problems = []
    let state
    try {
      state = this._getState()
    } catch (err) {
      return { ok: false, problems: [`cannot read the store: ${err.message}`] }
    }
    if (!state || typeof state !== 'object') {
      return { ok: false, problems: ['the store has no state'] }
    }
    for (let slice of StoreAdapter.REQUIRED_SLICES) {
      if (!(slice in state)) problems.push(`state.${slice} is missing`)
    }
    if (state.ontology && !state.ontology.template) {
      problems.push('state.ontology.template is missing')
    }
    return { ok: problems.length === 0, problems }
  }

  _getState() {
    return this.store.getState()
  }

  // ------------------------------------------------------------------ Reads

  /**
   * Every item, nested. An item whose inputs are the same objects as last
   * time (Redux state is immutable) comes back as the same object, so a
   * cycle over a large project where little changed costs reference
   * comparisons, not a rebuild of every item.
   */
  getAllItemsFull() {
    let state = this._getState()
    let cache = this._itemCache || (this._itemCache = new Map())
    let result = []
    let seen = new Set()
    for (let key of Object.keys(state.items)) {
      let id = Number(key)
      seen.add(id)
      let deps = this._itemInputs(state, id)
      let hit = cache.get(id)
      if (hit && sameRefs(hit.deps, deps)) {
        result.push(hit.value)
        continue
      }
      let value = this._buildItemFull(state, id)
      cache.set(id, { deps, value })
      if (value) result.push(value)
    }
    for (let id of cache.keys()) if (!seen.has(id)) cache.delete(id)
    return result
  }

  /** The state objects an item's nested form is built from. */
  _itemInputs(state, id) {
    let item = state.items[id]
    let deps = [item, state.metadata[id], state.tags]
    for (let pid of (item && item.photos) || []) {
      let photo = state.photos[pid]
      deps.push(photo, state.metadata[pid])
      if (!photo) continue
      for (let nid of photo.notes || []) deps.push(state.notes[nid])
      for (let tid of photo.transcriptions || []) deps.push(state.transcriptions[tid])
      for (let sid of photo.selections || []) {
        let sel = state.selections[sid]
        deps.push(sel, state.metadata[sid])
        if (!sel) continue
        for (let nid of sel.notes || []) deps.push(state.notes[nid])
        for (let tid of sel.transcriptions || []) deps.push(state.transcriptions[tid])
      }
    }
    return deps
  }

  getItemFull(itemId) {
    return this._buildItemFull(this._getState(), itemId)
  }

  /** One item with its photos, selections, notes and metadata nested. */
  _buildItemFull(state, itemId) {
    let item = state.items[itemId]
    if (!item) return null

    let enriched = {
      '@id': itemId,
      template: item.template,
      lists: item.lists || []
    }

    let meta = state.metadata[itemId]
    if (meta) {
      for (let [key, value] of Object.entries(meta)) {
        if (key === 'id') continue
        if (typeof value === 'object' && value !== null) {
          enriched[key] = { '@value': value.text || '', '@type': value.type || '' }
        } else if (value != null) {
          enriched[key] = value
        }
      }
    }

    enriched.tag = []
    for (let tid of (item.tags || [])) {
      let tag = state.tags[tid]
      if (tag) enriched.tag.push({ id: tid, name: tag.name, color: tag.color || null })
    }

    enriched.photo = []
    for (let pid of (item.photos || [])) {
      let photo = state.photos[pid]
      if (!photo) continue

      let ep = {
        '@id': pid,
        checksum: photo.checksum,
        note: [],
        selection: [],
        transcription: [],
        metadata: copyMetadata(state.metadata[pid])
      }

      for (let nid of (photo.notes || [])) {
        let note = state.notes[nid]
        if (note) ep.note.push(this._noteEntry(nid, note, { photo: pid }))
      }

      for (let txid of (photo.transcriptions || [])) {
        let tx = state.transcriptions[txid]
        if (tx) ep.transcription.push(tx)
      }

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
          transcription: [],
          metadata: copyMetadata(state.metadata[sid])
        }
        for (let nid of (sel.notes || [])) {
          let note = state.notes[nid]
          if (note) es.note.push(this._noteEntry(nid, note, { selection: sid }))
        }
        for (let txid of (sel.transcriptions || [])) {
          let tx = state.transcriptions[txid]
          if (tx) es.transcription.push(tx)
        }
        ep.selection.push(es)
      }

      enriched.photo.push(ep)
    }

    return enriched
  }

  _noteEntry(id, note, parent) {
    return {
      '@id': id,
      text: note.text || '',
      html: this._noteStateToHtml(note),
      language: note.language || null,
      ...parent
    }
  }

  getAllTags() {
    let { tags } = this._getState()
    return Object.values(tags || {}).map(t => ({
      id: t.id, name: t.name, color: t.color || null
    }))
  }

  /** The tag with this name, compared as Tropy does (case-insensitively). */
  findTag(name) {
    let lower = String(name).toLowerCase()
    return this.getAllTags().find(t => t.name && t.name.toLowerCase() === lower) || null
  }

  getAllLists() {
    let { lists } = this._getState()
    return Object.values(lists || {}).map(l => ({
      id: l.id, name: l.name, parent: l.parent ?? null
    }))
  }

  /** Raw `state.ontology.template`: URI → definition. Not getAllTemplates,
   *  which resolves and flattens and so loses the identity push needs. */
  readTemplates() {
    let state = this._getState()
    return (state.ontology && state.ontology.template) || {}
  }

  /** Raw `state.lists`: id → { id, parent, name, children }. Root is 0. */
  readLists() {
    return this._getState().lists || {}
  }

  getNote(id) {
    return this._getState().notes[id] || null
  }

  /**
   * Resolves once Tropy has loaded the project into its state.
   *
   * On opening a project Tropy runs item.load, photo.load, note.load and
   * the rest, then searches, and puts the result in `state.qr` (sagas/
   * project.js, sagas/search.js). The search result's `items` is a frozen
   * array; the initial `qr.items` is a plain []. So "qr.items is frozen and
   * no load is running" means loaded, whenever we first look. Timing
   * cannot: in a small project the loads end ~50 ms after it opens, before
   * Troparcel has started, and in a 10,000-item one they start ~2 s after.
   * test/scenarios/tropy-drift.test.js checks Tropy still works this way.
   */
  whenLoaded({ fallback = 15000 } = {}) {
    let loaded = () => isLoaded(this._getState())
    if (loaded()) return Promise.resolve()
    return new Promise(resolve => {
      let unsub = () => {}
      let finish = () => {
        clearTimeout(timer)
        unsub()
        resolve()
      }
      let timer = setTimeout(() => {
        this.logger.warn(`[troparcel] Tropy did not finish loading the project in ${fallback / 1000} s; starting anyway`)
        finish()
      }, fallback)
      unsub = this.store.subscribe(() => { if (loaded()) finish() })
    })
  }

  /** A photo as Tropy holds it, with its absolute `path` and file facts. */
  getPhoto(id) {
    return this._getState().photos[id] || null
  }

  /** The checksum of every photo in the project. */
  getAllChecksums() {
    return Object.values(this._getState().photos).map(p => p.checksum).filter(Boolean)
  }

  /**
   * Import items given as Tropy JSON-LD nodes. Done when a photo with each
   * of `checksums` exists. Tropy's import also resets the view mode and
   * search, so the owner's view is put back afterwards.
   */
  async importItems(nodes, checksums) {
    let nav = pickNav(this._getState().nav)
    let want = new Set(checksums)
    await this._command(this._cmd(ITEM.IMPORT, { data: nodes }), s => {
      let found = 0
      for (let p of Object.values(s.photos)) if (want.has(p.checksum)) found++
      return found >= want.size
    }, Math.max(StoreAdapter.TIMEOUT, nodes.length * 2000))
    this._restoreNav(nav)
  }

  /** An item as Tropy holds it: { id, photos, tags, lists, template }. */
  /** A transcription, or null once removed from its photo or selection. */
  getTranscription(id) {
    let s = this._getState()
    let tr = s.transcriptions[id]
    if (!tr) return null
    let parent = s.photos[tr.parent] || s.selections[tr.parent]
    return parent && (parent.transcriptions || []).includes(Number(id)) ? tr : null
  }

  /**
   * A selection, or null once deleted. Tropy keeps a deleted selection in
   * `state.selections`; only its photo's `selections` list loses it.
   */
  getSelection(id) {
    let s = this._getState()
    let sel = s.selections[id]
    let photo = sel && s.photos[sel.photo]
    return sel && photo && (photo.selections || []).includes(Number(id)) ? sel : null
  }

  getItem(id) {
    return this._getState().items[id] || null
  }

  /**
   * The local note carrying the footer for room entry `key`, or null.
   *
   * The index costs one pass over the notes, made at most once per write
   * phase (suppressChanges clears it) and kept current by createNote. A
   * lookup per note against the live notes slice made a bulk apply O(N²).
   * An id is returned only if that note still exists.
   */
  findNoteByKey(key) {
    let notes = this._getState().notes
    if (!this._noteIndex) {
      this._noteIndex = new Map()
      for (let [id, note] of Object.entries(notes)) {
        let k = footerKeyOfNote(note)
        if (k) this._noteIndex.set(k, Number(id))
      }
    }
    let id = this._noteIndex.get(key)
    return (id != null && notes[id]) ? id : null
  }

  // ----------------------------------------------------------------- Writes

  /**
   * Dispatch a command and wait until `effect(state)` returns something.
   * Resolves with that value.
   */
  _command(action, effect, timeout = StoreAdapter.TIMEOUT) {
    let dispatched
    try {
      dispatched = this.store.dispatch(action)
    } catch (err) {
      return Promise.reject(err)
    }
    let seq = dispatched && dispatched.meta && dispatched.meta.seq

    return new Promise((resolve, reject) => {
      let settled = false
      let unsub = () => {}
      let finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsub()
        fn(value)
      }
      let check = () => {
        let state = this._getState()
        let result
        try {
          result = effect(state)
        } catch (err) {
          return finish(reject, err)
        }
        if (result) return finish(resolve, result)
        // The command ran to the end without its effect: it failed.
        if (seq && state.activities && !state.activities[seq] && seenActivity) {
          finish(reject, new Error(`${action.type} finished without effect`))
        }
        if (seq && state.activities && state.activities[seq]) seenActivity = true
      }
      let seenActivity = false
      let timer = setTimeout(() =>
        finish(reject, new Error(`${action.type} timed out after ${timeout}ms`)), timeout)
      unsub = this.store.subscribe(check)
      check()
    })
  }

  /**
   * An effect for a create command: the first id that appears in a
   * parent's child list (`listOf`) and exists in its slice (`slice`).
   * Looking only at the parent keeps a create O(children), not O(slice):
   * scanning the slice made N creates cost O(N²).
   */
  _newChild(listOf, slice) {
    let before = new Set(listOf(this._getState()) || [])
    return s => {
      for (let id of (listOf(s) || [])) {
        if (!before.has(id) && slice(s)[id]) return Number(id)
      }
      return null
    }
  }

  _cmd(type, payload, cmd = 'project') {
    return { type, payload, meta: { cmd } }
  }

  /**
   * Create a note. Tropy's note.create also SELECTS the new note, which
   * would move the owner's view to a collaborator's note mid-edit; the
   * owner's selection is put back afterwards.
   */
  async createNote({ photo, selection, html, language }) {
    if (!photo && !selection) throw new Error('createNote: needs a photo or a selection')

    let state = this._getState()
    let nav = pickNav(state.nav)
    let notesOf = selection
      ? s => s.selections[selection] && s.selections[selection].notes
      : s => s.photos[photo] && s.photos[photo].notes

    let payload = { text: html || '' }
    if (selection) payload.selection = selection
    else payload.photo = photo
    if (language) payload.language = language

    let id = await this._command(this._cmd(NOTE.CREATE, payload),
      this._newChild(notesOf, s => s.notes))

    this._restoreNav(nav)
    let key = footerKey(html)
    if (key && this._noteIndex) this._noteIndex.set(key, id)
    return { id }
  }

  _restoreNav(nav) {
    let now = pickNav(this._getState().nav)
    if (JSON.stringify(now) === JSON.stringify(nav)) return
    this.store.dispatch({ type: NAV.UPDATE, payload: nav })
  }

  deleteNote(id) {
    return this._command(this._cmd(NOTE.DELETE, [id]), s => !s.notes[id] || s.notes[id].deleted)
  }

  /**
   * Replace a note's content. Tropy's note.update wants a live ProseMirror
   * state that only its editor can build, so this deletes and recreates;
   * the note gets a new id. If the create fails the old text is put back.
   */
  async updateNote(id, { html, language }) {
    let existing = this.getNote(id)
    if (!existing) throw new Error(`note ${id} not found`)
    let parent = existing.selection
      ? { selection: existing.selection }
      : { photo: existing.photo }
    let lang = language || existing.language || null
    let original = this._noteStateToHtml(existing)

    await this.deleteNote(id)
    try {
      return await this.createNote({ ...parent, html, language: lang })
    } catch (err) {
      this.logger.warn(`updateNote: create failed for note ${id}, restoring it — ${err.message}`)
      await this.createNote({ ...parent, html: original, language: lang })
      throw err
    }
  }

  async createSelection({ photo, x, y, width, height, angle }) {
    let id = await this._command(
      this._cmd(SELECTION.CREATE, { photo, x, y, width, height, angle: angle || 0 }),
      this._newChild(s => s.photos[photo] && s.photos[photo].selections, s => s.selections))
    return { id }
  }

  /** `data`: { [propertyUri]: { text, type } } on an item, photo or selection. */
  saveMetadata(id, data) {
    let props = Object.keys(data)
    return this._command(this._cmd(METADATA.SAVE, { ids: [id], data }), s => {
      let m = s.metadata[id]
      return m && props.every(p => m[p] && m[p].text === data[p].text)
    })
  }

  /** Create a tag, assigning it to `items` in the same command. */
  async createTag({ name, color, items = [] }) {
    let payload = { name }
    if (color) payload.color = color
    if (items.length) payload.items = items
    return this._command(this._cmd(TAG.CREATE, payload), s => {
      let tag = Object.values(s.tags).find(t => t.name === name)
      if (!tag) return null
      if (items.some(i => !(s.items[i]?.tags || []).includes(tag.id))) return null
      return { id: tag.id, name: tag.name, color: tag.color || null }
    })
  }

  /** Give one item, or many, these tags: one command however many. */
  addTags(itemIds, tagIds) {
    let ids = [].concat(itemIds)
    return this._command(this._cmd(ITEM.TAG.CREATE, { id: ids, tags: tagIds }), s =>
      ids.every(i => tagIds.every(t => (s.items[i]?.tags || []).includes(t))))
  }

  removeTags(itemIds, tagIds) {
    let ids = [].concat(itemIds)
    return this._command(this._cmd(ITEM.TAG.DELETE, { id: ids, tags: tagIds }), s =>
      ids.every(i => tagIds.every(t => !(s.items[i]?.tags || []).includes(t))))
  }

  /**
   * Add a transcription. Tropy keeps a photo's transcriptions as versions,
   * newest active; a changed remote transcription arrives as a new version.
   */
  /**
   * Delete selections of one photo. Done when the photo's list no longer
   * holds them: Tropy leaves a deleted selection in `state.selections`.
   */
  deleteSelections(photo, ids) {
    let selections = ids.map(Number)
    return this._command(this._cmd(SELECTION.DELETE, { photo, selections }), s =>
      !selections.some(id => (s.photos[photo]?.selections || []).includes(id)))
  }

  /** Remove transcriptions. Done when no parent's list holds them. */
  removeTranscriptions(ids) {
    let list = ids.map(Number)
    let before = this._getState()
    let parents = list.map(id => before.transcriptions[id]?.parent)
    let holds = (s, id, parent) =>
      (s.photos[parent]?.transcriptions || []).includes(id) ||
      (s.selections[parent]?.transcriptions || []).includes(id)
    return this._command(this._cmd(TRANSCRIPTION.REMOVE, list), s =>
      !list.some((id, i) => parents[i] != null && holds(s, id, parents[i])))
  }

  async createTranscription({ photo, selection, text, data }) {
    let payload = { photo, text: text || '' }
    if (selection) payload.selection = selection
    if (data) payload.data = data
    let parentOf = selection
      ? s => s.selections[selection] && s.selections[selection].transcriptions
      : s => s.photos[photo] && s.photos[photo].transcriptions
    let id = await this._command(this._cmd(TRANSCRIPTION.CREATE, payload),
      this._newChild(parentOf, s => s.transcriptions))
    return { id }
  }

  async createList({ name, parent = 0 }) {
    let id = await this._command(this._cmd(LIST.CREATE, { name, parent }),
      this._newChild(s => s.lists[parent] && s.lists[parent].children, s => s.lists))
    return { id }
  }

  addItemsToList(listId, itemIds) {
    return this._command(this._cmd(LIST.ITEM.ADD, { id: listId, items: itemIds }), s =>
      itemIds.every(i => (s.items[i]?.lists || []).includes(listId)))
  }

  removeItemsFromList(listId, itemIds) {
    return this._command(this._cmd(LIST.ITEM.REMOVE, { id: listId, items: itemIds }), s =>
      itemIds.every(i => !(s.items[i]?.lists || []).includes(listId)))
  }

  /** Create a template in the owner's ontology (shared by all projects). */
  createTemplate(uri, def) {
    return this._command(this._cmd(ONTOLOGY.TEMPLATE.CREATE, { [uri]: def }, 'ontology'),
      s => !!(s.ontology.template && s.ontology.template[uri]))
  }

  // ------------------------------------------------------- Change detection

  /**
   * Call `callback()` when any synced slice changes, unless suppressed.
   * Returns an unsubscribe function.
   */
  subscribe(callback) {
    this._prevState = this._getState()
    let slices = [
      'items', 'photos', 'selections', 'notes', 'metadata', 'tags',
      'lists', 'transcriptions'
    ]
    return this.store.subscribe(() => {
      if (this._suppressChangeDetection) return
      let state = this._getState()
      let changed = slices.some(s => state[s] !== this._prevState[s])
      this._prevState = state
      if (!changed) return
      try {
        callback()
      } catch (err) {
        this.logger.warn(`subscribe callback error: ${String(err.message || err)}`)
      }
    })
  }

  /** Stop reporting changes (while Troparcel itself writes). */
  suppressChanges() {
    this._suppressChangeDetection = true
    this._noteIndex = null
  }

  /** Report changes again; what changed while suppressed is not reported. */
  resumeChanges() {
    this._prevState = this._getState()
    this._suppressChangeDetection = false
  }

  // --------------------------------------------------------- Note HTML

  /** A Tropy note (ProseMirror state + text) as HTML. */
  _noteStateToHtml(note) {
    if (note.html) return note.html
    if (note.state && note.state.doc) return this._renderDoc(note.state.doc)
    if (note.text) return `<p>${this._esc(note.text)}</p>`
    return ''
  }

  _renderDoc(doc) {
    if (!doc) return ''
    if (typeof doc.toJSON === 'function') doc = doc.toJSON()
    return childrenOf(doc).map(n => this._renderNode(n)).join('')
  }

  _renderNode(node) {
    if (!node) return ''
    if (typeof node.toJSON === 'function') node = node.toJSON()
    let children = childrenOf(node).map(n => this._renderNode(n)).join('')

    let type = typeof node.type === 'string' ? node.type : (node.type && node.type.name) || ''
    switch (type) {
      case 'paragraph': {
        // Tropy writes 'left' as no style and 'right' as 'end'.
        let align = node.attrs && node.attrs.align
        if (align && align !== 'left') {
          return `<p style="text-align: ${align === 'right' ? 'end' : align}">${children}</p>`
        }
        return `<p>${children}</p>`
      }
      case 'blockquote': return `<blockquote>${children}</blockquote>`
      case 'ordered_list': return `<ol>${children}</ol>`
      case 'bullet_list': return `<ul>${children}</ul>`
      case 'list_item': return `<li>${children}</li>`
      case 'heading': {
        let l = (node.attrs && node.attrs.level) || 1
        return `<h${l}>${children}</h${l}>`
      }
      case 'horizontal_rule': return '<hr>'
      case 'code_block': return `<pre><code>${children}</code></pre>`
      case 'hard_break': return '<span class="line-break"><br></span>'
      case 'text': {
        let t = this._esc(node.text || '')
        for (let m of (node.marks || [])) {
          let mtype = typeof m.type === 'string' ? m.type : (m.type && m.type.name) || ''
          switch (mtype) {
            case 'bold':
            case 'strong': t = `<strong>${t}</strong>`; break
            case 'italic':
            case 'em': t = `<em>${t}</em>`; break
            case 'link': t = `<a href="${this._esc((m.attrs && m.attrs.href) || '')}">${t}</a>`; break
            case 'superscript':
            case 'sup': t = `<sup>${t}</sup>`; break
            case 'subscript':
            case 'sub': t = `<sub>${t}</sub>`; break
            case 'strikethrough': t = `<span style="text-decoration: line-through">${t}</span>`; break
            case 'underline': t = `<span style="text-decoration: underline">${t}</span>`; break
            case 'overline': t = `<span style="text-decoration: overline">${t}</span>`; break
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
      .replace(/'/g, '&#x27;')
  }
}

function sameRefs(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function copyMetadata(meta) {
  if (!meta) return null
  let out = {}
  for (let [key, value] of Object.entries(meta)) {
    if (key !== 'id') out[key] = value
  }
  return out
}

/** ProseMirror JSON keeps children in `content`; a live Fragment nests them. */
function childrenOf(node) {
  let c = node && node.content
  if (!c) return []
  if (Array.isArray(c)) return c
  return Array.isArray(c.content) ? c.content : []
}

function isLoaded(state) {
  let items = state && state.qr && state.qr.items
  return Array.isArray(items) && Object.isFrozen(items) && !isLoading(state)
}

function isLoading(state) {
  return Object.values((state && state.activities) || {}).some(a => /load$/i.test(String(a && a.type)))
}

/** The parts of the view a Troparcel write may disturb; only those set. */
function pickNav(nav = {}) {
  let out = {}
  for (let k of ['mode', 'query', 'items', 'photo', 'selection', 'note']) {
    if (nav[k] !== undefined) out[k] = nav[k]
  }
  return out
}

module.exports = { StoreAdapter }
