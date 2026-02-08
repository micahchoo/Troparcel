'use strict'

/**
 * Troparcel — Annotation Overlay Collaboration Layer for Tropy
 *
 * Syncs notes, tags, metadata, and selections between Tropy instances
 * through CRDTs (Yjs).  Items are matched across instances by photo
 * checksum, so each researcher keeps their own photos locally while
 * sharing interpretations through a lightweight WebSocket relay.
 *
 * Two modes of operation:
 *   1. Background sync (primary) — polls the Tropy API and keeps
 *      a shared CRDT document up to date automatically.
 *   2. Manual export/import (fallback) — triggered via the File
 *      menu for one-shot sharing.
 */

const { SyncEngine } = require('./sync-engine')
const identity = require('./identity')
const schema = require('./crdt-schema')

class TroparcelPlugin {
  constructor(options, context) {
    this.context = context
    this.options = this.mergeOptions(options)
    this.engine = null

    this.context.logger.info('Troparcel v2.0 initialized', {
      room: this.options.room,
      server: this.options.serverUrl,
      autoSync: this.options.autoSync,
      userId: this.options.userId,
      hasToken: !!this.options.roomToken
    })

    // Start background sync if enabled
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
      serverUrl: options.serverUrl || 'ws://localhost:2468',
      room: options.room || projectName || 'troparcel-default',
      userId: options.userId || '',
      autoSync: options.autoSync !== false,
      syncInterval: Number(options.syncInterval) || 10,
      apiPort: Number(options.apiPort) || 2019,
      roomToken: options.roomToken || ''
    }
  }

  /**
   * Start the background sync engine.
   * Runs asynchronously — logs errors but does not throw.
   */
  async startBackgroundSync() {
    if (this.engine) return

    this.engine = new SyncEngine(this.options, this.context.logger)

    try {
      await this.engine.start()
      this.context.logger.info('Background sync active', {
        room: this.options.room,
        interval: this.options.syncInterval
      })
    } catch (err) {
      this.context.logger.warn('Background sync failed to start — ' +
        'falling back to manual export/import', {
        error: err.message
      })
      // Engine failed but plugin still works via manual export/import
      this.engine.stop()
      this.engine = null
    }
  }

  /**
   * Export hook — share selected items to the collaboration room.
   * Works both with and without background sync.
   *
   * @param {Array} data - JSON-LD items from Tropy
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
      // If engine is running, push through it
      if (this.engine && this.engine.state === 'connected') {
        this.engine.pushItems(data)

        this.context.logger.info(
          `Shared ${data.length} item(s) to room "${this.options.room}" ` +
          `(background sync active)`
        )
        return
      }

      // No background sync — do a one-shot connection
      let tempEngine = new SyncEngine(this.options, this.context.logger)
      await tempEngine.start()
      tempEngine.pushItems(data)

      this.context.logger.info(
        `Shared ${data.length} item(s) to room "${this.options.room}"`
      )

      // Keep connection open briefly for replication, then disconnect
      setTimeout(() => tempEngine.stop(), 5000)

    } catch (err) {
      this.context.logger.error('Export failed', {
        error: err.message,
        room: this.options.room
      })
    }
  }

  /**
   * Import hook — pull annotations from the collaboration room.
   * Adds items to the Tropy import payload.
   *
   * @param {Object} payload - Tropy import payload
   */
  async import(payload) {
    this.context.logger.info('Import: pulling from room', {
      room: this.options.room
    })

    try {
      let items

      // If engine is running, pull from its CRDT state
      if (this.engine && this.engine.state === 'connected') {
        items = this.engine.pullItems()
      } else {
        // One-shot connection
        let tempEngine = new SyncEngine(this.options, this.context.logger)
        await tempEngine.start()

        // Wait a moment for sync
        await new Promise(r => setTimeout(r, 3000))

        items = tempEngine.pullItems()
        tempEngine.stop()
      }

      if (!items || items.length === 0) {
        this.context.logger.info('Import: no items found in room')
        return
      }

      if (!payload.data) payload.data = []
      payload.data.push(...items)

      this.context.logger.info(
        `Import: pulled ${items.length} item(s) from room "${this.options.room}"`
      )

    } catch (err) {
      this.context.logger.error('Import failed', {
        error: err.message,
        room: this.options.room
      })
    }
  }

  /**
   * Get plugin status for diagnostics.
   */
  getStatus() {
    // Redact sensitive fields from options (#2)
    let safeOptions = { ...this.options }
    if (safeOptions.roomToken) safeOptions.roomToken = '***'

    return {
      version: '2.0.0',
      options: safeOptions,
      engine: this.engine ? this.engine.getStatus() : null,
      backgroundSync: this.engine != null
    }
  }

  /**
   * Cleanup on plugin unload.
   */
  unload() {
    this.context.logger.info('Troparcel unloading')
    if (this.engine) {
      this.engine.stop()
      this.engine = null
    }
  }
}

module.exports = TroparcelPlugin
