'use strict'

const fs = require('fs')
const os = require('os')
const Y = require('yjs')
const { WebsocketProvider } = require('y-websocket')
const WS = require('ws')
const { ApiClient } = require('./api-client')
const { StoreAdapter } = require('./store-adapter')
const identity = require('./identity')
const schema = require('./crdt-schema')
const { BackupManager } = require('./backup')
const { SyncVault } = require('./vault')

/**
 * Sync Engine v4.0 — Store-First Architecture.
 *
 * When the Redux store is available (background sync in project window),
 * all reads come from store.getState() and writes use store.dispatch().
 * This eliminates the N+1 HTTP enrichment problem and fixes broken write
 * operations (selections, note updates, list item management).
 *
 * Falls back to the HTTP API when the store is not available (temp engines
 * created in export/import hooks, or if the store hasn't loaded yet).
 *
 * Inherited from v3.1:
 *   - R1:  No double startup delay (accepts skipStartupDelay flag)
 *   - R2:  Async mutex prevents concurrent syncOnce/applyPendingRemote
 *   - R3:  waitForConnection cleans up listener on timeout
 *   - R5:  Exponential backoff on consecutive errors
 *   - R7:  Vault pruning on each sync cycle
 *   - R9:  File watcher health monitoring and restart (API fallback only)
 *   - S3:  Validation failures block apply
 *   - P1:  Parallel sub-resource fetching in enrichItem (API fallback only)
 *   - P4:  checksumMap computed once per item in pushLocal
 *   - P5:  getStatus uses cached annotation count
 *   - P6:  Write delay only between items, not between individual fields
 *   - C1:  Stable note identity via vault mapping
 *   - C2:  List sync by name (not local ID)
 *   - C3:  Stable transcription identity via vault mapping
 *
 * New in v4.0:
 *   - SF1: Reads from Redux store via StoreAdapter (no HTTP GET calls)
 *   - SF2: Writes via store.dispatch() for selections, notes, lists
 *   - SF3: Change detection via store.subscribe() (replaces fs.watch)
 *   - SF4: ProseMirror-to-HTML conversion for note content in push path
 *   - SF5: Adapter.suppressChanges() prevents feedback loops during apply
 *
 * Methods are organized into mixins:
 *   - push.js:   local → CRDT writes (pushLocal, pushMetadata, pushTags, etc.)
 *   - apply.js:  CRDT → local writes (applyRemoteAnnotations, applyNotes, etc.)
 *   - enrich.js: HTTP API item enrichment (fallback when store unavailable)
 */
class SyncEngine {
  constructor(options, logger, store = null) {
    this.options = options
    this.logger = logger
    this.debug = options.debug === true

    this.doc = null
    this.provider = null
    this.api = new ApiClient(options.apiPort, logger)
    this.adapter = store ? new StoreAdapter(store, logger) : null
    this.backup = null

    this.localIndex = new Map()
    this.previousSnapshot = new Map()
    this.safetyNetTimer = null
    this.heartbeatTimer = null
    this.unsubscribe = null
    this._storeUnsubscribe = null
    this.fileWatcher = null
    this.projectPath = null

    this.state = 'idle'
    this.lastSync = null
    this.peerCount = 0
    this._syncing = false
    this._paused = false
    this._consecutiveErrors = 0

    // Debounce timers
    this._localDebounceTimer = null
    this._remoteDebounceTimer = null
    this._pendingRemoteIdentities = new Set()

    // State tracker (load persisted keys to prevent ghost notes on restart)
    this.vault = new SyncVault()
    this.vault.loadFromFile(this.options.room)

    // Retry counter for failed note creates
    this._applyFailureCount = 0
    this._failedNoteKeys = new Set()

    // Event queue for local changes detected during apply phase
    this._applyingRemote = false
    this._queuedLocalChange = false
    this._syncRequested = false
    this._stopping = false

    // Annotation-specific dirty flag — set by the annotations observer,
    // cleared after a full apply in syncOnce. Replaces state-vector hashing
    // for change detection (state vectors include heartbeat writes to the
    // users map, which caused unnecessary apply cycles every safety-net poll).
    this._remoteAnnotationsDirty = true  // true to force initial apply

    // R2: Async mutex — chains async operations to prevent concurrent access
    this._syncLock = Promise.resolve()

    // R9: File watcher health — track last event time (fs.watch fallback only)
    this._lastWatcherEvent = 0
    this._watcherHealthTimer = null

    // Transaction origin marker
    this.LOCAL_ORIGIN = 'troparcel-local'

    // C2: List name cache (listId -> listName)
    this._listNameCache = new Map()
    this._listCacheRefreshedAt = 0

    // Stable userId — includes apiPort so different Tropy instances on the
    // same machine get distinct IDs (e.g. AppImage:2019 vs Flatpak:2021)
    this._stableUserId = options.userId ||
      `${os.userInfo().username}@${os.hostname()}:${options.apiPort || 2019}`
  }

  // --- Logging ---

  _log(msg, data) {
    if (data) {
      this.logger.info(data, `[troparcel] ${msg}`)
    } else {
      this.logger.info(`[troparcel] ${msg}`)
    }
  }

  _debug(msg, data) {
    if (!this.debug) return
    if (data) {
      this.logger.info(data, `[troparcel:debug] ${msg}`)
    } else {
      this.logger.info(`[troparcel:debug] ${msg}`)
    }
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
      notesFailed: 0,
      tagsAdded: 0, tagsDeduped: 0,
      selectionsCreated: 0, selectionsDeduped: 0,
      metadataUpdated: 0,
      transcriptionsCreated: 0,
      listsAdded: 0,
      itemsProcessed: 0, itemsChanged: 0
    }
  }

  _logApplyStats() {
    let s = this._applyStats
    if (!s) return
    let parts = []
    if (s.notesCreated) parts.push(`${s.notesCreated} notes created`)
    if (s.notesUpdated) parts.push(`${s.notesUpdated} notes updated`)
    if (s.notesRetracted) parts.push(`${s.notesRetracted} notes retracted`)
    if (s.tagsAdded) parts.push(`${s.tagsAdded} tags added`)
    if (s.selectionsCreated) parts.push(`${s.selectionsCreated} selections created`)
    if (s.metadataUpdated) parts.push(`${s.metadataUpdated} metadata fields`)
    if (s.transcriptionsCreated) parts.push(`${s.transcriptionsCreated} transcriptions`)
    if (s.listsAdded) parts.push(`${s.listsAdded} list memberships`)
    if (s.notesFailed) parts.push(`${s.notesFailed} notes failed`)
    if (parts.length > 0) {
      this._log(`applied: ${parts.join(', ')} across ${s.itemsChanged}/${s.itemsProcessed} items`)
    } else {
      this._debug(`applied: nothing changed across ${s.itemsProcessed} items`)
    }
  }

  /**
   * Read all items fully enriched from the store adapter.
   * Used by syncOnce and import hook when store is available.
   */
  readAllItemsFull() {
    if (!this.adapter) return []
    return this.adapter.getAllItemsFull()
  }

  // --- Async mutex (R2) ---

  /**
   * Acquire the sync lock. Returns a release function.
   * Prevents concurrent syncOnce/applyPendingRemote operations.
   */
  _acquireLock() {
    let release
    let prev = this._syncLock
    this._syncLock = new Promise(resolve => { release = resolve })
    return prev.then(() => release)
  }

  // --- Lifecycle ---

  async start(opts = {}) {
    if (this.state === 'connected' || this.state === 'connecting') return

    this.state = 'connecting'
    this.logger.info({
      server: this.options.serverUrl,
      room: this.options.room,
      syncMode: this.options.syncMode
    }, 'Sync engine v4.11 starting')

    try {
      this.doc = new Y.Doc()
      schema.registerUser(this.doc, this.doc.clientID, this._stableUserId)

      // Always use Node.js ws module — browser WebSocket is blocked by Tropy's CSP
      let WSImpl = WS

      this.provider = new WebsocketProvider(
        this.options.serverUrl,
        this.options.room,
        this.doc,
        {
          connect: true,
          params: this.options.roomToken
            ? { token: this.options.roomToken }
            : {},
          maxBackoffTime: 10000,
          resyncInterval: 30000,
          WebSocketPolyfill: WSImpl
        }
      )

      // Connection lifecycle logging
      this.provider.on('status', (e) => {
        if (e.status === 'connected') {
          this.logger.info(`[troparcel] connected to ${this.options.serverUrl}`)
        } else if (e.status === 'disconnected') {
          this.logger.info('[troparcel] disconnected from server, reconnecting...')
        }
      })
      this.provider.on('connection-error', (e) => {
        this.logger.warn(
          `[troparcel] connection error: ${e.message || String(e)} — ` +
          'check that the Troparcel server is running')
      })
      this.provider.on('connection-close', (e) => {
        if (e.code !== 1000) {
          this.logger.info(`[troparcel] connection closed (code: ${e.code}${e.reason ? ', ' + e.reason : ''}), reconnecting...`)
        }
      })

      await this.waitForConnection()

      // Set up backup manager
      this.backup = new BackupManager(
        this.options.room,
        this.api,
        this.logger,
        {
          maxBackups: this.options.maxBackups,
          maxNoteSize: this.options.maxNoteSize,
          maxMetadataSize: this.options.maxMetadataSize,
          tombstoneFloodThreshold: this.options.tombstoneFloodThreshold
        }
      )

      // Set up CRDT observer for remote changes
      if (this.options.syncMode === 'auto') {
        this.unsubscribe = schema.observeAnnotationsDeep(
          this.doc,
          (changes) => { this.handleRemoteChanges(changes) },
          this.LOCAL_ORIGIN
        )
      }

      // Monitor connection status for state tracking
      this._statusHandler = (event) => {
        if (event.status === 'connected') {
          this.state = 'connected'
          this._log(`reconnected to room "${this.options.room}"`)
        } else if (event.status === 'disconnected') {
          this.logger.warn('[troparcel] lost connection, will retry automatically')
        }
      }
      this.provider.on('status', this._statusHandler)

      this.state = 'connected'
      this._log(`ready — room "${this.options.room}", client ${this.doc.clientID}`)

      // R1: Only wait for startup if not already waited by plugin
      if (!opts.skipStartupDelay) {
        let startupDelay = this.options.startupDelay
        if (startupDelay > 0) {
          await new Promise(r => setTimeout(r, startupDelay))
        }
      }

      // Purge tombstones if requested (one-shot cleanup)
      if (this.options.clearTombstones) {
        this.purgeTombstones()
      }

      // Initial full sync (skipped for temp engines used in export/import)
      if (!opts.skipInitialSync) {
        await this.syncOnce()
        let users = schema.getUsers(this.doc)
        let peers = users.filter(u => u.clientID !== this.doc.clientID).length
        this._log(
          `initial sync complete — ${this.localIndex.size} local items indexed, ` +
          `${this.vault.annotationCount} shared items in CRDT, ` +
          `${peers} peer(s) online`)
      }

      // Start file watching
      if (this.options.autoSync && !opts.skipInitialSync) {
        await this.startWatching()
      }

      // Safety-net periodic poll with backoff (R5)
      let safetyInterval = this.options.safetyNetInterval * 1000
      if (safetyInterval > 0) {
        this.safetyNetTimer = setInterval(() => {
          this._scheduleSafetyNet()
        }, safetyInterval)
      }

      // Heartbeat — only when peers are connected (avoids spurious state vector changes)
      this.heartbeatTimer = setInterval(() => {
        if (this.provider && this.provider.wsconnected) {
          schema.heartbeat(this.doc, this.doc.clientID)
        }
      }, 30000)

      // Periodic status log — lets users know sync is alive without DevTools
      this._statusLogCount = 0
      let statusInterval = this.debug ? 30000 : 300000 // 30s debug, 5min normal
      this._statusLogTimer = setInterval(() => {
        if (this.state !== 'connected') return
        this._statusLogCount++
        let users = this.doc ? schema.getUsers(this.doc) : []
        let peers = users.filter(u => u.clientID !== this.doc?.clientID).length
        this._log(
          `sync active — room "${this.options.room}", ` +
          `${peers} peer(s), ` +
          `${this.localIndex.size} local / ${this.vault.annotationCount} shared items` +
          (this.lastSync ? `, last sync ${this._formatAge(this.lastSync)}` : ''))
      }, statusInterval)

    } catch (err) {
      this.state = 'error'
      this.logger.error({ error: err.message, stack: err.stack }, 'Sync engine failed to start')
      throw err
    }
  }

  /**
   * Safety-net with exponential backoff (R5).
   */
  _scheduleSafetyNet() {
    if (this._consecutiveErrors > 0) {
      let backoffFactor = Math.min(Math.pow(2, this._consecutiveErrors), 16)
      let skipChance = 1 - (1 / backoffFactor)
      if (Math.random() < skipChance) {
        this._log(`Safety-net skipped (backoff: ${this._consecutiveErrors} errors)`)
        return
      }
    }
    this.syncOnce()
  }

  async _persistVault(force = false) {
    if (!force && !this.vault.isDirty) return
    try {
      await this.vault.persistToFile(this.options.room)
    } catch (err) {
      this.logger.warn('vault persist failed', { error: err.message })
    }
  }

  async stop() {
    this._stopping = true
    await this._persistVault(true)
    this.logger.info('Sync engine stopping')

    if (this._storeUnsubscribe) {
      this._storeUnsubscribe()
      this._storeUnsubscribe = null
    }

    this.stopWatching()

    if (this.safetyNetTimer) {
      clearInterval(this.safetyNetTimer)
      this.safetyNetTimer = null
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    if (this._statusLogTimer) {
      clearInterval(this._statusLogTimer)
      this._statusLogTimer = null
    }

    if (this._watcherHealthTimer) {
      clearInterval(this._watcherHealthTimer)
      this._watcherHealthTimer = null
    }

    if (this._localDebounceTimer) {
      clearTimeout(this._localDebounceTimer)
      this._localDebounceTimer = null
    }

    if (this._remoteDebounceTimer) {
      clearTimeout(this._remoteDebounceTimer)
      this._remoteDebounceTimer = null
    }

    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }

    if (this.doc) {
      try {
        schema.deregisterUser(this.doc, this.doc.clientID)
      } catch (err) {
        this._debug('Failed to deregister user', { error: err.message })
      }
    }

    if (this.provider) {
      if (this._statusHandler) {
        this.provider.off('status', this._statusHandler)
        this._statusHandler = null
      }
      this.provider.destroy()
      this.provider = null
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

  // R3: Clean up listener on timeout
  waitForConnection() {
    return new Promise((resolve, reject) => {
      if (this.provider.wsconnected) {
        resolve()
        return
      }

      let handler = (event) => {
        if (event.status === 'connected') {
          clearTimeout(timeout)
          this.provider.off('status', handler)
          resolve()
        }
      }

      let timeout = setTimeout(() => {
        this.provider.off('status', handler) // R3: prevent listener leak
        reject(new Error('Connection timeout (15s)'))
      }, 15000)

      this.provider.on('status', handler)
    })
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

  async startWatching() {
    // Prefer store.subscribe when adapter is available
    if (this.adapter) {
      if (this._storeUnsubscribe) return
      this._log('Using store.subscribe for change detection')
      this._storeUnsubscribe = this.adapter.subscribe(() => {
        this.handleLocalChange()
      })
      return
    }

    // Fallback: fs.watch on project file
    if (this.fileWatcher) return

    try {
      let info = await this.api.getProjectInfo()
      if (info && info.project) {
        this.projectPath = info.project
        this._log(`Watching project file: ${this.projectPath}`)
      }
    } catch (err) {
      this._log('Could not get project path, file watching disabled', {
        error: err.message
      })
      return
    }

    if (!this.projectPath) return

    this._startFileWatcher()

    // R9: Monitor watcher health — restart if no events for too long
    this._lastWatcherEvent = Date.now()
    this._watcherHealthTimer = setInterval(() => {
      this._checkWatcherHealth()
    }, 60000)
  }

  _startFileWatcher() {
    try {
      this.fileWatcher = fs.watch(this.projectPath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          this._lastWatcherEvent = Date.now()
          this.handleLocalChange()
        }
      })

      this.fileWatcher.on('error', (err) => {
        this._debug('File watcher error', { error: err.message })
        // R9: Try to restart the watcher
        this._restartFileWatcher()
      })
    } catch (err) {
      this._debug('Could not start file watcher', { error: err.message })
    }
  }

  // R9: Restart dead watcher
  _restartFileWatcher() {
    if (this.fileWatcher) {
      try { this.fileWatcher.close() } catch (err) {
        this.logger.warn('Failed to close file watcher', { error: String(err.message || err) })
      }
      this.fileWatcher = null
    }
    // Clear old health timer to prevent accumulation
    if (this._watcherHealthTimer) {
      clearInterval(this._watcherHealthTimer)
      this._watcherHealthTimer = null
    }
    if (this.projectPath) {
      this._log('Restarting file watcher')
      this._startFileWatcher()
      this._lastWatcherEvent = Date.now()
      this._watcherHealthTimer = setInterval(() => {
        this._checkWatcherHealth()
      }, 60000)
    }
  }

  // R9: If watcher hasn't fired in 5 minutes and safety-net has seen changes, restart
  _checkWatcherHealth() {
    if (!this.fileWatcher) return
    let silenceMs = Date.now() - this._lastWatcherEvent
    // If silent for > 5 minutes, the watcher might be dead
    if (silenceMs > 5 * 60 * 1000) {
      this.logger.info('File watcher silent for >5min, restarting')
      this._restartFileWatcher()
    }
  }

  stopWatching() {
    if (this.fileWatcher) {
      this.fileWatcher.close()
      this.fileWatcher = null
    }
    if (this._watcherHealthTimer) {
      clearInterval(this._watcherHealthTimer)
      this._watcherHealthTimer = null
    }
  }

  /**
   * Debounced handler for local file changes.
   */
  handleLocalChange() {
    if (this._paused) return
    if (this._stopping) return

    if (this._applyingRemote) {
      this._queuedLocalChange = true
      this._debug('handleLocalChange: queued (applying remote)')
      return
    }

    this._debug('handleLocalChange: store change detected, debouncing')

    if (this._localDebounceTimer) {
      clearTimeout(this._localDebounceTimer)
    }

    this._localDebounceTimer = setTimeout(() => {
      this._localDebounceTimer = null
      this._debug('handleLocalChange: debounce fired')
      this.syncOnce()
    }, this.options.localDebounce)
  }

  /**
   * Handle remote CRDT changes — debounce and apply.
   */
  handleRemoteChanges(changes) {
    this._remoteAnnotationsDirty = true
    for (let change of changes) {
      this._pendingRemoteIdentities.add(change.identity)
    }

    if (this._remoteDebounceTimer) {
      clearTimeout(this._remoteDebounceTimer)
    }

    this._remoteDebounceTimer = setTimeout(() => {
      this._remoteDebounceTimer = null
      this.applyPendingRemote()
    }, this.options.remoteDebounce)
  }

  async applyPendingRemote() {
    if (this._paused) return
    if (this._pendingRemoteIdentities.size === 0) return
    if (this.localIndex.size === 0) {
      this._debug('applyPendingRemote: localIndex empty, deferring')
      return
    }

    // R2: Acquire mutex
    let release = await this._acquireLock()
    try {
      let identities = Array.from(this._pendingRemoteIdentities)
      this._pendingRemoteIdentities.clear()

      let allTags = null
      try {
        allTags = this.adapter
          ? this.adapter.getAllTags()
          : await this.api.getTags()
      } catch (err) {
        this.logger.warn('applyPendingRemote: failed to fetch tags', { error: String(err.message || err) })
      }
      let tagMap = new Map()
      if (allTags && Array.isArray(allTags)) {
        for (let t of allTags) tagMap.set(t.name, t)
      }

      let listMap = new Map()
      if (this.options.syncLists) {
        try {
          let allLists = this.adapter
            ? this.adapter.getAllLists()
            : await this.api.getLists()
          if (Array.isArray(allLists)) {
            for (let l of allLists) listMap.set(l.name, l)
          }
        } catch (err) {
          this.logger.warn('applyPendingRemote: failed to fetch lists', { error: String(err.message || err) })
        }
      }

      // Re-read items from store to get current state (localIndex may be stale)
      if (this.adapter) {
        let freshItems = this.readAllItemsFull()
        if (freshItems.length > 0) {
          this.localIndex = identity.buildIdentityIndex(freshItems)
        }
      }

      // Refresh list name cache for this apply cycle
      await this._refreshListNameCache()

      // Validation uses per-item snapshots (avoids full doc serialization)

      this._applyingRemote = true
      if (this.adapter) this.adapter.suppressChanges()
      this._resetApplyStats()

      try {
        // First pass: exact matches (these take priority over fuzzy matches)
        let processedLocalIds = new Set()
        let exactMatchedIdentities = new Set()
        for (let itemIdentity of identities) {
          let local = identity.findLocalMatch(itemIdentity, this.localIndex)
          if (!local) continue

          exactMatchedIdentities.add(itemIdentity)
          processedLocalIds.add(local.localId)

          // Validate inbound CRDT data before applying (per-item)
          if (this.backup) {
            let crdtItem = schema.getItemSnapshot(this.doc, itemIdentity)
            if (crdtItem) {
              let validation = this.backup.validateInbound(itemIdentity, crdtItem, this._stableUserId)
              if (!validation.valid) {
                for (let w of validation.warnings) {
                  this.logger.warn(`applyPendingRemote validation: ${w}`)
                }
                continue
              }
            }
          }

          try {
            await this.applyRemoteAnnotations(itemIdentity, local, tagMap, listMap)
          } catch (err) {
            this.logger.warn(`Failed to apply remote for ${itemIdentity}`, {
              error: err.message
            })
          }
        }

        // Second pass: fuzzy matches for identities with no exact match,
        // skipping locals already processed by exact matches
        for (let itemIdentity of identities) {
          if (exactMatchedIdentities.has(itemIdentity)) continue
          let fuzzy = this._fuzzyMatchLocal(itemIdentity)
          if (!fuzzy) continue
          if (processedLocalIds.has(fuzzy.local.localId)) continue
          processedLocalIds.add(fuzzy.local.localId)

          if (this.backup) {
            let crdtItem = schema.getItemSnapshot(this.doc, itemIdentity)
            if (crdtItem) {
              let validation = this.backup.validateInbound(itemIdentity, crdtItem, this._stableUserId)
              if (!validation.valid) continue
            }
          }

          try {
            await this.applyRemoteAnnotations(itemIdentity, fuzzy.local, tagMap, listMap)
          } catch (err) {
            this.logger.warn(`Failed to apply remote for ${itemIdentity}`, {
              error: err.message
            })
          }
        }
      } finally {
        this._logApplyStats()
        this.vault.markDirty()
        await this._persistVault()
        this._applyingRemote = false
        if (this.adapter) this.adapter.resumeChanges()
        if (this._queuedLocalChange) {
          this._queuedLocalChange = false
          this._debug('replaying queued local change (debounced)')
          if (this._localDebounceTimer) clearTimeout(this._localDebounceTimer)
          this._localDebounceTimer = setTimeout(() => {
            this._localDebounceTimer = null
            this.syncOnce()
          }, Math.max(100, this.options.localDebounce))
        }
      }
    } finally {
      release()
    }
  }

  // --- Core sync cycle ---

  async syncOnce() {
    if (this.state !== 'connected') return
    if (!this.doc) return
    if (this._paused) return
    if (this._stopping) return

    if (this._syncing) {
      // Another syncOnce is running or waiting for the lock — mark that
      // a re-sync was requested so it runs after the current one completes
      this._syncRequested = true
      return
    }

    // Set flag before acquiring lock to prevent concurrent slipthrough
    this._syncing = true

    // R2: Acquire mutex
    let release = await this._acquireLock()

    // Re-check guards after acquiring lock (state may have changed while waiting)
    if (this.state !== 'connected' || !this.doc || this._paused || this._stopping) {
      this._syncing = false
      release()
      return
    }
    let prev = this.state
    this.state = 'syncing'

    try {
      this._debug('syncOnce: starting cycle')

      let items

      if (this.adapter) {
        // Store-first: read everything from Redux state (no HTTP calls)
        items = this.readAllItemsFull()
        if (items.length === 0) {
          this._debug('syncOnce: no items in store')
          this.state = prev
          return
        }
        this._debug(`syncOnce: got ${items.length} items from store`)
      } else {
        // Fallback: HTTP API enrichment
        let alive = await this.api.ping()
        if (!alive) {
          this._debug('syncOnce: API not reachable, skipping')
          this.state = prev
          return
        }

        let summaries = await this.api.getItems()
        if (!summaries || !Array.isArray(summaries)) {
          this._debug('syncOnce: no items from API')
          this.state = prev
          return
        }
        this._debug(`syncOnce: got ${summaries.length} item summaries`)

        items = await this._enrichAll(summaries)
      }

      this.localIndex = identity.buildIdentityIndex(items)
      this._debug(`syncOnce: ${items.length} items, ${this.localIndex.size} identities`)

      // C2: Build list name cache
      await this._refreshListNameCache()

      // Apply remote FIRST — ensures remote changes land before push
      let appliedIdentities = new Set()
      let crdtChanged = false
      if (this.options.syncMode === 'auto') {
        // P5: Cache annotation count from annotations map size (cheap)
        let annotationsMap = this.doc.getMap('annotations')
        this.vault.updateAnnotationCount(annotationsMap.size)

        crdtChanged = this._remoteAnnotationsDirty
        if (crdtChanged) {
          this._debug('syncOnce: CRDT changed, applying remote')
          appliedIdentities = await this.applyRemoteFromCRDT()

          // P2: Re-read modified items after apply
          if (appliedIdentities.size > 0) {
            if (this.adapter) {
              // Store-first: only re-read items that were actually applied
              let appliedLocalIds = new Set()
              for (let aid of appliedIdentities) {
                let local = this.localIndex.get(aid)
                if (local) appliedLocalIds.add(local.localId)
              }
              items = items.map(item => {
                let localId = item['@id'] || item.id
                if (appliedLocalIds.has(localId)) {
                  return this.adapter.getItemFull(localId) || item
                }
                return item
              })
            } else {
              // API fallback: re-enrich only affected summaries
              let summaries = await this.api.getItems()
              if (summaries && Array.isArray(summaries)) {
                let modifiedSummaries = summaries.filter(s => {
                  let id = identity.computeIdentity({ '@id': s.id, template: s.template, photo: [] })
                  return id && appliedIdentities.has(id)
                })

                if (modifiedSummaries.length === 0 && appliedIdentities.size > 0) {
                  items = await this._enrichAll(summaries)
                } else if (modifiedSummaries.length > 0) {
                  let reEnriched = await this._enrichAll(modifiedSummaries)
                  let reEnrichedMap = new Map()
                  for (let item of reEnriched) {
                    let id = identity.computeIdentity(item)
                    if (id) reEnrichedMap.set(id, item)
                  }
                  items = items.map(item => {
                    let id = identity.computeIdentity(item)
                    return (id && reEnrichedMap.has(id)) ? reEnrichedMap.get(id) : item
                  })
                }
              }
            }
            this.localIndex = identity.buildIdentityIndex(items)
          }
        } else {
          this._debug('syncOnce: CRDT unchanged, skip apply')
        }
      }

      // Push local changes to CRDT (skipped in 'pull' mode — only receive, never push)
      if (this.options.syncMode !== 'pull') {
        if (this.adapter) this.adapter.suppressChanges()
        try {
          await this.pushLocal(items)
        } finally {
          if (this.adapter) this.adapter.resumeChanges()
        }
      }

      // Update CRDT hash after push so next cycle doesn't falsely re-apply
      // Skip if apply had failures — forces retry on next cycle
      let skipHashUpdate = false
      if (this._applyStats && this._applyStats.notesFailed > 0) {
        // Track per-key failures in vault for persistence across restarts
        // Snapshot the set before iterating to avoid race with concurrent additions
        let failedKeys = new Set(this._failedNoteKeys)
        this._failedNoteKeys.clear()
        let givenUp = 0
        for (let key of failedKeys) {
          let count = (this.vault.failedNoteKeys.get(key) || 0) + 1
          this.vault.failedNoteKeys.set(key, count)
          if (count >= 3) {
            this.vault.appliedNoteKeys.add(key)
            this.vault.failedNoteKeys.delete(key)
            this._debug(`note key ${key.slice(0, 8)} permanently given up after ${count} retries`)
            givenUp++
          }
        }

        // Check if any keys still pending retry (failed minus permanently given up)
        let stillRetrying = this._applyStats.notesFailed - givenUp
        if (stillRetrying > 0) {
          skipHashUpdate = true
          this._debug(`apply had ${this._applyStats.notesFailed} note failures, ${stillRetrying} will retry next cycle`)
        }
      } else if (this._applyStats) {
        this._failedNoteKeys.clear()
      }
      if (this.options.syncMode === 'auto' && !skipHashUpdate) {
        // Clear the annotation-dirty flag so next safety-net cycle
        // skips apply unless the observer fires again.
        this._remoteAnnotationsDirty = false
      }

      // R7: Prune vault periodically
      this.vault.pruneAppliedKeys()

      // Persist vault to prevent ghost notes on restart
      this.vault.markDirty()
      await this._persistVault()

      // R7: Bound previousSnapshot size using LRU-style eviction
      this.vault._evictIfNeeded(this.previousSnapshot, 5000)

      this.lastSync = new Date()
      this._consecutiveErrors = 0
      this.state = 'connected'
      this._debug('syncOnce: cycle complete')

    } catch (err) {
      this._consecutiveErrors++
      let errMsg = err instanceof Error ? err.message : String(err || '')
      let isBusy = err && (err.sqliteBusy || errMsg.includes('SQLITE_BUSY'))

      if (isBusy) {
        this.logger.warn({ consecutiveErrors: this._consecutiveErrors },
          'Database busy, will back off')
      } else {
        this.logger.warn({
          error: errMsg,
          stack: err && err.stack
        }, 'Sync cycle failed')
      }

      this.state = prev === 'connected' ? 'connected' : 'error'
    } finally {
      this._syncing = false
      release()

      // Replay any sync triggers that arrived while we were running/waiting
      let needsReplay = this._queuedLocalChange || this._syncRequested
      this._queuedLocalChange = false
      this._syncRequested = false
      if (needsReplay) {
        this._debug('replaying queued sync trigger (debounced)')
        if (this._localDebounceTimer) clearTimeout(this._localDebounceTimer)
        this._localDebounceTimer = setTimeout(() => {
          this._localDebounceTimer = null
          this.syncOnce()
        }, Math.max(100, this.options.localDebounce))
      }
    }
  }

  // --- Fuzzy matching ---

  /**
   * Try to find a local item that matches a CRDT identity by shared photo checksums.
   * Used when exact identity matching fails (e.g., after item merges).
   * Returns { local, localIdentity, checksumCount } or null.
   */
  _fuzzyMatchLocal(crdtIdentity) {
    if (this.localIndex.size === 0 || !this.doc) return null

    let crdtChecksums = schema.getItemChecksums(this.doc, crdtIdentity)
    if (crdtChecksums.length === 0) return null

    let crdtSet = new Set(crdtChecksums)
    let bestMatch = null
    let bestRatio = 0

    for (let [localIdentity, local] of this.localIndex) {
      let photos = local.item.photo || []
      if (!Array.isArray(photos)) photos = [photos]
      let localChecksums = new Set()
      for (let p of photos) {
        if (p.checksum) localChecksums.add(p.checksum)
      }

      // ALL CRDT checksums must be present in the local item
      let allFound = true
      for (let cs of crdtSet) {
        if (!localChecksums.has(cs)) { allFound = false; break }
      }
      // Require minimum overlap: CRDT checksums must cover >= 50% of local photos
      // to reduce false positives when items share a single common photo
      if (allFound && localChecksums.size > 0 &&
          crdtChecksums.length >= Math.ceil(localChecksums.size * 0.5)) {
        // Pick the best match: highest overlap ratio (CRDT checksums / local photos)
        let ratio = crdtChecksums.length / localChecksums.size
        if (ratio > bestRatio) {
          bestRatio = ratio
          bestMatch = { local, localIdentity, checksumCount: crdtChecksums.length }
        }
      }
    }

    return bestMatch
  }

  // --- Apply remote → local (orchestration) ---

  /**
   * S3: Validates inbound data and BLOCKS apply when validation fails.
   * Returns Set of applied item identities (P2).
   */
  async applyRemoteFromCRDT() {
    let identities = schema.getIdentities(this.doc)
    let appliedIdentities = new Set()

    if (identities.length === 0) {
      this._log('applyRemote: CRDT snapshot is empty')
      return appliedIdentities
    }

    this._debug(`applyRemote: scanning ${identities.length} CRDT items`)

    let allTags = this.adapter
      ? this.adapter.getAllTags()
      : await this.api.getTags()
    let tagMap = new Map()
    if (allTags && Array.isArray(allTags)) {
      for (let t of allTags) tagMap.set(t.name, t)
    }

    let listMap = new Map()
    if (this.options.syncLists) {
      try {
        let allLists = this.adapter
          ? this.adapter.getAllLists()
          : await this.api.getLists()
        if (Array.isArray(allLists)) {
          for (let l of allLists) listMap.set(l.name || String(l.id), l)
        }
      } catch (err) {
        this.logger.warn('applyRemoteFromCRDT: failed to fetch lists', { error: String(err.message || err) })
      }
    }

    this._applyingRemote = true
    if (this.adapter) this.adapter.suppressChanges()

    // Collect and validate matched items
    let matched = []
    let matchedIdentities = new Set()
    let matchedLocalIds = new Set()  // Track which local items have exact matches
    for (let itemIdentity of identities) {
      let local = identity.findLocalMatch(itemIdentity, this.localIndex)
      if (!local) continue

      let crdtItem = schema.getItemSnapshot(this.doc, itemIdentity)
      if (!crdtItem) continue
      let validation = this.backup.validateInbound(itemIdentity, crdtItem, this._stableUserId)
      if (!validation.valid) {
        for (let warn of validation.warnings) {
          this.logger.warn(`Validation warning for ${itemIdentity.slice(0, 8)}: ${warn}`)
        }
        this.logger.warn(`Skipping apply for ${itemIdentity.slice(0, 8)} — validation failed`)
        continue
      }

      matched.push({ itemIdentity, local })
      matchedIdentities.add(itemIdentity)
      matchedLocalIds.add(local.localId)
    }

    // Fuzzy matching: for unmatched CRDT identities, try to find local items
    // that contain ALL of the CRDT item's photo checksums (handles merged items)
    let unmatchedIdentities = identities.filter(id => !matchedIdentities.has(id))
    for (let crdtIdentity of unmatchedIdentities) {
      let fuzzy = this._fuzzyMatchLocal(crdtIdentity)
      if (!fuzzy) {
        this._debug(`no fuzzy match for CRDT item ${crdtIdentity.slice(0, 8)}`)
        continue
      }

      // Skip fuzzy matches to locals that already have an exact match —
      // the merged identity's CRDT data supersedes pre-merge data
      if (matchedLocalIds.has(fuzzy.local.localId)) {
        this._debug(`fuzzy skip: CRDT ${crdtIdentity.slice(0, 8)} → local ${fuzzy.localIdentity.slice(0, 8)} (already has exact match)`)
        continue
      }
      this._log(`fuzzy match: CRDT ${crdtIdentity.slice(0, 8)} → local ${fuzzy.localIdentity.slice(0, 8)} (merged item, ${fuzzy.checksumCount} shared photo(s))`)
      let crdtItem = schema.getItemSnapshot(this.doc, crdtIdentity)
      if (!crdtItem) continue
      let validation = this.backup.validateInbound(crdtIdentity, crdtItem, this._stableUserId)
      if (validation.valid) {
        matched.push({ itemIdentity: crdtIdentity, local: fuzzy.local })
        matchedLocalIds.add(fuzzy.local.localId)
      }
    }

    if (matched.length === 0) {
      this._applyingRemote = false
      if (this.adapter) this.adapter.resumeChanges()
      this._debug('applyRemote: no matched items')
      return appliedIdentities
    }

    // Batch backup — prefer store adapter when available
    try {
      let backupItems = []
      for (let { local, itemIdentity } of matched) {
        try {
          let state = this.adapter
            ? this.backup.captureItemStateFromStore(this.adapter, local.localId, itemIdentity)
            : await this.backup.captureItemState(local.localId, itemIdentity)
          backupItems.push(state)
        } catch (err) {
          this.logger.warn(`applyRemoteFromCRDT: backup capture failed for ${itemIdentity.slice(0, 8)}`, { error: String(err.message || err) })
        }
      }
      if (backupItems.length > 0 && this.vault.shouldBackup(backupItems)) {
        await this.backup.saveSnapshot(backupItems)
      }
    } catch (err) {
      this.logger.warn('Batch backup failed', { error: err.message })
    }

    this._resetApplyStats()

    try {
      for (let { itemIdentity, local } of matched) {
        try {
          await this.applyRemoteAnnotations(itemIdentity, local, tagMap, listMap)
          appliedIdentities.add(itemIdentity)
        } catch (err) {
          this.logger.warn(`Failed to apply remote for ${itemIdentity}`, {
            error: err.message
          })
        }
      }
    } finally {
      this._logApplyStats()
      this.vault.markDirty()
      await this._persistVault()
      this._applyingRemote = false
      if (this.adapter) this.adapter.resumeChanges()
      if (this._queuedLocalChange) {
        this._queuedLocalChange = false
        this._debug('replaying queued local change (debounced)')
        // Debounce the replay to avoid thundering herd
        if (this._localDebounceTimer) clearTimeout(this._localDebounceTimer)
        this._localDebounceTimer = setTimeout(() => {
          this._localDebounceTimer = null
          this.syncOnce()
        }, Math.max(100, this.options.localDebounce))
      }
    }
    return appliedIdentities
  }

  // --- Import (review mode) ---

  async applyOnDemand() {
    if (!this.doc) return null

    let release = await this._acquireLock()
    try {
      return await this._applyOnDemandInner()
    } finally {
      release()
    }
  }

  async _applyOnDemandInner() {
    let allIdentities = schema.getIdentities(this.doc)
    let userId = this._stableUserId
    let summary = {}

    let allTags = this.adapter
      ? this.adapter.getAllTags()
      : await this.api.getTags()
    let tagMap = new Map()
    if (allTags && Array.isArray(allTags)) {
      for (let t of allTags) tagMap.set(t.name, t)
    }

    let listMap = new Map()
    if (this.options.syncLists) {
      try {
        let allLists = this.adapter
          ? this.adapter.getAllLists()
          : await this.api.getLists()
        if (Array.isArray(allLists)) {
          for (let l of allLists) listMap.set(l.name || String(l.id), l)
        }
      } catch (err) {
        this.logger.warn('applyOnDemand: failed to fetch lists', { error: String(err.message || err) })
      }
    }

    for (let itemIdentity of allIdentities) {
      let item = schema.getItemSnapshot(this.doc, itemIdentity)
      if (!item) continue
      for (let section of ['metadata', 'tags', 'notes', 'selections', 'transcriptions', 'lists']) {
        let data = item[section]
        if (!data || typeof data !== 'object') continue

        for (let val of Object.values(data)) {
          if (val && val.author && val.author !== userId && !val.deleted) {
            if (!summary[val.author]) {
              summary[val.author] = { metadata: 0, tags: 0, notes: 0, selections: 0, transcriptions: 0, lists: 0 }
            }
            summary[val.author][section]++
          }
        }
      }
    }

    for (let [author, counts] of Object.entries(summary)) {
      let parts = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([type, n]) => `${n} ${type}`)
      if (parts.length > 0) {
        this.logger.info(`${author}: ${parts.join(', ')}`)
      }
    }

    // Backup (with validation gating)
    let backupItems = []
    let validIdentities = []
    for (let itemIdentity of allIdentities) {
      let local = identity.findLocalMatch(itemIdentity, this.localIndex)
      if (!local) continue

      // S3: Validate before applying
      let crdtItem = schema.getItemSnapshot(this.doc, itemIdentity)
      if (!crdtItem) continue
      let validation = this.backup.validateInbound(itemIdentity, crdtItem, this._stableUserId)
      if (!validation.valid) {
        for (let warn of validation.warnings) {
          this.logger.warn(`Validation warning: ${warn}`)
        }
        continue
      }

      validIdentities.push(itemIdentity)
      try {
        let state = this.adapter
          ? this.backup.captureItemStateFromStore(this.adapter, local.localId, itemIdentity)
          : await this.backup.captureItemState(local.localId, itemIdentity)
        backupItems.push(state)
      } catch (err) {
        this.logger.warn(`applyOnDemand: backup capture failed for ${itemIdentity.slice(0, 8)}`, { error: String(err.message || err) })
      }
    }
    if (backupItems.length > 0 && this.vault.shouldBackup(backupItems)) {
      await this.backup.saveSnapshot(backupItems)
    }

    this._applyingRemote = true
    if (this.adapter) this.adapter.suppressChanges()
    this._resetApplyStats()
    let applied = 0
    try {
      for (let itemIdentity of validIdentities) {
        let local = identity.findLocalMatch(itemIdentity, this.localIndex)
        if (!local) continue
        try {
          await this.applyRemoteAnnotations(itemIdentity, local, tagMap, listMap)
          applied++
        } catch (err) {
          this.logger.warn(`Import: failed to apply ${itemIdentity}`, {
            error: err.message
          })
        }
      }
    } finally {
      this._logApplyStats()
      this.vault.markDirty()
      await this._persistVault()
      this._applyingRemote = false
      if (this.adapter) this.adapter.resumeChanges()
    }

    return { applied, summary }
  }

  // --- Rollback ---

  async rollback(backupPath) {
    return this.backup.rollback(backupPath, this.adapter)
  }

  // --- Tombstone purge ---

  purgeTombstones() {
    if (!this.doc) return

    this.logger.info('Purging tombstones from CRDT')

    this.doc.transact(() => {
      let result = schema.purgeTombstones(this.doc)
      this.logger.info(
        `Purged ${result.purged} tombstone(s) across ${result.items} item(s)`
      )
    }, this.LOCAL_ORIGIN)
  }

  // --- Status ---

  // P5: Uses cached annotation count instead of serializing whole doc
  getStatus() {
    return {
      state: this.state,
      lastSync: this.lastSync,
      room: this.options.room,
      server: this.options.serverUrl,
      syncMode: this.options.syncMode,
      clientId: this.doc ? this.doc.clientID : null,
      localItems: this.localIndex.size,
      crdtItems: this.vault.annotationCount,
      users: this.doc ? schema.getUsers(this.doc) : [],
      watching: this.fileWatcher != null || this._storeUnsubscribe != null,
      storeAvailable: this.adapter != null,
      projectPath: this.projectPath,
      consecutiveErrors: this._consecutiveErrors
    }
  }
}

// Mix in methods from modules
Object.assign(SyncEngine.prototype, require('./push'))
Object.assign(SyncEngine.prototype, require('./apply'))
Object.assign(SyncEngine.prototype, require('./enrich'))

module.exports = { SyncEngine }
