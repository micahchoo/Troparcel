'use strict'

/**
 * Parse a troparcel:// connection string into option fields.
 *
 * Formats:
 *   troparcel://ws/host:port/room?token=secret   a Troparcel server
 *   troparcel://wss/host:port/room?token=secret  the same, over TLS
 *   troparcel://file/path/to/shared/folder       a shared folder
 *
 * `photos=1` in the query makes a project room: photos travel with the
 * room, and items a member lacks are imported (option `sharePhotos`).
 * `key=<43 characters>` encrypts the room end to end (option `roomKey`).
 * Anyone with the string can read the room: share it like a password.
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
  if (params.photos === '1') result.sharePhotos = true
  if (params.key) result.roomKey = params.key

  return result
}

function _parseFile(rest) {
  let [pathPart, query] = rest.split('?', 2)
  let result = {
    transport: 'file',
    syncDir: '/' + pathPart.replace(/^\//, '')
  }
  let params = _parseQuery(query)
  if (params.photos === '1') result.sharePhotos = true
  if (params.key) result.roomKey = params.key
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
    let serverUrl = opts.serverUrl || 'ws://localhost:2468'
    let scheme = /^wss:/i.test(serverUrl) ? 'wss' : 'ws'
    let url = serverUrl.replace(/^wss?:\/\//, '').replace(/\/+$/, '')
    let str = `troparcel://${scheme}/${url}`
    if (opts.room) str += `/${encodeURIComponent(opts.room)}`
    let query = []
    if (opts.roomToken) query.push(`token=${encodeURIComponent(opts.roomToken)}`)
    if (opts.sharePhotos) query.push('photos=1')
    if (opts.roomKey) query.push(`key=${opts.roomKey}`)
    return query.length ? `${str}?${query.join('&')}` : str
  }

  if (transport === 'file') {
    let dir = (opts.syncDir || '').replace(/^\//, '')
    let query = []
    if (opts.sharePhotos) query.push('photos=1')
    if (opts.roomKey) query.push(`key=${opts.roomKey}`)
    return `troparcel://file/${dir}${query.length ? `?${query.join('&')}` : ''}`
  }

  return ''
}

module.exports = { parseConnectionString, generateConnectionString }
