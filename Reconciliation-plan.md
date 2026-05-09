# Troparcel — Reconciliation + V5 Completion Plan

> **Status:** active plan (2026-05-08). Continues `V5-plan.md` (whose status table is now superseded by this document's task list) and incorporates the 9 reconciliation findings from the 2026-05-08 codebase-diagnostics sweep.
>
> **Reads:** `docs/architecture/{overview,subsystems,risk-map}.md`, `docs/architecture/subsystems/{attribution,v5-template-list-sync,notes-html-pipeline}.md`, `shaping.md` (selected shape), `slices.md §V5` (demo criterion).

## Goals

1. **Make the selected shape work end-to-end.** *Batteries-Included + Full Project Sync* per `shaping.md`. V3 attribution must not crash; V5 templates + project-list-hierarchy must actually transit between peers.
2. **Replace archeology with citation.** Every load-bearing convention in `troparcel/src/` should trace to a file in `tropy/src/` via mulch `--evidence-file`. Drift detection becomes mechanical.
3. **Ship a smaller, more reliable plugin.** Less custom code, more upstream-aligned behavior — particularly file-watching, HTML sanitization, and notification UX.

## Non-goals

- V6 (item sync) and V7 (subdocs) — separate epics; depend on V5 landing first.
- Server-side LevelDB persistence changes.
- Ground-up rewrite of HTML sanitizer (only tightening + drop unused tags).
- Vault file format migration (current v4 stays).
- Any change to selected-shape decisions (Full Project Sync is the chosen path; this plan executes it).

## Wave map

```
Wave 1 ─ Critical path  ──┐
                          ├─► Wave 2 ─ V5 epic  ──► Wave 3 ─ Reliability + notes  ──► Wave 4 ─ Type-correctness  ──► Wave 5 ─ UX + hygiene
829a (research) ──────────┘
```

Waves 1, 3, 4 are independently shippable. Wave 2 is the central feature epic. Wave 5 is polish.

---

## Wave 1 — Critical path (1–2 days)

**Goal:** restore working V3 attribution; reconcile mulch with code state; understand the plugin's runtime surface.

### W1.T1 — Fix `_applyAttribution` (seed `tropy-plugin-03ee` · P0)
- **Where:** `src/apply.js:167, 174, 182, 191`.
- **What:** Replace each `this.adapter.dispatchSuppressed(...)` with `this.adapter.store.dispatch(...)`. Caller (`applyPendingRemote` in `sync-engine.js`) already brackets with `suppressChanges()` / `resumeChanges()`. Pattern matches V5 `applyTemplates` at `apply.js:1217`.
- **Acceptance:**
  - 2-instance test: Bob applies Alice's annotations without `TypeError`.
  - `@alice` tag appears on each item Alice contributed to.
  - `troparcel:contributors` and `troparcel:lastSync` metadata visible in metadata panel.
  - V3 demo criterion in `slices.md §V3` passes.

### W1.T2 — Update mulch `mx-ddbf09` (seed `tropy-plugin-d8ba` · P2, atomic with W1.T1)
- **What:** After W1.T1 lands, amend the convention record. New text: *"`suppressChanges()` / `resumeChanges()` are caller-managed via the bracket on `applyRemoteAnnotations`. Apply-mixin functions reached from there must use `this.adapter.store.dispatch(...)` directly. `dispatchSuppressed` is not implemented on the adapter — references in older docs predate its removal."*
- **Acceptance:** `ml search "suppressChanges"` returns the updated record; no record references a non-existent method.

### W1.T3 — Investigate plugin context object (seed `tropy-plugin-829a` · P3, research-only)
- **Where:** `tropy/src/components/plugin/config.js`, `tropy/src/wm/*` (renderer-side `Plugins` instantiation), `tropy/src/common/plugins.js getContext()`.
- **What to determine:**
  - Does the plugin's `context` parameter expose anything beyond `logger`? (e.g., the `store`, the `dialog` system, `ipcRenderer` access, the `plugins` manager itself.)
  - Can a plugin dispatch `FLASH.SHOW` directly?
  - Does `contextIsolation` affect what `require('electron')` returns from inside the plugin?
- **Output:** `ml record sync --type reference` with findings + decision matrix for downstream tasks (W5.T2, W5.T3).
- **Unblocks:** `e4da` (FLASH.SHOW adoption decision) + `b4eb` (constants import vs mirror decision).

---

## Wave 2 — V5 template + project-list-hierarchy sync (4–7 days)

**Goal:** ship the named V5 demo criterion. Alice creates template "Field Notes" + nested list hierarchy "2026 Campaign / Site A / Trench 1" → Bob connects to the same room → Bob sees both without manually creating either.

### Sub-phase 2a — Pre-reads (parallel)

#### W2.T1 — V5 template payload deep-dive (seed `tropy-plugin-733b` · P1)
- **Read:** `tropy/src/ontology/{template,vocabulary,ns}.js`, `tropy/src/actions/ontology.js`, `tropy/src/sagas/ontology.js`, `tropy/src/constants/ontology.js`.
- **Output:**
  - Confirm the full `Template.parse` JSON-LD shape (already mostly captured in `subsystems/v5-template-list-sync.md` §Reconciliation).
  - Verify whether Tropy validates `@id` URI prefix on template import.
  - Decide URI strategy for troparcel-generated templates (use Tropy's `https://tropy.org/v1/templates/id#…` convention vs preserve external URI).
- **Acceptance:** mulch convention record on URI strategy; payload-shape table in subsystem doc verified field-by-field.

#### W2.T2 — Store-adapter contract (seed `tropy-plugin-7a4a` · P1)
- **Read:** `tropy/src/selectors/{ontology,lists}.js`, `tropy/src/commands/api/{list,item}.js`, `tropy/src/reducers/{ontology,lists}.js`.
- **Output:** mulch convention record naming exact state slice paths (`state.ontology.template`, `state.lists`, `LIST.ROOT = 0`); memoization decision (cache reads per sync cycle to avoid 5×-redundant `getState()` calls).
- **Acceptance:** new `readTemplates` / `readLists` JSDoc cites this record.

### Sub-phase 2b — CRDT schema additions (atomic single change)

#### W2.T3 — Add `isProtected` and `domain` to template schema
- **Where:** `src/crdt-schema.js setTemplateSchema`.
- **What:**
  ```js
  // setTemplateSchema, inside the schemaMap.set(uri, {...}):
  isProtected: !!templateDef.isProtected,   // NEW — defaults to false
  domain: templateDef.domain || null,        // NEW — RDF domain URI or null
  ```
- **Migration safety:** Forward-compatible. Existing v4 docs without these fields parse as `undefined`; new push includes them; old peers reading new docs ignore extra Y.Map keys.
- **Decision:** **Do NOT** bump `room.schemaVersion` from 4 → 5. Rationale: additive change, not breaking. Re-evaluate if/when removal or rename happens.
- **Acceptance:** Round-trip a `Template` with `isProtected: true` → CRDT → second peer's apply → assert protected on receive.

#### W2.T4 — Vault hash invalidation
- **Where:** `src/vault.js pushedTemplateHashes` keying.
- **What:** Ensure the hash key used in `vault.pushedTemplateHashes` includes the new fields. If hash is computed from the full JSON-stringified template, no change. If hash is computed from a subset, add `isProtected` + `domain` to the subset.
- **Acceptance:** Toggle `isProtected` locally → push fires (was previously a no-op if hash didn't include the field).

### Sub-phase 2c — Adapter / push / apply / wire (the core landing)

#### W2.T5 — `store-adapter.js` reads
- **Add:** `readTemplates() { return this.store.getState().ontology.template }`
- **Add:** `readLists() { return this.store.getState().lists }`
- **JSDoc each:** state-path + evidence-file pointer to `tropy/src/selectors/{ontology,lists}.js`.
- **Acceptance:** `apply.js applyTemplates` no longer crashes on missing method (currently dies before ever being called because it's not wired, but the wiring depends on this).

#### W2.T6 — `push.js pushTemplates(userId, pushSeq)`
- **Read** local templates via `adapter.readTemplates()` (a `Map` of `{[id]: {...}}`).
- For each template:
  - Skip if URI is internal Tropy preset (skip `tropy.Item`, `tropy.Photo`, `tropy.Selection` factory templates — these come from Tropy itself, not user-created).
  - Compute deterministic hash from `{name, type, fields, isProtected, domain, …}`.
  - If `vault.pushedTemplateHashes.get(uri) === hash`, skip (already pushed unchanged).
  - Otherwise: `schema.setTemplateSchema(this.doc, uri, def, userId, pushSeq)` and update `vault.pushedTemplateHashes.set(uri, hash)`.
- **Acceptance:** Local template change → 1 CRDT write. Local template unchanged → 0 CRDT writes.

#### W2.T7 — `push.js pushListHierarchy(userId, pushSeq)`
- **Read** local lists via `adapter.readLists()` (a `Map` of `{[id]: {id, parent, name, children}}`).
- Walk in topological order (parent before children).
- For each non-root list:
  - Look up CRDT UUID via `vault.listIdToCrdtUuid.get(localId)`; if missing, mint new UUID + bidirectional vault mapping.
  - Resolve parent CRDT UUID (root → `null` in CRDT, others → mapped UUID).
  - Compute hash from `{name, parent: parentUuid, …}`.
  - Gate by `vault.pushedListHashes.get(uuid)`.
  - Write via `schema.setListHierarchyEntry(this.doc, uuid, entry, userId, pushSeq)`.
- **Acceptance:** Nested list created locally → corresponding nested entries in CRDT `projectLists` map; reparent → single write to the moved list (children's parent UUIDs do not change).

#### W2.T8 — `apply.js applyTemplates` payload update
- **Add** `isProtected` and `domain` to the dispatched payload alongside existing fields:
  ```js
  this.adapter.store.dispatch({
    type: 'ontology.template.create',
    payload: {
      [uri]: {
        name: tmpl.name,
        type: tmpl.type || 'https://tropy.org/v1/tropy#Item',
        creator: tmpl.creator || '',
        description: tmpl.description || '',
        isProtected: !!tmpl.isProtected,        // NEW
        domain: tmpl.domain || null,             // NEW
        fields
      }
    },
    meta: { cmd: 'ontology', history: 'add' }
  })
  ```
- **Acceptance:** Bob's local template after apply contains both new fields; round-trip preserves `isProtected: true`.

#### W2.T9 — `apply.js applyListHierarchy` verification (no code change expected)
- The function (apply.js, current state) already correctly: filters self-authored, topo-sorts, dispatches `list.create` via `store.dispatch` directly with the `_waitForAction` + state-diff pattern (per mulch `mx-92978e`). Verify against spec when wiring lands.
- **Acceptance:** First apply creates lists; subsequent applies are no-op (vault tracks UUID→localID mapping).

#### W2.T10 — `sync-engine.js syncOnce()` wires V5 (seed `tropy-plugin-4541` · P1, ✱ headline issue)
- **Where in `syncOnce`:** project-level (NOT per-item — once per cycle).
- **Order:**
  1. Push local: existing `pushLocal` per-item loop (unchanged)
  2. **NEW:** `await this.pushTemplates(userId, pushSeq)`
  3. **NEW:** `await this.pushListHierarchy(userId, pushSeq)`
  4. Apply remote: existing `applyRemoteAnnotations` per-item loop
  5. **NEW:** `await this.applyTemplates()` (project-level — once)
  6. **NEW:** `await this.applyListHierarchy()` (project-level — once)
- **Suppression:** all 4 NEW calls run inside the existing `adapter.suppressChanges() / resumeChanges()` bracket from `applyPendingRemote`. Confirm bracket spans both push and apply; if not, extend.
- **Acceptance:** 2-instance V5 demo from `slices.md §V5` passes — Alice creates template + nested list, Bob sees both without manual creation.

### Sub-phase 2d — Documentation
- Update `slices.md §V5` status from 🟡 PARTIALLY BUILT → DONE.
- Update `shaping.md §Shapes > CURRENT: Baseline` to remove the V5-S/V5-V/V5-A "🟡" rows.
- Add CHANGELOG entry: "V5 template + project-list-hierarchy sync".

---

## Wave 3 — Reliability + notes hardening (2–3 days)

### W3.T1 — Replace `fs.watch` with chokidar (seed `tropy-plugin-b5de` · P1)
- **Add dependency:** `chokidar` to `package.json` (esbuild bundles it into `index.js`).
- **Replace** `_startFileWatcher` body with:
  ```js
  const chokidar = require('chokidar')
  this.fileWatcher = chokidar.watch(this.projectPath, {
    awaitWriteFinish: true,    // SQLITE_BUSY mitigation
    alwaysStat: true,
    ignoreInitial: true,
    followSymLinks: false
  })
  this.fileWatcher.on('change', () => this.handleLocalChange())
  this.fileWatcher.on('error', err => this._debug('watcher error', { error: err.message }))
  ```
- **Delete** `_restartFileWatcher`, `_checkWatcherHealth`, `_watcherHealthTimer`, `_lastWatcherEvent`, the 60s health-check `setInterval`, and all R9 references (~50 LOC reduction).
- **Audit:** confirm `_startFileWatcher` only fires when Redux store is unavailable (per sync-engine.js SF3: `store.subscribe()` is the primary path). Document in updated JSDoc.
- **Acceptance:**
  - No SQLITE_BUSY observed under autosave + safety-net concurrency for 30 min.
  - Watcher resumes cleanly after USB-disconnect-style FS interrupt (chokidar handles).
  - Fallback path (when store missing) still triggers sync.

### W3.T2 — Tighten note `SAFE_TAGS` (seed `tropy-plugin-8073` · P1, security)
- **Where:** `src/sanitize.js SAFE_TAGS`.
- **Drop:** `u, s, h1, h2, h3, h4, h5, h6, code, pre, div`. (None are in Tropy's editor schema; their content survives Tropy's `fromHTML` parse but their formatting silently disappears.)
- **Keep:** `p, br, em, i, strong, b, a, ul, ol, li, blockquote, hr, sup, sub, span`.
- **Verify:** `<span class="line-break"><br></span>` still passes (the canonical `hard_break` form Tropy emits).
- **Couples with:** audit §5 security review; this change reduces XSS surface area.
- **Deferred (separate follow-up issue):** normalize-on-push helper that converts `<u>foo</u>` → `<span style="text-decoration: underline">foo</span>` etc. before writing to CRDT, for cross-peer visual consistency. **Filing as a new seed at end of Wave 3.**
- **Acceptance:** Round-trip note containing dropped tags → text content survives, formatting strips cleanly with no XSS regression.

---

## Wave 4 — Type-correctness (2–3 days)

### W4.T1 — Type-aware metadata merge (seed `tropy-plugin-25e2` · P2)
- **Add dependency:** `edtf` (already in Tropy's deps; bundle into plugin via esbuild).
- **Where:** `src/push.js` metadata path + `src/apply.js` metadata path + LWW comparison in vault dedup logic.
- **What:**
  - When pushing/applying metadata with `datatype === 'http://www.w3.org/2001/XMLSchema#date'`: pre-parse via `edtf(value.text)` to a stable representation. Use the parsed instant for LWW comparison, not the raw string.
  - Other datatypes (`xsd:string`, `xsd:integer`, etc.): current LWW-by-string is correct; no change.
- **Acceptance:**
  - Two peers writing `"1450"` and `"1450~"` (same EDTF instant, different strings) → LWW resolves once, no churn.
  - Date-vs-string-mismatched writes still picked up as conflicts (semantic-vs-syntactic distinction preserved).

---

## Wave 5 — UX + hygiene (2–4 days)

### W5.T1 — Group apply-cycle writes via `HISTORY.TICK mode:'merge'` (seed `tropy-plugin-a542` · P2)
- **Where:** `src/sync-engine.js applyPendingRemote` boundary.
- **What:** Bracket the apply cycle with a `HISTORY.TICK` action whose `meta.mode = 'merge'` (per `tropy/src/actions/history.js tick()`). All `tag.create` / `list.create` / `metadata.save` etc. inside the cycle merge into one undoable transaction.
- **Acceptance:** Applying 5 remote items shows ONE undo entry "Remote sync from Alice (5 items)" instead of dozens.
- **Risk:** verify HISTORY.TICK semantics from inside a renderer plugin (couples with W1.T3 context investigation).

### W5.T2 — `FLASH.SHOW` for native notifications (seed `tropy-plugin-e4da` · P3, blocked-by W1.T3)
- **Decision tree from W1.T3 outcome:**
  - **If** plugin context exposes `dispatch` (or store): replace `src/notifications.js` calls with `FLASH.SHOW` dispatch (`type: 'flash.show', payload: {message, duration}, meta: {ipc: true}`).
  - **If not:** keep DOM overlay; document why; close this seed as `outcome:rework — blocked-by-context-isolation`.
- **Acceptance (success path):** sync events render in Tropy's native flash UI consistent with other plugin notifications; no DOM injection from troparcel.

### W5.T3 — Constants sweep (seed `tropy-plugin-b4eb` · P3)
- **What:** Inventory hardcoded action-type strings across `src/{push,apply,store-adapter,sync-engine}.js`.
- **Decision tree from W1.T3:**
  - **If** plugin can `require('tropy/...')` once main is loaded: import constants/* directly.
  - **If not (likely):** mirror `tropy/src/constants/{tag,list,metadata,note,selection,history,flash,ontology,project,type}.js` into a single `src/tropy-constants.js` with evidence-file pointer at top.
- **Acceptance:** Every dispatched action type traces to a documented Tropy constant — `grep -r "type: '" src/` returns either a `TROPY_CONSTANTS.X` reference or an evidence-file comment.

### W5.T4 (NEW) — Notes normalize-on-push (file as seed during Wave 3)
- **Where:** new helper `src/note-normalize.js` invoked from `src/push.js` notes path.
- **What:** Map `<u>foo</u>` → `<span style="text-decoration: underline">foo</span>`; `<s>foo</s>` → `<span style="text-decoration: line-through">foo</span>`; etc. Mirror tag-equivalence table from `tropy/src/editor/schema.js`.
- **Acceptance:** Cross-peer rendering consistent regardless of which peer authored.

---

## Cross-cutting concerns

### Testing
`Vtest-plan.md` exists at repo root for the test campaign. This plan adds:

| Acceptance test | Wave | Type |
|---|---|---|
| V3 attribution 2-instance | 1 | integration |
| V5 template + nested-list 2-instance | 2 | integration |
| chokidar SQLITE_BUSY 30-min | 3 | endurance |
| sanitize SAFE_TAGS round-trip | 3 | unit |
| EDTF date-string equivalence | 4 | unit |
| Apply-cycle single-undo | 5 | integration |

### Migration safety
- **CRDT schema bump (W2.T3):** additive only; no version bump needed.
- **Vault format:** no change.
- **Existing rooms:** old peers ignore new template fields; new peers default to `undefined` for legacy entries.

### Documentation
After each wave:
- Wave 1 → `shaping.md` baseline (mark AT1 done); CHANGELOG.md.
- Wave 2 → `slices.md §V5` → DONE; `shaping.md §Shapes > CURRENT: Baseline` clear of yellows; CHANGELOG.md.
- Wave 3 → README §Port-conflicts (chokidar behavior); CHANGELOG.md; `subsystems/notes-html-pipeline.md` updated.
- Wave 4–5 → CHANGELOG.md per task.

### Mulch hygiene
After each wave's tasks land, the relevant mulch records get `--evidence-commit` annotations (or evidence-bead if no git). Drift detection at next `codebase-diagnostics` invocation should be 0 records flagged for the touched subsystems.

## Estimate

| Wave | Days | Critical-path? |
|---|---|---|
| 1 | 1–2 | yes — P0 blocker |
| 2 | 4–7 | yes — selected shape |
| 3 | 2–3 | parallelizable with W4 |
| 4 | 2–3 | parallelizable with W3 |
| 5 | 2–4 | depends on W1.T3 |
| **total** | **~12–19 days** | for 1 dev |

Wave 1 + Wave 2 are the priority block; everything else is incremental hardening.
