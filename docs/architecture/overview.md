# Troparcel — Architecture Overview

> **Status:** synthesis-only audit (2026-05-08). Maps existing canonical docs and verifies drift between them and current `src/`. Does not paraphrase the canonical docs — read them directly.

## What this is

Troparcel is a **Tropy plugin** (CommonJS, Electron renderer, AGPL-3.0) that adds CRDT-based multi-instance collaboration to the [Tropy](https://tropy.org) photo-research app. It wraps a Yjs document, runs alongside Tropy's Redux store, and synchronizes annotations (notes, tags, metadata, selections, transcriptions, lists) over a self-hosted WebSocket relay.

A second tree, `troparcel/server/`, is a small Node service: y-websocket relay + LevelDB persistence + monitor dashboard. Deployed via `docker-compose.yml`.

## Project shape

**Library + small backend.** Single npm package (the plugin) + a sibling `server/` package. No monorepo workspace. No git in this directory (the workspace lives at the parent).

- Plugin code → `src/` bundles into `index.js` via `esbuild.config.mjs`
- Server code → `server/` (separate `package.json`)
- Built output is committed (`index.js`, `index.js.map`) — Tropy expects a single bundled file (see `tropy/res/plugins/README.md`)

## Canonical documents — read these first

| Doc | Role | When to load |
|---|---|---|
| [README.md](../../README.md) | User-facing — install, configure, modules, server, security, port conflicts | Anyone setting up or running |
| [docs/COMPREHENSIVE_DOCUMENTATION.md](../COMPREHENSIVE_DOCUMENTATION.md) | Full technical reference | Implementation deep-dives |
| [docs/CONFLICTS.md](../CONFLICTS.md) | Conflict-resolution strategy per data type | Before changing merge semantics |
| [docs/DEVELOPER.md](../DEVELOPER.md) | Architecture + contribution guide | New contributor onboarding |
| [docs/SETUP.md](../SETUP.md) | 3-network-scenario deployment guide | Operator-mode work |
| [docs/GUIDE.md](../GUIDE.md) | Group-collaboration end-user guide | UX / docs work |
| [docs/API.md](../API.md) | Tropy HTTP API reference (used by `api-client.js`) | Touching enrichment / fallback path |
| [docs/CHANGELOG.md](../CHANGELOG.md) | Version history + migration notes | Release work |
| `tropy design spec.md` *(repo root)* | Tropy entity model reverse-engineered from its test suite | Touching identity, entity shapes, RDF metadata |
| `troparcel-audit.md` *(repo root)* | Section-by-section critique vs. design spec | Hardening / catching drift |
| `shaping.md` *(repo root)* | Shape-Up shaping doc — current baseline + selected shape (Batteries-Included + Full Project Sync) | Scope decisions |
| `slices.md` *(repo root)* | V1–V5 vertical slices with status per part | Tracking implementation progress |
| `crdt-design.md`, `crdt-feasibility.md` | Foundational CRDT design + feasibility analysis | Yjs document layout decisions |
| `spike-sync-architecture.md`, `spike-yjs-fullcap.md` | Spike write-ups | Background on architectural choices |
| `V2-plan.md` … `V5-plan.md`, `Vtest-plan.md`, `Deploy-plan.md`, `Docs-plan.md`, `ConnStr-plan.md` | Per-slice execution plans | Active implementation work |

## Architecture in one sentence

`plugin.js` boots a `SyncEngine`, which connects a `Yjs.Doc` over `y-websocket` (or a transport adapter) to a Tropy project's Redux store via `StoreAdapter`, with `push.js`/`apply.js` mixins translating in both directions and `vault.js` persisting per-room dedup state.

For module-by-module detail: [README — Architecture section](../../README.md#architecture).
For subsystem boundaries and current state: [subsystems.md](./subsystems.md).
For drift findings (audit claims verified against current code): [risk-map.md](./risk-map.md).

## Knowledge stores in this workspace

- **Mulch** at `../../../.mulch/expertise/` (workspace-level, shared with `tropy/` and `plugins/`)
  - `sync.jsonl` (6 records) — Yjs / store-adapter conventions and failures specific to troparcel
  - `meta.jsonl` — workspace-meta records (skill-tree drift, not project-relevant)
- **Memory** at `~/.claude/projects/-mnt-Ghar-2TA-DevStuff-tropy-plugin/memory/` (auto-managed)
- **Seeds** — not initialized at workspace level (see [risk-map.md](./risk-map.md) for tracked issues)

## Provenance

| Source | Authority |
|---|---|
| README + docs/ | Author-maintained, user-facing |
| `tropy design spec.md` | Reverse-engineered from `tropy/test/` fixtures — high fidelity but not author-of-Tropy |
| `troparcel-audit.md` | Critique against the design spec |
| `shaping.md` baseline (2026-02-28) | Last hand-verified state-of-the-world |
| This `docs/architecture/` tree | Synthesis 2026-05-08, drift-verified against `src/` HEAD |
