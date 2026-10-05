# Troparcel roadmap

Troparcel is an **annotation overlay**: each person keeps their own photos, and only what they write about them travels. That premise makes it usable with archives whose photos cannot be shared, so it stays the default. The roadmap builds outward from it in rings:

**trustworthy overlay → scalable overlay → shared project → verifiable authorship → publishable room**

Each phase ends with an exit test you can run, not a list of features. Status as of 2026-10-05.

| Phase | Status |
|---|---|
| 0 · Ground truth | Done |
| 1 · Trustworthy overlay | Code done; the two-person trial is open |
| 2 · Upstream track | Proposal drafted, not sent |
| 3 · Scale | In progress |
| 4 · Shared project | Done: exit test passes in real Tropy |
| 5 · Verifiable authorship, private rooms | In progress |
| 6 · Publishable rooms | Not started |

## Phase 0 · Ground truth — done

- The agent-facing docs are deleted; facts that still hold are in `docs/DEVELOPER.md` › "Tropy internals that have bitten".
- `npm test` passes on a fresh clone, with no sibling folders.
- `.github/workflows/test.yml` runs the tests against Tropy 1.17.3 and `main`.

**Exit test:** a fresh clone passes `npm install && npm test`. Passed 2026-10-05. (CI has not yet run on GitHub.)

## Phase 1 · Trustworthy overlay

Done in 6.0.0:

- One code path to Tropy: the Redux store, as commands. The HTTP-API fallback, the file watcher and `rollback()` are gone.
- Room schema 5: no nested shared types, so concurrent first writes lose nothing.
- Two-field setup (Connection, Your name); the server prints connection strings.
- Visibility through Tropy's own things: `@name` tags, the **Troparcel: received** list, a footer on each received note. No dialogs.
- A collaborator's change adds nothing to the owner's undo history. (The plan said "one undo step per sync". Tropy's history reducer crashes on the empty `history.tick` that needs, so there is none.)
- `npm run e2e` checks every kind of data between two real Tropy instances.

Also done: an oversized entry is skipped alone; a deleted selection or transcription reaches the others; only an entry's author can tombstone it in the room.

Remaining:

- Release 6.0.0.

**Exit test:** two researchers on two machines use it for a week: no duplicate notes, no dialogs, no lost work. Open.

## Phase 2 · Upstream track

Troparcel's largest risk is that it depends on Tropy internals: any release can change an action shape. Propose small, general additions that any plugin could use (`docs/upstream-proposal.md`):

1. A documented store or event-subscription hook in the plugin context.
2. A notice call that takes plain text, not a translation key.
3. A way to group a plugin's commands without an undo entry, or a documented `history: false`.

These change the platform, not a fork, so "no host modification" still holds.

**Exit test:** a maintainer replies. This track is uncertain, so no other phase waits on it.

## Phase 3 · Scale

Done: create effects read a parent's child list; notes are found by a footer-key index; unchanged items keep their object and hash; one transaction per push; tag and list assignments are one command per tag or list. A first sync in real Tropy is linear, about 50 ms per note, spent in Tropy's own command (`test/e2e/scale.bench.js`).

Remaining:

- Keep the room on the client's disk, so a start sends and receives only the difference.
- Move the server from y-websocket 1.x to `@y/websocket-server`.
- Measure the exit test in real Tropy.

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

## Phase 6 · Publishable rooms

- Export a room as IIIF manifests with W3C Web Annotations: notes and selections become annotations on image regions (`#xywh=`), the format PosterForker reads.
- The server's `/monitor` grows into a read-only web view of a room.
- Later, only if Tropy adds an editor hook: character-level co-editing of notes through y-prosemirror.

**Exit test:** an exported room opens in a IIIF viewer with every note on its region.
