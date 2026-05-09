---
shaping: true
---

# V4: "I can find what changed" — Auto-Lists V-Plan

Parent: [shaping.md](shaping.md) → [slices.md](slices.md)
Source: [shaping.md](shaping.md) R4 → [slices.md](slices.md) V4

## Demo Criterion

Remote sync applies changes. Sidebar shows a "Synced items" list containing items that received remote annotations. List updates on each sync cycle.

## Affordances

| # | Affordance | Type | Wires |
|---|------------|------|-------|
| N1 | List dispatch: create "Synced items" list + add items | Non-UI | Via dispatchSuppressed (from V3) |
| U1 | "Synced items" list in sidebar tree | UI | Created by N1 |

## File Scope

| File | Changes |
|------|---------|
| `src/apply.js` | After apply cycle: collect affected item IDs, dispatch `list.item.add` via dispatchSuppressed |
| `src/push.js` | Skip auto-list by name in pushLists |
| `src/vault.js` | Cache `syncedListId` |
| `src/plugin.js` | Add `syncedListName` to mergeOptions |
| `package.json` | Add `syncedListName` option in `[Advanced]` section |
| `test/index.test.js` | Auto-list tests |

## Build Sequence

1. Add `syncedListName` option to plugin.js mergeOptions + package.json
2. Add `vault.syncedListId` + getter/setter (not persisted — rediscovered from store)
3. After apply cycle in apply.js: collect `appliedItemIds`, find or create "Synced items" list, dispatch `list.item.add` via dispatchSuppressed
4. In push.js pushLists: `if (listName === this.options.syncedListName) continue`
5. Build + test

## List Rules

- Name: "Synced items" (configurable via `syncedListName` option, blank = disabled)
- Created once on first apply, reused thereafter
- Items ADDED on each sync cycle (accumulative)
- User curates removal manually
- Local-only: list membership dispatches never pushed to CRDT
