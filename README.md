# Troparcel

> AI-written (Claude Opus); in use and still being tested.

Troparcel lets a group of researchers annotate the same photos in [Tropy](https://tropy.org), each in their own project.

Each person keeps their own copy of the photos. Troparcel shares what you write about them: notes, tags, metadata, selections, transcriptions and lists. It matches items by their photos' checksums, so the photos never leave your computer.

## How it works

```
 alice's Tropy                                   bob's Tropy
 photos + project ──┐                      ┌── photos + project
                    │   notes, tags, ...   │
                    └──►  a room on a  ◄───┘
                         Troparcel server
                       (or a shared folder)
```

A **room** is a shared document. Everyone in a group connects to the same room. Each Tropy writes its changes into the room and applies everyone else's. The room is a [Yjs](https://docs.yjs.dev/) CRDT, so changes made at the same time merge without a central authority, and someone who was offline catches up when they reconnect.

The room travels through either:

- **a Troparcel server** that you run (a small Node program, or Docker), or
- **a shared folder** that you already sync, such as Nextcloud, Dropbox or Syncthing. No server is needed.

## Quick start

**1. Start a server** (skip this if you use a shared folder):

```bash
git clone https://github.com/micahchoo/Troparcel.git
cd Troparcel
docker compose up -d       # or: cd server && npm install && node index.js
```

The server prints a **connection string** for each room, for example:

```
troparcel://ws/192.168.0.20:2468/letters?token=…
```

**2. Install the plugin.** Download `troparcel.zip` from the [releases page](https://github.com/micahchoo/Troparcel/releases). In Tropy, choose **Help > Show Plugins Folder**, extract the zip there and restart Tropy.

**3. Fill in two fields** in **Preferences > Plugins > Troparcel**:

| Field | What to enter |
|---|---|
| Connection | The connection string from the server, or the path of your shared folder |
| Your name | A name no one else in the group uses |

Restart Tropy. Everyone in the group must have imported the **same photo files**.

The [Group Guide](docs/GUIDE.md) covers each setup step by step: one computer, a local network, the internet, and a shared folder.

## What you see in Tropy

Tropy has no place for a plugin to draw, so Troparcel uses Tropy's own tags, metadata and lists:

- **`@alice`**: a tag on each item that alice contributed to.
- **Troparcel: received**: a list of the items that received a collaborator's change.
- **Notes from others** end with a small line: `[troparcel:… from alice — safe to delete, do not edit]`.
- **Contributors** and **Last sync**: two metadata fields on each item that received changes.

These stay on your computer. Troparcel never sends them to the room.

A collaborator's change never enters your undo history, and it does not move your view away from what you are working on.

## What is shared

| Shared | Not shared |
|---|---|
| Item metadata | Photo files |
| Tags | File paths |
| Notes on photos and selections | Tropy's internal ids |
| Selections (photo regions) | Window layout, preferences |
| Transcriptions | |
| Lists and list membership (option) | |
| Photo and selection metadata (option) | |
| Templates you made | |
| Deletions: your notes, tags and list membership (option) | |

Before applying anything, Troparcel saves a JSON copy of each item it is about to change to `~/.troparcel/backups/<room>/`.

## Options

| Option | Default | What it does |
|---|---|---|
| Connection | | Server connection string, `ws://` address, or shared folder path |
| Your name | | Shown to others as `@name` on what you contribute |
| Mode | `auto` | `auto`: share and receive. `review`: share; receive on **File > Import > Troparcel**. `push`: share only. `pull`: receive only, on import |
| Share deletions | off | A note you delete is struck through for others (only its author can retract it); a tag or list membership you remove is removed for others. Deleted selections and transcriptions are not shared yet |
| Share lists | off | Share your list tree and list membership |
| Share photo and selection metadata | off | Share metadata on photos and selections, not only on items |
| Debug logging | off | Detailed messages in Tropy's log (**Help > Show Log Files**) |

## When people edit the same thing

| Data | What happens |
|---|---|
| A metadata field | Each field merges on its own. If you and a collaborator both change the same field before syncing, your value stays on your side and the conflict is logged |
| Tags | An add beats a concurrent remove. Names compare case-insensitively, as Tropy does |
| Notes, selections, transcriptions | Everyone's entries are kept side by side. Only a note's author can retract it |
| Lists | Matched by name |

[docs/CONFLICTS.md](docs/CONFLICTS.md) gives the full rules.

## Security

- A **room token** in the connection string keeps other people out of a room.
- Notes from others are **sanitised** before they reach Tropy: only the formatting Tropy's editor supports gets through.
- The server does **not** encrypt. Over the internet, put it behind a TLS proxy (the guide shows Caddy) and use a `troparcel://wss/…` string.

## Server

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `2468` | Listen port |
| `PUBLIC_URL` | LAN address | The address collaborators use, e.g. `wss://tropy.example.edu`. Goes into the printed connection strings |
| `AUTH_TOKENS` | none (open) | `room:token` pairs, comma-separated |
| `PERSISTENCE_DIR` | `./data` | Where rooms are stored (LevelDB) |
| `MONITOR_TOKEN` | none | Protects `/monitor` and the room API |
| `TOMBSTONE_MAX_DAYS` | `30` | Retractions older than this are purged |

`http://<server>:2468/monitor` shows rooms and who is connected.

## Development

```bash
npm install
npm test          # unit, scenario and integration tests
npm run e2e       # two real Tropy instances (Flatpak, headless), see test/README.md
npm run build     # bundles src/ into index.js
```

[docs/DEVELOPER.md](docs/DEVELOPER.md) explains the design. [docs/CHANGELOG.md](docs/CHANGELOG.md) lists changes.

## License

[AGPL-3.0](LICENSE)
