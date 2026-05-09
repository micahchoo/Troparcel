# Contracts from Tropy's Test Suite

Survey of `tropy/test/` (48 files, ~3,840 LOC) for executable contracts that
troparcel relies on, can leverage, or should mirror.

**Snapshot caveat.** Every contract below is one tropy revision away from
changing. This doc reflects tropy's test suite as it exists on disk on
2026-05-08 (per directory mtimes), not a stable upstream API. Tropy is a
brownfield reference clone — there is no upstream changelog watch in this
workspace, so all "contract" claims are point-in-time. If tropy is re-pulled,
re-survey the affected file.

**Coverage gaps in upstream itself.** Three load-bearing zones for troparcel
have **no upstream test coverage at all**:

| Missing test | Why it matters for troparcel |
|---|---|
| `reducers/lists.js` | LIST.SAVE / LIST.CREATE / LIST.MOVE behavior is the precise contract V5 `applyListHierarchy` dispatches into. Tropy upgrades could silently change spread-merge / parent-update invariants. |
| `reducers/ontology.js` | TEMPLATE.* spread-merge + meta.done gate (mx-9c9c7d, mx-8e3eb9) — same risk. |
| `selectors/ontology.js` | getAllTemplates property-resolution behavior (mx-34ef44). |
| `common/watch.js` | troparcel just adopted chokidar+awaitWriteFinish from this file (mx-67d331, mx-0fc4b0). The pattern troparcel mirrored has zero upstream regression coverage; only troparcel's tier2 smoke covers it anywhere. |

This is dual signal: (1) **leverage** — troparcel's V5 integration tests +
chokidar smoke are effectively the only regression net for these tropy
modules anywhere; (2) **risk** — silent upstream changes will not surface
through tropy's CI. See `Recommended uplifts` for the proposed mitigation.

Status legend: **honored** = troparcel already complies; **leverage** = new
exploitable contract; **uplift** = troparcel should mirror; **risk** = tropy
asserts X but troparcel currently does Y.

---

## Ontology

| Contract | Source test | troparcel impact | Status |
|---|---|---|---|
| Vocabulary export round-trips through N3 — `toN3(vocab, ontology)` produces a parseable string with quad counts matching input class/prop/datatype lists. | `tropy/test/ontology/vocabulary.test.js` | troparcel does NOT export vocabularies (V5/V6 scope is templates + lists). Reference only — if a future slice exports vocabs, this is the canonical round-trip test. | leverage |
| Ontology DB schema bootstraps with >10 vocabularies pre-loaded. | `tropy/test/models/ontology.test.js` | Confirms the on-disk ontology.db has a non-empty vocabularies table — relevant if troparcel ever queries the ontology DB directly (currently it doesn't; it reads `state.ontology.props` via the adapter per mx-34ef44). | reference |
| **No upstream test for `selectors/ontology.js getAllTemplates`** — the resolved-vs-raw URI distinction (mx-34ef44) is asserted only in mulch. | (gap) | troparcel's V5 push depends on raw URIs from `state.ontology.template`, NOT the resolved selector output. If tropy refactors getAllTemplates, no upstream test will catch it. | risk |

## Models

| Contract | Source test | troparcel impact | Status |
|---|---|---|---|
| `models/ontology.create(db)` bootstraps the vocabularies table. Async, returns void. | `tropy/test/models/ontology.test.js` | Reference for any future "rebuild ontology DB from CRDT" troparcel work. | reference |
| **No upstream test for `models/list.js`, `models/value.js`, `models/metadata.js`, `models/photo.js`, `models/item.js`.** | (gap) | The metadata-value contract (mx-f6e639) and list SQLite shape (mx-9104a8) are asserted only in mulch. troparcel's metadata push (push.js normalize-on-push, mx-be0280) is the only end-to-end check that the value/metadata schema still matches. | risk |

## Selectors

| Contract | Source test | troparcel impact | Status |
|---|---|---|---|
| `lists` state map keys are integer ids (or numeric-string-coercible). Each list is `{id, name, parent, children[]}`. ROOT is id=0 with `children[]`. Subtree traversal respects `state.sidebar.expand` map. | `tropy/test/selectors/lists.test.js` + `tropy/test/fixtures/state/lists.js` | **Confirms mx-06743c / mx-780c7d / mx-2a349c with concrete shape.** Adapter `readLists()` and apply-side list-creation can take this as gospel. Note also: the `lists.js` fixture uses non-integer keys `root` and `empty` for fixture readability — not normative. | honored |
| `getItemMetadata(state)` returns `{id: [...], property: {text, mixed}}` where `mixed: true` when items disagree on a value, `mixed: false` when uniform. Empty selection → `{id: []}`. Missing-from-state items → ids only, no property fields. | `tropy/test/selectors/metadata.test.js` | **New leverage** — troparcel could surface "this metadata field has divergent values across peers" UX directly using this shape. Currently troparcel has no UI for cross-peer metadata divergence. Filed as seed (wave:6). | leverage / uplift |
| `getExportItems(state, {id})` → `{@context, @graph, version}` where `@graph[i].tag` is tag NAMES (not ids), `.list` is list-PATHS like `'A list apart/A\\/B'` (slashes in names escaped with `\\`), photos are nested with their own metadata. | `tropy/test/selectors/export.test.js` + `tropy/test/fixtures/export.js` | **New leverage** — when troparcel pushes structured item data, it currently builds custom JSON. The export selector + JSON-LD `@context` already produces a canonical, vocab-prefixed form — adopting this format for the CRDT wire would make remote peers interpret URIs uniformly. Lower priority (not blocking anything). | leverage |
| `getExportItemIds` precedence: explicit `{id:[...]}` > `state.nav.items` > `state.qr.items`. | `tropy/test/selectors/export.test.js` | Reference — confirms `state.nav.items` and `state.qr.items` are the visible selection sources. | reference |
| Tag selector returns `{name, color}` with `color` as a string preset name (`'green'`, `'lavender'`, ...). | `tropy/test/fixtures/state/tags.js` | **Confirms tag.color is a fixed-vocabulary string**, not a hex/rgba. troparcel's `pushTags` already preserves `color` verbatim (push.js); receiver should validate against tropy's preset list to avoid arbitrary strings landing in state. (Tropy's preset list lives in tropy code outside `test/`; not enumerated here.) | honored / minor uplift |
| Photo state shape: `{id, item, selections[], notes[], transcriptions[], template, path, mimetype, checksum, width, height, page, size, orientation, density, brightness, contrast, hue, saturation, sharpen, angle, mirror, negative, color, protocol, created, modified}`. `protocol` is e.g. `'fixture'` / `'file'`. | `tropy/test/fixtures/state/photos.js` | Reference — none of these are CRDT-pushed currently (V5 stops at templates+lists), but useful for future photo-attribute sync. `color` is a derived dominant-color string `'rgb(...)'`. | reference |
| Selection state shape: `{id, photo, x, y, width, height, angle, brightness, contrast, hue, saturation, sharpen, template, mirror, negative, notes[], transcriptions[]}`. | `tropy/test/fixtures/state/selections.js` | Reference for V6+ if selections gain CRDT attribute sync. | reference |

## Editor / Notes

| Contract | Source test | troparcel impact | Status |
|---|---|---|---|
| `fromHTML('<p>Test</p>')` → ProseMirror state with `doc.type='doc'`, `content[0].type='paragraph'`, text node with `.text`. | `tropy/test/editor/serialize.test.js` | Confirms troparcel's note pipeline can rely on the doc.content[].type round-trip. Already honored implicitly via SAFE_TAGS (mx-a3caef / mx-f3a517). | honored |
| Note `state.doc` shape: `{type:'doc', content:[{type:'paragraph', attrs:{align:'left'}, content:[{type:'text', text:'...'}]}]}` plus `state.selection: {type:'text', anchor, head}`. | `tropy/test/fixtures/state/notes.js` | **Confirms `state.selection` is persisted with anchor/head positions**. troparcel's note-apply path drops selection state (rebuild-on-load is fine for the writing peer; receiving peer's cursor is undefined). Verify: troparcel does not need to round-trip selection — this is per-window UI state, not document content. | honored (deliberate drop) |
| Note paragraph `attrs.align` is persisted (default `'left'`). | `tropy/test/fixtures/state/notes.js` | Per-paragraph alignment is part of the document model. SAFE_TAGS handling needs to preserve `align` attr on `<p>` if it's serialized to HTML. **Verify.** | needs-uplift (verify) |
| Link mark shape: `{type:'link', attrs:{href}}` applied via `addMark(from, to, schema.marks.link.create({href}))`. | `tropy/test/fixtures/editor.js` + `tropy/test/editor/commands.test.js` | Confirms link is a mark, not a node — so `<a>` tags must round-trip in HTML serialize/parse with `href` attr preserved. Check SAFE_TAGS (mx-f3a517). | honored / verify |
| `markExtend(selection, mark)` extends a selection to the full range of a contiguous mark. | `tropy/test/editor/commands.test.js` | Pure UI utility — no troparcel impact. | reference |

## Reducers / Actions

| Contract | Source test | troparcel impact | Status |
|---|---|---|---|
| **`LIST.ITEM.ADD` and `LIST.ITEM.REMOVE` BOTH require `meta.done:true`.** Without it, the reducer returns the state by reference equality (skip). | `tropy/test/reducers/items.test.js` | **Generalizes mx-9c9c7d (template) to all `*.ADD/REMOVE` action families.** If troparcel ever applies item-list-membership remotely (V6 candidate), it MUST set `meta.done:true` exactly as for templates. Filed new mulch convention. | new-leverage |
| Items reducer mutates `state[itemId].lists` in place semantically (returns new state with new entry). Pre-existing list memberships are preserved on add. | `tropy/test/reducers/items.test.js` | Reference — confirms list-membership is bidirectional (`item.lists[]` ↔ `list.children[]` for items). | reference |
| `nested.add(key, state, payload, meta)` helper supports: single-id `{id, [key]: [vals]}`, multi-id `{id: [ids], [key]: [vals]}`, and `meta.idx` for positional insertion. `nested.remove` symmetric. | `tropy/test/reducers/util.test.js` | **Pattern troparcel could mirror** in the apply path for any list-membership operation. Currently troparcel reaches into state via `_getState` and does ad-hoc array manipulation — using this helper would match upstream semantics. | uplift (low priority) |
| Multiple items per `LIST.ITEM.ADD/REMOVE` payload supported via `payload.items: [ids]`. | `tropy/test/reducers/items.test.js` | Confirms batched membership operations are first-class. troparcel apply could batch when receiving multiple item-list-membership changes. | reference |
| **No upstream test for `reducers/lists.js`** (LIST.SAVE / LIST.CREATE / LIST.MOVE / LIST.DELETE / LIST.RESTORE). | (gap) | troparcel V5 `applyListHierarchy` dispatches LIST.CREATE + LIST.SAVE per mx-61bbc8 / mx-92978e. **No upstream regression net.** Filed seed. | risk |
| **No upstream test for `reducers/ontology.js`** (TEMPLATE.CREATE / SAVE / DELETE / IMPORT / FIELD.*). | (gap) | troparcel V5 `applyTemplates` dispatches TEMPLATE.CREATE per mx-57bcbc with meta.done:true (mx-9c9c7d). **No upstream regression net.** Filed seed. | risk |

## Common Utilities

| Contract | Source test | troparcel impact | Status |
|---|---|---|---|
| `util.merge` is a deep, recursive object merge. `null`/`undefined` overwrite. Date objects clone (not reference). Arrays REPLACE (not merge). | `tropy/test/common/util.test.js` | Reference — if troparcel ever needs to merge nested config, prefer this pattern (or import the helper directly via require — already in bundle). | reference |
| `util.uniq([])` preserves insertion order. `util.mixed([1,1,2])` returns true if any element differs. | `tropy/test/common/util.test.js` | `util.mixed` is **the same predicate** that powers `getItemMetadata`'s `.mixed` flag — confirms the contract end-to-end. | leverage |
| `util.move(arr, from, to, offset)` and `util.swap` for ordered list manipulation. | `tropy/test/common/util.test.js` | Reference for V6 list-reorder push/apply. | reference |
| `util.throttle(fn, ms)` exposes `.cancel()` and `.flush()`. Cancel suppresses trailing call; flush forces it immediately. | `tropy/test/common/util.test.js` | troparcel's debounced push (sync-engine handleLocalChange path) could expose flush() for "force-sync-now" UX. Currently uses bare setTimeout. | leverage / minor uplift |
| `Migration` parses `path/<num>.<name>.<js|sql>` → `{number, type}`. `.fresh(n)` returns true if migration > n. | `tropy/test/common/migration.test.js` | Reference if troparcel ever versions its vault file via numbered migrations (currently uses inline `version` field per the troparcel-vault-version rule). | reference |
| **Plugins.context object** spread into every plugin instance plus a child logger. `available(hook)` lists plugins implementing that hook. `exec(...)` returns the hook's return value. `init()` loads spec, `reload()` re-scans, `create()` instantiates. | `tropy/test/common/plugins.test.js` | Confirms the plugin context surface (mx-864ee7) — only enumerable members of the renderer-side `{dialog, json, sharp, window}` plus injected logger. **No `store`, no action constants, no ipcRenderer.** | honored |
| `Plugins.spec[name].hooks` enumerates which hook methods the plugin class defines (`'export': true/false`). | `tropy/test/common/plugins.test.js` | Tropy decides whether to invoke a plugin based on whether its class exports the hook method. troparcel registers `export()`, `import()`, `connect()`, etc. — confirm class shape matches. | honored |
| `Storage(folder).load(name, {defaults, secure})` decrypts via Electron `safeStorage` if `secure:true`. Returns `defaults` if `safeStorage.isEncryptionAvailable()` returns false. `Storage(folder).save(name, obj, {secure})` writes encrypted. | `tropy/test/main/storage.test.js` | **New leverage** — troparcel's SyncVault currently writes plaintext JSON to `~/.troparcel/vault/`. The vault contains room/user mappings; not secret per se, but if WS auth tokens land here in future they'd need encryption. **Pattern available without bundling extra deps**. Filed seed (P3). | uplift |
| `common/project create(path, schema, appDir, opts)` rejects unknown extensions, refuses to overwrite existing files (file or dir), creates SQLite + (for `.tropy` managed) creates an `assets/` dir. `load(db)` returns `{name, base, store, isManaged, project_id}`. `pstat(path)` stats a project. | `tropy/test/common/project.test.js` | Confirms the dual project format (`.tpy` flat-file vs `.tropy` managed-folder). troparcel's `getProjectInfo()` on the api returns `{project: <path>}` — verify it's the `.tpy` file, not the `.tropy` directory, when chokidar watches. | honored / verify |
| `Database` from `common/db.js` exposes `db.get(sql)` / `db.version()`. | `tropy/test/common/migration.test.js` + `tropy/test/common/project.test.js` | Reference — troparcel does not access the DB directly (would violate StoreAdapter contract per `.claude/rules/troparcel-store-adapter-contract.md`). | reference (do-not-use) |
| `common/fs.ls(root, {recursive, filter})` async lists directory entries with optional filter `({name})`. | `tropy/test/common/fs.test.js` | Reference if troparcel ever scans a directory (e.g. for vault recovery). | reference |
| **`Storage.save` with `safeStorage.isEncryptionAvailable() === false` AND `secure:true` → silently NO-OPs (file does not get written; ENOENT on access).** | `tropy/test/main/storage.test.js` | **Subtle gotcha worth a record.** If troparcel adopts safeStorage for the vault, must check return / availability — silent persistence loss is unacceptable. | risk-aware |

## Format / Display

| Contract | Source test | troparcel impact | Status |
|---|---|---|---|
| `format.datetime` falls back to input string for unparseable values (`'-300-'` → `'-300-'`, `null` → `null`, `''` → `''`). | `tropy/test/format.test.js` | Already in mx-768753 / mx-d8bf1f — display-only, never used in equality. | honored |
| `format.auto(value, type)` dispatches on TYPE; `format.auto(value)` (no type) returns input verbatim. | `tropy/test/format.test.js` | Confirms display-layer is type-aware but storage-layer is not (mx-5d504a). | honored |
| `format.bytes` returns null for non-numeric input (no throw). | `tropy/test/format.test.js` | UI-only; reference. | reference |

## Components / UI (lower priority)

| Contract | Source test | troparcel impact | Status |
|---|---|---|---|
| `TagAdder.matchFn(tag, query)` matches from start of words after punctuation/whitespace boundaries (`.`, `_`, `-`, `:`, `(`, `&`, ` `, ...). Case-insensitive. Unicode/emoji safe. | `tropy/test/components/tag/adder.test.js` | UI autocomplete — no troparcel sync surface. | reference |

## Test-fixture patterns (for FakeStoreAdapter mirror)

The `globalThis.F` global (set up by `tropy/test/support/fixtures.js`) exposes:

- `F.state` → fresh-`require`'d canonical state shape (lazy getter).
- `F.require('editor')` / `F.require('export')` → fixture modules.
- `F.image.path(name)`, `F.image.url(name)` → image fixture access.
- `F.schema(name='project')` → path to schema SQL file.

The state fixture (`tropy/test/fixtures/state/index.js`) is the canonical
shape for `{items, lists, metadata, notes, ontology, photos, projects,
selections, tags, transcriptions}`. troparcel's `FakeStoreAdapter`
(`troparcel/test/fixtures/fake-adapter.js`) currently builds state ad-hoc per
test. **A canonical `defaultState` derived from the tropy fixture would make
adapter-level assertions transferable.**

The `mkprojtmp(name, opts)` helper (`tropy/test/support/project.js`) creates
a real SQLite project file in a tmpdir per `beforeEach`, with auto-cleanup
in `afterEach`. Pattern troparcel could borrow if it needs end-to-end tests
against a real Tropy project file (currently all troparcel tests use
FakeStoreAdapter — a real-project test would be a new tier).

The babel hook for renderer-side React components (`tropy/test/support/babel.js`)
transforms only the test files matching `src/{components,views,hooks}/**/*.js`
+ `test/components/**/*.js` + `test/support/react.js`. troparcel currently
has no React components — not applicable yet.

---

## Recommended uplifts (ranked by leverage)

1. **(P2) Snapshot tropy reducer behavior in troparcel CI.** No upstream test
   covers `reducers/lists.js`, `reducers/ontology.js`. troparcel's V5 push +
   apply are the ONLY regression net for the LIST.* / TEMPLATE.* spread-merge
   + meta.done invariants. Add tier 2/3 tests that import the actual tropy
   reducer and assert: (a) LIST.CREATE without meta.done is no-op; (b)
   LIST.SAVE updates parent's children[] correctly; (c) TEMPLATE.CREATE
   spread-merge preserves unknown payload fields verbatim (relevant for
   forward-compat). Catches breakage if upstream is re-pulled.

2. **(P2) Add chokidar/watch regression net.** Same gap in
   `common/watch.test.js`. troparcel's tier2 chokidar smoke (mx-?) is the
   only test of the awaitWriteFinish behavior anywhere. If upstream
   refactors the Watcher (e.g., switches awaitWriteFinish off, changes
   debounce defaults), nothing alerts us. Pin chokidar version in
   `package.json` (already done per mx-eb5334) AND add a tier2 assertion
   that the option set matches `tropy/src/common/watch.js` literal.

3. **(P3) Mirror tropy's state-fixture format in FakeStoreAdapter.** Build
   `troparcel/test/fixtures/state/` as a sibling of tropy's, exporting the
   same `{items, lists, metadata, ...}` modules, derived from tropy's
   shapes. Existing `FakeStoreAdapter.defaultState` becomes a thin wrapper
   that loads this fixture. Adapter contract assertions become more
   trustworthy because the shape is upstream-derived, not hand-rolled.
   **Honor the rule: do not modify tropy's fixtures; create a new
   `troparcel/test/fixtures/state/` namespace.**

4. **(P3) Generalize meta.done convention to LIST.ITEM.ADD/REMOVE.** Mulch
   record filed; if/when V6 syncs item-list-membership, apply path MUST set
   meta.done:true (and use the `nested.add/remove` helper or matching
   semantics). Verify in code review of any new V6 apply function.

5. **(P3) Surface "mixed" metadata indicator in troparcel UI.** tropy's
   `getItemMetadata` already returns `{mixed: true}` when peers diverge.
   troparcel could leverage this to show a per-field "divergent across
   peers" badge in the metadata panel — zero new logic needed. Useful for
   conflict awareness in collaborative editing.

6. **(P3) Encrypt SyncVault via Electron safeStorage.** Pattern from
   `tropy/main/storage.js`. SyncVault currently plaintext JSON; if WS auth
   tokens or other secrets ever land in the vault, encryption-at-rest is
   needed. Honor the gotcha: silent NO-OP when `safeStorage` unavailable —
   troparcel must check availability and either bail loudly or persist
   plaintext with explicit user opt-out.

7. **(P4) Verify ProseMirror `paragraph.attrs.align` round-trips through
   note sanitizer.** `tropy/test/fixtures/state/notes.js` confirms
   `align:'left'` is persisted at the paragraph level. SAFE_TAGS allows
   `<p>` but the alignment may be carried via inline style or attribute —
   verify it survives push → CRDT → apply.

8. **(P4) Adopt `util.throttle` flush() for "force-sync-now" UX.** Current
   debounced push uses bare setTimeout. `util.throttle` is already in the
   tropy bundle — using it would gain a free flush()/cancel() API for a
   future sync-now button.
