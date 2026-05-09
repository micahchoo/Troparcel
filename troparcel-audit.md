# Troparcel Audit: Benchmark, Critique, and Improvement Proposals

This document evaluates Troparcel (v5.0, ~7,700 lines across 12 source files) against the CRDT design spec (`crdt-design.md`) and the Tropy plugin feasibility analysis (`crdt-feasibility.md`). Each section benchmarks what the design envisioned, what Troparcel actually implemented, where it exceeded or fell short, and what could be improved.

❯ tropy's codebase is here /media/2TA/DevStuff/BIIIF/tropy-plugin/tropy/
❯ troparcel's codebase is here /media/2TA/DevStuff/BIIIF/tropy-plugin/troparcel/

---

## 1. Identity Model

### Design Spec
Sorted photo checksums joined by `|`. Simple, deterministic, human-readable.

### Troparcel Implementation
SHA-256 of sorted photo checksums, truncated to 32 hex chars. Plus a fallback: SHA-256 of `template|title|date` when an item has no photos.

### Assessment

**Exceeds design** in one respect: the fallback handles photo-less items (e.g., items created as placeholders before photos are attached). The design spec assumed all items have photos, which isn't always true.

**Concerns:**

- **Fallback fragility.** The template+title+date fallback means editing a title or date changes the identity hash. If User A creates a photo-less item "Untitled" and User B renames it to "Letter from 1842", the identity diverges. This is a silent data fork.
- **Hash opacity.** The 32-char hex hash is not debuggable — you can't look at an identity and know which item it refers to without reverse-looking it up. The design spec's raw checksum list is verbose but transparent.
- **Merged item tracking.** Troparcel has an alias map (`setAlias(oldIdentity, newIdentity)`) for when items merge and the checksum set changes. This is a good solution to the design spec's "Item Splitting and Merging" open question, but it's a permanent growing map with no garbage collection described.

### Suggestions

1. **Drop the fallback or gate it.** Photo-less items are a degenerate case. Either refuse to sync them (log a warning: "item has no photos, skipping") or use a stable user-assigned identifier rather than content-derived hashing. A content-derived fallback that changes when content changes defeats the purpose of stable identity.
2. **Add alias GC.** Aliases should expire after all peers have seen the new identity (track via Yjs state vector comparison) or after a configurable time window.
3. **Consider keeping raw checksums alongside the hash** for debugging. The `checksums` field in the CRDT schema (comma-separated) already exists — make sure it's always populated and used in diagnostic logging.

---

## 2. CRDT Document Structure

### Design Spec
Nested `Y.Map` hierarchy: `items → Y.Map<identity → Y.Map>`, with sub-maps for metadata, tags, notes, etc.

### Troparcel Implementation
Schema v4: single top-level `Y.Map("annotations")` keyed by identity. Each item is a `Y.Map` containing:
- `metadata`: `YKeyValue` (Y.Array-backed, not Y.Map)
- `tags`: `Y.Map`
- `notes`: `Y.Map` (UUID-keyed)
- `photos`: `Y.Map<checksum → Y.Map>` with nested `YKeyValue` for photo metadata
- `selections`: `Y.Map` (UUID-keyed)
- `selectionMeta`: `YKeyValue` (composite key: `selUUID:propUri`)
- `selectionNotes`: `Y.Map` (composite key: `selUUID:noteUUID`)
- `transcriptions`: `Y.Map` (UUID-keyed)
- `lists`: `Y.Map` (UUID-keyed)
- `uuids`: `Y.Map` (recovery registry)
- `aliases`: `Y.Map` (merged item redirect)
- `checksums`: string

### Assessment

**Significantly exceeds design** in structural sophistication.

**YKeyValue over Y.Map for metadata** is a critical improvement. The design spec used `Y.Map` for metadata, but Y.Map retains the full history of every key (all past values persist in the Yjs update log). YKeyValue uses a Y.Array internally and manages key deduplication itself, meaning old values are truly replaced. For metadata-heavy projects (many properties, frequent edits), this prevents unbounded CRDT growth.

**UUID-keyed sub-resources** (notes, selections, transcriptions) instead of content-derived keys is more robust. The design spec suggested content-addressing for notes and geometry-addressing for selections, but:
- Content-addressed notes break when a note is edited (the key changes)
- Geometry-addressed selections break when a selection is resized

UUIDs are stable regardless of content changes. The vault maintains the UUID ↔ local ID mapping.

**Concerns:**

- **Schema complexity.** 12 sub-maps per item is a lot of structure. The composite key pattern (`selUUID:propUri`, `selUUID:noteUUID`) is functional but makes the schema harder to reason about than truly nested maps. A `Y.Map` per selection with its own notes/metadata sub-maps would be more intuitive.
- **Flat selection notes.** Selection notes live at the item level (`selectionNotes`) with composite keys rather than nested under each selection. This means iterating all selection notes for an item to find those for a specific selection requires filtering by prefix. Nested structure would be O(1) lookup.
- **UUID registry (`uuids` map).** This is a recovery mechanism for rebuilding vault mappings from the CRDT. It grows monotonically (one entry per UUID ever created). No pruning strategy is documented.

### Suggestions

1. **Consider nesting selections fully.** Instead of flat `selectionMeta` and `selectionNotes` at item level with composite keys, nest them under each selection's Y.Map. This is cleaner and avoids key-parsing logic:
   ```
   selections → Y.Map<uuid → Y.Map>
     └── metadata: YKeyValue
     └── notes: Y.Map<noteUUID → Y.Map>
     └── transcriptions: Y.Map<txUUID → Y.Map>
   ```
   Trade-off: deeper nesting means more Y.Map allocations and deeper observer chains. Benchmark whether this matters at realistic scale.

2. **Prune the UUID registry.** Add a tombstone-style expiry: if a UUID's parent item has been deleted (all entries tombstoned) for more than N days, remove the UUID registry entry.

3. **Document the schema formally.** The 992-line `crdt-schema.js` is the de facto spec, but a standalone schema document (like a JSON Schema or TypeScript interface) would help contributors and future auditors understand the structure without reading 992 lines of getters/setters.

---

## 3. Metadata Sync

### Design Spec
LWW per-property via Y.Map. Last writer wins based on Yjs vector clock.

### Troparcel Implementation
YKeyValue per-property with **logic-based conflict resolution**: compare field value hashes, remote wins only if local is unchanged since last push. Vault tracks per-field `pushedFieldValues` hashes.

### Assessment

**Significantly exceeds design.** Pure LWW (as in the design spec) means any concurrent edit to the same field results in one value silently overwriting the other, determined by Yjs clock ordering which is essentially arbitrary. Troparcel's logic-based approach is materially better:

- If you edited `dc:title` locally since the last push, and a remote change arrives for `dc:title`, your local edit is preserved (local wins because you made a deliberate change).
- If you haven't touched `dc:title` since last push and a remote change arrives, the remote value is applied (remote wins because you don't care about the old value).

This is closer to an **operational intent** model than raw LWW.

**Concerns:**

- **Hash-based change detection is brittle across reformat.** If Tropy normalizes whitespace or changes date formatting between reads, the hash changes even though the semantic value is identical. This would cause the vault to think a local edit occurred when it didn't, blocking legitimate remote updates.
- **No multi-value merge.** If both users edit the same field, one still loses. There's no "keep both values" or "show conflict" option. For string fields this is probably acceptable, but for fields like `dc:description` (long text), losing an edit is painful.
- **Push sequence tracking.** The `pushSeq` field (monotonic counter per author) is used for ordering but its interaction with the logic-based conflict resolution isn't entirely clear — is it used for anything beyond debugging?

### Suggestions

1. **Normalize values before hashing.** Trim whitespace, normalize Unicode (NFC), collapse internal whitespace for comparison. This prevents phantom "changes" from formatting differences.
2. **Consider a conflict log.** When a remote value overwrites a local value (even via LWW), log both values with timestamps and authors to a recoverable conflict history. The backup system captures pre-apply snapshots, but a per-field conflict log would be more granular and useful for "why did my title change?" debugging.
3. **Expose `pushSeq` purpose.** If it's purely diagnostic, consider dropping it to reduce CRDT entry size. If it serves a causal ordering purpose, document it.

---

## 4. Tag Sync

### Design Spec
`Y.Array<string>` with dedup by name (set union semantics).

### Troparcel Implementation
`Y.Map<tagName → {color, author, pushSeq, deleted?}>`. Supports soft-delete via `deleted: true` flag. Active vs deleted tags are filtered by the `getActiveTags`/`getDeletedTags` helpers.

### Assessment

**Exceeds design.** Using a Y.Map keyed by tag name gives O(1) lookup and natural dedup (setting the same tag name twice just updates the entry). The design spec's Y.Array requires manual dedup on read.

Soft-delete support answers the design spec's "Deletion Propagation" open question with an OR-Set-like approach: tags can be removed and the removal propagates, but the tombstone remains so re-adding is possible.

**Concerns:**

- **Case sensitivity.** Tropy tags are `UNIQUE (name) COLLATE NOCASE` in the DB. Troparcel's Y.Map keys are case-sensitive. If User A creates tag "Archival" and User B creates tag "archival", these are two separate CRDT entries but would collide in Tropy's database. The dedup must happen at apply time.
- **Color sync.** The `color` field is synced, but if two users set different colors for the same tag, the result is arbitrary (Y.Map LWW on the whole entry). This is minor but could be surprising.
- **Tombstone accumulation.** Deleted tags remain as tombstoned entries forever unless the server runs `purgeTombstones`. For projects with heavy tag churn, this grows the CRDT.

### Suggestions

1. **Normalize tag names to lowercase in the CRDT.** This matches Tropy's COLLATE NOCASE behavior and prevents case-collision bugs. Display the original casing from the first author who created the tag.
2. **Consider separating color from tag identity.** If color is personal preference, don't sync it. If it's shared, make it a separate LWW field rather than part of the tag entry (so color changes don't conflict with tag creation).

---

## 5. Note Sync

### Design Spec
Append-only `Y.Array<Y.Map>`. Both users' notes preserved, dedup by `(author, created)`.

### Troparcel Implementation
UUID-keyed `Y.Map` with embedded footer in HTML (`[troparcel:UUID from Author — safe to delete]`). Vault tracks UUID ↔ local note ID mapping. Supports soft-delete. HTML sanitized via state-machine parser.

### Assessment

**Exceeds design in some areas, adds complexity in others.**

The UUID-keyed approach is better than the design spec's append-only array because it enables:
- Updating a note in place (same UUID, new content)
- Deleting a specific note by UUID
- Tracking which local note corresponds to which CRDT entry

The HTML sanitizer (`sanitize.js`, 381 lines) is thorough — character-by-character parsing, entity decoding to defeat `&#x6A;avascript:` attacks, allowlisted tags/attributes/CSS properties. This is a critical security measure absent from the design spec.

**Concerns:**

- **Footer embedding is fragile.** The `[troparcel:UUID from Author]` footer is injected into the note HTML and parsed back out via regex. This means:
  - If a user manually edits or deletes the footer, the UUID mapping is lost and the note becomes an orphan (will be re-created as a new note on next sync)
  - The footer is visible to the user as part of the note content — it's not hidden metadata
  - ProseMirror may reformat the footer HTML, breaking the regex
- **Note update is delete+recreate.** The feasibility doc confirmed Tropy has no note update API endpoint. Troparcel's `StoreAdapter.updateNote` does delete+recreate. This means the local note ID changes on every update, requiring vault re-mapping. If the delete succeeds but the create fails, the note is lost.
- **No collaborative editing.** Notes are whole-value sync (replace entire HTML blob). Two users editing the same note results in one version winning. The design spec's Scenario C (Y.XmlFragment + ProseMirror binding) is acknowledged as infeasible from a plugin, and Troparcel correctly doesn't attempt it.

### Suggestions

1. **Consider invisible footer encoding.** Instead of a visible `[troparcel:UUID]` text block, embed the UUID in an HTML comment (`<!-- troparcel:UUID -->`) or a `data-` attribute on a hidden element. This keeps the note visually clean. Trade-off: HTML comments might be stripped by ProseMirror serialization — test this.
2. **Make delete+recreate atomic.** Wrap the note update in a try/catch where if create fails after delete, the old note content is re-created from the vault's last known state.
3. **Add note diffing for conflict detection.** Before overwriting a note with a remote version, check if the local note has been edited since last sync (compare text hash). If both sides changed, either keep both versions (append the remote as a new note) or merge with a visible conflict marker.

---

## 6. Selection Sync

### Design Spec
Keyed by geometry string `"x{x}y{y}w{w}h{h}"`. Two users making the same crop merge; different crops coexist.

### Troparcel Implementation
UUID-keyed selections with **fingerprint matching**: `computeSelectionFingerprint(photoChecksum, sel)` generates an FNV-1a hash of `sel:checksum:x:y:width:height`. On push, if a selection with matching fingerprint already exists in the CRDT, the existing UUID is reused. Vault tracks UUID ↔ local selection ID.

### Assessment

**Exceeds design.** Fingerprint matching is better than raw geometry keys because:
- UUIDs are stable even if the user slightly adjusts the selection bounds (the UUID stays, only the geometry fields update)
- The fingerprint is used only for initial matching; subsequent syncs use the UUID

The feasibility doc noted that **selection creation via API is impossible** — there's no `POST /project/selections` endpoint. Troparcel works around this via the `StoreAdapter.createSelection()` which dispatches a Redux action directly. This is a legitimate workaround that the feasibility doc didn't identify (it only assessed the HTTP API path).

**Concerns:**

- **Redux dispatch for selection creation is undocumented behavior.** Tropy doesn't officially expose Redux actions as a plugin API. If Tropy refactors its Redux actions or changes the action format, this breaks silently.
- **Floating point geometry.** Selection coordinates in Tropy are `NUMERIC` (can be float). The fingerprint hash includes exact coordinate values. If one instance stores `x: 100.0` and another stores `x: 100`, these produce different fingerprints. Normalize to integers or fixed-precision before hashing.

### Suggestions

1. **Round geometry to integers before fingerprinting.** Selections are pixel coordinates — sub-pixel precision is meaningless for identity matching.
2. **Document the Redux action dependency.** List exactly which Redux actions Troparcel dispatches and which state slices it reads. This creates a clear contract that can be validated against future Tropy versions.

---

## 7. Transcription Sync

### Design Spec
Append-only or LWW-by-author.

### Troparcel Implementation
UUID-keyed `Y.Map` with soft-delete. Each transcription stores `{text, data (ALTO XML), photo, selection, author, pushSeq}`.

### Assessment

**Matches design** (the UUID-keyed approach is effectively LWW-by-author — each author's transcription gets its own UUID).

**Concerns:**

- **ALTO XML size.** ALTO XML can be very large (hundreds of KB for a full-page OCR result). This is stored as a string in the CRDT entry. For a project with 1,000 photos each with ALTO transcriptions, the CRDT document could be 100MB+. The design spec didn't consider this, and Troparcel's `maxMetadataSize` (64KB) guard wouldn't catch it because transcriptions are separate from metadata.
- **No transcription update via API.** The feasibility doc confirmed there's no transcription update endpoint. If a transcription needs correction, Troparcel would need to delete+recreate (same fragility as notes).

### Suggestions

1. **Add a size guard for transcriptions.** Similar to `maxNoteSize` (1MB), add `maxTranscriptionSize` with a reasonable default (e.g., 512KB). Log a warning and skip oversized transcriptions.
2. **Consider not syncing ALTO XML.** The `data` field (ALTO XML) is machine-generated OCR output. If both users run OCR independently, they'll get similar results. Syncing only the `text` field (human-readable) and letting each instance generate its own ALTO would dramatically reduce CRDT size.

---

## 8. Deletion Propagation

### Design Spec
Listed as an open question. Discussed add-only (safest) vs OR-Set (propagating deletes).

### Troparcel Implementation
Tombstone-based soft deletes with configurable `syncDeletions` flag. Tombstone flood detection (if >50% of entries in a category are deleted, warn). Server-side tombstone purging after 30 days.

### Assessment

**Resolves the design spec's open question well.** The configurable `syncDeletions` flag lets users opt into or out of deletion propagation. The flood detection catches malicious or buggy mass-deletion scenarios.

**Concerns:**

- **Tombstone flood threshold is per-category.** If a user legitimately deletes 60% of their tags (narrowing down from exploratory tagging), this triggers a flood warning even though it's intentional behavior. The threshold should perhaps be absolute count-based rather than ratio-based, or should require a minimum count before the ratio check applies.
- **30-day tombstone retention.** If a user is offline for >30 days, they miss deletion events after purging. Their next sync would re-push the "deleted" items as alive, causing ghost resurrection. This is a known trade-off but should be documented prominently.

### Suggestions

1. **Add a minimum count before flood detection.** Only trigger the 50% ratio check if there are at least N total entries (e.g., 20). Deleting 3 out of 5 tags shouldn't be suspicious.
2. **Document the 30-day purge window.** Users need to know: if you go offline for >30 days, you should do a full re-sync rather than incremental.

---

## 9. Change Detection

### Design Spec (Feasibility Doc)
Polling the HTTP API is the only option. No change event hooks from Tropy.

### Troparcel Implementation
**Redux store subscription** via `StoreAdapter.subscribe()`. Watches state slices (`items`, `photos`, `selections`, `notes`, `metadata`, `tags`, `lists`, `transcriptions`) and fires a callback when any slice changes. Falls back to HTTP API polling via safety-net interval (default 120s).

### Assessment

**Significantly exceeds the feasibility doc's assessment.** The feasibility doc concluded that polling was the only option because plugins have no change event hooks. Troparcel discovered that `context.window.store` exposes the Redux store, and Redux store subscriptions provide fine-grained change detection without polling.

This is the single most important architectural improvement over the design spec. It means:
- Changes are detected within milliseconds (Redux dispatch → subscription callback)
- No wasted API calls polling for unchanged state
- The safety-net poll is a backup, not the primary mechanism

**Concerns:**

- **Store availability timing.** The store becomes available only after `win.load()` completes. Troparcel handles this with a startup delay (default 8s) and polling for store availability every 500ms. This is functional but fragile — if Tropy's startup takes longer (large project, slow disk), the 8s default may not be enough.
- **Suppression during apply.** When applying remote changes, Troparcel calls `suppressChanges()` to prevent the store subscription from firing for its own writes (which would create a push→apply→push loop). If an exception interrupts the apply phase before `resumeChanges()` is called, change detection stays suppressed permanently. A try/finally guard would be safer.
- **Undocumented API surface.** Redux store access is not part of Tropy's plugin contract. It works because `context.window` is the Window singleton, which happens to have a `.store` property. This could break in any Tropy update.

### Suggestions

1. **Replace the fixed startup delay with a ready-check loop.** Instead of waiting 8 seconds and hoping, poll for `context.window.store?.getState()` every 500ms with no upper time limit (but with a warning after 15s). This handles both fast and slow startups.
2. **Wrap apply phase in try/finally for `resumeChanges`.** Ensure change detection is always re-enabled even if apply throws.
3. **Track Tropy version compatibility.** Check `context.window.store` existence at startup and log a clear error if it's unavailable: "Tropy version X does not expose Redux store — falling back to HTTP polling."

---

## 10. Sync Engine Architecture

### Design Spec
Simple cycle: poll → diff → push to CRDT / observe CRDT → write via API.

### Troparcel Implementation
Sophisticated engine with:
- Async mutex (`_acquireLock`) preventing concurrent sync operations
- Debounced local changes (2s) and remote changes (500ms)
- Safety-net polling (120s fallback)
- Exponential backoff on errors (max 8s)
- Error threshold (3 consecutive errors) before auto-pause
- Push sequence numbering for causal ordering
- Backup-before-apply with rollback capability

### Assessment

**Far exceeds design** in production-readiness. The design spec described a conceptual sync loop; Troparcel implements a battle-tested engine with failure recovery, rate limiting, and data safety.

**Concerns:**

- **1,441 lines is a lot for one file.** `sync-engine.js` is the largest file and does too many things: connection management, sync orchestration, observer setup, lock management, error recovery, export/import hooks. This is a maintenance burden — a bug in lock management requires understanding 1,441 lines of context.
- **Mixin pattern.** Methods from `push.js`, `apply.js`, and `enrich.js` are assigned to the SyncEngine prototype. This means the SyncEngine class definition doesn't show its full interface — you have to know to check three other files. TypeScript or explicit composition would make the API surface discoverable.
- **Write delay between items, not fields.** The `writeDelay` (default 100ms) is applied between items during apply, but all fields within an item are written in quick succession. If Tropy's SQLite has contention (SQLITE_BUSY), the per-field writes within one item could fail. The API client has retry logic (3 retries with exponential backoff), which handles this, but the interaction between write delay and retry is complex.

### Suggestions

1. **Split sync-engine.js.** Extract connection management, lock management, and observer setup into separate modules. The core orchestration (syncOnce → pushLocalOnce + applyPendingRemote) should be readable in isolation.
2. **Consider explicit composition over mixins.** Instead of assigning push/apply/enrich methods to the prototype, use composition: `this.pusher = new Pusher(this)`, `this.applier = new Applier(this)`. This makes dependencies explicit and enables independent testing.
3. **Add integration tests for the lock + debounce + retry interaction.** The async mutex, debouncing, and retry logic are three independent concurrency mechanisms that interact in subtle ways. A test that simulates concurrent local edits + remote changes + SQLITE_BUSY errors would validate that they compose correctly.

---

## 11. Server

### Design Spec
"Lightweight server (Node.js + LevelDB)."

### Troparcel Implementation
830-line standalone server with:
- y-websocket relay
- LevelDB persistence
- Room-token authentication (timing-safe comparison)
- Per-IP rate limiting
- REST health/status endpoints
- SSE activity streams
- HTML monitoring dashboard
- Automatic compaction (6-hour cycle)
- Tombstone purging (30-day retention)

### Assessment

**Far exceeds design** in operational readiness. The design spec imagined a minimal relay; Troparcel built a production-grade server with auth, monitoring, and maintenance.

**Concerns:**

- **Single-file server.** 830 lines in one file covering HTTP routing, WebSocket handling, auth, rate limiting, persistence, compaction, monitoring, and dashboard HTML. This will be hard to maintain or extend.
- **No TLS.** WebSocket connections are `ws://`, not `wss://`. For localhost this is fine, but for remote collaboration the token is sent in cleartext. The README should strongly recommend reverse-proxying through nginx/caddy with TLS.
- **No room isolation for monitoring.** The `/monitor/status` endpoint shows all rooms. In a multi-tenant deployment, this leaks room names (which may reveal project names).
- **LevelDB single-writer limitation.** LevelDB allows only one process to open a database directory. If the server crashes without clean shutdown, the lock file may prevent restart. y-leveldb may handle this, but it should be documented.

### Suggestions

1. **Split server into modules.** Auth, routing, persistence, monitoring, and WebSocket handling should be separate files.
2. **Add TLS guidance or built-in option.** Either support `wss://` natively (pass cert/key via env vars) or prominently document the reverse proxy requirement.
3. **Add room-scoped monitoring.** The monitor token should optionally be per-room, so multi-tenant deployments don't leak cross-room information.

---

## 12. Store Adapter (Redux Integration)

### Design Spec (Feasibility Doc)
Not considered — the feasibility doc assessed only the HTTP API path.

### Troparcel Implementation
666-line `StoreAdapter` that reads Redux state directly and dispatches actions for writes. Eliminates N+1 HTTP API calls for item enrichment. Includes ProseMirror-to-HTML conversion, change subscription, and action completion waiting.

### Assessment

**The single most impactful architectural decision in Troparcel.** By reading the Redux store directly, Troparcel avoids the biggest performance bottleneck identified in the feasibility doc: polling the HTTP API and doing O(N) requests per item for enrichment.

`getAllItemsFull()` assembles every item with all nested data (photos, selections, notes, metadata, tags, transcriptions) from a single Redux state snapshot — zero HTTP calls.

**Concerns:**

- **ProseMirror rendering is reimplemented.** `_renderDoc`/`_renderNode` (120+ lines) manually converts ProseMirror JSON to HTML. Tropy already has `serialize()` in `src/editor/serialize.js` for this. If Troparcel's renderer doesn't handle a node type that Tropy's does (or handles it differently), notes will be subtly malformed.
- **Action completion heuristic.** `_waitForAction` watches `state.activities[seq]` to determine when a dispatched action completes. This depends on Tropy's internal activity tracking, which is an implementation detail.
- **Deep state access.** The adapter reads `state.items`, `state.photos`, `state.selections`, `state.notes`, `state.metadata`, `state.tags`, `state.lists`, `state.transcriptions`, `state.activities`. If any of these state shapes change in a Tropy update, the adapter silently produces wrong data.

### Suggestions

1. **Reuse Tropy's serialize module if possible.** Since plugins run in the renderer process with the same module system, try `require`-ing Tropy's own `src/editor/serialize.js` rather than reimplementing ProseMirror-to-HTML. If the path is unstable, at minimum add tests that compare Troparcel's rendering output against Tropy's for a representative set of ProseMirror documents.
2. **Add state shape validation.** On startup, check that the expected keys exist in the Redux state (`state.items`, `state.photos`, etc.). If they don't, log a version incompatibility warning and fall back to the HTTP API path.
3. **Version-gate the adapter.** Check `context.window.store?.getState()?.project?.version` (or similar) and only use the store adapter for known-compatible Tropy versions. Fall back to HTTP API for unrecognized versions.

---

## 13. HTML Sanitization

### Design Spec
Not addressed.

### Troparcel Implementation
381-line state-machine HTML parser/sanitizer. Character-by-character tokenization, entity decoding, protocol validation, CSS property allowlisting.

### Assessment

**Critical security measure** that the design spec overlooked entirely. Since notes are HTML strings synced between instances, a malicious or compromised peer could inject `<script>` tags, `javascript:` URLs, or CSS-based attacks. The sanitizer prevents all of these.

The implementation is solid:
- State-machine parser (not regex) handles malformed HTML correctly
- Entity decoding defeats `&#x6A;avascript:` obfuscation
- Protocol allowlist (http, https, mailto only)
- CSS property allowlist (only text-decoration and text-align)
- Tag name length limit (32 chars) prevents buffer-based attacks

**Concerns:**

- **No test suite visible.** A sanitizer this critical should have extensive test coverage including adversarial inputs (OWASP XSS cheat sheet, mutation XSS vectors, unicode normalization attacks).
- **`data-*` attributes are blocked.** This is correct for security, but may strip legitimate ProseMirror annotations if Tropy's editor ever uses data attributes.
- **Style injection via allowed properties.** `text-decoration` and `text-align` are safe, but future additions to the allowlist need careful review. A `background` or `position` property could enable UI redress attacks.

### Suggestions

1. **Add a comprehensive test suite** using known XSS vectors (e.g., the OWASP XSS Filter Evasion Cheat Sheet). Fuzz test with randomized malformed HTML.
2. **Consider using DOMPurify.** It's battle-tested, actively maintained, and smaller than a custom implementation. Trade-off: adds a dependency. But a dependency with thousands of eyes on it may be safer than a bespoke 381-line parser.

---

## 14. Backup and Rollback

### Design Spec
Not addressed.

### Troparcel Implementation
`BackupManager` saves pre-apply snapshots to `~/.troparcel/backups/ROOM/`, validates inbound data (size checks, tombstone flood detection), and supports rollback to a previous snapshot.

### Assessment

**Valuable safety net** absent from the design spec. The inbound validation catches:
- Notes exceeding 1MB (could be a data corruption or attack)
- Metadata fields exceeding 64KB
- Tombstone flood (>50% of entries deleted — possible malicious mass-delete)

Rollback restores metadata and tags via API.

**Concerns:**

- **Rollback doesn't restore notes fully.** The backup captures note content, but rollback creates new notes (new local IDs). If the user had editing history on the original notes, it's lost.
- **Rollback doesn't restore selection coordinates.** The backup manager explicitly warns about this limitation — selection geometry can't be updated via the API.
- **Backup size.** For large projects, each snapshot includes all metadata for every synced item. 10 backups of a 5,000-item project could use significant disk space.

### Suggestions

1. **Add backup size estimation and limits.** Before saving, estimate the snapshot size and skip if it exceeds a configurable maximum. Log a warning.
2. **Consider incremental backups.** Only capture items that changed since the last backup, with periodic full snapshots (e.g., every 10th backup is full).

---

## 15. Scenario Coverage

### Scenario A (Async Offline-First)

**Partially supported.** The export/import hooks provide manual sync. However:
- Export is user-initiated (select items → export to plugin)
- Import is user-initiated
- There's no "export CRDT state to file" / "import CRDT state from file" for sneakernet exchange
- The plugin is designed around live WebSocket sync, not file-based exchange

**Gap**: Add a "save sync state to file" / "load sync state from file" option for true offline exchange.

### Scenario B (Background Sync via Server)

**Fully implemented.** This is Troparcel's primary mode. WebSocket connection, background sync, debounced change detection, safety-net polling. Production-grade.

### Scenario C (Real-Time Collaborative Editing)

**Not implemented, correctly.** The feasibility doc confirmed this requires ProseMirror integration that plugins can't access. Troparcel doesn't attempt it.

### Scenario D (Hybrid)

**Phase 1 is fully implemented.** Background sync for metadata/tags/notes(append)/transcriptions/selections. Manual export/import as fallback.

**Phase 2 (real-time note co-editing) is not implemented** and can't be without Tropy core changes.

---

## 16. Overall Assessment

### Strengths

1. **Redux store integration** — The single most important architectural win. Eliminates the polling bottleneck that the feasibility analysis identified as the biggest limitation.
2. **Logic-based conflict resolution** — Materially better than raw LWW. Preserves intentional local edits.
3. **CRDT schema sophistication** — YKeyValue for metadata, UUID-keyed sub-resources, alias maps for merged items. All improvements over the design spec.
4. **Security** — HTML sanitization, file-path import blocking, timing-safe auth on server.
5. **Operational readiness** — Backup/rollback, tombstone management, error recovery, monitoring.

### Weaknesses

1. **Undocumented Tropy internals dependency** — Redux store access, action dispatching, state shape assumptions. Any Tropy update could break the plugin silently.
2. **Code organization** — sync-engine.js (1,441 lines), mixin pattern, server.js (830 lines). High maintenance burden.
3. **Note footer fragility** — Visible `[troparcel:UUID]` footer in note HTML is user-editable and parser-dependent.
4. **No test suite visible** — For a 7,700-line codebase handling security-sensitive HTML sanitization and concurrent data sync, tests are essential.
5. **Identity fallback fragility** — Photo-less items use content-derived identity that changes when content changes.

### Priority Improvements

1. **Add tests.** Especially for sanitize.js, identity.js, and the push/apply conflict resolution logic.
2. **Version-gate Redux access.** Detect Tropy version, validate state shape, fall back to HTTP API gracefully.
3. **Split large files.** sync-engine.js and server/index.js each need decomposition.
4. **Invisible note UUID embedding.** HTML comments or data attributes instead of visible footer.
5. **Scenario A support.** Add file-based CRDT state exchange for offline/sneakernet collaboration.
