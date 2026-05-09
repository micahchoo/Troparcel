# Plugin Entry Context Object

> **Status:** verified 2026-05-09 against `tropy/src/` (read-only reference clone).
> **Purpose:** unblock seeds `tropy-plugin-a542` (HISTORY.TICK), `tropy-plugin-e4da`
> (FLASH.SHOW), `tropy-plugin-b4eb` (action-type constants),
> `tropy-plugin-2b6d` (HISTORY.TICK testability).

## Where the context comes from

`tropy/src/common/plugins.js` defines `class Plugins extends EventEmitter`:

```js
constructor (root, context = {}) { super(); this.context = context; ... }   // L33-37
getContext (plugin) { return { logger: logger.child({ plugin }), ...this.context } }   // L43-48
this.instances[i] = new Plugin(options ?? {}, this.getContext(plugin))          // L67-69
```

So every plugin instance receives a fresh object spread from `this.context`,
plus a `logger` child scoped to the plugin name. The constructor's `context`
argument is whatever the caller of `new Plugins(root, context)` chose to pass.

Two `new Plugins(...)` call sites exist (`grep -rn 'new Plugins' tropy/src`):

| Site | Purpose | Context arg |
|---|---|---|
| `tropy/src/main/tropy.js:86` | main-process Tropy app — `this.plugins = new Plugins(join(opts.data, 'plugins'))` | **omitted (defaults to `{}`)** |
| `tropy/src/window.js:43` | renderer-side `Window` class — `new Plugins(ARGS.plugins, {dialog, json, sharp, window: this})` | 4 fields |

The renderer site is the one that actually calls into plugin classes — the
main-process `Plugins` instance never invokes `create()` on plugin user code
in this codebase (it only loads spec, watches the config dir, and rebroadcasts
`change` events; see `tropy/src/main/tropy.js:333,336,918`).

**Therefore: every plugin entry-point method runs inside a renderer window and
receives the renderer-side context.**

## Context object surface

Five fields total (one synthesized per-call by `getContext`, four from
`window.js:43-48`).

| Field | Type | Source file:line | Use case |
|---|---|---|---|
| `logger` | bunyan-style child logger (`{trace, debug, info, warn, error, fatal}`) | synthesized in `tropy/src/common/plugins.js:46` (`logger.child({plugin})`) | Diagnostic logging tagged with plugin name. Verified usage: `troparcel/src/plugin.js:33` and dozens of other call sites. |
| `dialog` | namespace re-exporting `{fail, notify, open, prompt, save, show, start, stop}` | `tropy/src/dialog.js:283-292` (re-export block) | User-facing modal dialogs and **transient flash notifications** via `dialog.notify(messageKey, params)`. Reference: `plugins/tropiiify/src/plugin.js:43,282` calls `this.context.dialog.notify("missing.ids", {...})` and `"export.complete"`. `plugins/tropy-crdt-collab/src/plugin.js:95,97` calls `this.context.dialog.info(...)` / `.warning(...)` — note: `info`/`warning` are NOT in the `dialog.js` export list, so those calls will silently no-op (potential downstream gotcha). |
| `json` | namespace `{open, parse, write, expand, compact}` (default-export plus named) | `tropy/src/common/json.js:46-82` | JSON-LD expansion/compaction for ontology and import/export pipelines. Reference: `plugins/tropiiify/src/plugin.js:31` calls `this.context.json.expand(data)`. |
| `sharp` | namespace `{init, defaults, open, toFile, toBuffer, default wrapper}` | `tropy/src/image/sharp.js:5-42` | Image manipulation backed by lib-sharp. Reference: `plugins/tropiiify/src/plugin.js:162` calls `this.context.sharp.open(photo.path, {...})`. |
| `window` | the renderer-side `Window` instance (extends EventEmitter) | `tropy/src/window.js:43-48` (`window: this`) | Bridge to the entire renderer surface. Key reachable members below. |

### `context.window` — the load-bearing field

`context.window` is the renderer `Window` singleton (`tropy/src/window.js`,
class `Window`, 482 lines). The members troparcel and other plugins actually
reach are:

| Member | When set | Use |
|---|---|---|
| `window.store` | populated by `Window.load()` at `tropy/src/window.js:108-111` (after dynamic `import(./views/${type}.js)`) | The full Redux store: `getState()`, `dispatch(action)`, `subscribe(listener)`. **NOT available before `window.load()` resolves** — see `troparcel/src/plugin.js:75-77,89,126,198` and the `store-adapter.js:6-37` JSDoc for the documented usage pattern. |
| `window.send(type, ...params)` | `tropy/src/window.js:479-481` — `ipc.send('wm', type, ...params)` | Send an IPC message to the WindowManager (main process). |
| `window.emit(...)` / `.on(...)` | inherited from `EventEmitter` | Listen for `'idle'`, `'print'`, `'settings.update'`, `'app.undo'`, `'app.redo'` events fired by `handleIpcEvents()` / `handleEditorCommands()`. |
| `window.toggle(name, state)` | called throughout, see `tropy/src/window.js:172-242` | DOM class toggling on `document.documentElement`. |
| `window.args` getter | `tropy/src/window.js:126-128` | Returns the `ARGS` object (CLI args + window config). |
| `window.body`, `window.html`, `window.stylesheets` | `window.js:130-145` | DOM accessors. |
| `window.controls` | optional, set when `ARGS.frameless` is true (`window.js:91-95`) | Custom titlebar handle. |
| `window.type` | class field, `basename(window.location.pathname, '.html')` (`window.js:41`) | Window kind: `'project'`, `'prefs'`, `'about'`, etc. — used by troparcel to skip non-project windows (`troparcel/src/plugin.js:33`). |
| `window.unloaders` | array of fns (`window.js:50, 70-71`) | Register cleanup callbacks; the plugins themselves are auto-unloaded via `Plugins.unload()`. |

### What is NOT in context

Verified absent (`getContext` only spreads the four fields above + `logger`):

- **No `store` at the top level** — must be reached via `context.window.store`,
  and the property is undefined until `Window.load()` completes.
- **No `dispatch` shortcut** — same: `context.window.store.dispatch(...)`.
- **No action-type constants** (no `FLASH`, `HISTORY`, `ITEM`, `LIST`, etc.).
  These live in `tropy/src/constants/<slice>.js` (35 files), e.g.
  `tropy/src/constants/flash.js` exports `{HIDE: 'flash.hide', SHOW: 'flash.show'}`
  and `tropy/src/constants/history.js` exports
  `{UNDO, REDO, TICK, DROP, CHANGED}` mapped to `'history.tick'` etc.
  Plugins must either re-declare the string literals locally or import the
  constants module by absolute Node `require()` path (fragile across Tropy
  versions).
- **No `ipcRenderer`** directly. Plugins can `require('electron')` themselves
  inside the renderer (`Window` does so at the top of `window.js`), but the
  context does not pre-inject it.
- **No `electron` dialog/shell** beyond what `tropy/src/dialog.js` re-exports.
- **No project metadata** (`project.id`, `path`) on `context.window` — see
  the explicit comment at `troparcel/src/plugin.js:75-77`: *"context.window.store
  is set after window.load() completes ... there is NO context.window.project
  property."*
- **No notification surface beyond `dialog.notify`** — `flash` reducer state
  is reachable via `store.getState().flash` and dispatched via raw action
  objects.

## Implications for blocked seeds

### `tropy-plugin-a542` — HISTORY.TICK merge feasibility

**Reachable.** `context.window.store.dispatch({type: 'history.tick', ...})` is
the same pathway already used for `note.create` etc. in
`troparcel/src/store-adapter.js`. The `HISTORY.TICK` literal can be
hard-coded as `'history.tick'` (the string is defined in
`tropy/src/constants/history.js:4`). Caveat: `store` is undefined until
`Window.load()` completes — same readiness gate as every other dispatch. The
existing `_waitForStore` pattern in `troparcel/src/plugin.js:89-130` already
handles this.

### `tropy-plugin-e4da` — FLASH.SHOW notifications

**Two routes, prefer dialog.notify:**

1. **`context.dialog.notify(messageKey, params)`** — already exists, already
   used by tropiiify (`plugins/tropiiify/src/plugin.js:43,282`). This is the
   blessed plugin-facing surface. Wraps the FLASH.SHOW dispatch internally.
2. **Raw dispatch** — `context.window.store.dispatch({type: 'flash.show',
   payload: {...}})`. Possible (the constant is `'flash.show'` per
   `tropy/src/constants/flash.js:3`) but bypasses the localization key
   lookup `notify` performs.

**Recommendation:** use `dialog.notify` for user-facing messages.

> ⚠ Note: `plugins/tropy-crdt-collab/src/plugin.js:95,97` calls
> `this.context.dialog.info(...)` and `.warning(...)`, but those names are
> NOT in the `tropy/src/dialog.js:283-292` export list. The reference plugin
> is buggy here — those calls silently no-op. troparcel should not copy that
> pattern.

### `tropy-plugin-b4eb` — action-type constants

**Three options, ranked:**

1. **Hard-code string literals** in troparcel (`'history.tick'`, `'flash.show'`,
   `'note.create'`, etc.). Simple, explicit, but drifts when Tropy renames a
   constant. Mitigation: a small `troparcel/src/tropy-action-types.js` module
   with all literals + a comment citing the upstream `constants/<slice>.js`
   file:line.
2. **`require('tropy/src/constants/history.js')`** at runtime — would couple
   to Tropy's internal layout (`/src/` is not a public export), and the path
   is not stable across Tropy install methods (Electron asar vs. dev tree).
   Avoid.
3. **Dispatch via `context.dialog.notify`** for FLASH and skip raw constants
   entirely. Works for that one slice; doesn't help HISTORY.TICK.

**Recommendation:** option 1. Mirror the constants in a single troparcel
module, with cross-references to the upstream file as a comment, and a one-line
runtime sanity check (`if (!HISTORY_TICK_ACTION) logger.warn(...)`).

### `tropy-plugin-2b6d` — HISTORY.TICK test plan

The test should mock `context = {logger, dialog, json, sharp, window:
{store: {getState, dispatch, subscribe}}}`. Specifically:

- `dispatch` is a jest/sinon spy; assert it was called with `{type:
  'history.tick', payload: <expected>}`.
- The `Window.load()` race condition does **not** apply in tests — inject the
  store directly. The polling code in `troparcel/src/plugin.js:89-130` should
  short-circuit when `context.window.store` is already set, which it already
  does.
- No need to mock `electron`, `ipcRenderer`, or the FLASH/HISTORY constants
  modules — troparcel must own its action-type literals (per b4eb decision).

## Recommended access pattern for troparcel

| Field | Verdict | Notes |
|---|---|---|
| `context.logger` | **consume** | Already used pervasively. |
| `context.window.store` | **consume, with readiness guard** | The existing `_waitForStore` polling in `plugin.js:89-130` is the canonical pattern. Don't add a second guard. |
| `context.dialog.notify` | **consume** for user-facing flashes | Use localization keys; matches tropiiify pattern. |
| `context.dialog.info/warning` | **avoid** | Not in the upstream export list. Use `notify` or `dispatch FLASH.SHOW` directly. |
| `context.window.send(...)` | **ignore** | IPC to WindowManager — troparcel has no need to send wm-level commands; sync state belongs in Redux, not IPC. |
| `context.window.emit/on` | **maybe** | Could subscribe to `'idle'` for auto-pause, or `'print'` etc. Not needed by the current design. |
| `context.json` | **consume** if/when troparcel does ontology import/export | Currently unused. |
| `context.sharp` | **ignore** | Image processing not in scope. |
| `context.window.args / .type` | **consume** | Already used (`type === 'project'` gate at `plugin.js:33`). |
| `context.window.controls / .body / .html` | **avoid** | DOM coupling — troparcel should not touch chrome. |
| Action-type constants | **mirror locally** (option 1 above) | One file, cross-referenced to upstream constants. |

## Item-metadata mixed flag

> **Status:** verified 2026-05-09. Research-only — UX implementation deferred per design decision (separate from this audit).
> **Seed:** `tropy-plugin-9381` (closed partial — research complete).

`getItemMetadata` is **reachable** from troparcel through the existing context surface (no new field needed):

| Layer | Path |
|---|---|
| Selector definition | `tropy/src/selectors/metadata.js:55` (`export const getItemMetadata = memo(...)`) |
| Re-export | `tropy/src/selectors/index.js:7` (`export * from './metadata.js'`) |
| Contract test | `tropy/test/selectors/metadata.test.js:27` (`it('marks mixed values', ...)`) — asserts `value.mixed === true` iff items disagree on a property's text |
| Return shape | `{ id: [itemIds...], [propertyURI]: { text, mixed: bool } }` for multi-item selection; empty selection → `{ id: [] }` |
| Mixed computation | `collectMetadata` in `metadata.js:42-52` — `value.mixed = value.count !== ids.length` |

### Render path (for a UX integration site)

```
selectors/metadata.js getItemMetadata
  → selectors/metadata.js getItemFields (line 122 — reads getItemMetadata)
    → components/metadata/panel.js:240  (item: getItemFields(state))
      → components/metadata/list.js:133 (isMixed={!!value.mixed})
        → components/metadata/field.js:18,45,85-87  (className 'mixed' applied)
```

**The cheap troparcel integration site is `field.js:85-87`** — Tropy already attaches the CSS class `metadata-field mixed` when `isMixed` is true. Troparcel can:

1. **CSS-only path (recommended for v1)** — inject a stylesheet (via `context.window.stylesheets` or DOM mutation) that targets `.metadata-field.mixed` and adds a divergence badge / colored stripe. **Zero React touchpoints, zero schema patches.** Caveat: no per-peer attribution — only "this field is mixed across the current multi-selection."
2. **Selector-call path** — call `getItemMetadata(context.window.store.getState(), props)` directly to inspect the mixed flag programmatically (e.g. for a peer-divergence panel outside Tropy's standard UI). Requires constructing the `props` object `{items: [...], nav: ...}` shape.
3. **Per-peer divergence (richer)** — separate concern: tropy's `mixed` reflects multi-item disagreement, NOT cross-peer disagreement on a single item. To surface "peer A wrote X, peer B wrote Y" troparcel must build its own diff layer over the CRDT history. Out of scope for the cheap integration.

### Why this is filed as research-only

Per user (2026-05-09): UX placement (badge style, color, copy, hover behavior) is a design decision the user owns separately. This doc captures the **load-bearing technical seam** so a design pass can decide between the CSS-only path and a richer custom panel without re-spelunking the selector chain. See mulch `mx-751d49` (selector contract) and the follow-up record from this investigation.

## Open questions / follow-up

- **None of the four blocked seeds need additional context fields.** All
  required capabilities are reachable through the documented surface.
- One uncertainty worth flagging: the *prefs window* and *about window* also
  instantiate `Window` (and therefore `Plugins`). The `window.type === 'project'`
  short-circuit in `troparcel/src/plugin.js:33` already handles this, but any
  new plugin entry method that does work before that check runs will execute
  in those windows too. If a future hook (e.g., `import`) is added, repeat the
  guard.
- The main-process `Plugins` instance (`tropy/src/main/tropy.js:86`) does have
  the same class but never calls `create()` — confirmed by reading the
  `restore()` and `listen()` flow. If upstream Tropy ever moves plugin
  execution to the main process, this entire context surface changes (no
  `window`, no `store`). Track via the upstream changelog.
