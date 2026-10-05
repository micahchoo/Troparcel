# Troparcel Changelog

## Unreleased (6.1)

### Found by long soak runs (several Tropys, restarts, outages)

- **A Tropy could stop reconnecting for good after an outage.** An error
  raised while reporting the refused connection stopped the retries, and the
  Tropy stayed offline without saying so. Nothing that reports the
  connection may throw now.
- **A collaborator's withdrawn note was deleted, not struck through, and the
  withdrawal was retried forever.** Tropy's note.delete leaves the note in its
  state and only takes it off its photo's list; Troparcel waited for it to go.
  A note now counts as deleted once its photo or selection no longer lists it.
- **A restart could publish received transcriptions and selections as your
  own.** The first push ran before the room had arrived, so a copy received
  from bob looked new and was written over bob's entry. Troparcel now waits
  for the room before its first push, and never writes over an entry its
  records say another member wrote.
- **Pasting the wrong address in setup** (a share link, the setup page's own
  address, a server's web page) now says what it is and what to paste.

## v6.0.0 (2026-10-05) — Room schema 5, writes Tropy can trust

**Upgrade everyone in a group at the same time.** Troparcel 6 converts a
room written by Troparcel 5 the first time it opens it, but Troparcel 5
cannot read the new layout.

### Data loss fixed

- **Concurrent first writes lost a peer's annotations.** The v4 room nested a
  map per item and per section, created on first write. When two peers first
  wrote the same item (or the first note, tag, … on it) before seeing each
  other's change, Yjs kept one map and discarded the other with its contents:
  200 of 200 runs lost data. Schema 5 keeps every section top-level, keyed
  `<item>|<key>`, so concurrent writes only ever compete for single entries.
- **A collaborator's second edit to a field was reverted.** The merge base was
  updated on push but not on apply, so after receiving a value a peer took its
  own copy for a local edit, refused the next remote value and pushed the old
  one back. The base is now recorded on apply too, and saved to disk, so a
  restart no longer makes every field look locally edited.
- **Shortened notes were never applied** (a "local text contains remote text"
  shortcut). Applied notes are now tracked by the exact remote content.
- **Shared-folder sync lost writes.** Every peer wrote one shared file. Each
  peer now writes only its own file and reads the others'.
- **Deleting a collaborator's entry erased it from the room.** With Share
  deletions on, deleting someone else's note, selection or transcription on
  your own computer wrote a tombstone over their entry, so anyone who joined
  later never received it. Now only an entry's author can tombstone it.
- **One oversized entry stopped its whole item.** Now that entry alone is
  skipped.
- **Deleted selections and transcriptions now reach the others.** A
  selection the owner has written on is kept.
- **Templates received from a room were never saved** (dispatched with
  `meta.done`, which skips Tropy's database command); gone after a restart.

### Tropy writes

- Every write goes through the Redux store as a Tropy command, with the
  payload shapes of Tropy's own action creators. Troparcel no longer uses
  Tropy's HTTP API: no API port to configure, no port conflicts between two
  Tropy instances. Before, remote tags, metadata and transcriptions failed
  whenever Tropy's API was not on port 2019.
- A collaborator's change is no longer added to your undo history. (The
  "one undo entry per sync" wrapper crashed Tropy's history reducer.)
- Receiving a note no longer moves your view to it.
- At start, Troparcel checks that Tropy's state looks as expected and syncs
  nothing if it does not.
- No more empty dialog on every sync start (`dialog.notify` is a modal).

### Attribution

- `@name` tags now work: they were created without a name and failed. Their
  colours are Tropy's preset colours.
- Items that received a collaborator's change are added to the list
  **Troparcel: received**.
- Attribution tags, the received list and Troparcel's metadata fields are
  never pushed back to the room.

### Setup

- Two fields: **Connection** (a connection string, a `ws://` address, or a
  shared-folder path) and **Your name**. Seven options in all, down from 23.
  Settings saved by Troparcel 5 are still read.
- The server prints a ready-to-paste connection string per room. New
  `PUBLIC_URL` sets the address it uses; `troparcel://wss/…` strings mean TLS.
- The shared-folder transport works (it was written but never connected).
  The HTTP snapshot transport is removed.

### Server

- Tombstone compaction purged a loaded copy and saved nothing. It now purges
  the open room, or stores the purge for a closed one.
- The Docker image builds from the repository root and runs on Node 24.

### Removed

- The HTTP-API fallback (`api-client.js`, `enrich.js`), the project-file
  watcher (chokidar) and `rollback()`, which re-wrote each note's current
  text and so restored nothing. Backups remain as JSON to read.

### Tests

- `npm run e2e`: two real Tropy instances (Flatpak, headless) and a synthetic
  peer, end to end.
- Scenario tests run real sync engines over a fake Tropy store that enforces
  Tropy's command rules.
- CI against Tropy 1.17.3 and `main`.

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
