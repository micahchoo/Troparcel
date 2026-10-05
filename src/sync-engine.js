'use strict'

const os = require('os')
const Y = require('yjs')
const { StoreAdapter } = require('./store-adapter')
const { createTransport } = require('./adapters')
const identity = require('./identity')
const schema = require('./crdt-schema')
const { BackupManager } = require('./backup')
const { SyncVault, defaultRoot } = require('./vault')
const { RECEIVED_LIST } = require('./local-only')
const { Assignments } = require('./assignments')
const { ProjectRoom } = require('./project-room')
const { Signer, Keyring } = require('./authorship')
const { RoomKey } = require('./room-key')
const { Journal } = require('./journal')
const TEXT = 'http://www.w3.org/2001/XMLSchema#string'
const path = require('path')

/**
 * SyncEngine — keeps one Tropy project and one room in step.
 *
 * Reads and writes go through StoreAdapter (Tropy's Redux store); the room
 * is a Yjs document carried by a transport (a Troparcel server or a shared
 * folder, see adapters/). A cycle APPLIES what collaborators wrote, then
 * PUSHES what the owner wrote:
 *
 *   local change  → store.subscribe → debounce → syncOnce (apply, push)
 *   remote change → doc observer    → debounce → applyPendingRemote
 *   safety net    → every N seconds → syncOnce
 *
 * One mutex serialises the cycles. While Troparcel writes to Tropy it
 * suppresses change detection, so its own writes are not pushed back.
 *
 * The work itself is in three mixins on this prototype:
 *   push.js   local → room
 *   apply.js  room → local
 */
class SyncEngine {
  constructor(options, logger, store) {
    if (!store) throw new Error('SyncEngine needs the project window\'s Redux store')

    this.options = options
    // What happened recently, for the dashboard; warnings are recorded too.
    this.journal = new Journal()
    this.logger = this.journal.watch(logger)
    this.debug = options.debug === true
    this.peers = []

    this.doc = null
    this.transport = null
    this.adapter = new StoreAdapter(store, logger)
    this.backup = null

    this.localIndex = new Map()
    this.previousSnapshot = new Map()
    this.safetyNetTimer = null
    this.unsubscribe = []
    this._storeUnsubscribe = null

    this.state = 'idle'
    this.lastSync = null
    this.peerCount = 0
    this._syncing = false
    this._paused = false
    this._consecutiveErrors = 0

    this._localDebounceTimer = null
    this._remoteDebounceTimer = null
    this._pendingRemoteIdentities = new Set()
    this._projectDirty = true

    // Includes the API port so two Tropy instances on one machine differ.
    this._stableUserId = options.userId ||
      `${os.userInfo().username}@${os.hostname()}:${options.apiPort || 2019}`

    this.dataDir = options.dataDir || defaultRoot()
    this.vault = new SyncVault()
    this._rejected = new Map() // identity → Set of section|key validation rejected
    this.vault.loadFromFile(this.options.room, this._stableUserId, this.dataDir)

    this._failedNoteKeys = new Set()
    this._applyingRemote = false
    this._queuedLocalChange = false
    this._syncRequested = false
    this._stopping = false

    // Set by the annotations observer, cleared after a full apply.
    this._remoteAnnotationsDirty = true

    this._syncLock = Promise.resolve()
    this.LOCAL_ORIGIN = 'troparcel-local'

    this._listNameCache = new Map()
    this._listCacheRefreshedAt = 0
  }

  // --- Logging ---

  _log(msg, data) {
    if (data) this.logger.info(data, `[troparcel] ${msg}`)
    else this.logger.info(`[troparcel] ${msg}`)
  }

  _debug(msg, data) {
    if (!this.debug) return
    if (data) this.logger.info(data, `[troparcel:debug] ${msg}`)
    else this.logger.info(`[troparcel:debug] ${msg}`)
  }

  _formatAge(date) {
    let sec = Math.floor((Date.now() - date.getTime()) / 1000)
    if (sec < 60) return `${sec}s ago`
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`
  }

  _resetApplyStats() {
    this._applyStats = {
      notesCreated: 0, notesDeduped: 0, notesUpdated: 0, notesRetracted: 0,
      selectionsDeleted: 0, transcriptionsRemoved: 0,
      notesFailed: 0,
      tagsAdded: 0,
      selectionsCreated: 0,
      metadataUpdated: 0,
      transcriptionsCreated: 0,
      listsAdded: 0,
      itemsProcessed: 0, itemsChanged: 0,
      receivedItemIds: new Set(),
      authors: new Set()
    }
  }

  _logApplyStats() {
    let s = this._applyStats
    if (!s) return
    let parts = []
    if (s.notesCreated) parts.push(`${s.notesCreated} notes created`)
    if (s.notesUpdated) parts.push(`${s.notesUpdated} notes updated`)
    if (s.notesRetracted) parts.push(`${s.notesRetracted} notes retracted`)
    if (s.selectionsDeleted) parts.push(`${s.selectionsDeleted} selections deleted`)
    if (s.transcriptionsRemoved) parts.push(`${s.transcriptionsRemoved} transcriptions removed`)
    if (s.tagsAdded) parts.push(`${s.tagsAdded} tags added`)
    if (s.selectionsCreated) parts.push(`${s.selectionsCreated} selections created`)
    if (s.metadataUpdated) parts.push(`${s.metadataUpdated} metadata fields`)
    if (s.transcriptionsCreated) parts.push(`${s.transcriptionsCreated} transcriptions`)
    if (s.listsAdded) parts.push(`${s.listsAdded} list memberships`)
    if (s.notesFailed) parts.push(`${s.notesFailed} notes failed`)
    if (parts.length > 0) {
      this._log(`applied: ${parts.join(', ')} across ${s.itemsChanged}/${s.itemsProcessed} items`)
      let who = [...(s.authors || [])].map(a => this._resolveDisplayName(a))
      this.journal.event(`Received ${parts.join(', ')}${who.length ? ` from ${who.join(', ')}` : ''}`,
        { kind: 'received', items: s.itemsChanged })
    } else {
      this._debug(`applied: nothing changed across ${s.itemsProcessed} items`)
    }
  }

  /** Every local item that has at least one photo, read from the store. */
  readSyncableItems() {
    return this.adapter.getAllItemsFull()
      .filter(item => (item.photo || []).some(p => p.checksum))
  }

  /** Acquire the sync mutex. Resolves to a release function. */
  _acquireLock() {
    let release
    let prev = this._syncLock
    this._syncLock = new Promise(resolve => { release = resolve })
    return prev.then(() => release)
  }

  // --- Lifecycle ---

  async start(opts = {}) {
    if (this.state === 'connected' || this.state === 'connecting') return

    let probe = this.adapter.probe()
    if (!probe.ok) {
      throw new Error(
        `this Tropy does not look like one Troparcel supports — ${probe.problems.join('; ')}. ` +
        'Nothing was synced.')
    }

    this.state = 'connecting'
    this.logger.info({
      transport: this.options.transport || 'websocket',
      room: this.options.room,
      syncMode: this.options.syncMode
    }, 'Troparcel sync engine starting')

    try {
      this.doc = new Y.Doc()
      // An encrypted room: every value is sealed and opened with this key.
      this.roomKey = this.options.roomKey ? new RoomKey(this.options.roomKey) : null
      schema.setRoomKey(this.doc, this.roomKey)
      this.transport = createTransport(this.doc,
        { ...this.options, peerId: this._stableUserId }, this.logger)
      await this.transport.connect()

      this._migrateRoom()
      this._startPresence()
      this._startAuthorship()

      if (this.options.sharePhotos) {
        this.projectRoom = new ProjectRoom({
          doc: this.doc,
          transport: this.transport,
          adapter: this.adapter,
          vault: this.vault,
          roomKey: this.roomKey,
          dir: path.join(this.dataDir, 'photos', String(this.options.room).replace(/[^a-zA-Z0-9_.@-]/g, '_')),
          logger: this.logger,
          origin: this.LOCAL_ORIGIN
        })
      }

      this.backup = new BackupManager(this.options.room, this.logger, {
        dataDir: this.dataDir,
        maxBackups: this.options.maxBackups,
        maxNoteSize: this.options.maxNoteSize,
        maxMetadataSize: this.options.maxMetadataSize,
        tombstoneFloodThreshold: this.options.tombstoneFloodThreshold
      })

      if (this.options.syncMode === 'auto') this._observeRoom()

      this._statusHandler = (event) => {
        if (event.status === 'connected') {
          this.state = 'connected'
          this._log(`connected to ${this.transport.displayAddress}`)
        } else if (event.status === 'disconnected') {
          this.logger.warn('[troparcel] lost connection, will retry automatically')
        }
      }
      this.transport.on('status', this._statusHandler)

      this.state = 'connected'
      this._log(`ready — room "${this.options.room}" over ${this.transport.transportName}, client ${this.doc.clientID}`)

      if (!opts.skipStartupDelay && this.options.startupDelay > 0) {
        await new Promise(r => setTimeout(r, this.options.startupDelay))
      }

      if (this.options.clearTombstones) this.purgeTombstones()

      if (!opts.skipInitialSync) {
        await this.adapter.whenLoaded()
        await this.syncOnce()
        this._log(
          `initial sync complete — ${this.localIndex.size} local items, ` +
          `${this.vault.annotationCount} shared items, ${this.peerCount} peer(s) online`)
      }

      if (this.options.autoSync && !opts.skipInitialSync) this.startWatching()

      let safetyInterval = this.options.safetyNetInterval * 1000
      if (safetyInterval > 0) {
        this.safetyNetTimer = setInterval(() => this._scheduleSafetyNet(), safetyInterval)
      }

      this._statusLogTimer = setInterval(() => {
        if (this.state !== 'connected') return
        this._log(
          `sync active — room "${this.options.room}", ${this.peerCount} peer(s), ` +
          `${this.localIndex.size} local / ${this.vault.annotationCount} shared items` +
          (this.lastSync ? `, last sync ${this._formatAge(this.lastSync)}` : ''))
      }, this.debug ? 30000 : 300000)

    } catch (err) {
      this.state = 'error'
      this.logger.error({ error: err.message, stack: err.stack }, 'Sync engine failed to start')
      throw err
    }
  }

  /** Presence over the transport's awareness channel, where it has one. */
  _startPresence() {
    let awareness = this.transport.getAwareness()
    if (!awareness) return

    let name = this.options.displayName || this._stableUserId
    this.vault.setDisplayName(this._stableUserId, name)
    awareness.setLocalStateField('user', {
      userId: this._stableUserId, name, joinedAt: Date.now()
    })

    this._awarenessHandler = () => {
      this.peerCount = 0
      let peers = []
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === this.doc.clientID || !state.user) return
        this.peerCount++
        if (state.user.name) peers.push(state.user.name)
        if (state.user.userId && state.user.name) {
          this.vault.setDisplayName(state.user.userId, state.user.name)
        }
      })
      this.peers = peers.sort()
    }
    awareness.on('change', this._awarenessHandler)
  }

  /** Watch the room: annotations per item, and project structure. */
  _observeRoom() {
    this.unsubscribe.push(schema.observeAnnotationsDeep(this.doc,
      changes => this.handleRemoteChanges(changes), this.LOCAL_ORIGIN))
    let structure = () => {
      this._projectDirty = true
      this._scheduleRemoteApply()
    }
    this.unsubscribe.push(schema.observeSchema(this.doc, structure, this.LOCAL_ORIGIN))
    this.unsubscribe.push(schema.observeProjectLists(this.doc, structure, this.LOCAL_ORIGIN))
  }

  _scheduleSafetyNet() {
    if (this._consecutiveErrors > 0) {
      let backoffFactor = Math.min(Math.pow(2, this._consecutiveErrors), 16)
      if (Math.random() < 1 - (1 / backoffFactor)) {
        this._log(`Safety-net skipped (backoff: ${this._consecutiveErrors} errors)`)
        return
      }
    }
    this.syncOnce()
  }

  async _persistVault(force = false) {
    if (!force && !this.vault.isDirty) return
    try {
      await this.vault.persistToFile(this.options.room, this._stableUserId, this.dataDir)
    } catch (err) {
      this.logger.warn('vault persist failed', { error: err.message })
    }
  }

  async stop() {
    this._stopping = true
    await this._persistVault(true)
    this.logger.info('Sync engine stopping')

    this.stopWatching()
    for (let timer of ['safetyNetTimer', '_statusLogTimer']) {
      if (this[timer]) clearInterval(this[timer])
      this[timer] = null
    }
    for (let timer of ['_localDebounceTimer', '_remoteDebounceTimer']) {
      if (this[timer]) clearTimeout(this[timer])
      this[timer] = null
    }
    for (let off of this.unsubscribe) off()
    this.unsubscribe = []

    if (this.transport) {
      let awareness = this.transport.getAwareness()
      if (awareness) {
        try {
          if (this._awarenessHandler) awareness.off('change', this._awarenessHandler)
          awareness.setLocalState(null)
        } catch (err) {
          this._debug('Failed to clean up awareness', { error: err.message })
        }
      }
      if (this._statusHandler) this.transport.off('status', this._statusHandler)
      await this.transport.destroy()
      this.transport = null
    }

    if (this.doc) {
      this.doc.destroy()
      this.doc = null
    }

    this.localIndex.clear()
    this.previousSnapshot.clear()
    this._pendingRemoteIdentities.clear()
    this._listNameCache.clear()
    this.vault.clear()
    this._applyingRemote = false
    this._queuedLocalChange = false
    this._syncRequested = false
    this._remoteAnnotationsDirty = false
    this.state = 'idle'
  }

  pause() {
    this._paused = true
    this._log('Sync paused')
  }

  resume() {
    this._paused = false
    this._log('Sync resumed')
  }

  // --- Change detection ---

  startWatching() {
    if (this._storeUnsubscribe) return
    this._storeUnsubscribe = this.adapter.subscribe(() => this.handleLocalChange())
  }

  stopWatching() {
    if (this._storeUnsubscribe) this._storeUnsubscribe()
    this._storeUnsubscribe = null
  }

  handleLocalChange() {
    if (this._paused || this._stopping) return
    if (this._applyingRemote) {
      this._queuedLocalChange = true
      return
    }
    this._debounceSync(this.options.localDebounce)
  }

  _debounceSync(ms) {
    if (this._localDebounceTimer) clearTimeout(this._localDebounceTimer)
    this._localDebounceTimer = setTimeout(() => {
      this._localDebounceTimer = null
      this.syncOnce()
    }, Math.max(100, ms))
  }

  handleRemoteChanges(changes) {
    this._remoteAnnotationsDirty = true
    for (let change of changes) this._pendingRemoteIdentities.add(change.identity)
    this._repairForgeries(new Set(changes.map(c => c.identity)))
    this._debug(`remote change: ${changes.length} event(s), ${this._pendingRemoteIdentities.size} item(s) pending`)
    this._scheduleRemoteApply()
  }

  /**
   * Sign what this member writes, and check what others write (see
   * authorship.js). This member's key is published under their name; if the
   * room shows another key under it, the name is already someone's, or
   * someone is posing as them: the key is written back, and others, who
   * pinned the first key they saw, keep trusting the right one.
   */
  _startAuthorship() {
    this.signer = Signer.load(path.join(this.dataDir, 'keys'), this._stableUserId)
    schema.setSigner(this.doc, this.signer)
    this.keyring = new Keyring(this.vault.pinnedKeys, () => schema.getMembers(this.doc))
    this.vault.pinnedKeys.set(this._stableUserId, this.signer.publicKey)

    let claim = () => {
      let mine = schema.getMembers(this.doc)[this._stableUserId]
      if (mine && mine.publicKey === this.signer.publicKey) return
      if (mine) {
        this.logger.warn(`[troparcel] another key is published under your name "${this._stableUserId}". ` +
          'If someone else in the group uses this name, choose another one in Troparcel\'s settings.')
      }
      this.doc.transact(() => schema.publishKey(this.doc, this._stableUserId, this.signer.publicKey), this.LOCAL_ORIGIN)
    }
    claim()
    let members = this.doc.getMap('members')
    this._membersHandler = (e, tr) => { if (tr.origin !== this.LOCAL_ORIGIN) claim() }
    members.observe(this._membersHandler)
  }

  /**
   * An item whose room entries include one that fails its signature check
   * is pushed again, so this member's own entries, overwritten by someone
   * posing as them, are written back.
   */
  _repairForgeries(identities) {
    if (!this.keyring) return
    let forged = false
    for (let identity of identities) {
      for (let section of ['notes', 'selections', 'selectionNotes', 'transcriptions']) {
        let entries = section === 'notes' ? schema.getNotes(this.doc, identity)
          : section === 'selections' ? schema.getSelections(this.doc, identity)
            : section === 'transcriptions' ? schema.getTranscriptions(this.doc, identity)
              : schema.getAllSelectionNotes(this.doc, identity)
        for (let [rest, value] of Object.entries(entries)) {
          if (this.keyring.verify(section, schema.entryKey(identity, rest), value) === false) {
            this.vault.pushedHashes.delete(identity)
            forged = true
          }
        }
      }
    }
    if (forged) this._debounceSync(this.options.localDebounce)
  }

  _scheduleRemoteApply() {
    if (this._remoteDebounceTimer) clearTimeout(this._remoteDebounceTimer)
    this._remoteDebounceTimer = setTimeout(() => {
      this._remoteDebounceTimer = null
      this.applyPendingRemote()
    }, this.options.remoteDebounce)
  }

  /** Apply what collaborators changed since the last apply. */
  async applyPendingRemote() {
    if (this._paused || this._stopping || !this.doc) return

    let release = await this._acquireLock()
    try {
      let identities = Array.from(this._pendingRemoteIdentities)
      this._pendingRemoteIdentities.clear()
      this.localIndex = identity.buildIdentityIndex(this.readSyncableItems())
      await this._refreshListNameCache()
      await this._applyIdentities(identities)
    } finally {
      release()
    }
  }

  // --- Core sync cycle ---

  async syncOnce() {
    if (this.state !== 'connected' || !this.doc || this._paused || this._stopping) return

    if (this._syncing) {
      this._syncRequested = true
      return
    }
    this._syncing = true

    let release = await this._acquireLock()
    if (this.state !== 'connected' || !this.doc || this._paused || this._stopping) {
      this._syncing = false
      release()
      return
    }
    let prev = this.state
    this.state = 'syncing'

    try {
      let items = this.readSyncableItems()

      // A changed photo set changes an item's identity: alias old → new.
      let oldIdentityOf = new Map()
      for (let [ident, { localId }] of this.localIndex) oldIdentityOf.set(localId, ident)
      let previousIdentities = new Set(this.localIndex.keys())
      this.localIndex = identity.buildIdentityIndex(items)

      if (oldIdentityOf.size > 0) {
        this.doc.transact(() => {
          for (let [newIdentity, { localId }] of this.localIndex) {
            let oldIdentity = oldIdentityOf.get(localId)
            if (oldIdentity && oldIdentity !== newIdentity) {
              schema.setAlias(this.doc, oldIdentity, newIdentity)
              this._log(`alias created: ${oldIdentity.slice(0, 8)} → ${newIdentity.slice(0, 8)}`)
            }
          }
        }, this.LOCAL_ORIGIN)
      }

      // A newly imported item may already have annotations in the room.
      if (previousIdentities.size > 0 &&
          [...this.localIndex.keys()].some(id => !previousIdentities.has(id))) {
        this._remoteAnnotationsDirty = true
      }

      await this._refreshListNameCache()

      // A project room: import the room's items this project lacks, then
      // apply their annotations in this same cycle.
      if (this.projectRoom && this.options.syncMode === 'auto') {
        this.adapter.suppressChanges()
        let imported
        try { imported = await this.projectRoom.importMissing() } finally { this.adapter.resumeChanges() }
        if (imported > 0) {
          items = this.readSyncableItems()
          this.localIndex = identity.buildIdentityIndex(items)
          this._remoteAnnotationsDirty = true
        }
      }

      // Apply first, so remote changes land before local ones are pushed.
      if (this.options.syncMode === 'auto') {
        this.vault.updateAnnotationCount(schema.getIdentities(this.doc).length)
        if (this._remoteAnnotationsDirty || this._projectDirty) {
          let applied = await this._applyIdentities(
            this._remoteAnnotationsDirty ? schema.getIdentities(this.doc) : [])
          if (applied.size > 0) {
            items = this.readSyncableItems()
            this.localIndex = identity.buildIdentityIndex(items)
          }
        }
      }

      if (this.options.syncMode !== 'pull') {
        let pushSeq = this.vault.nextPushSeq()
        this.adapter.suppressChanges()
        try {
          await this.pushLocal(items, pushSeq)
          await this.pushTemplates(this._stableUserId, pushSeq)
          await this.pushListHierarchy(this._stableUserId, pushSeq)
        } finally {
          this.adapter.resumeChanges()
        }
        if (this.projectRoom) await this.projectRoom.share(this.localIndex)
      }

      // Failed note creates are retried for three cycles, then given up.
      let retrying = this._settleFailedNotes()
      if (this.options.syncMode === 'auto' && !retrying) {
        this._remoteAnnotationsDirty = false
      }

      this.vault.pruneAppliedKeys()
      this.vault.markDirty()
      await this._persistVault()
      this.vault._evictIfNeeded(this.previousSnapshot, 5000)

      this.lastSync = new Date()
      this._consecutiveErrors = 0
      this.state = 'connected'
    } catch (err) {
      this._consecutiveErrors++
      this.logger.warn({ error: err && err.message, stack: err && err.stack }, 'Sync cycle failed')
      this.state = prev === 'connected' ? 'connected' : 'error'
    } finally {
      this._syncing = false
      release()
      let replay = this._queuedLocalChange || this._syncRequested
      this._queuedLocalChange = false
      this._syncRequested = false
      if (replay) this._debounceSync(this.options.localDebounce)
    }
  }

  /** True while some failed note creates still have retries left. */
  _settleFailedNotes() {
    let failed = new Set(this._failedNoteKeys)
    this._failedNoteKeys.clear()
    let retrying = false
    for (let key of failed) {
      let count = (this.vault.failedNoteKeys.get(key) || 0) + 1
      if (count >= 3) {
        this.vault.appliedNoteKeys.add(key)
        this.vault.failedNoteKeys.delete(key)
        this._log(`note ${key.slice(0, 8)} given up after ${count} failed attempts`)
      } else {
        this.vault.failedNoteKeys.set(key, count)
        retrying = true
      }
    }
    return retrying
  }

  // --- Apply remote → local ---

  /**
   * Room items that match a local item, validated. Three passes, each
   * claiming a local item at most once: exact identity, then an alias
   * (the item's photo set changed), then fuzzy (most photos shared).
   */
  _matchIdentities(identities) {
    let matched = []
    let claimed = new Set()
    let done = new Set()

    let take = (itemIdentity, local) => {
      if (!local || claimed.has(local.localId) || done.has(itemIdentity)) return
      let crdtItem = schema.getItemSnapshot(this.doc, itemIdentity)
      if (!crdtItem) return
      let validation = this.backup.validateInbound(itemIdentity, crdtItem, this._stableUserId)
      for (let w of validation.warnings) this.logger.warn(`validation: ${w} — skipped`)
      if (validation.rejected.size > 0) this._rejected.set(itemIdentity, validation.rejected)
      else this._rejected.delete(itemIdentity)
      matched.push({ itemIdentity, local })
      claimed.add(local.localId)
      done.add(itemIdentity)
    }

    for (let id of identities) take(id, identity.findLocalMatch(id, this.localIndex))
    for (let id of identities) {
      if (done.has(id)) continue
      let resolved = schema.resolveAlias(this.doc, id)
      if (resolved) take(id, identity.findLocalMatch(resolved, this.localIndex))
    }
    for (let id of identities) {
      if (done.has(id)) continue
      let fuzzy = this._fuzzyMatchLocal(id)
      if (fuzzy) {
        this._debug(`fuzzy match: ${id.slice(0, 8)} → ${fuzzy.localIdentity.slice(0, 8)} (score ${fuzzy.score.toFixed(2)})`)
        take(id, fuzzy.local)
      }
    }
    return matched
  }

  /**
   * Apply the room's project structure (if changed) and the given items.
   * Returns the identities applied.
   */
  async _applyIdentities(identities) {
    let applied = new Set()
    let matched = this._matchIdentities(identities)

    this._applyingRemote = true
    this.adapter.suppressChanges()
    this._resetApplyStats()
    this._assignments = new Assignments()
    try {
      if (this._projectDirty) {
        try { await this.applyTemplates() } catch (err) {
          this.logger.warn(`applyTemplates failed: ${err.message}`)
        }
        try { await this.applyListHierarchy() } catch (err) {
          this.logger.warn(`applyListHierarchy failed: ${err.message}`)
        }
        this._projectDirty = false
      }
      if (matched.length === 0) return applied

      await this._backup(matched)

      let tagMap = new Map(this.adapter.getAllTags().map(t => [t.name.toLowerCase(), t]))
      let listMap = new Map(this.adapter.getAllLists().map(l => [l.name, l]))

      for (let { itemIdentity, local } of matched) {
        try {
          await this.applyRemoteAnnotations(itemIdentity, local, tagMap, listMap)
          applied.add(itemIdentity)
        } catch (err) {
          this.logger.warn(`Failed to apply remote for ${itemIdentity.slice(0, 8)}: ${err.message}`)
        }
      }
      await this._markReceived(this._applyStats.receivedItemIds)
      await this._assignments.flush(this.adapter, this.logger)
      return applied
    } finally {
      this._logApplyStats()
      this.vault.markDirty()
      await this._persistVault()
      this._applyingRemote = false
      this.adapter.resumeChanges()
      if (this._queuedLocalChange) {
        this._queuedLocalChange = false
        this._debounceSync(this.options.localDebounce)
      }
    }
  }

  async _backup(matched) {
    try {
      let snapshots = matched.map(({ local, itemIdentity }) =>
        this.backup.captureItemStateFromStore(this.adapter, local.localId, itemIdentity))
      if (this.vault.shouldBackup(snapshots)) await this.backup.saveSnapshot(snapshots)
    } catch (err) {
      this.logger.warn(`backup before apply failed: ${err.message}`)
    }
  }

  /** Put the items a collaborator changed into the owner's received list. */
  async _markReceived(itemIds) {
    if (!itemIds || itemIds.size === 0) return
    try {
      let list = this.adapter.getAllLists().find(l => l.name === RECEIVED_LIST && l.parent === 0)
      let listId = list ? list.id : (await this.adapter.createList({ name: RECEIVED_LIST, parent: 0 })).id
      for (let id of itemIds) {
        let item = this.adapter.getItem(id)
        if (item && !(item.lists || []).includes(listId)) this._assignments.list(listId, id)
      }
    } catch (err) {
      this.logger.warn(`could not update the "${RECEIVED_LIST}" list: ${err.message}`)
    }
  }

  // --- Import hook (review / pull modes) ---

  async applyOnDemand() {
    if (!this.doc) return null
    let release = await this._acquireLock()
    try {
      this.localIndex = identity.buildIdentityIndex(this.readSyncableItems())
      await this._refreshListNameCache()
      this._projectDirty = true
      let all = schema.getIdentities(this.doc)
      this._logPendingSummary(all)
      let applied = await this._applyIdentities(all)
      return { applied: applied.size }
    } finally {
      release()
    }
  }

  /** Log, per collaborator, how much is waiting in the room. */
  _logPendingSummary(identities) {
    let summary = {}
    for (let itemIdentity of identities) {
      let item = schema.getItemSnapshot(this.doc, itemIdentity)
      if (!item) continue
      for (let section of ['metadata', 'tags', 'notes', 'selections', 'transcriptions', 'lists']) {
        for (let val of Object.values(item[section] || {})) {
          if (!val || !val.author || val.author === this._stableUserId || val.deleted) continue
          summary[val.author] = summary[val.author] || {}
          summary[val.author][section] = (summary[val.author][section] || 0) + 1
        }
      }
    }
    for (let [author, counts] of Object.entries(summary)) {
      this.logger.info(`${author}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`)
    }
  }

  // --- Maintenance ---

  /**
   * Bring a v4 room to v5 (see crdt-schema.js for why v5 exists). A room a
   * NEWER Troparcel has written is left alone: syncing would misread it.
   */
  _migrateRoom() {
    let { version } = schema.checkSchemaVersion(this.doc)
    if (version && version > schema.SCHEMA_VERSION) {
      throw new Error(`room "${this.options.room}" was written by a newer Troparcel ` +
        `(schema ${version}); update Troparcel to sync it`)
    }
    this.doc.transact(() => {
      let copied = schema.migrateFromV4(this.doc)
      if (copied > 0) this._log(`moved ${copied} item(s) from the v4 room layout to v5`)
      schema.setSchemaVersion(this.doc)
    }, this.LOCAL_ORIGIN)
  }

  _logConflict(type, itemIdentity, field, detail) {
    if (type === 'metadata') {
      this.journal.conflict({ identity: itemIdentity, field, ...detail, title: this._titleOf(itemIdentity) })
    }
    this.logger.info({
      event: 'conflict', type, identity: itemIdentity.slice(0, 8), field, ...detail
    }, `[troparcel] Conflict: ${type} ${field} on ${itemIdentity.slice(0, 8)}`)
  }

  /**
   * The local item sharing the most photos with a room item (Jaccard
   * similarity ≥ 0.5), for items merged or split on one side.
   */
  _fuzzyMatchLocal(crdtIdentity) {
    if (this.localIndex.size === 0 || !this.doc) return null
    let crdtSet = new Set(schema.getItemChecksums(this.doc, crdtIdentity))
    if (crdtSet.size === 0) return null

    let best = null
    for (let [localIdentity, local] of this.localIndex) {
      let localSet = new Set((local.item.photo || []).map(p => p.checksum).filter(Boolean))
      if (localSet.size === 0) continue
      let shared = [...crdtSet].filter(c => localSet.has(c)).length
      if (shared === 0) continue
      let score = shared / new Set([...crdtSet, ...localSet]).size
      if (score >= 0.5 && (!best || score > best.score)) {
        best = { local, localIdentity, checksumCount: shared, score }
      }
    }
    return best
  }

  purgeTombstones() {
    if (!this.doc) return
    this.doc.transact(() => {
      let result = schema.purgeTombstones(this.doc)
      this.logger.info(`Purged ${result.purged} tombstone(s), ${result.uuidsPurged || 0} orphaned UUID(s), ` +
        `${result.aliasesPurged || 0} alias(es) across ${result.items} item(s)`)
    }, this.LOCAL_ORIGIN)
  }

  /** An item's title in this project, for messages; its identity's start otherwise. */
  _titleOf(itemIdentity) {
    let local = this.localIndex.get(itemIdentity)
    let item = local && local.item
    let title = item && (item['http://purl.org/dc/elements/1.1/title'] || {})
    return (title && (title['@value'] || title.text)) || `item ${itemIdentity.slice(0, 8)}`
  }

  /**
   * Room items no item here matches: in an overlay room, nearly always
   * photo files that differ from the collaborator's (re-saved, converted).
   */
  unmatchedItems(limit = 10) {
    if (!this.doc) return { count: 0, examples: [] }
    let examples = []
    let count = 0
    for (let id of schema.getIdentities(this.doc)) {
      if (this.localIndex.has(id)) continue
      let alias = schema.resolveAlias(this.doc, id)
      if (alias) continue
      let meta = schema.getMetadata(this.doc, id)
      let anyone = Object.values(meta)[0] || Object.values(schema.getNotes(this.doc, id))[0]
      if (!anyone || anyone.author === this._stableUserId) continue
      count++
      if (examples.length < limit) {
        let title = meta['http://purl.org/dc/elements/1.1/title']
        examples.push({ title: (title && title.text) || null, from: this._resolveDisplayName(anyone.author) })
      }
    }
    return { count, examples }
  }

  /**
   * Settle a field two people changed: 'theirs' takes the room's value
   * here; 'mine' sends this project's value to the room again.
   */
  async resolveConflict(itemIdentity, field, choice) {
    let local = this.localIndex.get(itemIdentity)
    let remote = schema.getMetadata(this.doc, itemIdentity)[field]
    if (!local || !remote) throw new Error('that item or field is no longer in the room')
    if (choice === 'theirs') {
      await this.adapter.saveMetadata(local.localId, { [field]: { text: remote.text, type: remote.type || TEXT } })
      this.vault.markFieldPushed(itemIdentity, field, this.vault._fastHash(`${remote.text || ''}|${remote.type || ''}`))
    } else if (choice === 'mine') {
      this.vault.pushedHashes.delete(itemIdentity)
      this.vault.markFieldPushed(itemIdentity, field, this.vault._fastHash(`${remote.text || ''}|${remote.type || ''}`))
      this._debounceSync(0)
    } else {
      throw new Error(`unknown choice ${choice}`)
    }
    this.vault.markDirty()
    this.journal.resolve(itemIdentity, field)
    this.journal.event(choice === 'theirs'
      ? `Used ${this._resolveDisplayName(remote.author)}'s value for ${field.split(/[/#]/).pop()} on ${this._titleOf(itemIdentity)}`
      : `Kept your value for ${field.split(/[/#]/).pop()} on ${this._titleOf(itemIdentity)}`)
  }

  /** Everything the dashboard shows. */
  dashboardStatus() {
    return {
      ...this.getStatus(),
      peers: this.peers,
      user: this._stableUserId,
      recent: this.journal.recent(),
      problems: this.journal.problems(),
      conflicts: this.journal.openConflicts(),
      unmatched: this.unmatchedItems(),
      photosWaiting: this.projectRoom ? this.projectRoom._waiting.size : 0,
      projectRoom: !!this.projectRoom,
      encrypted: !!this.roomKey
    }
  }

  getStatus() {
    return {
      state: this.state,
      lastSync: this.lastSync,
      room: this.options.room,
      transport: this.transport ? this.transport.transportName : null,
      address: this.transport ? this.transport.displayAddress : null,
      syncMode: this.options.syncMode,
      clientId: this.doc ? this.doc.clientID : null,
      localItems: this.localIndex.size,
      crdtItems: this.vault.annotationCount,
      peerCount: this.peerCount,
      watching: this._storeUnsubscribe != null,
      consecutiveErrors: this._consecutiveErrors
    }
  }
}

Object.assign(SyncEngine.prototype, require('./push'))
Object.assign(SyncEngine.prototype, require('./apply'))

module.exports = { SyncEngine }
