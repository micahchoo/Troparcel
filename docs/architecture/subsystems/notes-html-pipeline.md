# Subsystem: Notes HTML Pipeline (vs. Tropy editor)

> **Reconciliation against `tropy/src/editor/`**, completed 2026-05-08. This documents the structural asymmetry between troparcel (HTML on the wire) and Tropy (ProseMirror state on disk), and finds 4–6 over-permissive tags in `sanitize.js`.

## Tropy's canonical pipeline

| File | Role |
|---|---|
| `tropy/src/editor/schema.js` | ProseMirror schema — defines exactly which nodes/marks Tropy's note editor accepts |
| `tropy/src/editor/serialize.js` | `serialize(note)`, `toHTML(doc)`, `fromHTML(html)`, `toMarkdown(doc)`, `toText(doc)` — round-trip helpers |
| `tropy/src/models/note.js` | SQLite schema — `state` (JSON-stringified ProseMirror EditorState) + `text` (plain-text) + `language` + `deleted` (timestamp) |
| `tropy/src/sagas/note.js` | Autosave saga — debounces `NOTE.UPDATE` actions, calls `models.save(db, {id, state, text})` |
| `tropy/src/constants/note.js` | Action types: `note.create`, `note.save`, `note.update`, `note.delete`, `note.restore`, etc. (full set in this file) |

## Tropy's schema in two tables

### Nodes (block + inline)
| Node | DOM tag | Notes |
|---|---|---|
| `doc` | — | top-level |
| `paragraph` | `<p>` | with `align` attr (`text-align: …` style or none for `left`) |
| `blockquote` | `<blockquote>` | basic |
| `text` | text node | basic |
| `horizontal_rule` | `<hr>` | basic |
| `hard_break` | `<span class="line-break"><br></span>` | parses `<br>` *and* `span.line-break` |
| `ordered_list` | `<ol>` | wraps `list_item+` |
| `bullet_list` | `<ul>` | wraps `list_item+` |
| `list_item` | `<li>` | wraps `paragraph block*` |

### Marks (inline formatting)
| Mark | DOM emitted | DOM parsed |
|---|---|---|
| `italic` | `<em>` | `<em>` and `<i>` (schema-basic default) |
| `bold` | `<strong>` | `<strong>` and `<b>` (schema-basic default) |
| `underline` | `<span style="text-decoration: underline">` | `style: text-decoration` value `underline` |
| `overline` | `<span style="text-decoration: overline">` | `style: text-decoration` value `overline` |
| `strikethrough` | `<span style="text-decoration: line-through">` | `style: text-decoration` value `line-through` |
| `link` | `<a href="…" title="…">` | `<a[href]>` |
| `superscript` | `<sup>` | `<sup>` and `<span style="vertical-align: super">` |
| `subscript` | `<sub>` | `<sub>` and `<span style="vertical-align: sub">` |

**Notably absent:** `<u>`, `<s>`, `<h1>–<h6>`, `<code>`, `<pre>`, `<div>`. ProseMirror's `fromHTML` will silently drop or down-convert anything outside this schema.

## The structural asymmetry

- **On disk (Tropy):** `notes.state` = JSON-stringified `EditorState` (the ProseMirror document is the source of truth). `notes.text` is regenerated from `state.doc.textBetween(0, size, ' ', ' ')`.
- **On the wire (troparcel CRDT):** `{html, text, lang, photo, sel, author, pushSeq, deleted?}` — HTML is the exchange format, ProseMirror state is never transmitted.
- **Boundary** = `fromHTML(html)` at apply (HTML → state, lossy for non-schema content) and the implicit `toHTML(state)` at the moment Tropy serializes via `note.export` or HTTP-API export (which is where troparcel reads it from).

This is a sound design — plugins can't ship ProseMirror, so HTML is the right interchange. **But** it makes the sanitizer's `SAFE_TAGS` allowlist load-bearing for cross-version visual consistency. Anything passed through that's outside Tropy's schema will:

1. Render correctly in the *raw* HTML view (if any peer has one)
2. Be silently dropped or re-shaped by `fromHTML(html)` when it reaches a Tropy editor
3. Result in different visible rendering across peers running different troparcel versions

## SAFE_TAGS audit (2026-05-08)

Compared `troparcel/src/sanitize.js SAFE_TAGS` against Tropy's editor schema:

| Tag | In Tropy schema? | In troparcel SAFE_TAGS | Action |
|---|---|---|---|
| `p` | ✅ paragraph | ✅ | keep |
| `br` | ✅ hard_break | ✅ | keep |
| `em` / `i` | ✅ italic | ✅ / ✅ | keep both (parser accepts both) |
| `strong` / `b` | ✅ bold | ✅ / ✅ | keep both |
| `a` | ✅ link | ✅ | keep |
| `ul` / `ol` / `li` | ✅ list nodes | ✅ / ✅ / ✅ | keep |
| `blockquote` | ✅ | ✅ | keep |
| `hr` | ✅ horizontal_rule | ✅ | keep |
| `sup` / `sub` | ✅ superscript/subscript | ✅ / ✅ | keep |
| `span` | ✅ (used by hard_break + decoration marks) | ✅ | keep |
| **`u`** | ❌ (Tropy uses `<span style="text-decoration: underline">`) | ✅ | **drop or normalize on push** — peers running Tropy will silently re-render as plain text |
| **`s`** | ❌ (same — uses `text-decoration: line-through`) | ✅ | **drop or normalize on push** |
| **`h1`–`h6`** | ❌ | ✅ × 6 | **drop** — content survives but loses heading semantics on Tropy's parse |
| **`code`** | ❌ | ✅ | **drop** |
| **`pre`** | ❌ | ✅ | **drop** |
| **`div`** | ❌ | ✅ | **drop** — nothing emits `<div>` from Tropy; allowing it is a XSS-attack-surface widening with no benefit |

Net: **6 tags accepted by troparcel that Tropy will drop on parse.** Audit §5 (security review of sanitizer) should narrow `SAFE_TAGS` to the subset above + decide whether to *normalize* on push (e.g., `<u>` → `<span style="text-decoration: underline">`) for cross-peer visual consistency.

## What `tropy/src/editor/serialize.js` exposes

If troparcel ever wanted to author *richer* notes from outside Tropy's editor (e.g., a CRDT-aware bulk import), the canonical helpers are:

- `fromHTML(html)` → `{state, text}` — HTML to ProseMirror state via `DOMParser.fromSchema(schema).parse(...)`
- `toHTML(doc)` → string — emits canonical Tropy form (uses `<span style="text-decoration: …">`, etc.)
- `toMarkdown(doc)` → string — markdown export (also handles `superscript`/`subscript` via custom serializer rules)
- `toText(doc)` → string — plain-text via `textBetween(0, size, ' ', ' ')`

Plugins would need to ship ProseMirror to use these. troparcel doesn't, and shouldn't — the wire format remains HTML.

## Mulch records to consult

- (this audit's new) **convention** on the SAFE_TAGS subset rule
- (this audit's new) **reference** to `tropy/src/editor/{schema,serialize}.js` + `models/note.js` as canonical sources
- `mx-ddbf09` — apply path uses `dispatchSuppressed` for note ops; remember the suppression-not-nestable rule

## Related canonical docs

- `troparcel/docs/CONFLICTS.md §Notes` — merge semantics (append-only)
- `troparcel/troparcel-audit.md §5 Note Sync` — flagged HTML sanitizer for security review
- `troparcel/slices.md §V*` — note sync was completed in V2 era; reconciliation does not change merge semantics
