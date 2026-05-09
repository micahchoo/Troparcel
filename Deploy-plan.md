---
shaping: true
---

# Deploy Templates — V-Plan

Parent: [shaping.md](shaping.md) → [slices.md](slices.md)
Source: [shaping.md](shaping.md) R5 → [slices.md](slices.md) Deploy

## Demo Criterion

Coordinator clicks "Deploy to Render" in README → gets a running server → server prints connection string → coordinator shares with team.

## File Scope

| File | Changes |
|------|---------|
| `render.yaml` | **NEW** — Render blueprint (free tier, persistent disk) |
| `railway.json` | **NEW** — Railway deploy config |
| `server/index.js` | Print connection string on startup. Add shebang for npx. |
| `server/package.json` | Add `bin` field for `npx troparcel-server` |

## Build Sequence

1. Add shebang (`#!/usr/bin/env node`) to server/index.js
2. Add connection string output after "listening" log line
3. Add `bin` field to server/package.json
4. Create `render.yaml` — web service, node runtime, env vars, persistent disk
5. Create `railway.json` — nixpacks builder, restart policy
6. Test: `node server/index.js` prints connection string
