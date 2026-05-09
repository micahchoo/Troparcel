'use strict'

/**
 * FakeStoreAdapter — drop-in replacement for src/store-adapter.js for tests.
 *
 * Holds Tropy's Redux state shape in memory. Implements every read/write helper
 * that apply.js + push.js + sync-engine.js call. Records dispatched actions for
 * assertion. Mirrors reducer behavior for the action types troparcel uses
 * (sourced from tropy/src/reducers/{lists,ontology,tag,metadata,notes}.js).
 *
 * Not a full Tropy reducer — only handles the subset troparcel dispatches.
 * Add cases here as the plugin grows.
 *
 * Usage:
 *   const adapter = new FakeStoreAdapter({ initialState: {...} })
 *   adapter.dispatch({ type: 'tag.create', payload: {...} })
 *   adapter.actions          // → array of every dispatched action, in order
 *   adapter.store.getState() // → current state
 */

const LIST_ROOT = 0

// Default state matches Tropy's Redux shape after PROJECT.OPEN
function defaultState() {
  return {
    project: { id: 'test-project', path: '/tmp/test.tpy' },
    items: {},
    photos: {},
    selections: {},
    notes: {},
    transcriptions: {},
    metadata: {},
    tags: {},
    lists: {
      [LIST_ROOT]: { id: LIST_ROOT, parent: null, name: '', children: [] }
    },
    ontology: {
      template: {},
      props: {},
      class: {},
      type: {},
      vocab: {}
    }
  }
}

let nextId = 1
const newId = () => nextId++

class FakeStoreAdapter {
  constructor({ initialState = {}, userId = 'fake-user' } = {}) {
    this.state = { ...defaultState(), ...initialState }
    this.userId = userId
    this.actions = []           // every action ever dispatched
    this.suppressedActions = [] // actions dispatched while suppressed
    this._suppressed = false
    this._subscribers = []

    // Tropy's StoreAdapter exposes a `store` proxy with dispatch + getState.
    this.store = {
      dispatch: (action) => this._dispatch(action),
      getState: () => this.state
    }
  }

  // Real adapter (store-adapter.js:75) exposes _getState as the canonical
  // private accessor; apply.js + push.js call this 10+ times.
  _getState() {
    return this.state
  }

  // --- Read helpers (mirror Tropy's selectors + real store-adapter.js method names) ---
  // Names with "read" prefix are troparcel-specific helpers used by apply/push.
  // Names with "getAll" / "getItem" mirror the REAL src/store-adapter.js methods.

  readItems()        { return this.state.items }
  readPhotos()       { return this.state.photos }
  readSelections()   { return this.state.selections }
  readNotes()        { return this.state.notes }
  readTranscriptions() { return this.state.transcriptions }
  readMetadata(id)   { return id == null ? this.state.metadata : (this.state.metadata[id] || {}) }
  readTags()         { return this.state.tags }
  readLists()        { return this.state.lists }       // V5 — currently missing on real adapter (see W2.T5)
  readTemplates()    { return this.state.ontology.template } // V5 — currently missing on real adapter (see W2.T5)
  readProps()        { return this.state.ontology.props }
  readFullItem(id)   { return this.state.items[id] }

  // --- Methods present on the real store-adapter.js (must exist on fake to test current code) ---
  getAllLists()       { return this.state.lists }
  getAllTags()        { return this.state.tags }
  getAllItems()       { return this.state.items }
  getAllItemsFull()   { return Object.values(this.state.items).map(item => this._buildItemFull(this.state, item.id)) }
  getItemFull(itemId) { return this._buildItemFull(this.state, itemId) }

  /**
   * Build the "full item" projection — item + its photos + photos' selections.
   * Mirrors store-adapter.js _buildItemFull (line 90-110ish).
   */
  _buildItemFull(state, itemId) {
    const item = state.items[itemId]
    if (!item) return null
    const photoIds = Array.isArray(item.photo) ? item.photo : (item.photo != null ? [item.photo] : [])
    const photos = photoIds.map(pid => state.photos[pid]).filter(Boolean).map(photo => {
      const selectionIds = Array.isArray(photo.selection) ? photo.selection : (photo.selection != null ? [photo.selection] : [])
      const selections = selectionIds.map(sid => state.selections[sid]).filter(Boolean)
      return { ...photo, selection: selections }
    })
    return { ...item, photo: photos }
  }

  /**
   * Convert a ProseMirror state JSON to HTML.
   * Real adapter uses prosemirror-model's DOMSerializer; fake stub returns a
   * plain-text wrap. Sufficient for tests that don't exercise rich note round-trips.
   * Tests that need real round-trip should mock this further or move to Tier 3.
   */
  _noteStateToHtml(state) {
    if (!state || typeof state !== 'object') return ''
    if (state.html) return state.html
    if (state.text) return `<p>${state.text}</p>`
    return ''
  }

  // --- Write helpers ---

  /**
   * dispatchSuppressed — INTENTIONALLY ABSENT.
   * apply.js currently calls this.adapter.dispatchSuppressed(...) at 4 sites.
   * Real store-adapter.js does NOT define it. Tests that exercise _applyAttribution
   * with the current code SHOULD FAIL with "dispatchSuppressed is not a function" —
   * that's the P0 bug captured in seed tropy-plugin-03ee.
   *
   * After W1.T1 fix lands, _applyAttribution uses this.adapter.store.dispatch
   * directly, and tests pass.
   */

  suppressChanges() {
    this._suppressed = true
  }

  resumeChanges() {
    this._suppressed = false
  }

  subscribe(callback) {
    this._subscribers.push(callback)
    return () => {
      this._subscribers = this._subscribers.filter(s => s !== callback)
    }
  }

  _waitForAction(action, _timeout = 15000) {
    // Synchronous in fake — action already dispatched + reduced.
    return Promise.resolve(action)
  }

  // --- High-level write wrappers (mirror real store-adapter.js convenience methods) ---

  /**
   * Create a note via dispatch. Real adapter dispatches note.create with
   * {state, text, id: parentItemId} and resolves to the new note id via
   * state diff. Fake assigns a fresh id and returns it directly.
   */
  async createNote({ id: parentId, state, text }) {
    const id = newId()
    const note = { id, state, text, photo: null, selection: null,
                   language: null, created: new Date(), modified: new Date(), deleted: false }
    this.state.notes = { ...this.state.notes, [id]: note }
    this._dispatch({ type: 'note.create', payload: { id, state, text, parent: parentId },
                    meta: { cmd: 'project', history: 'add' } })
    return id
  }

  async updateNote({ id, state, text }) {
    const n = this.state.notes[id]
    if (!n) return null
    this.state.notes[id] = { ...n, state, text, modified: new Date() }
    this._dispatch({ type: 'note.save', payload: { id, state, text },
                     meta: { cmd: 'project', history: 'add' } })
    return id
  }

  async deleteNote(id) {
    const n = this.state.notes[id]
    if (!n) return
    this.state.notes[id] = { ...n, deleted: true }
    this._dispatch({ type: 'note.delete', payload: { id },
                     meta: { cmd: 'project', history: 'add' } })
  }

  async createSelection({ photo, x, y, w, h, angle = 0 }) {
    const id = newId()
    this.state.selections[id] = { id, photo, x, y, w, h, angle, deleted: false }
    this._dispatch({ type: 'selection.create',
                     payload: { id, photo, x, y, width: w, height: h, angle },
                     meta: { cmd: 'project', history: 'add' } })
    return id
  }

  async addItemsToList({ id: listId, items }) {
    this._dispatch({ type: 'list.item.add',
                     payload: { id: listId, items: Array.isArray(items) ? items : [items] },
                     meta: { cmd: 'project', history: 'add', search: true } })
  }

  async removeItemsFromList(listId, items) {
    this._dispatch({ type: 'list.item.remove',
                     payload: { id: listId, items: Array.isArray(items) ? items : [items] },
                     meta: { cmd: 'project', history: 'add', search: true } })
  }

  // --- Internal dispatch + reducer ---

  _dispatch(action) {
    this.actions.push(action)
    if (this._suppressed) this.suppressedActions.push(action)

    this._reduce(action)

    if (!this._suppressed) {
      for (const sub of this._subscribers) {
        try { sub() } catch { /* ignore */ }
      }
    }
    return action
  }

  _reduce({ type, payload }) {
    switch (type) {
      case 'tag.create': {
        // payload: {id, color}
        const id = payload.id ?? newId()
        this.state.tags = { ...this.state.tags, [id]: { id, color: payload.color, name: '' } }
        break
      }
      case 'tag.save': {
        // payload: {id, name}
        const t = this.state.tags[payload.id]
        if (t) this.state.tags = { ...this.state.tags, [payload.id]: { ...t, ...payload } }
        break
      }
      case 'item.tag.create': {
        // payload: {id: [itemId], tags: [tagId]}
        // Mirrors the AddTags saga effect: on dispatch of ITEM.TAG.CREATE the
        // saga persists then emits ITEM.TAG.INSERT (which the items reducer
        // applies via nested.add('tags', ...)). The fake collapses both
        // saga + reducer into the state mutation below so tier-1 tests can
        // assert on the resulting items[id].tags without running redux-saga.
        // FIXED 2256: previously keyed on 'item.tags.add' which was a
        // silent-no-op literal in apply.js — masked the bug at test time.
        const itemIds = Array.isArray(payload.id) ? payload.id : [payload.id]
        for (const itemId of itemIds) {
          const item = this.state.items[itemId]
          if (item) {
            const existing = new Set(item.tags || [])
            for (const t of payload.tags) existing.add(t)
            this.state.items[itemId] = { ...item, tags: [...existing] }
          }
        }
        break
      }
      case 'list.create': {
        // payload: {name, parent, position?}  — id is DB-assigned; mirror by minting one
        const id = newId()
        const parent = payload.parent ?? LIST_ROOT
        const list = { id, name: payload.name, parent, children: [] }
        const parentList = this.state.lists[parent]
        if (parentList) {
          this.state.lists = {
            ...this.state.lists,
            [parent]: { ...parentList, children: [...parentList.children, id] },
            [id]: list
          }
        } else {
          this.state.lists = { ...this.state.lists, [id]: list }
        }
        break
      }
      case 'list.save': {
        // payload: {id, name?, parent?}
        const list = this.state.lists[payload.id]
        if (list) {
          this.state.lists = { ...this.state.lists, [payload.id]: { ...list, ...payload } }
        }
        break
      }
      case 'list.item.add': {
        // payload: {id: listId, items: [itemId]}
        const list = this.state.lists[payload.id]
        if (list) {
          const items = new Set(list.items || [])
          for (const i of payload.items) items.add(i)
          this.state.lists = { ...this.state.lists, [payload.id]: { ...list, items: [...items] } }
        }
        break
      }
      case 'list.item.remove': {
        const list = this.state.lists[payload.id]
        if (list && list.items) {
          const drop = new Set(payload.items)
          this.state.lists = { ...this.state.lists, [payload.id]: { ...list, items: list.items.filter(i => !drop.has(i)) } }
        }
        break
      }
      case 'metadata.save': {
        // payload: {id, data: {[propUri]: {text, type, lang?}}}
        const cur = this.state.metadata[payload.id] || {}
        this.state.metadata = {
          ...this.state.metadata,
          [payload.id]: { ...cur, ...payload.data }
        }
        break
      }
      case 'ontology.template.create':
      case 'ontology.template.save': {
        // payload: { [uri]: {name, type, fields, isProtected?, domain?, ...} }
        const next = { ...this.state.ontology.template }
        for (const [uri, def] of Object.entries(payload)) {
          next[uri] = { id: uri, ...def }
        }
        this.state.ontology = { ...this.state.ontology, template: next }
        break
      }
      case 'ontology.template.delete': {
        // payload: uri or [uri, ...]
        const uris = Array.isArray(payload) ? payload : [payload]
        const next = { ...this.state.ontology.template }
        for (const uri of uris) delete next[uri]
        this.state.ontology = { ...this.state.ontology, template: next }
        break
      }
      case 'note.create': {
        const id = payload.id ?? newId()
        this.state.notes = { ...this.state.notes, [id]: { id, ...payload } }
        break
      }
      case 'note.save':
      case 'note.update': {
        const n = this.state.notes[payload.id]
        if (n) this.state.notes = { ...this.state.notes, [payload.id]: { ...n, ...payload } }
        break
      }
      default:
        // Ignore unknown action types — test asserts on `actions[]` directly
        break
    }
  }

  // --- Test helpers ---

  /** Seed an item programmatically (skipping action dispatch). */
  seedItem(item) {
    this.state.items[item.id] = item
  }

  /** Seed a tag programmatically. */
  seedTag(tag) {
    this.state.tags[tag.id] = { id: tag.id, name: tag.name, color: tag.color || 'blue' }
  }

  /** Filter actions of a given type. Useful for assertion. */
  actionsByType(type) {
    return this.actions.filter(a => a.type === type)
  }

  /** Reset the dispatch log (does NOT reset state). */
  clearActions() {
    this.actions = []
    this.suppressedActions = []
  }
}

module.exports = { FakeStoreAdapter, LIST_ROOT, defaultState }
