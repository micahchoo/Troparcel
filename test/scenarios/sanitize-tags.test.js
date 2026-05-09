'use strict'

/**
 * Sanitize SAFE_TAGS — TDD anchor for seed tropy-plugin-8073 (Recon-plan W3.T2).
 *
 * Verifies the SAFE_TAGS audit table from
 * troparcel/docs/architecture/subsystems/notes-html-pipeline.md.
 *
 * Pre-W3.T2: u, s, h1-h6, code, pre, div pass through (over-permissive).
 * Post-W3.T2: those tags are stripped (formatting drops, content survives).
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { sanitizeHtml } = require('../../src/sanitize')

// --- Tags that Tropy's editor schema accepts (KEEP across the fix) ---

test('sanitize: paragraph passes through', () => {
  assert.equal(sanitizeHtml('<p>hello</p>'), '<p>hello</p>')
})

test('sanitize: line break in canonical hard_break form passes', () => {
  // Tropy emits this exact shape from hard_break toDOM
  const html = '<span class="line-break"><br></span>'
  const out = sanitizeHtml(html)
  assert.match(out, /<span/)
  assert.match(out, /<br/)
})

test('sanitize: em / strong / sub / sup pass through', () => {
  assert.match(sanitizeHtml('<em>x</em>'), /<em>x<\/em>/)
  assert.match(sanitizeHtml('<strong>x</strong>'), /<strong>x<\/strong>/)
  assert.match(sanitizeHtml('<sup>x</sup>'), /<sup>x<\/sup>/)
  assert.match(sanitizeHtml('<sub>x</sub>'), /<sub>x<\/sub>/)
})

test('sanitize: text-decoration spans (canonical Tropy form for u/s) pass', () => {
  const u = '<span style="text-decoration: underline">x</span>'
  const out = sanitizeHtml(u)
  // safe — span allowed, style=text-decoration: underline allowed
  assert.match(out, /<span/)
  assert.match(out, /text-decoration: underline/)
})

// --- Dangerous tags that MUST be stripped (security: invariant pre and post) ---

test('sanitize: script tag content stripped entirely', () => {
  assert.doesNotMatch(
    sanitizeHtml('<p>safe</p><script>alert(1)</script>'),
    /script|alert/
  )
})

test('sanitize: javascript: href blocked', () => {
  assert.doesNotMatch(
    sanitizeHtml('<a href="javascript:alert(1)">x</a>'),
    /javascript/i
  )
})

test('sanitize: data: href in img blocked (img not in SAFE_TAGS at all)', () => {
  assert.doesNotMatch(
    sanitizeHtml('<img src="data:image/svg+xml;base64,...">'),
    /<img/
  )
})

// --- Tags audited 2026-05-08 as over-permissive vs Tropy editor schema ---
// These tests are SKIPPED until W3.T2 lands — current sanitizer permits them.
// Flip `skip` → undefined to lock in the fix.

test('sanitize [W3.T2]: <u> stripped (Tropy uses span+text-decoration)',() => {
  assert.doesNotMatch(sanitizeHtml('<u>x</u>'), /<u>/)
})

test('sanitize [W3.T2]: <s> stripped',() => {
  assert.doesNotMatch(sanitizeHtml('<s>x</s>'), /<s>/)
})

test('sanitize [W3.T2]: heading tags stripped',() => {
  for (const h of ['h1','h2','h3','h4','h5','h6']) {
    const out = sanitizeHtml(`<${h}>x</${h}>`)
    assert.doesNotMatch(out, new RegExp(`<${h}>`), `${h} should be stripped`)
  }
})

test('sanitize [W3.T2]: code/pre/div stripped',() => {
  assert.doesNotMatch(sanitizeHtml('<code>x</code>'), /<code>/)
  assert.doesNotMatch(sanitizeHtml('<pre>x</pre>'), /<pre>/)
  assert.doesNotMatch(sanitizeHtml('<div>x</div>'), /<div>/)
})

// --- Content survival contract — even when format strips, text remains ---

test('sanitize [W3.T2]: stripped tags retain their text content',() => {
  // After tightening, the dropped tags should leave inner text intact
  for (const tag of ['u', 's', 'h1', 'code', 'pre', 'div']) {
    const out = sanitizeHtml(`<${tag}>visible text</${tag}>`)
    assert.match(out, /visible text/, `${tag} content should survive`)
  }
})
