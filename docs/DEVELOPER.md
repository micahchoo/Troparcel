# Troparcel developer guide

How Troparcel is built, the rules the code depends on, and how to test a change. For what users see, read the [README](../README.md) and the [Group Guide](GUIDE.md); for merge rules, [CONFLICTS.md](CONFLICTS.md).

## The shape of it

```
Tropy project window                       the room (a Yjs doc)
┌──────────────────────┐                  ┌──────────────────────┐
│ Redux store          │                  │ items, tags, notes,  │
│   getState/dispatch  │                  │ metadata, … (v5)     │
└─────────▲────────────┘                  └──────────▲───────────┘
          │ the only module that knows Tropy         │ crdt-schema.js
   store-adapter.js                                   │
          │                                           │
          └──── sync-engine.js ── push.js / apply.js ─┘
                     │
               adapters/  ── websocket.js (Troparcel server)
                          └─ file.js      (shared folder)
```

A cycle **applies** the room's changes to Tropy, then **pushes** Tropy's changes to the room. Triggers: a local change (`store.subscribe`, debounced), a remote change (doc observers, debounced) and a periodic safety net. One mutex serialises cycles.

| Module | Job |
|---|---|
| `plugin.js` | Tropy's plugin class: options, waiting for the project, the Export/Import hooks, retry on connection errors |
| `connection-string.js` | `troparcel://ws|wss|file/…` strings, both ways |
| `sync-engine.js` | Lifecycle, cycles, matching room items to local ones, backups before apply |
| `push.js` | Tropy → room (mixed into SyncEngine) |
| `apply.js` | Room → Tropy (mixed into SyncEngine), including attribution |
| `store-adapter.js` | Every read of Tropy's state and every action dispatched |
| `tropy-action-types.js` | The action-type literals, copied from Tropy |
| `crdt-schema.js` | The room's layout (schema 5) and v4 migration |
| `purge.js` | Tombstone purge; shared with the server |
| `project-room.js` | Project rooms: record each item, upload its photos, import the items a member lacks |
| `local-only.js` | What Troparcel writes for the owner only, and never pushes |
| `vault.js` | Per-user state on disk: id ↔ UUID maps, merge bases, what was applied |
| `identity.js` | Item identity from photo checksums; UUIDs |
| `backup.js` | JSON snapshot before apply; inbound size validation |
| `sanitize.js`, `normalize-on-push.js` | Note HTML in and out |
| `adapters/` | Transports: `websocket.js`, `file.js`, and `index.js` to choose |
| `server/index.js` | y-websocket relay, LevelDB storage, auth, monitor, compaction |

## Rules the code depends on

### Only `store-adapter.js` talks to Tropy

Tropy offers plugins no API that changes a project. Troparcel uses the project window's Redux store, which is internal and can change in any release. So every state shape it reads and every action it dispatches is in `store-adapter.js`, and every write follows three rules:

1. **It is a command:** `meta.cmd` set, `meta.done` unset. Tropy's command saga runs only then (`src/sagas/cmd.js`), and only the command writes the database.
2. **It has no `meta.history`.** A collaborator's change is not the owner's to undo.
3. **It resolves when its effect is visible in the store** (`_command(action, effect)`), and rejects when the command ends without it or after 15 seconds.

`probe()` checks the state's shape at start. If it fails, the engine does not start and nothing is written.

### The room has no nested shared types

When two peers set the same key at the same moment, Yjs keeps one value. If that value is a nested `Y.Map`, the other peer's map is lost with everything inside it. Schema 4 nested a map per item and per section and lost one peer's annotations whenever two peers first wrote the same item before syncing (200 of 200 runs). Schema 5 makes every section top-level, keyed `<identity>|<key>`. **Never store a Y.Map, Y.Array or Y.Doc as a value in the room.** `test/index.test.js` › "concurrent first writes" holds this.

### Never push what is local-only

`@name` tags, the received list and the `troparcel.org/ns/` fields are made on apply. `push.js` asks `local-only.js` before writing anything to the room.

### Tropy internals that have bitten

Every one of these was a shipped defect. Each was checked against Tropy's source.

- **A command runs only when `meta.done` is unset.** An action with `done: true` reaches the reducer only: the change shows in the window and is never written to the database.
- **Payloads are the action creators' shapes.** `metadata.save` takes `{ ids: [...], data }`. `tag.create` asserts a `name` and takes `items`; it assigns its own id. Copy the shape from Tropy's `src/actions/*.js` or `src/slices/*.js`.
- **`note.create` selects the new note**, which moves the owner's view. `createNote` puts `nav` back afterwards.
- **`history.tick` with an empty payload crashes Tropy's history reducer** (`canMerge` reads `undo.type`). There is no way to group a cycle into one undo entry; send no history instead.
- **`dialog.notify` is a modal** that looks up `dialog.notify.<key>` in Tropy's strings. A plugin cannot add strings, so it shows an empty dialog. `dialog.info` and `dialog.warning` do not exist.
- **A deleted selection stays in `state.selections`.** Tropy's selections reducer has no delete case; only the photo's `selections` list loses it. Ask the parent list, as `getSelection` and `getTranscription` do.
- **`item.import` with `payload.data` takes Tropy's JSON-LD export** and trusts it: each photo's checksum, mimetype and size come from the JSON, not the file, and no duplicate check runs. `project-room.js` writes full IRIs, so no context is needed. The import also resets the view mode and search (`nav.update`); `importItems` puts them back.
- **Tropy's import form is parsed with `qs`**, which turns more than 20 repeated `file` keys into an object; the import then fails inside Tropy. Send 20 at a time.
- **Tag colours are preset names** (`red`, `green`, …), not hex values.
- **The photo checksum is the MD5 of the stored file**, computed after any conversion at import.
- **Templates are read raw** from `state.ontology.template`, not through `getAllTemplates`, which resolves and flattens them.
- **Lists load after the project opens.** Do not require the root list (id 0) at start.
- **A fresh data folder seeds its ontology after the project opens.** An import before the default template exists fails inside Tropy.

## Tests

| Command | What runs | Needs |
|---|---|---|
| `npm test` | Unit tests (`test/index.test.js`), scenarios (`test/scenarios/`), integration (`test/integration/`: a real server, a real shared folder) | Node 24 |
| `TROPY_SRC=<checkout> npm test` | Also `tropy-drift.test.js`: every mirrored action type against Tropy's source | A Tropy checkout |
| `npm run e2e` | Two real Tropy instances and a third synthetic peer, end to end | Flatpak Tropy, `xvfb-run`, `dbus-run-session` |

The scenario tests run real `SyncEngine`s over **fake Tropy stores** (`test/harness/fake-tropy.js`) joined by an in-memory relay (`test/harness/engine.js`). The fake enforces the Tropy rules above: a wrong payload throws, `done: true` changes nothing, history adds undo entries, `note.create` moves `nav`. A test that dispatches a bad action fails here before it can fail in Tropy. When you learn something new about Tropy, encode it in the fake and add the e2e check that proves it.

The e2e harness (`test/e2e/harness.js`) never touches your own Tropy: each instance gets its own `--data` folder under `.e2e/`, runs on Xvfb with Wayland disabled, and is killed by process group when the test ends. Logs and projects stay in `.e2e/<run>/` for inspection.

CI (`.github/workflows/test.yml`) runs `npm test` against Tropy 1.17.3 and `main`.

## Adding a kind of data

1. **Room:** a top-level section in `crdt-schema.js`, keyed `<identity>|<key>`, with set/get/remove functions. Plain JSON values only.
2. **Tropy:** the reads and the write in `store-adapter.js`. Find the action creator in Tropy's source; add its type to `tropy-action-types.js` and to `tropy-drift.test.js`; add its rules to `fake-tropy.js`.
3. **Push** in `push.js` and **apply** in `apply.js`. Decide what a concurrent change means (CONFLICTS.md) and whether the vault needs a base.
4. **Test:** a scenario in `test/scenarios/sync.test.js` (two engines), then a check in `test/e2e/sync.e2e.js`.

## Building and releasing

`npm run build` bundles `src/plugin.js` and its dependencies into `index.js` (esbuild, CommonJS, Node target). `npm run pack` makes `troparcel.zip` with `package.json`, `index.js` and `icon.svg`, the three files Tropy needs.

The server image builds from the repository root, because it shares `src/purge.js` and `src/connection-string.js`: `docker compose build`.

Bump `version` in `package.json` and add a `CHANGELOG.md` entry. A change to the room layout is a new schema version: bump `SCHEMA_VERSION` in `crdt-schema.js`, write a migration from the previous layout, and say in the changelog that a group must upgrade together.
