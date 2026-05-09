# Subsystem: Metadata sync (type-aware merge)

**Seed:** `tropy-plugin-25e2` (P2, Wave 4, audit-cross-ref-§3)
**Status:** Research — plan only. No source-code changes in this seed.
**Acceptance criterion:** two peers writing `1450` and `1450~` (same EDTF
instant, different strings) → LWW resolves once on each side, no churn.

## Tropy type system

### The four canonical types

Tropy's entire type registry is `tropy/src/constants/type.js` — four entries:

| Constant | URI | Source |
|---|---|---|
| `TYPE.DATE` | `https://tropy.org/v1/tropy#date` | tropy ns proxy |
| `TYPE.NUMBER` | `http://www.w3.org/2001/XMLSchema#integer` | xsd ns proxy |
| `TYPE.BYTE` | `http://www.w3.org/2001/XMLSchema#byte` | xsd ns proxy |
| `TYPE.TEXT` | `http://www.w3.org/2001/XMLSchema#string` | xsd ns proxy |

The `xsd`, `dcterms`, `tropy`, … namespace objects in
`tropy/src/ontology/ns.js` are JS `Proxy` instances — any URI that *starts
with* the namespace base is legal. Tropy stores arbitrary datatype URIs
verbatim in `metadata_values.datatype` (see `models/value.js:10`); only the
four constants above receive special treatment in code.

### Value shape and equality

`tropy/src/value.js` defines the canonical value record:

```js
// tropy/src/value.js:11-13, 15-20
export function value (input, type) { return { text: input, type: type || TYPE.TEXT } }
export function equal (a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  return a.type === b.type && a.text === b.text
}
```

**Invariants** (load-bearing for sync):

- `value.text` is always a string. There is no `value.parsed` field — Tropy
  does not pre-parse on save.
- `value.type` is always a datatype URI string.
- `equal()` is a string-level comparison. Two strings denoting the same EDTF
  instant (`"1450"` vs `"1450~"`) are *not equal* under Tropy's own
  semantics. This is intentional: Tropy preserves user input verbatim and
  only normalizes at the formatting boundary.

### Where Tropy uses `edtf`

Exactly one import: `tropy/src/format.js:1`:

```js
import edtf, { format as edtfFormat } from 'edtf'
```

Used only inside `format.datetime(value)` for **display** (locale-aware
rendering). Storage and equality are untouched. The `edtf` dep declared in
`tropy/package.json` is `^4.10.0` (transitively pulls `nearley ^2.19.7`).

### Pipeline summary

```
ui edit → { text, type } → metadata.update (models/metadata.js:17)
                          → value.save (models/value.js:1)
                          → INSERT INTO metadata_values (datatype, text)
                          → INSERT INTO metadata (id, property, value_id)
display:                  ← format.auto(text, type) (format.js:43)
                              └── TYPE.DATE → format.datetime → edtf(text)
```

### Datatype categorization for sync

| Category | Examples | Comparison rule |
|---|---|---|
| **Needs type-aware normalize** | `tropy.date` (EDTF) | Parse with `edtf()` and compare canonical instants |
| **Correctly compared as strings** | `xsd.integer`, `xsd.byte`, `xsd.string`, all unknown URIs | Existing `text === text` is faithful to Tropy's own `equal()` |

Scope discipline: `xsd.integer` `"1"` vs `"01"` and locale-folding for
`xsd.string` are *not* in scope. Tropy itself treats them as distinct;
troparcel must not invent stricter equality than the host app. The single
exception is `tropy.date`, justified because `edtf` is already the canonical
parser inside Tropy and the acceptance scenario is explicit.

## Where troparcel currently merges metadata

All sites use the same shape: `_fastHash(\`${text}|${type}\`)` keys both the
`pushedFieldValues` map (push side) and the `hasLocalEdit` LWW probe (apply
side). The hash is FNV-1a over the concatenated string (vault.js:198).

### Push side — `troparcel/src/push.js`

| Line | Site | What it pushes |
|---|---|---|
| ~110 | item metadata loop | `text = value['@value'] || value.text`, `type = value['@type'] || value.type` → `schema.setMetadata` + `markFieldPushed` keyed by `prop` |
| ~371 | photo metadata loop | per-photo field push, key `photo:${checksum}:${key}` |
| ~462 | selection metadata loop | per-selection field push, key `sel:${selUUID}:${key}` |

The conflict-detection branch at push time (push.js ~line 110-128) computes
`valueHash = vault._fastHash(\`${text}|${type}\`)` and calls
`hasLocalEdit(itemIdentity, key, valueHash)` to decide whether to override
the remote.

### Apply side — `troparcel/src/apply.js`

| Line | Function | Notes |
|---|---|---|
| ~217-244 | `applyMetadata` | item-level fields; `localText === (value.text \|\| '')` short-circuit at line 218; LWW via `_fastHash` at 220 |
| ~675-700 | photo metadata block inside `applyPhotos` | same pattern, key `photo:${checksum}:${prop}` |
| ~990-1015 | selection metadata block inside `applySelections` | same pattern, key `sel:${selUUID}:${prop}` |

All three sites dispatch via `this.api.saveMetadata(localId, batch)` (the
`StoreAdapter` write helper) — no use of `dispatchSuppressed` here, and the
outer `applyRemoteAnnotations` already brackets `suppressChanges` /
`resumeChanges` (see `.claude/rules/troparcel-apply-suppression.md`). No
new dispatch sites are introduced by this plan.

### Vault dedup — `troparcel/src/vault.js`

- `vault.js:75` — `pushedFieldValues = new Map()` keyed `${identity}:${field}`
  → value hash. Intentionally *not* persisted (vault.js:512 comment) —
  rebuilt on first push cycle.
- `vault.js:141-148` — `hasLocalEdit(identity, field, currentValueHash)`
  returns true when `pushedFieldValues.get(key) !== currentValueHash`. This
  is the core LWW gate.
- `vault.js:151-154` — `markFieldPushed(identity, field, valueHash)` records
  the hash after a successful push.
- `vault.js:198` — `_fastHash(obj)` is FNV-1a 32-bit. Used for both
  `appliedNoteHashes` (persisted, vault version 4) and `pushedFieldValues`
  (not persisted).

**Critical constraint:** `_fastHash` itself is reachable from
`appliedNoteHashes`, which **is** persisted in vault format v4
(vault.js:506, 612). Changing `_fastHash` globally would invalidate every
persisted note hash and force a vault version bump per
`.claude/rules/troparcel-vault-version.md`. Therefore the type-aware
normalization must happen at the *call sites* (push/apply metadata loops)
before the hash is computed — not inside `_fastHash`.

## Proposed change

### New helper in `troparcel/src/vault.js` (or a new util module)

```js
// vault.js (or new src/value-normalize.js)
import edtf from 'edtf'

const TROPY_DATE = 'https://tropy.org/v1/tropy#date'

export function normalizeMetaText(text, type) {
  if (text == null || text === '') return ''
  if (type !== TROPY_DATE) return String(text)        // pass-through for all others
  try {
    // edtf().toString() returns the canonical EDTF representation;
    // approximate/uncertain qualifiers fold through edtf-internal
    // normalization. `1450` and `1450~` parse to the same year instant
    // when compared by `.values[0]` / `.year`.
    let parsed = edtf(String(text))
    return parsed.toString()                          // canonical form
  } catch {
    return String(text)                               // unparseable → fall back to raw
  }
}
```

The exact `parsed.toString()` semantics for the `1450`/`1450~` acceptance
must be confirmed during ff6e implementation — if `toString()` preserves
the qualifier, switch to `String(parsed.values[0])` (year-as-int) or a
similar canonical projection. The test seed (ff6e) is the right place to
pin this down via assertion.

### Push-side modifications — `troparcel/src/push.js`

Replace the three `_fastHash(\`${text}|${type}\`)` constructions with:

```js
let normText = normalizeMetaText(text, type)
let valueHash = this.vault._fastHash(`${normText}|${type}`)
```

Sites:

1. `push.js:~110` — item metadata loop, before the
   `hasLocalEdit(itemIdentity, key, valueHash)` check and the matching
   `markFieldPushed` call.
2. `push.js:~371` — photo metadata loop, `photo:${checksum}:${key}` field.
3. `push.js:~462` — selection metadata loop, `sel:${selUUID}:${key}` field.

The `text` written to the CRDT (`schema.setMetadata` / `setPhotoMetadata` /
`setSelectionMetadata`) **stays the user's raw string** — only the dedup
hash uses the normalized form. This preserves Tropy's
input-fidelity invariant.

### Apply-side modifications — `troparcel/src/apply.js`

Replace the equality check and hash construction at all three sites:

```js
// Before:
if (localText === (value.text || '')) continue
let valueHash = this.vault._fastHash(`${localText}|${value.type || ''}`)

// After:
let localNorm  = normalizeMetaText(localText, value.type)
let remoteNorm = normalizeMetaText(value.text || '', value.type)
if (localNorm === remoteNorm) continue
let valueHash = this.vault._fastHash(`${localNorm}|${value.type || ''}`)
```

Sites:
1. `apply.js:~217-220` — `applyMetadata`
2. `apply.js:~675-680` — `applyPhotos` photo metadata block
3. `apply.js:~990-995` — `applySelections` selection metadata block

The `batch[prop] = { text: value.text, type: value.type }` payload that
goes to `api.saveMetadata` keeps the **remote raw text** unchanged. We
only normalize for the equality decision and the LWW probe.

### Vault dedup logic

No changes to `vault.js` beyond exporting / colocating `normalizeMetaText`.
`pushedFieldValues` already keys on a hash; the hash now happens to be
type-aware because callers feed it normalized text. `appliedNoteHashes` is
*not* affected — notes are HTML, not typed metadata.

**Vault version: stays at v4.** No persistence-layer change.

### Dependency addition — `troparcel/package.json`

Add to `dependencies`:

```json
"edtf": "^4.10.0"
```

Matches the version Tropy itself depends on. `edtf@4.10` declares
`type: "module"`, `main: ./dist/index.cjs`, and one runtime dep
`nearley ^2.19.7`. esbuild bundles both via the existing
`troparcel/esbuild.config.mjs` config (`bundle: true`, `format: 'cjs'`,
`platform: 'node'`, `target: 'node20'`, `external: ['electron']`).

**esbuild quirks to verify in ff6e** (not blocking the plan):

1. `edtf` ships `dist/index.cjs` as its `main` — esbuild will pick that up
   for the cjs build target. No ESM interop hazard.
2. `nearley` is pure JS — no native bindings, no `.peg`/`.wasm` runtime
   loading.
3. Bundle-size delta: rough order-of-magnitude only — `edtf` + `nearley`
   together are ~100-200 KB minified. Confirm with
   `cd troparcel && npm run build && wc -c index.js` before vs after.
4. If `edtf` does any `import.meta`-style probing internally, esbuild's
   cjs output may need `--define:import.meta.url=…` — ff6e will hit this if
   the build fails.

## Acceptance test sketch (becomes seed `tropy-plugin-ff6e`)

```js
// test/scenarios/edtf-metadata-merge.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeContext } from '../helpers/context.js'
import { normalizeMetaText } from '../../src/vault.js' // or wherever it lands

const DATE = 'https://tropy.org/v1/tropy#date'
const ITEM = 'item:abc'
const PROP = 'http://purl.org/dc/elements/1.1/date'

test('EDTF: 1450 ≡ 1450~ — peers settle without churn', async () => {
  // 1. canonical-form sanity
  assert.equal(
    normalizeMetaText('1450', DATE),
    normalizeMetaText('1450~', DATE),
    'edtf canonicalization must fold approximate qualifier for year-only')
  )

  // 2. xsd.string is NOT folded — Tropy treats them as distinct
  const STR = 'http://www.w3.org/2001/XMLSchema#string'
  assert.notEqual(
    normalizeMetaText('Hello',  STR),
    normalizeMetaText('hello',  STR),
    'xsd.string must remain case-sensitive (no scope creep)')
  )

  // 3. End-to-end: Alice pushes "1450", Bob pushes "1450~", expect
  //    one settle, then both vaults stable across a second push cycle.
  const alice = makeContext({ userId: 'alice' })
  const bob   = makeContext({ userId: 'bob' })
  alice.adapter.seedItem({ id: 1, [PROP]: { text: '1450',  type: DATE } })
  bob.adapter.seedItem(  { id: 1, [PROP]: { text: '1450~', type: DATE } })

  await alice.push(); await bob.push()
  await alice.apply(); await bob.apply()

  // First settle: one peer's value wins (LWW), recorded once.
  // Second cycle: NO new push edges (no churn).
  const beforeSeq = alice.vault.pushSeq
  await alice.push(); await bob.push()
  const afterSeq = alice.vault.pushSeq
  assert.equal(afterSeq, beforeSeq, 'no churn after EDTF-equivalent settle')
})
```

The implementation seed (`tropy-plugin-ff6e`) will additionally need:

- Build smoke test: `cd troparcel && npm run build && node -e "require('./index.js')"`.
- A failure-mode test for unparseable EDTF: `"not-a-date"` must not throw
  and must compare as raw strings.
- A guard that `edtf` lookup does not regress when run inside a Tropy
  Electron renderer process (the only realistic prod environment).

## Open questions deferred to ff6e

1. **Canonical EDTF projection.** Is `edtf(s).toString()` stable for the
   acceptance pair, or do we need `.values[0]` or `.year`? Decide by
   running both against the four-corners EDTF cases (`1450`, `1450~`,
   `1450?`, `1450%`).
2. **Unparseable-text policy.** Today: `text|type` falls back to raw
   string. Confirm acceptable.
3. **Bundle-size budget.** Plugin currently builds to a single `index.js`.
   If the +200 KB cost is unacceptable, scope `normalizeMetaText` behind a
   lazy `await import('edtf')` — but that adds async to a hot path, so
   prefer eager bundle unless the size is shown to bite.

## References

- `tropy/src/constants/type.js` — type constant table (4 entries)
- `tropy/src/value.js` — `equal()`, `value()`, `date()` helpers
- `tropy/src/models/value.js` — DB save/prune
- `tropy/src/models/metadata.js` — `update`/`load` over `(id, property, value_id)`
- `tropy/src/format.js` — `edtf` import + `datetime` formatter
- `tropy/src/ontology/ns.js` — namespace proxy for `xsd`, `tropy`, `dcterms`
- `troparcel/src/push.js` — metadata push paths (lines ~110, ~371, ~462)
- `troparcel/src/apply.js` — metadata apply paths (lines ~217, ~675, ~990)
- `troparcel/src/vault.js` — `_fastHash`, `hasLocalEdit`, `markFieldPushed`
- `.claude/rules/troparcel-vault-version.md` — vault format-version contract
- `.claude/rules/troparcel-apply-suppression.md` — apply-side dispatch contract
