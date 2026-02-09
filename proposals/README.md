# Troparcel Architecture Proposals

Four alternative architectures for Tropy collaboration, evaluated against the current external-API-plus-file-watching approach.

## Current State

Troparcel v3.0 syncs annotations between Tropy instances via Yjs CRDTs over WebSocket. It works **outside** Tropy's architecture — watching the `.tpy` file for changes, polling the HTTP REST API for data, and writing back through API endpoints (some of which don't exist in stock Tropy). This requires ~4,000 lines of workaround code including feedback-loop suppression, async mutexes, event queuing, content-hash deduplication, and identity hashing.

## Proposals

| # | Approach | Tropy Changes | Plugin Changes | Effort | Multi-Writer | Offline |
|---|---|---|---|---|---|---|
| **1** | [Core Sync Integration](option-1-core-integration.md) | Major (new saga) | Replaced entirely | 2-3 weeks | Yes | Yes |
| **2** | [cr-sqlite Replication](option-2-cr-sqlite.md) | Major (extension + IDs) | Replaced entirely | 4-6 weeks | Yes | Yes |
| **3** | [Enhanced Plugin API](option-3-enhanced-plugin-api.md) | Minor (3-4 hooks) | Simplified (~50%) | 1-2 weeks | Yes | Yes |
| **4** | [WAL Streaming](option-4-wal-replication.md) | None-Minor | Complementary | 3-5 days | No* | No |

*Approach 4A (Litestream) is leader-follower only. Approach 4C (hybrid) adds multi-writer via CRDT overlay.

## Decision Matrix

### If you can modify Tropy core and want the best architecture:

**Choose Proposal 1 (Core Integration).** The sync saga integrates with Redux, uses `db.on('update')` for instant change detection, writes through models directly, and eliminates every workaround. This is the technically optimal solution.

### If you want the most elegant long-term solution and can accept risk:

**Choose Proposal 2 (cr-sqlite).** The database itself becomes a CRDT — no application-level sync code at all. But it requires solving the ID problem (auto-increment → UUIDs) and packaging a native SQLite extension across platforms.

### If you want the fastest path to improvement with the smallest upstream ask:

**Choose Proposal 3 (Enhanced Plugin API).** Three hooks and a scoped DB handle — ~75-200 lines of Tropy code — let Troparcel drop ~1,000 lines of workarounds. This is proposable upstream because it benefits all plugins, not just sync.

### If you only need one-to-many sharing or fast initial sync:

**Choose Proposal 4 (WAL Streaming)** as a complement to another approach. Litestream gives you instant full-project replication for read-only followers. Not suitable as the primary sync mechanism for true collaboration.

## Recommended Strategy

**Phase 1 — Now:** Propose Proposal 3 (Enhanced Plugin API) to Tropy maintainers. Start with just `projectOpened()` and `projectClosing()` hooks as an initial PR. These alone eliminate context polling and give plugins a reliable lifecycle.

**Phase 2 — After hooks land:** Add `projectChanged()` and the scoped DB handle. Rewrite Troparcel to use direct model access instead of the HTTP API. This fixes the missing-endpoint problem and removes file watching.

**Phase 3 — If Tropy team is interested:** Propose Proposal 1 (Core Integration) as a native feature. The work done in Phase 2 provides a working reference implementation.

**Long-term:** Monitor cr-sqlite maturity. If it stabilizes and solves the ID problem cleanly, Proposal 2 becomes the simplest possible architecture — the sync layer shrinks to ~500 lines of transport code.

## Key Findings from Codebase Analysis

1. **Tropy's plugin system has only 3 hooks** (`export`, `import`, `transcribe`) — all batch-oriented, none lifecycle-aware.

2. **The REST API is missing critical write endpoints:** No `POST /project/selections`, no `PUT /project/notes/:id`, no selection update. The plugin calls these but they return 404 on stock Tropy.

3. **`db.on('update')` already exists** (`src/common/db.js:129`) — it fires on every INSERT/UPDATE/DELETE with the SQL query. This is exactly the change notification the plugin needs but can't access.

4. **Tropy uses Redux-Saga** with a command pattern — any new sync operation fits naturally as a saga fork or a command handler.

5. **The `Database` class uses a connection pool** (`generic-pool`, max 3 connections, 60s idle timeout). Direct DB access from a plugin would share this pool, getting automatic connection management and busy-timeout handling.

6. **Tropy already uses WAL mode** for managed projects. This is compatible with all four proposals.

7. **The plugin `unload()` method is called** on window close, but there's no notification of project open/close — the plugin must detect this from context object mutations and logger bindings.
