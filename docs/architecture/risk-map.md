# Troparcel — Risk Map

Audit-grade list of known issues. Drift findings from this synthesis cycle (2026-05-08) are marked **DRIFT-VERIFIED**; carryovers from [docs/AUDIT.md](../AUDIT.md) and [docs/SHAPING.md](../SHAPING.md) are marked **CARRYOVER**.

## P0 — runtime crashes (block selected shape)

### R1. `_applyAttribution` calls `dispatchSuppressed` which is undefined — DRIFT-VERIFIED

- **Where:** `src/apply.js:167, 174, 182, 191` invoke `this.adapter.dispatchSuppressed(...)`.
- **Why broken:** `src/store-adapter.js` defines only `suppressChanges()` / `resumeChanges()`; no `dispatchSuppressed` exists in `src/`.
- **Symptom:** First applied non-self item triggers `TypeError: this.adapter.dispatchSuppressed is not a function`, aborts the apply cycle, attribution never lands.
- **Fix:** Detail in [subsystems/attribution.md](./subsystems/attribution.md). Recommended Option B (use `store.dispatch` directly — caller already suppresses).
- **Mulch:** `mx-ddbf09` (suppressChanges not nestable) is load-bearing here.

## P1 — unfinished selected shape

### R2. V5 template + list-hierarchy sync never invoked — DRIFT-VERIFIED

- **Where:** `applyTemplates()` and `applyListHierarchy()` exist in `src/apply.js`. Zero call sites in `src/sync-engine.js`.
- **Also missing:** `readTemplates()` / `readLists()` on `store-adapter.js`; `pushTemplates()` / `pushListHierarchy()` in `push.js`.
- **Symptom:** Template + project-level list hierarchy never sync between peers (the named demo criterion of V5).
- **Fix:** Wiring chain in [subsystems/v5-template-list-sync.md §Wiring chain](./subsystems/v5-template-list-sync.md#wiring-chain-to-make-this-live).

## P1–P2 — design-spec gaps (CARRYOVER from [docs/AUDIT.md](../AUDIT.md))

[docs/AUDIT.md](../AUDIT.md) is comprehensive — read it directly. Highlights cross-referenced here so they're not lost:

| Audit § | Concern | Severity |
|---|---|---|
| §1 Identity Model | Item-identity hash collision risk + alias map fragility | P2 |
| §2 CRDT Document Structure | Subdoc refactor (V7) not started; current `annotations` Y.Map will not scale to large projects | P2 (becomes P0 at scale) |
| §3 Metadata Sync | Metadata uses YKeyValue (Y.Array); historical-value retention behaviour differs from spec — see audit suggestions | P2 |
| §4 Tag Sync | Tag-name normalization (`_migrateTagKeysToLowercase`) is one-shot; verify idempotency on re-run after schema-version bump | P2 |
| §5 Note Sync | UUID-keyed `Y.Map` with HTML footer for soft-delete; HTML sanitizer is state-machine custom (not a library) — security review needed. **Reconciliation 2026-05-08:** found 6 over-permissive tags vs Tropy's editor schema (`u, s, h1-h6, code, pre, div`). Detail: [subsystems/notes-html-pipeline.md](./subsystems/notes-html-pipeline.md). | P1 |
| §6 Selection Sync | Geometry-keyed merge (per [docs/design/crdt-design.md](../design/crdt-design.md)) — selection-near-duplicate behaviour deserves dedicated tests | P2 |

## P2 — knowledge-store hygiene

### R3. Workspace `.seeds/` not initialized

- No `.seeds/` exists at `/mnt/Ghar/2TA/DevStuff/tropy-plugin/`. Issues are tracked only in plan files + audit doc + this risk map.
- Action: run `sd init` at workspace level when adopting the seeds workflow. R1 + R2 above are the natural first issues.

### R4. Mulch convention `mx-ddbf09` describes a method that no longer exists

- The record describes how `dispatchSuppressed` *should* behave. The method was removed (or never landed) on `store-adapter.js`.
- Action: amend the record (see `mulch sync` workflow) to clarify that `dispatchSuppressed` is the documented pattern but is not currently implemented at the adapter; choose Option B from [subsystems/attribution.md] before implementing.

## Out of scope for this audit

- No git in `troparcel/` directory (workspace lives at parent). Evolution lens (churn hotspots, era strata) is not applicable here; [docs/SHAPING.md](../SHAPING.md) baseline + [docs/design/slices.md](../design/slices.md) status table substitute as the time axis.
- No test-coverage / quality-linter sweep was performed. [docs/plans/test.md](../plans/test.md) exists for the test campaign.
- Server-side (`server/index.js`, LevelDB persistence, monitor dashboard) was not drift-verified — README §Server is current and the server has not been a source of known bugs.

## Reconciliation findings (2026-05-08, follow-up to initial sweep)

These come from comparing `troparcel/src/` against `tropy/src/` directly, recorded as mulch entries with `--evidence-file` pointers:

- **Notes HTML pipeline:** `sanitize.js SAFE_TAGS` is over-permissive vs Tropy's editor schema by 6 tags (`u, s, h1-h6, code, pre, div`). Detail: [subsystems/notes-html-pipeline.md](./subsystems/notes-html-pipeline.md). Couples to audit §5 (security review).
- **V5 templates:** CRDT schema is missing `isProtected` and `domain` fields that Tropy's `Template.defaults` declares. Forward-compatible fix; should land before V5 wires up. Detail in [subsystems/v5-template-list-sync.md](./subsystems/v5-template-list-sync.md) §Reconciliation.
- **State paths verified:** `state.ontology.template` for templates, `state.lists` for lists, `LIST.ROOT = 0` sentinel. Direct one-line implementations for store-adapter `readTemplates` / `readLists`.
- **fs.watch unreliability (R9 watcher-restart):** is fallback-path-only smell. Primary path uses `store.subscribe()` per sync-engine.js SF3. Fallback path can replace `fs.watch` with chokidar + `awaitWriteFinish: true` (per `tropy/src/common/watch.js` `Watcher`) to eliminate SQLITE_BUSY races and the ~50 LOC restart machinery.

Seeds tracking these: `tropy-plugin-{8073, 25e2, 7a4a, a542, 733b, b5de, e4da, b4eb, 829a}` (9 reconciliation issues). Run `sd ready` to see the unblocked queue.
