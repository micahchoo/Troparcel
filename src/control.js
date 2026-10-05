'use strict'

const fs = require('fs')
const path = require('path')
const { parseConnectionString, generateConnectionString } = require('./connection-string')
const { syncRoots, createRoomFolder } = require('./sync-folders')

/**
 * What the dashboard shows and does, for one Troparcel plugin instance.
 *
 *   status(plugin)                 → the JSON the page renders
 *   perform(plugin, action, input) → a message, or throws one
 *
 * Settings are changed the way Preferences > Plugins changes them: by
 * writing this plugin's entry in Tropy's plugin config.json. Tropy notices
 * and re-creates the plugin with them, no restart needed.
 */

function configured(options) {
  return !!(options.connectionGiven && options.userId)
}

/** What to send a new member, and what they must do first. */
function invite(options) {
  if (options.transport === 'file') {
    let name = options.syncFolder || (options.syncDir && path.basename(options.syncDir))
    if (!name) return null
    let text = generateConnectionString({
      transport: 'file', syncFolder: name, sharePhotos: options.sharePhotos, roomKey: options.roomKey
    })
    let client = options.syncDir ? (syncRoots().find(([, root]) => options.syncDir.startsWith(root)) || [])[0] : null
    return {
      text,
      how: `First share the folder “${name}” with them${client ? ` in ${client}` : ''}. Then send them this, to paste into Troparcel’s Connection field:`,
      secret: !!options.roomKey,
      encrypted: !!options.roomKey
    }
  }
  let text = generateConnectionString(options)
  return {
    text,
    how: 'Send them this, to paste into Troparcel’s Connection field:',
    secret: !!(options.roomToken || options.roomKey),
    encrypted: !!options.roomKey
  }
}

function status(plugin) {
  let o = plugin.options
  return {
    version: require('../package.json').version,
    configured: configured(o),
    options: { connection: o.connectionGiven || '', userId: o.userId || '' },
    syncRoots: syncRoots(),
    invite: configured(o) ? invite(o) : null,
    engine: plugin.engine && plugin.engine.doc ? plugin.engine.dashboardStatus() : null,
    problems: plugin.journal.problems()
  }
}

async function perform(plugin, action, input) {
  let engine = plugin.engine
  switch (action) {
    case 'setup': {
      let connection = String(input.connection || '').trim()
      let userId = String(input.userId || '').trim()
      if (!connection) throw new Error('Paste the connection your group sent you.')
      if (!parseConnectionString(connection)) {
        throw new Error('That does not look like a Troparcel connection. It starts with troparcel://, ws:// or a folder path.')
      }
      if (!userId) throw new Error('Choose a name others will see on your work.')
      writeSettings(plugin, { connection, userId })
      return 'Saved. Troparcel is connecting…'
    }
    case 'create-room': {
      let room = String(input.room || '').trim()
      let userId = String(input.userId || plugin.options.userId || '').trim()
      if (!room) throw new Error('Give the room a name, such as tropy-letters.')
      if (/[\\/]/.test(room)) throw new Error('A room name cannot contain / or \\.')
      if (!userId) throw new Error('Fill in “Your name” first: others see it on your work.')
      if (!syncRoots().some(([, root]) => root === input.root)) throw new Error('Choose one of the shared folders listed.')
      createRoomFolder(input.root, room)
      writeSettings(plugin, { connection: `troparcel://folder/${room}`, userId })
      return `Room “${room}” created. Share that folder with your group, then send them the invite below.`
    }
    case 'resolve':
      if (!engine) throw new Error('Troparcel is not connected yet.')
      await engine.resolveConflict(input.identity, input.field, input.choice)
      return input.choice === 'theirs' ? 'Their value is in your project now.' : 'Your value is being sent to the group.'
    case 'share':
      if (!engine) throw new Error('Troparcel is not connected yet.')
      await engine.syncOnce()
      return 'Your changes were shared.'
    case 'receive':
      if (!engine) throw new Error('Troparcel is not connected yet.')
      engine._remoteAnnotationsDirty = true
      await engine.syncOnce()
      return 'Received what the group shared.'
    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

/**
 * Change this plugin's settings in Tropy's plugin config.json. The entry
 * is the Troparcel one whose options are this instance's, so a second
 * Troparcel entry (one that publishes IIIF) is never touched.
 */
function writeSettings(plugin, changes) {
  let file = plugin.configFile()
  if (!file || !fs.existsSync(file)) throw new Error('Could not find Tropy’s plugin settings. Change them in Preferences › Plugins instead.')
  let config = JSON.parse(fs.readFileSync(file, 'utf8'))
  let mine = JSON.stringify(plugin.rawOptions || {})
  let entry = config.find(e => e.plugin === 'troparcel' && JSON.stringify(e.options || {}) === mine) ||
    config.find(e => e.plugin === 'troparcel' && !(e.options || {}).iiifFolder)
  if (!entry) throw new Error('Could not find Troparcel in Tropy’s plugin settings.')
  entry.options = { ...(entry.options || {}), ...changes }
  // Tropy lists the entry under File › Export by this name; give an
  // unnamed one a recognisable name, never rename one the owner chose.
  if (!entry.name) entry.name = 'Troparcel'
  // Older versions kept the server, room and token apart; the connection replaces them.
  if (changes.connection) for (let old of ['serverUrl', 'room', 'roomToken']) delete entry.options[old]
  let tmp = `${file}.troparcel-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
  fs.renameSync(tmp, file)
}

module.exports = { status, perform, invite, writeSettings }
