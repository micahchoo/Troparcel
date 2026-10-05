'use strict'

/**
 * Parse a troparcel:// connection string into option fields.
 *
 * Formats:
 *   troparcel://ws/host:port/room?token=secret   a Troparcel server
 *   troparcel://wss/host:port/room?token=secret  the same, over TLS
 *   troparcel://file/path/to/shared/folder       a shared folder
 *   ws://host:port, wss://host                   a server, bare URL
 *   /path/to/shared/folder                       a shared folder, bare path
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

  // Bare absolute path — a shared folder
  if (str.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(str)) {
    return { transport: 'file', syncDir: str }
  }

  let match = str.match(/^troparcel:\/\/(wss|ws|file)\/(.+)$/i)
  if (!match) return null

  let scheme = match[1].toLowerCase()
  if (scheme === 'file') return _parseFile(match[2])
  return _parseWebSocket(match[2], scheme === 'wss' ? 'wss' : null)
}

function _parseWebSocket(rest, protocolHint) {
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

  // ws/ with no port means a TLS proxy (older strings); wss/ says so outright
  let protocol = protocolHint || (hostPort.includes(':') ? 'ws' : 'wss')
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
    let serverUrl = opts.serverUrl || 'ws://localhost:2468'
    let scheme = /^wss:/i.test(serverUrl) ? 'wss' : 'ws'
    let url = serverUrl.replace(/^wss?:\/\//, '').replace(/\/+$/, '')
    let str = `troparcel://${scheme}/${url}`
    if (opts.room) str += `/${encodeURIComponent(opts.room)}`
    if (opts.roomToken) str += `?token=${encodeURIComponent(opts.roomToken)}`
    return str
  }

  if (transport === 'file') {
    let dir = (opts.syncDir || '').replace(/^\//, '')
    return `troparcel://file/${dir}`
  }

  return ''
}

module.exports = { parseConnectionString, generateConnectionString }
