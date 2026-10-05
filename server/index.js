#!/usr/bin/env node

'use strict'

/**
 * Troparcel Collaboration Server v4.0
 *
 * Yjs CRDT sync server with LevelDB persistence and monitoring.
 *
 * Uses y-websocket's sync protocol for Yjs document synchronization,
 * y-leveldb for persistent CRDT state, and adds:
 *   - Room-token authentication (timing-safe comparison)
 *   - Per-IP connection rate limiting
 *   - Periodic LevelDB compaction (6h) with time-based tombstone purge
 *   - Health/status REST endpoints
 *   - SSE live activity streams
 *   - HTML monitor dashboard
 *
 * Usage:
 *   node server/index.js
 *   PORT=2468 AUTH_TOKENS=room1:secret1,room2:secret2 node server/index.js
 *
 * Environment variables:
 *   PORT              - Listen port (default: 2468)
 *   HOST              - Bind address (default: 0.0.0.0)
 *   PERSISTENCE_DIR   - LevelDB directory (default: ./data)
 *   AUTH_TOKENS       - Comma-separated room:token pairs
 *   MAX_ROOMS         - Max concurrent rooms (default: 100)
 *   MAX_CONNS_PER_IP  - Max WebSocket connections per IP (default: 10)
 *   MONITOR_ORIGIN    - Allowed CORS origin for monitor API
 *   MONITOR_TOKEN     - Auth token for monitor endpoints
 *   MAX_ACTIVITY_LOG  - Ring buffer size for activity events (default: 200)
 *   MIN_TOKEN_LENGTH  - Minimum token length for security (default: 16)
 *   COMPACTION_HOURS  - Hours between LevelDB compaction runs (default: 6)
 *   TOMBSTONE_MAX_DAYS - Days to keep tombstones before purging (default: 30)
 *   MAX_BLOB_MB       - Largest photo a room may store, in MB (default: 200)
 *   PUBLIC_URL        - The address collaborators use, e.g. wss://tropy.example.edu
 *                       (default: ws://<this machine's LAN address>:<PORT>)
 */

const crypto = require('crypto')

// `node index.js --new-key` prints a key for an end-to-end encrypted room
// and exits. The server stores nothing: the key lives only in the
// connection strings the coordinator hands out.
if (process.argv.includes('--new-key')) {
  console.log(crypto.randomBytes(32).toString('base64url'))
  process.exit(0)
}
const fs = require('fs')
const path = require('path')
const http = require('http')
const WebSocket = require('ws')
const Y = require('yjs')
const { setupWSConnection, getYDoc, setPersistence, docs } = require('y-websocket/bin/utils')
const { LeveldbPersistence } = require('y-leveldb')
const { purgeTombstones } = require('../src/purge')
const { generateConnectionString } = require('../src/connection-string')
const os = require('os')

// --- Configuration ---

const PORT = parseInt(process.env.PORT, 10) || 2468
const HOST = process.env.HOST || '0.0.0.0'
const PERSISTENCE_DIR = process.env.PERSISTENCE_DIR || './data'
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS, 10) || 100
const MAX_BLOB_BYTES = (parseInt(process.env.MAX_BLOB_MB, 10) || 200) * 1024 * 1024
const MAX_CONNS_PER_IP = parseInt(process.env.MAX_CONNS_PER_IP, 10) || 10
const MONITOR_ORIGIN = process.env.MONITOR_ORIGIN || ''
const MONITOR_TOKEN = process.env.MONITOR_TOKEN || ''
const MAX_ACTIVITY_LOG = parseInt(process.env.MAX_ACTIVITY_LOG, 10) || 200
const MIN_TOKEN_LENGTH = parseInt(process.env.MIN_TOKEN_LENGTH, 10) || 16
const COMPACTION_HOURS = parseInt(process.env.COMPACTION_HOURS, 10) || 6
const TOMBSTONE_MAX_DAYS = parseInt(process.env.TOMBSTONE_MAX_DAYS, 10) || 30

// --- Auth token parsing ---

const AUTH_TOKENS = new Map()
if (process.env.AUTH_TOKENS) {
  for (let pair of process.env.AUTH_TOKENS.split(',')) {
    let idx = pair.indexOf(':')
    if (idx > 0) {
      let room = pair.slice(0, idx).trim()
      let token = pair.slice(idx + 1).trim()
      if (room && token) {
        if (token.length < MIN_TOKEN_LENGTH) {
          console.warn(
            `Warning: token for room "${room}" is shorter than ${MIN_TOKEN_LENGTH} characters`
          )
        }
        AUTH_TOKENS.set(room, token)
      }
    }
  }
}

function safeTokenCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  let bufA = Buffer.from(a)
  let bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA) // constant-time even on length mismatch
    return false
  }
  return crypto.timingSafeEqual(bufA, bufB)
}

// --- LevelDB persistence ---

const ldb = new LeveldbPersistence(PERSISTENCE_DIR)

// Origin marker for updates produced by replaying persisted state.
// The persistence handler must skip these to avoid re-storing the
// loaded bytes back into LevelDB on every reconnect.
const BIND_STATE_ORIGIN = Symbol('bindState')

setPersistence({
  bindState: async (docName, ydoc) => {
    // Register the persistence handler BEFORE awaiting the LevelDB load.
    // y-websocket's getYDoc() calls bindState without awaiting; sync
    // messages arriving during the await window (the first peer's
    // sync-step-2 carrying their writes) update the in-memory doc but
    // bypass storage entirely if the handler isn't yet registered. The
    // empirical signature was "schemaSize=N after Y.applyUpdate(2 bytes)"
    // — the doc held pre-bindState writes that never reached LevelDB.
    // Origin filter skips the self-trigger from replaying loaded state.
    ydoc.on('update', async (update, origin) => {
      if (origin === BIND_STATE_ORIGIN) return
      await ldb.storeUpdate(docName, update)
    })
    let stored = await ldb.getYDoc(docName)
    let update = Y.encodeStateAsUpdate(stored)
    Y.applyUpdate(ydoc, update, BIND_STATE_ORIGIN)
  },
  writeState: async (docName) => {
    // y-websocket-utils calls writeState before doc.destroy() on
    // last-peer-disconnect. Flush merges queued updates and ensures they
    // are durably persisted (and clock-advanced) before the in-memory doc
    // is evicted, so a late-joining peer reconstructed via getYDoc() sees
    // all prior writes. Closes mx-c38ee9.
    await ldb.flushDocument(docName)
  }
})

// --- Rate limiting ---

const connsByIp = new Map()

function checkRateLimit(ip) {
  return (connsByIp.get(ip) || 0) < MAX_CONNS_PER_IP
}

function trackConnection(ip) {
  connsByIp.set(ip, (connsByIp.get(ip) || 0) + 1)
}

function untrackConnection(ip) {
  let count = connsByIp.get(ip) || 0
  if (count <= 1) connsByIp.delete(ip)
  else connsByIp.set(ip, count - 1)
}

// --- Room name sanitization ---

const ROOM_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,127}$/

/** Whether `token` opens `roomName`. A room with no token is open. */
function roomAllowed(roomName, token) {
  let expected = AUTH_TOKENS.get(roomName)
  return !expected || safeTokenCompare(expected, token || '')
}

function sanitizeRoomName(raw) {
  if (ROOM_NAME_RE.test(raw)) return raw
  let clean = raw.replace(/[^a-zA-Z0-9_. -]/g, '').slice(0, 128)
  return clean || 'default'
}

// --- Room metadata (monitoring) ---

const roomMeta = new Map()
const roomConns = new Map() // roomName -> Set<ws>

function getRoomMeta(name) {
  if (!roomMeta.has(name)) {
    roomMeta.set(name, {
      created: new Date(),
      lastActivity: new Date(),
      totalSyncs: 0,
      activityLog: [],
      updateHooked: false
    })
  }
  let meta = roomMeta.get(name)
  meta.lastActivity = new Date()
  return meta
}

function getRoomConns(name) {
  if (!roomConns.has(name)) {
    roomConns.set(name, new Set())
  }
  return roomConns.get(name)
}

// --- SSE subscriber tracking ---

const sseSubscribers = new Map()

function logRoomEvent(roomName, event) {
  let meta = roomMeta.get(roomName)
  if (!meta) return

  let entry = { ...event, ts: new Date().toISOString() }

  meta.activityLog.push(entry)
  if (meta.activityLog.length > MAX_ACTIVITY_LOG) {
    meta.activityLog.shift()
  }

  let subs = sseSubscribers.get(roomName)
  if (subs && subs.size > 0) {
    let data = JSON.stringify(entry)
    for (let res of subs) {
      try {
        res.write(`event: activity\ndata: ${data}\n\n`)
      } catch {
        subs.delete(res)
      }
    }
  }
}

function maskIp(ip) {
  if (!ip) return '?'
  if (ip.includes('.')) {
    let parts = ip.split('.')
    return parts[0] + '.' + parts[1] + '.x.x'
  }
  let parts = ip.split(':')
  return parts.slice(0, 4).join(':') + '::x'
}

// --- Monitor auth ---

function checkMonitorAuth(req, res) {
  if (!MONITOR_TOKEN) return true
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host}`)
  } catch {
    return true
  }
  let token = url.searchParams.get('token') || ''
  if (!safeTokenCompare(MONITOR_TOKEN, token)) {
    res.writeHead(401)
    jsonReply(res, { error: 'Unauthorized' })
    return false
  }
  return true
}

// --- WebSocket connection handler ---

function handleConnection(ws, req) {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host}`)
  } catch {
    ws.close(4000, 'Bad URL')
    return
  }

  let ip = req.socket.remoteAddress || 'unknown'
  let rawRoom = decodeURIComponent(url.pathname.slice(1)) || 'default'
  let roomName = sanitizeRoomName(rawRoom)
  let token = url.searchParams.get('token') || ''

  if (!roomAllowed(roomName, token)) {
    console.warn(`Auth failed for room "${roomName}" from ${ip}`)
    ws.close(4001, 'Unauthorized')
    return
  }

  // Rate limit check
  if (!checkRateLimit(ip)) {
    console.warn(`Rate limit exceeded for ${ip}`)
    ws.close(4003, 'Too many connections')
    return
  }

  // Room limit check
  if (!roomMeta.has(roomName) && roomMeta.size >= MAX_ROOMS) {
    ws.close(4002, 'Room limit reached')
    return
  }

  trackConnection(ip)

  // Set up room metadata and monitoring
  let meta = getRoomMeta(roomName)
  let conns = getRoomConns(roomName)
  conns.add(ws)

  // Hook into doc updates for sync counting (once per room)
  if (!meta.updateHooked) {
    meta.updateHooked = true
    let doc = getYDoc(roomName)
    doc.on('update', () => {
      meta.totalSyncs++
      meta.lastActivity = new Date()
    })
  }

  console.log(`+conn: "${roomName}" (${conns.size} total) from ${ip}`)

  // Delegate to y-websocket's Yjs sync protocol
  setupWSConnection(ws, req, { docName: roomName })

  logRoomEvent(roomName, {
    type: 'connect',
    ip: maskIp(ip),
    connections: conns.size
  })

  // Handle close for monitoring
  ws.on('close', () => {
    conns.delete(ws)
    untrackConnection(ip)
    console.log(`-conn: "${roomName}" (${conns.size} remaining)`)

    logRoomEvent(roomName, {
      type: 'disconnect',
      ip: maskIp(ip),
      connections: conns.size
    })

    // Schedule cleanup of empty rooms
    if (conns.size === 0) {
      setTimeout(() => {
        let c = roomConns.get(roomName)
        if (c && c.size === 0) {
          roomConns.delete(roomName)
          roomMeta.delete(roomName)
          console.log(`Room cleaned up: "${roomName}"`)
        }
      }, 60000)
    }
  })

  ws.on('error', (err) => {
    console.error(`WS error in "${roomName}": ${err.message}`)
  })
}

// --- HTTP request handler ---

/**
 * Photos of a project room, stored under their MD5 checksum (Tropy's own
 * name for a photo). GET returns one; PUT stores one, and refuses a body
 * whose MD5 is not its name. The room's token is required, as for the
 * room itself: `?token=` or `Authorization: Bearer`.
 */
async function handleBlob(req, res, roomName, md5, url) {
  let auth = req.headers.authorization || ''
  let token = url.searchParams.get('token') || (auth.startsWith('Bearer ') ? auth.slice(7) : '')
  if (!roomAllowed(roomName, token)) {
    res.writeHead(401)
    return res.end('Unauthorized')
  }
  let dir = path.join(PERSISTENCE_DIR, 'blobs', roomName)
  let file = path.join(dir, md5)

  if (req.method === 'GET' || req.method === 'HEAD') {
    let stat
    try { stat = await fs.promises.stat(file) } catch {
      res.writeHead(404)
      return res.end()
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size })
    if (req.method === 'HEAD') return res.end()
    return fs.createReadStream(file).pipe(res)
  }

  if (req.method === 'PUT') {
    if (fs.existsSync(file)) {
      req.resume()
      res.writeHead(204)
      return res.end()
    }
    let chunks = []
    let size = 0
    for await (let chunk of req) {
      size += chunk.length
      if (size > MAX_BLOB_BYTES) {
        res.writeHead(413)
        return res.end(`larger than ${MAX_BLOB_BYTES / 1024 / 1024} MB (MAX_BLOB_MB)`)
      }
      chunks.push(chunk)
    }
    let body = Buffer.concat(chunks)
    // A sealed photo (an encrypted room) is ciphertext under an HMAC name:
    // only its members can check it, and they do.
    let sealed = req.headers['x-troparcel-sealed'] === '1'
    if (!sealed && crypto.createHash('md5').update(body).digest('hex') !== md5) {
      res.writeHead(400)
      return res.end('the body\'s MD5 is not its name')
    }
    await fs.promises.mkdir(dir, { recursive: true })
    let tmp = `${file}.${process.pid}.part`
    await fs.promises.writeFile(tmp, body)
    await fs.promises.rename(tmp, file)
    res.writeHead(201)
    return res.end()
  }

  res.writeHead(405)
  res.end()
}

async function handleHttp(req, res) {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host}`)
  } catch {
    res.writeHead(400)
    res.end('Bad URL')
    return
  }

  if (MONITOR_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', MONITOR_ORIGIN)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  let urlPath = url.pathname

  if (urlPath === '/health') {
    jsonReply(res, { status: 'healthy', timestamp: new Date().toISOString() })
    return
  }

  let blob = urlPath.match(/^\/blobs\/([^/]+)\/([0-9a-f]{32})$/)
  if (blob) return handleBlob(req, res, sanitizeRoomName(decodeURIComponent(blob[1])), blob[2], url)

  if (urlPath === '/api/status') {
    if (!checkMonitorAuth(req, res)) return
    jsonReply(res, {
      status: 'running',
      port: PORT,
      version: 'v4.0-yjs',
      uptime: process.uptime(),
      rooms: roomMeta.size,
      connections: totalConnections(),
      persistence: PERSISTENCE_DIR,
      authEnabled: AUTH_TOKENS.size > 0
    })
    return
  }

  if (urlPath === '/api/rooms') {
    if (!checkMonitorAuth(req, res)) return
    let list = []
    roomMeta.forEach((meta, name) => {
      let conns = roomConns.get(name)
      list.push({
        name,
        connections: conns ? conns.size : 0,
        created: meta.created,
        lastActivity: meta.lastActivity,
        totalSyncs: meta.totalSyncs,
        authRequired: AUTH_TOKENS.has(name)
      })
    })
    jsonReply(res, { rooms: list, count: list.length })
    return
  }

  // SSE endpoint: /api/rooms/:name/events
  let eventsMatch = urlPath.match(/^\/api\/rooms\/(.+)\/events$/)
  if (eventsMatch) {
    let name = sanitizeRoomName(decodeURIComponent(eventsMatch[1]))
    let meta = roomMeta.get(name)
    if (!meta) {
      res.writeHead(404)
      jsonReply(res, { error: 'Room not found' })
      return
    }

    let token = url.searchParams.get('token') || ''
    if (AUTH_TOKENS.size > 0) {
      let expected = AUTH_TOKENS.get(name)
      if (expected && !safeTokenCompare(expected, token)) {
        res.writeHead(401)
        jsonReply(res, { error: 'Unauthorized' })
        return
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    for (let entry of meta.activityLog) {
      res.write(`event: history\ndata: ${JSON.stringify(entry)}\n\n`)
    }
    res.write(`event: caught-up\ndata: {}\n\n`)

    if (!sseSubscribers.has(name)) {
      sseSubscribers.set(name, new Set())
    }
    sseSubscribers.get(name).add(res)

    req.on('close', () => {
      let subs = sseSubscribers.get(name)
      if (subs) {
        subs.delete(res)
        if (subs.size === 0) sseSubscribers.delete(name)
      }
    })
    return
  }

  // POST /api/rooms/:name/compact — manual compaction
  let compactMatch = urlPath.match(/^\/api\/rooms\/(.+)\/compact$/)
  if (compactMatch && req.method === 'POST') {
    if (!checkMonitorAuth(req, res)) return
    let roomName = sanitizeRoomName(decodeURIComponent(compactMatch[1]))
    try {
      let result = await compactAndPurge(roomName)
      jsonReply(res, {
        status: 'compacted', room: roomName,
        purged: result.purged,
        uuidsPurged: result.uuidsPurged,
        aliasesPurged: result.aliasesPurged
      })
    } catch (e) {
      res.writeHead(500)
      jsonReply(res, { error: 'Compaction failed', message: e.message })
    }
    return
  }

  // Room detail API: /api/rooms/:name
  if (urlPath.startsWith('/api/rooms/')) {
    if (!checkMonitorAuth(req, res)) return
    let name = sanitizeRoomName(
      decodeURIComponent(urlPath.slice('/api/rooms/'.length))
    )
    let meta = roomMeta.get(name)
    if (!meta) {
      res.writeHead(404)
      jsonReply(res, { error: 'Room not found' })
      return
    }

    let conns = roomConns.get(name)
    jsonReply(res, {
      name,
      connections: conns ? conns.size : 0,
      created: meta.created,
      lastActivity: meta.lastActivity,
      totalSyncs: meta.totalSyncs
    })
    return
  }

  // Room detail page: /monitor/room/:name
  if (urlPath.startsWith('/monitor/room/')) {
    if (!checkMonitorAuth(req, res)) return
    let name = decodeURIComponent(urlPath.slice('/monitor/room/'.length))
    res.setHeader('Content-Type', 'text/html')
    res.writeHead(200)
    res.end(roomDetailHtml(name))
    return
  }

  if (urlPath === '/monitor') {
    if (!checkMonitorAuth(req, res)) return
    res.setHeader('Content-Type', 'text/html')
    res.writeHead(200)
    res.end(monitorHtml())
    return
  }

  res.writeHead(404)
  jsonReply(res, { error: 'Not found' })
}

function jsonReply(res, data) {
  if (!res.headersSent) res.writeHead(200)
  res.end(JSON.stringify(data, null, 2))
}

function totalConnections() {
  let total = 0
  roomConns.forEach(c => { total += c.size })
  return total
}

// --- Monitor HTML ---

function monitorHtml() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Troparcel Server v4.0</title>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e1e4e8; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #79b8ff; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card { background: #1c2028; border-radius: 8px; padding: 1.25rem; border: 1px solid #2d333b; }
    .card h3 { font-size: 0.85rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
    .card .value { font-size: 2rem; font-weight: 600; }
    .room { background: #1c2028; border: 1px solid #2d333b; border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; }
    .room h4 { color: #79b8ff; margin-bottom: 0.5rem; }
    .room .meta { font-size: 0.85rem; color: #8b949e; }
    .status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .status.on { background: #3fb950; }
    .badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.7rem; background: #1b4721; color: #3fb950; }
    #rooms-list { margin-top: 1rem; }
    .refresh { color: #8b949e; font-size: 0.8rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>Troparcel Server <span class="badge">v4.0 Yjs</span></h1>
  <div class="grid">
    <div class="card"><h3>Status</h3><div class="value" id="status"><span class="status on"></span>Running</div></div>
    <div class="card"><h3>Rooms</h3><div class="value" id="room-count">-</div></div>
    <div class="card"><h3>Connections</h3><div class="value" id="conn-count">-</div></div>
    <div class="card"><h3>Uptime</h3><div class="value" id="uptime">-</div></div>
  </div>
  <h1>Active Rooms</h1>
  <div id="rooms-list"></div>
  <div class="refresh">Auto-refreshes every 5 seconds</div>
  <script>
    async function refresh() {
      try {
        let [status, rooms] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/rooms').then(r => r.json())
        ]);
        document.getElementById('room-count').textContent = status.rooms;
        document.getElementById('conn-count').textContent = status.connections;
        document.getElementById('uptime').textContent = formatUptime(status.uptime);
        let html = '';
        for (let room of rooms.rooms) {
          html += '<div class="room">'
            + '<h4><a href="/monitor/room/' + encodeURIComponent(room.name) + '" style="color:#79b8ff;text-decoration:none;">' + esc(room.name) + '</a></h4>'
            + '<div class="meta">'
            + room.connections + ' peer(s) &middot; '
            + room.totalSyncs + ' sync(s) &middot; '
            + 'active ' + ago(room.lastActivity)
            + (room.authRequired ? ' &middot; <span style="color:#d29922;">auth</span>' : '')
            + '</div></div>';
        }
        document.getElementById('rooms-list').innerHTML = html || '<div class="room"><div class="meta">No active rooms</div></div>';
      } catch(e) { console.error(e); }
    }
    function formatUptime(s) {
      if (s < 60) return Math.floor(s) + 's';
      if (s < 3600) return Math.floor(s/60) + 'm';
      if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
      return Math.floor(s/86400) + 'd ' + Math.floor((s%86400)/3600) + 'h';
    }
    function ago(ts) { let d = (Date.now() - new Date(ts)) / 1000; return formatUptime(d) + ' ago'; }
    function esc(s) { let d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function roomDetailHtml(name) {
  let safeName = escHtml(name)
  return `<!DOCTYPE html>
<html>
<head>
  <title>Room: ${safeName} — Troparcel</title>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e1e4e8; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #79b8ff; }
    a { color: #79b8ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .back { margin-bottom: 1.5rem; display: inline-block; font-size: 0.9rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .card { background: #1c2028; border-radius: 8px; padding: 1rem; border: 1px solid #2d333b; }
    .card h3 { font-size: 0.8rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
    .card .value { font-size: 1.5rem; font-weight: 600; }
    #feed { max-height: 70vh; overflow-y: auto; }
    .event { background: #1c2028; border: 1px solid #2d333b; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; font-size: 0.85rem; }
    .event .time { color: #8b949e; font-size: 0.8rem; margin-right: 0.75rem; }
    .event .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 3px; font-size: 0.75rem; font-weight: 600; margin-right: 0.5rem; }
    .badge.connect { background: #0d419d; color: #79b8ff; }
    .badge.disconnect { background: #3d1f00; color: #d29922; }
    .status-msg { color: #8b949e; font-size: 0.85rem; margin-bottom: 1rem; }
    .auth-box { background: #1c2028; border: 1px solid #2d333b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; max-width: 400px; }
    .auth-box label { display: block; margin-bottom: 0.5rem; color: #8b949e; font-size: 0.9rem; }
    .auth-box input { width: 100%; padding: 0.5rem; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #e1e4e8; }
    .auth-box button { margin-top: 0.75rem; padding: 0.5rem 1.25rem; background: #238636; border: none; border-radius: 4px; color: #fff; cursor: pointer; }
    .auth-error { color: #f85149; margin-top: 0.5rem; font-size: 0.85rem; display: none; }
    #stream-section { display: none; }
  </style>
</head>
<body>
  <a href="/monitor" class="back">&larr; Back to Dashboard</a>
  <h1>Room: ${safeName}</h1>
  <div class="grid" id="room-stats" style="display:none;">
    <div class="card"><h3>Peers</h3><div class="value" id="stat-conns">-</div></div>
    <div class="card"><h3>Syncs</h3><div class="value" id="stat-syncs">-</div></div>
    <div class="card"><h3>Last Active</h3><div class="value" id="stat-active" style="font-size:1rem;">-</div></div>
  </div>
  <div id="auth-section">
    <div class="auth-box" id="auth-box" style="display:none;">
      <label for="token-input">Room token required:</label>
      <input type="password" id="token-input" placeholder="Enter room token" autocomplete="off">
      <button id="auth-btn">Connect</button>
      <div class="auth-error" id="auth-error">Invalid token.</div>
    </div>
    <div class="status-msg" id="loading-msg">Checking room...</div>
  </div>
  <div id="stream-section">
    <h2 style="font-size:1.1rem; color:#e1e4e8; margin-bottom:0.75rem;">Live Activity</h2>
    <div class="status-msg" id="stream-status">Connecting...</div>
    <div id="feed"></div>
  </div>
  <script>
    let roomName = ${JSON.stringify(name).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')};
    function esc(s) { let d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function fmtTime(ts) { return new Date(ts).toLocaleTimeString(); }
    function renderEvent(ev) {
      let badge = '<span class="badge ' + esc(ev.type) + '">' + esc(ev.type) + '</span>';
      let detail = JSON.stringify(ev);
      if (ev.type === 'connect') detail = 'Peer connected from ' + esc(ev.ip||'') + ' (' + ev.connections + ' total)';
      if (ev.type === 'disconnect') detail = 'Peer disconnected (' + ev.connections + ' remaining)';
      return '<div class="event"><span class="time">' + fmtTime(ev.ts) + '</span>' + badge + detail + '</div>';
    }
    function addEvent(ev) {
      let feed = document.getElementById('feed');
      feed.insertAdjacentHTML('afterbegin', renderEvent(ev));
      while (feed.children.length > 500) feed.removeChild(feed.lastChild);
    }
    function connectSSE(token) {
      let url = '/api/rooms/' + encodeURIComponent(roomName) + '/events';
      if (token) url += '?token=' + encodeURIComponent(token);
      let es = new EventSource(url);
      es.addEventListener('history', e => { try { addEvent(JSON.parse(e.data)); } catch {} });
      es.addEventListener('caught-up', () => { document.getElementById('stream-status').textContent = 'Connected — streaming live events'; });
      es.addEventListener('activity', e => { try { addEvent(JSON.parse(e.data)); } catch {} });
      es.onerror = () => { document.getElementById('stream-status').textContent = 'Disconnected — retrying...'; };
    }
    async function loadRoom(token) {
      document.getElementById('loading-msg').textContent = 'Loading...';
      try {
        let resp = await fetch('/api/rooms');
        let data = await resp.json();
        let room = data.rooms.find(r => r.name === roomName);
        if (!room) {
          document.getElementById('loading-msg').textContent = 'Room not found (inactive).';
          setTimeout(() => loadRoom(token), 5000);
          return;
        }
        document.getElementById('room-stats').style.display = 'grid';
        document.getElementById('stat-conns').textContent = room.connections;
        document.getElementById('stat-syncs').textContent = room.totalSyncs;
        document.getElementById('stat-active').textContent = new Date(room.lastActivity).toLocaleString();
        if (room.authRequired && !token) {
          document.getElementById('loading-msg').textContent = '';
          document.getElementById('auth-box').style.display = 'block';
          return;
        }
        document.getElementById('loading-msg').style.display = 'none';
        document.getElementById('auth-box').style.display = 'none';
        document.getElementById('stream-section').style.display = 'block';
        connectSSE(token);
      } catch (e) {
        document.getElementById('loading-msg').textContent = 'Error: ' + e.message;
      }
    }
    document.getElementById('auth-btn').addEventListener('click', function() {
      let token = document.getElementById('token-input').value;
      if (!token) return;
      document.getElementById('auth-error').style.display = 'none';
      fetch('/api/rooms/' + encodeURIComponent(roomName) + '/events?token=' + encodeURIComponent(token))
        .then(resp => {
          if (resp.status === 401) { document.getElementById('auth-error').style.display = 'block'; resp.body.cancel(); return; }
          resp.body.cancel();
          document.getElementById('auth-box').style.display = 'none';
          document.getElementById('loading-msg').style.display = 'none';
          document.getElementById('stream-section').style.display = 'block';
          connectSSE(token);
        })
        .catch(() => { document.getElementById('auth-error').textContent = 'Connection failed.'; document.getElementById('auth-error').style.display = 'block'; });
    });
    document.getElementById('token-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('auth-btn').click(); });
    setInterval(async () => {
      try {
        let data = await fetch('/api/rooms').then(r => r.json());
        let room = data.rooms.find(r => r.name === roomName);
        if (room) {
          document.getElementById('room-stats').style.display = 'grid';
          document.getElementById('stat-conns').textContent = room.connections;
          document.getElementById('stat-syncs').textContent = room.totalSyncs;
          document.getElementById('stat-active').textContent = new Date(room.lastActivity).toLocaleString();
        }
      } catch {}
    }, 5000);
    loadRoom(null);
  </script>
</body>
</html>`
}

// --- LevelDB compaction + tombstone purge ---

/**
 * Purge old tombstones from a room, then merge its stored updates.
 *
 * An open room is purged in memory, and y-websocket persists and relays
 * the change. A closed room is loaded from LevelDB, purged, and the purge
 * stored as an update: changing a loaded copy alone persists nothing.
 */
async function compactAndPurge(docName, maxAgeMs) {
  if (maxAgeMs == null) maxAgeMs = TOMBSTONE_MAX_DAYS * 24 * 60 * 60 * 1000

  let live = docs.get(docName)
  let doc = live || await ldb.getYDoc(docName)
  let updates = []
  let capture = update => updates.push(update)
  if (!live) doc.on('update', capture)

  let result
  doc.transact(() => { result = purgeTombstones(doc, maxAgeMs) })

  if (!live) {
    doc.off('update', capture)
    for (let update of updates) await ldb.storeUpdate(docName, update)
    doc.destroy()
  }
  await ldb.flushDocument(docName)
  return { ...result, docName }
}

async function runCompaction() {
  try {
    let docNames = await ldb.getAllDocNames()
    console.log(`[compaction] Starting compaction for ${docNames.length} room(s)`)
    for (let name of docNames) {
      try {
        let result = await compactAndPurge(name)
        let parts = []
        if (result.purged > 0) parts.push(`${result.purged} tombstone(s)`)
        if (result.uuidsPurged > 0) parts.push(`${result.uuidsPurged} orphaned UUID(s)`)
        if (result.aliasesPurged > 0) parts.push(`${result.aliasesPurged} expired alias(es)`)
        if (parts.length > 0) {
          console.log(`[compaction] Room "${name}": purged ${parts.join(', ')}`)
        } else {
          console.log(`[compaction] Room "${name}": compacted (nothing to purge)`)
        }
      } catch (e) {
        console.error(`[compaction] Failed for "${name}":`, e.message)
      }
    }
  } catch (e) {
    console.error('[compaction] Failed to list rooms:', e.message)
  }
}

// --- Server startup ---

const server = http.createServer(handleHttp)
const wss = new WebSocket.Server({ server })

wss.on('connection', handleConnection)

/** The address collaborators reach this server at. */
function publicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '')
  if (HOST !== '0.0.0.0' && HOST !== '::') return `ws://${HOST}:${PORT}`
  for (let addrs of Object.values(os.networkInterfaces())) {
    for (let a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return `ws://${a.address}:${PORT}`
    }
  }
  return `ws://localhost:${PORT}`
}

/** What a collaborator pastes into Troparcel's Connection field. */
function connectionString(room, token) {
  return generateConnectionString({ transport: 'websocket', serverUrl: publicUrl(), room, roomToken: token })
}

server.listen(PORT, HOST, () => {
  console.log(`Troparcel server listening on ${HOST}:${PORT}`)
  console.log('')
  if (AUTH_TOKENS.size > 0) {
    console.log('  Give each group its connection string (Troparcel > Connection):')
    for (let [room, token] of AUTH_TOKENS) console.log(`    ${room}: ${connectionString(room, token)}`)
  } else {
    console.log('  Connection string (replace <room> with your group\'s room name):')
    console.log(`    ${connectionString('ROOM').replace('/ROOM', '/<room>')}`)
  }
  console.log('')
  console.log(`  WebSocket: ws://${HOST}:${PORT}/<room-name>?token=<token>`)
  console.log(`  Monitor:   http://${HOST}:${PORT}/monitor`)
  console.log(`  Health:    http://${HOST}:${PORT}/health`)
  console.log(`  Limits:    ${MAX_ROOMS} rooms, ${MAX_CONNS_PER_IP} conns/IP`)
  console.log(`  Persist:   ${PERSISTENCE_DIR}`)
  if (AUTH_TOKENS.size > 0) {
    console.log(`  Auth:      ${AUTH_TOKENS.size} room token(s) configured`)
  }
  if (MONITOR_TOKEN) {
    console.log(`  Monitor:   protected by MONITOR_TOKEN`)
  } else {
    console.log(`  Monitor:   WARNING — MONITOR_TOKEN not set, monitor endpoints are open`)
  }
  console.log(`  Compact:   every ${COMPACTION_HOURS}h, tombstones older than ${TOMBSTONE_MAX_DAYS}d`)
  console.log(`  ⚠ Tombstone retention: deletions older than ${TOMBSTONE_MAX_DAYS}d are purged.`)
  console.log(`    Clients offline longer than ${TOMBSTONE_MAX_DAYS}d may resurrect deleted items.`)
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log(`  ⚠ TLS: This server does not provide TLS. For remote collaboration,`)
    console.log(`    deploy behind a reverse proxy (nginx/caddy) with HTTPS/WSS.`)
    console.log(`    Without TLS, room tokens are sent in cleartext.`)
  }

  // Start periodic compaction
  let compactionIntervalMs = COMPACTION_HOURS * 60 * 60 * 1000
  setInterval(() => { runCompaction() }, compactionIntervalMs)
})

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...')
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1001, 'Server shutting down')
  })
  server.close(() => {
    ldb.destroy().then(() => {
      console.log('Server stopped')
      process.exit(0)
    }).catch(() => {
      process.exit(0)
    })
  })
})

process.on('SIGTERM', () => process.emit('SIGINT'))
