# Batteries-Included Troparcel — Design Document

**Date:** 2026-02-27
**Status:** Approved
**Parent:** [shaping.md](../../shaping.md)

---

## Problem

Troparcel syncs annotations between Tropy instances, but:
1. Any user can tombstone any other user's content — no ownership enforcement
2. The plugin is invisible — no in-app feedback beyond dev console
3. Attribution limited to plain-text note footers (ProseMirror strips HTML)
4. No native-UI way to see what changed or who contributed
5. Setup requires running a server, configuring 20+ options, manually sharing connection details

## Solution: Shape C+ (Batteries-Included)

A collaboration layer where authored content is protected, sync is visible in Tropy's native UI, setup is two fields, and multiple transport options are each a one-step choice.

---

## Architecture

```
                        ┌─────────────────────────┐
                        │   push.js / apply.js     │  ← V2 ownership guard
                        │   crdt-schema.js / vault │  ← pushSeq-aware dismissals
                        └────────┬────────────────┘
                                 │ reads/writes Y.Doc
                        ┌────────┴────────────────┐
                        │      SyncEngine          │  ← adapter interface
                        │  (sync-engine.js)        │
                        └────────┬────────────────┘
                                 │
                   ┌─────────────┼─────────────────┐
             ┌─────┴─────┐ ┌────┴────┐ ┌──────────┴──────────┐
             │ WebSocket  │ │  File   │ │     Snapshot         │
             │  (done)    │ │ (done)  │ │     (done)           │
             └────────────┘ └─────────┘ └──────────────────────┘

  Tropy-native collaboration UI:
    @user tags (V3) + "Synced items" list (V4) + DOM notifications (V1, done)
    All local-only — never pushed to CRDT
```

---

## What's Done

| Slice | Files | Status |
|---|---|---|
| **V1: Notifications** | `src/notifications.js` | Done — status pill + toasts |
| **Transport Adapters** | `src/adapters/{base,index,websocket,file,snapshot}.js` | Done — 258.9KB bundle, 149/159 tests |

## What's Planned

### Connection String

Collapse setup into a single URI the coordinator shares:

```
troparcel://ws/server.edu:2468/room?token=secret
troparcel://file/home/alice/Nextcloud/tropy-collab
troparcel://snapshot/https://r2.example.com/crdt/state.yjs?auth=Bearer+tok
```

Researcher configures 2 fields: connection string + your name. Individual fields remain as `[Advanced]` overrides.

**Parse priority:** Connection string parsed first. Explicit individual field overrides win. Empty connectionString + existing serverUrl = backward compatible.

| File | Change |
|---|---|
| `src/connection-string.js` | **New** — parse/generate `troparcel://` URIs |
| `src/plugin.js` | Parse connectionString before mergeOptions(). Add connectionString + reorder options. |
| `package.json` | connectionString field at top of options array |

### V2: Ownership Guard

Author-scoped retraction for authored content. Tags/lists exempt (add-wins semantics).

**Entity-type-specific rules:**

| Entity | Ownership model | Rationale |
|---|---|---|
| Notes | Author-guarded | Clear single authorship (UUID creator) |
| Selections | Author-guarded | Clear single authorship |
| Transcriptions | Author-guarded | Clear single authorship |
| Tags | No guard (add-wins) | Multi-author — `author` = last pusher, not creator |
| List memberships | No guard (add-wins) | Same as tags |

**Push side** (`pushDeletions`): For notes/selections/transcriptions, read CRDT `author` before tombstoning. Own → tombstone. Others' → `vault.dismissedKeys`.

**Apply side**: Reject tombstones where `tombstone.author !== original.author` for notes/selections/transcriptions. Accept all tag/list tombstones.

**pushSeq-aware dismissals:** `vault.dismissedKeys` stores `Map<key, pushSeqAtDismissal>`. When author revises content (`entry.pushSeq > dismissedPushSeq`), auto-undismiss. Dismissed keys excluded from `failedNoteKeys`.

**syncDeletions default stays OFF.** Rationale: changing defaults on upgrade breaks existing users; author spoofing (userId is self-declared) means ON isn't fully safe in untrusted/file-based environments. Language softened in docs.

| File | Change |
|---|---|
| `src/push.js` | Author check in pushDeletions for notes/sel/tx. Skip `@*` tags, `troparcel:*` metadata. |
| `src/apply.js` | Tombstone author validation for notes/sel/tx |
| `src/vault.js` | dismissedKeys → Map<key, pushSeq>. Entity-type prefix. failedNoteKeys exclusion. |
| `src/sync-engine.js` | Wire notification calls for retract/dismiss events |

### V3: Attribution Tags + Metadata

On apply, tag items with `@contributor` and write contributor/lastSync metadata.

**Local-only — two-layer protection:**
1. `dispatchSuppressed()` wraps all attribution dispatches (prevents store.subscribe)
2. Push filter skips `@*` tags and `troparcel:*` / `https://troparcel.org/ns/*` URIs (prevents CRDT entry even if suppression fails)

**Tag rules:** `@username` format, deterministic color (hash → palette), created once per user. Cached in vault. Re-created on each apply from CRDT author fields. Deleting is harmless.

**Metadata URIs:** `https://troparcel.org/ns/contributors`, `https://troparcel.org/ns/lastSync`

| File | Change |
|---|---|
| `src/apply.js` | After apply per item: dispatch @user tag + metadata via dispatchSuppressed() |
| `src/push.js` | Skip @* tags and troparcel:* metadata URIs |
| `src/store-adapter.js` | Add dispatchSuppressed(action) helper |
| `src/vault.js` | Cache attribution tag IDs |

### V4: Auto-Lists

"Synced items" list populated with items that received remote annotations.

**Rules:** Accumulative (items added, not replaced). User curates removal. Dismissed items excluded. Created on first apply, reused thereafter. Local-only (never pushed to CRDT).

**Apply sequence:** apply annotations → V3 attribution → V4 list add. All wrapped in dispatchSuppressed().

| File | Change |
|---|---|
| `src/apply.js` | Collect applied item IDs, dispatch list.item.add via dispatchSuppressed() |
| `src/store-adapter.js` | Uses dispatchSuppressed() from V3 |
| `src/vault.js` | Cache auto-list ID |
| `src/plugin.js` | Add syncedListName option (default: "Synced items") |

### Deploy Templates

| File | Purpose |
|---|---|
| `render.yaml` | One-click Render deploy |
| `railway.json` | One-click Railway deploy |
| `server/cloudflare/` | Durable Objects worker template |
| `server/index.js` | Print connection string on startup |
| `server/package.json` | `bin` field for `npx troparcel-server` |

### Documentation Rewrite

| Doc | Key changes |
|---|---|
| **GUIDE.md** | Connection string setup replaces settings card. Ownership model. Attribution tags/auto-lists explained. Presets simplified. 5-step deletion dance replaced. |
| **SETUP.md** | File/snapshot transport scenarios. Connection string in all scenarios. Deploy button instructions. |
| **CONFLICTS.md** | Entity-type ownership. Attribution tags local-only. Departed authors limitation. |
| **DEVELOPER.md** | Yjs future-proofing: subdocs, client persistence, XmlFragment migration paths. |
| **CHANGELOG.md** | v6.0 entry |

---

## Original Design Concerns — Resolution Table

| ID | Concern | Original mitigation | Resolution in C+ |
|---|---|---|---|
| OC1 | Any user can tombstone any content | syncDeletions OFF | Author guard for notes/sel/tx. Tags/lists: add-wins. Default stays OFF. |
| OC2 | No cryptographic identity | Room tokens | Unchanged. userId trust-based. Documented limitation. |
| OC3 | Tag author ≠ creator | N/A (not previously addressed) | Tags exempt from ownership guard. Add-wins semantics. |
| OC4 | Tombstone GC window (30d) | Connect monthly | Unchanged. V2 doesn't alter tombstone lifecycle. |
| OC5 | Coordinator-only deletion | 5-step enable/delete/disable | Simplified: author retracts own. Departed author: dismiss locally or reset CRDT. |
| OC6 | Ghost note prevention | failedNoteKeys 3-retry | Dismissed keys excluded from failedNoteKeys. |
| OC7 | Dismissal lifecycle | N/A (new concern) | pushSeq-aware: auto-undismiss when author revises. |
| OC8 | Attribution feedback loops | N/A (new concern) | Two layers: dispatchSuppressed() + push filter. |
| OC9 | Setup complexity | Settings card, 20+ options | Connection string. Two fields. Server prints string. |

---

## Yjs Future-Proofing (R13)

| Capability | Risk | Affordance now | Implementation later |
|---|---|---|---|
| **Subdocs** (per-item isolation) | Low | Don't assume all items loaded in hot paths | Per-item subdocs, adapter loadSubdoc() |
| **Client persistence** (offline-first) | Low | Doc created before connect. Reserve state vector methods. | y-indexeddb or fs persistence, delta sync |
| **XmlFragment** (concurrent editing) | Medium | Reserve noteFormat field. Document Tropy dependency. | y-prosemirror binding, schema migration |

---

## Build Order

```
                 DONE                          PLANNED
            ┌────────────┐     ┌──────────────────────────────────────┐
            │            │     │                                      │
V1 (notifs) ─── done     │     │  Connection String ──┐               │
Transport ──── done      │     │                      ├→ V2 (ownership)
            │            │     │                      │               │
            └────────────┘     │  V3 (attribution) ←──┘               │
                               │       │                              │
                               │       └──→ V4 (auto-lists)          │
                               │                                      │
                               │  Deploy templates ──── (parallel)    │
                               │  Documentation ──────── (after V2-V4)│
                               └──────────────────────────────────────┘
```

**Dependencies:**
- Connection String + V2: independent, can start in parallel
- V3: depends on V2 (dismiss events) + needs dispatchSuppressed()
- V4: depends on V3 (shares dispatch pattern, fires after attribution)
- Deploy: independent, parallel
- Docs: after V2-V4

## Verification

| Slice | Criteria |
|---|---|
| Connection String | Parse ws/file/snapshot URIs. Individual overrides win. Empty string = backward compat. |
| V2 | Own note tombstones. Non-author note dismisses. pushSeq advance un-dismisses. Tags: no guard. |
| V3 | @user tags appear. troparcel:* metadata written. Neither enters CRDT. |
| V4 | "Synced items" populated. Dismissed items excluded. Accumulative. |
| Deploy | npx troparcel-server prints connection string. Render deploy works. |
| Docs | All presets use connection string. Ownership model documented. All 3 transports covered. |
