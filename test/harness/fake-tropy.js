'use strict'

/**
 * A fake Tropy project window store: getState, dispatch, subscribe.
 *
 * Tests drive the REAL StoreAdapter over this store, so the action shapes
 * the adapter sends are checked here. The rules below are Tropy's, read
 * from its source (1.17.3 and main) and confirmed by `npm run e2e`:
 *
 *   - A command runs only with `meta.cmd` set and `meta.done` unset. An
 *     action with `done: true` changes nothing here, because in Tropy it
 *     changes the window and never reaches the database.
 *   - Payloads are the action creators' shapes. A wrong one throws, as the
 *     command would, and the effect never appears.
 *   - A command with `meta.history` adds an undo entry (`undo`).
 *   - note.create selects the new note (moves `nav`), as Tropy does.
 *
 * Commands finish asynchronously, like sagas: the effect lands on a later
 * tick, while `activities[seq]` is set.
 *
 *   let tropy = fakeTropy({ items: {...} })
 *   new StoreAdapter(tropy.store, logger)
 *   tropy.commands   // every command action, in order
 *   tropy.undo       // undo entries commands added
 */

const GENERIC = 'https://tropy.org/v1/templates/generic'
const TROPY = 'https://tropy.org/v1/tropy#'

function defaultState() {
  return {
    project: { id: 'p1', name: 'Test', path: '/tmp/test.tropy' },
    items: {},
    photos: {},
    selections: {},
    notes: {},
    transcriptions: {},
    metadata: {},
    tags: {},
    lists: { 0: { id: 0, parent: null, name: '', children: [] } },
    // Tropy always has its preset templates once the ontology has loaded.
    ontology: { template: { [GENERIC]: { id: GENERIC, name: 'Tropy Generic', fields: [] } } },
    activities: {},
    // Tropy's search result: a frozen array. The initial qr.items is a
    // plain [], and frozen means the project has loaded (whenLoaded).
    qr: { items: Object.freeze([]) },
    nav: { items: [], photo: null, selection: null, note: null }
  }
}

function fakeTropy(initial = {}) {
  let state = { ...defaultState(), ...initial }
  let listeners = []
  let seq = 0
  let nextId = 1000
  let tropy = { commands: [], actions: [], undo: [], rejected: [] }

  let set = (next) => {
    state = next
    for (let fn of listeners.slice()) fn()
  }

  let need = (cond, msg) => { if (!cond) throw new Error(msg) }

  // Each handler validates, then returns the next state.
  let handlers = {
    'note.create'({ text, state: pm, photo, selection }) {
      need(text != null || pm, 'note.create: text or state missing')
      need(photo != null || selection != null, 'note.create: no parent')
      let id = nextId++
      let s = { ...state, notes: { ...state.notes, [id]: {
        id, text: stripTags(text || ''), html: text, photo: selection ? null : photo, selection: selection || null
      } } }
      if (selection) {
        let sel = s.selections[selection]
        need(sel, `note.create: selection ${selection} not found`)
        s.selections = { ...s.selections, [selection]: { ...sel, notes: [...(sel.notes || []), id] } }
      } else {
        let p = s.photos[photo]
        need(p, `note.create: photo ${photo} not found`)
        s.photos = { ...s.photos, [photo]: { ...p, notes: [...(p.notes || []), id] } }
      }
      // Tropy's command selects the new note.
      s.nav = { ...s.nav, items: [undefined], photo, selection, note: id }
      return s
    },

    'note.delete'(ids) {
      need(Array.isArray(ids), 'note.delete: payload must be an array of ids')
      let notes = { ...state.notes }
      let photos = { ...state.photos }
      let selections = { ...state.selections }
      for (let id of ids) {
        let n = notes[id]
        if (!n) continue
        delete notes[id]
        if (n.photo && photos[n.photo]) {
          photos[n.photo] = { ...photos[n.photo], notes: photos[n.photo].notes.filter(x => x !== id) }
        }
        if (n.selection && selections[n.selection]) {
          selections[n.selection] = { ...selections[n.selection], notes: selections[n.selection].notes.filter(x => x !== id) }
        }
      }
      return { ...state, notes, photos, selections }
    },

    'selection.create'({ photo, x, y, width, height, angle }) {
      need(state.photos[photo], `selection.create: photo ${photo} not found`)
      need([x, y, width, height].every(Number.isFinite), 'selection.create: bad region')
      let id = nextId++
      let p = state.photos[photo]
      return {
        ...state,
        selections: { ...state.selections, [id]: { id, photo, x, y, width, height, angle, notes: [], transcriptions: [] } },
        photos: { ...state.photos, [photo]: { ...p, selections: [...(p.selections || []), id] } }
      }
    },

    // Tropy's JSON-LD import, for the shape project-room.js writes: full
    // IRIs, one tropy#photo list per item. Like Tropy, it needs each photo's
    // file to exist, takes the checksum from the JSON, and resets the view.
    'item.import'({ data }) {
      need(Array.isArray(data), 'item.import: payload.data must be JSON-LD nodes')
      let s = { ...state, items: { ...state.items }, photos: { ...state.photos } }
      for (let node of data) {
        let list = (node[`${TROPY}photo`] || [])[0]
        need(list && Array.isArray(list['@list']), 'item.import: an item without photos')
        let id = nextId++
        let photoIds = []
        for (let p of list['@list']) {
          let val = k => p[`${TROPY}${k}`] && p[`${TROPY}${k}`][0]['@value']
          need(val('checksum'), 'item.import: a photo without a checksum')
          need(require('node:fs').existsSync(val('path')), `item.import: no file at ${val('path')}`)
          let pid = nextId++
          s.photos[pid] = {
            id: pid, item: id, checksum: val('checksum'), path: val('path'),
            mimetype: val('mimetype'), filename: val('filename'),
            notes: [], selections: [], transcriptions: []
          }
          photoIds.push(pid)
        }
        let template = node[`${TROPY}template`] && node[`${TROPY}template`][0]['@id']
        s.items[id] = { id, photos: photoIds, tags: [], lists: [], template: template || GENERIC }
      }
      s.nav = { ...s.nav, mode: 'project', query: '' }
      return s
    },

    'selection.delete'({ photo, selections }) {
      need(state.photos[photo], `selection.delete: photo ${photo} not found`)
      need(Array.isArray(selections), 'selection.delete: payload.selections must be an array')
      // Tropy's selections reducer has no DELETE case: the selection stays
      // in state.selections, and only its photo's list loses it.
      let p = state.photos[photo]
      return {
        ...state,
        photos: { ...state.photos, [photo]: { ...p, selections: (p.selections || []).filter(id => !selections.includes(id)) } }
      }
    },

    'transcriptions/remove'(ids) {
      need(Array.isArray(ids), 'transcriptions/remove: payload must be an array of ids')
      let transcriptions = { ...state.transcriptions }
      let s = { ...state, photos: { ...state.photos }, selections: { ...state.selections } }
      for (let id of ids) {
        let tr = transcriptions[id]
        if (!tr) continue
        delete transcriptions[id]
        for (let owner of ['photos', 'selections']) {
          let o = s[owner][tr.parent]
          if (o) s[owner][tr.parent] = { ...o, transcriptions: (o.transcriptions || []).filter(x => x !== id) }
        }
      }
      return { ...s, transcriptions }
    },

    'metadata.save'({ ids, data }) {
      need(Array.isArray(ids), 'metadata.save: payload.ids must be an array')
      let metadata = { ...state.metadata }
      for (let id of ids) {
        let m = { id, ...(metadata[id] || {}) }
        for (let [prop, v] of Object.entries(data)) {
          m[prop] = typeof v === 'string' ? { text: v, type: 'text' } : v
        }
        metadata[id] = m
      }
      return { ...state, metadata }
    },

    'tag.create'({ name, color, items }) {
      need(name != null, 'tag.name missing')
      let id = nextId++
      let s = { ...state, tags: { ...state.tags, [id]: { id, name, color: color || null } } }
      if (items && items.length) s = addTags(s, items, [id])
      return s
    },

    'item.tag.create'({ id, tags }) {
      need(Array.isArray(id), 'item.tag.create: payload.id must be an array')
      return addTags(state, id, tags)
    },

    'item.tag.delete'({ id, tags }) {
      need(Array.isArray(id), 'item.tag.delete: payload.id must be an array')
      let items = { ...state.items }
      for (let i of id) items[i] = { ...items[i], tags: (items[i].tags || []).filter(t => !tags.includes(t)) }
      return { ...state, items }
    },

    'transcriptions/create'({ photo, selection, text, data }) {
      need(text != null || data != null, 'transcription: text or data missing')
      let parent = selection || photo
      let id = nextId++
      let owner = selection ? 'selections' : 'photos'
      let o = state[owner][parent]
      need(o, `transcription: parent ${parent} not found`)
      return {
        ...state,
        transcriptions: { ...state.transcriptions, [id]: { id, parent, text, data } },
        [owner]: { ...state[owner], [parent]: { ...o, transcriptions: [...(o.transcriptions || []), id] } }
      }
    },

    'list.create'({ name, parent }) {
      let p = state.lists[parent]
      need(p, `list.create: parent ${parent} not found`)
      let id = nextId++
      return {
        ...state,
        lists: {
          ...state.lists,
          [id]: { id, name, parent, children: [] },
          [parent]: { ...p, children: [...p.children, id] }
        }
      }
    },

    'list.item.add'({ id, items }) {
      let next = { ...state.items }
      for (let i of items) next[i] = { ...next[i], lists: [...new Set([...(next[i].lists || []), id])] }
      return { ...state, items: next }
    },

    'list.item.remove'({ id, items }) {
      let next = { ...state.items }
      for (let i of items) next[i] = { ...next[i], lists: (next[i].lists || []).filter(l => l !== id) }
      return { ...state, items: next }
    },

    'ontology.template.create'(payload) {
      let template = { ...state.ontology.template }
      for (let [uri, def] of Object.entries(payload)) {
        need(def && def.name, 'template: name missing')
        template[uri] = { id: uri, ...def }
      }
      return { ...state, ontology: { ...state.ontology, template } }
    }
  }

  let store = {
    getState: () => state,
    subscribe(fn) {
      listeners.push(fn)
      return () => { listeners = listeners.filter(l => l !== fn) }
    },
    dispatch(action) {
      let meta = { ...(action.meta || {}), seq: ++seq, now: Date.now() }
      action = { ...action, meta }
      tropy.actions.push(action)

      if (action.type === 'nav.update') {
        set({ ...state, nav: { ...state.nav, ...action.payload } })
        return action
      }
      if (!meta.cmd || meta.done) return action

      tropy.commands.push(action)
      let handler = handlers[action.type]
      set({ ...state, activities: { ...state.activities, [meta.seq]: action.type } })

      setImmediate(() => {
        let next = state
        try {
          if (!handler) throw new Error(`fake Tropy: no command ${action.type}`)
          next = handler(action.payload)
          if (meta.history) tropy.undo.push(action.type)
        } catch (err) {
          tropy.rejected.push({ type: action.type, error: err.message })
          next = state
        }
        let activities = { ...next.activities }
        delete activities[meta.seq]
        set({ ...next, activities })
      })
      return action
    }
  }

  tropy.store = store
  tropy.state = () => state
  tropy.replace = (next) => set(next)
  return tropy
}

function addTags(state, itemIds, tagIds) {
  let items = { ...state.items }
  for (let i of itemIds) {
    if (!items[i]) throw new Error(`item ${i} not found`)
    items[i] = { ...items[i], tags: [...new Set([...(items[i].tags || []), ...tagIds])] }
  }
  return { ...state, items }
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, '')
}

/**
 * Seed one item whose photos have these checksums.
 * Returns { item, photos: [photo ids] }.
 */
function seedItem(tropy, { id, photos = [], tags = [], lists = [] }) {
  let s = tropy.state()
  let photoIds = photos.map((checksum, i) => id * 100 + i + 1)
  let next = {
    ...s,
    items: { ...s.items, [id]: { id, photos: photoIds, tags, lists, template: 'https://tropy.org/v1/templates/generic' } },
    photos: { ...s.photos }
  }
  photoIds.forEach((pid, i) => {
    next.photos[pid] = { id: pid, item: id, checksum: photos[i], notes: [], selections: [], transcriptions: [] }
  })
  tropy.replace(next)
  return { item: id, photos: photoIds }
}

module.exports = { fakeTropy, seedItem }
