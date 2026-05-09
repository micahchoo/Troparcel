---
shaping: true
---

# Connection String — V-Plan

Parent: [SHAPING.md](../SHAPING.md) → [slices.md](../design/slices.md)
Source: [SHAPING.md](../SHAPING.md) R5 → [slices.md](../design/slices.md) ConnStr

## Demo Criterion

Researcher pastes `troparcel://ws/server.edu:2468/room?token=abc` into plugin settings. Plugin auto-configures transport, server URL, room, and token. Two fields total (connection string + name).

## Affordances

| # | Affordance | Type | Wires |
|---|------------|------|-------|
| N1 | `parseConnectionString()` — parse `troparcel://` URI into option fields | Non-UI | Called by plugin.js mergeOptions |
| N2 | `generateConnectionString()` — reverse: options → URI | Non-UI | Used by server startup output |
| U1 | `connectionString` option field in Tropy preferences | UI | First field in options array |

## File Scope

| File | Changes |
|------|---------|
| `src/connection-string.js` | **NEW** — parse/generate `troparcel://` URIs |
| `src/plugin.js` | Parse `connectionString` in `mergeOptions()`. Individual fields override. |
| `package.json` | Add `connectionString` as FIRST option. |
| `test/index.test.js` | 8 parser tests |

## Build Sequence

1. Write failing tests for connection string parsing (8 tests)
2. Run tests — expect fail (`Cannot find module`)
3. Implement `src/connection-string.js` — `parseConnectionString()` + `generateConnectionString()`
4. Run tests — expect pass
5. Wire into `plugin.js` mergeOptions: parse connectionString, spread into options (individual fields override)
6. Add `connectionString` option to `package.json` options array (first position)
7. Build (`node esbuild.config.mjs`) + test

## URI Formats

```
troparcel://ws/host:port/room?token=secret     → websocket
troparcel://file/path/to/shared/folder          → file
troparcel://snapshot/https://host/path?auth=tok  → snapshot
ws://host:port                                   → websocket (bare URL shorthand)
```

## Key Design Decisions

- Port present → `ws://` (local dev). No port → `wss://` (reverse proxy with TLS).
- `parseConnectionString` returns null for empty/invalid input (backward compat).
- Individual option fields override connection string values (explicit > derived).
- Windows paths: `troparcel://file/C:/Users/...` → `syncDir: 'C:/Users/...'`
