# Troparcel roadmap

Troparcel is an **annotation overlay**: each person keeps their own photos, and only what they write about them travels. That premise makes it usable with archives whose photos cannot be shared, so it stays the default. The roadmap builds outward from it in rings:

**trustworthy overlay → scalable overlay → shared project → verifiable authorship → publishable room**

Each phase ends with an exit test you can run, not a list of features. Status as of 2026-10-05.

| Phase | Status | Exit test | Next step |
|---|---|---|---|
| 0 · Ground truth | Done | Passed | — |
| 1 · Trustworthy overlay | Done (6.0, soak fixes in 6.1) | Passed: 30- and 60-minute soaks, on a server and in a shared folder, in overlay, project and private rooms | A soak where members share fields and settle conflicts on the page |
| 2 · Stay compatible with Tropy | Done | Passed: CI against Tropy `main` | — |
| 3 · Scale | Done, one follow-up | Start: passed (1.5 s for 10,000 items). Memory: no baseline | Keep Troparcel's own markings out of an item's hash |
| 4 · Shared project | Done (6.1) | Passed in real Tropy | — |
| 5 · Authorship, private rooms | Done (6.1) | Passed in real Tropy | — |
| 6 · Publishable rooms | IIIF export done (6.1) | Half: export passes; no viewer opened yet | Open a published folder in a IIIF viewer |
| 7 · Easy for beginners | Mostly done (6.1) | The setup page passes in real Tropy | Hosted relay: not planned (folder-first instead) |

6.1.0 is everything since 6.0.0. A 68-second film of real Tropy (`npm run film`, `docs/media/troparcel.mp4`) shows what 6.1 does; filming it found a real bug (attribution credited people for entries that changed nothing locally), now fixed. Testing grew with it: a test-only **driver** plugin lets e2e tests read Tropy's state and use its menus, and an **observer** plugin records a timeline of every action inside each test Tropy (`test/README.md`).

## Phase 0 · Ground truth — done

- The agent-facing docs are deleted; facts that still hold are in `docs/DEVELOPER.md` › "Tropy internals that have bitten".
- `npm test` passes on a fresh clone, with no sibling folders.
- `.github/workflows/test.yml` runs the tests against Tropy 1.17.3 and `main`.

**Exit test:** a fresh clone passes `npm install && npm test`. Passed 2026-10-05, locally and in CI on GitHub.

## Phase 1 · Trustworthy overlay

Done in 6.0.0:

- One code path to Tropy: the Redux store, as commands. The HTTP-API fallback, the file watcher and `rollback()` are gone.
- Room schema 5: no nested shared types, so concurrent first writes lose nothing.
- Two-field setup (Connection, Your name); the server prints connection strings.
- Visibility through Tropy's own things: `@name` tags, the **Troparcel: received** list, a footer on each received note. No dialogs.
- A collaborator's change adds nothing to the owner's undo history. (The plan said "one undo step per sync". Tropy's history reducer crashes on the empty `history.tick` that needs, so there is none.)
- `npm run e2e` checks every kind of data between two real Tropy instances.

Also done: an oversized entry is skipped alone; a deleted selection or transcription reaches the others; only an entry's author can tombstone it in the room.

Released as [6.0.0](https://github.com/micahchoo/Troparcel/releases/tag/v6.0.0) on 2026-10-05.

**Exit test:** ~~two researchers on two machines use it for a week~~ — there are no testers. Instead, a **soak test**: three real Tropy instances and synthetic members make random edits for hours, with restarts and dropped connections; at the end every project holds the same data, nothing is duplicated, and Tropy logs no warnings. It finds sync bugs; it cannot find what only people find (confusing setup, awkward workflows). **Built** (`npm run soak`, `test/e2e/soak.js`); the first 60-minute run is in progress.

## Phase 2 · Stay compatible with Tropy — done

Troparcel's largest risk is that it depends on Tropy internals: Tropy gives plugins no supported way to change a project, so Troparcel uses the window's Redux store, and any Tropy release can change an action shape. The plan was to propose a plugin API to Tropy's maintainers; that is dropped. Instead, breakage is caught before users see it:

- CI runs every test against the current Tropy release (1.17.3) and Tropy's `main`, on every push;
- `test/scenarios/tropy-drift.test.js` checks each action type and each state detail Troparcel relies on (how a command runs, how a loaded project looks) against Tropy's source;
- `npm run e2e` runs real Tropy.

**Exit test:** a Tropy change that breaks Troparcel fails CI. Passed: the drift test fails on a renamed action or a changed load marker.

## Phase 3 · Scale

Done:

- Create effects read a parent's child list; notes are found by a footer-key index; unchanged items keep their object and hash; one transaction per push; tag and list assignments are one command per tag or list.
- A first sync in real Tropy grows linearly: 18–19 notes/s at 2,000 and at 10,000 items, the time spent in Tropy's own command (`test/e2e/scale.bench.js`; measured while the disk ran a RAID check, so slower than normal).
- Start-up, found by measuring in real Tropy: the first cycle ran before Tropy had loaded the project, and every start pushed every item again. Fixed: the vault keeps its push hashes, and Troparcel waits for the project to load, detected from Tropy's search result (`whenLoaded`) rather than from timing.
- A backup over the size limit is split into parts; a 10,000-item first sync was the one sync with no backup.
- The server runs y-websocket 2.1 and the client 3.1. `@y/websocket-server` needs Yjs 14 prereleases, so it waits for Yjs 14.

**Exit test, measured 2026-10-05 on the NVMe disk:** a 10,000-item project starts in **1.5 s**, from Tropy opening the project to Troparcel's first full cycle over all 10,000 items (target: 5 s). A first sync of 10,000 notes took 380 s (26 notes/s). With Troparcel running, the restarted Tropy idles at 824 MB; there is no figure yet for Tropy alone, so the memory half is open.

Keeping the room on the client's disk is not needed for that start time, so it is not built.

Follow-up: the first cycle after a restart can push again items whose only change was Troparcel's own marking (`@name` tags, Contributors, the received list), 1,319 items in the measurement. Nothing of it reaches the room, but the cycle spends time on it. Those markings should not count in an item's hash.

**Exit test:** a 10,000-item project starts in under 5 s, and memory grows with the items in use.

## Phase 4 · Shared project (a room option)

- An `items` index in the room: identity, template, checksums.
- Photos travel as content-addressed files keyed by MD5, which is how Tropy's own asset store names them. Stored on the server, in S3/R2, or in a shared folder.
- Import them with `item.import`; an item whose photos have not arrived waits.
- A room is an *overlay room* (photos stay local) or a *project room* (photos travel).

**Exit test:** a new researcher pastes one string into an empty Tropy and gets the whole project: items, templates, lists, photos and annotations. Passes: `test/e2e/project-room.e2e.js` (2026-10-05).

Built as `src/project-room.js`: a connection string ending in `photos=1` makes a project room. Tropy's own JSON-LD import (`item.import` with `payload.data`) creates the item; its annotations follow by ordinary sync.

## Phase 5 · Verifiable authorship and private rooms

- Each user has an ed25519 key in their vault and signs what they author. The rule "only an author can retract" then checks a signature, not a name anyone can type.
- Optional end-to-end encryption: the server relays and stores ciphertext only, and clients take snapshots, since the server can no longer compact. The connection string carries the room key.

**Exit test:** a peer that claims another person's name cannot retract that person's notes, and the server's database holds no plaintext.

Built as `src/authorship.js` (signatures, trust on first use) and `src/room-key.js` (AES-256-GCM per value; tag keys and photo names are HMACs). Encryption works inside the values, not on Yjs updates: the y-websocket server must read updates, and the server's tombstone purge still needs `deleted`/`deletedAt`.

**Exit test: passed.** A forged retraction is ignored, and the author's Troparcel writes the entry back (`test/scenarios/sync.test.js`). The server's stored files hold none of an encrypted room's text (`test/integration/e2ee-server.test.js`), and in real Tropy an encrypted project room delivers items, photos and notes to an empty project while the server stores no note text or photo in the clear (`test/e2e/project-room.e2e.js`). Every e2e run signs, so ed25519 works in Tropy's Electron.

Known limit: trust on first use. A member who first joins while someone has put a false key under a name pins that false key.

## Phase 6 · Publishable rooms

- Export a room as IIIF manifests with W3C Web Annotations: notes and selections become annotations on image regions (`#xywh=`), the format PosterForker reads.
- The server's `/monitor` grows into a read-only web view of a room.
- Later, only if Tropy adds an editor hook: character-level co-editing of notes through y-prosemirror.

**Exit test:** an exported room opens in a IIIF viewer with every note on its region.

Built: `src/iiif.js` turns Tropy's own export JSON-LD into Presentation 3 manifests with web annotations (`#xywh=` regions); a Troparcel entry with "Publish as IIIF to" set writes them on **File > Export**. Checked by `test/iiif.test.js` and the IIIF community parser (`@iiif/parser`), and in real Tropy: `test/e2e/iiif.e2e.js` runs **File > Export** through the driver plugin, and the manifest from Tropy's real export has the note on its canvas and the image copied. Not yet checked: opening a published folder in a IIIF viewer.

Not built: the `/monitor` web view of a room. A server cannot read an encrypted room, and for an open room a static IIIF export does the same job with less to maintain; it is dropped unless a group asks for it.

## Phase 7 · Easy for beginners

Tropy gives a plugin no place to draw, so everything Troparcel shows had to fit into tags, a list and a note footer, and setting it up meant running a server. This phase makes setup and everyday use work for someone who has never heard of a CRDT.

Done:

- **Troparcel's page** (`src/dashboard.js`): a local web page, opened from **File › Export** with the Troparcel entry, and by itself the first time. It sets Troparcel up (your name, then join with an invite or start a room), and shows whether sync works, who is online, what arrived, conflicts to settle ("use theirs" / "keep mine"), items with no match (different photo files), and the invite for new members.
- **Folder-first rooms:** `troparcel://folder/<name>` finds the room's folder in whichever sync app each member has, so one invite works for everyone, with no server.
- **Settings apply live:** Tropy re-creates the plugin; Troparcel closes its old connection cleanly (this was broken).
- **The installer:** `npx github:micahchoo/Troparcel install` finds every Tropy and installs.
- **Plain words:** settings, problems and the note footer ("— alice") rewritten for people; the README starts from the basics.
- **Project rooms carry photo names.**

Not planned: a hosted relay with short invite codes. It would be the easiest setup of all, but it is a running service someone must pay for and answer for. Folder-first rooms give most of the benefit at no cost.

**Exit test:** a newcomer installs, sets up from the page and syncs without a restart (`test/e2e/dashboard.e2e.js`, `test/installer.test.js`). Passes.

