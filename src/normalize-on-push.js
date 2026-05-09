'use strict'

/**
 * Normalize-on-push HTML canonicalization.
 *
 * Pairs with sanitize.js — sanitize is the RECEIVE-side guard
 * (incoming remote HTML, XSS protection); normalize is the SEND-side
 * helper that converts non-canonical / dropped HTML tags into the form
 * Tropy's ProseMirror editor schema actually accepts BEFORE the value
 * is written into the CRDT.
 *
 * Without this, a peer can locally edit and persist HTML that survives
 * sanitize.js (because SAFE_TAGS is a strict subset, see mulch
 * mx-f3a517 / mx-a3caef) but loses formatting on the receiving side
 * because Tropy's `fromHTML` silently drops anything outside its
 * editor schema (tropy/src/editor/schema.js).
 *
 * Mapping table (verified against tropy/src/editor/schema.js 2026-05-09):
 *   <u>X</u>      → <span style="text-decoration: underline">X</span>
 *   <s>X</s>      → <span style="text-decoration: line-through">X</span>
 *   <strike>X</…> → <span style="text-decoration: line-through">X</span>
 *   <h1..h6>X</…> → <p><strong>X</strong></p>   (no heading node in schema;
 *                                                preserve emphasis as bold ¶)
 *   <code>X</code>→ X                            (no inline-code mark; keep text)
 *   <pre>X</pre>  → <p>X</p>                     (no code-block; preserve as ¶)
 *   <div>X</div>  → <p>X</p>                     (not a node type)
 *
 * Conservative invariant: NEVER lose the user's text content. Only the
 * formatting wrapper is rewritten / dropped — inner text always survives.
 *
 * Implementation note: a regex sweep is sufficient and intentional —
 * the input is HTML the local Tropy already produced (or a peer's
 * already-sanitized HTML), so it is well-formed by construction. No
 * heavy parser dependency is added.
 */

// Strikethrough canonical span (matches schema.js textDecoMark output).
const STRIKE_OPEN = '<span style="text-decoration: line-through">'
const UNDERLINE_OPEN = '<span style="text-decoration: underline">'
const SPAN_CLOSE = '</span>'

/**
 * Replace each occurrence of <openTag ...attrs...>INNER</openTag> with
 * `${replacementOpen}INNER${replacementClose}`. Tag matching is
 * case-insensitive. Attributes on the wrapper are discarded — the
 * schema target form has its own canonical attributes.
 *
 * Uses a non-greedy inner match; nested tags of the same name are not
 * supported (rare in practice for u, s, headings, code, pre, div) but
 * the fallback is the conservative drop-wrapper-keep-text behavior since
 * leftover inner text is preserved by subsequent passes.
 */
function replaceWrapper(html, tagName, replacementOpen, replacementClose) {
  // Open tag with optional attributes, close tag — both case-insensitive.
  let pattern = new RegExp(
    '<' + tagName + '\\b[^>]*>([\\s\\S]*?)<\\/' + tagName + '\\s*>',
    'gi'
  )
  return html.replace(pattern, (_match, inner) => {
    return replacementOpen + inner + replacementClose
  })
}

/**
 * Normalize note HTML into Tropy editor schema canonical form before push.
 *
 * @param {string} html - locally-produced (or already-sanitized) note HTML
 * @returns {string} canonical HTML ready for CRDT write
 */
function normalizeNoteHtml(html) {
  if (!html || typeof html !== 'string') return html || ''

  let out = html

  // Underline: <u>X</u> → <span style="text-decoration: underline">X</span>
  out = replaceWrapper(out, 'u', UNDERLINE_OPEN, SPAN_CLOSE)

  // Strikethrough: <s> and <strike> → canonical line-through span
  out = replaceWrapper(out, 's', STRIKE_OPEN, SPAN_CLOSE)
  out = replaceWrapper(out, 'strike', STRIKE_OPEN, SPAN_CLOSE)

  // Headings h1–h6 → <p><strong>X</strong></p> (preserve text + emphasis).
  for (let level = 1; level <= 6; level++) {
    out = replaceWrapper(out, 'h' + level, '<p><strong>', '</strong></p>')
  }

  // Code: drop the wrapper, keep inner text (no inline-code mark).
  out = replaceWrapper(out, 'code', '', '')

  // Pre block: rewrap as paragraph (no code-block node).
  out = replaceWrapper(out, 'pre', '<p>', '</p>')

  // Div: rewrap as paragraph (not a node type).
  out = replaceWrapper(out, 'div', '<p>', '</p>')

  return out
}

module.exports = {
  normalizeNoteHtml
}
