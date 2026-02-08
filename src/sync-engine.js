'use strict'

const Y = require('yjs')
const { WebsocketProvider } = require('y-websocket')
const { ApiClient } = require('./api-client')
const identity = require('./identity')
const schema = require('./crdt-schema')
const { sanitizeHtml, escapeHtml } = require('./sanitize')

/**
 * Sync Engine — background loop that keeps local Tropy state
 * and the shared CRDT document in sync.
 *
 * The engine:
 *   1. Connects to the collaboration server via WebSocket
 *   2. Polls the local Tropy API for items + annotations
 *   3. Pushes local annotations into the CRDT document
 *   4. Listens for remote CRDT changes and applies them locally
 *
 * Only annotations (metadata, tags, notes, selections) are synced.
 * Photos and images stay local.
 */
class SyncEngine {
  constructor(options, logger) {
    this.options = options
    this.logger = logger

    this.doc = null
    this.provider = null
    this.api = new ApiClient(options.apiPort, logger)

    this.localIndex = new Map()  // identity → { localId, item }
    this.syncTimer = null
    this.heartbeatTimer = null
    this.unsubscribe = null      // CRDT observer cleanup

    this.state = 'idle'          // idle, connecting, connected, syncing, error
    this.lastSync = null
    this.peerCount = 0
    this.pendingRemoteChanges = []

    // Track which remote notes we've already applied locally to prevent
    // infinite duplication (#12 in audit)
    this.appliedNoteIds = new Set()

    // Transaction origin marker to distinguish local vs remote changes (#13)
    this.LOCAL_ORIGIN = 'troparcel-local'
  }

  /**
   * Start the sync engine: connect to the server and begin polling.
   */
  async start() {
    if (this.state === 'connected' || this.state === 'connecting') return

    this.state = 'connecting'
    this.logger.info('Sync engine starting', {
      server: this.options.serverUrl,
      room: this.options.room
    })

    try {
      // Create Yjs document
      this.doc = new Y.Doc()

      // Register local user
      schema.registerUser(this.doc, this.doc.clientID, this.options.userId)

      // Connect to server
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
          resyncInterval: 30000
        }
      )

      // Wait for connection
      await this.waitForConnection()

      // Set up remote change observer — only fires for non-local changes
      this.unsubscribe = schema.observeAnnotationsDeep(
        this.doc,
        (changes) => { this.handleRemoteChanges(changes) },
        this.LOCAL_ORIGIN
      )

      // Monitor peers
      this.provider.on('status', (event) => {
        if (event.status === 'connected') {
          this.state = 'connected'
          this.logger.info('WebSocket connected')
        } else if (event.status === 'disconnected') {
          this.logger.warn('WebSocket disconnected, will retry')
        }
      })

      this.state = 'connected'
      this.logger.info('Sync engine connected', {
        clientId: this.doc.clientID,
        room: this.options.room
      })

      // Do an initial full sync
      await this.syncOnce()

      // Start periodic polling
      if (this.options.autoSync) {
        this.startPolling()
      }

      // Start heartbeat
      this.heartbeatTimer = setInterval(() => {
        schema.heartbeat(this.doc, this.doc.clientID)
      }, 30000)

    } catch (err) {
      this.state = 'error'
      this.logger.error('Sync engine failed to start', { error: err.message })
      throw err
    }
  }

  /**
   * Stop the sync engine and clean up.
   */
  stop() {
    this.logger.info('Sync engine stopping')

    this.stopPolling()

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }

    if (this.provider) {
      this.provider.destroy()
      this.provider = null
    }

    if (this.doc) {
      this.doc.destroy()
      this.doc = null
    }

    this.localIndex.clear()
    this.pushedVersions.clear()
    this.pendingRemoteChanges = []
    this.state = 'idle'
  }

  /**
   * Wait for initial WebSocket connection.
   */
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

  /**
   * Start the periodic sync polling loop.
   */
  startPolling() {
    this.stopPolling()
    let interval = (this.options.syncInterval || 10) * 1000
    this.syncTimer = setInterval(() => this.syncOnce(), interval)
    this.logger.info(`Polling started (every ${interval / 1000}s)`)
  }

  /**
   * Stop polling.
   */
  stopPolling() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
  }

  /**
   * Run a single sync cycle: poll local → push to CRDT.
   */
  async syncOnce() {
    if (this.state !== 'connected') return
    if (!this.doc) return

    let prev = this.state
    this.state = 'syncing'

    try {
      // Check API availability
      let alive = await this.api.ping()
      if (!alive) {
        this.logger.debug('Tropy API not reachable, skipping sync')
        this.state = prev
        return
      }

      // Get all items
      let items = await this.api.getItems()
      if (!items || !Array.isArray(items)) {
        this.logger.debug('No items from API')
        this.state = prev
        return
      }

      // Build identity index
      this.localIndex = identity.buildIdentityIndex(items)

      // Push local annotations to CRDT
      await this.pushLocal(items)

      // Apply any pending remote changes
      await this.applyPendingRemote()

      this.lastSync = new Date()
      this.state = 'connected'

    } catch (err) {
      this.logger.warn('Sync cycle failed', { error: err.message })
      this.state = prev === 'connected' ? 'connected' : 'error'
    }
  }

  /**
   * Push local annotations for all items into the CRDT.
   */
  async pushLocal(items) {
    let userId = this.options.userId || `user-${this.doc.clientID}`

    for (let item of items) {
      let id = identity.computeIdentity(item)
      if (!id) continue

      try {
        await this.pushItemAnnotations(item, id, userId)
      } catch (err) {
        this.logger.debug(`Failed to push item ${id}`, { error: err.message })
      }
    }
  }

  /**
   * Push annotations for a single item into the CRDT.
   */
  async pushItemAnnotations(item, itemIdentity, userId) {
    let localId = item['@id'] || item.id
    if (!localId) return

    // Batch all CRDT writes in a single transaction, tagged with our origin
    // so the observer can skip changes we made ourselves (#13)
    this.doc.transact(() => {
      // Push metadata
      this.pushMetadata(item, itemIdentity, userId)

      // Push tags from the item data
      this.pushTags(item, itemIdentity, userId)

      // Push notes from photo/selection data
      this.pushNotes(item, itemIdentity, userId)
    }, this.LOCAL_ORIGIN)
  }

  /**
   * Push metadata properties from an item.
   */
  pushMetadata(item, itemIdentity, userId) {
    // Tropy JSON-LD items have metadata as top-level properties with URIs
    for (let [key, value] of Object.entries(item)) {
      // Skip internal/structural fields
      if (key.startsWith('@') || key.startsWith('_')) continue
      if (['photo', 'template', 'list', 'tag'].includes(key)) continue

      // Only sync URI-keyed properties (metadata)
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

      // Only push if different from what's already in the CRDT
      let existing = schema.getMetadata(this.doc, itemIdentity)
      let current = existing[key]
      if (current && current.text === text && current.type === type) continue

      schema.setMetadata(this.doc, itemIdentity, key, { text, type, language }, userId)
    }
  }

  /**
   * Push tags from an item.
   */
  pushTags(item, itemIdentity, userId) {
    // Tags may be in item.tag or item['https://tropy.org/v1/tropy#tag']
    let tags = item.tag || item['https://tropy.org/v1/tropy#tag'] || []
    if (!Array.isArray(tags)) tags = [tags]

    for (let tag of tags) {
      let name = typeof tag === 'string' ? tag : (tag.name || tag['@value'] || '')
      let color = typeof tag === 'object' ? tag.color : null

      if (name) {
        schema.addTag(this.doc, itemIdentity, { name, color }, userId)
      }
    }
  }

  /**
   * Push notes from an item's photos and selections.
   */
  pushNotes(item, itemIdentity, userId) {
    let photos = item.photo || item['https://tropy.org/v1/tropy#photo'] || []
    if (!Array.isArray(photos)) photos = [photos]

    for (let photo of photos) {
      let notes = photo.note || photo['https://tropy.org/v1/tropy#note'] || []
      if (!Array.isArray(notes)) notes = [notes]

      for (let note of notes) {
        if (!note) continue
        let text = note['@value'] || note.text || note['https://schema.org/text'] || ''
        let html = note.html || note['https://tropy.org/v1/tropy#html'] || ''
        let noteId = note['@id'] || note.id

        if (text || html) {
          schema.addNote(this.doc, itemIdentity, {
            noteId: noteId ? String(noteId) : null,
            text: typeof text === 'object' ? text['@value'] || '' : text,
            html: typeof html === 'object' ? html['@value'] || '' : html,
            language: note.language || null,
            photo: photo['@id'] || photo.id || null
          }, userId)
        }
      }

      // Notes on selections
      let selections = photo.selection || photo['https://tropy.org/v1/tropy#selection'] || []
      if (!Array.isArray(selections)) selections = [selections]

      for (let sel of selections) {
        let selNotes = sel.note || sel['https://tropy.org/v1/tropy#note'] || []
        if (!Array.isArray(selNotes)) selNotes = [selNotes]

        for (let note of selNotes) {
          if (!note) continue
          let text = note['@value'] || note.text || ''
          let html = note.html || ''
          let noteId = note['@id'] || note.id

          if (text || html) {
            schema.addNote(this.doc, itemIdentity, {
              noteId: noteId ? String(noteId) : null,
              text: typeof text === 'object' ? text['@value'] || '' : text,
              html: typeof html === 'object' ? html['@value'] || '' : html,
              language: note.language || null,
              selection: sel['@id'] || sel.id || null
            }, userId)
          }
        }
      }
    }
  }

  /**
   * Handle remote changes from the CRDT and queue them for local application.
   * Only called for changes NOT originating from our LOCAL_ORIGIN transactions.
   */
  handleRemoteChanges(changes) {
    for (let change of changes) {
      // Only queue changes for items we have locally — otherwise there's
      // nothing to apply them to
      if (this.localIndex.has(change.identity)) {
        this.pendingRemoteChanges.push(change)
      }
    }
  }

  /**
   * Apply pending remote changes to the local Tropy instance via API.
   */
  async applyPendingRemote() {
    if (this.pendingRemoteChanges.length === 0) return

    let changes = this.pendingRemoteChanges.splice(0)
    let processed = new Set()

    for (let change of changes) {
      if (processed.has(change.identity)) continue
      processed.add(change.identity)

      let local = identity.findLocalMatch(change.identity, this.localIndex)
      if (!local) continue

      try {
        await this.applyRemoteAnnotations(change.identity, local)
      } catch (err) {
        this.logger.debug(`Failed to apply remote changes for ${change.identity}`, {
          error: err.message
        })
      }
    }
  }

  /**
   * Apply remote annotations for a single item.
   */
  async applyRemoteAnnotations(itemIdentity, local) {
    let localId = local.localId
    let userId = this.options.userId || `user-${this.doc.clientID}`

    // Apply metadata
    let remoteMeta = schema.getMetadata(this.doc, itemIdentity)
    for (let [prop, value] of Object.entries(remoteMeta)) {
      // Skip our own changes
      if (value.author === userId) continue

      try {
        await this.api.saveMetadata(localId, {
          [prop]: { text: value.text, type: value.type }
        })
      } catch (err) {
        this.logger.debug(`Failed to save metadata ${prop} on ${localId}`, {
          error: err.message
        })
      }
    }

    // Apply tags
    let remoteTags = schema.getTags(this.doc, itemIdentity)
    if (remoteTags.length > 0) {
      let allTags = await this.api.getTags()
      if (allTags && Array.isArray(allTags)) {
        let tagMap = new Map()
        for (let t of allTags) tagMap.set(t.name, t)

        for (let tag of remoteTags) {
          if (tag.author === userId) continue

          let existing = tagMap.get(tag.name)
          if (!existing) {
            // Create the tag first
            try {
              let result = await this.api.createTag(tag.name, tag.color, [localId])
              if (result) continue // Tag created and applied
            } catch (err) {
              this.logger.debug(`Failed to create tag "${tag.name}"`, {
                error: err.message
              })
              continue
            }
          }

          // Tag exists, add to item
          if (existing) {
            try {
              await this.api.addTagsToItem(localId, [existing.id || existing.tag_id])
            } catch {
              // May already be tagged
            }
          }
        }
      }
    }

    // Apply notes — sanitize HTML and skip already-applied notes
    let remoteNotes = schema.getNotes(this.doc, itemIdentity)
    for (let note of remoteNotes) {
      if (note.author === userId) continue
      if (!note.html && !note.text) continue

      // Skip notes we've already applied locally (#12)
      if (note.noteId && this.appliedNoteIds.has(note.noteId)) continue

      // We need a photo ID to attach the note to.
      // Try to find one from the local item.
      let photos = local.item.photo || local.item['https://tropy.org/v1/tropy#photo'] || []
      if (!Array.isArray(photos)) photos = [photos]
      let photoId = note.photo || (photos[0] && (photos[0]['@id'] || photos[0].id))

      if (photoId) {
        // CRITICAL: Sanitize HTML from remote source to prevent XSS→RCE (#1)
        let safeHtml = note.html
          ? sanitizeHtml(note.html)
          : `<p>${escapeHtml(note.text)}</p>`

        try {
          await this.api.createNote({
            html: safeHtml,
            language: note.language,
            photo: Number(photoId) || null,
            selection: note.selection ? Number(note.selection) : null
          })

          // Track this note as applied so we don't duplicate it
          if (note.noteId) this.appliedNoteIds.add(note.noteId)
        } catch (err) {
          this.logger.debug(`Failed to create note on ${localId}`, {
            error: err.message
          })
        }
      }
    }
  }

  /**
   * Manually push a set of JSON-LD items to the CRDT (for export hook).
   */
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

  /**
   * Pull all annotations from the CRDT as JSON-LD items
   * suitable for Tropy import (for import hook).
   */
  pullItems() {
    if (!this.doc) return []

    let snapshot = schema.getSnapshot(this.doc)
    let items = []

    for (let [itemIdentity, ann] of Object.entries(snapshot)) {
      let item = { '@type': 'Item' }

      // Reconstruct metadata as JSON-LD properties
      for (let [prop, value] of Object.entries(ann.metadata)) {
        item[prop] = {
          '@value': value.text,
          '@type': value.type
        }
        if (value.language) {
          item[prop]['@language'] = value.language
        }
      }

      // Attach tags
      if (ann.tags.length > 0) {
        item.tag = ann.tags.map(t => t.name)
      }

      // Attach notes — we create a stub photo to hold them
      if (ann.notes.length > 0) {
        // Group notes by photo
        item.photo = []
        let notesByPhoto = new Map()

        for (let note of ann.notes) {
          let key = note.photo || '__default'
          if (!notesByPhoto.has(key)) notesByPhoto.set(key, [])
          notesByPhoto.get(key).push(note)
        }

        for (let [photoKey, notes] of notesByPhoto) {
          let photo = {
            note: notes.map(n => ({
              '@value': n.html || n.text,
              'https://tropy.org/v1/tropy#html': n.html || '',
              'https://schema.org/text': n.text || ''
            }))
          }
          item.photo.push(photo)
        }
      }

      // Metadata for attribution
      item._troparcel = {
        identity: itemIdentity,
        syncedAt: new Date().toISOString()
      }

      items.push(item)
    }

    return items
  }

  /**
   * Get sync status for diagnostics.
   */
  getStatus() {
    return {
      state: this.state,
      lastSync: this.lastSync,
      room: this.options.room,
      server: this.options.serverUrl,
      clientId: this.doc ? this.doc.clientID : null,
      localItems: this.localIndex.size,
      crdtItems: this.doc ? schema.getSnapshot(this.doc) : {},
      users: this.doc ? schema.getUsers(this.doc) : [],
      pendingRemote: this.pendingRemoteChanges.length
    }
  }
}

module.exports = { SyncEngine }
