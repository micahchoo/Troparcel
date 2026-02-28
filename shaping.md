---
shaping: true
---

# Troparcel — Batteries-Included Collaboration Shaping

## Frame

### Source

> 1. Additions stack
> 2. You can only delete your own notes
> 3. There's two ways to delete - just for yourself and for everyone else

Directive: make this as generalizable and user-friendly as possible. Expand troparcel's scope by finding creative ways to work with Tropy's UI. Support sync via Nextcloud and other transports. Make setup radically simpler — "batteries included."

Constraint: ProseMirror strips most HTML on Tropy's side — attribution and collaboration UI must use Tropy-native channels (tags, metadata, lists), not embedded HTML in notes. Flash dispatch requires i18n key registration (= host modification = ruled out by R9).

### Problem

Troparcel syncs annotations between Tropy instances, but:
1. Any user can tombstone any other user's content — no ownership enforcement
2. The plugin is invisible — no in-app feedback, users must check the dev console
3. Attribution is limited to plain-text note footers (ProseMirror strips richer HTML)
4. Users have no native-UI way to see what changed or who contributed
5. Setup requires running a server, configuring 20+ options, and manually sharing connection details — too many moving parts for non-technical researchers

### Outcome

A "batteries-included" collaboration layer where:
- Each user's contributions are protected (additions stack)
- The sync process is visible inside Tropy's native UI
- Setup is a two-field configuration (connection string + your name)
- Multiple transport options (WebSocket, shared folder, HTTP) are each a one-step choice
- Documentation reflects the new safety model and simplified setup

### Appetite

TBD — user to specify.

---

## Requirements (R)

| ID | Requirement | Status |
|----|-------------|--------|
| R0 | Collaborative annotations form an additive stack — each user's authored content is protected from other users' deletions | Core goal |
| R1 | Only the author of a note, selection, or transcription can retract it (tombstone propagating to all peers) | Must-have |
| R2 | Deleting a non-authored annotation automatically becomes a local dismissal (hidden locally, CRDT untouched) | Must-have |
| R3 | Ownership enforcement applies to authored content (notes, selections, transcriptions). Tags and list memberships use add-wins semantics without ownership guard. | Must-have |
| R4 | Dismissals are persistent across restarts, non-destructive, and recoverable. Dismissals are pushSeq-aware — re-dismiss lifts when author revises content. | Must-have |
| R5 | Visible in-app feedback about sync events and deletion scope via DOM notifications (not console-only) | Must-have |
| R6 | Users can see who contributed which annotations via Tropy-native UI (attribution tags `@user`, contributor metadata) | Must-have |
| R7 | Incoming changes are surfaced through Tropy's native UI (auto-lists, tags, metadata) so users know what arrived | Must-have |
| R8 | Sync transport is pluggable — CRDT state can sync via WebSocket, shared folder (Nextcloud), or HTTP snapshot | Done |
| R9 | No Tropy host modification; no CRDT schema version bump | Must-have |
| R10 | Setup requires at most two fields: connection string + user name. All other options have safe defaults or are derived from the connection string. | Must-have |
| R11 | Coordinator can generate a connection string via server output, monitor dashboard, npx, or deploy button — no manual URL construction | Must-have |
| R12 | All documentation (GUIDE, SETUP, CONFLICTS) updated to reflect new safety model and simplified setup | Must-have |
| R13 | Architecture supports future Yjs capabilities: subdocs for per-item sync, client-side persistence for offline-first, Y.XmlFragment for concurrent note editing. Current design must not close these doors. | Architecture |

---

## Codebase Classification

| Module | Bucket | Evidence | Implication |
|--------|:------:|----------|-------------|
| push.js | (a) LOAD-BEARING | pushDeletions works, no authorship check | Needs ownership guard for notes/selections/transcriptions |
| apply.js | (a) LOAD-BEARING | Skips own notes, dismissedKeys checked | Needs dismiss routing + tombstone author validation + attribution dispatch |
| vault.js | (a) LOAD-BEARING | dismissedKeys already persisted as Set | Extend to Map<key, pushSeq> for pushSeq-aware dismissals |
| crdt-schema.js | (a) LOAD-BEARING | `author` field on every CRDT entry | No changes — foundation exists |
| sync-engine.js | (a) LOAD-BEARING | Core orchestration, transport coupling removed | Transport adapter layer done. Needs notification wiring. |
| plugin.js | (a) LOAD-BEARING | Entry point, hooks, lifecycle | Needs connection string parsing, transport option |
| store-adapter.js | (a) LOAD-BEARING | Redux read/write abstraction | Needs `dispatchSuppressed()` for attribution writes |
| notifications.js | (a) LOAD-BEARING | V1 DOM overlay complete | Wire retract/dismiss/attribution events |
| adapters/*.js | (a) LOAD-BEARING | Transport adapter layer complete | No further changes |
| All others | (a) LOAD-BEARING | Working, no deletion logic | Don't touch |

## Interrelationship Map

| Subsystem A | Subsystem B | Relationship | Implication |
|-------------|-------------|:------------:|-------------|
| pushDeletions | vault.dismissedKeys | COUPLED | Ownership check routes non-author deletions to dismiss |
| pushDeletions | crdt-schema author | ORTHOGONAL | Schema already has author; push just reads it |
| apply tombstones | vault.dismissedKeys | COUPLED | Apply skips dismissed keys — already wired |
| attribution (tags/metadata) | store-adapter | COUPLED | Need dispatchSuppressed for tag/metadata writes |
| auto-lists | store-adapter | COUPLED | Need dispatchSuppressed for list create/item.add |
| push (tags/metadata) | attribution | FILTER | Push must skip `@*` tags and `troparcel:*` metadata URIs |
| connection-string | plugin.js | NEW | Parse `troparcel://` URI into transport options |

---

## Original Design Concerns

These concerns drove the conservative defaults in v5.0. Each is addressed explicitly in the new design.

### OC1: Any user can tombstone any content

**Original mitigation:** `syncDeletions` defaults OFF. Deletions are local-only and restored on next sync.

**New design:** Ownership guard scopes retraction to authored content (notes, selections, transcriptions). Tags and list memberships are exempt because:
- Their `author` field means "most recent pusher," not "creator" — multiple users independently add the same tag, last push wins the author field
- Add-wins semantics already recovers from tombstones (a subsequent add clears the tombstone)
- They are lightweight shared vocabulary, not authored content

**syncDeletions default stays OFF.** Rationale:
- Changing defaults on upgrade changes behavior for existing users
- Author spoofing (OC2) means ON is not fully safe for untrusted environments
- File-based sync has no auth layer — anyone writing to the folder can spoof
- GUIDE's coordinator-centric safety model still applies for classroom settings

But: language softened. Instead of "dangerous," docs say "safe for author-scoped retractions of your own notes, selections, and transcriptions."

### OC2: No cryptographic identity

**Original mitigation:** Room tokens protect WebSocket; `userId` is self-declared.

**New design:** Unchanged. Author field is trust-based. A malicious user can set `userId` to match another's and tombstone their content. Room tokens protect WebSocket transport; file-based sync has no auth. Documented as known limitation.

**Future enhancement (not in scope):** Coordinator `superUser` role that can tombstone any content. Cryptographic signing of CRDT entries.

### OC3: Tag `author` field ≠ "creator"

**Discovered during V2 design.** Tags are keyed by lowercase name with a single `author` field. When two users both add "Important," the most recent pusher becomes the author. A naive ownership guard would prevent the original creator from retracting their own tag.

**Resolution:** Tags and list memberships use add-wins without ownership guard. Ownership guard applies only to UUID-keyed authored content (notes, selections, transcriptions).

### OC4: Tombstone GC window

**Original mitigation:** Server purges tombstones older than `TOMBSTONE_MAX_DAYS` (default 30). Clients offline >30 days may resurrect deleted items.

**New design:** Unchanged. V2 ownership guard doesn't alter tombstone lifecycle. Document recommendation: connect at least once per 30 days.

### OC5: Coordinator-only permanent deletion

**Original mitigation:** 5-step coordinator dance — enable syncDeletions, restart, delete, disable, restart.

**New design:** Simplified for authored content. Author can retract their own notes/selections/transcriptions directly (syncDeletions ON). For departed authors — nobody can tombstone their content; users dismiss locally, or coordinator resets CRDT state.

**Future enhancement (not in scope):** `superUser` coordinator role.

### OC6: Ghost note prevention

**Original mitigation:** `failedNoteKeys` gives up after 3 retries.

**New design:** Dismissed note keys must NOT count toward `failedNoteKeys`. Dismissed = user chose to hide. Failed = technical failure. Different buckets. Apply-side checks `dismissedKeys` before retrying.

### OC7: Dismissal lifecycle

**New concern from V2 design.** When dismissed content gets updated by the original author, should the dismissal persist?

**Resolution: pushSeq-aware dismissals.** `vault.dismissedKeys` stores `Map<key, pushSeqAtDismissal>` instead of `Set<key>`. Apply-side checks: if `entry.pushSeq > dismissedPushSeq`, un-dismiss and show the updated content. This matches "mute this thread" semantics — you're pulled back in when there's new activity.

### OC8: Attribution feedback loops

**Concern from V3 design.** Attribution writes (tags, metadata) must not trigger push.

**Resolution — two layers:**
1. **Dispatch layer:** `dispatchSuppressed()` wraps attribution dispatches in `suppressChanges()/resumeChanges()` — prevents store.subscribe from firing
2. **Push filter:** Push side skips `@*` tags and `troparcel:*` / `https://troparcel.org/ns/*` metadata URIs — attribution never enters the CRDT even if suppression fails

Attribution is local-only by design. It's re-created on each apply cycle from CRDT author fields.

### OC9: Setup complexity

**Original mitigation:** 20+ flat options in Tropy preferences. GUIDE has a "settings card" concept (coordinator fills in values, shares with team). SETUP.md has 3 scenarios with 5-8 steps each.

**New design: Connection string.** All transport/address/room/auth collapsed into one URI:
```
troparcel://ws/server.edu:2468/room-name?token=secret
troparcel://file/home/alice/Nextcloud/tropy-collab
troparcel://snapshot/https://r2.example.com/crdt/state.yjs?auth=Bearer+tok
```

Researcher configures 2 fields: connection string + your name. Individual fields remain as `[Advanced]` overrides for backward compatibility.

---

## Shapes

### CURRENT + T1: Baseline + Transport Adapters (DONE)

Transport adapter layer implemented. Pluggable sync via WebSocket, shared folder, or HTTP snapshot.

| Part | Mechanism | Status |
|------|-----------|:------:|
| T1 | Transport adapter base class + factory | Done |
| T2 | WebSocket adapter (extracted from sync-engine.js) | Done |
| T3 | File adapter (poll-based shared folder) | Done |
| T4 | Snapshot adapter (HTTP GET/PUT) | Done |
| T5 | `transport` option in plugin.js + package.json | Done |

---

### Shape C+: Batteries-Included (Selected)

Shape C from the original shaping, extended with transport adapters (done), connection string UX, and entity-type-specific ownership rules. Incorporates all original concern resolutions.

| Part | Mechanism | Status |
|------|-----------|:------:|
| **C1** | **Push-side author guard**: pushDeletions reads CRDT entry's `author` field before tombstoning. Own notes/selections/transcriptions → tombstone. Others' → vault.dismissedKeys. Tags and list memberships: no ownership check (add-wins). | Planned |
| **C2** | **Apply-side tombstone validation**: reject incoming tombstones where `tombstone.author !== original.author` for notes/selections/transcriptions. Accept all tag/list tombstones (add-wins recovers). | Planned |
| **C3** | **pushSeq-aware dismissals**: vault.dismissedKeys stores `Map<key, pushSeq>`. Auto-undismiss when author revises content (`entry.pushSeq > dismissedPushSeq`). Dismissed keys excluded from `failedNoteKeys`. | Planned |
| **C4** | **DOM notification overlay**: status pill + toast notifications. Connect, disconnect, apply, retract, dismiss events. | Done (V1) |
| **C5** | **Attribution tags**: on apply, create/assign `@user` tags per contributor. Deterministic color from username hash. Cached in vault. Local-only (never pushed to CRDT). Push side skips `@*` tags. | Planned |
| **C6** | **Auto-lists**: auto-create "Synced items" list, populate with items that received remote annotations. Local-only (never pushed). Accumulated, user-curated removal. | Planned |
| **C7** | **Sync metadata**: write `troparcel:contributors` and `troparcel:lastSync` to item metadata. Local-only (push skips `troparcel:*` URIs). Wrapped in `dispatchSuppressed()`. | Planned |
| **C8** | **Connection string**: `troparcel://` URI encodes transport + address + room + auth. Two-field researcher config. Server prints string on startup. Monitor dashboard shows copyable string. | Planned |
| **C9** | **npx server**: `npx troparcel-server` zero-config server start. Prints connection string. | Planned |
| **C10** | **Deploy templates**: Render `render.yaml`, Railway `railway.json`, Cloudflare Workers template. One-click deploy → get connection string. | Planned |
| **C11** | **Documentation rewrite**: GUIDE, SETUP, CONFLICTS updated for ownership model, connection string, transport options. Settings presets simplified. | Planned |

---

## Spike Results

### S1: Flash Message Dispatch — PARTIAL FAILURE

**Mechanism works, content doesn't.** Flash is i18n-bound:

```javascript
// Flash component renders:
<FormattedMessage id={`flash.${id}.message`} values={values}/>
```

The `id` maps to a translation key in Tropy's string resources. A plugin dispatching
`{ type: 'flash.show', payload: { id: 'troparcel-sync' } }` looks up
`flash.troparcel-sync.message` — which doesn't exist. React-intl shows the raw key
as fallback text. Ugly, not user-friendly. Only used once in Tropy (app updates).

| Question | Answer |
|----------|--------|
| Payload shape | `{ id: string, values?: object }` — id is i18n key, not message text |
| Renders in project window? | Yes — `useSelector(state => state.flash)` |
| Lifecycle | Manual dismiss only — confirm + X close, no auto-timer |

**Verdict:** Flash NOT suitable for plugin notifications. Requires i18n key registration = host modification = violates R9.

**Alternative (implemented):** Direct DOM injection via `src/notifications.js`. Plugin has `context.window` access. Status pill + toast overlay. CSS-isolated, z-index layered, auto-dismiss.

### S2: Tag/Metadata Dispatch — PASS

| Question | Answer | Risk |
|----------|--------|------|
| Create tag? | **YES** — `{ type: 'tag.create', payload: { id, color }, meta: { cmd: 'project', history: 'add' } }` | Low |
| Custom metadata URIs? | **YES** — arbitrary URIs like `troparcel:contributors` work | Low |
| Saga triggers? | **YES** — cmd saga persists to DB, tag appears in UI immediately | Low |
| Feedback loop? | **HIGH RISK** — must wrap in `suppressChanges()/resumeChanges()` | Solvable (mechanism exists) |

### S3: Transport Decoupling — PASS (IMPLEMENTED)

| Question | Answer |
|----------|--------|
| Yjs coupling zones in sync-engine.js | 5 zones (~100 lines): imports, construction, event wiring, waitForConnection, cleanup |
| `Y.encodeStateAsUpdate()` / `Y.applyUpdate()` transport-agnostic? | **YES** — work over any byte transport |
| Awareness protocol required? | **NO** — only WebSocket adapter provides awareness; file/snapshot return null |
| Build size impact | 258.9KB (from 250KB baseline) — within 260KB budget |
| Test regression | 149/159 pass (same 10 pre-existing failures) |

---

## Fit Check

| Req | Requirement | Status | CURRENT | C+ |
|-----|-------------|--------|:-------:|:--:|
| R0 | Additive stack — authored content protected | Core goal | ❌ | ✅ |
| R1 | Author-only retraction (notes/selections/transcriptions) | Must-have | ❌ | ✅ |
| R2 | Auto-dismiss for non-author deletions | Must-have | ❌ | ✅ |
| R3 | Entity-type-specific ownership (authored content guarded, add-wins for tags/lists) | Must-have | ❌ | ✅ |
| R4 | pushSeq-aware persistent dismissals | Must-have | ✅ (partial) | ✅ |
| R5 | Visible in-app feedback via DOM notifications | Must-have | ❌ | ✅ (done) |
| R6 | Attribution visibility via tags + metadata | Must-have | ❌ | ✅ |
| R7 | Change surfacing via auto-lists + tags | Must-have | ❌ | ✅ |
| R8 | Pluggable transport (WebSocket, file, snapshot) | Done | ❌ | ✅ (done) |
| R9 | No host modification, no schema bump | Must-have | ✅ | ✅ |
| R10 | Two-field setup (connection string + name) | Must-have | ❌ | ✅ |
| R11 | Connection string generation (server, dashboard, npx, deploy) | Must-have | ❌ | ✅ |
| R12 | Documentation updated | Must-have | ❌ | ✅ |

**S × R Profile: C+ (12/12)** — All requirements pass.

---

## Decision

**Shape C+ selected.** Extends original Shape C with transport adapters (done), connection string UX, entity-type-specific ownership, pushSeq-aware dismissals, and documentation rewrite.

### Why not original Shape C unchanged?

1. **R3 was wrong.** "Uniform across all annotation types" is not achievable because tags and list memberships have multi-author semantics (the `author` field means "last pusher," not "creator"). Entity-type-specific rules are the correct design.
2. **R8 was undecided.** Transport adapters are now implemented.
3. **Setup pain was unaddressed.** Original Shape C solved visibility and safety but not onboarding. Connection string UX closes this gap.
4. **Dismissal lifecycle was underspecified.** pushSeq-aware dismissals handle the "author revises dismissed content" edge case.

---

## Slices

Build order:

```
V1 (notifications) ──────── DONE
Transport adapters ──────── DONE
                      ┌──→ V2 (ownership guard)
Connection string ────┤
                      └──→ V3 (attribution) ──→ V4 (auto-lists)
Deploy templates ──────────────────────────────→ (parallel)
Documentation ─────────────────────────────────→ (after V2-V4)
```

### V1: "I can see it's alive" — DONE

DOM notification overlay. Status pill + toasts. `src/notifications.js`.

### Transport Adapters — DONE

`src/adapters/{base,index,websocket,file,snapshot}.js`. sync-engine.js refactored. plugin.js + package.json updated.

### Connection String (new)

**Demo:** Researcher pastes `troparcel://ws/server.edu:2468/room?token=abc` into plugin settings. Plugin auto-configures transport, server URL, room, and token. Two fields total.

| File | Changes |
|------|---------|
| `src/connection-string.js` | **NEW** — parse/generate `troparcel://` URIs |
| `src/plugin.js` | Parse `connectionString` before `mergeOptions()`. Individual fields override. |
| `package.json` | Add `connectionString` field at top of options. Reorder: essential fields first, `[Advanced]` prefix on rest. |

### V2: "My work is protected" — Ownership Guard

**Demo:** Alice creates a note. Bob sees it via sync. Bob deletes it locally. Instead of tombstoning, Bob's troparcel notifies "Dismissed alice's note (hidden locally)" and alice's note remains in the CRDT. If Bob deletes his OWN note, it retracts normally. If alice later edits the note Bob dismissed, the updated version reappears for Bob.

| File | Changes |
|------|---------|
| `src/push.js` | `pushDeletions()` — author check for notes, selections, transcriptions (3 entity types). Tags and lists: unchanged (no ownership check). |
| `src/apply.js` | Tombstone author validation for notes, selections, transcriptions. Tags/lists: accept all tombstones (add-wins recovers). |
| `src/vault.js` | `dismissedKeys` becomes `Map<key, pushSeq>`. Entity-type prefix (`note:`, `sel:`, `tx:`). `failedNoteKeys` exclusion for dismissed keys. |
| `src/sync-engine.js` | Wire notification calls for retract/dismiss events |

#### Edge cases

| Scenario | Expected behavior |
|---|---|
| Bob dismisses alice's note, alice edits it | Bob sees updated note (pushSeq advanced past dismissal) |
| Alice leaves project, her notes need removal | Other users dismiss locally. Coordinator can reset CRDT. No one can tombstone alice's notes. |
| Bob spoofs userId="alice" | Bob can tombstone alice's content. Known limitation (OC2). Room tokens mitigate for WebSocket. |
| Both alice and bob add tag "Important" | Tag `author` = last pusher. Either can tombstone (no ownership guard on tags). Add-wins recovers. |
| Tag tombstoned, then re-added by different user | Add-wins: tombstone cleared. Tag reappears. |
| Dismissed note key retried by ghost note prevention | Dismissed keys excluded from `failedNoteKeys`. Not retried. |

### V3: "I can see who did what" — Attribution Tags + Metadata

**Demo:** Remote sync applies alice's annotations to 3 items. Each item gets an `@alice` tag (visible in item list and detail panel). Item metadata shows `troparcel:contributors = alice, bob` and `troparcel:lastSync = 2026-02-27T14:30:00Z`.

| File | Changes |
|------|---------|
| `src/apply.js` | After apply per item: dispatch `@user` tag + contributor metadata via `dispatchSuppressed()` |
| `src/push.js` | Skip `@*` tags and `troparcel:*` / `https://troparcel.org/ns/*` metadata URIs during push |
| `src/store-adapter.js` | Add `dispatchSuppressed(action)` helper |
| `src/vault.js` | Cache attribution tag IDs to avoid duplicate creation |

#### Attribution rules

- Tags: `@username` format, deterministic color (hash username → palette), created once per user, reused across items
- Metadata URIs: `https://troparcel.org/ns/contributors`, `https://troparcel.org/ns/lastSync`
- Local-only: attribution never enters CRDT (push filter + suppressChanges)
- Re-created on each apply cycle from CRDT author fields
- Deleting `@user` tags is harmless — they reappear on next sync

### V4: "I can find what changed" — Auto-Lists

**Demo:** Remote sync applies changes. Sidebar shows a "Synced items" list containing the items that received remote annotations. List updates on each sync cycle.

| File | Changes |
|------|---------|
| `src/apply.js` | After apply cycle: collect affected item IDs, dispatch `list.item.add` via `dispatchSuppressed()` |
| `src/store-adapter.js` | Uses `dispatchSuppressed()` from V3 |
| `src/vault.js` | Cache list ID to avoid duplicate creation |

#### List rules

- List name: "Synced items" (configurable via options)
- Created once on first apply, reused thereafter
- Items ADDED on each sync cycle (accumulative, not replacing)
- User curates removal manually (removing items they've reviewed)
- Local-only: list membership dispatches never pushed to CRDT

### Deploy Templates

**Demo:** Coordinator clicks "Deploy to Render" in README → gets URL → shares connection string.

| File | Changes |
|------|---------|
| `render.yaml` | **NEW** — Render blueprint |
| `railway.json` | **NEW** — Railway deploy config |
| `server/cloudflare/` | **NEW** — Durable Objects worker template |
| `server/index.js` | Print connection string on startup |
| `server/package.json` | Add `bin` field for `npx troparcel-server` |

### Documentation Rewrite

All docs updated to reflect new safety model, connection string UX, and transport options.

| Doc | Key changes |
|------|------------|
| **GUIDE.md §1 Key Concepts** | Add: connection string, transport, retract vs dismiss, attribution tags, auto-lists |
| **GUIDE.md §3 Data Protection** | Rewrite "Deletions stay local" → "Deletions are author-scoped for notes/selections/transcriptions. Tags/lists use add-wins." Soften syncDeletions warning. |
| **GUIDE.md §5 Coordinator Setup** | Replace settings card with connection string. Add: generate via server output, dashboard, npx, deploy button. |
| **GUIDE.md §6 Settings Presets** | Simplify all presets: connection string + name + sync mode. Remove 20-field tables. Add `syncDeletions` note about author-scoping. |
| **GUIDE.md §7 Contributor Setup** | Replace 6-step settings entry with: paste connection string, enter name, restart. |
| **GUIDE.md §9.7 Handling Unwanted Annotations** | Replace 5-step coordinator dance with: author retracts own content (syncDeletions ON), others dismiss locally, coordinator resets CRDT for departed authors. |
| **GUIDE.md §10 Conflict Avoidance** | Update Rule 3: "`@` tags reserved for attribution." Update Rule 5: soften syncDeletions warning. Add Rule 11: "attribution tags/lists are managed by Troparcel — deleting them is harmless." |
| **GUIDE.md §11 Troubleshooting** | Add file/snapshot transport errors. Replace "server unreachable" with transport-aware messages. |
| **SETUP.md** | Add file transport scenario (shared folder). Add snapshot transport scenario. Add connection string to all scenarios. Add deploy button instructions. |
| **CONFLICTS.md §Per-Data-Type: Tags** | Add: "Attribution tags (`@user`) are local-only and never enter the CRDT. Tags/lists use add-wins without ownership guard." |
| **CONFLICTS.md §Known Limitations** | Update "Author ID Spoofing" — ownership guard mitigates but doesn't eliminate risk. Add "Departed Authors" limitation. |
| **CHANGELOG.md** | v6.0 entry for batteries-included release |

---

## Future-Proofing: Full Yjs Capabilities (R13)

The current design uses ~20% of Yjs's capabilities (Y.Map, Y.Array, YKeyValue, awareness, binary encoding). Three major Yjs features would transform Troparcel's architecture. The batteries-included design must not close these doors.

### F1: Subdocs — Per-Item CRDT Isolation

**What it is:** `Y.Doc` supports nested subdocuments that load and sync independently. Instead of one monolithic `Y.Doc` for the entire room, each item (or group of items) gets its own subdoc.

**Why it matters:**
- **Selective sync:** A researcher studying only 50 of 5,000 photos loads only those 50 subdocs
- **Memory:** Current design loads entire CRDT into memory. With 10,000 items × 20 fields, the Y.Doc becomes large. Subdocs load on demand.
- **Granular permissions:** Different subdocs could have different access controls (future)
- **Parallel apply:** Independent subdocs can be applied concurrently without mutex contention

**Current design compatibility:**
- The `annotations` Y.Map is already keyed by item identity hash — each item's data is a separate Y.Map. This is structurally similar to subdocs.
- **Door-closing risk: LOW.** Migration path: wrap each item's Y.Map in a subdoc. The adapter interface (`connect/disconnect/destroy`) already abstracts transport lifecycle. Subdocs would add `loadSubdoc(itemHash)` / `unloadSubdoc(itemHash)` to the adapter interface.

**Affordance to add now:** None required in code. Document the migration path in DEVELOPER.md. Ensure new code doesn't assume all items are loaded simultaneously (e.g., don't iterate all CRDT items in hot paths without pagination).

### F2: Client-Side Persistence — Offline-First

**What it is:** `y-indexeddb` (browser) or a Node.js equivalent persists the Y.Doc locally. The plugin works fully offline, syncing when transport reconnects.

**Why it matters:**
- **No server dependency at startup.** Current design: if WebSocket is unreachable, the plugin has no CRDT state. With client persistence: plugin loads last-known CRDT from disk, works offline, syncs deltas on reconnect.
- **File transport natural fit.** The FileAdapter already writes `Y.encodeStateAsUpdate()` to disk — this is essentially client-side persistence. Formalizing it means the file adapter and offline mode share the same storage layer.
- **Faster startup.** No need to download entire CRDT state on every launch. Apply `Y.encodeStateVector()` diff only.

**Current design compatibility:**
- The vault already persists key mappings to `~/.troparcel/vault/`. Client-side CRDT persistence would live alongside it.
- The adapter interface's `connect()` currently means "connect AND load initial state." With offline persistence, it would mean "load from local persistence, THEN connect for deltas."
- **Door-closing risk: LOW.** The adapter interface separates transport from CRDT document. Adding persistence means: `doc` loads from disk before `adapter.connect()`, and `adapter.connect()` sends a state vector instead of requesting full state.

**Affordance to add now:**
- Ensure `Y.Doc` is created and usable BEFORE `transport.connect()` resolves (already true in current design — doc is created in `start()` before `createAdapter()`).
- Add `Y.encodeStateVector(doc)` / `Y.encodeStateAsUpdate(doc, stateVector)` to the adapter vocabulary for delta-only sync. Not wired yet, but the adapter interface should reserve these methods.

### F3: Y.XmlFragment — Concurrent Rich Text Editing

**What it is:** Yjs has first-class support for concurrent rich text editing via `Y.XmlFragment`, with bindings for ProseMirror (`y-prosemirror`), TipTap, Quill, and others. Two users editing the same note would see each other's cursor and edits merge character-by-character.

**Why it matters:**
- **True collaborative editing** instead of whole-note-replace. Current design: if alice and bob both edit the same synced note, local-wins and the other edit is lost (logged as conflict). With Y.XmlFragment: both edits merge at the character level.
- **Tropy uses ProseMirror.** The `y-prosemirror` binding exists and is production-grade. The gap is that Tropy's ProseMirror instance is internal — the plugin can't easily inject a Y.XmlFragment binding into it.

**Current design compatibility:**
- Notes are currently stored as `{ text, html, author, pushSeq }` in a Y.Map — a flat snapshot model. Y.XmlFragment would replace this with a structured document type.
- **Door-closing risk: MEDIUM.** The note content model would need to change from snapshot-based (push entire HTML) to CRDT-native (Y.XmlFragment per note). This is a schema change, but since notes already use stable UUID keys (`n_` prefix), the migration path is: for each note UUID, swap the Y.Map entry for a Y.XmlFragment subdoc.
- **Biggest blocker is Tropy, not Troparcel.** The plugin would need to inject `y-prosemirror` into Tropy's editor instance, which requires either:
  a. Tropy exposing the ProseMirror EditorView via plugin context (requires Tropy change = R9 violation), or
  b. Troparcel intercepting keystrokes and replaying them into a shadow Y.XmlFragment (fragile), or
  c. Tropy adopting y-prosemirror natively (ideal but out of our control)

**Affordance to add now:**
- Use `Y.Doc.getXmlFragment(noteKey)` as a no-op today — just ensure the method doesn't conflict with existing Y.Map usage.
- In the CRDT schema, reserve a `noteFormat` field on note entries: `'snapshot'` (current) vs `'xmlfragment'` (future). Apply-side can branch on this.
- Document the Tropy dependency in DEVELOPER.md.

### Summary: What to do now vs later

| Capability | Door-closing risk | Affordance now | Implementation later |
|---|---|---|---|
| **Subdocs** | Low | Document migration path. Don't assume all items loaded. | Per-item subdocs, adapter `loadSubdoc()` |
| **Client persistence** | Low | Ensure doc created before connect. Reserve state vector methods on adapter. | y-indexeddb or fs persistence, delta sync |
| **XmlFragment** | Medium | Reserve `noteFormat` field in CRDT schema. Document Tropy dependency. | y-prosemirror binding, schema migration |

---

## R × V Fit Check

| Req | Requirement | Transport | ConnStr | V1 | V2 | V3 | V4 | Deploy | Docs |
|-----|-------------|:---------:|:------:|:--:|:--:|:--:|:--:|:------:|:----:|
| R0 | Additive stack | | | | ✅ | | | | |
| R1 | Author-only retraction | | | | ✅ | | | | |
| R2 | Auto-dismiss non-author | | | | ✅ | | | | |
| R3 | Entity-type-specific ownership | | | | ✅ | | | | |
| R4 | pushSeq-aware dismissals | | | | ✅ | | | | |
| R5 | Visible in-app feedback | | | ✅ | | | | | |
| R6 | Attribution visibility | | | | | ✅ | | | |
| R7 | Change surfacing | | | ✅ | | | ✅ | | |
| R8 | Pluggable transport | ✅ | | | | | | | |
| R9 | No host modification | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| R10 | Two-field setup | | ✅ | | | | | | |
| R11 | Connection string generation | | ✅ | | | | | ✅ | |
| R12 | Documentation updated | | | | | | | | ✅ |
| R13 | Yjs future-proofing | ✅ | | | | | | | ✅ |

R13 coverage: Transport adapter interface supports future subdoc/persistence methods (Transport column). Migration paths documented (Docs column). `noteFormat` field reserved in CRDT schema (V2 column, deferred to schema work).
