'use strict'

/**
 * Parse a troparcel:// connection string into option fields.
 *
 * Formats:
 *   troparcel://ws/host:port/room?token=secret
 *   troparcel://file/path/to/shared/folder
 *   troparcel://snapshot/https://host/path?auth=Bearer+token
 *   ws://host:port  (bare URL, auto-detected)
 *   wss://host:port
 *
 * @param {string} str
 * @returns {object|null} parsed options or null if empty/invalid
 */
function parseConnectionString(str) {
  if (!str || typeof str !== 'string') return null
  str = str.trim()
  if (!str) return null

  // Bare ws:// or wss:// URL — treat as websocket
  if (/^wss?:\/\//i.test(str)) {
    return { transport: 'websocket', serverUrl: str }
  }

  // Must start with troparcel://
  let match = str.match(/^troparcel:\/\/(ws|file|snapshot)\/(.+)$/i)
  if (!match) return null

  let scheme = match[1].toLowerCase()
  let rest = match[2]

  if (scheme === 'ws') return _parseWebSocket(rest)
  if (scheme === 'file') return _parseFile(rest)
  if (scheme === 'snapshot') return _parseSnapshot(rest)

  return null
}

function _parseWebSocket(rest) {
  let [pathPart, query] = rest.split('?', 2)
  let params = _parseQuery(query)

  // Split host:port and room — find slash after host:port
  let slashIdx = pathPart.indexOf('/', pathPart.indexOf(':') + 1)
  let hostPort, room

  if (slashIdx > 0 && slashIdx < pathPart.length - 1) {
    hostPort = pathPart.slice(0, slashIdx)
    room = decodeURIComponent(pathPart.slice(slashIdx + 1))
  } else {
    hostPort = pathPart.replace(/\/$/, '')
  }

  // Use wss:// if no port specified (assume reverse proxy with TLS)
  let protocol = hostPort.includes(':') ? 'ws' : 'wss'
  let result = {
    transport: 'websocket',
    serverUrl: `${protocol}://${hostPort}`
  }
  if (room) result.room = room
  if (params.token) result.roomToken = params.token

  return result
}

function _parseFile(rest) {
  let [pathPart] = rest.split('?', 1)
  return {
    transport: 'file',
    syncDir: '/' + pathPart.replace(/^\//, '')
  }
}

function _parseSnapshot(rest) {
  let [urlPart, query] = rest.split('?', 2)
  let params = _parseQuery(query)

  let result = {
    transport: 'snapshot',
    snapshotUrl: urlPart
  }
  if (params.auth) result.snapshotAuth = params.auth

  return result
}

function _parseQuery(query) {
  if (!query) return {}
  let params = {}
  for (let pair of query.split('&')) {
    let [k, v] = pair.split('=', 2)
    if (k && v !== undefined) {
      params[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '))
    }
  }
  return params
}

/**
 * Generate a connection string from options.
 *
 * @param {object} opts
 * @returns {string}
 */
function generateConnectionString(opts) {
  let transport = opts.transport || 'websocket'

  if (transport === 'websocket') {
    let url = (opts.serverUrl || 'ws://localhost:2468').replace(/^wss?:\/\//, '')
    let str = `troparcel://ws/${url}`
    if (opts.room) str += `/${encodeURIComponent(opts.room)}`
    if (opts.roomToken) str += `?token=${encodeURIComponent(opts.roomToken)}`
    return str
  }

  if (transport === 'file') {
    let dir = (opts.syncDir || '').replace(/^\//, '')
    return `troparcel://file/${dir}`
  }

  if (transport === 'snapshot') {
    let str = `troparcel://snapshot/${opts.snapshotUrl || ''}`
    if (opts.snapshotAuth) str += `?auth=${encodeURIComponent(opts.snapshotAuth)}`
    return str
  }

  return ''
}

module.exports = { parseConnectionString, generateConnectionString }
