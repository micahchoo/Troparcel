# Proposal 3: Enhanced Plugin API (Pragmatic Middle Ground)

## Summary

Propose a small, focused set of additions to Tropy's plugin system — 3-4 new hooks and scoped DB access — that would make continuous sync viable without modifying Tropy's core architecture. This is the **minimum upstream change** that makes Troparcel robust.

## Motivation

Tropy's plugin system was designed for batch I/O: `export()` gives you items, `import()` lets you inject them, `transcribe()` produces text. There is no mechanism for a plugin to:

1. Know when a project is opened or closed
2. Be notified when data changes
3. Write data back without going through the HTTP API
4. Distinguish its own writes from user writes

Troparcel needs all four. Today it approximates them through file watching, API polling, and elaborate feedback-loop suppression. The result is fragile and complex.

The proposed additions are small enough to be acceptable upstream while transformative for plugin capabilities.

## Proposed Plugin API Additions

### Hook 1: `projectOpened(project, context)`

Called when a project finishes opening, after all data is loaded and the UI is ready.

```js
class MyPlugin {
  async projectOpened(project, context) {
    // project.id    — project UUID
    // project.path  — file path
    // project.name  — display name
    // context.db    — scoped database handle (see below)
    // context.store — Redux store (read-only getState())

    this.db = context.db
    this.projectId = project.id
    await this.startSync()
  }
}
```

**Tropy-side implementation:** In `src/sagas/project.js`, after the `setup()` saga completes, call the hook on all plugin instances:

```js
// In project.js, after setup completes
for (let plugin of Object.values(win.plugins.instances)) {
  if (typeof plugin.projectOpened === 'function') {
    await plugin.projectOpened(project, {
      db: createScopedDb(db),
      store: readOnlyStore
    })
  }
}
```

**Complexity:** ~15 lines in `project.js`.

### Hook 2: `projectChanged(changes)`

Called when the project database is modified, debounced to batch rapid changes.

```js
class MyPlugin {
  async projectChanged(changes) {
    // changes is an array of:
    // {
    //   table: 'notes',
    //   action: 'insert' | 'update' | 'delete',
    //   id: 42,
    //   source: 'user' | 'plugin:troparcel' | 'api'
    // }

    // Filter out our own changes
    let external = changes.filter(c => c.source !== 'plugin:troparcel')
    if (external.length > 0) {
      await this.pushChanges(external)
    }
  }
}
```

**Tropy-side implementation:** The `Database` class already emits `update` events with the SQL query (see `db.js:129`). A wrapper would:

1. Parse the query to extract table name and action (INSERT/UPDATE/DELETE)
2. Track the source (user action vs plugin write vs API)
3. Debounce (100ms) and batch changes
4. Call `projectChanged()` on all plugin instances

```js
// In db.js or a new db-events.js wrapper
db.on('profile', (query, ms) => {
  if (IUD.test(query)) {
    let change = parseChange(query)
    change.source = currentSource // set by scoped DB handle
    changeBuffer.push(change)
    scheduleFlush()
  }
})

function scheduleFlush() {
  clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    let batch = changeBuffer.splice(0)
    for (let plugin of plugins.instances) {
      plugin.projectChanged?.(batch)
    }
  }, 100)
}
```

**Complexity:** ~50 lines. The hardest part is parsing the SQL query to extract the table and action. A regex on `INSERT INTO (\w+)`, `UPDATE (\w+)`, `DELETE FROM (\w+)` covers 95% of cases.

### Hook 3: `projectClosing()`

Called before the project database closes, giving plugins time to flush state and disconnect.

```js
class MyPlugin {
  async projectClosing() {
    await this.stopSync()
    await this.flushPendingChanges()
  }
}
```

**Tropy-side implementation:** In `src/sagas/project.js`, in the `teardown()` saga:

```js
// In teardown(), before db.close()
for (let plugin of Object.values(win.plugins.instances)) {
  try {
    await plugin.projectClosing?.()
  } catch (e) {
    warn({ stack: e.stack }, 'plugin projectClosing failed')
  }
}
```

**Complexity:** ~10 lines.

### Scoped Database Handle

Instead of the full `Database` instance (which would let plugins do anything), provide a **scoped handle** with controlled access:

```js
function createScopedDb(db, pluginName) {
  return {
    // Read operations (safe)
    all: (sql, ...params) => db.all(sql, ...params),
    get: (sql, ...params) => db.get(sql, ...params),
    each: (sql, ...params) => db.each(sql, ...params),

    // Write operations (tagged with source)
    run: (sql, ...params) => {
      currentSource = `plugin:${pluginName}`
      try {
        return db.run(sql, ...params)
      } finally {
        currentSource = 'user'
      }
    },

    transaction: (fn) => {
      currentSource = `plugin:${pluginName}`
      try {
        return db.transaction(fn)
      } finally {
        currentSource = 'user'
      }
    },

    // Model access (preferred over raw SQL)
    models: {
      item: mod.item,
      note: mod.note,
      metadata: mod.metadata,
      selection: mod.selection,
      photo: mod.photo,
      tag: mod.tag,
      list: mod.list,
      transcription: mod.transcription,
      subject: mod.subject
    }
  }
}
```

The `currentSource` tracking lets `projectChanged()` filter out a plugin's own writes.

**Alternative: model-only access** (no raw SQL). This is safer but less flexible:

```js
// Plugin uses models directly
let items = await this.db.models.item.load(db, [itemId])
await this.db.models.note.create(db, { id: photoId, state, text, language })
await this.db.models.metadata.update(db, { id: [itemId], data })
```

## Impact on Troparcel

### What Troparcel Can Drop

With these hooks, Troparcel's sync engine simplifies dramatically:

| Current Component | Lines | Replacement |
|---|---|---|
| File watcher setup/teardown | ~80 | `projectChanged()` hook |
| Safety-net periodic poll | ~60 | Not needed — hook is reliable |
| API client (`api-client.js`) | ~436 | `db.models.*` direct access |
| Plugin context polling | ~40 | `projectOpened()` provides context |
| Prefs window detection | ~20 | `projectOpened()` only called in project window |
| Feedback loop suppression | ~80 | `changes.source` filtering |
| Event queue (`_queuedLocalChange`) | ~40 | Not needed — no watcher to suppress |
| Async mutex (`_syncLock`) | ~30 | Still useful but simpler |
| Enrichment batching (`enrichItem`) | ~120 | Direct DB queries |
| SQLITE_BUSY retry logic | ~40 | Internal DB pool handles this |
| SyncVault push hashing | ~60 | Can compare DB state directly |
| Write delays between phases | ~10 | Transactions are atomic |

**Estimated reduction: ~1,000 lines removed** from the ~2,100 line sync engine. The remaining ~1,100 lines are the CRDT schema, Yjs integration, push/apply logic, backup management, and sanitization — which are the actual sync logic and still needed.

### New Troparcel Architecture

```js
class TroparcelPlugin {
  constructor(options, context) {
    this.options = { ...defaults, ...options }
    this.context = context
    this.engine = null
  }

  // Called by Tropy when project opens
  async projectOpened(project, { db, store }) {
    this.engine = new SyncEngine({
      db,              // direct DB access
      project,
      options: this.options,
      logger: this.context.logger
    })
    await this.engine.start()
  }

  // Called by Tropy on every data change
  async projectChanged(changes) {
    if (!this.engine) return

    // Ignore our own writes
    let external = changes.filter(c =>
      c.source !== 'plugin:troparcel'
    )

    if (external.length > 0) {
      await this.engine.pushChanges(external)
    }
  }

  // Called by Tropy before project closes
  async projectClosing() {
    await this.engine?.stop()
    this.engine = null
  }

  // Existing hooks still work for manual sync
  async export(data) { /* ... */ }
  async import(payload) { /* ... */ }

  unload() {
    this.engine?.stop()
  }
}
```

### Missing API Endpoints: Solved

The current plugin calls REST endpoints that don't exist in Tropy:

- `POST /project/selections` — doesn't exist
- `PUT /project/selections/:id` — doesn't exist
- `PUT /project/notes/:id` — doesn't exist

With direct model access:

```js
// Create a selection (currently impossible via API)
await mod.selection.create(db, {
  photo: photoId,
  x, y, width, height,
  template: templateId
})

// Update a note (currently impossible via API)
await db.run(
  'UPDATE notes SET text = ?, state = ?, modified = datetime("now") WHERE note_id = ?',
  [text, state, noteId]
)
```

## Package.json Hook Declaration

Tropy's plugin system uses `package.json` to declare supported hooks:

```json
{
  "hooks": {
    "export": true,
    "import": true,
    "projectOpened": true,
    "projectChanged": true,
    "projectClosing": true
  }
}
```

The `Plugins.supports()` method already checks this map. New hooks slot in naturally.

## Upstream Proposal Strategy

### What to Emphasize

1. **Small change surface** — 3 hooks + a DB wrapper, ~75 lines of Tropy code
2. **Backward compatible** — existing plugins are unaffected; new hooks are opt-in
3. **Enables entire class of plugins** — not just sync, but analytics, audit logging, external integrations, auto-tagging, real-time export
4. **No architectural change** — hooks fire from existing code paths (saga setup/teardown, DB update events)

### What to Expect

The Tropy maintainers may push back on:

1. **Giving plugins DB write access** — security concern. Mitigation: scoped handle, read-only by default, write access requires explicit opt-in in plugin config.

2. **The `projectChanged` hook** — performance concern if plugins are slow. Mitigation: async with timeout, debounced, plugin errors don't block Tropy.

3. **Source tracking** — complexity of tagging SQL queries with their origin. Mitigation: only needed if `projectChanged` is accepted; simpler version could just provide table+action without source.

### Minimal Viable Proposal

If the full proposal is too ambitious, the **minimum useful addition** is:

1. `projectOpened(project)` — just the project info, no DB handle
2. `projectClosing()` — cleanup

Even without DB access or change notifications, knowing *when* a project opens and closes eliminates the context-polling hack and gives the plugin a reliable lifecycle. The rest can follow incrementally.

## Implementation Timeline

### Phase 1: Hooks Only (1 week)

Add `projectOpened`, `projectChanged`, `projectClosing` to the plugin system. No DB handle — plugins still use the HTTP API for writes, but get reliable lifecycle and change notifications.

**Tropy changes:** ~75 lines across `project.js`, `plugins.js`, `db.js`.

### Phase 2: Scoped DB Handle (1 week)

Add the `context.db` parameter to `projectOpened`. Plugins can read and write directly.

**Tropy changes:** ~100 lines for the scoped wrapper.

### Phase 3: Source Tracking (3 days)

Add source tagging to write operations so plugins can filter their own changes in `projectChanged`.

**Tropy changes:** ~30 lines in the DB wrapper.

### Phase 4: Troparcel Migration (1-2 weeks)

Rewrite Troparcel's sync engine to use the new hooks. Remove file watcher, API client, context polling, and feedback-loop suppression.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Upstream rejection | Medium | Start with minimal proposal (lifecycle hooks only). Demonstrate value with Troparcel. |
| Plugin security (DB writes) | Medium | Scoped handle with model-only access. Config flag to enable. |
| Performance (slow plugin in change hook) | Low | Async hooks with timeout. Debounce. |
| Breaking existing plugins | None | New hooks are additive. |

## Recommendation

This is the **best risk/reward tradeoff**. It requires the least change to Tropy (~75-200 lines) while enabling the most dramatic simplification of Troparcel (~1,000 lines removed). It's also proposable upstream because:

- It benefits all plugins, not just Troparcel
- It follows Tropy's existing patterns (lifecycle hooks, event-driven)
- It's backward compatible
- The implementation is small enough to review in a single PR

Start with Phase 1 (hooks only) as a proof of concept. If accepted, Phase 2 (DB handle) unlocks the full potential.
