---
shaping: true
---

# Tropy — Design Spec (Reverse-Engineered from Test Suite)

## Frame

### Source
44 test files across 10 directories in `tropy/test/`, covering the common layer, main (Electron) process, React components, Redux selectors/reducers, rich-text editor, ontology model, and DOM/CSS/format utilities. Fixture data provides the canonical entity shapes.

### Problem
No design spec exists independent of the source code. The test suite is the closest thing to a behavioral contract. This document captures what the tests assert the system *must do*.

### Outcome
A single reference document mapping Tropy's behavioral contracts — entity model, architectural layers, component contracts, state management rules, and integration points — as revealed solely by the test suite.

---

## 1. Domain Model (from fixtures)

### Entity Relationship Diagram

```
Project (root)
 |-- Item --< Photo --< Selection
 |    |         |            |
 |    |         |-- Note     |-- Note
 |    |         +-- Transcription  +-- Transcription
 |    |--< Tag (M:N)
 |    +-- Metadata (keyed by RDF property URI)
 |-- List (tree: root -> children[])
 |-- Ontology
 |    +-- Vocabulary --< Class, Property, Datatype
 +-- Template (metadata schema)
```

### Entity Shapes

#### Item
```
{
  id: Number,
  lists: Number[],          // FK -> List.id
  photos: Number[],         // FK -> Photo.id
  tags: Number[],           // FK -> Tag.id
  template: URI,            // e.g. 'https://tropy.org/v1/templates/generic'
  created: Date,
  modified: Date,
  deleted: Boolean
}
```

#### Photo
```
{
  id: Number,
  item: Number,              // FK -> Item.id
  selections: Number[],      // FK -> Selection.id
  notes: Number[],           // FK -> Note.id
  transcriptions: Number[],  // FK -> Transcription.id
  template: URI,
  path: String,              // local filesystem path
  protocol: String,          // e.g. 'fixture'
  mimetype: String,          // e.g. 'image/jpeg'
  checksum: String,          // MD5/SHA hash for identity
  width: Number,
  height: Number,
  size: Number,              // bytes
  page: Number,
  orientation: Number,       // EXIF orientation
  angle: Number,             // user rotation
  mirror: Boolean,
  negative: Boolean,
  density: Number|null,
  brightness: Number,
  contrast: Number,
  hue: Number,
  saturation: Number,
  sharpen: Number,
  color: String,             // RGB string
  created: ISO8601,
  modified: ISO8601
}
```

#### Selection (spatial region on a Photo)
```
{
  id: Number,
  photo: Number,             // FK -> Photo.id
  notes: Number[],
  transcriptions: Number[],
  template: URI,
  x: Number, y: Number,     // origin
  width: Number, height: Number,
  angle: Number,
  mirror: Boolean,
  negative: Boolean,
  brightness: Number,
  contrast: Number,
  hue: Number,
  saturation: Number,
  sharpen: Number,
  created: ISO8601,
  modified: ISO8601
}
```

#### Note (ProseMirror document)
```
{
  id: Number,
  photo: Number,             // FK -> Photo.id
  selection: Number|null,    // FK -> Selection.id (null = whole photo)
  text: String,              // plain text extract
  language: String,          // e.g. 'en', 'de'
  state: {
    doc: ProseMirrorDoc,     // { type: 'doc', content: [{ type: 'paragraph', ... }] }
    selection: { type: 'text', anchor: Number, head: Number }
  },
  modified: ISO8601,
  deleted: Boolean
}
```

#### Tag
```
{
  id: Number,
  name: String,
  color: String,             // e.g. 'green', 'red', 'lavender'
  created: ISO8601,
  modified: ISO8601
}
```

#### Transcription
```
{
  id: Number,
  status: Number,            // -1 = error, 1 = success
  config: Object,            // { plugin: String } or { error: String }
  text: String,
  data: String               // raw format, e.g. '<alto/>'
}
```

#### Metadata (per-entity, keyed by RDF property URI)
```
{
  [entityId: Number]: {
    [propertyURI: String]: {
      type: URI,             // XSD datatype, e.g. 'xsd:string', 'xsd:integer'
      text: String|Number    // the value
    }
  }
}
```

#### List (tree structure)
```
{
  id: Number,
  name: String,
  children: Number[]         // FK -> List.id (root has id: 0)
}
```

#### Project
```
{
  id: UUID,
  name: String
}
```

#### Ontology / Vocabulary
```
Vocabulary: {
  id: URI,                   // e.g. 'http://purl.org/dc/elements/1.1/'
  prefix: String,            // e.g. 'dc', 'dcterms', 'tropy'
  classes: URI[],
  datatypes: URI[],
  properties: URI[]
}

Property: { id: URI, label: String, vocabulary: URI }
Class:    { id: URI, label: String, comment: String }
Datatype: { id: URI, comment: String }
```

---

## 2. Architecture Layers (from test directory structure)

### Layer Map

| Layer | Test Dir | Scope | Process |
|-------|----------|-------|---------|
| **Common** | `common/` | DB, FS, migration, plugins, projects, queries, releases, utilities | Both |
| **Main** | `main/` | App lifecycle, args, idle, locale, menus, resources, storage, window mgmt | Electron main |
| **Components** | `components/` | React UI: icons, toolbar, sidebar, panel, lists, photos, plugins, tags, items | Renderer |
| **Selectors** | `selectors/` | Redux read-side: export, lists, metadata, tags | Renderer |
| **Reducers** | `reducers/` | Redux write-side: items, nested helpers | Renderer |
| **Editor** | `editor/` | ProseMirror: mark commands, HTML serialization | Renderer |
| **Models** | `models/` | Ontology DB creation | Main |
| **Ontology** | `ontology/` | N3/Turtle vocabulary serialization | Both |
| **Utilities** | top-level | CSS cursors, DOM helpers, number/byte formatting, image loading, resource paths | Renderer |

---

## 3. Common Layer Contracts (10 tests)

### Database (`common/db_test.js`)
| Contract | Evidence |
|----------|----------|
| Connection pooling with bounded size | `pool.size` assertions, `db.busy` tracking |
| Disposable resource pattern | `using()` with guaranteed release on success and error |
| Four execution models | `exec` (one-shot), `seq` (sequential, no rollback), `transaction` (ACID), `migration` (ACID + FK check) |
| Prepared statement reuse | Statement runs in loop, 9 inserts verified |
| Integrity checking | FK violations detected (count reported), null violations detected |
| Concurrent read/write | 8 parallel reads, 6 parallel writes with proper isolation |
| Pragma configuration | `configure({busy_timeout})` maps to `PRAGMA` |

### Disposable (`common/disposable_test.js`)
| Contract | Evidence |
|----------|----------|
| `using()` requires disposable resource | Rejects non-disposable |
| Guaranteed cleanup on success | Disposes after handler returns |
| Guaranteed cleanup on throw | Disposes after sync error |
| Guaranteed cleanup on rejection | Disposes after async error |
| No dispose on acquisition failure | Resource promise rejection -> no dispose call |

### Filesystem (`common/fs_test.js`)
| Contract | Evidence |
|----------|----------|
| Recursive directory listing | `ls()` lists files recursively |

### Math (`common/math_test.js`)
| Contract | Evidence |
|----------|----------|
| Configurable precision rounding | `round()` accepts precision parameter |

### Migration (`common/migration_test.js`)
| Contract | Evidence |
|----------|----------|
| Version extracted from path | Constructor parses version from filesystem path |
| Type tracking | Migration type set at construction |
| Freshness check | `#fresh` true by default; true if `#number > given` |

### Plugins (`common/plugins_test.js`)
| Contract | Evidence |
|----------|----------|
| Config validation | Valid config matches expected shape |
| Hook scanning | Async scan for available hooks |
| Registered vs unknown hooks | `available()` distinguishes them |
| Plugin lifecycle | `create()`, `exec()`, `list()` -- all async |

### Project (`common/project_test.js`)
| Contract | Evidence |
|----------|----------|
| Multi-format support | `*.tpy` (file) and managed (folder + DB) |
| Validation | Rejects unknown extensions, existing files |
| Stat caching | `pstat()` returns null if not modified since given time |
| One-way conversion | `*.tpy -> *.tropy`; reverse throws; same-type throws |
| Comprehensive input validation on convert | No source, no target, bad paths all throw |

### Query Builder (`common/query_test.js`)
| Contract | Evidence |
|----------|----------|
| Full CRUD | Select, Update, Insert, Delete |
| Fluent API | Chaining: alias, distinct, scoped, sources, order, join, count |
| Null/undefined handling | Explicit handling in updates |
| Parameterized queries | `params` in selects |
| RETURNING clause | Supported on update, insert, delete |
| Sub-queries | Delete with sub-query |

### Release (`common/release_test.js`)
| Contract | Evidence |
|----------|----------|
| Channel naming | Valid channel names |
| Platform feed URLs | Include platform + architecture |

### Utilities (`common/util_test.js`)
| Contract | Evidence |
|----------|----------|
| Immutable operations | `pick`, `omit`, `set`, `merge`, `remove` return new objects |
| Promise-based events | `once()` resolves on event, rejects on error, cleans up |
| Deep object ops | `get`, `set` (1-3 levels), `has`, `merge` (deep) |
| Array manipulation | `move` (offset 0/1), `swap`, `adjacent`, `uniq`, `mixed`, `remove` |
| `flatten` | Flattens nested dictionaries |
| `strftime` | Subset of stdlib format specifiers |

---

## 4. Main Process Contracts (9 tests)

### App Initialization (`main/index_test.js`)
| Contract | Evidence |
|----------|----------|
| Sets app name from qualified product | `app.name === qualified.product` |
| Configures data paths | `app.setPath` called |
| Single instance lock | `app.requestSingleInstanceLock()` |
| Waits for OS ready | `app.on('ready', ...)` |
| Starts Tropy singleton | `Tropy.instance.start()` |
| Global error handling | Handlers for `uncaughtException` + `unhandledRejection` |

### CLI Args (`main/args_test.js`)
| Contract | Evidence |
|----------|----------|
| Env fallback | `parse([]).opts.env === process.env.NODE_ENV` |
| Explicit override | `--env development` |

### Idle Detection (`main/idle_test.js`)
| Contract | Evidence |
|----------|----------|
| Observer registration | Required params: observer + time |
| Precision validation | Rejects time below precision threshold |
| State transitions | `idle` <-> `active` callbacks with proper timing |
| Cleanup | Remove unregisters observer/time pairs |

### Locale (`main/locale_test.js`)
| Contract | Evidence |
|----------|----------|
| RTL detection | `he`, `ar` -> true; `en`, `it` -> false |

### Menu (`main/menu_test.js`)
| Contract | Evidence |
|----------|----------|
| Template compilation | Loads, compiles, sets via `Menu.setApplicationMenu()` |

### Resources (`main/res_test.js`)
| Contract | Evidence |
|----------|----------|
| Base class `Resource` | `expand()` builds paths with extensions |
| `Menu extends Resource` | Pattern: `menu.main.en.yml` |
| `Strings extends Resource` | `open('en')` loads/parses; `openWithFallback` for missing locales |

### Storage (`main/storage_test.js`)
| Contract | Evidence |
|----------|----------|
| JSON persistence | `save`/`load` (async + sync) |
| Missing file rejection | `load` rejects for nonexistent files |

### Tropy App (`main/tropy_test.js`)
| Contract | Evidence |
|----------|----------|
| Singleton | `tropy === Tropy.instance === new Tropy()` |
| Protocol routing | `tropy://about` -> about window; `tropy://prefs` -> prefs window; `tropy://project` -> project window |
| Deep linking | `tropy://project/current/items/41/3` dispatches item action |
| Window reuse | Focus existing window if project already open |
| IPC dispatch | `win.webContents.send()` with action payload |

### Window Manager (`main/wm_test.js`)
| Contract | Evidence |
|----------|----------|
| Type-indexed registry | `wm.has(type)`, `wm.current(type)` |
| Window types | `main`, `prefs`, `about` |
| Ready promise | Resolves with timestamp |
| Lifecycle | Open -> register; Close -> destroy + deregister |
| Iterable | `[...wm]` spreads all windows |

---

## 5. Component Contracts (11 tests)

### Layout Components
| Component | Contract | Evidence |
|-----------|----------|----------|
| `Icon` | Renders `<i>` with icon class from `name` prop; merges `className`; passes `title` | 4 assertions |
| `Toolbar` | Renders without crashing | Smoke test only |
| `Sidebar` | Renders children | Children projection |
| `Panel` | Renders children | Children projection |

### Domain Components
| Component | Contract | Evidence |
|-----------|----------|----------|
| `ProjectSidebar` | Renders sidebar with project name | 1 test |
| `ListTree` | Renders nothing for empty parent; renders list nodes | 2 tests |
| `TableHead` | Has class `table-head`; renders head columns | 2 tests |
| `PluginOption` | Renders options from plugin config | 2 tests |
| `TagAdder` (autocomplete) | Matches from start of tag; case-insensitive; matches after punctuation/whitespace; supports non-latin scripts; supports emoji; matches tags starting with punctuation; does NOT match mid-word | 9 tests |
| `PhotoList` | Renders empty list by default; computes expansion row offsets; computes expansions before row; adjusts offset for expansion rows; computes iterable range with expansion | 6 tests |

### TagAdder Matching Rules (detailed)
The tag autocomplete has specific matching semantics:
1. Matches from the **start** of a tag name
2. Does **not** match sections from the middle of words
3. Case-insensitive
4. Matches sections after any punctuation or whitespace boundary
5. Supports non-Latin scripts (CJK, Cyrillic, etc.)
6. Supports emoji in tag names
7. Tags starting with punctuation are matchable
8. Tags containing punctuation are matchable at boundary points
9. Punctuation typed at query start does **not** match mid-tag punctuation

### PhotoList Virtual Scrolling
The PhotoList tests reveal a virtual-scrolling model:
- `getExpansionRows()` -- computes which rows are expansion rows (offsets)
- `getExpansionRowsBefore(row)` -- counts expansion rows before a given index
- `getOffset(index)` -- adjusts scroll offset for expansion rows
- `getIterableRange()` -- computes visible range accounting for expansions

---

## 6. State Management Contracts (selectors + reducers)

### Selectors (read-side)

| Selector | Contract | Evidence |
|----------|----------|----------|
| `getExportItemIds` | Returns passed IDs; falls back to selected items; falls back to all visible items | 3 behaviors |
| `getExportItems` | Includes `@context`, `@graph`, version; items include tags, lists, photos, metadata | JSON-LD structure |
| `getListSubTree` | Returns expanded subtree of list hierarchy | Tree traversal |
| `getItemMetadata` | Returns combined metadata in bulk with stats | Aggregation |
| `getItemTags` | Returns combined tags with stats | Aggregation |

### Reducers (write-side)

| Action | Contract | Evidence |
|--------|----------|----------|
| `LIST.ITEM.ADD` | No-op unless `done` flag; adds list to all affected items | Async completion pattern |
| `LIST.ITEM.REMOVE` | No-op unless `done` flag; removes list from all affected items | Async completion pattern |

### Reducer Helper: `nested`
| Operation | Contract | Evidence |
|-----------|----------|----------|
| `nested.add` | Single ID, multiple IDs, index-based (`meta.idx`) | 3 modes |
| `nested.remove` | Single ID, multiple IDs | 2 modes |

---

## 7. Editor Contracts (ProseMirror)

| Feature | Contract | Evidence |
|---------|----------|----------|
| `markExtend` | Extends selection to mark boundaries; works forward and backward; handles first/last letter edge cases | 4 selection modes |
| `fromHTML` | Creates ProseMirror document from HTML string | Round-trip serialization |

---

## 8. Ontology and Vocabulary Contracts

| Feature | Contract | Evidence |
|---------|----------|----------|
| `models.ontology.create` | Creates new ontology DB from schema (async) | Schema-driven init |
| `toN3()` | Serializes vocabulary to N3/Turtle string; output is parseable | Round-trip validation |

---

## 9. Utility Contracts

### CSS (`css_test.js`)
- `cursor(path)` -> CSS `url()` for single path
- `cursor(paths)` -> CSS `image-set` for multiple paths

### DOM (`dom_test.js`)
- `.css()` -> creates `<style>` node
- `.stylesheet()` -> creates `<link>` node
- `ready` -> Promise that resolves when DOM is ready
- `.attr()` -> get/set/remove attributes
- `.create()` -> create element with attributes
- `.append()` -> append child
- `.on/.off/.once` -> event listener management (`.once` auto-removes)
- `.loadImage()` -> Promise: resolves on load, rejects on error

### Format (`format_test.js`)
- `number()` -> formats numbers and numeric strings
- `bytes()` -> formats as byte quantities

---

## 10. Test Infrastructure Contracts

### Support Utilities
| Utility | Purpose |
|---------|---------|
| `mkdbtmp()` | Creates temporary SQLite database for test isolation |
| `mkprojtmp()` | Creates temporary project (file or managed) |
| `mkdtmp()` / `mktmp()` | Temporary directories/files |
| Custom `render()` | Wraps React Testing Library with Redux store + IntlProvider + DnD context |
| Custom matchers | `.startWith()`, `.endWith()` for Chai |

### Test Execution Model
| Mode | Command | Files |
|------|---------|-------|
| Main process | `electron-mocha --no-sandbox` | `test/{main,common}/**/*_test.js` |
| Renderer | `electron-mocha --no-sandbox --renderer` | Other `*_test.js` |
| Pretest | `babel src -d internal && babel test -d mocha` | Transpiles before run |
| Coverage | `COVERAGE=true` env var | NYC/Istanbul |

---

## 11. Cross-Cutting Design Patterns

| Pattern | Where | Evidence |
|---------|-------|----------|
| **Disposable resources** | DB connections, statements | `using()` with guaranteed cleanup |
| **Singleton** | Tropy app instance | `Tropy.instance === new Tropy()` |
| **Async completion flag** | Redux actions | `done` property gates reducer logic |
| **JSON-LD** | Export format | `@context`, `@graph`, typed values |
| **RDF/Linked Data** | Metadata, ontology | XSD datatypes, Dublin Core URIs, N3 serialization |
| **Template-driven metadata** | Items, photos, selections | `template` URI determines available fields |
| **Protocol deep linking** | `tropy://` URLs | Routes to windows and item navigation |
| **Virtual scrolling** | PhotoList | Expansion row offset calculations |
| **Mark-based formatting** | Editor | ProseMirror marks with selection extension |
| **Immutable state** | Utilities, reducers | All operations return new objects/arrays |
| **Connection pooling** | SQLite | Bounded pool with busy tracking |
| **Resource inheritance** | Menu, Strings extend Resource | Shared expand/open pattern with fallback |

---

## 12. Contracts Found in Source Code (Untested)

The following behavioral contracts exist in the source but have no test coverage. Discovered by examining `src/` to fill gaps identified in the test suite.

---

### 12.1 Drag and Drop System

**Core infrastructure:** `src/components/dnd.js`, `src/components/drag-layer.js`, `src/components/draggable.js`

**DnD hooks** (7 specialized hooks in `src/hooks/`):
- `use-drag-handler.js` — generic drag event handler
- `use-drag-drop-metadata.js` — metadata field drag/drop
- `use-drop-photo-files.js` — external image file drops
- `use-drop-project-files.js` — .tropy/.ttp file drops
- `use-drop-text.js` — plain text drops into metadata fields
- `use-drop-effect.js` — visual feedback (copy/move/not-allowed cursor)
- `use-mouse-tracking.js` — drag position tracking

**Drag source / drop target matrix:**

| Source Entity | Valid Drop Targets | Effect |
|---|---|---|
| Item | List node, Trash | Move to list / Delete |
| Photo | Item, Trash, external app | Add to item / Reorder / Delete / Export |
| Selection | Tag, Trash, New Item | Tag / Delete / Create item from crop |
| Tag | Item, Photo, Selection | Apply tag |
| Metadata field | Photo, Selection, Item | Populate field |
| Template field | Template editor | Reorder fields |
| Transcription (ALTO) | Selection, Note | Annotate |
| External image file | Photo panel, Item panel, Project view | Import photo |
| External project file | Project view | Open project |
| Plain text | Metadata field, Note editor | Populate field |

---

### 12.2 Photo Interactions (beyond virtual scrolling)

**Click handlers** (`src/components/photo/list-item.js`, `tile.js`, `grid.js`):
- Single click: select/deselect photo
- Ctrl/Cmd+click: multi-select
- Shift+click: range select
- Double-click: open in Esper viewer

**Context menu** (`src/components/photo/list.js`, `grid.js`):
- Delete, Rotate, Duplicate, Export, Create selection, Copy reference

**Esper image viewer** (`src/components/esper/view.js`, `tools.js`, `panel.js`):
- Mouse wheel: zoom in/out
- Click+drag: pan image
- Double-click: reset zoom to fit
- Toolbar: rotate (90deg or smooth), flip H/V, zoom presets (fit/100%/200%), crop tool, reset
- Crop tool: click+drag creates rectangular Selection entity; drag handles to resize; confirm/cancel

---

### 12.3 Selection Creation/Editing

**Files:** `src/components/selection/` (grid, iterator, iterable, list, list-item, tile), `src/selection.js`

**Creation flow:**
1. Open photo in Esper viewer
2. Activate crop/selection tool
3. Click+drag to define rectangle
4. Name the selection
5. Confirm -> creates Selection entity in Redux store

**Editing:** Drag handles to resize, update name/metadata in sidebar, add tags

**Selection-to-Item:** Right-click selection -> "Create Item" spawns new Item referencing original photo

---

### 12.4 Plugin Lifecycle

**File:** `src/common/plugins.js` (8,122 bytes)

| Operation | Contract | Error handling |
|-----------|----------|----------------|
| `scan()` | Discovers plugins in plugin directory, reads package.json hooks | Logs warning, continues |
| `create()` | Instantiates plugin: `new Plugin(options, context)` | Logs warning, skips plugin |
| `install()` | Installs plugin from spec (name/path) | Logs warning with stack trace |
| `uninstall()` | Removes plugin files | Logs warning, non-fatal |
| `unload()` | Tears down plugin instance | Logs warning, continues |
| `list()` | Returns installed plugins | Logs warning on failure |

**Error contract:** All operations use try-catch with structured `warn()` logging. No plugin failure crashes the app. Non-fatal isolation.

---

### 12.5 Import Pipeline

**Files spanning the full pipeline:**

| Layer | File | Role |
|-------|------|------|
| Constants | `src/constants/import.js` | Import action types/flags |
| Actions | `src/actions/imports.js` | Redux action creators |
| Commands | `src/commands/import.js` | Import orchestration |
| Item-level | `src/commands/item/import.js` | Per-item import logic |
| Common | `src/common/import.js` | Shared import utilities |
| Reducer | `src/reducers/import.js` | Import state management |
| UI | `src/components/settings/import.js` | Import settings panel |

**`POST /project/import` flow:** Parse JSON from form data -> route through `commands/import.js` -> per-item processing via `commands/item/import.js` -> state update via `reducers/import.js`

---

### 12.6 Search/Filter

**Navigation search** (`src/actions/nav.js`, `src/reducers/nav.js`):
- Search terms affect item navigation and filtering
- Central search state in Redux `nav` slice

**Entity-level filtering:**
- Items: `src/actions/item.js`, `src/reducers/items.js`
- Lists: `src/actions/list.js`, `src/reducers/lists.js`
- Tags: `src/actions/tag.js`, `src/selectors/tags.js`
- Activity log: `src/actions/activity.js`, `src/selectors/activity.js`
- API queries: `src/actions/api.js` (backend supports query parameters)

---

### 12.7 Undo/Redo

**Dedicated history system:**
- Constants: `src/constants/history.js`
- Actions: `src/actions/history.js`
- Reducer: `src/reducers/history.js` (maintains undo/redo stack)
- Saga: `src/sagas/history.js` (side effects)

**Undoable actions** (all tracked in history stack):

| Entity | Source file |
|--------|------------|
| Photo operations | `src/actions/photo.js` |
| Item operations | `src/actions/item.js` |
| Tag operations | `src/actions/tag.js` |
| Metadata edits | `src/actions/metadata.js` |
| Note operations | `src/actions/note.js` |
| Selection changes | `src/actions/selection.js` |
| Project changes | `src/actions/project.js` |

---

### 12.8 Note Editing (ProseMirror)

**Files:** `src/components/note/` (notepad, list, list-item, toolbar), `src/components/editor/` (view, container, toolbar, link), `src/commands/note/`

**Capabilities** (beyond mark extension and HTML serialization tested):
- Note CRUD: create, delete, update dispatched from `note/notepad.js` and `note/list-item.js`
- Rich text toolbar: `editor/toolbar.js`
- Link editing: `editor/link.js`
- Undo/redo integrated via history system
- Notes attachable to Items, Photos, or Selections

---

### 12.9 IPC Communication

**79 files reference IPC.** Key architecture:

| Pattern | Files | Direction |
|---------|-------|-----------|
| `ipcMain.handle()` | `src/main/api.js` | Renderer -> Main (async request/response) |
| `ipcRenderer.invoke()` | Various renderer components | Renderer -> Main (caller side) |
| `webContents.send()` | `src/main/wm.js`, `src/main/tropy.js` | Main -> Renderer (push updates) |
| `useIpc()` hook | `src/hooks/use-ipc.js` | Renderer components subscribe to IPC |
| IPC saga | `src/sagas/ipc.js` | Renderer-side IPC event handling |

**Main -> Renderer messages:** window state, project updates, photo/item changes, selection updates, tag updates, note updates

**Renderer -> Main messages:** file dialogs, photo operations (create/extract/transcribe), item operations (import/print), project save/load, tag/note CRUD, plugin operations

---

### 12.10 Image Processing

**6 core files in `src/image/`:**

| File | Purpose |
|------|---------|
| `index.js` | Central image API |
| `sharp.js` | Sharp library: resize, rotate, crop, convert, orientation correction |
| `exif.js` | EXIF metadata extraction (orientation, camera, GPS) |
| `xmp.js` | XMP extended metadata |
| `image.js` | Image class definition |
| `svg.js` | SVG handling |

**Processing pipeline:**
1. Photo imported via `commands/photo/create.js`
2. EXIF read via `image/exif.js`
3. Orientation corrected + processed via `image/sharp.js`
4. Thumbnail generated for grid display (`components/photo/thumbnail.js`)
5. Full image rendered in Esper with filters (`esper/filter/` — includes sharpen)
6. Export to IIIF or other formats via `common/export.js`, `common/iiif.js`

**Photo extraction:** `commands/photo/extract.js` — extracts photo data for export/sharing

---

### 12.11 Component Behavioral Contracts (beyond smoke tests)

**Toolbar** (`src/components/toolbar.js`, 2,838 bytes):
- Redux-connected: dispatches view mode, search, create actions
- Props from state selectors for visibility/enabled state

**Sidebar** (`src/components/sidebar.js`, 223 bytes):
- Minimal presenter; children prop controls content
- No direct dispatch (parent-controlled)

**Panel** (`src/components/panel.js`, 9,436 bytes):
- Redux-connected: selects item, metadata, notes, tags, photos
- Dispatches: metadata save, note create/delete, tag add/remove, photo select
- Multi-section container for item detail editing

**ProjectSidebar** (`src/components/project/sidebar.js`):
- Redux-connected: selects collections and selected collection
- Dispatches: collection select, create, delete
- Renders tree nodes via `list/node.js`

---

### 12.12 Application Architecture (Redux state + view switching)

**No React Router.** View switching is state-based via Redux:

| View | Container | Purpose |
|------|-----------|---------|
| Project | `project/container.js` | Main item browsing |
| Item editor | `editor/container.js` | Item detail editing |
| Preferences | `prefs/container.js` | Settings dialog |
| Print | `print/container.js` | Print preview |

**Entry point:** `components/main.js` dispatches based on Redux state

**Context providers wrapping the app:**

| Context | File | Purpose |
|---------|------|---------|
| Redux Provider | `main/tropy.js` | Redux store |
| DnD Context | `components/dnd.js` | React-DnD |
| Window Context | `hooks/use-window.js` | Electron window/IPC access |
| Frame Context | `components/frame.js` | Viewport state |
| Popup Context | `components/popup.js` | Modal/popup state |
| Tree Node Context | `components/tree/node-container.js` | Tree state sharing |

**Inferred Redux state shape:**

```
{
  items:          { byId: {}, selected: id },
  photos:         { byId: {}, order: [] },
  selections:     { ids: [] },
  metadata:       { byId: {}, values: {} },
  notes:          { byId: {}, byItemId: {} },
  tags:           { byId: {}, list: [] },
  lists:          { byId: {}, root: id },
  nav:            { search: '', filters: {} },
  history:        { past: [], future: [] },
  editor:         { mode: '', active: bool },
  preferences:    { view: '', layout: '' },
  ui:             { sidebar: bool, panel: bool, toolbar: bool },
  transcription:  { byId: {}, active: id },
  import:         { ... }
}
```
