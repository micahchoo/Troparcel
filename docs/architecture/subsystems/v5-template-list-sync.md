# Subsystem: V5 Template + List Hierarchy Sync

> **Drift status (2026-05-08):** Confirms [docs/SHAPING.md](../../SHAPING.md) baseline 2026-02-28 — V5 schema and apply functions exist; push and wiring still missing.

## Goal

Synchronize **project-level** templates (custom item templates with field schemas) and **project-level** list hierarchy (nested folders in Tropy's sidebar). Per-item lists already work via `pushLists`/`applyLists`; this subsystem covers the project-level structure that lives outside individual items.

Demo criterion (from [docs/design/slices.md](../../design/slices.md)): Alice creates template "Field Notes" + list hierarchy "2026 Campaign / Site A / Trench 1" → Bob connects → Bob sees both without manual creation.

## Components

| Part | File | Status | Evidence |
|---|---|---|---|
| CRDT layout (`schema` + `projectLists` Y.Maps) | `src/crdt-schema.js` | ✅ Done | `getTemplateSchema`, `setTemplateSchema`, `removeTemplateSchema`, `getListHierarchy`, `setListHierarchyEntry`, `removeListHierarchyEntry`, `observeSchema`, `observeProjectLists` all present |
| Vault dedup state | `src/vault.js` | ✅ Fields defined | `pushedTemplateHashes`, `pushedListHashes`, `listIdToCrdtUuid`, `crdtUuidToListId` declared, persisted as `version: 4` v6 fields, `clear()` resets them |
| Apply: `applyTemplates()` | `src/apply.js` | 🟡 Written, never called | Defined in `apply.js`. Reads via `schema.getTemplateSchema(this.doc)` and `this.adapter.readTemplates()`. Dispatches `ontology.template.create` directly via `store.dispatch` (not `dispatchSuppressed`) — comment at apply.js:1217 explains caller already suppresses. |
| Apply: `applyListHierarchy()` | `src/apply.js` | 🟡 Written, never called | Defined in `apply.js`. Reads via `schema.getListHierarchy(this.doc)` and `this.adapter.readLists()`. Topological-sorts by parent, dispatches `list.create` then diffs state to find new local IDs (per mulch convention `mx-92978e`). |
| Store adapter `readTemplates()` / `readLists()` | `src/store-adapter.js` | ❌ Missing | grep returns no matches. Apply functions would crash on `TypeError: this.adapter.readTemplates is not a function`. |
| Push: `pushTemplates()` / `pushListHierarchy()` | `src/push.js` | ❌ Missing | grep returns no matches. Only per-item `pushLists` (different concern) exists. |
| Sync-engine wiring | `src/sync-engine.js` | ❌ Missing | grep over `sync-engine.js` shows no calls to `applyTemplates` or `applyListHierarchy` (5 call sites for `applyRemoteAnnotations`, zero for the V5 functions). |

## Drift verification (this audit, 2026-05-08)

Verified by direct grep on `troparcel/src/`:

```
$ grep -n "applyTemplates\|applyListHierarchy" src/sync-engine.js
(no output)

$ grep -n "readTemplates\|readLists" src/store-adapter.js
(no output)

$ grep -n "pushTemplates\|pushListHierarchy\|pushSchema" src/push.js
(no output)
```

The [docs/SHAPING.md](../../SHAPING.md) baseline statement is current: V5 is exactly as it was on 2026-02-28.

## Wiring chain to make this live

In dependency order (each must precede the next):

1. **`store-adapter.js`** — add `readTemplates()` and `readLists()`. Return raw state slices (`state.ontology.template`, `state.lists`) — **not** the `getAllTemplates`/`getListTree` selectors (they resolve URIs to objects / flatten trees, breaking CRDT-side identity). See [`## State paths`](#state-paths) for the contract and the load-bearing reason.
2. **`push.js`** — add `pushTemplates(userId, pushSeq)` and `pushListHierarchy(userId, pushSeq)`. Hash before push, gate by `vault.pushedTemplateHashes`/`pushedListHashes` to avoid loops. Use `crdtUuidToListId`/`listIdToCrdtUuid` for stable list identity across instances. Suppress `@*` and `troparcel:*` URIs (V3 attribution rule still applies).
3. **`sync-engine.js syncOnce()`** — invoke push (`pushTemplates`/`pushListHierarchy`) before `applyRemoteAnnotations` loop; invoke `applyTemplates()` and `applyListHierarchy()` once per cycle (project-level, not per-item).
4. **Test** — [docs/plans/v5.md](../../plans/v5.md) and [docs/design/slices.md §V5](../../design/slices.md) define the affordances + edge cases.

## Mulch records to consult before editing

- `mx-75e138` — `ontology.template.create` payload shape (apply path)
- `mx-92978e` — `list.create` payload + the `_waitForAction` + state-diff pattern (apply path)
- `mx-2a349c` — root doc Y.Map keyed `projectLists` (not `lists`) to avoid name collision with per-item annotations
- `mx-ff1e47` — YKeyValue forEach unwrap pattern (when reading metadata sections)
- `mx-ddbf09` — `suppressChanges` not nestable (relevant: apply.js:1217 already uses the workaround for this case)
- (this audit's new) reconciliation findings against `tropy/src/ontology/template.js` + `tropy/src/selectors/ontology.js` + `tropy/src/selectors/lists.js`
- See `## State paths`, `## Template payload shape`, `## URI strategy` below for verified field-by-field tables (closes seeds tropy-plugin-7a4a + 733b)
- **2026-05-09 update — load-bearing for V5 wiring (`tropy-plugin-4541`):**
  - `mx-780c7d` (convention) — `readTemplates`/`readLists` V2: bypass selectors, no memoization (supersedes `mx-06743c`)
  - `mx-57bcbc` (convention) — `ontology.template.create` payload V2 with verified field set + `meta.done:true` (supersedes `mx-75e138`)
  - `mx-0ade81` (convention) — URI strategy: preserve remote `@id`, never re-mint (supersedes `mx-c6baf2`; load-bearing CRDT correctness)
  - `mx-b5b6b6` (failure) — drift-corrected template-fields gap (supersedes `mx-d00765`)
  - `mx-995aa5` (convention) — `Field.id` is local synthetic; CRDT keys fields by `property` URI
  - `mx-9c9c7d` (convention) — apply must dispatch with `meta.done:true` to bypass saga gate
  - References: `mx-b8ab84` (template.js), `mx-8e3eb9` (reducers/ontology.js), `mx-34ef44` (selectors/ontology.js), `mx-539e62` (selectors/lists.js), `mx-be8d37` (api/list.js — no templates HTTP endpoint)

## State paths

> Verified 2026-05-09 against `tropy/src/selectors/ontology.js` + `tropy/src/selectors/lists.js` + `tropy/src/reducers/ontology.js` + `tropy/src/reducers/lists.js`. Closes seeds `tropy-plugin-7a4a`. Mulch: `mx-06743c`.

| What | Path | Shape | Source |
|---|---|---|---|
| Templates | `state.ontology.template` | `{[uri]: {id, type, name, creator, description, version, domain, isProtected, fields:[]}}` | `tropy/src/reducers/ontology.js:90-104` (template reducer — spread-merge on `TEMPLATE.CREATE/IMPORT/LOAD`) |
| Template selectors | — | `getAllTemplates`, `getTemplatesByType(type)`, `getItemTemplates`, `getPhotoTemplates`, `getSelectionTemplates`, `getTemplateList`, `getTemplateFields(state, props)`, `getTemplateField(state, props)` | `tropy/src/selectors/ontology.js:43-90` |
| Properties (vocabulary) | `state.ontology.props` | `{[uri]: {id, label, vocabulary, comment, ...}}` | `tropy/src/selectors/ontology.js:14-19` |
| Lists | `state.lists` (top-level — **NOT** under `state.ontology`) | `{[id:int]: {id, parent, name, children:[]}}` | `tropy/src/selectors/lists.js:1-59` |
| List root sentinel | `LIST.ROOT === 0` | top-level lists have `parent: 0`; root entry exists at `state.lists[0]` with full `children` array | `tropy/src/constants/list.js:2` |
| List subtree selector | — | `getListTree({lists}, {id, recursive})`, `getListByName`, `getListPath`, `getListSubTree` | `tropy/src/selectors/lists.js:5-59` |

**Adapter implementation rule (load-bearing):** `readTemplates()` MUST return `state.ontology.template` directly — **NOT** the `getAllTemplates` selector. The selector (ontology.js:43-58) replaces each `field.property` URI with the resolved vocab object (`{id, label, vocabulary, comment, ...}`); the CRDT push needs the raw URI string for cross-peer property identity. Same constraint applies to `readLists()` vs `getListTree`: CRDT push needs the raw `state.lists` map, not a flattened tree.

```js
// store-adapter.js (one-liners, no memoization — see note below)
readTemplates() { return this._getState().ontology.template }
readLists()     { return this._getState().lists }
```

**Memoization decision (per seeds 7a4a acceptance):** do NOT cache reads per sync cycle. `getState()` is O(1) (Redux returns a reference, not a copy); templates and lists are small Maps in practice; staleness during a long-running sync cycle is a worse failure mode than redundant access. Re-evaluate only if profiling shows cost.

**HTTP API surface for templates:** none. `tropy/src/commands/api/` contains `list.js` (`ListShow` for `API.LIST.SHOW`), but no `templates.js`. Templates only land in state via the Redux `TEMPLATE.CREATE/IMPORT/SAVE` actions described in [Action payloads](#canonical-action-payloads-from-tropysrcactionslistontologyjs) below.

## Template payload shape

> Verified 2026-05-09 against `tropy/src/ontology/template.js` + `tropy/src/ontology/ns.js` + `tropy/src/constants/ontology.js` + `tropy/src/reducers/ontology.js` + `tropy/src/sagas/ontology.js`. Closes seeds `tropy-plugin-733b`. Mulch: `mx-75e138` (updated), `mx-d00765` (updated), `mx-c6baf2`, `mx-9104a8`.

### `Template.defaults` (runtime object — `tropy/src/ontology/template.js:8-16`)

| Field | Type | Required | Default | Semantics |
|---|---|---|---|---|
| `id` | string (URI) | required for storage; minted by `Template.identify()` if omitted (template.js:18-20) | — | Map key in `state.ontology.template`; CRDT identity |
| `type` | string (URI) | required | `tropy.Item` (= `https://tropy.org/v1/tropy#Item`) | Which Tropy entity class the template applies to. Other valid values: `tropy.Photo`, `tropy.Selection` (`tropy/src/ontology/ns.js:19`, used by `getItemTemplates`/`getPhotoTemplates`/`getSelectionTemplates` selectors) |
| `name` | string | required | `''` | Human-readable label |
| `creator` | string | optional | `''` | Free-form author |
| `description` | string | optional | `''` | Free-form description |
| `created` | timestamp | optional | `undefined` | Stripped on `Template.copy` (template.js:33) |
| `isProtected` | boolean | optional | `false` | Protected templates cannot be edited in Tropy's UI. Always reset to `false` by `Template.copy` |
| `fields` | `Field[]` | required | `[]` | Ordered field schema |

### Fields NOT in `Template.defaults` but preserved via parse + reducer

| Field | Type | Source | Why it survives |
|---|---|---|---|
| `version` | string (user-managed) | `Template.parse` (template.js:54) writes it into JSON-LD; reducer spread-merge (reducers/ontology.js:94-99) preserves it | Round-trips through import/export but no version-bump semantics |
| `domain` | string (URI, RDF domain) | `Template.parse` (template.js:55) writes it; reducer spread-merges | Indicates which RDF class(es) the template applies to. Distinct from `type` — `type` is Tropy's entity class (Item/Photo/Selection); `domain` is a free-form RDF URI |

**Reducer behavior (reducers/ontology.js:90-104):** `TEMPLATE.CREATE`, `TEMPLATE.IMPORT`, `TEMPLATE.LOAD` all execute `{...state, ...payload}` — pure spread-merge on the keyed payload. **No field validation, no field whitelisting.** Any extra fields a peer sends will be persisted to state untouched. Conversely, missing optional fields stay missing — no defaults injected at the reducer.

### `Field.defaults` (`tropy/src/ontology/template.js:67-75`)

| Field | Type | Required | Default | Semantics |
|---|---|---|---|---|
| `id` | int (synthetic, decrementing counter from `-1`) | minted by `Field.identify()` (template.js:77-78, 92) | — | **NOT stable across peers** — local synthetic ID. CRDT push MUST key by `property` URI, not `id` |
| `property` | string (URI) | required | `''` | RDF property URI; key into `state.ontology.props` |
| `label` | string | required | `''` | Display label (overrides vocab label) |
| `datatype` | string (URI) | required | `TYPE.TEXT` | RDF datatype URI from `tropy/src/constants/type.js` |
| `hint` | string | optional | `''` | UI placeholder |
| `isConstant` | boolean | optional | `false` | Field cannot be edited per-item |
| `isRequired` | boolean | optional | `false` | Item validation flag |
| `value` | string | optional | `''` | Default value populated when applied to a new item |

troparcel's CRDT-schema field set (`crdt-schema.js setTemplateSchema`) declares `property, label, datatype, isRequired, isConstant, hint, value` — matches `Field.defaults` exactly minus `id` (which is correctly excluded as non-stable). No drift.

### Action constants and dispatch shape

| Action constant | String | Payload | meta |
|---|---|---|---|
| `ONTOLOGY.TEMPLATE.CREATE` | `'ontology.template.create'` | `{[uri]: templateObj}` (multiple templates per action allowed) | `{cmd: 'ontology', history: 'add'}` |
| `ONTOLOGY.TEMPLATE.SAVE` | `'ontology.template.save'` | `{id, ...patch}` (partial update merged via reducer `update`) | `{cmd: 'ontology', history: 'add'}` |
| `ONTOLOGY.TEMPLATE.DELETE` | `'ontology.template.delete'` | `uri \| uri[]` | `{cmd: 'ontology', history: 'add'}` |
| `ONTOLOGY.TEMPLATE.IMPORT` | `'ontology.template.import'` | `{files, isProtected}` → saga loads + dispatches CREATE | `{cmd: 'ontology', history: 'add'}` |
| `ONTOLOGY.TEMPLATE.CONTEXT` | (constant) | `'https://tropy.org/v1/contexts/template.jsonld'` | (JSON-LD context URI for `Template.parse`) |

(Source: `tropy/src/constants/ontology.js:21-37` + `tropy/src/sagas/ontology.js:302,365,404` (`TemplateImport.register`, `TemplateCreate.register`, `TemplateSave.register`).)

The full V5 apply payload should be:
```js
store.dispatch({
  type: 'ontology.template.create',
  payload: {
    [uri]: {
      id: uri,
      type,            // tropy.Item | tropy.Photo | tropy.Selection
      name,
      creator,
      description,
      version,         // optional — pass-through
      domain,          // optional — pass-through, V5 must add this
      isProtected,     // boolean — V5 must add this
      fields: [...]    // ordered, no `id` field
    }
  },
  meta: { cmd: 'ontology', history: 'add', done: true }
})
```

Note `meta.done: true` — the reducer guards every case on `meta.done && !error` (reducers/ontology.js:94-103). Apply path must mark `done: true` because we are bypassing the saga's command pipeline.

### `Template.parse` JSON-LD wire form (template.js:47-60)

Used only by `Template.save`/`Template.open` for disk export/import — NOT used by the in-memory state path. Documented here for completeness:

```js
{
  '@context': 'https://tropy.org/v1/contexts/template.jsonld',
  '@id': data.id,
  '@type': tropy.Template,           // 'https://tropy.org/v1/tropy#Template'
  type, name, version, domain, creator, description,
  field: [...]                       // singular 'field' (JSON-LD), not 'fields'
}
```

### Drift correction (mx-d00765 v2)

Earlier mulch record claimed both `isProtected` and `domain` are in `Template.defaults`. Verified incorrect:
- `isProtected` IS in `Template.defaults` (default `false`) — confirmed.
- `domain` is NOT in `Template.defaults` — appears only in `Template.parse` output (template.js:55) and is preserved via reducer spread-merge.
- `version` is NOT in `Template.defaults` either — same status as `domain`.

| Field | In `Template.defaults` | In `Template.parse` | In troparcel CRDT | Action required |
|---|---|---|---|---|
| `isProtected` | ✅ `false` | ❌ (intentionally stripped) | ❌ | **Add to V5 schema** — boolean, default `false` |
| `domain` | ❌ | ✅ | ❌ | **Add to V5 schema** — string URI, optional |
| `version` | ❌ | ✅ | ✅ | Already tracked in CRDT; verify round-trip through push + apply |

The fix is still scoped as P0 in `risk-map.md` (forward-compat, zero migration cost).

## URI strategy

> Decision: **PRESERVE external URIs**, never re-mint. Mulch: `mx-c6baf2` (updated to make CRDT correctness rationale load-bearing).

**Decision:** When applying a remote template whose `@id` URI does NOT match the canonical `https://tropy.org/v1/templates/id#<random>` pattern, troparcel's `applyTemplates` MUST preserve the remote URI verbatim. Do NOT call `Template.identify()` to re-mint a canonical URI.

**Rationale (load-bearing — CRDT correctness, not cosmetic):**

1. **Tropy does not validate URI prefixes.** Verified 2026-05-09 by `grep -rn "tropy.org/v1/templates/id" tropy/src/` — only one match: the `Template.identify()` definition itself (template.js:19). No call site validates inbound URIs against the prefix; reducers spread-merge any URI key without inspection (reducers/ontology.js:90-104). Round-trip through `Template.parse`/`Template.save` preserves arbitrary `@id` values.

2. **Re-minting breaks CRDT identity.** If peer B re-mints peer A's template URI on apply, the next push from A creates a duplicate (URI mismatch → LWW treats them as separate templates). The CRDT's `schema` Y.Map is keyed by URI; URI stability across peers is the identity contract. Re-minting silently corrupts the contract.

3. **`Template.identify()` is for new local creation only.** `tropy/src/ontology/template.js:18-20` mints a UUID-suffixed URI under the canonical namespace. troparcel uses this only when an `applyTemplates` payload arrives without an `@id` (which should never happen for synced templates) or when a local creation handler needs a fresh URI.

**Implementation:** `applyTemplates` reads each entry's URI from the CRDT Y.Map key (the `forEach` iterator's second argument) and uses it directly as both `payload[uri].id` and the outer payload key. No URI rewriting, no validation against the canonical prefix, no warning when the prefix differs.

## Canonical action payloads (from `tropy/src/actions/{list,ontology}.js`)

Cross-reference against existing mulch records:

| Action type (constants) | Payload shape | meta | Mulch record |
|---|---|---|---|
| `LIST.CREATE` (`'list.create'`) | `{name, parent}` (no `id` — DB-assigned) — also accepts `position` | `{cmd: 'project', history: 'add'}` | `mx-92978e` ✅ accurate |
| `LIST.SAVE` (`'list.save'`) | `{id, name, parent}` | `{cmd: 'project', history: 'add'}` | not yet recorded |
| `LIST.MOVE` (`'list.move'`) | `{id, parent, ...}` | `{cmd: 'project', history: 'add'}` | not yet recorded — needed for V6 reparenting |
| `LIST.DELETE` | `{id}` | `{cmd: 'project', history: 'add'}` | not yet recorded |
| `TEMPLATE.CREATE` (`'ontology.template.create'`) | `{[uri]: {id, name, type, creator, description, fields, version, domain, isProtected}}` | `{cmd: 'ontology', history: 'add', done: true}` | `mx-75e138` (updated) |
| `TEMPLATE.SAVE` (`'ontology.template.save'`) | `{id, ...patch}` | `{cmd: 'ontology', history: 'add', done: true}` | not yet recorded |
| `TEMPLATE.DELETE` (`'ontology.template.delete'`) | `uri \| uri[]` | `{cmd: 'ontology', history: 'add', done: true}` | not yet recorded — needed for tombstone apply |

`actions.list.save(payload)` automatically routes to `LIST.SAVE` when `payload.id != null` and `LIST.CREATE` otherwise — see `tropy/src/actions/list.js:38-44`. troparcel's apply path that uses state-diff to discover the new local id (per `mx-92978e`) is exactly the right pattern for `LIST.CREATE` because Tropy doesn't return the id in the dispatched action — it lands in state via the saga.

## Constants to import or mirror

`tropy/src/constants/{list,ontology}.js` define every action-type string. troparcel currently hardcodes them (e.g., `'list.create'`, `'ontology.template.create'`). Two reconciliation paths:
- **Mirror** the constants in troparcel as a local `constants.js` with evidence-file pointers to tropy/src/constants/*.js
- **Import** at runtime — only viable if the bundled plugin can `require('tropy/...')` once Tropy has loaded, which is non-obvious from the plugin spec

The mirror approach is safer; pair with the tropy-plugin-b4eb seeds task ("Action-type strings → constants/* references").

## Related canonical docs

- [docs/plans/v5.md](../../plans/v5.md) — execution plan
- [docs/design/slices.md §V5](../../design/slices.md) — affordances, status, demo criterion
- [docs/SHAPING.md §Selected Shape](../../SHAPING.md) — Full Project Sync = V5 + V6 + V7
- [docs/design/crdt-design.md](../../design/crdt-design.md) — Template = LWW
