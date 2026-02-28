# Red/Blue Team Testing Design — Troparcel Test Suite

**Date**: 2026-02-27
**Status**: Approved
**Goal**: 8 independent teams (each picks red or blue stance) targeting different scopes and methods. Mix of finding real bugs in current code and stress-testing architecture for future robustness.

## Current State

- **208 tests**, 183 pass, 25 fail (mostly store-adapter and crdt-schema — v5 migration seams)
- **16 top-level describe blocks** covering: connection-string, sanitize, identity, vault, backup, crdt-schema, api-client, plugin, store-adapter, attribution, v5 schema/store/vault, push, apply, roundtrip
- **Test infra**: `node:test` + `node:assert/strict`, helpers in `test/helpers.js` (builders + mocks)

## Attack Surface Summary

| Surface | Trust Level | Current Coverage |
|---------|------------|-----------------|
| CRDT doc (Y.Doc) | Remote peer writes freely | Schema ops tested, no adversarial input |
| Vault persistence | Local filesystem, no integrity check | Roundtrip + clear tested, no invariant proofs |
| Identity hashing | Deterministic but fuzzy matching trusts Jaccard | Basic hash tests, no collision testing |
| HTML sanitization | Untrusted remote HTML in Electron app | Strong OWASP coverage, no mutation XSS |
| Store adapter | Trusted Redux store | 25 failing tests, needs edge case hardening |
| Sync engine lifecycle | Internal orchestration | No lifecycle tests at all |
| Connection/backup | User input + filesystem | Basic parsing, no boundary exhaustion |
| Push/apply roundtrip | Cross-peer data flow | 3 roundtrip tests, minimal conflict scenarios |

## Cross-Cutting Risk Themes (from deep analysis)

1. **userId is self-reported** — no authentication. Any peer claiming another's userId bypasses all conflict guards.
2. **Vault file is trusted input** — no HMAC/checksum. Filesystem access → arbitrary ID mapping injection.
3. **Bidirectional map invariant (`crdtKey ↔ localId`) assumed but never verified** — LRU eviction breaks it.
4. **`suppressChanges` is a boolean, not a refcount** — nested suppression causes premature resume.
5. **Tombstone ownership defense empty on first join** — new peers accept tombstones from any author.

---

## Team 1 — RED: CRDT Poisoning

**Scope**: `src/crdt-schema.js`, the Y.Doc layer
**Method**: Craft malicious Y.Doc entries that bypass schema assumptions
**Target files**: `src/crdt-schema.js`, `src/push.js` (no size guard on push side)

### Test Scenarios

| # | Scenario | What it proves |
|---|----------|---------------|
| 1.1 | Schema version mismatch: inject v3 content-addressed keys into a v4 room | Engine should reject or migrate, currently silently accepts |
| 1.2 | Oversized metadata values written to CRDT (push.js has no `maxMetadataSize` check) | Size guard gap on push side — only backup.js validates on apply |
| 1.3 | Malformed UUID keys: `n_<script>`, `s_../../../etc/passwd`, `l_` (empty suffix) | Schema layer should reject non-conforming keys |
| 1.4 | Template fields with 1MB property URIs, null characters in labels | Remote template dispatch has no field validation |
| 1.5 | Duplicate tag names with different casing (`Important` vs `important` vs `IMPORTANT`) | Tag matching should be case-aware or case-normalized |
| 1.6 | Alias entry pointing identity-A's annotations at identity-B's data | Alias resolver trusts CRDT aliases without origin verification |
| 1.7 | Y.Map entry with `deletedAt` in the future (year 9999) | Tombstone GC should handle abnormal timestamps |
| 1.8 | Metadata with `author` field set to empty string, null, `undefined` | Author comparisons throughout push/apply should handle missing author |

### Key Finding to Validate
Push-side has **zero** size validation. `pushMetadata()` writes arbitrary `text` values. The only guard is `backup.validateInbound()` on the apply side — which is advisory, not blocking for metadata.

---

## Team 2 — BLUE: Vault Integrity Invariants

**Scope**: `src/vault.js` — persistence, serialization, ID mappings
**Method**: Property-based testing of serialization roundtrips + invariant assertions
**Target files**: `src/vault.js`

### Test Scenarios

| # | Scenario | What it proves |
|---|----------|---------------|
| 2.1 | Full serialization roundtrip: populate all vault state → `persistToFile` → `loadFromFile` → deep equality | All fields survive persistence |
| 2.2 | Bidirectional map invariant after N random operations: `crdtKeyToNoteId.get(noteIdToCrdtKey.get(x)) === x` | Maps stay consistent (currently untested) |
| 2.3 | LRU eviction of `noteIdToCrdtKey` → check `crdtKeyToNoteId` still consistent | **Expected to fail** — eviction is one-sided |
| 2.4 | `pushSeq` monotonicity: 100 random `incrementPushSeq()` calls → never decreases | Core ordering invariant |
| 2.5 | `failedNoteKeys` migration: load each of the 3 legacy formats → verify correct Map state | Format migration correctness |
| 2.6 | Vault load from each version (1, 2, 3, 4) → verify defaults for missing fields | Backward compatibility |
| 2.7 | `.tmp` file exists but main file doesn't → verify load behavior | Crash recovery scenario |
| 2.8 | Concurrent `markDirty()` + `persistToFile()` → verify no dirty state loss | Async safety |
| 2.9 | `clear()` resets ALL state including v5 additions (template hashes, list mappings) | Complete reset contract |
| 2.10 | `dismissedKeys` with Map entries vs old Set format → load both, verify `isDismissed` | Backward compat for dismissals |

### Key Finding to Validate
LRU eviction (scenario 2.3) is **expected to find a bug** — `_evictIfNeeded` on `noteIdToCrdtKey` doesn't touch `crdtKeyToNoteId`, causing ghost entries that grow unboundedly.

---

## Team 3 — RED: Identity Collision & Fuzzy Match Exploitation

**Scope**: `src/identity.js`, `src/sync-engine.js` fuzzy matching
**Method**: Crafted hash collisions, near-miss identities, Jaccard similarity gaming
**Target files**: `src/identity.js`, `src/sync-engine.js` (applyPendingRemote third pass)

### Test Scenarios

| # | Scenario | What it proves |
|---|----------|---------------|
| 3.1 | Two-photo item: attacker shares one checksum → Jaccard = 0.5 → match | Minimum similarity threshold is too permissive |
| 3.2 | Single-photo item: attacker uses same checksum → Jaccard = 1.0, wrong item matched | Single-photo items are maximally vulnerable to identity theft |
| 3.3 | FNV-1a 32-char hash collision: craft two different checksum sets with same identity hash | Theoretical — may need brute force, but proves hash strength |
| 3.4 | Selection fingerprint collision: different (x,y,w,h) with same fingerprint due to rounding | `computeSelectionKey` rounds coordinates — near-miss collisions exist |
| 3.5 | Note key collision: different html+photo produces same 24-char FNV-1a hash | `computeNoteKey` collision risk assessment |
| 3.6 | Empty photo array → `computeIdentity` returns null → item skipped silently | Photo-less items are invisible to sync (by design, but test the boundary) |
| 3.7 | Photo with `checksum: { '@value': '' }` — empty checksum in JSON-LD value object | Edge case in value extraction |
| 3.8 | Item with 1000 photos → identity hash stability and performance | Verify sorting + hashing doesn't degrade |

### Key Finding to Validate
Scenario 3.1 is the most critical: **a two-photo item can be hijacked by any peer that knows one of its checksums**. The Jaccard threshold of 0.5 means 1/2 overlap = match.

---

## Team 4 — BLUE: Multi-Peer CRDT Convergence

**Scope**: `src/push.js`, `src/apply.js`, `src/crdt-schema.js` — full push/apply roundtrip
**Method**: Simulate N peers with divergent operations, verify state convergence
**Target files**: `src/push.js`, `src/apply.js`, `src/crdt-schema.js`, `test/helpers.js`

### Test Scenarios

| # | Scenario | What it proves |
|---|----------|---------------|
| 4.1 | Two-peer metadata roundtrip: A pushes title → B's doc has it | Basic data flow works |
| 4.2 | Concurrent metadata edits: A sets title="Foo", B sets title="Bar" → deterministic winner | Conflict resolution is consistent |
| 4.3 | Two peers create same-content note independently → dedup produces exactly one note | Content-based dedup works |
| 4.4 | Two peers create different-content notes on same photo → both survive | Independent notes coexist |
| 4.5 | Tag add/remove interleaving: A adds "Important", B removes it → add-wins semantics hold | OC3 tag semantics verified |
| 4.6 | Selection create on both peers with same coordinates → fingerprint dedup works | Cross-instance selection matching |
| 4.7 | Template roundtrip: A pushes template, B applies it → field structure preserved | V5 template sync correctness |
| 4.8 | List hierarchy roundtrip with nesting: root → child → grandchild → topological apply order | Parents applied before children |
| 4.9 | Tombstone lifecycle: create note → push → tombstone → apply on peer B → note retracted | Full deletion propagation |
| 4.10 | Three-peer convergence: A, B, C all edit same item concurrently → all converge to same state | N>2 convergence |
| 4.11 | Metadata conflict with `hasLocalEdit()` returning true → local edit preserved over remote | Logic-based conflict resolution |
| 4.12 | Note with troparcel footer → re-push doesn't duplicate footer | Roundtrip stability of synced notes |

### Key Finding to Validate
Scenario 4.10 (three-peer convergence) is the acid test for CRDT correctness — not just pairwise but full mesh convergence.

---

## Team 5 — RED: Sanitizer Evasion

**Scope**: `src/sanitize.js` — HTML sanitization for remote notes
**Method**: Mutation XSS, DOM clobbering, encoding tricks, novel vectors
**Target files**: `src/sanitize.js`, `src/apply.js` (noteKey interpolation in retraction HTML)

### Test Scenarios

| # | Scenario | What it proves |
|---|----------|---------------|
| 5.1 | Mutation XSS: `<noscript><p title="</noscript><img src=x onerror=alert(1)>">` | Browser re-parsing creates new tags from safe input |
| 5.2 | Unicode fullwidth: `＜script＞alert(1)＜/script＞` | Sanitizer may not normalize Unicode before matching |
| 5.3 | Double-encoding: `&amp;lt;script&amp;gt;` → decode once → `&lt;script&gt;` → decode again → `<script>` | Multi-pass decode vulnerability |
| 5.4 | SVG foreignObject: `<svg><foreignObject><body onload=alert(1)>>` | SVG context switch escaping |
| 5.5 | CSS `@import url(evil.css)` in style attribute | Style attribute should only allow allowlisted properties |
| 5.6 | `noteKey` interpolation in retraction HTML with `n_<img/src=x/onerror=alert(1)>` | apply.js line 617 doesn't escape noteKey |
| 5.7 | RTL override character `\u202E` hiding real tag direction | Visual spoofing in note display |
| 5.8 | Polyglot payload: valid HTML that's also valid JS | Tests defense-in-depth |
| 5.9 | Entity-encoded attribute name: `<p &#111;nclick="alert(1)">` | Attribute-level entity decode |
| 5.10 | `<a href>` with `\x01javascript:alert(1)` (control char prefix) | Low-ASCII bypass of protocol check |
| 5.11 | ProseMirror→HTML edge cases: unknown node type, empty text node, mark without text | Store adapter's HTML renderer for edge cases |

### Key Finding to Validate
Scenario 5.6 is the highest-priority finding: **`noteKey` is directly interpolated into retraction HTML without escaping** in apply.js. A CRDT key containing HTML metacharacters would inject into the note content shown to users in Electron.

---

## Team 6 — BLUE: Store Adapter Correctness

**Scope**: `src/store-adapter.js` — the Redux bridge
**Method**: State shape fuzzing, missing/malformed slices, edge case data
**Target files**: `src/store-adapter.js`

### Test Scenarios

| # | Scenario | What it proves |
|---|----------|---------------|
| 6.1 | Fix 25 failing tests — diagnose root cause (likely v5 refactor changed exports/API) | Baseline correctness restored |
| 6.2 | Empty state (`{}` for all slices) → `getAllItems()` returns `[]`, no crash | Empty state handling |
| 6.3 | Orphan photo (photo exists, but `items[item]` doesn't reference it) → skip gracefully | Referential integrity gaps in Redux |
| 6.4 | Note with no `state` and no `text` → `_noteStateToHtml` returns `''` | Minimal note edge case |
| 6.5 | ProseMirror doc with every node type (h1–h6, blockquote, bullet_list, ordered_list, code_block, hr, hard_break, image) | Full renderer coverage |
| 6.6 | ProseMirror doc with nested marks (bold+italic+underline+link simultaneously) | Mark stacking correctness |
| 6.7 | `suppressChanges()` called twice → `resumeChanges()` called once → still suppressed? | Boolean vs refcount behavior documented |
| 6.8 | `dispatchSuppressed` with action that throws → flag restores to false | Exception safety (already tested, verify fix) |
| 6.9 | 1000-item state → `getAllItems()` performance + correctness | Scale behavior |
| 6.10 | `_validateStateShape` with every possible missing-slice combination (2^7 = 128 combos) | Exhaustive validation |
| 6.11 | `readTemplates()` with deeply nested template fields (50+ fields) | V5 template reading correctness |
| 6.12 | `readLists()` with circular parent references (`list.parent = list.id`) | Defensive handling of corrupt state |

### Key Finding to Validate
The 25 failing tests are the top priority. They likely indicate an API contract change during v5 refactoring that broke the existing test assumptions.

---

## Team 7 — RED: Lifecycle Race Conditions

**Scope**: `src/sync-engine.js` — timing windows, startup/shutdown, concurrent events
**Method**: Simulated concurrent events, startup/shutdown races, error cascades
**Target files**: `src/sync-engine.js`

### Test Scenarios

| # | Scenario | What it proves |
|---|----------|---------------|
| 7.1 | `_acquireLock()` rejects → `_syncing` stays `true` forever → all future `syncOnce()` no-op | Lock starvation via flag desync |
| 7.2 | Safety-net fires during `applyPendingRemote` (suppressChanges active) → premature `resumeChanges` | Concurrent suppression conflict |
| 7.3 | Error cascade: 100 consecutive `syncOnce()` failures → verify backoff caps and no tight loop | Queued replay amplification |
| 7.4 | `stop()` called during `applyTemplates()` → no orphaned suppress state | Mid-apply shutdown safety |
| 7.5 | `start()` → immediate `stop()` before `_waitForProjectAndStart` resolves | Startup cancellation |
| 7.6 | Export hook called while `syncOnce` holds the lock → no deadlock | Hook + sync contention |
| 7.7 | `_applyingRemote = true` but not yet `suppressChanges()` → store event fires → queued vs immediate | Timing window between flag and suppression |
| 7.8 | Engine stopped between inner and outer `finally` in apply → queued change fires `syncOnce()` on null doc | Post-shutdown ghost sync |
| 7.9 | Concurrent `syncOnce()` — bypass mutex by manipulating `_syncing` directly → doc consistency | Mutex bypass (adversarial test of the lock) |
| 7.10 | `_consecutiveErrors` integer overflow after 2^53 failures (theoretical) → backoff calculation | Numeric overflow in backoff |

### Key Finding to Validate
Scenario 7.1 is the most likely real bug: if `_acquireLock()` throws before the `try` block is entered, `_syncing = true` is set at line 886 but never cleared, permanently freezing the sync engine.

---

## Team 8 — BLUE: Boundary Validation & Connection Security

**Scope**: `src/backup.js`, `src/connection-string.js`, `src/api-client.js`
**Method**: Boundary value testing, malformed inputs, protocol edge cases
**Target files**: `src/backup.js`, `src/connection-string.js`, `src/api-client.js`

### Test Scenarios

| # | Scenario | What it proves |
|---|----------|---------------|
| 8.1 | Connection string: every transport (ws, wss, file, snapshot) with path traversal (`../../../etc/passwd`) | Input validation on connection parsing |
| 8.2 | Connection string: extremely long room names (10KB), null bytes, Unicode | String handling robustness |
| 8.3 | Connection string: `troparcel://unknown-transport/...` → graceful error | Unknown transport handling |
| 8.4 | `maxBackupSize` boundary: exactly at limit, 1 byte over, 1 byte under | Precise boundary behavior |
| 8.5 | `maxNoteSize` boundary: exactly 1MB, 1MB+1 byte | Note size validation precision |
| 8.6 | `maxMetadataSize` boundary: exactly 64KB, 64KB+1 byte | Metadata size validation precision |
| 8.7 | `validateInbound` with all field types oversized simultaneously | Combined validation correctness |
| 8.8 | `sanitizeDir` with Unicode paths, null bytes, Windows reserved names (CON, PRN, NUL, COM1) | Directory name sanitization |
| 8.9 | `sanitizeDir` with path separators (`/`, `\`, `..`) and symlink-like patterns | Path traversal prevention |
| 8.10 | API client `importItems` bypass: `file:///etc/passwd`, encoded paths (`%2Fetc%2Fpasswd`), symlinks | File path blocking completeness |
| 8.11 | Tombstone flood at exact threshold (0.5 ratio) with rounding edge cases | Threshold precision |
| 8.12 | `saveSnapshot` with concurrent calls → no file corruption | Atomic write safety |
| 8.13 | `loadFromFile` with truncated JSON, binary garbage, empty file | Corrupt file handling |

### Key Finding to Validate
Scenario 8.10 tests whether the `importItems` file path blocking can be bypassed with encoding tricks or protocol prefixes. Current test only checks bare `/etc/passwd`.

---

## Team Summary Matrix

| Team | Stance | Scope | Method | Expected Bug Yield |
|------|--------|-------|--------|-------------------|
| 1. CRDT Poisoning | RED | crdt-schema, push | Malicious CRDT entries | High — no push-side size validation |
| 2. Vault Integrity | BLUE | vault | Property-based invariants | High — LRU eviction bug expected |
| 3. Identity Collision | RED | identity, sync-engine | Hash collisions, Jaccard gaming | Medium — fuzzy match exploitable |
| 4. CRDT Convergence | BLUE | push, apply, crdt-schema | Multi-peer simulation | Medium — proves core guarantees |
| 5. Sanitizer Evasion | RED | sanitize, apply | Mutation XSS, encoding tricks | Medium — noteKey interpolation is real |
| 6. Store Adapter | BLUE | store-adapter | State shape fuzzing | High — 25 tests currently failing |
| 7. Lifecycle Races | RED | sync-engine | Timing exploitation | High — _syncing flag bug likely real |
| 8. Boundary Validation | BLUE | backup, connection, api | Boundary values | Low-Medium — hardening existing code |

## Test Organization

Each team gets its own `describe` block in `test/index.test.js` (or optionally a separate file per team):

```
test/
  index.test.js          ← existing tests
  team1-crdt-poison.js   ← or inline as describe('Team 1: CRDT Poisoning', ...)
  team2-vault-inv.js
  ...
```

Shared infrastructure additions to `test/helpers.js`:
- `buildCRDTDoc` already exists — extend with adversarial builder options
- `mockSyncContext` already exists — extend with lifecycle simulation helpers
- New: `buildMaliciousCRDTDoc(poisonConfig)` for Team 1
- New: `simulatePeers(N, operations)` for Team 4

## Priority Order for Implementation

1. **Team 6** (Store Adapter) — fix the 25 failing tests first, then add coverage
2. **Team 2** (Vault Integrity) — highest expected bug yield, pure unit tests
3. **Team 5** (Sanitizer Evasion) — noteKey interpolation is a real security issue
4. **Team 4** (CRDT Convergence) — proves core correctness
5. **Team 1** (CRDT Poisoning) — validates trust boundaries
6. **Team 7** (Lifecycle Races) — complex but high-value
7. **Team 3** (Identity Collision) — validates matching assumptions
8. **Team 8** (Boundary Validation) — hardening, lower urgency
