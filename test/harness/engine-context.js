'use strict'

/**
 * Build a minimal "engine-like" context for testing apply/push mixins.
 *
 * We don't construct a full SyncEngine — its start() lifecycle wants a real
 * WebSocket provider, file watcher, etc. Instead, we build a plain object that
 * has every field apply.js + push.js touch, then mix in the methods. This
 * isolates pure logic from transport.
 *
 * The Y.Doc + vault + adapter are all real (not mocked) — only the network
 * and Tropy host are faked.
 */

const Y = require('yjs')
const apply = require('../../src/apply')
const push = require('../../src/push')
const enrich = require('../../src/enrich')
const { SyncVault } = require('../../src/vault')
const { FakeStoreAdapter } = require('./fake-adapter')

const silentLogger = {
  trace: () => {}, debug: () => {}, info: () => {},
  warn: () => {}, error: () => {},
  child: () => silentLogger
}

const DEFAULT_OPTIONS = {
  room: 'test-room',
  syncMetadata: true,
  syncTags: true,
  syncNotes: true,
  syncSelections: true,
  syncTranscriptions: true,
  syncDeletions: true,
  syncPhotoAdjustments: false,
  reviewMode: false,
  writeDelay: 0,                 // disable in tests
  pushSeq: 0
}

/**
 * Create an engine-like test context.
 *
 * @param {Object} opts
 * @param {string} opts.userId        — stable user id for the peer
 * @param {Object} [opts.adapter]     — optional pre-made FakeStoreAdapter
 * @param {Object} [opts.options]     — overrides for sync options
 * @param {Y.Doc}  [opts.doc]         — share a Y.Doc with another peer for in-process sync
 * @returns {Object} ctx — has all apply/push/enrich methods + adapter + doc + vault
 */
function makeContext({ userId, adapter, options = {}, doc } = {}) {
  const ctx = {
    options: { ...DEFAULT_OPTIONS, ...options },
    logger: silentLogger,
    doc: doc || new Y.Doc(),
    adapter: adapter || new FakeStoreAdapter({ userId }),
    vault: new SyncVault(),
    api: null,                  // HTTP fallback unused in tier-1 tests

    _stableUserId: userId,
    _applyingRemote: false,
    _stopping: false,
    _writeDelay: () => Promise.resolve(),

    state: 'connected',
    localIndex: new Map(),
    peerCount: 1,
    lastSync: null,

    _resetApplyStats: () => {},
    _logApplyStats: () => {},
    _log: () => {},
    _debug: () => {},

    // Stub the per-peer-tag attribution palette
    attributionTagIds: new Map()
  }

  // Mix in apply / push / enrich methods (they expect to be called via `this`)
  Object.assign(ctx, apply)
  Object.assign(ctx, push)
  Object.assign(ctx, enrich)

  return ctx
}

/**
 * Connect two contexts so updates on one Y.Doc propagate to the other in-process.
 * This is the "transport-free" pair — no WebSocket, just direct Y.applyUpdate.
 */
function connect(ctxA, ctxB) {
  const onUpdateA = (update, origin) => {
    if (origin === 'remote') return
    Y.applyUpdate(ctxB.doc, update, 'remote')
  }
  const onUpdateB = (update, origin) => {
    if (origin === 'remote') return
    Y.applyUpdate(ctxA.doc, update, 'remote')
  }

  ctxA.doc.on('update', onUpdateA)
  ctxB.doc.on('update', onUpdateB)

  return () => {
    ctxA.doc.off('update', onUpdateA)
    ctxB.doc.off('update', onUpdateB)
  }
}

module.exports = { makeContext, connect, silentLogger, DEFAULT_OPTIONS }
