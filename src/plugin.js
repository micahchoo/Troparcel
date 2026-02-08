'use strict'

/**
 * Troparcel v3.0 — Annotation Overlay Collaboration Layer for Tropy
 *
 * Syncs notes, tags, metadata, selections, transcriptions, and lists
 * between Tropy instances through CRDTs (Yjs). Items are matched
 * across instances by photo checksum, so each researcher keeps their
 * own photos locally while sharing interpretations through a
 * lightweight WebSocket relay.
 *
 * Two sync modes:
 *   - "auto" — near-real-time: local changes pushed on DB file change,
 *     remote changes applied immediately (debounced)
 *   - "review" — local changes pushed automatically, but remote changes
 *     only applied when the user triggers Import from the File menu
 */

const { SyncEngine } = require('./sync-engine')
const identity = require('./identity')
const schema = require('./crdt-schema')

class TroparcelPlugin {
  constructor(options, context) {
    this.context = context
    this.options = this.mergeOptions(options)
    this.engine = null

    this.context.logger.info('Troparcel v3.0 initialized', {
      room: this.options.room,
      server: this.options.serverUrl,
      autoSync: this.options.autoSync,
      syncMode: this.options.syncMode,
      userId: this.options.userId,
      hasToken: !!this.options.roomToken
    })

    if (this.options.autoSync) {
      this.startBackgroundSync()
    }
  }

  mergeOptions(options) {
    let projectName = ''
    try {
      if (this.context.window && this.context.window.project) {
        projectName = this.context.window.project.name || ''
      }
    } catch { /* ignore */ }

    return {
      // Connection
      serverUrl: options.serverUrl || 'ws://localhost:2468',
      room: options.room || projectName || 'troparcel-default',
      userId: options.userId || '',
      roomToken: options.roomToken || '',
      apiPort: Number(options.apiPort) || 2019,

      // Sync behavior
      autoSync: options.autoSync !== false,
      syncMode: options.syncMode || 'auto',
      syncPhotoAdjustments: options.syncPhotoAdjustments === true || options.syncPhotoAdjustments === 'true',
      syncLists: options.syncLists === true || options.syncLists === 'true',

      // Timing (all configurable)
      startupDelay: Number(options.startupDelay) || 8000,
      localDebounce: Number(options.localDebounce) || 2000,
      remoteDebounce: Number(options.remoteDebounce) || 500,
      safetyNetInterval: Number(options.safetyNetInterval) || 120,
      writeDelay: Number(options.writeDelay) || 100,

      // Safety limits
      maxBackups: Number(options.maxBackups) || 10,
      maxNoteSize: Number(options.maxNoteSize) || 1048576,
      maxMetadataSize: Number(options.maxMetadataSize) || 65536,
      tombstoneFloodThreshold: Number(options.tombstoneFloodThreshold) || 0.5,

      // Debug
      debug: options.debug === true || options.debug === 'true'
    }
  }

  async startBackgroundSync() {
    if (this.engine) return

    this.engine = new SyncEngine(this.options, this.context.logger)

    try {
      await this.engine.start()
      this.context.logger.info('Background sync active', {
        room: this.options.room,
        syncMode: this.options.syncMode
      })
    } catch (err) {
      this.context.logger.warn('Background sync failed to start — ' +
        'falling back to manual export/import', {
        error: err.message
      })
      this.engine.stop()
      this.engine = null
    }
  }

  /**
   * Export hook — share selected items to the collaboration room.
   */
  async export(data) {
    if (!data || data.length === 0) {
      this.context.logger.warn('Export: no items selected')
      return
    }

    this.context.logger.info(`Export: sharing ${data.length} item(s)`, {
      room: this.options.room
    })

    try {
      if (this.engine && this.engine.state === 'connected') {
        this.engine.pushItems(data)
        this.context.logger.info(
          `Shared ${data.length} item(s) to room "${this.options.room}" ` +
          `(background sync active)`
        )
        return
      }

      let tempEngine = new SyncEngine(this.options, this.context.logger)
      await tempEngine.start()
      tempEngine.pushItems(data)

      this.context.logger.info(
        `Shared ${data.length} item(s) to room "${this.options.room}"`
      )

      setTimeout(() => tempEngine.stop(), 5000)

    } catch (err) {
      this.context.logger.error('Export failed', {
        error: err.message,
        room: this.options.room
      })
    }
  }

  /**
   * Import hook — apply annotations from the collaboration room.
   *
   * In review mode, shows a summary of pending changes before applying.
   * In auto mode, forces a full re-sync from the CRDT.
   */
  async import(payload) {
    this.context.logger.info('Import: pulling from room', {
      room: this.options.room,
      syncMode: this.options.syncMode
    })

    if (this.engine) this.engine.pause()

    try {
      let engine
      let tempEngine = false

      if (this.engine && this.engine.state === 'connected') {
        engine = this.engine
      } else {
        engine = new SyncEngine(this.options, this.context.logger)
        await engine.start()
        await new Promise(r => setTimeout(r, 3000))
        tempEngine = true
      }

      let api = engine.api
      let alive = await api.ping()
      if (!alive) {
        this.context.logger.warn('Import: Tropy API not reachable')
        if (tempEngine) engine.stop()
        return
      }

      // Build local index if not already populated
      if (engine.localIndex.size === 0) {
        let localItems = await api.getItems()
        if (localItems && Array.isArray(localItems)) {
          let items = []
          for (let s of localItems) {
            try { items.push(await engine.enrichItem(s)) } catch {}
          }
          engine.localIndex = identity.buildIdentityIndex(items)
        }
      }

      // Use applyOnDemand which handles summary + backup
      let result = await engine.applyOnDemand()

      if (result) {
        this.context.logger.info(
          `Import: applied annotations to ${result.applied} item(s) from room "${this.options.room}"`
        )
      }

      if (tempEngine) engine.stop()

    } catch (err) {
      this.context.logger.error('Import failed', {
        error: err.message,
        room: this.options.room
      })
    } finally {
      if (this.engine) this.engine.resume()
    }
  }

  getStatus() {
    let safeOptions = { ...this.options }
    if (safeOptions.roomToken) safeOptions.roomToken = '***'

    return {
      version: '3.0.0',
      options: safeOptions,
      engine: this.engine ? this.engine.getStatus() : null,
      backgroundSync: this.engine != null
    }
  }

  unload() {
    this.context.logger.info('Troparcel unloading')
    if (this.engine) {
      this.engine.stop()
      this.engine = null
    }
  }
}

module.exports = TroparcelPlugin
