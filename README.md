# Troparcel

An annotation overlay collaboration layer for [Tropy](https://tropy.org).

Troparcel lets multiple researchers work on the same collection of research photos without sharing the photos themselves. Each person keeps their own local copy of the images; Troparcel syncs **annotations** — metadata, tags, notes, and selections — through a lightweight WebSocket relay using CRDTs.

## How it works

```
Researcher A                         Researcher B
┌───────────────┐                    ┌───────────────┐
│  Tropy + local│   Troparcel CRDT   │  Tropy + local│
│  photos/DB    │◄──── WebSocket ───►│  photos/DB    │
│               │                    │               │
│  Annotations  │  ← merge via Yjs → │  Annotations  │
│  (tags, notes,│                    │  (tags, notes,│
│   metadata)   │                    │   metadata)   │
└───────────────┘                    └───────────────┘
                    ┌──────────┐
                    │ Troparcel│
                    │  Server  │
                    │ (relay + │
                    │ persist) │
                    └──────────┘
```

Items are matched across instances by **photo checksum** (SHA-256). Since archival photos are immutable source material, their hashes are stable identifiers regardless of file location.

Conflict resolution is handled by [Yjs](https://docs.yjs.dev/) CRDTs:
- **Metadata**: per-property last-writer-wins (two users editing different fields merge cleanly)
- **Tags**: set union (both users' tags are kept)
- **Notes**: append (both users' notes are preserved)

## Quick start

### 1. Start the server

```bash
cd server
npm install
node index.js
```

Or with Docker:

```bash
docker compose up -d
```

The server runs on port **2468** by default. Open `http://localhost:2468/monitor` to see the dashboard.

### 2. Install the plugin

```bash
cd plugins/troparcel
npm install
npm run build
```

This bundles all third-party dependencies (Yjs, y-websocket, lib0) into a single `index.js` file, as recommended by [Tropy's plugin spec](https://github.com/tropy/tropy/blob/main/res/plugins/README.md#dependencies).

Copy the `troparcel` folder into Tropy's plugins directory. You can find this directory via **Help > Show Plugins Folder** in Tropy. Alternatively, for development, symlink it:

```bash
# Linux
ln -s /path/to/troparcel ~/.config/Tropy/plugins/troparcel

# macOS
ln -s /path/to/troparcel ~/Library/Application\ Support/Tropy/plugins/troparcel
```

### 3. Configure

In Tropy, go to **Preferences > Plugins > Troparcel** and set:

| Option | Description | Default |
|--------|-------------|---------|
| Server URL | WebSocket URL of your server | `ws://localhost:2468` |
| Room | Collaboration room name — all participants must match | *(project name)* |
| User ID | Your display name for attribution | |
| Auto Sync | Sync automatically in the background | `true` |
| Sync Interval | Seconds between sync polls | `10` |
| Tropy API Port | Tropy's local API port | `2019` |
| Room Token | Shared secret for room authentication | |

### 4. Collaborate

With auto-sync enabled, annotations flow automatically. Both researchers should:
1. Have the same photos imported into their own Tropy projects
2. Use the same **Room** name and **Server URL**
3. Set a unique **User ID**

Changes appear within one sync interval (default 10 seconds).

#### Manual mode

If auto-sync is off, use the File menu:
- **File > Export > Troparcel** — push selected items' annotations to the room (if nothing is selected, all items are exported)
- **File > Import > Troparcel** — pull annotations from the room into `payload.data` as JSON-LD items for Tropy to import

## Architecture

```
troparcel/
├── src/
│   ├── plugin.js        Main plugin entry — hooks into Tropy
│   ├── sync-engine.js   Background sync loop
│   ├── api-client.js    HTTP client for Tropy's local API
│   ├── crdt-schema.js   Yjs document structure
│   └── identity.js      Item matching by photo checksum
├── server/
│   ├── index.js         Collaboration server
│   ├── Dockerfile       Container build
│   └── package.json     Server dependencies
├── docker-compose.yml   One-click server deployment
├── esbuild.config.mjs   Plugin bundler config
├── package.json         Plugin package
└── index.js             Built plugin bundle (output)
```

### Modules

**identity.js** — Computes stable identity hashes for items using photo SHA-256 checksums. Multi-photo items use sorted+concatenated checksums. Falls back to template+title+date for items without photos.

**crdt-schema.js** — Defines the Yjs document structure. Per-item annotations use nested `Y.Map` for metadata (per-property merging) and `Y.Array` for tags/notes (append semantics). Every change carries author attribution and timestamp.

**api-client.js** — HTTP client wrapping Tropy's localhost REST API (port 2019). Reads items, metadata, tags, notes; writes metadata, tags, and notes back.

**sync-engine.js** — Connects to the collaboration server, polls the local Tropy API for changes, pushes local annotations into the CRDT, and applies remote CRDT changes back to Tropy. Runs as a background loop.

**plugin.js** — The Tropy plugin class. Wires everything together. Starts background sync on load; provides [export/import hooks](https://github.com/tropy/tropy/blob/main/res/plugins/README.md#hooks) as a manual fallback.

### Plugin context

Tropy passes a `context` object to every plugin with:
- `logger` — write to Tropy's log
- `dialog` — open native file/message dialogs
- `json.expand()` / `json.compact()` — JSON-LD processing via [jsonld.js](https://github.com/digitalbazaar/jsonld.js)
- `window` — read-only access to the current project, installed templates, and vocabularies

Troparcel uses `window.project.name` to auto-derive the room name when none is configured.

## Server

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Listen port | `2468` |
| `HOST` | Bind address | `0.0.0.0` |
| `PERSISTENCE_DIR` | LevelDB data directory | `./data` |
| `AUTH_TOKENS` | Comma-separated `room:token` pairs | *(empty = open)* |

### API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /api/status` | Server stats |
| `GET /api/rooms` | List active rooms |
| `GET /api/rooms/:name` | Room details + users |
| `GET /monitor` | Web dashboard |

### Authentication

Set `AUTH_TOKENS` to require tokens for specific rooms:

```bash
AUTH_TOKENS="my-room:s3cret,team-room:p@ssw0rd" node server/index.js
```

Rooms without a configured token remain open. Clients pass their token as a query parameter on the WebSocket URL.

### Docker deployment

```bash
docker compose up -d
```

Persistent data is stored in the `troparcel-data` Docker volume. To set auth tokens, uncomment the `AUTH_TOKENS` line in `docker-compose.yml`.

## What gets synced (and what doesn't)

| Synced | Not synced |
|--------|------------|
| Metadata (title, date, creator, etc.) | Photos / image files |
| Tags (name + color) | Photo file paths |
| Notes (text + HTML) | Internal SQLite IDs |
| Selections (region coordinates) | List membership |
| Author attribution | Project settings |

Photos are never transferred. Both researchers must have their own copies of the source images imported into their Tropy projects. Troparcel matches items by photo checksum, so the images must be identical files.

## Security

- **Room tokens** provide basic authentication per room
- **No encryption** — data travels as plaintext WebSocket frames. For sensitive material, run the server on a private network or behind a TLS-terminating reverse proxy (nginx, Caddy, etc.)
- **Room names are not secrets** — use tokens for access control
- **The server sees all data** — self-host if privacy is a concern

## Development

```bash
# Install plugin dependencies
npm install

# Build plugin bundle
npm run build

# Watch for changes during development
npm run watch

# Start the collaboration server
npm run server
```

## License

AGPL-3.0
