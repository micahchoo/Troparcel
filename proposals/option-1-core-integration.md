# Proposal 1: Tropy Core Sync Integration

## Summary

Add collaboration as a first-class feature inside Tropy by implementing a sync saga that lives alongside the existing Redux-Saga architecture. This eliminates every workaround the current plugin requires by operating directly on the data layer.

## Motivation

Tropy already has all the infrastructure needed for real-time sync:

- **Redux + Redux-Saga** for state management with action interception
- **`db.on('update')` events** fired on every INSERT/UPDATE/DELETE
- **Direct model access** (`mod.item`, `mod.note`, `mod.selection`, etc.)
- **IPC between main and renderer** for dispatching actions
- **The command system** for encapsulating DB operations

The current plugin approach fights all of this — it watches the SQLite file externally, polls a REST API that's missing key endpoints, and builds elaborate feedback-loop suppression to avoid corrupting its own state.

## Architecture

### New Files

```
src/
  sagas/
    sync.js              — Main sync saga (lifecycle, orchestration)
    sync/
      provider.js        — Yjs + WebSocket provider management
      push.js            — Local → CRDT push logic
      apply.js           — CRDT → local apply logic
      identity.js        — Item identity computation
      schema.js          — CRDT document structure
  slices/
    sync.js              — Redux slice for sync state
  components/
    sync/
      status.js          — Connection status indicator
      peers.js           — Active collaborators list
      conflicts.js       — Conflict review UI (optional)
  constants/
    sync.js              — Action type constants
```

### Data Flow

```
User edits in Tropy
  → Redux action dispatched
  → Existing saga processes it (DB write, state update)
  → db.on('update') fires
  → sync saga receives change event
  → Debounce (configurable)
  → Diff affected items against CRDT
  → Yjs transaction pushes delta
  → WebSocket to server → relay to peers

Remote peer pushes change
  → Yjs observer fires in sync saga
  → Debounce (configurable)
  → Saga dispatches Redux actions directly:
      put(act.metadata.save(...))
      put(act.note.create(...))
      put(act.tag.create(...))
      put(act.selection.create(...))
  → Existing command handlers process them
  → DB writes happen through normal path
  → Redux state updates, UI re-renders
  → db.on('update') fires — but sync saga ignores
    changes it originated (via meta.sync flag)
```

### Integration Points

#### 1. Sync Saga Lifecycle

The sync saga would be forked alongside existing sagas in `src/sagas/project.js`:

```js
// In project.js setup()
function *setup({ db, project }) {
  // ... existing setup ...

  if (project.sync?.enabled) {
    yield fork(sync, { db, project })
  }
}
```

#### 2. Change Detection via db.on('update')

The Database class already emits `update` events on every INSERT/UPDATE/DELETE (see `src/common/db.js:129`). The sync saga would subscribe:

```js
function *watchLocalChanges(db) {
  let channel = eventChannel(emitter => {
    let handler = (query) => emitter(query)
    db.on('update', handler)
    return () => db.off('update', handler)
  })

  while (true) {
    let query = yield take(channel)
    // Parse which table was affected
    // Debounce and batch changes
    // Push affected items to CRDT
  }
}
```

#### 3. Applying Remote Changes

Remote changes dispatch normal Redux actions with a `meta.sync` flag:

```js
function *applyRemoteMetadata(itemId, data) {
  yield put({
    type: METADATA.SAVE,
    payload: { ids: [itemId], data },
    meta: { cmd: 'project', sync: true }
  })
}
```

The `meta.sync` flag lets the change-detection watcher ignore these writes, preventing feedback loops without any file-watching hacks.

#### 4. Identity

Items would use the existing `project_id` UUID for cross-instance identity. The project table already has this field. For matching items that were imported independently (same photos, different DBs), the photo checksum approach can remain as a fallback, but the primary path uses stable UUIDs.

### What This Eliminates

| Current Plugin Workaround | Why It's No Longer Needed |
|---|---|
| `fs.watch()` on .tpy file | `db.on('update')` provides instant notification |
| Safety-net periodic poll | Direct DB events are reliable |
| HTTP REST API calls (N+1 enrichment) | Direct `mod.*` model access |
| Missing API endpoints (selections, note updates) | Models support all operations |
| Async mutex lock | Redux-Saga serializes naturally via `take`/`put` |
| `_applyingRemote` flag + event queue | `meta.sync` flag distinguishes origin |
| Plugin context polling (500ms x 16) | Saga has full context at fork time |
| Prefs window detection | Saga only runs in project windows |
| SQLITE_BUSY retry logic | Internal DB pool handles contention |
| Content-hash comparison for skip | `db.on('update')` only fires on actual writes |
| Applied-key deduplication Sets | `meta.sync` prevents re-processing |
| SyncVault state tracker | Saga state is in-memory, scoped to session |
| Write delays between API phases | Direct DB transactions are atomic |
| HTML sanitization | Still needed for untrusted remote content |
| Backup batching | Can use Tropy's existing undo/history system |

### Configuration

Sync settings would live in project preferences (accessible via the Prefs window):

```js
// In project state
sync: {
  enabled: false,
  serverUrl: 'wss://sync.example.com',
  room: '',           // defaults to project UUID
  userId: '',         // display name
  roomToken: '',      // shared secret
  autoApply: true,    // auto vs review mode
  syncPhotos: false,  // sync photo adjustments
  syncLists: false,   // sync list membership
  debounce: {
    local: 2000,
    remote: 500
  }
}
```

### UI

A sync status indicator in the project toolbar:

- **Disconnected** (gray dot) — not connected to server
- **Connected** (green dot) — connected, idle
- **Syncing** (animated) — push or apply in progress
- **Peers: N** — number of connected collaborators
- **Review: N pending** — in review mode, pending changes count

Clicking opens a panel showing:
- Connected peers and their last activity
- Pending inbound changes (in review mode)
- Sync log / recent activity

### Migration Path

1. Users install a Tropy build with sync support
2. Enable sync in project preferences
3. Configure server URL and room
4. Existing Troparcel CRDT data can be imported by connecting to the same room — the Yjs protocol will sync the document

### Server

The existing Troparcel WebSocket server (`server/index.js`) works unchanged. It speaks the y-websocket protocol and handles room management, LevelDB persistence, and authentication. No server changes needed.

## Complexity Estimate

| Component | Effort | Notes |
|---|---|---|
| Sync saga (lifecycle, push, apply) | Medium | ~800 lines, replacing ~2000 in plugin |
| CRDT schema + identity | Low | Reuse from plugin with simplification |
| Redux slice + constants | Low | ~100 lines |
| UI components | Medium | Status indicator, peer list, review panel |
| Settings integration | Low | Add to existing prefs UI |
| Testing | Medium | Saga testing with redux-saga-test-plan |

**Total: ~2-3 weeks of focused development**

## Risks

- **Upstream acceptance** — Tropy maintainers may not want sync in core
- **Maintenance burden** — Must keep sync code in sync with Tropy releases
- **Scope creep** — Tempting to add features (permissions, versioning, E2E encryption)

## Recommendation

This is the **technically optimal** solution. Pursue it if:
- You're willing to maintain a Tropy fork, or
- The Tropy team is interested in collaboration features

If upstream acceptance is unlikely, see Proposal 3 (Enhanced Plugin API) for a compromise that gets 80% of the benefit with 20% of the Tropy-side changes.
