# Test Harness ↔ Seeds Coverage Matrix

How each ready seed maps to the harness, and what the harness will do when the seed lands. Updated 2026-05-08 after autonomous Tier 3 baseline.

## Harness contribution per ready seed

| Seed | Title | Harness contribution | Confidence |
|---|---|---|---|
| `tropy-plugin-03ee` (P0) | _applyAttribution dispatchSuppressed | **Direct TDD anchor** — Tier 1 `v3-attribution.test.js` test #1 fails on `dispatchSuppressed is not a function`. Flips green when `store.dispatch` substitution lands. Two regression tests already pass (self-attribution skip, tombstone skip). | **High** — exact bug-to-test match |
| `tropy-plugin-4541` (P1) | V5 wiring into syncOnce | Tier 1 `v5-templates.test.js` + `v5-list-hierarchy.test.js` together cover the apply path (8 passing tests proving `applyTemplates`/`applyListHierarchy` work in isolation). **Wiring itself** isn't directly testable in Tier 1 — needs sync-engine integration test (gap; seed below). Tier 3 `synthetic-peer.js` list-receive assertion is the integration anchor: currently fails, flips green after wiring + plugin config. | **Medium** — apply paths covered, wiring needs new test |
| `tropy-plugin-8073` (P1) | Notes HTML pipeline | **Direct anchors** — Tier 1 `sanitize-tags.test.js` has 5 skipped tests waiting for SAFE_TAGS tightening. Flip `skip:` → undefined when fix lands; tests assert dropped tags + content survival. 7 passing security tests guard against regression. | **High** — pre-locked expectations |
| `tropy-plugin-7a4a` (P1) | readTemplates/readLists study | Tier 1 already uses `adapter.readTemplates()` / `readLists()` (FakeStoreAdapter exposes them). After W2.T5 adds them to real adapter, no test changes needed — apply paths just keep passing. The `harness:` drift-detection test (`push-paths.test.js #1`) confirms parity. | **High** — covered by parity assertion |
| `tropy-plugin-733b` (P1) | V5 template payload study | Tier 1 `v5-templates.test.js` test #1 asserts payload shape (name, type, creator, fields, meta.cmd, meta.history). Test #5 (skipped) asserts `isProtected` + `domain` round-trip after W2.T3 schema bump. | **High** — payload covered |
| `tropy-plugin-b5de` (P1) | chokidar replacement | **Limited coverage** — Tier 1 doesn't exercise fs.watch (it's a fallback path). Tier 2 transport test verifies WebSocket path which is the primary. After fix, would need a Tier 2 test that triggers a real file mutation and confirms one debounced sync (gap; seed below). | **Low** — needs new test |
| `tropy-plugin-25e2` (P2) | EDTF metadata merge | **No coverage yet** — needs new Tier 1 scenario asserting EDTF instant equality (`'1450'` vs `'1450~'` parse to same date → LWW does not thrash). Gap; seed below. | **None** — gap |
| `tropy-plugin-a542` (P2) | HISTORY.TICK undo merge | **No coverage yet** — needs Tier 1 scenario asserting one history entry per apply cycle (count `history.tick` actions in `adapter.actions`). Gap; seed below. | **None** — gap |
| `tropy-plugin-1390` (P2) | Late-joiner persistence | **Direct anchor** — Tier 2 `transport.test.js` test 2 fails. Confirmed real bug at `server/index.js:100` (unawaited `ldb.storeUpdate`). Test passes after `async (update) => { await ldb.storeUpdate(...) }`. | **High** — failure isolates root cause |
| `tropy-plugin-d8ba` (P2) | Update mulch mx-ddbf09 | No code change → no harness contribution. Knowledge-hygiene only. | N/A |
| `tropy-plugin-829a` (P3) | Investigate context object | Research-only → no harness needed. Findings inform e4da/b4eb/a542 strategies. | N/A |
| `tropy-plugin-e4da` (P3) | FLASH.SHOW notifications | If FLASH.SHOW dispatch path: Tier 1 can assert the action shape. If GUI-only: Tier 3 visual verification (no automated). Decision after 829a. | **Low pending 829a** |
| `tropy-plugin-b4eb` (P3) | Constants sweep | Mechanical refactor — no behavior change, no test. | N/A |
| `tropy-plugin-f832` (P3) | Notes normalize-on-push | **No coverage yet** — needs Tier 1 scenario: push `<u>foo</u>`, assert CRDT contains `<span style="text-decoration: underline">foo</span>`. Gap; seed below. | **None** — gap |

## Coverage gaps to file as new seeds

1. **Sync-engine V5 wiring integration test** — Tier 1 has unit-coverage of apply* but not the syncOnce wiring itself. Needs a test that constructs a SyncEngine (or a test-mode wrapper), calls `syncOnce()`, and asserts the order: pushTemplates → pushListHierarchy → applyRemoteAnnotations loop → applyTemplates → applyListHierarchy.
2. **chokidar fs-watch test** — Tier 2 should verify that touching a file under chokidar triggers exactly one debounced sync.
3. **EDTF metadata merge test** — Tier 1 scenario for type-aware LWW.
4. **HISTORY.TICK merge test** — Tier 1 scenario asserting one undo entry per apply cycle.
5. **Notes normalize-on-push test** — Tier 1 scenario for tag-equivalence normalization.
6. **Tropy `/project/templates` HTTP API gap** — Tier 3 cannot verify template sync via REST. Either request route upstream, verify indirectly via items, or document as GUI-only.

## Anchored vs gap summary

- **9 of 14 ready seeds** have meaningful harness coverage (TDD anchor, locked expectation, or already-passing parity assertion)
- **5 of 14 are gaps**: 25e2, a542, b5de, f832, plus the wiring integration test for 4541. Seeds filed below.
- **2 are research/refactor** with no testable change (829a, b4eb, d8ba, e4da depending on 829a)

## Tier 3 autonomous baseline (2026-05-08)

| Step | Result |
|---|---|
| Server start | ✅ 100ms |
| Tropy under xvfb + dbus-run-session | ✅ 2s to API responding |
| Synthetic peer connects | ✅ |
| Synthetic peer pushes template + list | ✅ |
| Tropy API: project loaded | ✅ `Test Project A.tropy` |
| List sync verification | ❌ (expected — V5 wiring missing per `4541`, plugin's configured room may differ) |
| Template sync verification | ⊝ skipped (no Tropy HTTP route) |
| Cleanup | ✅ all PIDs killed, no leftover processes |

The Tier 3 list-fail is the integration anchor for `4541`. After wiring + configuring the plugin's `room=tier3-baseline`, this should flip green.
