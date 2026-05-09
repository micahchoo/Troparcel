'use strict'

/**
 * Tier 1 — normalize-on-push HTML canonicalization scenarios.
 *
 * Locks in the mapping table from src/normalize-on-push.js (mulch mx-be0280,
 * seed f832). Every row in the JSDoc table @ normalize-on-push.js:18-26 has
 * a corresponding assertion below, plus idempotence + pass-through + edge
 * cases.
 *
 * Mapping verified against tropy/src/editor/schema.js (2026-05-09).
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeNoteHtml } = require('../../src/normalize-on-push')

// --- Mapping table: one assertion per row ---

test('normalize: <u> → span text-decoration: underline', () => {
  const out = normalizeNoteHtml('<u>foo</u>')
  assert.match(out, /text-decoration: underline/, 'should produce underline span')
  assert.match(out, /foo/, 'should preserve text content')
  assert.doesNotMatch(out, /<u>/i, 'raw <u> wrapper must be gone')
})

test('normalize: <s> → span text-decoration: line-through', () => {
  const out = normalizeNoteHtml('<s>bar</s>')
  assert.match(out, /text-decoration: line-through/, 'should produce strikethrough span')
  assert.match(out, /bar/, 'should preserve text content')
  assert.doesNotMatch(out, /<s>/i, 'raw <s> wrapper must be gone')
})

test('normalize: <strike> → span text-decoration: line-through', () => {
  const out = normalizeNoteHtml('<strike>baz</strike>')
  assert.match(out, /text-decoration: line-through/, 'should produce strikethrough span')
  assert.match(out, /baz/, 'should preserve text content')
  assert.doesNotMatch(out, /<strike>/i, 'raw <strike> wrapper must be gone')
})

test('normalize: h1–h6 headings → <p><strong>...</strong></p>', () => {
  for (let level = 1; level <= 6; level++) {
    const tag = 'h' + level
    const input = `<${tag}>title-${level}</${tag}>`
    const out = normalizeNoteHtml(input)
    assert.match(out, /^<p><strong>/, `${tag}: should start with <p><strong>`)
    assert.match(out, /<\/strong><\/p>$/, `${tag}: should end with </strong></p>`)
    assert.match(out, new RegExp(`title-${level}`), `${tag}: text preserved`)
    assert.doesNotMatch(
      out,
      new RegExp(`<${tag}>`, 'i'),
      `${tag}: raw heading wrapper must be gone`
    )
  }
})

test('normalize: <code> → text only (no inline-code mark in schema)', () => {
  const out = normalizeNoteHtml('<code>x</code>')
  assert.equal(out, 'x', 'code wrapper dropped, only text remains')
})

test('normalize: <pre>multi\\nline</pre> → <p>multi\\nline</p>', () => {
  const out = normalizeNoteHtml('<pre>multi\nline</pre>')
  assert.equal(out, '<p>multi\nline</p>', 'pre rewrapped as paragraph, newline preserved')
})

test('normalize: <div>content</div> → <p>content</p>', () => {
  const out = normalizeNoteHtml('<div>content</div>')
  assert.equal(out, '<p>content</p>', 'div rewrapped as paragraph')
})

// --- Composition: nested transformations apply ---

test('normalize: nested <h1><u>both</u></h1> applies both transformations', () => {
  const out = normalizeNoteHtml('<h1><u>both</u></h1>')
  // h1 outer rewraps as <p><strong>...</strong></p>
  assert.match(out, /<p><strong>/, 'outer h1 rewrap')
  assert.match(out, /<\/strong><\/p>/, 'outer h1 close')
  // u inner rewraps as text-decoration: underline span
  assert.match(out, /text-decoration: underline/, 'inner u rewrap')
  assert.match(out, /both/, 'text content preserved through both passes')
})

// --- Idempotence ---

test('normalize: idempotent on canonical paragraph', () => {
  const html = '<p>foo</p>'
  assert.equal(normalizeNoteHtml(html), html, 'canonical p round-trips unchanged')
  assert.equal(
    normalizeNoteHtml(normalizeNoteHtml(html)),
    normalizeNoteHtml(html),
    'double-application equals single-application'
  )
})

test('normalize: idempotent on transformed inputs', () => {
  // After one pass, output should be canonical and stable on a second pass.
  const samples = [
    '<u>x</u>',
    '<s>x</s>',
    '<strike>x</strike>',
    '<h1>x</h1>',
    '<h6>x</h6>',
    '<code>x</code>',
    '<pre>x</pre>',
    '<div>x</div>',
    '<h1><u>both</u></h1>'
  ]
  for (const input of samples) {
    const once = normalizeNoteHtml(input)
    const twice = normalizeNoteHtml(once)
    assert.equal(twice, once, `idempotent for: ${input}`)
  }
})

// --- Pass-through: schema-canonical inputs unchanged ---

test('normalize: paragraph passes through unchanged', () => {
  assert.equal(normalizeNoteHtml('<p>hello</p>'), '<p>hello</p>')
})

test('normalize: hard break <br> survives', () => {
  // Per f832 / schema.js: parseDOM accepts both raw <br> and the canonical
  // <span class="line-break"><br></span> form. Both must survive normalize.
  const bare = '<p>line1<br>line2</p>'
  assert.equal(normalizeNoteHtml(bare), bare, 'bare <br> survives')

  const canonical = '<p>line1<span class="line-break"><br></span>line2</p>'
  assert.equal(normalizeNoteHtml(canonical), canonical, 'canonical line-break survives')
})

test('normalize: em / strong / sub / sup / lists pass through', () => {
  const inputs = [
    '<em>x</em>',
    '<strong>x</strong>',
    '<sub>x</sub>',
    '<sup>x</sup>',
    '<ul><li>a</li><li>b</li></ul>',
    '<ol><li>1</li></ol>',
    '<blockquote>q</blockquote>',
    '<a href="https://example.com">link</a>',
    '<hr>'
  ]
  for (const input of inputs) {
    assert.equal(normalizeNoteHtml(input), input, `pass-through: ${input}`)
  }
})

test('normalize: text-decoration span (already canonical) passes through', () => {
  // Critical idempotence path — output of <u> rewrite should not be
  // re-rewritten on a subsequent normalize pass.
  const canonical = '<span style="text-decoration: underline">x</span>'
  assert.equal(normalizeNoteHtml(canonical), canonical)
})

// --- Edge cases: defensive contract per src code ---

test('normalize: empty string returns empty string', () => {
  assert.equal(normalizeNoteHtml(''), '')
})

test('normalize: null returns empty string (does not crash)', () => {
  assert.equal(normalizeNoteHtml(null), '')
})

test('normalize: undefined returns empty string (does not crash)', () => {
  assert.equal(normalizeNoteHtml(undefined), '')
})

test('normalize: non-string truthy input is returned unchanged (does not crash)', () => {
  // Source contract @ normalize-on-push.js:71 —
  //   if (!html || typeof html !== 'string') return html || ''
  // For non-string truthy inputs, the typeof guard hits but `html || ''`
  // evaluates to `html` itself (since it's truthy). The load-bearing
  // promise is "does not crash"; pass-through on non-strings is fine —
  // push.js never calls this with a non-string value in practice.
  assert.doesNotThrow(() => normalizeNoteHtml(42))
  assert.doesNotThrow(() => normalizeNoteHtml({}))
  assert.doesNotThrow(() => normalizeNoteHtml([]))
})

// --- Wrapper attribute discard ---

test('normalize: attributes on rewritten wrappers are discarded', () => {
  // <u class="foo" data-x="bar">x</u> → canonical span with NO foo / bar
  const out = normalizeNoteHtml('<u class="foo" data-x="bar">x</u>')
  assert.match(out, /text-decoration: underline/, 'canonical attrs only')
  assert.doesNotMatch(out, /foo/, 'wrapper class discarded')
  assert.doesNotMatch(out, /data-x/, 'wrapper data-attr discarded')
  assert.match(out, /x/, 'text preserved')
})

test('normalize: case-insensitive tag matching', () => {
  const out1 = normalizeNoteHtml('<U>x</U>')
  assert.match(out1, /text-decoration: underline/, 'uppercase <U> handled')

  const out2 = normalizeNoteHtml('<DIV>x</DIV>')
  assert.equal(out2, '<p>x</p>', 'uppercase <DIV> rewrapped')
})
