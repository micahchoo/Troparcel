'use strict'

const Y = require('yjs')
const schema = require('../src/crdt-schema')
const { SyncVault } = require('../src/vault')

// ── Builders ────────────────────────────────────────────────────────

/**
 * Build a Redux-shaped item with sensible defaults.
 * Matches state.items[id] + enriched photo/tag/note shape.
 */
function buildItem(overrides = {}) {
  let id = overrides.id ?? 1
  let photoId = overrides.photoId ?? 10
  let checksum = overrides.checksum ?? 'abc123'

  let base = {
    '@id': id,
    id,
    template: 'https://tropy.org/v1/templates/generic',
    photos: [photoId],
    tags: [],
    lists: [],
    photo: [{
      '@id': photoId,
      checksum,
      note: [],
      selection: [],
      transcription: [],
      metadata: null
    }],
    tag: []
  }

  // Merge overrides shallowly
  return { ...base, ...overrides }
}

/**
 * Build a photo object matching the enriched item.photo[] shape.
 */
function buildPhoto(overrides = {}) {
  return {
    '@id': overrides.id ?? 10,
    checksum: overrides.checksum ?? 'abc123',
    note: [],
    selection: [],
    transcription: [],
    metadata: null,
    ...overrides
  }
}

/**
 * Build a template definition matching ontology.template shape.
 */
function buildTemplate(overrides = {}) {
  let uri = overrides.uri ?? 'https://tropy.org/v1/templates/test'
  return {
    uri,
    id: uri,
    name: overrides.name ?? 'Test Template',
    type: overrides.type ?? 'https://tropy.org/v1/tropy#Item',
    creator: overrides.creator ?? '',
    description: overrides.description ?? '',
    fields: overrides.fields ?? [
      {
        property: 'http://purl.org/dc/elements/1.1/title',
        label: 'Title',
        datatype: 'http://www.w3.org/2001/XMLSchema#string',
        isRequired: false,
        isConstant: false,
        hint: '',
        value: ''
      }
    ],
    ...overrides
  }
}

/**
 * Build a pre-populated Y.Doc from items/templates/lists data.
 * Uses real crdt-schema functions for accurate CRDT structure.
 */
function buildCRDTDoc({ items, templates, lists } = {}) {
  let doc = new Y.Doc()

  // Populate items
  if (items) {
    for (let { identity, metadata, tags, notes } of items) {
      if (metadata) {
        for (let [prop, val] of Object.entries(metadata)) {
          schema.setMetadata(doc, identity, prop, val, 'remote-user', 1)
        }
      }
      if (tags) {
        for (let tag of tags) {
          schema.setTag(doc, identity, tag, 'remote-user', 1)
        }
      }
      if (notes) {
        for (let note of notes) {
          schema.setNote(doc, identity, note.uuid, note, 'remote-user', 1)
        }
      }
    }
  }

  // Populate templates
  if (templates) {
    for (let [uri, tmpl] of Object.entries(templates)) {
      schema.setTemplateSchema(doc, uri, tmpl, 'remote-user', 1)
    }
  }

  // Populate project lists
  if (lists) {
    for (let [uuid, entry] of Object.entries(lists)) {
      schema.setListHierarchyEntry(doc, uuid, entry, 'remote-user', 1)
    }
  }

  schema.setSchemaVersion(doc)
  return doc
}

// ── Mocks ───────────────────────────────────────────────────────────

/**
 * Mock Redux store with seq injection and subscribe.
 * Matches the pattern used in existing tests.
 */
function mockStore(state) {
  let listeners = []
  let dispatched = []

  return {
    getState: () => state,
    dispatch: (action) => {
      action.meta = action.meta || {}
      action.meta.seq = Date.now()
      action.meta.now = Date.now()
      dispatched.push(action)
      return action
    },
    subscribe: (fn) => {
      listeners.push(fn)
      return () => {
        listeners = listeners.filter(l => l !== fn)
      }
    },
    _listeners: listeners,
    _notify: () => listeners.forEach(fn => fn()),
    _dispatched: dispatched
  }
}

/**
 * Build a full Redux state with all slices.
 * Accepts overrides per slice.
 */
function mockState(overrides = {}) {
  return {
    items: overrides.items ?? {},
    photos: overrides.photos ?? {},
    selections: overrides.selections ?? {},
    notes: overrides.notes ?? {},
    metadata: overrides.metadata ?? {},
    tags: overrides.tags ?? {},
    lists: overrides.lists ?? {},
    activities: overrides.activities ?? {},
    transcriptions: overrides.transcriptions ?? {},
    ontology: overrides.ontology ?? { template: {} }
  }
}

/**
 * Build a minimal SyncEngine-like context for calling push/apply mixin methods.
 * Returns an object with all `this` properties that push.js and apply.js need.
 */
function mockSyncContext(overrides = {}) {
  let doc = overrides.doc ?? new Y.Doc()
  let vault = overrides.vault ?? new SyncVault()
  let state = overrides.state ?? mockState()
  let store = overrides.store ?? mockStore(state)
  let { StoreAdapter } = require('../src/store-adapter')
  let adapter = overrides.adapter ?? new StoreAdapter(store, { debug: () => {}, warn: () => {} })

  let logs = { debug: [], log: [], conflicts: [] }

  let ctx = {
    doc,
    vault,
    adapter,
    _stableUserId: overrides.userId ?? 'test-user',
    LOCAL_ORIGIN: overrides.LOCAL_ORIGIN ?? 'local',
    options: {
      syncMetadata: true,
      syncTags: true,
      syncNotes: true,
      syncSelections: true,
      syncTranscriptions: true,
      syncPhotoAdjustments: true,
      syncLists: true,
      syncDeletions: true,
      room: 'test-room',
      maxNoteSize: 100000,
      ...(overrides.options ?? {})
    },
    logger: overrides.logger ?? { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    _debug: (...args) => logs.debug.push(args.join(' ')),
    _log: (...args) => logs.log.push(args.join(' ')),
    _logConflict: (type, identity, key, details) => {
      logs.conflicts.push({ type, identity, key, details })
    },
    _applyStats: {
      itemsProcessed: 0,
      itemsChanged: 0,
      notesCreated: 0,
      notesUpdated: 0,
      notesRetracted: 0,
      tagsAdded: 0,
      selectionsCreated: 0,
      metadataUpdated: 0,
      transcriptionsCreated: 0,
      listsAdded: 0,
      appliedItemIds: new Set()
    },
    previousSnapshot: new Map(),
    _logs: logs
  }

  // Mix in push and apply methods so they can be called directly
  let push = require('../src/push')
  let apply = require('../src/apply')
  Object.assign(ctx, push)
  Object.assign(ctx, apply)

  return ctx
}

module.exports = {
  buildItem,
  buildPhoto,
  buildTemplate,
  buildCRDTDoc,
  mockStore,
  mockState,
  mockSyncContext
}
