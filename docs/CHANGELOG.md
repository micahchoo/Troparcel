# Troparcel Changelog

## v5.0.0 (2026-02-11) — Schema v4, Logic-Based Conflicts


### CRDT Schema v4

- **UUID keying** for notes (`n_`), selections (`s_`), transcriptions (`t_`), and lists (`l_`). Eliminates content-addressed key drift, enables in-place updates, and removes the fragile delete+recreate pattern.
- **YKeyValue** for metadata storage (via `y-utility`). Document size depends only on current map size, not historical operations. Eliminates Y.Map history bloat.
- **Awareness protocol** for user presence. Replaces the `users` Y.Map heartbeat that caused unbounded document growth.
- **Schema version field** (`room.schemaVersion = 4`) for future migration detection.
- **Tag case normalization.** CRDT tag keys are normalized to lowercase, matching Tropy's `COLLATE NOCASE` constraint. Display case preserved in the value. Prevents DB errors when peers use different casing.

### Logic-Based Conflict Resolution

- **Push side:** `vault.hasLocalEdit()` / `vault.markFieldPushed()` replaces wall-clock `ts > lastPushTs` comparison. Eliminates clock-skew sensitivity entirely.
- **Apply side:** Metadata, photo metadata, and selection metadata fields check for local edits before overwriting. Conflicts are logged with `_logConflict()` including local/remote values and resolution outcome.
- **Note apply-side conflict detection:** `vault.hasLocalNoteEdit()` / `vault.markNoteApplied()` tracks content hash of last-applied note. Prevents silent overwrite of user edits to synced notes.
- **pushSeq** monotonic per-author counter for diagnostic ordering (NOT used for conflict resolution).

### Safety and Validation

- **Backup size limit** (`maxBackupSize`, default 10MB). Oversized snapshots are skipped with a warning.
- **State shape validation.** StoreAdapter validates expected Redux slices on construction, warns if Tropy version is incompatible.
- **35+ adversarial XSS test vectors** added to the test suite for the HTML sanitizer.
- **MONITOR_TOKEN warning** on server startup when not set.
- **Tombstone retention warning** — server logs that clients offline >30 days may resurrect deleted items.
- **TLS warning** for non-localhost server deployments.

### Documentation

- New **Developer's Guide** (`docs/DEVELOPER.md`) covering architecture, CRDT schema, mixin pattern, build system, testing, and contribution workflow.
- Comprehensive documentation rewritten for v5.0.
- Conflict resolution docs updated for UUID keying and logic-based conflicts.
- Group collaboration guide updated for case-insensitive tags and logic-based conflicts.
- This changelog replaces the pre-v5 `RECOMMENDATIONS.md` proposal document (most items implemented).

### Other Changes

- Photo-less item skip upgraded from debug to info-level logging.
- Note footer rationale documented in code comments.
- Redux action dependency catalog added to StoreAdapter.
- Offline/sneakernet exchange workaround documented.
- Selection fingerprinting for apply-side dedup.
- Alias map for re-imported items with GC via tombstone purge.

---

## v4.x (Pre-v5 Development)

### v4.11 — Store-First Architecture

- **Store-first design:** Reads from Redux store via `store.getState()`, writes via `store.dispatch()`. Falls back to HTTP API when store unavailable.
- **StoreAdapter** class for Redux store abstraction with change detection via `store.subscribe()`.
- ProseMirror-to-HTML conversion for note content (simple recursive renderer, no Tropy imports).
- `_waitForAction()` with 15s timeout for Redux saga completion.
- Feedback loop prevention via `suppressChanges()` / `resumeChanges()`.

### v4.0 — CRDT Schema v3

- All per-item collections migrated from Y.Array to Y.Map for proper update/delete support.
- Tombstone support with `{ deleted: true, author, ts }` entries.
- Content-addressed keys for notes (FNV-1a hash of content + parent).
- Coordinate-hash keys for selections (FNV-1a of photo + rounded coordinates).
- SyncVault for persistent state tracking and key mappings.
- Backup system with pre-apply JSON snapshots.
- HTML sanitizer (character-by-character state machine parser).
- Safety-net poll with exponential backoff.
- Server-side LevelDB compaction with periodic tombstone purge.

---

## v3.x

### v3.0 — Server and Monitoring

- Collaboration server with LevelDB persistence.
- Web monitoring dashboard at `/monitor`.
- Per-room authentication via `AUTH_TOKENS`.
- Rate limiting (`MAX_CONNS_PER_IP`, `MAX_ROOMS`).
- SSE live events for room activity.
- Docker support with `docker-compose.yml`.

---

## v2.x

### v2.0 — Initial Release

- Basic Yjs CRDT sync over WebSocket.
- Metadata, tags, and notes sync.
- Photo checksum-based item matching.
- Export/import hooks for manual sync.
- Auto-sync with configurable debouncing.

---

## Migration Guide

### Upgrading from v4.x to v5.0

1. **Stop all Tropy instances** with Troparcel enabled.
2. **Stop the server** (`Ctrl+C`).
3. **Delete the server's `data/` directory** (LevelDB CRDT state).
4. **Delete vault files** at `~/.troparcel/vault/` on each machine.
5. **Update the plugin** — replace `index.js` with the new build.
6. **Restart the server** and all Tropy instances.
7. On first sync, each instance will re-push its local annotations with the new v4 schema.

Local Tropy project data is **never affected** by this process — only the shared CRDT state and sync metadata are cleared.

### Upgrading from v3.x to v4.x

Same process as above. The CRDT schema changed from Y.Array-based to Y.Map-based collections.
