# Troparcel — Subsystems

Subsystem boundaries inside `src/`. Each row is a module or coherent group; the **Doc** column points to the canonical description rather than restating it.

| Subsystem | File(s) | Role | Doc |
|---|---|---|---|
| **Plugin entry** | `src/plugin.js` | Tropy plugin class — constructor, options merge, connection-string parse, lifecycle (start/stop), `export`/`import` hooks, prefs-window detection, retry-on-server-down | [README §Architecture](../../README.md#architecture), [docs/DEVELOPER.md] |
| **Sync orchestrator** | `src/sync-engine.js` | `SyncEngine` class — Yjs doc + WebSocket provider lifecycle, file-watcher, safety-net polling with exponential backoff (R5), debouncing of local & remote changes, `syncOnce()` cycle, awareness presence, vault persistence, store subscription | [README §Architecture] |
| **Push mixin** | `src/push.js` | local → CRDT writes: `pushLocal`, `pushMetadata`, `pushTags`, `pushNotes`, `pushSelections`, `pushTranscriptions`, `pushLists` (per-item lists), `pushDeletions` | [shaping.md §Codebase Classification], [V*-plan.md] |
| **Apply mixin** | `src/apply.js` | CRDT → local writes: `applyRemoteAnnotations` (the master), `_applyAttribution`, `applyNotes`, `applySelections`, `applyTranscriptions`, **plus** unwired V5 functions `applyTemplates` + `applyListHierarchy` | [docs/CONFLICTS.md], drift detail in [subsystems/v5-template-list-sync.md](./subsystems/v5-template-list-sync.md) |
| **Enrich mixin** | `src/enrich.js` | HTTP API item enrichment, fallback when Redux store unavailable | [docs/API.md] |
| **Store adapter** | `src/store-adapter.js` | Redux abstraction — read accessors (items, lists, tags, metadata), `suppressChanges()`/`resumeChanges()`, `subscribe()`, `_waitForAction()` | [shaping.md], drift detail: missing `dispatchSuppressed`/`readTemplates`/`readLists` (see [subsystems/attribution.md](./subsystems/attribution.md)) |
| **API client** | `src/api-client.js` | Tropy local HTTP API client (fallback path) | [docs/API.md] |
| **CRDT schema** | `src/crdt-schema.js` | Yjs document layout — `annotations` Y.Map keyed by item identity hash, plus root-level `schema`, `projectLists`, `room`. Getters/setters/observers for every section. Schema v4 with v6 additions for templates/list hierarchy. | [crdt-design.md], [crdt-feasibility.md] |
| **Identity** | `src/identity.js` | Item identity hashing, UUID generators, selection fingerprinting (geometry-keyed merge — see [docs/CONFLICTS.md §Selections]) | [crdt-design.md §Identity Model] |
| **Vault** | `src/vault.js` | `SyncVault` — per-room persistent dedup state: pushed-hash sets, applied-key sets, UUID↔localID maps, attribution tag IDs, original-author tracking. Persisted to `~/.troparcel/vault/<room>_<userId>.json` | [shaping.md §V5-V] |
| **Backup** | `src/backup.js` | `BackupManager` — pre-apply snapshots, validation, rollback | [README §Backup & safety] |
| **Sanitize** | `src/sanitize.js` | HTML sanitizer for remote note content (state-machine parser) | [docs/CONFLICTS.md §Notes] |
| **Notifications** | `src/notifications.js` | DOM overlay (status pill + toasts) — fixed-position element injected into Tropy's window | [slices.md §V1] |
| **Connection string** | `src/connection-string.js` | Parse/generate `troparcel://` URIs | [ConnStr-plan.md] |
| **Transport adapters** | `src/adapters/{base,websocket,file,snapshot,index}.js` | Pluggable transport layer — base class + factory; WebSocket (default), file (poll-based shared folder), snapshot (HTTP GET/PUT) | [slices.md §Transport Adapters] |
| **Server** | `server/index.js`, `server/Dockerfile` | y-websocket relay + LevelDB persistence + monitor dashboard at `/monitor` | [README §Server], [docs/SETUP.md] |

## Inter-subsystem flow (read direction matters)

```
Tropy Redux store ──┐
                    ├──► StoreAdapter ──► push.js ──┐
file-watcher ───────┘                                ├──► Yjs.Doc ──► WebsocketProvider ──► server
                                                     │
applyRemoteAnnotations ◄── apply.js ◄── observe(*)──┘
       │
       ├─► _applyAttribution ──► adapter.dispatchSuppressed   ⚠ MISSING METHOD
       └─► (V5 unwired) applyTemplates / applyListHierarchy   ⚠ NEVER CALLED
```

Cross-cutting via `vault.js` (consulted/updated by both push and apply for dedup) and `backup.js` (snapshot before each apply).

## Subsystem detail pages

Only subsystems with active drift / partial implementation get their own page:

- [subsystems/v5-template-list-sync.md](./subsystems/v5-template-list-sync.md) — V5 template/list hierarchy sync, status: schema + apply written, push + wiring missing
- [subsystems/attribution.md](./subsystems/attribution.md) — V3 attribution tags + contributor metadata, status: blocked by missing `dispatchSuppressed` on store-adapter
- [subsystems/notes-html-pipeline.md](./subsystems/notes-html-pipeline.md) — HTML-on-wire vs ProseMirror-state-on-disk asymmetry; SAFE_TAGS reconciliation against Tropy's editor schema (6 over-permissive tags found 2026-05-08)

For all other subsystems, the canonical doc + the file itself are sufficient.
