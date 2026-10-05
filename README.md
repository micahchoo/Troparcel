# Troparcel

> AI-written (Claude Opus); in use and still being tested. See [Status](#status).

Troparcel lets a group annotate the same photos in [Tropy](https://tropy.org), each person in their own project.

What one person writes (notes, tags, metadata, selections, transcriptions, lists) appears in everyone else's Tropy within seconds. Each person keeps working in their own project, offline if they want; changes merge when they reconnect.

## How it works

```
 alice's Tropy                                   bob's Tropy
 photos + project ──┐                      ┌── photos + project
                    │   notes, tags, ...   │
                    └──►     a room     ◄──┘
                     on a Troparcel server,
                       or a shared folder
```

A **room** is one shared [Yjs](https://docs.yjs.dev/) document, which merges changes made at the same time without a central authority. Each Tropy writes its changes into the room and applies everyone else's. Items are matched across projects by their photos' checksums, so the same photo file is the same item everywhere.

The room travels through either:

- **a Troparcel server** that you run (Node, or Docker), or
- **a shared folder** that you already sync: Nextcloud, Dropbox, Syncthing. No server is needed.

## Quick start

**1. Start a server** (skip this if you use a shared folder):

```bash
git clone https://github.com/micahchoo/Troparcel.git
cd Troparcel
docker compose up -d       # or: cd server && npm install && node index.js
```

The server prints a **connection string** for each room:

```
troparcel://ws/192.168.0.20:2468/letters?token=…
```

**2. Install the plugin** in each person's Tropy (1.17 or later). Download `troparcel.zip` from the [releases page](https://github.com/micahchoo/Troparcel/releases). In Tropy, choose **Help > Show Plugins Folder**, extract the zip there, and restart Tropy.

**3. Fill in two fields** in **Preferences > Plugins > Troparcel**, then restart Tropy:

| Field | What to enter |
|---|---|
| Connection | The connection string, or the path of the shared folder |
| Your name | A name no one else in the group uses |

The [Group Guide](docs/GUIDE.md) walks through each setup: one computer, a local network, the internet, a shared folder.

## Three kinds of room

| Room | Connection string | Photos | Use it when |
|---|---|---|---|
| **Overlay** (default) | as printed | Stay on each computer. Everyone imports the same photo files | The photos may not be copied (archive rules) |
| **Project room** (6.1) | ends in `&photos=1` | Travel with the room. A new member can start from an empty project | The group may share its photos |
| **Encrypted** (6.1) | adds `&key=…` | As above, but sealed | The server should not be able to read the work |

In an overlay room, the photo files must be identical, byte for byte. A re-saved or converted copy has another checksum, and that item does not sync.

## What you see in Tropy

Tropy gives plugins no place to draw, so Troparcel uses Tropy's own tags, lists and metadata:

- **`@alice`**: a tag on each item alice contributed to;
- **Troparcel: received**: a list of the items that received a collaborator's change;
- a small last line on each note from someone else: `[troparcel:… from alice — safe to delete, do not edit]`;
- **Contributors** and **Last sync**: two metadata fields on each item that received changes.

These stay on your computer; Troparcel never sends them to the room. A collaborator's change never enters your undo history and does not move your view.

## What is shared

| Shared | Not shared |
|---|---|
| Item metadata | Photo files (except in a project room) |
| Tags | File paths |
| Notes on photos and selections | Tropy's internal ids |
| Selections (photo regions) | Window layout, preferences |
| Transcriptions | |
| Templates you made | |
| Lists and list membership (option) | |
| Photo and selection metadata (option) | |
| Deletions of what you wrote (option) | |

Before it changes anything in your project, Troparcel saves a JSON copy of each item it is about to change, in `~/.troparcel/backups/<room>/`.

## When people edit the same thing

| Data | What happens |
|---|---|
| A metadata field | Each field merges on its own. If you and a collaborator both change one field before syncing, your value stays on your side and the conflict is logged |
| Tags | An add beats a concurrent remove. Names compare case-insensitively, as in Tropy |
| Notes, selections, transcriptions | Everyone's are kept side by side. Only an entry's author can delete it for others |
| Lists | Matched by name |

[docs/CONFLICTS.md](docs/CONFLICTS.md) gives the full rules.

## Publish as IIIF (6.1)

Troparcel can publish items as [IIIF](https://iiif.io) manifests for the web: each photo a canvas, each note and transcription a web annotation, a note on a selection placed on its region. Add a second Troparcel entry in **Preferences > Plugins**, set **Publish as IIIF to** (a folder) and **IIIF web address** (where that folder will be online), then select items and choose **File > Export** with that entry. Upload the folder; IIIF viewers open `collection.json`.

## Options

| Option | Default | What it does |
|---|---|---|
| Connection | | Connection string, `ws://` address, or shared-folder path |
| Your name | | Shown to others as `@name` |
| Mode | `auto` | `auto`: share and receive. `review`: share; receive on **File > Import > Troparcel**. `push`: share only. `pull`: receive only, on import |
| Share deletions | off | What you delete is deleted for others: your notes are struck through, your selections and transcriptions removed, tags and list membership removed |
| Share lists | off | Share the list tree and list membership |
| Share photo and selection metadata | off | Share metadata on photos and selections, not only items |
| Publish as IIIF to, IIIF web address | | Make this entry publish IIIF on File > Export (6.1) |
| Debug logging | off | Detailed messages in Tropy's log (**Help > Show Log Files**) |

## Security

- A **room token** in the connection string keeps other people out of a room.
- **Signed authorship** (6.1): each member signs what they write with a key made on their own computer. Nobody can delete your work for others, or write in your name, even with the room token.
- **End-to-end encryption** (6.1): with `key=…` in the connection string, the server, or the shared folder, holds only ciphertext, photos included. Make a key with `node server/index.js --new-key`. Anyone with the string can read the room; send it like a password.
- Notes from others are **sanitised** before they reach Tropy: only the formatting Tropy's editor supports gets through.
- The server does not use TLS itself. Over the internet, put it behind a TLS proxy (the guide shows Caddy) and use a `troparcel://wss/…` string.

## Server

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `2468` | Listen port |
| `PUBLIC_URL` | LAN address | The address collaborators use, e.g. `wss://tropy.example.edu`; goes into the printed connection strings |
| `AUTH_TOKENS` | none (open) | `room:token` pairs, comma-separated |
| `PERSISTENCE_DIR` | `./data` | Where rooms and project-room photos are stored |
| `MONITOR_TOKEN` | none | Protects `/monitor` and the room API |
| `TOMBSTONE_MAX_DAYS` | `30` | Deletion markers older than this are purged |
| `MAX_BLOB_MB` | `200` | Largest photo a project room may store |

`http://<server>:2468/monitor` shows rooms and who is connected.

## Status

**Released:** [6.0.0](https://github.com/micahchoo/Troparcel/releases/tag/v6.0.0), overlay rooms. **On `main`, for 6.1:** project rooms, signed authorship, encryption, IIIF publishing, and fixes to how a large project starts. Features marked 6.1 above are not in the 6.0.0 download.

What has been checked, and what not:

| Checked | How |
|---|---|
| Every kind of data, both ways, saved by Tropy | `npm run e2e`: two real Tropy instances and a third peer |
| A project room: an empty Tropy receives items, photos and notes | e2e, real Tropy |
| Concurrent edits lose nothing | scenario tests (two sync engines) and room-level tests |
| The server stores no plaintext of an encrypted room | integration test that reads the server's files |
| A 10,000-item project | real Tropy: the first sync grows linearly with the number of notes (about 10 minutes, measured on a disk busy with a RAID check) |

| Not yet checked | |
|---|---|
| A group using it for a week on separate computers | the [roadmap](ROADMAP.md)'s Phase 1 exit test |
| Signatures, encryption and IIIF export inside real Tropy | they pass outside it; the e2e run is next |
| Start-up time of a 10,000-item project | being measured again after a start-up fix |

**Upgrade a group together.** 6.0 changed the room's layout; 6.0 converts a room written by 5.x on first open, but 5.x cannot read it. An encrypted room cannot be read by a version without encryption.

## Development

```bash
npm install
npm test          # unit, scenario and integration tests
npm run e2e       # real Tropy instances (Flatpak, headless); see test/README.md
npm run build     # bundle src/ into index.js
```

[docs/DEVELOPER.md](docs/DEVELOPER.md) explains the design, [ROADMAP.md](ROADMAP.md) where it is going, and [docs/CHANGELOG.md](docs/CHANGELOG.md) what changed.

## License

[AGPL-3.0](LICENSE)
