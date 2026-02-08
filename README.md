# Troparcel

An annotation overlay collaboration layer for [Tropy](https://tropy.org).

Troparcel lets multiple researchers work on the same collection of research photos without sharing the photos themselves. Each person keeps their own local copy of the images; Troparcel syncs **annotations** — metadata, tags, notes, selections, transcriptions, and list membership — through a lightweight WebSocket relay using CRDTs.

<!-- TODO: screenshot of two Tropy windows side by side with synced annotations -->

## How it works

```
Researcher A                         Researcher B
┌───────────────┐                    ┌───────────────┐
│  Tropy + local│   Troparcel CRDT   │  Tropy + local│
│  photos/DB    │◄──── WebSocket ───►│  photos/DB    │
│               │                    │               │
│  Annotations  │  ← merge via Yjs → │  Annotations  │
│  (tags, notes,│                    │  (tags, notes,│
│   metadata,   │                    │   metadata,   │
│   selections, │                    │   selections, │
│   etc.)       │                    │   etc.)       │
└───────────────┘                    └───────────────┘
                    ┌──────────┐
                    │ Troparcel│
                    │  Server  │
                    │ (relay + │
                    │ persist) │
                    └──────────┘
```

Items are matched across instances by **photo checksum** (SHA-256). Since archival photos are immutable source material, their hashes are stable identifiers regardless of file location.

Troparcel communicates with Tropy through its **local HTTP API**, which runs on port **2019** by default. This API must be enabled and reachable for the plugin to read and write annotations. The plugin never touches Tropy's SQLite database directly.

Sync is **event-driven**: local changes are detected via file system watching on the `.tpy` database file, and remote changes from collaborators are applied as they arrive over the WebSocket connection. A configurable safety-net poll runs periodically to catch anything the watcher misses.

For the full conflict resolution strategy, see [CONFLICTS.md](CONFLICTS.md).
For the Tropy HTTP API reference used internally, see [API.md](API.md).

## Quick start

### 1. Download and start the server

Clone or download the Troparcel repository, then start the collaboration server:

```bash
git clone https://github.com/your-org/troparcel.git
cd troparcel/server
npm install
node index.js
```

Or with Docker:

```bash
cd troparcel
docker compose up -d
```

The server runs on port **2468** by default. Open `http://localhost:2468/monitor` to see the dashboard.

<!-- TODO: screenshot of the server monitor dashboard -->

### 2. Install the plugin

There are two ways to install:

#### Option A: From the pre-built zip (easiest)

1. Download `troparcel.zip` from the [releases page](https://github.com/your-org/troparcel/releases).
2. In Tropy, go to **Help > Show Plugins Folder** to open your plugins directory.
3. Extract the zip into that folder so you end up with a `troparcel` subfolder containing `package.json` and `index.js`.
4. Restart Tropy. Troparcel should now appear under **Preferences > Plugins**.

#### Option B: Build from source

```bash
cd troparcel
npm install
npm run build
```

This bundles all third-party dependencies (Yjs, y-websocket, lib0) into a single `index.js` file, as recommended by [Tropy's plugin spec](https://github.com/tropy/tropy/blob/main/res/plugins/README.md#dependencies).

Copy the `troparcel` folder into Tropy's plugins directory (found via **Help > Show Plugins Folder** in Tropy). For development, you can symlink it instead:

```bash
# Linux
ln -s /path/to/troparcel ~/.config/Tropy/plugins/troparcel

# macOS
ln -s /path/to/troparcel ~/Library/Application\ Support/Tropy/plugins/troparcel
```

### 3. Configure

In Tropy, go to **Preferences > Plugins > Troparcel** and set:

<!-- TODO: screenshot of the plugin settings panel in Tropy preferences -->

#### Connection settings

| Option | Description | Default |
|--------|-------------|---------|
| Server URL | WebSocket URL of your Troparcel server | `ws://localhost:2468` |
| Room | Collaboration room name — all participants must match | *(project name)* |
| User ID | Your display name for attribution | |
| Room Token | Shared secret for room authentication | |
| Tropy API Port | Port of Tropy's local HTTP API (see [Port conflicts](#port-conflicts)) | `2019` |

#### Sync settings

| Option | Description | Default |
|--------|-------------|---------|
| Auto Sync | Sync automatically in the background | `true` |
| Sync Mode | `auto` (apply immediately) or `review` (apply on Import) | `auto` |
| Sync Photo Adjustments | Sync brightness, contrast, saturation, etc. | `false` |
| Sync Lists | Sync list membership between collaborators | `false` |

#### Timing settings

| Option | Description | Default |
|--------|-------------|---------|
| Startup Delay (ms) | Wait before first sync after connecting | `8000` |
| Local Change Debounce (ms) | Wait after a local DB change before pushing | `2000` |
| Remote Change Debounce (ms) | Wait after a remote change before applying | `500` |
| Safety Net Interval (seconds) | Periodic full sync fallback (0 to disable) | `120` |
| Write Delay (ms) | Pause between API writes to avoid DB locks | `100` |

#### Safety settings

| Option | Description | Default |
|--------|-------------|---------|
| Max Backups | Backup snapshots to keep per room | `10` |
| Max Note Size (bytes) | Reject remote notes larger than this | `1048576` (1 MB) |
| Max Metadata Size (bytes) | Reject remote metadata values larger than this | `65536` (64 KB) |
| Tombstone Flood Threshold | Warn if more than this fraction of an item's data is deleted in one sync | `0.5` |

#### Debug

| Option | Description | Default |
|--------|-------------|---------|
| Debug Logging | Verbose logging to Tropy's developer console | `false` |

### 4. Collaborate

With auto-sync enabled, annotations flow automatically. Both researchers should:
1. Have the same photos imported into their own Tropy projects
2. Use the same **Room** name and **Server URL**
3. Set a unique **User ID**

Changes appear within seconds of being made.

For a detailed walkthrough of different collaboration scenarios (same machine, local network, over the internet), see the **[Setup Guide](SETUP.md)**.

#### Sync modes

**Auto mode** (`syncMode: "auto"`): Changes from other collaborators are applied to your local project as soon as they arrive. This is the default — near-real-time collaboration.

**Review mode** (`syncMode: "review"`): Your local changes are still pushed automatically, but remote changes accumulate in the CRDT without being applied. When you're ready, use **File > Import > Troparcel** to pull and apply them. The import logs a summary of what each collaborator changed before applying.

<!-- TODO: screenshot of the import summary log -->

#### Manual export/import

If auto-sync is off, use the File menu:
- **File > Export > Troparcel** — push selected items' annotations to the room
- **File > Import > Troparcel** — pull annotations from the room and apply them locally

## What gets synced

| Synced | Not synced |
|--------|------------|
| Item metadata (title, date, creator, etc.) | Photos / image files |
| Tags (name, color, removal) | Photo file paths |
| Notes (text, HTML, updates, deletion) | Internal SQLite IDs |
| Photo metadata (when enabled) | Project settings |
| Selections (region coordinates) | Templates / vocabularies |
| Selection metadata and notes | |
| Transcriptions | |
| List membership (when enabled) | |
| Author attribution per change | |

Photos are never transferred. Both researchers must have their own copies of the source images imported into their Tropy projects. Troparcel matches items by photo checksum, so the images must be identical files.

## Conflict resolution

Troparcel uses [Yjs](https://docs.yjs.dev/) CRDTs for automatic conflict resolution:

| Data type | Strategy | Concurrent edits |
|-----------|----------|-----------------|
| Metadata | Per-property last-writer-wins | Different fields merge cleanly; same field: latest timestamp wins |
| Tags | Add-wins OR-Set | Add + remove at the same time: add wins |
| Notes | Last-writer-wins per note | Both users' distinct notes are kept; same note: latest wins |
| Selections | Last-writer-wins per region | Position conflicts: latest wins |
| Transcriptions | Last-writer-wins | Content conflicts: latest wins |
| Lists | Add-wins set | Add + remove: add wins |

Deletions use **tombstones** — a deleted tag or note is marked as removed rather than erased, so it won't be re-created by a lagging peer.

For the full strategy document, see **[CONFLICTS.md](CONFLICTS.md)**.

## Backup & safety

Before applying remote changes, Troparcel saves a JSON snapshot of every item that will be modified. Snapshots are stored at `~/.troparcel/backups/<room>/` with configurable retention (default: last 10). If something goes wrong, the snapshot can restore the previous state.

Inbound validation guards protect against corrupted or malicious data:
- Notes and transcriptions over the configured size limit are rejected
- Metadata values over the configured size limit are rejected
- If more than 50% of an item's data is tombstoned in one sync, a warning is logged

## Architecture

```
troparcel/
├── src/
│   ├── plugin.js        Main plugin entry — hooks, lifecycle, settings
│   ├── sync-engine.js   Watch-based sync engine — push/apply all data types
│   ├── api-client.js    HTTP client for Tropy's local API (full CRUD)
│   ├── crdt-schema.js   Yjs document structure (v3 — all Y.Map, tombstones)
│   ├── identity.js      Item/selection/note/transcription key computation
│   ├── backup.js        Pre-apply snapshots, validation, rollback
│   └── sanitize.js      HTML sanitizer for remote note content
├── server/
│   ├── index.js         Collaboration server (WebSocket relay + LevelDB)
│   ├── Dockerfile       Container build
│   └── package.json     Server dependencies
├── docker-compose.yml   One-click server deployment
├── esbuild.config.mjs   Plugin bundler config
├── package.json         Plugin package + all configurable options
├── CONFLICTS.md         Conflict resolution strategy document
├── API.md               Tropy HTTP API reference
├── SETUP.md             Non-technical setup guide for 3 scenarios
└── index.js             Built plugin bundle (output)
```

### Modules

**plugin.js** — The Tropy plugin class. Manages 20 configurable settings, starts the sync engine, provides export/import hooks. Supports auto and review sync modes.

**sync-engine.js** — Watches the `.tpy` database file for local changes (debounced), pushes all annotation types into the CRDT, and applies remote changes as they arrive. Integrates the backup system for safe applies. Handles deletion detection via snapshot diffing.

**crdt-schema.js** — Defines the Yjs document structure. All per-item collections use `Y.Map` for proper update/delete support via tombstones. Nine sections per item: metadata, tags, notes, photos, selections, selectionMeta, selectionNotes, transcriptions, lists.

**api-client.js** — HTTP client wrapping Tropy's localhost REST API. Full CRUD for items, metadata, tags, notes, photos, selections, transcriptions, and lists. Includes SQLITE_BUSY retry with exponential backoff. See **[API.md](API.md)** for the endpoint reference.

**identity.js** — Computes stable identity hashes for items using photo SHA-256 checksums. Also computes stable keys for selections (by photo checksum + coordinates), notes (by content hash + parent), and transcriptions (by photo + index).

**backup.js** — Saves JSON snapshots before applying remote changes. Validates inbound data (size guards, tombstone flood protection). Provides rollback by replaying snapshots via the API.

**sanitize.js** — Strips dangerous HTML from remote note content to prevent XSS in Tropy's Electron renderer.

## Server

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Listen port | `2468` |
| `HOST` | Bind address | `0.0.0.0` |
| `PERSISTENCE_DIR` | LevelDB data directory | `./data` |
| `AUTH_TOKENS` | Comma-separated `room:token` pairs | *(empty = open)* |
| `MAX_ROOMS` | Maximum concurrent rooms | `100` |
| `MAX_CONNS_PER_IP` | Maximum connections per IP | `10` |
| `MONITOR_ORIGIN` | Allowed CORS origin for monitor API | *(none)* |

### API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /api/status` | Server stats (uptime, rooms, connections) |
| `GET /api/rooms` | List active rooms |
| `GET /api/rooms/:name` | Room details + connected users |
| `POST /api/rooms/:name/purge-users` | Remove stale user entries |
| `GET /monitor` | Web dashboard |

### Authentication

Set `AUTH_TOKENS` to require tokens for specific rooms:

```bash
AUTH_TOKENS="my-room:s3cret,team-room:p@ssw0rd" node server/index.js
```

Rooms without a configured token remain open. Clients pass their token via the **Room Token** plugin setting.

### Docker deployment

```bash
docker compose up -d
```

Persistent data is stored in the `troparcel-data` Docker volume. To set auth tokens, uncomment the `AUTH_TOKENS` line in `docker-compose.yml`.

<!-- TODO: screenshot of docker compose logs showing server startup -->

## Security

- **Room tokens** provide per-room authentication (timing-safe comparison)
- **HTML sanitization** — all remote note content is sanitized before being applied locally, preventing XSS in Tropy's Electron renderer
- **Size guards** — oversized remote data is rejected before it reaches Tropy
- **No encryption** — data travels as plaintext WebSocket frames. For sensitive material, run the server behind a TLS-terminating reverse proxy (nginx, Caddy, etc.) or use SSH tunneling
- **No file path sharing** — Troparcel never sends or accepts file paths, preventing path traversal attacks
- **Rate limiting** — the server caps connections per IP and total rooms

## Port conflicts

Troparcel uses two network ports:

| Port | Used by | Purpose |
|------|---------|---------|
| **2019** | Tropy | Local HTTP API that Troparcel calls to read/write annotations |
| **2468** | Troparcel server | WebSocket relay for CRDT sync between instances |

**Tropy API port (2019):** Tropy starts its built-in HTTP API on port 2019 by default. If something else on your system is already using port 2019, or if you are running multiple Tropy instances on the same machine, only the first instance will bind successfully — the second will fail to start its API or use a different port. Check Tropy's developer console (**Help > Toggle Developer Tools**) on startup to confirm which port it is listening on, and set the **Tropy API Port** in the plugin settings to match.

**Troparcel server port (2468):** If port 2468 is taken by another service, start the server on a different port using the `PORT` environment variable:

```bash
PORT=3000 node server/index.js
```

Then update the **Server URL** in every collaborator's plugin settings to match (e.g. `ws://localhost:3000`).

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
