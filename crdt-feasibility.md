# CRDT Feasibility: What Tropy Exposes to Plugins

This document maps each element of the CRDT design against what Tropy's plugin system and HTTP API actually allow. The goal is to determine what's achievable today, what requires workarounds, and what's impossible without modifying Tropy's core.

---

## Plugin Runtime Environment

### What a Plugin Is

A plugin is a CommonJS module with a `package.json` declaring hooks. Tropy instantiates it in the **renderer process** with:

```js
new Plugin(options, context)
```

**Context object** (from `src/window.js:44-49`):

```js
{
  logger,    // Pino logger (trace/debug/info/warn/error/fatal)
  dialog,    // File dialogs, notifications, prompts
  json,      // JSON-LD expand/compact/parse/write
  sharp,     // Image processing (open, resize, convert)
  window     // The Window singleton (Electron renderer)
}
```

### Node.js Access

Electron's web preferences (`src/main/wm.js:43-46`):
```js
contextIsolation: true,
nodeIntegration: false,
sandbox: false,
preload: join(Resource.base, 'lib/bootstrap.mjs')
```

`nodeIntegration` is false, but `sandbox` is also false. The preload script (`src/bootstrap.js`) runs with full Node.js access and bootstraps the window. Plugins are loaded via dynamic `import()` of `file://` URLs in the preload context (`src/common/plugins.js:190`), meaning they **do have full Node.js access** — they can `require('http')`, `require('fs')`, open sockets, spawn processes, etc.

**Confirmed**: `eval()` is explicitly blocked (`src/bootstrap.js:69-71`), but `require`/`import` work normally.

### UI Modification

Plugins **cannot** modify Tropy's UI. There is no component injection API, no menu extension point, no panel/sidebar/toolbar hook. The React components in `src/components/plugin/` are Tropy's own settings UI for configuring plugin options — they render the `options` array from `package.json`, not plugin-provided components.

A plugin's only UI surface is:
- `context.dialog.notify(id, opts)` — system notification
- `context.dialog.open(opts)` — file open dialog
- `context.dialog.save(opts)` — file save dialog
- `context.dialog.prompt(id, opts)` — prompt dialog

No custom windows, no DOM injection, no React component registration.

---

## Plugin Hooks

### Export Hook

```js
async export(data) { ... }
```

**What `data` is**: The full JSON-LD export of selected items, produced by `getExportItems()` in `src/selectors/export.js`. Structure:

```json
{
  "@context": { /* JSON-LD context with RDF namespaces */ },
  "@graph": [
    {
      "@type": "Item",
      "template": "https://tropy.org/v1/templates/generic",
      "tag": ["tag1", "tag2"],
      "list": ["list1"],
      "dc:title": "value or { @type, @value }",
      "photo": [
        {
          "@type": "Photo",
          "checksum": "sha256...",
          "path": "/local/path.jpg",
          "mimetype": "image/jpeg",
          "note": [{ "@type": "Note", "html": "...", "text": "..." }],
          "selection": [{ "@type": "Selection", "x": 100, "y": 50, ... }],
          "transcription": [{ "@type": "Transcription", "text": "..." }]
        }
      ]
    }
  ],
  "version": "v2.x.y"
}
```

**Trigger**: User manually selects items → right-click → Export → Plugin. This is a **user-initiated action**, not automatic.

**Return value**: Ignored. The export hook is fire-and-forget.

### Import Hook

```js
async import(payload, meta) { ... }
```

**What it receives**: A mutable `payload` object. The plugin can set `payload.data` to an array of JSON-LD items, which Tropy will then import via `importFromJSON()`.

**Trigger**: User manually invokes import via the plugin. User-initiated only.

**What Tropy does with `payload.data`**: Normalizes the JSON-LD, iterates items via `eachItem()`, and for each:
- Creates item + subjects in DB
- Creates photos (resolves paths, computes checksums)
- Creates selections, notes, transcriptions
- Finds or creates tags by name
- Dispatches Redux actions to update UI

**Critical limitation**: Import creates **new** items. There is no "update existing item" path through the import hook. If you import an item that already exists (same photos), you get a duplicate.

### Other Hooks

- **`extract(buffer, raw)`** — Receives image buffer from photo/selection extraction. Can return `{ note: "string" }`. Not relevant to CRDT sync.
- **`transcribe(draft, buffer, raw)`** — OCR hook. Receives image buffer, returns transcription text/data. Not relevant to CRDT sync.
- **`unload()`** — Cleanup hook called when plugin is destroyed. Useful for closing WebSocket connections.

### Missing Hooks

There are **no** hooks for:
- Project open/close (lifecycle events)
- Item create/update/delete (change events)
- Metadata change events
- Tag change events
- Note change events
- Background polling/timers (must self-manage with `setInterval`)
- Startup/ready events

---

## HTTP API (localhost:2019)

The API is a Koa server defined in `src/common/api.js`. It's available when Tropy is running with API enabled. All endpoints operate on local integer IDs.

### Read Operations

| Endpoint | Returns |
|----------|---------|
| `GET /project/items` | Item list (supports `?tag=`, `?q=`, `?sort=`, `?reverse=`) |
| `GET /project/items/:id` | Single item as JSON-LD |
| `GET /project/items/:id/photos` | Item's photos |
| `GET /project/items/:id/tags` | Item's tags |
| `GET /project/items/:id/transcriptions` | Item's transcriptions |
| `GET /project/data/:id` | Metadata for any subject (item/photo/selection) |
| `GET /project/notes/:id` | Note content (`?format=json\|html\|plain\|md`) |
| `GET /project/transcriptions/:id` | Transcription (`?format=json\|html\|plain\|xml\|alto`) |
| `GET /project/photos/:id` | Photo info |
| `GET /project/photos/:id/raw` | Raw photo file download |
| `GET /project/selections/:id` | Selection info |
| `GET /project/tags` | All tags |
| `GET /project/tags/:id` | Single tag |
| `GET /project/lists{/:id}` | List info (`?expand=true` for children) |

### Write Operations

| Endpoint | Does |
|----------|------|
| `POST /project/import` | Import items (form-urlencoded: `file` or `data` param) |
| `POST /project/data/:id` | Save metadata on existing subject |
| `POST /project/notes` | Create note (`html` + `photo` or `selection` param) |
| `DELETE /project/notes/:id` | Delete note |
| `POST /project/tags` | Create tag (`name`, optional `color`, `item`) |
| `DELETE /project/tags` | Delete tag |
| `POST /project/items/:id/tags` | Add tags to item |
| `DELETE /project/items/:id/tags` | Remove tags from item |
| `POST /project/transcriptions` | Create transcription (`text`/`data` + `photo`/`selection`) |

### What the API Can and Cannot Do

**Can do**:
- Read all item/photo/selection/note/tag/transcription data
- Write metadata to existing subjects (`POST /project/data/:id`)
- Create and delete notes on existing photos/selections
- Create, delete, add, and remove tags
- Create transcriptions
- Import new items from JSON-LD

**Cannot do**:
- Update existing notes (only create and delete — no PATCH/PUT)
- Update transcriptions
- Delete items
- Create selections on existing photos
- Modify photo properties (orientation, adjustments)
- Create or modify lists
- Batch operations (one request per entity)
- Query items by photo checksum (must list all and filter client-side)

---

## Feasibility Assessment by CRDT Feature

### 1. Reading Local State for Export → CRDT

| Feature | Feasible? | How |
|---------|-----------|-----|
| Read all items | Yes | `GET /project/items` or export hook |
| Read item metadata | Yes | `GET /project/data/:id` |
| Read photo checksums | Yes | `GET /project/items/:id/photos` returns checksum |
| Read tags | Yes | `GET /project/items/:id/tags` |
| Read notes | Yes | `GET /project/notes/:id` |
| Read transcriptions | Yes | `GET /project/transcriptions/:id` |
| Read selections | Yes | Via item JSON-LD export (includes selections) |
| Detect local changes | Partial | Must poll and diff — no change event hooks |
| Map checksum → local ID | Manual | Must `GET /project/items`, enumerate photos, build lookup |

**Key gap**: No change detection. The plugin must poll the API periodically and diff against the CRDT state to detect local edits. This is the biggest limitation for background sync.

### 2. Writing CRDT State → Local Database

| Feature | Feasible? | How |
|---------|-----------|-----|
| Write metadata to existing item | Yes | `POST /project/data/:id` (JSON body) |
| Add tags to existing item | Yes | `POST /project/items/:id/tags` |
| Remove tags from existing item | Yes | `DELETE /project/items/:id/tags` |
| Create note on existing photo | Yes | `POST /project/notes` (html + photo param) |
| Delete note | Yes | `DELETE /project/notes/:id` |
| Update existing note | **No** | No API endpoint. Must delete + recreate. |
| Create transcription | Yes | `POST /project/transcriptions` |
| Update transcription | **No** | No API endpoint. |
| Create selection on existing photo | **No** | No API endpoint. |
| Import new item (with photos) | Yes | `POST /project/import` or import hook |
| Update existing item (merge) | **No** | Import always creates new. Must use `POST /project/data/:id` per-field. |

### 3. Background Sync Loop

| Requirement | Feasible? | How |
|-------------|-----------|-----|
| Run background timer | Yes | `setInterval()` — plugins have full Node.js |
| Open WebSocket to sync server | Yes | `require('ws')` or `y-websocket` — full Node.js access |
| Maintain persistent connection | Yes | Plugin constructor runs once, lives until unload |
| Cleanup on shutdown | Yes | `unload()` hook |
| React to remote CRDT changes | Yes | Yjs `observe()` callbacks trigger HTTP API writes |
| React to local Tropy changes | Partial | Must poll HTTP API — no push events |

### 4. Identity Resolution (Checksum → Local ID)

| Step | Feasible? | How |
|------|-----------|-----|
| List all items | Yes | `GET /project/items` |
| Get photos per item | Yes | `GET /project/items/:id/photos` |
| Extract checksum from photo | Yes | Photo object includes `checksum` field |
| Build checksum → item/photo ID map | Yes | Client-side map built from API responses |
| Query by checksum directly | **No** | No `?checksum=` query param. Must enumerate. |

**Workaround**: On startup and periodically, fetch all items + photos and build a `Map<checksum, { itemId, photoId }>`. For typical research projects (< 10,000 items), this is fast enough.

### 5. UI Feedback

| Feature | Feasible? | How |
|---------|-----------|-----|
| Show sync notifications | Yes | `context.dialog.notify()` |
| Show error dialogs | Yes | `context.dialog.fail()` |
| Prompt for server URL | Yes | Plugin `options` in `package.json` (rendered in Tropy's preferences) |
| Show sync status indicator | **No** | No way to add UI elements |
| Show conflict resolution UI | **No** | No custom windows or panels |
| Show peer presence | **No** | No UI injection |
| Highlight remotely-changed items | **No** | No way to modify item appearance |

---

## Scenario Feasibility Matrix

### Scenario A: Async Offline-First

| Aspect | Verdict |
|--------|---------|
| Export to CRDT state file | **Fully feasible** via export hook |
| Import from CRDT state file | **Feasible with workarounds** — import creates new items; metadata updates on existing items require API calls per-field |
| File dialog for state exchange | **Fully feasible** via `context.dialog.open/save` |
| Merge semantics | **Fully feasible** — CRDT merge happens in-memory, then written via API |
| Duplicate detection on import | **Manual** — must check checksums against existing photos before importing |

**Overall: Achievable.** The export hook provides the full JSON-LD. For import, use the HTTP API to update existing items (metadata, tags, notes) and the import endpoint only for genuinely new items.

### Scenario B: Background Sync via Server

| Aspect | Verdict |
|--------|---------|
| WebSocket connection | **Fully feasible** — full Node.js access |
| Background polling for local changes | **Feasible but expensive** — must poll HTTP API, no change events |
| Writing remote changes to local DB | **Feasible** — HTTP API covers metadata, tags, notes |
| Persistent connection across session | **Fully feasible** — plugin instance lives until unload |
| Change detection | **Biggest limitation** — polling + diffing is the only option |

**Overall: Achievable with polling overhead.** The lack of change event hooks means the plugin must periodically snapshot local state and diff against the CRDT. For small-to-medium projects this is acceptable. For large projects, polling frequency must be tuned.

### Scenario C: Real-Time Collaborative Editing

| Aspect | Verdict |
|--------|---------|
| Live metadata sync | **Partially feasible** — writes via API work, but UI doesn't live-refresh from API changes without Redux dispatch |
| Collaborative note editing | **Not feasible** — plugin cannot bind Y.XmlFragment to Tropy's ProseMirror editor. No access to editor instances or React components. |
| Presence awareness | **Not feasible** — no UI injection for cursors/avatars |
| Live tag sync | **Partially feasible** — API writes work, but UI may not reflect changes until refresh |

**Overall: Not achievable as a plugin.** Real-time collaborative editing requires deep integration with Tropy's React/ProseMirror layer, which plugins cannot access.

### Scenario D: Hybrid (Recommended)

Phase 1 (background sync) maps to Scenario B — **fully achievable**.
Phase 2 (real-time editing) maps to Scenario C — **requires Tropy core changes**.

---

## Critical Gaps and Workarounds

### Gap 1: No Change Events

**Problem**: Plugins can't subscribe to "item metadata changed" or "tag added" events.

**Workaround**: Poll the HTTP API on an interval (e.g., every 5 seconds). On each poll:
1. `GET /project/items` to get the full item list
2. For each item, `GET /project/data/:id` to read current metadata
3. Diff against last known state
4. Push changes to CRDT

**Optimization**: Hash the metadata response and only process items whose hash changed. Track `modified` timestamps to skip unchanged items.

### Gap 2: No Checksum Query

**Problem**: Can't do `GET /project/items?checksum=abc123`. Must enumerate all items and photos.

**Workaround**: Build a checksum index on startup:
```js
const index = new Map()  // checksum → { itemId, photoId }

const items = await fetch('http://localhost:2019/project/items').then(r => r.json())
for (const item of items) {
  const photos = await fetch(`http://localhost:2019/project/items/${item.id}/photos`).then(r => r.json())
  for (const photo of photos) {
    index.set(photo.checksum, { itemId: item.id, photoId: photo.id })
  }
}
```

Rebuild on polling cycle or when item count changes.

### Gap 3: Import Creates Duplicates

**Problem**: `POST /project/import` always creates new items. There's no "upsert" or "update if exists."

**Workaround**: Never use the import endpoint for sync. Instead:
1. Check if the item's photo checksums already exist locally (via index)
2. If yes: update metadata via `POST /project/data/:id`, manage tags via tag endpoints, create notes via `POST /project/notes`
3. If no: the item's photos don't exist locally, so skip it (photos are local-only)

This means a CRDT sync plugin almost never needs the import endpoint — it only updates annotations on items the user already has.

### Gap 4: No Note Update

**Problem**: Notes can be created and deleted via API, but not updated in place.

**Workaround**: For append-only notes (Scenario A/B/D Phase 1), this is fine — just create new notes, never update. If a note needs correction, delete the old one and create a new one. Note that `DELETE /project/notes/:id` requires knowing the note's local integer ID, which means the plugin must track the mapping between CRDT note entries and local note IDs.

### Gap 5: No Selection Creation via API

**Problem**: The HTTP API has no endpoint to create a selection on an existing photo.

**Workaround**: Selections can only be synced if they already exist locally. The plugin can sync metadata/notes/transcriptions *on* existing selections, but can't create new crop regions remotely. This is an acceptable limitation — selections are inherently visual/spatial and users typically create them while looking at the photo.

### Gap 6: UI Doesn't Live-Refresh

**Problem**: When the plugin writes metadata via the HTTP API, Tropy's UI may not immediately reflect the change (no Redux action dispatched from API writes in the renderer).

**Partial workaround**: The API handler in `src/common/api.js` dispatches actions via `rsvp()` which goes through the Redux saga system. Changes made through the API *should* update the Redux store and re-render. This needs empirical verification — it may work correctly already, or may require a manual refresh.

---

## Summary Table

| CRDT Design Element | Plugin Feasibility | Mechanism |
|----------------------|--------------------|-----------|
| Metadata sync (LWW per-property) | **Full** | HTTP API `POST /project/data/:id` |
| Tag sync (set-union) | **Full** | HTTP API tag endpoints |
| Note sync (append-only) | **Full** | HTTP API `POST /project/notes` |
| Note sync (collaborative editing) | **None** | Requires ProseMirror integration |
| Transcription sync | **Partial** | Create yes, update no |
| Selection metadata sync | **Full** | HTTP API `POST /project/data/:id` |
| Selection creation | **None** | No API endpoint |
| Background WebSocket | **Full** | Node.js `ws` / `y-websocket` |
| Change detection | **Polling only** | No event hooks |
| Checksum-based identity | **Manual index** | Enumerate all photos on startup |
| Sync status UI | **Notifications only** | `dialog.notify()` — no persistent UI |
| Conflict resolution UI | **None** | No UI extension possible |
