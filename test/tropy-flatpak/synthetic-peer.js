'use strict'

/**
 * Tier 3 — Synthetic peer driver for testing against real Flatpak Tropy.
 *
 * Setup:
 *   1) bash test/tropy-flatpak/install.sh   (install plugin into Flatpak data dir)
 *   2) flatpak run org.tropy.Tropy --port=2019    (start Tropy with HTTP API)
 *   3) Open a project; configure troparcel plugin (serverUrl + room)
 *   4) npm run server                        (in another terminal — y-websocket relay)
 *   5) node test/tropy-flatpak/synthetic-peer.js --room=<room>
 *
 * What it does:
 *   - Connects to the troparcel server in the same room as Tropy's plugin
 *   - Pushes a deterministic test payload (templates + lists + a note)
 *   - Polls Tropy's HTTP API to verify the writes appear in Tropy's project
 *   - Reports pass/fail per assertion
 *
 * Architecture-wise: synthetic peer = Bob; real Tropy = Alice. Bob runs
 * SyncEngine logic via the same crdt-schema setters; the plugin in Tropy
 * apply()s into the real Redux store; Bob verifies via Tropy's REST API.
 */

const Y = require('yjs')
const WS = require('ws')
const { WebsocketProvider } = require('y-websocket')
const schema = require('../../src/crdt-schema')

// --- arg parsing ---
function parseArgs(argv) {
  const args = {
    room: 'troparcel-test',
    server: 'ws://localhost:2468',
    tropyApi: 'http://localhost:2019',
    timeout: 30
  }
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/)
    if (m) args[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[2]
  }
  return args
}

const args = parseArgs(process.argv)

console.log('=== Troparcel Tier-3 synthetic peer ===')
console.log(`server:   ${args.server}`)
console.log(`room:     ${args.room}`)
console.log(`tropyApi: ${args.tropyApi}`)
console.log()

// --- check Tropy API is reachable ---
async function checkTropy() {
  try {
    const res = await fetch(`${args.tropyApi}/`, { method: 'GET' })
    if (!res.ok) {
      console.error(`✗ Tropy API responded ${res.status} — start Tropy with --port=2019`)
      return false
    }
    console.log('✓ Tropy API reachable')
    return true
  } catch (err) {
    console.error(`✗ Tropy API unreachable (${err.message}) — start Tropy with --port=2019`)
    return false
  }
}

// --- connect synthetic peer to the same room ---
function connect() {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(args.server, args.room, doc, {
    WebSocketPolyfill: WS,
    connect: true
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('peer connect timeout')), 10000)
    provider.on('status', ({ status }) => {
      if (status === 'connected') {
        clearTimeout(timer)
        resolve({ doc, provider })
      }
    })
  })
}

// --- push a deterministic payload as the synthetic peer ---
function pushPayload(doc) {
  const SYNTH = 'synth-peer-tier3'
  const pushSeq = Date.now()

  // Template
  const tmplUri = 'https://tropy.org/v1/templates/id#tier3-test'
  schema.setTemplateSchema(doc, tmplUri, {
    name: 'Tier 3 Test Template',
    type: 'https://tropy.org/v1/tropy#Item',
    creator: 'tier3-synthetic-peer',
    description: 'Pushed by synthetic peer to verify Tropy plugin apply path',
    fields: [
      { property: 'http://purl.org/dc/elements/1.1/title', label: 'Title',
        datatype: 'http://www.w3.org/2001/XMLSchema#string', isRequired: true }
    ]
  }, SYNTH, pushSeq)

  // List hierarchy
  schema.setListHierarchyEntry(doc, 'tier3-list-uuid-root', {
    name: 'Tier 3 Test List', parent: null, children: []
  }, SYNTH, pushSeq)

  return { tmplUri, listUuid: 'tier3-list-uuid-root' }
}

// --- poll Tropy API for verification ---
async function pollFor({ predicate, label, timeoutSec }) {
  const start = Date.now()
  while (Date.now() - start < timeoutSec * 1000) {
    try {
      const ok = await predicate()
      if (ok) {
        console.log(`✓ ${label}`)
        return true
      }
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, 500))
  }
  console.error(`✗ ${label} (timed out after ${timeoutSec}s)`)
  return false
}

// Real Tropy HTTP API routes verified against tropy/src/common/api.js (2026-05-08):
//   /                       — {project, status, version}
//   /version                — {version}
//   /project/items          — list of items
//   /project/lists          — root list (with /:id expand)
//   /project/lists/:id      — list detail
//   /project/lists/:id/items
//   /project/tags           — all tags
//   /project/items/:id      — single item
//   /project/data/:id       — metadata
// NOTE: there is NO HTTP API route for ontology.template — Tier 3 cannot
// directly verify template sync via REST. Verify indirectly (an item
// referencing the template, or via GUI). Tracked: tropy-plugin-<future>.

async function fetchTropyLists() {
  const res = await fetch(`${args.tropyApi}/project/lists`, { method: 'GET' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchTropyTags() {
  const res = await fetch(`${args.tropyApi}/project/tags`, { method: 'GET' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchTropyItems() {
  const res = await fetch(`${args.tropyApi}/project/items`, { method: 'GET' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// --- main ---
async function main() {
  if (!(await checkTropy())) process.exit(1)

  console.log('Connecting synthetic peer...')
  const { doc, provider } = await connect()
  console.log('✓ Synthetic peer connected to room')

  console.log('Pushing test payload...')
  const { tmplUri, listUuid } = pushPayload(doc)
  console.log(`✓ Pushed template ${tmplUri.split('#')[1]} + list ${listUuid}`)
  console.log()
  console.log('Verifying via Tropy HTTP API (polling for up to', args.timeout, 's)...')

  let pass = 0, fail = 0

  // Tropy has NO HTTP API for templates. Skip with explanation.
  console.log('⊝ Template verification SKIPPED — Tropy /project/templates does not exist.')
  console.log('  Verify template sync via GUI or via items that reference the template.')

  const verifyList = await pollFor({
    label: 'Tropy received list "Tier 3 Test List"',
    timeoutSec: args.timeout,
    predicate: async () => {
      const lists = await fetchTropyLists()
      // /project/lists returns { id, name, parent, children, items? }
      // For the root list, children expand to nested lists
      const flat = []
      const walk = (node) => {
        if (!node) return
        flat.push(node)
        if (Array.isArray(node.children)) {
          for (const c of node.children) walk(c)
        }
      }
      if (Array.isArray(lists)) lists.forEach(walk)
      else walk(lists)
      return flat.some(l => l && l.name === 'Tier 3 Test List')
    }
  })
  verifyList ? pass++ : fail++

  console.log()
  console.log(`Results: ${pass} passed, ${fail} failed`)
  console.log()
  console.log('NOTE: only list sync is verified via HTTP API (no template route).')
  console.log('Template sync requires GUI verification — open Tropy and check the')
  console.log('Templates panel, or look for items using the template URI.')

  provider.destroy()
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('FATAL:', err.message)
  process.exit(2)
})
