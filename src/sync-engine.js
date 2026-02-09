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
const { sanitizeHtml, escapeHtml } = require('./sanitize')

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

    // State tracker
    this.vault = new SyncVault()

    // Event queue for local changes detected during apply phase
    this._applyingRemote = false
    this._queuedLocalChange = false

    // R2: Async mutex — chains async operations to prevent concurrent access
    this._syncLock = Promise.resolve()

    // R9: File watcher health — track last event time (fs.watch fallback only)
    this._lastWatcherEvent = 0
    this._watcherHealthTimer = null

    // Transaction origin marker
    this.LOCAL_ORIGIN = 'troparcel-local'

    // C2: List name cache (listId -> listName)
    this._listNameCache = new Map()

    // Stable userId — includes apiPort so different Tropy instances on the
    // same machine get distinct IDs (e.g. AppImage:2019 vs Flatpak:2021)
    this._stableUserId = options.userId ||
      `${os.userInfo().username}@${os.hostname()}:${options.apiPort || 2019}`
  }

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

  _resetApplyStats() {
    this._applyStats = {
      notesCreated: 0, notesDeduped: 0, notesUpdated: 0, notesRetracted: 0,
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
    }, 'Sync engine v3.1 starting')

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

      // Diagnostic: log all provider status events
      this.provider.on('status', (e) => {
        this.logger.info(`WS status: ${e.status}`)
      })
      this.provider.on('connection-error', (e) => {
        this.logger.warn({ error: e.message || String(e) }, 'WS connection-error')
      })
      this.provider.on('connection-close', (e) => {
        this.logger.info({ code: e.code, reason: e.reason }, 'WS connection-close')
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

      // Monitor connection status
      this._statusHandler = (event) => {
        if (event.status === 'connected') {
          this.state = 'connected'
          this.logger.info('WebSocket connected')
        } else if (event.status === 'disconnected') {
          this.logger.warn('WebSocket disconnected, will retry')
        }
      }
      this.provider.on('status', this._statusHandler)

      this.state = 'connected'
      this.logger.info({
        clientId: this.doc.clientID,
        room: this.options.room
      }, 'Sync engine connected')

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

      // Heartbeat
      this.heartbeatTimer = setInterval(() => {
        schema.heartbeat(this.doc, this.doc.clientID)
      }, 30000)

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

  stop() {
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
      try { this.fileWatcher.close() } catch {}
      this.fileWatcher = null
    }
    if (this.projectPath) {
      this._log('Restarting file watcher')
      this._startFileWatcher()
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
      } catch {}
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
        } catch {}
      }

      // Re-read items from store to get current state (localIndex may be stale)
      if (this.adapter) {
        let freshItems = this.readAllItemsFull()
        if (freshItems.length > 0) {
          this.localIndex = identity.buildIdentityIndex(freshItems)
        }
      }

      // C3: Cache CRDT snapshot for validation (same check as applyRemoteFromCRDT)
      let validationSnapshot = this.backup ? schema.getSnapshot(this.doc) : null

      this._applyingRemote = true
      if (this.adapter) this.adapter.suppressChanges()
      this._resetApplyStats()

      try {
        // First pass: exact matches (these take priority over fuzzy matches)
        let processedLocalIds = new Set()
        for (let itemIdentity of identities) {
          let local = identity.findLocalMatch(itemIdentity, this.localIndex)
          if (!local) continue

          processedLocalIds.add(local.localId)

          // C3: Validate inbound CRDT data before applying
          if (this.backup && validationSnapshot) {
            let crdtItem = validationSnapshot[itemIdentity]
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
          if (identity.findLocalMatch(itemIdentity, this.localIndex)) continue
          let local = this._fuzzyMatchLocal(itemIdentity)
          if (!local) continue
          if (processedLocalIds.has(local.localId)) continue
          processedLocalIds.add(local.localId)

          if (this.backup && validationSnapshot) {
            let crdtItem = validationSnapshot[itemIdentity]
            if (crdtItem) {
              let validation = this.backup.validateInbound(itemIdentity, crdtItem, this._stableUserId)
              if (!validation.valid) continue
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
      } finally {
        this._logApplyStats()
        this._applyingRemote = false
        if (this.adapter) this.adapter.resumeChanges()
        if (this._queuedLocalChange) {
          this._queuedLocalChange = false
          this._debug('replaying queued local change')
          this.handleLocalChange()
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
    if (this._syncing) return
    if (this._paused) return

    this._syncing = true

    // R2: Acquire mutex
    let release = await this._acquireLock()
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
      if (this.options.syncMode === 'auto') {
        let snapshot = schema.getSnapshot(this.doc)

        // P5: Cache annotation count
        this.vault.updateAnnotationCount(Object.keys(snapshot).length)

        if (this.vault.hasCRDTChanged(snapshot)) {
          this._debug('syncOnce: CRDT changed, applying remote')
          appliedIdentities = await this.applyRemoteFromCRDT()

          // P2: Re-read modified items after apply
          if (appliedIdentities.size > 0) {
            if (this.adapter) {
              // Store-first: just re-read everything (cheap)
              items = this.readAllItemsFull()
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

      await this.pushLocal(items)

      // Update CRDT hash after push so next cycle doesn't falsely re-apply
      if (this.options.syncMode === 'auto') {
        let postPushSnapshot = schema.getSnapshot(this.doc)
        this.vault.hasCRDTChanged(postPushSnapshot)
      }

      // R7: Prune vault periodically
      this.vault.pruneAppliedKeys()

      // R7: Bound previousSnapshot size
      if (this.previousSnapshot.size > 5000) {
        let keys = Array.from(this.previousSnapshot.keys())
        let toRemove = keys.slice(0, keys.length - 5000)
        for (let k of toRemove) this.previousSnapshot.delete(k)
      }

      this.lastSync = new Date()
      this._consecutiveErrors = 0
      this.state = 'connected'
      this._debug('syncOnce: cycle complete')

    } catch (err) {
      this._consecutiveErrors++
      let isBusy = err && (err.sqliteBusy || (err.message && err.message.includes('SQLITE_BUSY')))

      if (isBusy) {
        this.logger.warn({ consecutiveErrors: this._consecutiveErrors },
          'Database busy, will back off')
      } else {
        this.logger.warn({
          error: err instanceof Error ? err.message : String(err),
          stack: err && err.stack,
          raw: typeof err === 'object' ? JSON.stringify(err) : String(err)
        }, 'Sync cycle failed')
      }

      this.state = prev === 'connected' ? 'connected' : 'error'
    } finally {
      this._syncing = false
      release()

      if (this._queuedLocalChange) {
        this._queuedLocalChange = false
        this._debug('replaying queued local change')
        this.handleLocalChange()
      }
    }
  }

  // --- Enrichment ---

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
  }

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
  }

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
    } catch {
      return null
    }
  }

  /**
   * Try to find a local item that matches a CRDT identity by shared photo checksums.
   * Used when exact identity matching fails (e.g., after item merges).
   * Returns { localId, item } or null.
   */
  _fuzzyMatchLocal(crdtIdentity) {
    if (this.localIndex.size === 0 || !this.doc) return null

    let crdtChecksums = schema.getItemChecksums(this.doc, crdtIdentity)
    if (crdtChecksums.length === 0) return null

    let crdtSet = new Set(crdtChecksums)

    for (let [, local] of this.localIndex) {
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
      if (allFound) return local
    }

    return null
  }

  // --- Push local → CRDT ---

  async pushLocal(items) {
    let userId = this._stableUserId
    let pushed = 0
    let skipped = 0

    for (let item of items) {
      let id = identity.computeIdentity(item)
      if (!id) continue

      if (!this.vault.hasItemChanged(id, item)) {
        skipped++
        continue
      }
      pushed++

      // P4: Compute checksumMap once per item
      let checksumMap = identity.buildPhotoChecksumMap(item)

      try {
        this.doc.transact(() => {
          // Store photo checksums for fuzzy identity matching (merged items)
          let checksums = Array.from(checksumMap.values())
          if (checksums.length > 0) {
            schema.setItemChecksums(this.doc, id, checksums)
          }
          this.pushMetadata(item, id, userId)
          this.pushTags(item, id, userId)
          this.pushNotes(item, id, userId, checksumMap)
          this.pushPhotoMetadata(item, id, userId)
          this.pushSelections(item, id, userId, checksumMap)
          this.pushTranscriptions(item, id, userId, checksumMap)
          if (this.options.syncLists) {
            this.pushLists(item, id, userId)
          }
          this.pushDeletions(item, id, userId, checksumMap)
        }, this.LOCAL_ORIGIN)

        this.saveItemSnapshot(item, id, checksumMap)
        this.vault.markPushed(id, item)
      } catch (err) {
        this.logger.warn(`Failed to push item ${id}`, { error: err.message })
      }
    }

    if (pushed > 0) {
      this._log(`pushed ${pushed} item(s) to CRDT`)
    } else {
      this._debug(`pushLocal: ${skipped} item(s) unchanged`)
    }
  }

  pushMetadata(item, itemIdentity, userId) {
    let existing = schema.getMetadata(this.doc, itemIdentity)
    let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0

    for (let [key, value] of Object.entries(item)) {
      if (key.startsWith('@') || key.startsWith('_')) continue
      if (['photo', 'template', 'list', 'lists', 'tag'].includes(key)) continue
      if (!key.includes(':') && !key.includes('/')) continue

      let text = ''
      let type = 'http://www.w3.org/2001/XMLSchema#string'
      let language = null

      if (typeof value === 'string') {
        text = value
      } else if (value && typeof value === 'object') {
        text = value['@value'] || value.text || ''
        type = value['@type'] || value.type || type
        language = value['@language'] || value.language || null
      } else if (value != null) {
        text = String(value)
      }

      if (!text) continue

      let current = existing[key]
      if (current) {
        if (current.text === text && current.type === type) continue
        if (current.author !== userId && current.ts > lastPushTs) continue
      }

      schema.setMetadata(this.doc, itemIdentity, key, { text, type, language }, userId)
    }
  }

  pushTags(item, itemIdentity, userId) {
    let tags = item.tag || item['https://tropy.org/v1/tropy#tag'] || []
    if (!Array.isArray(tags)) tags = [tags]

    let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0
    let existingTags = schema.getTags(this.doc, itemIdentity)

    for (let tag of tags) {
      let name = typeof tag === 'string' ? tag : (tag.name || tag['@value'] || '')
      let color = typeof tag === 'object' ? tag.color : null

      if (!name) continue

      let existing = existingTags.find(t => t.name === name)
      if (existing && !existing.deleted) {
        if ((existing.color || null) === (color || null)) continue
        if (existing.author !== userId && existing.ts > lastPushTs) continue
      }

      schema.setTag(this.doc, itemIdentity, { name, color }, userId)
    }
  }

  // C1: Uses vault mapping for stable note keys
  pushNotes(item, itemIdentity, userId, checksumMap) {
    let photos = item.photo || item['https://tropy.org/v1/tropy#photo'] || []
    if (!Array.isArray(photos)) photos = [photos]

    let existingNotes = schema.getNotes(this.doc, itemIdentity)
    let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0

    // Track all note keys we push, so we can clean up stale entries after
    let pushedNoteKeys = new Set()
    let pushedSelNoteKeys = new Set()

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      let notes = photo.note || photo['https://tropy.org/v1/tropy#note'] || []
      if (!Array.isArray(notes)) notes = [notes]

      for (let note of notes) {
        if (!note) continue
        let text = note['@value'] || note.text || note['https://schema.org/text'] || ''
        let html = note.html || note['https://tropy.org/v1/tropy#html'] || ''
        if (typeof text === 'object') text = text['@value'] || ''
        if (typeof html === 'object') html = html['@value'] || ''

        // Skip notes applied by troparcel (have [author] prefix from sync)
        if (this._isSyncedNote(text, html)) continue

        if (text || html) {
          let contentKey = identity.computeNoteKey(
            { text, html, photo: photo['@id'] || photo.id },
            photoChecksum
          )

          // C1: Use vault to get stable key across edits
          let localNoteId = note['@id'] || note.id
          let noteKey = localNoteId
            ? this.vault.getNoteKey(localNoteId, contentKey)
            : contentKey

          pushedNoteKeys.add(noteKey)
          this.vault.appliedNoteKeys.add(noteKey)

          let existingNote = existingNotes[noteKey]
          if (existingNote && !existingNote.deleted &&
              existingNote.text === text && existingNote.html === html) {
            continue
          }
          if (existingNote && !existingNote.deleted &&
              existingNote.author !== userId && existingNote.ts > lastPushTs) {
            continue
          }

          schema.setNote(this.doc, itemIdentity, noteKey, {
            text,
            html,
            language: note.language || null,
            photo: photoChecksum || null
          }, userId)
        }
      }

      // Selection notes
      let selections = photo.selection || photo['https://tropy.org/v1/tropy#selection'] || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel || !photoChecksum) continue

        let selKey = identity.computeSelectionKey(photoChecksum, sel)
        let selNotes = sel.note || sel['https://tropy.org/v1/tropy#note'] || []
        if (!Array.isArray(selNotes)) selNotes = [selNotes]

        let existingSelNotes = schema.getSelectionNotes(this.doc, itemIdentity, selKey)

        for (let note of selNotes) {
          if (!note) continue
          let text = note['@value'] || note.text || ''
          let html = note.html || ''
          if (typeof text === 'object') text = text['@value'] || ''
          if (typeof html === 'object') html = html['@value'] || ''

          // Skip notes applied by troparcel (have [author] prefix from sync)
          if (this._isSyncedNote(text, html)) continue

          if (text || html) {
            let contentKey = identity.computeNoteKey(
              { text, html, selection: sel['@id'] || sel.id },
              photoChecksum
            )

            let localNoteId = note['@id'] || note.id
            let noteKey = localNoteId
              ? this.vault.getNoteKey(localNoteId, contentKey)
              : contentKey

            let compositeKey = `${selKey}:${noteKey}`
            pushedSelNoteKeys.add(compositeKey)
            this.vault.appliedNoteKeys.add(compositeKey)

            let existingSelNote = existingSelNotes[compositeKey]
            if (existingSelNote &&
                existingSelNote.text === text && existingSelNote.html === html) {
              continue
            }
            if (existingSelNote && !existingSelNote.deleted &&
                existingSelNote.author !== userId && existingSelNote.ts > lastPushTs) {
              continue
            }

            schema.setSelectionNote(this.doc, itemIdentity, selKey, noteKey, {
              text,
              html,
              language: note.language || null
            }, userId)
          }
        }
      }
    }

    // Clean up stale CRDT entries authored by us (content-based key changed).
    // Uses permanent Y.Map.delete() — NOT tombstoning — to avoid bloat.
    this._cleanupStaleNotes(itemIdentity, userId, pushedNoteKeys, pushedSelNoteKeys)
  }

  /**
   * Remove stale CRDT note/selectionNote entries authored by this user
   * that are no longer in the current local note set.
   * Uses Y.Map.delete() for permanent removal (not tombstoning).
   */
  _cleanupStaleNotes(itemIdentity, userId, pushedNoteKeys, pushedSelNoteKeys) {
    // Only clean up stale entries when deletion propagation is enabled.
    // Y.Map.delete() propagates to all peers — without this guard,
    // locally-deleted notes get removed from the CRDT even when the user
    // has syncDeletions=false.
    if (!this.options.syncDeletions) return

    let allNotes = schema.getNotes(this.doc, itemIdentity)
    let removed = 0

    for (let [key, note] of Object.entries(allNotes)) {
      if (note.author !== userId) continue
      if (note.deleted) continue
      if (pushedNoteKeys.has(key)) continue

      // This is a stale entry from us — permanently delete it
      schema.deleteNoteEntry(this.doc, itemIdentity, key)
      removed++
    }

    let allSelNotes = schema.getAllSelectionNotes(this.doc, itemIdentity)
    for (let [key, note] of Object.entries(allSelNotes)) {
      if (note.author !== userId) continue
      if (note.deleted) continue
      if (pushedSelNoteKeys.has(key)) continue

      schema.deleteSelectionNoteEntry(this.doc, itemIdentity, key)
      removed++
    }

    if (removed > 0) {
      this._log(`cleanupStaleNotes: removed ${removed} stale entry(s) for ${itemIdentity.slice(0, 8)}`)
    }
  }

  pushPhotoMetadata(item, itemIdentity, userId) {
    if (!this.options.syncPhotoAdjustments) return
    let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0

    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let photo of photos) {
      let checksum = photo.checksum
      if (!checksum || !photo.metadata) continue

      let existing = schema.getPhotoMetadata(this.doc, itemIdentity, checksum)

      for (let [key, value] of Object.entries(photo.metadata)) {
        if (key === 'id') continue
        let text = ''
        let type = 'http://www.w3.org/2001/XMLSchema#string'

        if (typeof value === 'object' && value !== null) {
          text = value.text || ''
          type = value.type || type
        } else if (value != null) {
          text = String(value)
        }

        if (!text) continue

        if (existing[key] && existing[key].text === text) continue
        if (existing[key] && existing[key].author !== userId && existing[key].ts > lastPushTs) continue

        schema.setPhotoMetadata(this.doc, itemIdentity, checksum, key, { text, type }, userId)
      }
    }
  }

  // P4: Accepts checksumMap parameter instead of recomputing
  pushSelections(item, itemIdentity, userId, checksumMap) {
    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    let existingSelections = schema.getSelections(this.doc, itemIdentity)
    let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      if (!photoChecksum) continue

      let selections = photo.selection || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel) continue

        let selKey = identity.computeSelectionKey(photoChecksum, sel)
        this.vault.appliedSelectionKeys.add(selKey)

        let existingSel = existingSelections[selKey]
        let selUnchanged = existingSel && !existingSel.deleted &&
            existingSel.x === sel.x && existingSel.y === sel.y &&
            existingSel.w === sel.width && existingSel.h === sel.height &&
            (existingSel.angle || 0) === (sel.angle || 0)

        let remoteNewer = existingSel && !existingSel.deleted &&
            existingSel.author !== userId && existingSel.ts > lastPushTs

        if (!selUnchanged && !remoteNewer) {
          schema.setSelection(this.doc, itemIdentity, selKey, {
            x: sel.x,
            y: sel.y,
            width: sel.width,
            height: sel.height,
            angle: sel.angle || 0,
            photo: photoChecksum
          }, userId)
        }

        // Selection metadata
        if (sel.metadata) {
          let existingSelMeta = schema.getSelectionMeta(this.doc, itemIdentity, selKey)

          for (let [key, value] of Object.entries(sel.metadata)) {
            if (key === 'id') continue
            let text = ''
            let type = 'http://www.w3.org/2001/XMLSchema#string'

            if (typeof value === 'object' && value !== null) {
              text = value.text || ''
              type = value.type || type
            } else if (value != null) {
              text = String(value)
            }

            if (!text) continue

            let existingSM = existingSelMeta[key]
            if (existingSM && existingSM.text === text && existingSM.type === type) continue
            if (existingSM && existingSM.author !== userId && existingSM.ts > lastPushTs) continue

            schema.setSelectionMeta(this.doc, itemIdentity, selKey, key, { text, type }, userId)
          }
        }
      }
    }
  }

  // C3: Uses vault mapping for stable transcription keys
  pushTranscriptions(item, itemIdentity, userId, checksumMap) {
    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    let existingTranscriptions = schema.getTranscriptions(this.doc, itemIdentity)
    let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      if (!photoChecksum) continue

      // Photo-level transcriptions
      let txs = photo.transcription || []
      if (!Array.isArray(txs)) txs = [txs]

      txs.forEach((tx, idx) => {
        if (!tx) return
        let contentKey = identity.computeTranscriptionKey(photoChecksum, idx)

        // C3: Use vault for stable key
        let localTxId = tx['@id'] || tx.id
        let txKey = localTxId
          ? this.vault.getTxKey(localTxId, contentKey)
          : contentKey

        this.vault.appliedTranscriptionKeys.add(txKey)

        let existingTx = existingTranscriptions[txKey]
        if (existingTx && !existingTx.deleted && existingTx.text === (tx.text || '')) {
          return
        }
        if (existingTx && !existingTx.deleted &&
            existingTx.author !== userId && existingTx.ts > lastPushTs) {
          return
        }

        schema.setTranscription(this.doc, itemIdentity, txKey, {
          text: tx.text || '',
          data: tx.data || null,
          photo: photoChecksum
        }, userId)
      })

      // Selection-level transcriptions
      let selections = photo.selection || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel) continue
        let selKey = identity.computeSelectionKey(photoChecksum, sel)
        let selTxs = sel.transcription || []
        if (!Array.isArray(selTxs)) selTxs = [selTxs]

        selTxs.forEach((tx, idx) => {
          if (!tx) return
          let contentKey = identity.computeTranscriptionKey(photoChecksum, idx, selKey)

          let localTxId = tx['@id'] || tx.id
          let txKey = localTxId
            ? this.vault.getTxKey(localTxId, contentKey)
            : contentKey

          this.vault.appliedTranscriptionKeys.add(txKey)

          let existingTx = existingTranscriptions[txKey]
          if (existingTx && !existingTx.deleted && existingTx.text === (tx.text || '')) {
            return
          }
          if (existingTx && !existingTx.deleted &&
              existingTx.author !== userId && existingTx.ts > lastPushTs) {
            return
          }

          schema.setTranscription(this.doc, itemIdentity, txKey, {
            text: tx.text || '',
            data: tx.data || null,
            photo: photoChecksum,
            selection: selKey
          }, userId)
        })
      }
    }
  }

  // C2: Resolves list IDs to names for cross-instance matching
  pushLists(item, itemIdentity, userId) {
    let listIds = item.lists || []
    if (!Array.isArray(listIds)) return

    let existingLists = schema.getLists(this.doc, itemIdentity)
    let lastPushTs = this.lastSync ? this.lastSync.getTime() : 0

    for (let listId of listIds) {
      // C2: Use list name (not local ID) as the CRDT key
      let listName = this._listNameCache.get(listId) || this._listNameCache.get(String(listId))
      let key = listName || String(listId)

      let existing = existingLists[key]
      if (existing && !existing.deleted && existing.member) continue
      if (existing && existing.author !== userId && existing.ts > lastPushTs) continue

      schema.setListMembership(this.doc, itemIdentity, key, userId)
    }
  }

  // C2: Refresh the listId -> listName cache
  async _refreshListNameCache() {
    if (!this.options.syncLists) return
    try {
      let lists = this.adapter
        ? this.adapter.getAllLists()
        : await this.api.getLists()
      if (Array.isArray(lists)) {
        this._listNameCache.clear()
        for (let l of lists) {
          if (l.id && l.name) {
            this._listNameCache.set(l.id, l.name)
            this._listNameCache.set(String(l.id), l.name)
          }
        }
      }
    } catch {}
  }

  // --- Deletion detection ---

  /**
   * Compute all identity keys for an item's sub-resources (notes, selections,
   * transcriptions, selection notes, list names). Shared by saveItemSnapshot
   * and pushDeletions to avoid duplicated photo traversal code.
   */
  _computeItemKeys(item, checksumMap) {
    let noteKeys = new Set()
    let selectionKeys = new Set()
    let transcriptionKeys = new Set()
    let selectionNoteKeys = new Set()
    let listNames = new Set()

    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)

      // Photo-level notes
      let notes = photo.note || []
      if (!Array.isArray(notes)) notes = [notes]

      for (let note of notes) {
        if (!note) continue
        let text = note['@value'] || note.text || ''
        let html = note.html || ''
        if (typeof text === 'object') text = text['@value'] || ''
        if (typeof html === 'object') html = html['@value'] || ''
        if (text || html) {
          let contentKey = identity.computeNoteKey(
            { text, html, photo: photo['@id'] || photo.id },
            photoChecksum
          )
          let localNoteId = note['@id'] || note.id
          let key = localNoteId
            ? this.vault.getNoteKey(localNoteId, contentKey)
            : contentKey
          noteKeys.add(key)
        }
      }

      // Photo-level transcriptions
      let txs = photo.transcription || []
      if (!Array.isArray(txs)) txs = [txs]
      txs.forEach((tx, idx) => {
        if (!tx) return
        let contentKey = identity.computeTranscriptionKey(photoChecksum, idx)
        let localTxId = tx['@id'] || tx.id
        let txKey = localTxId
          ? this.vault.getTxKey(localTxId, contentKey)
          : contentKey
        transcriptionKeys.add(txKey)
      })

      // Selections and their sub-resources
      let selections = photo.selection || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel || !photoChecksum) continue
        let selKey = identity.computeSelectionKey(photoChecksum, sel)
        selectionKeys.add(selKey)

        // Selection notes
        let selNotes = sel.note || []
        if (!Array.isArray(selNotes)) selNotes = [selNotes]
        for (let note of selNotes) {
          if (!note) continue
          let text = note['@value'] || note.text || ''
          let html = note.html || ''
          if (typeof text === 'object') text = text['@value'] || ''
          if (typeof html === 'object') html = html['@value'] || ''
          if (text || html) {
            let contentKey = identity.computeNoteKey(
              { text, html, selection: sel['@id'] || sel.id },
              photoChecksum
            )
            let localNoteId = note['@id'] || note.id
            let noteKey = localNoteId
              ? this.vault.getNoteKey(localNoteId, contentKey)
              : contentKey
            selectionNoteKeys.add(`${selKey}:${noteKey}`)
          }
        }

        // Selection transcriptions
        let selTxs = sel.transcription || []
        if (!Array.isArray(selTxs)) selTxs = [selTxs]
        selTxs.forEach((tx, idx) => {
          if (!tx) return
          let contentKey = identity.computeTranscriptionKey(photoChecksum, idx, selKey)
          let localTxId = tx['@id'] || tx.id
          let txKey = localTxId
            ? this.vault.getTxKey(localTxId, contentKey)
            : contentKey
          transcriptionKeys.add(txKey)
        })
      }
    }

    // List memberships
    let listIds = item.lists || []
    if (Array.isArray(listIds)) {
      for (let listId of listIds) {
        let name = this._listNameCache.get(listId) || this._listNameCache.get(String(listId))
        if (name) listNames.add(name)
      }
    }

    return { noteKeys, selectionKeys, transcriptionKeys, selectionNoteKeys, listNames }
  }

  // P4: Accepts checksumMap parameter
  saveItemSnapshot(item, itemIdentity, checksumMap) {
    let tags = (item.tag || []).map(t =>
      typeof t === 'string' ? t : (t.name || '')
    ).filter(Boolean)

    let keys = this._computeItemKeys(item, checksumMap)

    this.previousSnapshot.set(itemIdentity, { tags, ...keys })
  }

  pushDeletions(item, itemIdentity, userId, checksumMap) {
    if (!this.options.syncDeletions) return
    let prev = this.previousSnapshot.get(itemIdentity)
    if (!prev) return

    // Detect removed tags
    let currentTags = new Set(
      (item.tag || []).map(t =>
        typeof t === 'string' ? t : (t.name || '')
      ).filter(Boolean)
    )
    for (let tagName of prev.tags) {
      if (!currentTags.has(tagName)) {
        schema.removeTag(this.doc, itemIdentity, tagName, userId)
      }
    }

    // Compute current keys and compare with previous snapshot
    let current = this._computeItemKeys(item, checksumMap)

    // Tombstone removed notes
    for (let noteKey of prev.noteKeys) {
      if (!current.noteKeys.has(noteKey)) {
        schema.removeNote(this.doc, itemIdentity, noteKey, userId)
      }
    }

    // Tombstone removed selections
    if (prev.selectionKeys) {
      for (let selKey of prev.selectionKeys) {
        if (!current.selectionKeys.has(selKey)) {
          schema.removeSelection(this.doc, itemIdentity, selKey, userId)
        }
      }
    }

    // Tombstone removed transcriptions
    if (prev.transcriptionKeys) {
      for (let txKey of prev.transcriptionKeys) {
        if (!current.transcriptionKeys.has(txKey)) {
          schema.removeTranscription(this.doc, itemIdentity, txKey, userId)
        }
      }
    }

    // Tombstone removed selection notes
    if (prev.selectionNoteKeys) {
      for (let compositeKey of prev.selectionNoteKeys) {
        if (!current.selectionNoteKeys.has(compositeKey)) {
          let sepIdx = compositeKey.indexOf(':')
          if (sepIdx > 0) {
            let selKey = compositeKey.slice(0, sepIdx)
            let noteKey = compositeKey.slice(sepIdx + 1)
            schema.removeSelectionNote(this.doc, itemIdentity, selKey, noteKey, userId)
          }
        }
      }
    }

    // Tombstone removed list memberships
    if (prev.listNames && this.options.syncLists) {
      for (let listName of prev.listNames) {
        if (!current.listNames.has(listName)) {
          schema.removeListMembership(this.doc, itemIdentity, listName, userId)
        }
      }
    }
  }

  // --- Apply remote → local ---

  /**
   * S3: Validates inbound data and BLOCKS apply when validation fails.
   * Returns Set of applied item identities (P2).
   */
  async applyRemoteFromCRDT() {
    let snapshot = schema.getSnapshot(this.doc)
    let identities = Object.keys(snapshot)
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
      } catch {}
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

      let crdtItem = snapshot[itemIdentity]
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
    if (unmatchedIdentities.length > 0) {
      for (let crdtIdentity of unmatchedIdentities) {
        let crdtChecksums = schema.getItemChecksums(this.doc, crdtIdentity)
        if (crdtChecksums.length === 0) {
          this._debug(`no checksums for unmatched CRDT item ${crdtIdentity.slice(0, 8)}`)
          continue
        }

        let crdtSet = new Set(crdtChecksums)
        let bestLocal = null
        let bestLocalIdentity = null

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
          if (allFound) {
            bestLocal = local
            bestLocalIdentity = localIdentity
            break
          }
        }

        if (bestLocal) {
          // Skip fuzzy matches to locals that already have an exact match —
          // the merged identity's CRDT data supersedes pre-merge data
          if (matchedLocalIds.has(bestLocal.localId)) {
            this._debug(`fuzzy skip: CRDT ${crdtIdentity.slice(0, 8)} → local ${bestLocalIdentity.slice(0, 8)} (already has exact match)`)
            continue
          }
          this._log(`fuzzy match: CRDT ${crdtIdentity.slice(0, 8)} → local ${bestLocalIdentity.slice(0, 8)} (merged item, ${crdtChecksums.length} shared photo(s))`)
          let crdtItem = snapshot[crdtIdentity]
          let validation = this.backup.validateInbound(crdtIdentity, crdtItem, this._stableUserId)
          if (validation.valid) {
            matched.push({ itemIdentity: crdtIdentity, local: bestLocal })
            matchedLocalIds.add(bestLocal.localId)
          }
        } else {
          this._debug(`no fuzzy match for CRDT item ${crdtIdentity.slice(0, 8)}`)
        }
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
        } catch {}
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
      this._applyingRemote = false
      if (this.adapter) this.adapter.resumeChanges()
      if (this._queuedLocalChange) {
        this._queuedLocalChange = false
        this._debug('replaying queued local change')
        this.handleLocalChange()
      }
    }
    return appliedIdentities
  }

  // P6: Write delay only between items, not between individual fields
  _writeDelay() {
    return new Promise(r => setTimeout(r, this.options.writeDelay))
  }

  /**
   * Detect notes that were applied by troparcel from remote sync.
   * Uses HTML-only detection — survives ProseMirror round-trip and avoids
   * false positives on user notes starting with [brackets].
   * Checks: blockquote format (v4.1+), bold format (v4.0), legacy format (v3).
   */
  _isSyncedNote(text, html) {
    if (!html) return false
    // v4.1+ blockquote format
    if (html.includes('<blockquote><p><em>troparcel:')) return true
    // v4.0 bold format
    if (html.includes('<p><strong>[troparcel:')) return true
    // Legacy v3 check removed — html.includes('<p><strong>[') was too broad
    // and matched user notes like "[Reference 1] According to..."
    return false
  }

  async applyRemoteAnnotations(itemIdentity, local, tagMap, listMap) {
    let localId = local.localId
    let userId = this._stableUserId

    this._debug(`applyAnnotations: item ${localId}, identity ${itemIdentity.slice(0, 8)}...`)

    // Snapshot stats before this item to detect if anything changed
    let s = this._applyStats
    let before = s ? (s.notesCreated + s.notesUpdated + s.tagsAdded +
      s.selectionsCreated + s.metadataUpdated + s.transcriptionsCreated +
      s.listsAdded + s.notesRetracted) : 0

    // Apply metadata (batched — no per-field delay)
    await this.applyMetadata(itemIdentity, localId, userId, local.item)

    // P6: Single delay between major phases
    await this._writeDelay()

    await this.applyTags(itemIdentity, localId, userId, tagMap, local.item)
    await this._writeDelay()

    await this.applyNotes(itemIdentity, local, userId)
    await this._writeDelay()

    if (this.options.syncPhotoAdjustments) {
      await this.applyPhotoMetadata(itemIdentity, local, userId)
      await this._writeDelay()
    }

    await this.applySelections(itemIdentity, local, userId)
    await this._writeDelay()

    await this.applySelectionNotes(itemIdentity, local, userId)
    await this._writeDelay()

    await this.applySelectionMetadata(itemIdentity, local, userId)
    await this._writeDelay()

    await this.applyTranscriptions(itemIdentity, local, userId)

    if (this.options.syncLists) {
      await this._writeDelay()
      await this.applyLists(itemIdentity, local, userId, listMap)
    }

    if (s) {
      s.itemsProcessed++
      let after = s.notesCreated + s.notesUpdated + s.tagsAdded +
        s.selectionsCreated + s.metadataUpdated + s.transcriptionsCreated +
        s.listsAdded + s.notesRetracted
      if (after > before) s.itemsChanged++
    }
  }

  // P6: No per-field delay within metadata apply
  async applyMetadata(itemIdentity, localId, userId, localItem) {
    if (!this.options.syncMetadata) return
    let remoteMeta = schema.getMetadata(this.doc, itemIdentity)
    let batch = {}
    for (let [prop, value] of Object.entries(remoteMeta)) {
      if (value.author === userId) continue

      // Diff: skip if local already has same value
      let localVal = localItem[prop]
      if (localVal != null) {
        let localText = typeof localVal === 'object'
          ? (localVal['@value'] || localVal.text || '')
          : String(localVal)
        if (localText === (value.text || '')) continue
      }

      batch[prop] = { text: value.text, type: value.type }
    }

    let batchKeys = Object.keys(batch)
    if (batchKeys.length > 0) {
      try {
        await this.api.saveMetadata(localId, batch)
        if (this._applyStats) this._applyStats.metadataUpdated += batchKeys.length
        this._debug(`metadata: ${batchKeys.length} field(s) on item ${localId}`)
      } catch (err) {
        this.logger.warn(`Failed to save metadata batch on ${localId}`, {
          error: err.message
        })
      }
    }
  }

  async applyTags(itemIdentity, localId, userId, tagMap, localItem) {
    if (!this.options.syncTags) return

    // Build set of tag names already on this item
    let localTagNames = new Set()
    let localTags = localItem.tag || []
    for (let t of localTags) {
      if (t && t.name) localTagNames.add(t.name)
    }

    let activeTags = schema.getActiveTags(this.doc, itemIdentity)
    for (let tag of activeTags) {
      if (tag.author === userId) continue

      // Diff: skip if item already has this tag
      if (localTagNames.has(tag.name)) continue

      let existing = tagMap.get(tag.name)
      if (!existing) {
        try {
          await this.api.createTag(tag.name, tag.color, [localId])
          localTagNames.add(tag.name)
          if (this._applyStats) this._applyStats.tagsAdded++
          this._debug(`tag created: "${tag.name}" on item ${localId}`)
          continue
        } catch (err) {
          this.logger.warn(`Failed to create tag "${tag.name}"`, { error: err.message })
          continue
        }
      }

      try {
        await this.api.addTagsToItem(localId, [existing.id || existing.tag_id])
        localTagNames.add(tag.name)
        if (this._applyStats) this._applyStats.tagsAdded++
        this._debug(`tag added: "${tag.name}" on item ${localId}`)
      } catch {}
    }

    if (!this.options.syncDeletions) return

    let deletedTags = schema.getDeletedTags(this.doc, itemIdentity)
    for (let tag of deletedTags) {
      if (tag.author === userId) continue

      // Diff: skip if item doesn't have this tag anyway
      if (!localTagNames.has(tag.name)) continue

      let existing = tagMap.get(tag.name)
      if (existing) {
        try {
          await this.api.removeTagsFromItem(localId, [existing.id || existing.tag_id])
        } catch {}
      }
    }
  }

  /**
   * Build a dedup set from existing local notes (text + html with prefix stripping).
   */
  _buildExistingNoteTexts(notes) {
    let set = new Set()
    for (let n of notes) {
      if (n && n.text) {
        set.add(n.text.trim())
        let stripped = n.text
          .replace(/^troparcel:\s*[^\n]*\n?/, '')
          .replace(/^\[(?:troparcel:)?[^\]]{1,80}\]\s*/, '')
          .trim()
        if (stripped) set.add(stripped)
      }
      if (n && n.html) {
        set.add(n.html.trim())
        let strippedHtml = n.html
          .replace(/^<blockquote><p><em>troparcel:[^<]*<\/em><\/p><\/blockquote>/, '')
          .replace(/^<p><strong>\[[^\]]*\]<\/strong><\/p>/, '')
          .trim()
        if (strippedHtml) set.add(strippedHtml)
      }
    }
    return set
  }

  /**
   * Apply a single remote note: sanitize, dedup, update-or-create.
   * Shared by applyNotes and applySelectionNotes.
   *
   * @param {string} noteKey - vault key for this note
   * @param {Object} note - remote note data
   * @param {Object} parent - { photo, selection } — which parent to attach to
   * @param {Set} existingTexts - dedup set (mutated on create)
   * @param {string} userId - local user ID
   * @param {string} label - label for log messages (e.g. "note" or "sel note")
   * @returns {boolean} true if note was created/updated, false if skipped
   */
  async _applyRemoteNote(noteKey, note, parent, existingTexts, userId, label) {
    let safeHtml = note.html
      ? sanitizeHtml(note.html)
      : `<p>${escapeHtml(note.text)}</p>`

    let authorLabel = escapeHtml(note.author || 'unknown')
    safeHtml = `<blockquote><p><em>troparcel: ${authorLabel}</em></p></blockquote>${safeHtml}`

    // Content-based dedup
    let plainText = (note.text || '').trim()
    if ((plainText && existingTexts.has(plainText)) ||
        existingTexts.has(safeHtml.trim())) {
      this.vault.appliedNoteKeys.add(noteKey)
      if (this._applyStats) this._applyStats.notesDeduped++
      return false
    }

    // C1: Check if we've already applied this note (update instead of re-create)
    let existingLocalId = this.vault.getLocalNoteId(noteKey)
    if (existingLocalId) {
      try {
        if (this.adapter) {
          let result = await this.adapter.updateNote(existingLocalId, { html: safeHtml })
          this.vault.appliedNoteKeys.add(noteKey)
          if (result && (result.id || result['@id'])) {
            this.vault.mapAppliedNote(noteKey, result.id || result['@id'])
          }
        } else {
          await this.api.updateNote(existingLocalId, { html: safeHtml })
          this.vault.appliedNoteKeys.add(noteKey)
        }
        if (this._applyStats) this._applyStats.notesUpdated++
        this._debug(`${label} updated: ${noteKey.slice(0, 8)}`)
        return true
      } catch {
        // Note might have been deleted locally — fall through to create
      }
    }

    try {
      let created
      let payload = {
        html: safeHtml,
        language: note.language,
        photo: parent.photo || null,
        selection: parent.selection || null
      }
      if (this.adapter) {
        created = await this.adapter.createNote(payload)
      } else {
        created = await this.api.createNote(payload)
      }
      if (created && (created.id || created['@id'])) {
        this.vault.appliedNoteKeys.add(noteKey)
        this.vault.mapAppliedNote(noteKey, created.id || created['@id'])
        if (plainText) existingTexts.add(plainText)
        existingTexts.add(safeHtml.trim())
        if (this._applyStats) this._applyStats.notesCreated++
        this._debug(`${label} created: ${noteKey.slice(0, 8)} by ${note.author}`)
        return true
      } else {
        this.logger.warn({ ...parent, noteKey: noteKey.slice(0, 8), author: note.author },
          `${label}.create returned null`)
      }
    } catch (err) {
      this.logger.warn(`Failed to create ${label}`, {
        error: err.message, ...parent, noteKey: noteKey.slice(0, 8)
      })
    }
    return false
  }

  // C1: Stores vault mapping when applying remote notes
  async applyNotes(itemIdentity, local, userId) {
    if (!this.options.syncNotes) return
    let localId = local.localId

    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    // Build index of existing local notes for content-based dedup
    let allLocalNotes = []
    for (let p of photos) {
      for (let n of (p.note || [])) allLocalNotes.push(n)
    }
    let existingNoteTexts = this._buildExistingNoteTexts(allLocalNotes)

    // Also process tombstoned notes to update previously-applied notes as retracted
    let allNotes = schema.getNotes(this.doc, itemIdentity)
    let remoteNotes = {}
    let tombstonedNotes = {}
    for (let [key, val] of Object.entries(allNotes)) {
      if (val.deleted) {
        tombstonedNotes[key] = val
      } else {
        remoteNotes[key] = val
      }
    }

    for (let [noteKey, note] of Object.entries(remoteNotes)) {
      if (note.author === userId) continue
      if (!note.html && !note.text) continue
      if (this.vault.appliedNoteKeys.has(noteKey)) continue

      // Find the right photo by checksum
      let photoId = null
      if (note.photo) {
        for (let p of photos) {
          if (p.checksum === note.photo) {
            photoId = p['@id'] || p.id
            break
          }
        }
      }
      // Fallback to first photo only if no checksum specified
      if (!photoId && !note.photo) {
        photoId = photos[0] && (photos[0]['@id'] || photos[0].id)
      }
      if (!photoId) continue

      await this._applyRemoteNote(
        noteKey, note,
        { photo: Number(photoId) || null },
        existingNoteTexts, userId, 'note'
      )
    }

    // Handle tombstoned notes: update previously-applied notes to show retracted style
    for (let [noteKey, note] of Object.entries(tombstonedNotes)) {
      if (note.author === userId) continue
      let existingLocalId = this.vault.getLocalNoteId(noteKey)
      if (!existingLocalId) continue

      let authorLabel = escapeHtml(note.author || 'unknown')
      let retractedHtml = `<blockquote><p><em>troparcel: ${authorLabel} [retracted]</em></p></blockquote>`

      try {
        if (this.adapter) {
          await this.adapter.updateNote(existingLocalId, { html: retractedHtml })
        }
        this.vault.appliedNoteKeys.add(noteKey)
        if (this._applyStats) this._applyStats.notesRetracted++
        this._debug(`note retracted: ${noteKey.slice(0, 8)} by ${note.author}`)
      } catch {
        // Note may have been deleted locally
      }
    }
  }

  async applyPhotoMetadata(itemIdentity, local, userId) {
    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let photo of photos) {
      let checksum = photo.checksum
      let localPhotoId = photo['@id'] || photo.id
      if (!checksum || !localPhotoId) continue

      let remoteMeta = schema.getPhotoMetadata(this.doc, itemIdentity, checksum)
      let localMeta = photo.metadata || {}

      // P6: Batch metadata writes per photo
      let batch = {}
      for (let [prop, value] of Object.entries(remoteMeta)) {
        if (value.author === userId) continue

        // Diff: skip if local already has same value
        let localVal = localMeta[prop]
        if (localVal != null) {
          let localText = typeof localVal === 'object'
            ? (localVal['@value'] || localVal.text || '')
            : String(localVal)
          if (localText === (value.text || '')) continue
        }

        batch[prop] = { text: value.text, type: value.type }
      }

      let photoBatchKeys = Object.keys(batch)
      if (photoBatchKeys.length > 0) {
        try {
          await this.api.saveMetadata(localPhotoId, batch)
          if (this._applyStats) this._applyStats.metadataUpdated += photoBatchKeys.length
        } catch (err) {
          this.logger.warn(`Failed to save photo metadata batch`, { error: err.message })
        }
      }
    }
  }

  async applySelections(itemIdentity, local, userId) {
    let remoteSelections = schema.getActiveSelections(this.doc, itemIdentity)

    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let [selKey, sel] of Object.entries(remoteSelections)) {
      if (sel.author === userId) continue
      if (this.vault.appliedSelectionKeys.has(selKey)) continue

      let x = Number(sel.x)
      let y = Number(sel.y)
      let w = Number(sel.w)
      let h = Number(sel.h)
      if (!Number.isFinite(x) || !Number.isFinite(y) ||
          !Number.isFinite(w) || !Number.isFinite(h) ||
          w <= 0 || h <= 0) {
        this._log(`Skipping selection ${selKey}: invalid coordinates`, { x, y, w, h })
        continue
      }

      let localPhotoId = null
      for (let p of photos) {
        if (p.checksum === sel.photo) {
          localPhotoId = p['@id'] || p.id
          break
        }
      }
      if (!localPhotoId) continue

      let alreadyExists = false
      for (let p of photos) {
        if (p.checksum !== sel.photo) continue
        let localSels = p.selection || []
        if (!Array.isArray(localSels)) localSels = [localSels]
        for (let ls of localSels) {
          if (!ls) continue
          let localSelKey = identity.computeSelectionKey(p.checksum, ls)
          if (localSelKey === selKey) {
            alreadyExists = true
            break
          }
        }
      }

      if (!alreadyExists) {
        try {
          if (this.adapter) {
            await this.adapter.createSelection({
              photo: Number(localPhotoId),
              x,
              y,
              width: w,
              height: h,
              angle: sel.angle || 0
            })
          } else {
            await this.api.createSelection({
              photo: Number(localPhotoId),
              x,
              y,
              width: w,
              height: h,
              angle: sel.angle || 0
            })
          }
          this.vault.appliedSelectionKeys.add(selKey)
          if (this._applyStats) this._applyStats.selectionsCreated++
          this._debug(`selection created: ${selKey.slice(0, 8)} on photo ${localPhotoId}`)
        } catch (err) {
          this.logger.warn(`Failed to create selection on photo ${localPhotoId}`, {
            error: err.message
          })
          this.vault.appliedSelectionKeys.add(selKey)
        }
      } else {
        this.vault.appliedSelectionKeys.add(selKey)
      }
    }
  }

  async applySelectionNotes(itemIdentity, local, userId) {
    if (!this.options.syncNotes) return
    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let photo of photos) {
      let checksum = photo.checksum
      if (!checksum) continue

      let localSels = photo.selection || []
      if (!Array.isArray(localSels)) localSels = [localSels]

      for (let sel of localSels) {
        if (!sel) continue

        let existingTexts = this._buildExistingNoteTexts(sel.note || [])

        let selKey = identity.computeSelectionKey(checksum, sel)
        let remoteNotes = schema.getSelectionNotes(this.doc, itemIdentity, selKey)

        for (let [compositeKey, note] of Object.entries(remoteNotes)) {
          if (note.author === userId) continue
          if (!note.html && !note.text) continue
          if (this.vault.appliedNoteKeys.has(compositeKey)) continue

          let localSelId = sel['@id'] || sel.id
          if (!localSelId) continue

          await this._applyRemoteNote(
            compositeKey, note,
            { selection: Number(localSelId) || null },
            existingTexts, userId, 'sel note'
          )
        }
      }
    }
  }

  async applySelectionMetadata(itemIdentity, local, userId) {
    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let photo of photos) {
      let checksum = photo.checksum
      if (!checksum) continue

      let localSels = photo.selection || []
      if (!Array.isArray(localSels)) localSels = [localSels]

      for (let sel of localSels) {
        if (!sel) continue
        let selKey = identity.computeSelectionKey(checksum, sel)
        let localSelId = sel['@id'] || sel.id
        if (!localSelId) continue

        let remoteMeta = schema.getSelectionMeta(this.doc, itemIdentity, selKey)
        let localMeta = sel.metadata || {}

        // P6: Batch writes
        let batch = {}
        for (let [prop, value] of Object.entries(remoteMeta)) {
          if (value.author === userId) continue

          // Diff: skip if local already has same value
          let localVal = localMeta[prop]
          if (localVal != null) {
            let localText = typeof localVal === 'object'
              ? (localVal['@value'] || localVal.text || '')
              : String(localVal)
            if (localText === (value.text || '')) continue
          }

          batch[prop] = { text: value.text, type: value.type }
        }

        let selBatchKeys = Object.keys(batch)
        if (selBatchKeys.length > 0) {
          try {
            await this.api.saveMetadata(localSelId, batch)
            if (this._applyStats) this._applyStats.metadataUpdated += selBatchKeys.length
          } catch (err) {
            this.logger.warn(`Failed to save selection metadata`, { error: err.message })
          }
        }
      }
    }
  }

  // C3: Stores vault mapping when applying remote transcriptions
  async applyTranscriptions(itemIdentity, local, userId) {
    let remoteTranscriptions = schema.getActiveTranscriptions(this.doc, itemIdentity)

    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let [txKey, tx] of Object.entries(remoteTranscriptions)) {
      if (tx.author === userId) continue
      if (!tx.text && !tx.data) continue
      if (this.vault.appliedTranscriptionKeys.has(txKey)) continue

      let localPhotoId = null
      for (let p of photos) {
        if (p.checksum === tx.photo) {
          localPhotoId = p['@id'] || p.id
          break
        }
      }
      if (!localPhotoId) continue

      let localSelId = null
      if (tx.selection) {
        for (let p of photos) {
          if (p.checksum !== tx.photo) continue
          let sels = p.selection || []
          if (!Array.isArray(sels)) sels = [sels]
          for (let s of sels) {
            if (!s) continue
            let sk = identity.computeSelectionKey(p.checksum, s)
            if (sk === tx.selection) {
              localSelId = s['@id'] || s.id
              break
            }
          }
        }
      }

      // C3: Check for existing mapping (update vs create)
      // Note: HTTP PUT for transcriptions returns 404 (no route).
      // With adapter unavailable, fall through to delete + recreate.
      let existingLocalId = this.vault.getLocalTxId(txKey)
      if (existingLocalId) {
        try {
          // Delete old, recreate with new content (update not supported via HTTP)
          try { await this.api.deleteTranscription(existingLocalId) } catch {}
          let created = await this.api.createTranscription({
            text: tx.text,
            data: tx.data,
            photo: Number(localPhotoId) || null,
            selection: localSelId ? Number(localSelId) : null
          })
          this.vault.appliedTranscriptionKeys.add(txKey)
          if (created && (created.id || created['@id'])) {
            this.vault.mapAppliedTranscription(txKey, created.id || created['@id'])
          }
          continue
        } catch {}
      }

      try {
        let created = await this.api.createTranscription({
          text: tx.text,
          data: tx.data,
          photo: Number(localPhotoId) || null,
          selection: localSelId ? Number(localSelId) : null
        })
        this.vault.appliedTranscriptionKeys.add(txKey)
        if (created && (created.id || created['@id'])) {
          this.vault.mapAppliedTranscription(txKey, created.id || created['@id'])
          if (this._applyStats) this._applyStats.transcriptionsCreated++
          this._debug(`transcription created: ${txKey.slice(0, 8)} by ${tx.author}`)
        }
      } catch (err) {
        this.logger.warn(`Failed to create transcription`, {
          error: err.message
        })
        this.vault.appliedTranscriptionKeys.add(txKey)
      }
    }
  }

  // C2: Matches lists by name for cross-instance compatibility
  async applyLists(itemIdentity, local, userId, listMap) {
    let remoteLists = schema.getActiveLists(this.doc, itemIdentity)
    let localId = local.localId

    // I5: Build set of lists this item already belongs to
    let localListNames = new Set()
    for (let listId of (local.item.lists || [])) {
      let name = this._listNameCache.get(listId) || this._listNameCache.get(String(listId))
      if (name) localListNames.add(name)
    }

    for (let [listKey, list] of Object.entries(remoteLists)) {
      if (list.author === userId) continue
      if (localListNames.has(listKey)) continue  // Already in list

      // C2: Match by name
      let localList = listMap.get(listKey)
      if (localList) {
        try {
          if (this.adapter) {
            await this.adapter.addItemsToList(localList.id, [localId])
          } else {
            await this.api.addItemsToList(localList.id, [localId])
          }
          localListNames.add(listKey)
          if (this._applyStats) this._applyStats.listsAdded++
          this._debug(`list add: item ${localId} → "${listKey}"`)
        } catch {}
      }
    }

    if (this.options.syncDeletions) {
      let allLists = schema.getLists(this.doc, itemIdentity)
      for (let [listKey, list] of Object.entries(allLists)) {
        if (!list.deleted) continue
        if (list.author === userId) continue

        let localList = listMap.get(listKey)
        if (localList) {
          try {
            if (this.adapter) {
              await this.adapter.removeItemsFromList(localList.id, [localId])
            } else {
              await this.api.removeItemsFromList(localList.id, [localId])
            }
          } catch {}
        }
      }
    }
  }

  // --- Import (review mode) ---

  async applyOnDemand() {
    if (!this.doc) return null

    let snapshot = schema.getSnapshot(this.doc)
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
      } catch {}
    }

    for (let [itemIdentity, item] of Object.entries(snapshot)) {
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
    for (let [itemIdentity] of Object.entries(snapshot)) {
      let local = identity.findLocalMatch(itemIdentity, this.localIndex)
      if (!local) continue

      // S3: Validate before applying
      let validation = this.backup.validateInbound(itemIdentity, snapshot[itemIdentity], this._stableUserId)
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
      } catch {}
    }
    if (backupItems.length > 0 && this.vault.shouldBackup(backupItems)) {
      await this.backup.saveSnapshot(backupItems)
    }

    this._applyingRemote = true
    if (this.adapter) this.adapter.suppressChanges()
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
      this._applyingRemote = false
      if (this.adapter) this.adapter.resumeChanges()
    }

    return { applied, summary }
  }

  // --- Manual push (export hook) ---

  pushItems(items) {
    if (!this.doc) return

    let userId = this._stableUserId

    this.doc.transact(() => {
      for (let item of items) {
        let id = identity.computeIdentity(item)
        if (!id) continue
        let checksumMap = identity.buildPhotoChecksumMap(item)
        this.pushMetadata(item, id, userId)
        this.pushTags(item, id, userId)
        this.pushNotes(item, id, userId, checksumMap)
        this.pushPhotoMetadata(item, id, userId)
        this.pushSelections(item, id, userId, checksumMap)
        this.pushTranscriptions(item, id, userId, checksumMap)
        if (this.options.syncLists) {
          this.pushLists(item, id, userId)
        }
      }
    }, this.LOCAL_ORIGIN)
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

module.exports = { SyncEngine }
