'use strict'

const fs = require('fs')
const Y = require('yjs')
const { WebsocketProvider } = require('y-websocket')
const WS = require('ws')
const { ApiClient } = require('./api-client')
const identity = require('./identity')
const schema = require('./crdt-schema')
const { BackupManager } = require('./backup')
const { sanitizeHtml, escapeHtml } = require('./sanitize')

/**
 * Sync Engine v3 — watch-based sync with full API parity.
 *
 * Replaces the v2 polling loop with event-driven sync:
 *   - Local → CRDT: fs.watch() on the .tpy file, debounced
 *   - CRDT → Local: observer-driven, applied immediately (debounced)
 *   - Safety-net poll at configurable interval (default 120s)
 *
 * Syncs all data types: metadata, tags, notes, photos, selections,
 * selection metadata/notes, transcriptions, and lists.
 */
class SyncEngine {
  constructor(options, logger) {
    this.options = options
    this.logger = logger
    this.debug = options.debug === true

    this.doc = null
    this.provider = null
    this.api = new ApiClient(options.apiPort, logger)
    this.backup = null

    this.localIndex = new Map()
    this.previousSnapshot = new Map()  // identity → last-known state for deletion detection
    this.safetyNetTimer = null
    this.heartbeatTimer = null
    this.unsubscribe = null
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

    // Applied tracking to prevent duplication
    this.appliedNoteKeys = new Set()
    this.appliedSelectionKeys = new Set()
    this.appliedTranscriptionKeys = new Set()

    // Suppress file watcher during apply phase
    this._applyingRemote = false

    // Transaction origin marker
    this.LOCAL_ORIGIN = 'troparcel-local'
  }

  _log(msg, data) {
    if (this.debug) {
      this.logger.info(`[troparcel] ${msg}`, data)
    }
  }

  // --- Lifecycle ---

  async start() {
    if (this.state === 'connected' || this.state === 'connecting') return

    this.state = 'connecting'
    this.logger.info('Sync engine v3 starting', {
      server: this.options.serverUrl,
      room: this.options.room,
      syncMode: this.options.syncMode
    })

    try {
      this.doc = new Y.Doc()
      schema.registerUser(this.doc, this.doc.clientID, this.options.userId)

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
          WebSocketPolyfill: WS
        }
      )

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
      this.logger.info('Sync engine connected', {
        clientId: this.doc.clientID,
        room: this.options.room
      })

      // Wait for Tropy startup (FTS optimize, migrations, etc.)
      let startupDelay = this.options.startupDelay
      if (startupDelay > 0) {
        await new Promise(r => setTimeout(r, startupDelay))
      }

      // Initial full sync
      await this.syncOnce()

      // Start file watching
      if (this.options.autoSync) {
        await this.startWatching()
      }

      // Safety-net periodic poll
      let safetyInterval = this.options.safetyNetInterval * 1000
      if (safetyInterval > 0) {
        this.safetyNetTimer = setInterval(() => {
          this.syncOnce()
        }, safetyInterval)
      }

      // Heartbeat
      this.heartbeatTimer = setInterval(() => {
        schema.heartbeat(this.doc, this.doc.clientID)
      }, 30000)

    } catch (err) {
      this.state = 'error'
      this.logger.error('Sync engine failed to start', { error: err.message })
      throw err
    }
  }

  stop() {
    this.logger.info('Sync engine stopping')

    this.stopWatching()

    if (this.safetyNetTimer) {
      clearInterval(this.safetyNetTimer)
      this.safetyNetTimer = null
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
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
        this.logger.debug('Failed to deregister user', { error: err.message })
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
    this.appliedNoteKeys.clear()
    this.appliedSelectionKeys.clear()
    this.appliedTranscriptionKeys.clear()
    this._applyingRemote = false
    this.state = 'idle'
  }

  waitForConnection() {
    return new Promise((resolve, reject) => {
      let timeout = setTimeout(() => {
        reject(new Error('Connection timeout (15s)'))
      }, 15000)

      if (this.provider.wsconnected) {
        clearTimeout(timeout)
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

  // --- File watching ---

  async startWatching() {
    if (this.fileWatcher) return

    // Get project path from API
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

    try {
      this.fileWatcher = fs.watch(this.projectPath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          this.handleLocalChange()
        }
      })

      this.fileWatcher.on('error', (err) => {
        this.logger.debug('File watcher error', { error: err.message })
        // Don't crash — safety-net poll still runs
      })
    } catch (err) {
      this.logger.debug('Could not start file watcher', { error: err.message })
    }
  }

  stopWatching() {
    if (this.fileWatcher) {
      this.fileWatcher.close()
      this.fileWatcher = null
    }
  }

  /**
   * Debounced handler for local file changes.
   */
  handleLocalChange() {
    if (this._paused) return
    if (this._applyingRemote) return  // Ignore DB writes caused by our own apply

    if (this._localDebounceTimer) {
      clearTimeout(this._localDebounceTimer)
    }

    this._localDebounceTimer = setTimeout(() => {
      this._localDebounceTimer = null
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

    // If localIndex hasn't been built yet (syncOnce hasn't completed),
    // keep pending identities queued — don't consume and drop them
    if (this.localIndex.size === 0) {
      this._log('applyPendingRemote: localIndex empty, deferring')
      return
    }

    let identities = Array.from(this._pendingRemoteIdentities)
    this._pendingRemoteIdentities.clear()

    // Fetch tags once
    let allTags = null
    try {
      allTags = await this.api.getTags()
    } catch {}
    let tagMap = new Map()
    if (allTags && Array.isArray(allTags)) {
      for (let t of allTags) tagMap.set(t.name, t)
    }

    // Fetch lists once
    let allLists = null
    let listMap = new Map()
    if (this.options.syncLists) {
      try {
        allLists = await this.api.getLists()
        if (Array.isArray(allLists)) {
          for (let l of allLists) listMap.set(l.name, l)
        }
      } catch {}
    }

    // Suppress file watcher during apply
    this._applyingRemote = true

    try {
      for (let itemIdentity of identities) {
        let local = identity.findLocalMatch(itemIdentity, this.localIndex)
        if (!local) continue

        try {
          await this.applyRemoteAnnotations(itemIdentity, local, tagMap, listMap)
        } catch (err) {
          this.logger.debug(`Failed to apply remote for ${itemIdentity}`, {
            error: err.message
          })
        }
      }
    } finally {
      this._applyingRemote = false
    }
  }

  // --- Core sync cycle ---

  async syncOnce() {
    if (this.state !== 'connected') return
    if (!this.doc) return
    if (this._syncing) return
    if (this._paused) return

    this._syncing = true
    let prev = this.state
    this.state = 'syncing'

    try {
      this._log('syncOnce: starting cycle')

      let alive = await this.api.ping()
      if (!alive) {
        this._log('syncOnce: API not reachable, skipping')
        this.state = prev
        return
      }

      let summaries = await this.api.getItems()
      if (!summaries || !Array.isArray(summaries)) {
        this._log('syncOnce: no items from API')
        this.state = prev
        return
      }
      this._log(`syncOnce: got ${summaries.length} item summaries`)

      let items = []
      for (let summary of summaries) {
        try {
          let enriched = await this.enrichItem(summary)
          items.push(enriched)
        } catch (err) {
          this.logger.debug(`Failed to enrich item ${summary.id}`, {
            error: err.message
          })
        }
      }

      this.localIndex = identity.buildIdentityIndex(items)
      this._log(`syncOnce: identity index built`, {
        items: items.length,
        identities: this.localIndex.size
      })

      await this.pushLocal(items)

      // Apply remote if in auto mode
      if (this.options.syncMode === 'auto') {
        await this.applyRemoteFromCRDT()
      }

      this.lastSync = new Date()
      this._consecutiveErrors = 0
      this.state = 'connected'
      this._log('syncOnce: cycle complete')

    } catch (err) {
      this._consecutiveErrors++
      let isBusy = err.sqliteBusy || (err.message && err.message.includes('SQLITE_BUSY'))

      if (isBusy) {
        this.logger.warn('Database busy, will back off', {
          consecutiveErrors: this._consecutiveErrors
        })
      } else {
        this.logger.warn('Sync cycle failed', { error: err.message })
      }

      this.state = prev === 'connected' ? 'connected' : 'error'
    } finally {
      this._syncing = false
    }
  }

  // --- Enrichment ---

  async enrichItem(summary) {
    let enriched = {
      '@id': summary.id,
      template: summary.template,
      lists: summary.lists || []
    }

    // Fetch item metadata
    try {
      let meta = await this.api.getMetadata(summary.id)
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
    } catch (err) {
      this.logger.debug(`enrichItem: metadata fetch failed for ${summary.id}`, {
        error: err.message
      })
    }

    // Fetch photos with checksums, notes, selections, metadata
    enriched.photo = []
    let photoIds = summary.photos || []
    for (let photoId of photoIds) {
      try {
        let photo = await this.api.getPhoto(photoId)
        if (!photo) continue

        let enrichedPhoto = {
          '@id': photo.id,
          checksum: photo.checksum,
          note: [],
          selection: [],
          transcription: [],
          metadata: null
        }

        // Fetch photo metadata
        if (this.options.syncPhotoAdjustments) {
          try {
            enrichedPhoto.metadata = await this.api.getMetadata(photoId)
          } catch {}
        }

        // Fetch notes for this photo
        let noteIds = photo.notes || []
        for (let noteId of noteIds) {
          try {
            let note = await this.api.getNote(noteId, 'json')
            let html = ''
            try { html = await this.api.getNote(noteId, 'html') } catch {}
            if (note) {
              enrichedPhoto.note.push({
                '@id': note.id,
                text: note.text || '',
                html: typeof html === 'string' ? html : '',
                language: note.language || null,
                photo: note.photo
              })
            }
          } catch (err) {
            this.logger.debug(`enrichItem: note ${noteId} fetch failed`, {
              error: err.message
            })
          }
        }

        // Fetch selections
        let selectionIds = photo.selections || []
        for (let selId of selectionIds) {
          try {
            let sel = await this.api.getSelection(selId)
            if (!sel) continue

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

            // Selection metadata
            try {
              enrichedSel.metadata = await this.api.getMetadata(selId)
            } catch {}

            // Selection notes
            let selNoteIds = sel.notes || []
            for (let noteId of selNoteIds) {
              try {
                let note = await this.api.getNote(noteId, 'json')
                let html = ''
                try { html = await this.api.getNote(noteId, 'html') } catch {}
                if (note) {
                  enrichedSel.note.push({
                    '@id': note.id,
                    text: note.text || '',
                    html: typeof html === 'string' ? html : '',
                    language: note.language || null,
                    selection: note.selection
                  })
                }
              } catch {}
            }

            // Selection transcriptions
            let selTxIds = sel.transcriptions || []
            for (let txId of selTxIds) {
              try {
                let tx = await this.api.getTranscription(txId, 'json')
                if (tx) enrichedSel.transcription.push(tx)
              } catch {}
            }

            enrichedPhoto.selection.push(enrichedSel)
          } catch {}
        }

        // Photo transcriptions
        let txIds = photo.transcriptions || []
        for (let txId of txIds) {
          try {
            let tx = await this.api.getTranscription(txId, 'json')
            if (tx) enrichedPhoto.transcription.push(tx)
          } catch {}
        }

        enriched.photo.push(enrichedPhoto)
      } catch (err) {
        this.logger.debug(`enrichItem: photo ${photoId} fetch failed`, {
          error: err.message
        })
      }
    }

    // Fetch tags
    try {
      let tags = await this.api.getItemTags(summary.id)
      if (tags && Array.isArray(tags)) {
        enriched.tag = tags.map(t => ({
          id: t.id || t.tag_id,
          name: t.name,
          color: t.color || null
        }))
      }
    } catch (err) {
      this.logger.debug(`enrichItem: tags fetch failed for ${summary.id}`, {
        error: err.message
      })
    }

    return enriched
  }

  // --- Push local → CRDT ---

  async pushLocal(items) {
    let userId = this.options.userId || `user-${this.doc.clientID}`

    for (let item of items) {
      let id = identity.computeIdentity(item)
      if (!id) continue

      try {
        this.doc.transact(() => {
          this.pushMetadata(item, id, userId)
          this.pushTags(item, id, userId)
          this.pushNotes(item, id, userId)
          this.pushPhotoMetadata(item, id, userId)
          this.pushSelections(item, id, userId)
          this.pushTranscriptions(item, id, userId)
          if (this.options.syncLists) {
            this.pushLists(item, id, userId)
          }

          // Detect deletions by diffing against previous snapshot
          this.pushDeletions(item, id, userId)
        }, this.LOCAL_ORIGIN)

        // Save current state as snapshot for next diff
        this.saveItemSnapshot(item, id)
      } catch (err) {
        this.logger.debug(`Failed to push item ${id}`, { error: err.message })
      }
    }
  }

  pushMetadata(item, itemIdentity, userId) {
    let existing = schema.getMetadata(this.doc, itemIdentity)

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
      if (current && current.text === text && current.type === type) continue

      schema.setMetadata(this.doc, itemIdentity, key, { text, type, language }, userId)
    }
  }

  pushTags(item, itemIdentity, userId) {
    let tags = item.tag || item['https://tropy.org/v1/tropy#tag'] || []
    if (!Array.isArray(tags)) tags = [tags]

    for (let tag of tags) {
      let name = typeof tag === 'string' ? tag : (tag.name || tag['@value'] || '')
      let color = typeof tag === 'object' ? tag.color : null

      if (name) {
        schema.setTag(this.doc, itemIdentity, { name, color }, userId)
      }
    }
  }

  pushNotes(item, itemIdentity, userId) {
    let photos = item.photo || item['https://tropy.org/v1/tropy#photo'] || []
    if (!Array.isArray(photos)) photos = [photos]

    let checksumMap = identity.buildPhotoChecksumMap(item)

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

        if (text || html) {
          let noteKey = identity.computeNoteKey(
            { text, html, photo: photo['@id'] || photo.id },
            photoChecksum
          )

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

        for (let note of selNotes) {
          if (!note) continue
          let text = note['@value'] || note.text || ''
          let html = note.html || ''
          if (typeof text === 'object') text = text['@value'] || ''
          if (typeof html === 'object') html = html['@value'] || ''

          if (text || html) {
            let noteKey = identity.computeNoteKey(
              { text, html, selection: sel['@id'] || sel.id },
              photoChecksum
            )

            schema.setSelectionNote(this.doc, itemIdentity, selKey, noteKey, {
              text,
              html,
              language: note.language || null
            }, userId)
          }
        }
      }
    }
  }

  pushPhotoMetadata(item, itemIdentity, userId) {
    if (!this.options.syncPhotoAdjustments) return

    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let photo of photos) {
      let checksum = photo.checksum
      if (!checksum || !photo.metadata) continue

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

        let existing = schema.getPhotoMetadata(this.doc, itemIdentity, checksum)
        if (existing[key] && existing[key].text === text) continue

        schema.setPhotoMetadata(this.doc, itemIdentity, checksum, key, { text, type }, userId)
      }
    }
  }

  pushSelections(item, itemIdentity, userId) {
    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    let checksumMap = identity.buildPhotoChecksumMap(item)

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      if (!photoChecksum) continue

      let selections = photo.selection || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        if (!sel) continue

        let selKey = identity.computeSelectionKey(photoChecksum, sel)

        schema.setSelection(this.doc, itemIdentity, selKey, {
          x: sel.x,
          y: sel.y,
          width: sel.width,
          height: sel.height,
          angle: sel.angle || 0,
          photo: photoChecksum
        }, userId)

        // Selection metadata
        if (sel.metadata) {
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

            schema.setSelectionMeta(this.doc, itemIdentity, selKey, key, { text, type }, userId)
          }
        }
      }
    }
  }

  pushTranscriptions(item, itemIdentity, userId) {
    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    let checksumMap = identity.buildPhotoChecksumMap(item)

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      if (!photoChecksum) continue

      // Photo-level transcriptions
      let txs = photo.transcription || []
      if (!Array.isArray(txs)) txs = [txs]

      txs.forEach((tx, idx) => {
        if (!tx) return
        let txKey = identity.computeTranscriptionKey(photoChecksum, idx)
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
          let txKey = identity.computeTranscriptionKey(photoChecksum, idx, selKey)
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

  pushLists(item, itemIdentity, userId) {
    let listIds = item.lists || []
    if (!Array.isArray(listIds)) return

    // We store list membership by name, but API gives us IDs.
    // For now we use the ID as key — the apply side resolves names.
    for (let listId of listIds) {
      schema.setListMembership(this.doc, itemIdentity, String(listId), userId)
    }
  }

  // --- Deletion detection ---

  saveItemSnapshot(item, itemIdentity) {
    let tags = (item.tag || []).map(t =>
      typeof t === 'string' ? t : (t.name || '')
    ).filter(Boolean)

    let noteKeys = new Set()
    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]
    let checksumMap = identity.buildPhotoChecksumMap(item)

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      let notes = photo.note || []
      if (!Array.isArray(notes)) notes = [notes]

      for (let note of notes) {
        if (!note) continue
        let text = note['@value'] || note.text || ''
        let html = note.html || ''
        if (typeof text === 'object') text = text['@value'] || ''
        if (typeof html === 'object') html = html['@value'] || ''
        if (text || html) {
          let key = identity.computeNoteKey(
            { text, html, photo: photo['@id'] || photo.id },
            photoChecksum
          )
          noteKeys.add(key)
        }
      }
    }

    this.previousSnapshot.set(itemIdentity, { tags, noteKeys })
  }

  pushDeletions(item, itemIdentity, userId) {
    let prev = this.previousSnapshot.get(itemIdentity)
    if (!prev) return  // First sync for this item, no previous to diff

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

    // Detect removed notes
    let currentNoteKeys = new Set()
    let photos = item.photo || []
    if (!Array.isArray(photos)) photos = [photos]
    let checksumMap = identity.buildPhotoChecksumMap(item)

    for (let photo of photos) {
      let photoChecksum = photo.checksum || checksumMap.get(photo['@id'] || photo.id)
      let notes = photo.note || []
      if (!Array.isArray(notes)) notes = [notes]

      for (let note of notes) {
        if (!note) continue
        let text = note['@value'] || note.text || ''
        let html = note.html || ''
        if (typeof text === 'object') text = text['@value'] || ''
        if (typeof html === 'object') html = html['@value'] || ''
        if (text || html) {
          let key = identity.computeNoteKey(
            { text, html, photo: photo['@id'] || photo.id },
            photoChecksum
          )
          currentNoteKeys.add(key)
        }
      }
    }

    for (let noteKey of prev.noteKeys) {
      if (!currentNoteKeys.has(noteKey)) {
        schema.removeNote(this.doc, itemIdentity, noteKey, userId)
      }
    }
  }

  // --- Apply remote → local ---

  async applyRemoteFromCRDT() {
    let snapshot = schema.getSnapshot(this.doc)
    let identities = Object.keys(snapshot)
    if (identities.length === 0) {
      this._log('applyRemote: CRDT snapshot is empty')
      return
    }

    this._log(`applyRemote: scanning ${identities.length} CRDT items`)

    let allTags = await this.api.getTags()
    let tagMap = new Map()
    if (allTags && Array.isArray(allTags)) {
      for (let t of allTags) tagMap.set(t.name, t)
    }

    let listMap = new Map()
    if (this.options.syncLists) {
      try {
        let allLists = await this.api.getLists()
        if (Array.isArray(allLists)) {
          for (let l of allLists) listMap.set(l.name || String(l.id), l)
        }
      } catch {}
    }

    // Suppress file watcher during apply to prevent feedback loops —
    // our own DB writes should not trigger another sync cycle
    this._applyingRemote = true

    let applied = 0
    try {
      for (let itemIdentity of identities) {
        let local = identity.findLocalMatch(itemIdentity, this.localIndex)
        if (!local) continue

        // Validate inbound data
        let crdtItem = snapshot[itemIdentity]
        let validation = this.backup.validateInbound(itemIdentity, crdtItem)
        if (!validation.valid) {
          for (let warn of validation.warnings) {
            this.logger.warn(`Validation warning for ${itemIdentity.slice(0, 8)}: ${warn}`)
          }
          // Still apply — warnings are non-fatal, just logged
        }

        // Take backup snapshot before applying
        try {
          let itemState = await this.backup.captureItemState(local.localId, itemIdentity)
          this.backup.saveSnapshot([itemState])
        } catch (err) {
          this.logger.debug('Backup snapshot failed', { error: err.message })
        }

        try {
          await this.applyRemoteAnnotations(itemIdentity, local, tagMap, listMap)
          applied++
        } catch (err) {
          this.logger.debug(`Failed to apply remote for ${itemIdentity}`, {
            error: err.message
          })
        }
      }
    } finally {
      this._applyingRemote = false
    }
    this._log(`applyRemote: processed ${applied} matched items`)
  }

  _writeDelay() {
    return new Promise(r => setTimeout(r, this.options.writeDelay))
  }

  async applyRemoteAnnotations(itemIdentity, local, tagMap, listMap) {
    let localId = local.localId
    let userId = this.options.userId || `user-${this.doc.clientID}`

    this._log(`applyAnnotations: item ${localId}, identity ${itemIdentity.slice(0, 8)}...`)

    // Apply metadata
    await this.applyMetadata(itemIdentity, localId, userId)

    // Apply tags (add + remove)
    await this.applyTags(itemIdentity, localId, userId, tagMap)

    // Apply notes (create + update + delete)
    await this.applyNotes(itemIdentity, local, userId)

    // Apply photo metadata
    if (this.options.syncPhotoAdjustments) {
      await this.applyPhotoMetadata(itemIdentity, local, userId)
    }

    // Apply selections
    await this.applySelections(itemIdentity, local, userId)

    // Apply selection notes
    await this.applySelectionNotes(itemIdentity, local, userId)

    // Apply selection metadata
    await this.applySelectionMetadata(itemIdentity, local, userId)

    // Apply transcriptions
    await this.applyTranscriptions(itemIdentity, local, userId)

    // Apply lists
    if (this.options.syncLists) {
      await this.applyLists(itemIdentity, local, userId, listMap)
    }
  }

  async applyMetadata(itemIdentity, localId, userId) {
    let remoteMeta = schema.getMetadata(this.doc, itemIdentity)
    for (let [prop, value] of Object.entries(remoteMeta)) {
      if (value.author === userId) continue

      try {
        await this.api.saveMetadata(localId, {
          [prop]: { text: value.text, type: value.type }
        })
        await this._writeDelay()
      } catch (err) {
        this.logger.debug(`Failed to save metadata ${prop} on ${localId}`, {
          error: err.message
        })
      }
    }
  }

  async applyTags(itemIdentity, localId, userId, tagMap) {
    // Apply active tags
    let activeTags = schema.getActiveTags(this.doc, itemIdentity)
    for (let tag of activeTags) {
      if (tag.author === userId) continue

      let existing = tagMap.get(tag.name)
      if (!existing) {
        try {
          await this.api.createTag(tag.name, tag.color, [localId])
          await this._writeDelay()
          continue
        } catch (err) {
          this.logger.debug(`Failed to create tag "${tag.name}"`, { error: err.message })
          continue
        }
      }

      try {
        await this.api.addTagsToItem(localId, [existing.id || existing.tag_id])
        await this._writeDelay()
      } catch {}
    }

    // Apply tag removals
    let deletedTags = schema.getDeletedTags(this.doc, itemIdentity)
    for (let tag of deletedTags) {
      if (tag.author === userId) continue

      let existing = tagMap.get(tag.name)
      if (existing) {
        try {
          await this.api.removeTagsFromItem(localId, [existing.id || existing.tag_id])
          await this._writeDelay()
        } catch {}
      }
    }
  }

  async applyNotes(itemIdentity, local, userId) {
    let remoteNotes = schema.getActiveNotes(this.doc, itemIdentity)
    let localId = local.localId

    // Find local photo IDs for attaching notes
    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]
    let firstPhotoId = photos[0] && (photos[0]['@id'] || photos[0].id)

    for (let [noteKey, note] of Object.entries(remoteNotes)) {
      if (note.author === userId) continue
      if (!note.html && !note.text) continue
      if (this.appliedNoteKeys.has(noteKey)) continue

      let photoId = firstPhotoId
      // Try to match by photo checksum
      if (note.photo) {
        for (let p of photos) {
          if (p.checksum === note.photo) {
            photoId = p['@id'] || p.id
            break
          }
        }
      }

      if (!photoId) continue

      let safeHtml = note.html
        ? sanitizeHtml(note.html)
        : `<p>${escapeHtml(note.text)}</p>`

      try {
        await this.api.createNote({
          html: safeHtml,
          language: note.language,
          photo: Number(photoId) || null,
          selection: null
        })
        await this._writeDelay()
        this.appliedNoteKeys.add(noteKey)
      } catch (err) {
        this.logger.debug(`Failed to create note on ${localId}`, {
          error: err.message
        })
      }
    }

    // Apply note deletions
    let allNotes = schema.getNotes(this.doc, itemIdentity)
    for (let [noteKey, note] of Object.entries(allNotes)) {
      if (!note.deleted) continue
      if (note.author === userId) continue
      // We can't easily map CRDT note keys back to local note IDs without
      // a reverse index. For now, deletion sync requires a full re-sync.
      // This is a known limitation — local note IDs differ across instances.
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
      for (let [prop, value] of Object.entries(remoteMeta)) {
        if (value.author === userId) continue

        try {
          await this.api.saveMetadata(localPhotoId, {
            [prop]: { text: value.text, type: value.type }
          })
          await this._writeDelay()
        } catch (err) {
          this.logger.debug(`Failed to save photo metadata ${prop}`, {
            error: err.message
          })
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

      // Skip if we already applied this selection in a previous cycle
      if (this.appliedSelectionKeys.has(selKey)) continue

      // Validate coordinates — must be finite positive numbers for width/height
      let x = Number(sel.x)
      let y = Number(sel.y)
      let w = Number(sel.w)
      let h = Number(sel.h)
      if (!Number.isFinite(x) || !Number.isFinite(y) ||
          !Number.isFinite(w) || !Number.isFinite(h) ||
          w <= 0 || h <= 0) {
        this._log(`Skipping selection ${selKey}: invalid coordinates`, {
          x, y, w, h
        })
        continue
      }

      // Find the local photo by checksum match
      let localPhotoId = null
      for (let p of photos) {
        if (p.checksum === sel.photo) {
          localPhotoId = p['@id'] || p.id
          break
        }
      }
      if (!localPhotoId) continue

      // Check if this selection already exists locally (by checking existing selections)
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
          await this.api.createSelection({
            photo: Number(localPhotoId),
            x,
            y,
            width: w,
            height: h,
            angle: sel.angle || 0
          })
          await this._writeDelay()
          this.appliedSelectionKeys.add(selKey)
        } catch (err) {
          this.logger.debug(`Failed to create selection on photo ${localPhotoId}`, {
            error: err.message
          })
          // Mark as applied even on failure to avoid retrying a broken selection
          // every cycle. The next full sync (safety-net) will retry.
          this.appliedSelectionKeys.add(selKey)
        }
      } else {
        // Already exists locally — mark so we don't re-check every cycle
        this.appliedSelectionKeys.add(selKey)
      }
    }
  }

  async applySelectionNotes(itemIdentity, local, userId) {
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
        let remoteNotes = schema.getSelectionNotes(this.doc, itemIdentity, selKey)

        for (let [compositeKey, note] of Object.entries(remoteNotes)) {
          if (note.author === userId) continue
          if (!note.html && !note.text) continue
          if (this.appliedNoteKeys.has(compositeKey)) continue

          let safeHtml = note.html
            ? sanitizeHtml(note.html)
            : `<p>${escapeHtml(note.text)}</p>`

          let localSelId = sel['@id'] || sel.id
          if (!localSelId) continue

          try {
            await this.api.createNote({
              html: safeHtml,
              language: note.language,
              selection: Number(localSelId) || null
            })
            await this._writeDelay()
            this.appliedNoteKeys.add(compositeKey)
          } catch (err) {
            this.logger.debug(`Failed to create selection note`, {
              error: err.message
            })
          }
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
        for (let [prop, value] of Object.entries(remoteMeta)) {
          if (value.author === userId) continue

          try {
            await this.api.saveMetadata(localSelId, {
              [prop]: { text: value.text, type: value.type }
            })
            await this._writeDelay()
          } catch (err) {
            this.logger.debug(`Failed to save selection metadata ${prop}`, {
              error: err.message
            })
          }
        }
      }
    }
  }

  async applyTranscriptions(itemIdentity, local, userId) {
    let remoteTranscriptions = schema.getActiveTranscriptions(this.doc, itemIdentity)

    let photos = local.item.photo || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let [txKey, tx] of Object.entries(remoteTranscriptions)) {
      if (tx.author === userId) continue
      if (!tx.text && !tx.data) continue
      if (this.appliedTranscriptionKeys.has(txKey)) continue

      // Find local photo by checksum
      let localPhotoId = null
      for (let p of photos) {
        if (p.checksum === tx.photo) {
          localPhotoId = p['@id'] || p.id
          break
        }
      }
      if (!localPhotoId) continue

      // Find local selection if this transcription is on a selection
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

      try {
        await this.api.createTranscription({
          text: tx.text,
          data: tx.data,
          photo: Number(localPhotoId) || null,
          selection: localSelId ? Number(localSelId) : null
        })
        await this._writeDelay()
        this.appliedTranscriptionKeys.add(txKey)
      } catch (err) {
        this.logger.debug(`Failed to create transcription`, {
          error: err.message
        })
        this.appliedTranscriptionKeys.add(txKey)
      }
    }
  }

  async applyLists(itemIdentity, local, userId, listMap) {
    let remoteLists = schema.getActiveLists(this.doc, itemIdentity)
    let localId = local.localId

    for (let [listKey, list] of Object.entries(remoteLists)) {
      if (list.author === userId) continue

      let localList = listMap.get(listKey)
      if (localList) {
        try {
          await this.api.addItemsToList(localList.id, [localId])
          await this._writeDelay()
        } catch {}
      }
    }

    // Remove from lists that are tombstoned
    let allLists = schema.getLists(this.doc, itemIdentity)
    for (let [listKey, list] of Object.entries(allLists)) {
      if (!list.deleted) continue
      if (list.author === userId) continue

      let localList = listMap.get(listKey)
      if (localList) {
        try {
          await this.api.removeItemsFromList(localList.id, [localId])
          await this._writeDelay()
        } catch {}
      }
    }
  }

  // --- Import (review mode) ---

  /**
   * Apply remote changes on demand (review mode).
   * Returns a summary of what was applied, grouped by author.
   */
  async applyOnDemand() {
    if (!this.doc) return null

    let snapshot = schema.getSnapshot(this.doc)
    let userId = this.options.userId || `user-${this.doc.clientID}`
    let summary = {}  // author → { metadata: n, tags: n, notes: n, ... }

    let allTags = await this.api.getTags()
    let tagMap = new Map()
    if (allTags && Array.isArray(allTags)) {
      for (let t of allTags) tagMap.set(t.name, t)
    }

    let listMap = new Map()
    if (this.options.syncLists) {
      try {
        let allLists = await this.api.getLists()
        if (Array.isArray(allLists)) {
          for (let l of allLists) listMap.set(l.name || String(l.id), l)
        }
      } catch {}
    }

    // Count changes by author
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

    // Log summary
    for (let [author, counts] of Object.entries(summary)) {
      let parts = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([type, n]) => `${n} ${type}`)
      if (parts.length > 0) {
        this.logger.info(`${author}: ${parts.join(', ')}`)
      }
    }

    // Take backup
    let backupItems = []
    for (let [itemIdentity] of Object.entries(snapshot)) {
      let local = identity.findLocalMatch(itemIdentity, this.localIndex)
      if (!local) continue
      try {
        let state = await this.backup.captureItemState(local.localId, itemIdentity)
        backupItems.push(state)
      } catch {}
    }
    if (backupItems.length > 0) {
      this.backup.saveSnapshot(backupItems)
    }

    // Apply all — suppress file watcher during apply
    this._applyingRemote = true
    let applied = 0
    try {
      for (let itemIdentity of Object.keys(snapshot)) {
        let local = identity.findLocalMatch(itemIdentity, this.localIndex)
        if (!local) continue
        try {
          await this.applyRemoteAnnotations(itemIdentity, local, tagMap, listMap)
          applied++
        } catch (err) {
          this.logger.debug(`Import: failed to apply ${itemIdentity}`, {
            error: err.message
          })
        }
      }
    } finally {
      this._applyingRemote = false
    }

    return { applied, summary }
  }

  // --- Manual push (export hook) ---

  pushItems(items) {
    if (!this.doc) return

    let userId = this.options.userId || `user-${this.doc.clientID}`

    this.doc.transact(() => {
      for (let item of items) {
        let id = identity.computeIdentity(item)
        if (!id) continue
        this.pushMetadata(item, id, userId)
        this.pushTags(item, id, userId)
        this.pushNotes(item, id, userId)
      }
    }, this.LOCAL_ORIGIN)
  }

  // --- Rollback ---

  async rollback(backupPath) {
    return this.backup.rollback(backupPath)
  }

  // --- Status ---

  getStatus() {
    return {
      state: this.state,
      lastSync: this.lastSync,
      room: this.options.room,
      server: this.options.serverUrl,
      syncMode: this.options.syncMode,
      clientId: this.doc ? this.doc.clientID : null,
      localItems: this.localIndex.size,
      crdtItems: this.doc ? Object.keys(schema.getSnapshot(this.doc)).length : 0,
      users: this.doc ? schema.getUsers(this.doc) : [],
      watching: this.fileWatcher != null,
      projectPath: this.projectPath
    }
  }
}

module.exports = { SyncEngine }
