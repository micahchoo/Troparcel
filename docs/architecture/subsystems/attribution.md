# Subsystem: V3 Attribution (tags + contributor metadata)

> **Drift status (2026-05-08):** Confirms shaping.md baseline 2026-02-28 — `_applyAttribution` is wired into `applyRemoteAnnotations` but blocks at runtime because `dispatchSuppressed` is missing from `store-adapter.js`.

## Goal

When applying remote annotations, attribute who contributed:

1. For each non-self author found in the item's annotations, create (or reuse) a tag named `@<author>` and assign it to the local item.
2. Write `troparcel:contributors` (comma-separated authors) and `troparcel:lastSync` (ISO timestamp) to item metadata.
3. Skip these attribution-only writes when *pushing* back (`@*` tag names + `troparcel:*` / `https://troparcel.org/ns/*` URIs in `push.js`) so attribution doesn't echo across peers.

Demo criterion (from `slices.md`): Bob's apply cycle attaches `@alice` to every item Alice has annotated, and the metadata panel shows `troparcel:contributors = alice`.

## Components

| Part | File | Status | Evidence |
|---|---|---|---|
| `_applyAttribution(itemIdentity, localId, userId)` | `src/apply.js:125` | ✅ Written, ✅ wired | Called from apply.js:108 inside the per-item loop of `applyRemoteAnnotations` |
| Author collection from annotations | `src/apply.js` | ✅ Done | Walks `notes`, `metadata`, `tags`, `selections`, `transcriptions` (read via `crdt-schema.js`) collecting non-self, non-deleted `author` fields into a Set |
| Tag dispatch (`tag.create` + `tag.save` + `item.tags.add`) | `src/apply.js:167-184` | 🟡 Defined but unreachable | Calls `this.adapter.dispatchSuppressed(...)` 3 times |
| Contributor metadata dispatch (`metadata.save`) | `src/apply.js:191` | 🟡 Defined but unreachable | Calls `this.adapter.dispatchSuppressed(...)` once |
| `attributionTagIds` cache in vault | `src/vault.js` | ✅ Done | Map<tagName, tagId> exists; cleared by `clear()`; not currently persisted |
| `dispatchSuppressed` on store adapter | `src/store-adapter.js` | ❌ **MISSING** | grep over all `src/`: 4 call sites in `apply.js`, **0 definitions anywhere** |
| Push-side filter for `@*` and `troparcel:*` | `src/push.js` | ⚠️ unverified | Not checked by this audit — verify before fixing the apply path or attribution will echo |

## Drift verification (this audit, 2026-05-08)

```
$ grep -rn "dispatchSuppressed" src/
src/apply.js:167:        this.adapter.dispatchSuppressed({
src/apply.js:174:        this.adapter.dispatchSuppressed({
src/apply.js:182:      this.adapter.dispatchSuppressed({
src/apply.js:191:    this.adapter.dispatchSuppressed({
src/apply.js:1217:      // … NOT dispatchSuppressed (which would call resumeChanges …
```

`store-adapter.js` defines only `suppressChanges()` (line 521) and `resumeChanges()` (line 528). The mulch convention `mx-ddbf09` describes how `dispatchSuppressed` *should* behave (call `resumeChanges` in finally), suggesting the method existed earlier and was removed or never landed at this layer.

The shaping baseline note "Attribution code exists but crashes at runtime (missing `dispatchSuppressed`)" is confirmed.

## Two viable fixes

**Option A — restore `dispatchSuppressed` on the adapter (matches mulch `mx-ddbf09`).**
```js
// store-adapter.js
dispatchSuppressed(action) {
  this.suppressChanges()
  try {
    return this.store.dispatch(action)
  } finally {
    this.resumeChanges()
  }
}
```
Then `_applyAttribution` works as written. **But** when called from inside `applyRemoteAnnotations`, the engine has already called `adapter.suppressChanges()` (sync-engine.js:`applyPendingRemote`) — the inner `resumeChanges` would prematurely lift suppression and start re-pushing the attribution writes back to the CRDT (the exact failure mode that mulch convention `mx-ddbf09` warns about).

**Option B — caller-already-suppresses pattern (matches what V5 apply functions do).**
Replace the 4 `dispatchSuppressed` call sites in `_applyAttribution` with `this.adapter.store.dispatch(...)` directly, mirroring the comment at apply.js:1217. This is the pattern V5's `applyTemplates`/`applyListHierarchy` already use.

Option B is consistent with the load-bearing invariant from `mx-ddbf09` (suppressChanges not nestable) and avoids re-introducing a known-buggy pattern. Option A would need `dispatchSuppressed` to additionally check whether suppression is already active — strictly more complex and easier to misuse.

## Mulch records to consult before fixing

- `mx-ddbf09` — **suppressChanges not nestable** — drives the choice toward Option B
- The V5 apply.js comment at line 1217 itself describes the canonical pattern

## Related canonical docs

- [slices.md §V3](../../../slices.md) — affordances, attribution rules, file scope
- [shaping.md §AT1](../../../shaping.md) — current state row
- [docs/CONFLICTS.md] — resolution rules per data type (attribution does not change merge semantics, only adds derived UI metadata)
