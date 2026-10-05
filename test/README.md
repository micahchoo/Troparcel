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
