# Tests

| Command | Runs | Needs |
|---|---|---|
| `npm test` | `index.test.js` (units), `scenarios/` (two engines over fake Tropys), `integration/` (a real server, a real shared folder) | Node 24 |
| `TROPY_SRC=<tropy checkout> npm test` | also `scenarios/tropy-drift.test.js` | a Tropy source checkout |
| `npm run e2e` | `e2e/` (two real Tropy instances and a synthetic peer) | Flatpak `org.tropy.Tropy`, `xvfb-run`, `dbus-run-session` |

## The fakes, and why they are trustworthy

`harness/fake-tropy.js` is a fake Tropy **store**, not a fake adapter: tests drive the real `StoreAdapter` over it, so the action shapes Troparcel sends are what is tested. It enforces what Tropy does, as read from Tropy's source and confirmed by `npm run e2e`:

- a command runs only with `meta.cmd` set and `meta.done` unset;
- a payload of the wrong shape throws, and the command's effect never appears;
- a command with `meta.history` adds an undo entry (`tropy.undo`);
- `note.create` selects the new note (moves `nav`).

`harness/engine.js` starts real `SyncEngine`s over fake Tropys, joined by an in-memory relay, with vaults and backups in a temp folder.

If Tropy surprises you, encode the surprise in `fake-tropy.js` and add the e2e check that proves it.

## End to end

`npm run e2e` builds the plugin, starts a Troparcel server, and starts two Flatpak Tropy instances (alice and bob) on Xvfb, each with its own `--data` folder and a fresh project with the same generated photos. A third peer, carol, writes to the room directly, for what Tropy's HTTP API cannot create. The test drives Tropy through its HTTP API and checks every kind of data arrives once, is saved, and that Tropy logs no errors.

Nothing touches your own Tropy: everything lives in `.e2e/<run>/`, which keeps the logs (`<name>/logs/`) and projects for inspection. Each run takes about a minute.

### The timeline: what happened inside Tropy

The HTTP API shows Tropy's state, not how it got there. So every e2e Tropy also loads `e2e/observer/`, a test-only plugin (entry #2; the driver is #1, extra entries start at #3). In the project window it writes `.e2e/<run>/<name>/timeline.jsonl` (`tropy.timelineFile`), one JSON object per line, each with `t` (ms since the plugin started) and `at` (epoch ms):

- `action`: every action that reached the store — `type`, `seq`, and `cmd`, `rel`, `done`, `history`, `plugin` when set; the payload only as its JSON `size`; `error` and `message` for a failed action.
- `activity`: a command (`state.activities`) starting, and ending with its `ms`.
- `counts`: items, photos, selections, notes, transcriptions, tags, lists, whether `project.path` is set, `nav.mode`, `nav.query`, and the undo history (`history.past` / `future` lengths). At most one line per 100 ms, written only when something changed; when Tropy is killed inside that period the last change is missing.

Read it with:

```
node test/e2e/timeline.js .e2e/<run>/alice/timeline.jsonl
```

which prints when the project opened, when loads ran, each command type with count, total and max duration, errored actions, and undo and nav changes. The observer reads actions with a saga that takes `'*'`, because sagas `put` past `store.dispatch`; it attaches when the window assigns its store, so the first few actions (`intl.load`, `keymap.load`) come before it.

## Footage for the explainer

`npm run film` records real Tropy windows (`test/e2e/film.js`: alice, bob and a newcomer, carol, each on a 1280×800 Xvfb display through `test/e2e/studio.js`), then cuts the film (`test/e2e/edit.js`: zooms, pans, captions and crossfades with ffmpeg; camera moves are the `SHOTS` table). It needs `ffmpeg`, `Xvfb` and `xdotool`. The letter scans are public domain (`test/fixtures/letters/SOURCES.md`). `--rehearse` takes screenshots instead of recording, to check each scene. `TROPARCEL_BUNDLE=<file>` films a bundle other than `./index.js`, e.g. while another run uses it.
