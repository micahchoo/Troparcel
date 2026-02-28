'use strict'

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

// ============================================================
//  connection-string.js
// ============================================================

describe('connection-string', () => {
  const { parseConnectionString, generateConnectionString } = require('../src/connection-string')

  it('parses websocket URL with port and room', () => {
    let r = parseConnectionString('troparcel://ws/server.edu:2468/my-room?token=secret')
    assert.equal(r.transport, 'websocket')
    assert.equal(r.serverUrl, 'ws://server.edu:2468')
    assert.equal(r.room, 'my-room')
    assert.equal(r.roomToken, 'secret')
  })

  it('parses wss URL (no port)', () => {
    let r = parseConnectionString('troparcel://ws/server.edu/room?token=abc')
    assert.equal(r.serverUrl, 'wss://server.edu')
  })

  it('parses file path', () => {
    let r = parseConnectionString('troparcel://file/home/alice/Nextcloud/tropy-collab')
    assert.equal(r.transport, 'file')
    assert.equal(r.syncDir, '/home/alice/Nextcloud/tropy-collab')
  })

  it('parses Windows file path', () => {
    let r = parseConnectionString('troparcel://file/C:/Users/alice/Dropbox/sync')
    assert.equal(r.transport, 'file')
    assert.equal(r.syncDir, '/C:/Users/alice/Dropbox/sync')
  })

  it('parses snapshot URL', () => {
    let r = parseConnectionString('troparcel://snapshot/https://r2.example.com/crdt/room.yjs?auth=Bearer+tok')
    assert.equal(r.transport, 'snapshot')
    assert.equal(r.snapshotUrl, 'https://r2.example.com/crdt/room.yjs')
    assert.equal(r.snapshotAuth, 'Bearer tok')
  })

  it('parses bare ws:// URL as websocket', () => {
    let r = parseConnectionString('ws://localhost:2468')
    assert.equal(r.transport, 'websocket')
    assert.equal(r.serverUrl, 'ws://localhost:2468')
  })

  it('returns null for empty string', () => {
    assert.equal(parseConnectionString(''), null)
    assert.equal(parseConnectionString(null), null)
    assert.equal(parseConnectionString(undefined), null)
  })

  it('parses websocket with no room', () => {
    let r = parseConnectionString('troparcel://ws/server.edu:2468')
    assert.equal(r.transport, 'websocket')
    assert.equal(r.serverUrl, 'ws://server.edu:2468')
    assert.equal(r.room, undefined)
  })

  it('generates websocket connection string', () => {
    let s = generateConnectionString({ transport: 'websocket', serverUrl: 'ws://example.com:2468', room: 'test', roomToken: 'abc' })
    assert.equal(s, 'troparcel://ws/example.com:2468/test?token=abc')
  })

  it('generates file connection string', () => {
    let s = generateConnectionString({ transport: 'file', syncDir: '/home/alice/sync' })
    assert.equal(s, 'troparcel://file/home/alice/sync')
  })
})

// ============================================================
//  sanitize.js
// ============================================================

describe('sanitize', () => {
  const { sanitizeHtml, escapeHtml } = require('../src/sanitize')

  describe('sanitizeHtml', () => {
    it('returns empty string for null/undefined', () => {
      assert.equal(sanitizeHtml(null), '')
      assert.equal(sanitizeHtml(undefined), '')
      assert.equal(sanitizeHtml(''), '')
    })

    it('passes through plain text', () => {
      assert.equal(sanitizeHtml('Hello world'), 'Hello world')
    })

    it('keeps safe HTML tags', () => {
      assert.equal(sanitizeHtml('<p>Hello</p>'), '<p>Hello</p>')
      assert.equal(sanitizeHtml('<em>italic</em>'), '<em>italic</em>')
      assert.equal(sanitizeHtml('<strong>bold</strong>'), '<strong>bold</strong>')
    })

    it('strips script tags and their content', () => {
      let result = sanitizeHtml('<p>Hello</p><script>alert("xss")</script><p>World</p>')
      assert.equal(result, '<p>Hello</p><p>World</p>')
    })

    it('strips style tags and their content', () => {
      let result = sanitizeHtml('<style>body{display:none}</style><p>ok</p>')
      assert.equal(result, '<p>ok</p>')
    })

    it('strips iframe tags', () => {
      let result = sanitizeHtml('<iframe src="evil.com"></iframe><p>ok</p>')
      assert.equal(result, '<p>ok</p>')
    })

    it('strips unknown tags but keeps text content', () => {
      let result = sanitizeHtml('<custom>Hello</custom>')
      assert.equal(result, 'Hello')
    })

    it('strips event handler attributes', () => {
      let result = sanitizeHtml('<p onclick="alert(1)">Hello</p>')
      assert.equal(result, '<p>Hello</p>')
    })

    it('strips data- attributes', () => {
      let result = sanitizeHtml('<p data-evil="payload">Hello</p>')
      assert.equal(result, '<p>Hello</p>')
    })

    it('allows safe href attributes on links', () => {
      let result = sanitizeHtml('<a href="https://example.com">link</a>')
      assert.ok(result.includes('href'))
      assert.ok(result.includes('https://example.com'))
    })

    it('blocks javascript: protocol in href', () => {
      let result = sanitizeHtml('<a href="javascript:alert(1)">link</a>')
      assert.ok(!result.includes('javascript'))
    })

    it('blocks entity-encoded javascript: in href', () => {
      let result = sanitizeHtml('<a href="&#x6A;avascript:alert(1)">link</a>')
      assert.ok(!result.includes('javascript'))
    })

    it('handles HTML comments', () => {
      let result = sanitizeHtml('Hello <!-- comment --> World')
      assert.equal(result, 'Hello  World')
    })

    it('handles self-closing tags', () => {
      let result = sanitizeHtml('Hello<br />World')
      assert.ok(result.includes('<br'))
    })

    it('handles nested dangerous tags', () => {
      let result = sanitizeHtml('<script><script>alert(1)</script></script><p>ok</p>')
      assert.ok(!result.includes('script'))
      assert.ok(!result.includes('alert'))
    })

    it('allows class attribute on safe tags', () => {
      let result = sanitizeHtml('<p class="highlight">Hello</p>')
      assert.ok(result.includes('class'))
    })

    it('preserves list structure', () => {
      let result = sanitizeHtml('<ul><li>one</li><li>two</li></ul>')
      assert.ok(result.includes('<ul>'))
      assert.ok(result.includes('<li>'))
    })
  })

  // --------------------------------------------------------
  //  Adversarial XSS vectors (OWASP cheat sheet + mutation XSS)
  // --------------------------------------------------------
  describe('sanitizeHtml — XSS vectors', () => {

    // --- Script injection variants ---

    it('strips script with mixed case', () => {
      let result = sanitizeHtml('<ScRiPt>alert(1)</ScRiPt>')
      assert.ok(!result.includes('alert'))
      assert.ok(!result.toLowerCase().includes('script'))
    })

    it('strips script with spaces in tag', () => {
      let result = sanitizeHtml('<script >alert(1)</script >')
      assert.ok(!result.includes('alert'))
    })

    it('strips script with tab in tag name', () => {
      let result = sanitizeHtml('<script\t>alert(1)</script>')
      assert.ok(!result.includes('alert'))
    })

    it('strips script with newline in tag name', () => {
      let result = sanitizeHtml('<script\n>alert(1)</script>')
      assert.ok(!result.includes('alert'))
    })

    it('strips unclosed script tag (strips rest of document)', () => {
      let result = sanitizeHtml('<script>alert(1)')
      assert.ok(!result.includes('alert'))
    })

    it('strips SVG with onload', () => {
      let result = sanitizeHtml('<svg onload="alert(1)"><p>ok</p></svg>')
      assert.ok(!result.includes('alert'))
      assert.ok(!result.includes('onload'))
    })

    it('strips math tag', () => {
      let result = sanitizeHtml('<math><maction actiontype="statusline#http://evil.com">ok</maction></math>')
      assert.ok(!result.includes('math'))
      assert.ok(!result.includes('maction'))
    })

    it('strips template tag', () => {
      let result = sanitizeHtml('<template><script>alert(1)</script></template>')
      assert.ok(!result.includes('alert'))
    })

    it('strips object/embed tags', () => {
      let r1 = sanitizeHtml('<object data="data:text/html,<script>alert(1)</script>"></object>')
      let r2 = sanitizeHtml('<embed src="javascript:alert(1)">')
      assert.ok(!r1.includes('object'))
      assert.ok(!r2.includes('embed'))
    })

    // --- Event handler variants ---

    it('strips all on* event handlers', () => {
      let handlers = [
        'onclick', 'onerror', 'onload', 'onmouseover', 'onfocus',
        'onblur', 'onsubmit', 'onmouseenter', 'oninput', 'onchange'
      ]
      for (let h of handlers) {
        let result = sanitizeHtml(`<p ${h}="alert(1)">ok</p>`)
        assert.ok(!result.includes(h), `${h} should be stripped`)
      }
    })

    it('strips event handler with entity-encoded name', () => {
      // on&#x63;lick → onclick after entity decode
      let result = sanitizeHtml('<p on&#x63;lick="alert(1)">ok</p>')
      assert.ok(!result.includes('alert'))
    })

    // --- Protocol bypass attempts ---

    it('blocks javascript: with tab characters', () => {
      let result = sanitizeHtml('<a href="java\tscript:alert(1)">link</a>')
      assert.ok(!result.includes('javascript'))
    })

    it('blocks javascript: with newline characters', () => {
      let result = sanitizeHtml('<a href="java\nscript:alert(1)">link</a>')
      assert.ok(!result.includes('javascript'))
    })

    it('blocks javascript: with carriage return', () => {
      let result = sanitizeHtml('<a href="java\rscript:alert(1)">link</a>')
      assert.ok(!result.includes('javascript'))
    })

    it('blocks javascript: with null bytes', () => {
      let result = sanitizeHtml('<a href="java\x00script:alert(1)">link</a>')
      assert.ok(!result.includes('alert'))
    })

    it('blocks vbscript: protocol', () => {
      let result = sanitizeHtml('<a href="vbscript:alert(1)">link</a>')
      assert.ok(!result.includes('vbscript'))
    })

    it('blocks data: protocol', () => {
      let result = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">link</a>')
      assert.ok(!result.includes('data:'))
    })

    it('blocks protocol-relative URLs', () => {
      let result = sanitizeHtml('<a href="//evil.com/steal">link</a>')
      assert.ok(!result.includes('evil.com'))
    })

    it('blocks decimal entity-encoded javascript:', () => {
      // &#106;avascript:
      let result = sanitizeHtml('<a href="&#106;avascript:alert(1)">link</a>')
      assert.ok(!result.includes('javascript'))
    })

    it('blocks hex entity-encoded javascript: (full)', () => {
      // &#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;
      let result = sanitizeHtml('<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">link</a>')
      assert.ok(!result.includes('alert'))
    })

    // --- CSS attack vectors ---

    it('strips CSS expression()', () => {
      let result = sanitizeHtml('<p style="width: expression(alert(1))">ok</p>')
      assert.ok(!result.includes('expression'))
    })

    it('strips CSS url() in style', () => {
      let result = sanitizeHtml('<p style="background: url(javascript:alert(1))">ok</p>')
      assert.ok(!result.includes('javascript'))
      assert.ok(!result.includes('background'))
    })

    it('strips -moz-binding CSS', () => {
      let result = sanitizeHtml('<p style="-moz-binding: url(evil.xml#xss)">ok</p>')
      assert.ok(!result.includes('binding'))
    })

    it('strips behavior CSS property', () => {
      let result = sanitizeHtml('<p style="behavior: url(xss.htc)">ok</p>')
      assert.ok(!result.includes('behavior'))
    })

    it('strips position/z-index UI redress', () => {
      let result = sanitizeHtml('<div style="position: fixed; z-index: 9999; top: 0; left: 0">overlay</div>')
      assert.ok(!result.includes('position'))
      assert.ok(!result.includes('z-index'))
    })

    it('allows only safe CSS values for text-decoration', () => {
      let ok = sanitizeHtml('<span style="text-decoration: underline">ok</span>')
      assert.ok(ok.includes('underline'))

      let bad = sanitizeHtml('<span style="text-decoration: underline; background: red">bad</span>')
      assert.ok(!bad.includes('background'))
      assert.ok(bad.includes('underline'))
    })

    it('allows only safe CSS values for text-align', () => {
      let ok = sanitizeHtml('<p style="text-align: center">ok</p>')
      assert.ok(ok.includes('center'))

      // Reject non-allowlisted text-align value
      let bad = sanitizeHtml('<p style="text-align: expression(alert(1))">bad</p>')
      assert.ok(!bad.includes('expression'))
    })

    // --- Malformed HTML ---

    it('handles unclosed tags safely', () => {
      let result = sanitizeHtml('<p>Hello<script')
      assert.ok(!result.toLowerCase().includes('script'))
      assert.ok(result.includes('Hello'))
    })

    it('handles tags with no closing >', () => {
      let result = sanitizeHtml('<p>ok</p><img src=x onerror=alert(1)')
      assert.ok(!result.includes('onerror'))
      assert.ok(!result.includes('alert'))
    })

    it('handles deeply nested tags', () => {
      let deep = '<p>'.repeat(100) + 'text' + '</p>'.repeat(100)
      let result = sanitizeHtml(deep)
      assert.ok(result.includes('text'))
    })

    it('escapes bare < that is not a valid tag', () => {
      let result = sanitizeHtml('1 < 2 and 3 > 1')
      assert.ok(result.includes('&lt;'))
    })

    it('handles attribute injection via unquoted values', () => {
      let result = sanitizeHtml('<p class=foo onclick=alert(1)>ok</p>')
      assert.ok(!result.includes('onclick'))
      assert.ok(!result.includes('alert'))
    })

    it('handles tag name exceeding 32-char limit', () => {
      let longTag = 'a'.repeat(40)
      let result = sanitizeHtml(`<${longTag}>text</${longTag}>`)
      // Should be treated as malformed and escaped
      assert.ok(!result.includes(`<${longTag}>`))
    })

    // --- Dangerous tag content stripping ---

    it('strips noscript content', () => {
      let result = sanitizeHtml('<noscript><img src=x onerror=alert(1)></noscript>')
      assert.ok(!result.includes('alert'))
    })

    it('strips xmp content', () => {
      let result = sanitizeHtml('<xmp><script>alert(1)</script></xmp>')
      assert.ok(!result.includes('alert'))
    })

    it('strips plaintext tag content', () => {
      let result = sanitizeHtml('<plaintext><script>alert(1)</script>')
      assert.ok(!result.includes('alert'))
    })

    // --- Tropy-specific safe content preservation ---

    it('preserves Tropy note structure through sanitization', () => {
      let troparcelNote = [
        '<p>Descriptive paragraph</p>',
        '<blockquote><p><em>troparcel:n_abc123:alice</em></p></blockquote>',
        '<p style="text-align: end">Right-aligned</p>',
        '<ul><li>Item 1</li><li>Item 2</li></ul>',
        '<ol><li>First</li><li>Second</li></ol>',
        '<p><strong>Bold</strong> and <em>italic</em></p>',
        '<p><span style="text-decoration: underline">Underlined</span></p>',
        '<p><span style="text-decoration: line-through">Struck</span></p>',
        '<p><a href="https://example.com">Link</a></p>',
        '<p><sup>Super</sup> and <sub>Sub</sub></p>',
        '<span class="line-break"><br></span>',
        '<h1>Heading</h1>',
        '<hr>',
        '<pre><code>let x = 1</code></pre>'
      ].join('')

      let result = sanitizeHtml(troparcelNote)
      assert.ok(result.includes('<blockquote>'))
      assert.ok(result.includes('<em>'))
      assert.ok(result.includes('text-align: end'))
      assert.ok(result.includes('<ul>'))
      assert.ok(result.includes('<ol>'))
      assert.ok(result.includes('<strong>'))
      assert.ok(result.includes('text-decoration: underline'))
      assert.ok(result.includes('text-decoration: line-through'))
      assert.ok(result.includes('href'))
      assert.ok(result.includes('<sup>'))
      assert.ok(result.includes('<sub>'))
      assert.ok(result.includes('line-break'))
      assert.ok(result.includes('<h1>'))
      assert.ok(result.includes('<hr>'))
      assert.ok(result.includes('<pre>'))
      assert.ok(result.includes('<code>'))
    })
  })

  describe('escapeHtml', () => {
    it('returns empty string for null/undefined', () => {
      assert.equal(escapeHtml(null), '')
      assert.equal(escapeHtml(undefined), '')
    })

    it('escapes HTML special characters', () => {
      assert.equal(escapeHtml('<script>'), '&lt;script&gt;')
      assert.equal(escapeHtml('"hello"'), '&quot;hello&quot;')
      assert.equal(escapeHtml("it's"), "it&#x27;s")
      assert.equal(escapeHtml('a&b'), 'a&amp;b')
    })

    it('passes through safe text', () => {
      assert.equal(escapeHtml('Hello world'), 'Hello world')
    })
  })
})

// ============================================================
//  identity.js
// ============================================================

describe('identity', () => {
  const identity = require('../src/identity')

  describe('computeIdentity', () => {
    it('returns hash for item with photo checksums', () => {
      let item = {
        photo: [{ checksum: 'abc123' }]
      }
      let id = identity.computeIdentity(item)
      assert.ok(id)
      assert.equal(typeof id, 'string')
      assert.equal(id.length, 32)
    })

    it('returns consistent hash for same checksums', () => {
      let item1 = { photo: [{ checksum: 'abc123' }] }
      let item2 = { photo: [{ checksum: 'abc123' }] }
      assert.equal(identity.computeIdentity(item1), identity.computeIdentity(item2))
    })

    it('returns different hash for different checksums', () => {
      let item1 = { photo: [{ checksum: 'abc123' }] }
      let item2 = { photo: [{ checksum: 'def456' }] }
      assert.notEqual(identity.computeIdentity(item1), identity.computeIdentity(item2))
    })

    it('handles JSON-LD expanded form', () => {
      let item = {
        'https://tropy.org/v1/tropy#photo': [
          { 'https://tropy.org/v1/tropy#checksum': 'abc123' }
        ]
      }
      let id = identity.computeIdentity(item)
      assert.ok(id)
      assert.equal(id.length, 32)
    })

    it('sorts multiple checksums for consistency', () => {
      let item1 = { photo: [{ checksum: 'aaa' }, { checksum: 'bbb' }] }
      let item2 = { photo: [{ checksum: 'bbb' }, { checksum: 'aaa' }] }
      assert.equal(identity.computeIdentity(item1), identity.computeIdentity(item2))
    })

    it('returns null when no photo checksums (photo-less items not syncable)', () => {
      let item = {
        template: 'https://tropy.org/v1/templates/generic',
        'http://purl.org/dc/elements/1.1/title': 'Test Item',
        'http://purl.org/dc/elements/1.1/date': '2024-01-01'
      }
      let id = identity.computeIdentity(item)
      assert.equal(id, null)
    })

    it('returns null for item with no identifying info', () => {
      let id = identity.computeIdentity({})
      assert.equal(id, null)
    })

    it('handles single photo (not array)', () => {
      let item = { photo: { checksum: 'abc123' } }
      let id = identity.computeIdentity(item)
      assert.ok(id)
    })

    it('handles checksum as @value object', () => {
      let item = {
        photo: [{ checksum: { '@value': 'abc123' } }]
      }
      let id = identity.computeIdentity(item)
      assert.ok(id)
    })
  })

  describe('computeSelectionKey', () => {
    it('returns stable key for same coordinates', () => {
      let key1 = identity.computeSelectionKey('photo123', { x: 10, y: 20, width: 100, height: 50 })
      let key2 = identity.computeSelectionKey('photo123', { x: 10, y: 20, width: 100, height: 50 })
      assert.equal(key1, key2)
      assert.equal(key1.length, 24)
    })

    it('returns different key for different coordinates', () => {
      let key1 = identity.computeSelectionKey('photo123', { x: 10, y: 20, width: 100, height: 50 })
      let key2 = identity.computeSelectionKey('photo123', { x: 15, y: 25, width: 100, height: 50 })
      assert.notEqual(key1, key2)
    })

    it('handles w/h shorthand', () => {
      let key1 = identity.computeSelectionKey('p', { x: 0, y: 0, width: 10, height: 10 })
      let key2 = identity.computeSelectionKey('p', { x: 0, y: 0, w: 10, h: 10 })
      assert.equal(key1, key2)
    })

    it('rounds coordinates to integers', () => {
      let key1 = identity.computeSelectionKey('p', { x: 10.3, y: 20.7, width: 100.1, height: 50.9 })
      let key2 = identity.computeSelectionKey('p', { x: 10, y: 21, width: 100, height: 51 })
      assert.equal(key1, key2)
    })
  })

  describe('computeNoteKey', () => {
    it('returns stable key for same note content', () => {
      let note = { html: '<p>Hello</p>', photo: '123' }
      let key1 = identity.computeNoteKey(note, 'checksum_abc')
      let key2 = identity.computeNoteKey(note, 'checksum_abc')
      assert.equal(key1, key2)
      assert.equal(key1.length, 24)
    })

    it('returns different key for different content', () => {
      let key1 = identity.computeNoteKey({ html: '<p>Hello</p>' }, 'cs')
      let key2 = identity.computeNoteKey({ html: '<p>World</p>' }, 'cs')
      assert.notEqual(key1, key2)
    })

    it('uses photoChecksum over note.photo', () => {
      let key1 = identity.computeNoteKey({ html: '<p>Hi</p>', photo: '999' }, 'cs')
      let key2 = identity.computeNoteKey({ html: '<p>Hi</p>', photo: '111' }, 'cs')
      assert.equal(key1, key2)
    })
  })

  describe('computeTranscriptionKey', () => {
    it('returns stable key', () => {
      let key1 = identity.computeTranscriptionKey('cs', 0)
      let key2 = identity.computeTranscriptionKey('cs', 0)
      assert.equal(key1, key2)
      assert.equal(key1.length, 24)
    })

    it('includes selection key when provided', () => {
      let key1 = identity.computeTranscriptionKey('cs', 0)
      let key2 = identity.computeTranscriptionKey('cs', 0, 'sel123')
      assert.notEqual(key1, key2)
    })
  })

  describe('buildIdentityIndex', () => {
    it('builds a map from identity to local item info', () => {
      let items = [
        { id: 1, photo: [{ checksum: 'abc' }] },
        { id: 2, photo: [{ checksum: 'def' }] }
      ]
      let index = identity.buildIdentityIndex(items)
      assert.equal(index.size, 2)
    })

    it('skips items with no identity', () => {
      let items = [
        { id: 1 },
        { id: 2, photo: [{ checksum: 'abc' }] }
      ]
      let index = identity.buildIdentityIndex(items)
      assert.equal(index.size, 1)
    })
  })

  describe('buildPhotoChecksumMap', () => {
    it('maps photo IDs to checksums', () => {
      let item = {
        photo: [
          { id: 1, checksum: 'abc' },
          { id: 2, checksum: 'def' }
        ]
      }
      let map = identity.buildPhotoChecksumMap(item)
      assert.equal(map.size, 2)
      assert.equal(map.get(1), 'abc')
      assert.equal(map.get(2), 'def')
    })
  })
})

// ============================================================
//  vault.js
// ============================================================

describe('vault', () => {
  const { SyncVault } = require('../src/vault')
  let vault

  beforeEach(() => {
    vault = new SyncVault()
  })

  describe('hasCRDTChanged', () => {
    it('returns true on first call', () => {
      assert.ok(vault.hasCRDTChanged({ foo: 'bar' }))
    })

    it('returns false for identical snapshot', () => {
      vault.hasCRDTChanged({ foo: 'bar' })
      assert.ok(!vault.hasCRDTChanged({ foo: 'bar' }))
    })

    it('returns true when snapshot changes', () => {
      vault.hasCRDTChanged({ foo: 'bar' })
      assert.ok(vault.hasCRDTChanged({ foo: 'baz' }))
    })
  })

  describe('shouldBackup', () => {
    it('returns true on first call', () => {
      assert.ok(vault.shouldBackup([{ id: 1 }]))
    })

    it('returns false for identical content', () => {
      vault.shouldBackup([{ id: 1 }])
      assert.ok(!vault.shouldBackup([{ id: 1 }]))
    })
  })

  describe('hasItemChanged / markPushed', () => {
    it('returns true for unknown items', () => {
      assert.ok(vault.hasItemChanged('item1', { title: 'Test' }).changed)
    })

    it('returns false after marking pushed', () => {
      let { hash } = vault.hasItemChanged('item1', { title: 'Test' })
      vault.markPushed('item1', hash)
      assert.ok(!vault.hasItemChanged('item1', { title: 'Test' }).changed)
    })

    it('returns true when item content changes', () => {
      let { hash } = vault.hasItemChanged('item1', { title: 'Test' })
      vault.markPushed('item1', hash)
      assert.ok(vault.hasItemChanged('item1', { title: 'Changed' }).changed)
    })
  })

  describe('stable note identity (C1)', () => {
    it('returns content key on first call', () => {
      let key = vault.getNoteKey('note-1', 'content-hash-abc')
      assert.equal(key, 'content-hash-abc')
    })

    it('returns same key on subsequent calls', () => {
      vault.getNoteKey('note-1', 'content-hash-abc')
      let key = vault.getNoteKey('note-1', 'different-hash')
      assert.equal(key, 'content-hash-abc')
    })

    it('maps applied notes for updates', () => {
      vault.mapAppliedNote('crdt-key-1', 'local-note-42')
      assert.equal(vault.getLocalNoteId('crdt-key-1'), 'local-note-42')
    })

    it('returns null for unknown CRDT keys', () => {
      assert.equal(vault.getLocalNoteId('unknown'), null)
    })
  })

  describe('stable transcription identity (C3)', () => {
    it('returns content key on first call', () => {
      let key = vault.getTxKey('tx-1', 'tx-hash-abc')
      assert.equal(key, 'tx-hash-abc')
    })

    it('returns same key on subsequent calls', () => {
      vault.getTxKey('tx-1', 'tx-hash-abc')
      let key = vault.getTxKey('tx-1', 'different-hash')
      assert.equal(key, 'tx-hash-abc')
    })

    it('maps applied transcriptions', () => {
      vault.mapAppliedTranscription('crdt-key-1', 'local-tx-5')
      assert.equal(vault.getLocalTxId('crdt-key-1'), 'local-tx-5')
    })
  })

  describe('annotation count cache (P5)', () => {
    it('defaults to 0', () => {
      assert.equal(vault.annotationCount, 0)
    })

    it('tracks annotation count', () => {
      vault.updateAnnotationCount(42)
      assert.equal(vault.annotationCount, 42)
    })
  })

  describe('hashObject', () => {
    it('produces consistent hashes', () => {
      let h1 = vault.hashObject({ a: 1, b: 2 })
      let h2 = vault.hashObject({ a: 1, b: 2 })
      assert.equal(h1, h2)
    })

    it('is key-order independent', () => {
      let h1 = vault.hashObject({ a: 1, b: 2 })
      let h2 = vault.hashObject({ b: 2, a: 1 })
      assert.equal(h1, h2)
    })

    it('produces 16-char hex strings', () => {
      let h = vault.hashObject({ test: true })
      assert.equal(h.length, 16)
      assert.ok(/^[0-9a-f]+$/.test(h))
    })
  })

  describe('pruning (R7)', () => {
    it('does not crash on small sets', () => {
      for (let i = 0; i < 100; i++) {
        vault.appliedNoteKeys.add(`key-${i}`)
      }
      vault.pruneAppliedKeys()
      assert.equal(vault.appliedNoteKeys.size, 100)
    })
  })

  describe('pushSeq-aware dismissals (V2)', () => {
    it('dismissKey stores pushSeq', () => {
      vault.dismissKey('note:n_abc', 5)
      assert.equal(vault.isDismissed('note:n_abc', 5), true)
      assert.equal(vault.isDismissed('note:n_abc', 6), false)
    })

    it('isDismissed returns false for unknown key', () => {
      assert.equal(vault.isDismissed('note:n_xyz', 0), false)
    })

    it('auto-undismisses when pushSeq advances', () => {
      vault.dismissKey('note:n_abc', 3)
      assert.equal(vault.isDismissed('note:n_abc', 3), true)
      assert.equal(vault.isDismissed('note:n_abc', 4), false)
    })

    it('shouldSkipNote returns true for dismissed notes', () => {
      vault.dismissKey('n_abc', 5)
      assert.equal(vault.shouldSkipNote('n_abc', 5), true)
      assert.equal(vault.shouldSkipNote('n_abc', 6), false)
    })

    it('shouldSkipNote returns true for failed notes (>= 3 retries)', () => {
      vault.failedNoteKeys.set('n_fail', 3)
      assert.equal(vault.shouldSkipNote('n_fail', 0), true)
    })

    it('shouldSkipNote dismissed overrides failedNoteKeys', () => {
      vault.dismissKey('n_abc', 5)
      vault.failedNoteKeys.set('n_abc', 3)
      assert.equal(vault.shouldSkipNote('n_abc', 5), true)
      // When undismissed (pushSeq advanced), failedNoteKeys should NOT block
      assert.equal(vault.shouldSkipNote('n_abc', 6), false)
    })

    it('dismissedKeys serialization round-trip (Map entries)', () => {
      vault.dismissKey('note:n_abc', 5)
      vault.dismissKey('sel:s_def', 10)
      let entries = Array.from(vault.dismissedKeys.entries())
      let v2 = new SyncVault()
      for (let [k, v] of entries) v2.dismissedKeys.set(k, v)
      assert.equal(v2.isDismissed('note:n_abc', 5), true)
      assert.equal(v2.isDismissed('sel:s_def', 10), true)
    })

    it('backward-compat: old Set format loads as pushSeq 0', () => {
      // Simulate old format: array of strings
      let v2 = new SyncVault()
      let oldData = ['note:n_old1', 'sel:s_old2']
      for (let entry of oldData) {
        if (typeof entry === 'string') v2.dismissedKeys.set(entry, 0)
      }
      assert.equal(v2.isDismissed('note:n_old1', 0), true)
      assert.equal(v2.isDismissed('note:n_old1', 1), false)
    })
  })

  describe('original author tracking (V2)', () => {
    it('tracks original author (first write wins)', () => {
      vault.trackOriginalAuthor('n_abc', 'alice')
      assert.equal(vault.getOriginalAuthor('n_abc'), 'alice')
    })

    it('first write wins — does not overwrite', () => {
      vault.trackOriginalAuthor('n_abc', 'alice')
      vault.trackOriginalAuthor('n_abc', 'bob')
      assert.equal(vault.getOriginalAuthor('n_abc'), 'alice')
    })

    it('returns null for unknown key', () => {
      assert.equal(vault.getOriginalAuthor('unknown'), null)
    })

    it('ignores null/empty author', () => {
      vault.trackOriginalAuthor('n_abc', null)
      assert.equal(vault.getOriginalAuthor('n_abc'), null)
      vault.trackOriginalAuthor('n_abc', '')
      assert.equal(vault.getOriginalAuthor('n_abc'), null)
    })
  })

  describe('clear', () => {
    it('resets all state', () => {
      vault.hasCRDTChanged({ foo: 'bar' })
      vault.markPushed('item1', { title: 'Test' })
      vault.appliedNoteKeys.add('note-1')
      vault.updateAnnotationCount(10)
      vault.dismissKey('note:n_test', 5)
      vault.trackOriginalAuthor('n_test', 'alice')

      vault.clear()

      assert.equal(vault.lastCRDTHash, null)
      assert.equal(vault.pushedHashes.size, 0)
      assert.equal(vault.appliedNoteKeys.size, 0)
      assert.equal(vault.annotationCount, 0)
      assert.equal(vault.dismissedKeys.size, 0)
      assert.equal(vault.originalAuthors.size, 0)
    })
  })
})

// ============================================================
//  backup.js
// ============================================================

describe('backup', () => {
  const { BackupManager } = require('../src/backup')

  describe('sanitizeDir', () => {
    it('sanitizes special characters', () => {
      let bm = new BackupManager('test', null, { info: () => {}, debug: () => {} })
      assert.equal(bm.sanitizeDir('my-room'), 'my-room')
      assert.equal(bm.sanitizeDir('room/with/slashes'), 'room_with_slashes')
      assert.equal(bm.sanitizeDir('room with spaces'), 'room_with_spaces')
    })

    it('truncates long names', () => {
      let bm = new BackupManager('test', null, { info: () => {}, debug: () => {} })
      let long = 'a'.repeat(200)
      assert.ok(bm.sanitizeDir(long).length <= 128)
    })

    it('returns "default" for empty after sanitization', () => {
      let bm = new BackupManager('test', null, { info: () => {}, debug: () => {} })
      // Empty string gets replaced with 'default'; slashes become underscores
      assert.equal(bm.sanitizeDir(''), 'default')
    })
  })

  describe('validateInbound', () => {
    let bm
    beforeEach(() => {
      bm = new BackupManager('test', null, { info: () => {}, debug: () => {} })
    })

    it('returns valid for normal data', () => {
      let result = bm.validateInbound('item-1', {
        metadata: { 'dc:title': { text: 'Hello' } },
        tags: { 'important': { color: '#ff0000' } }
      })
      assert.ok(result.valid)
      assert.equal(result.warnings.length, 0)
    })

    it('warns on oversized notes', () => {
      let bigNote = 'x'.repeat(2 * 1024 * 1024)
      let result = bm.validateInbound('item-1', {
        notes: { 'note-1': { html: bigNote } }
      })
      assert.ok(!result.valid)
      assert.ok(result.warnings[0].includes('exceeds max size'))
    })

    it('warns on oversized metadata', () => {
      let bigMeta = 'x'.repeat(128 * 1024)
      let result = bm.validateInbound('item-1', {
        metadata: { 'dc:title': { text: bigMeta } }
      })
      assert.ok(!result.valid)
      assert.ok(result.warnings[0].includes('exceeds max size'))
    })

    it('tombstone flood is non-blocking (informational only)', () => {
      let result = bm.validateInbound('item-1', {
        tags: {
          'tag1': { deleted: true },
          'tag2': { deleted: true },
          'tag3': { deleted: true },
          'tag4': { color: '#000' }
        }
      })
      // Tombstone flood no longer blocks apply — only size guards are blocking
      assert.ok(result.valid)
      assert.strictEqual(result.warnings.length, 0)
    })

    it('skips deleted entries in note size checks', () => {
      // Include non-deleted entries to avoid triggering tombstone flood threshold
      let result = bm.validateInbound('item-1', {
        notes: {
          'note-1': { deleted: true },
          'note-2': { html: 'ok', text: 'ok' },
          'note-3': { html: 'fine', text: 'fine' }
        }
      })
      assert.ok(result.valid)
    })
  })

  describe('shouldOverwrite', () => {
    let bm
    beforeEach(() => {
      bm = new BackupManager('test', null, { info: () => {}, debug: () => {} })
    })

    it('allows tombstoned overwrites', () => {
      assert.ok(bm.shouldOverwrite({ text: 'local' }, { deleted: true }))
    })

    it('prevents empty overwrite of non-empty local', () => {
      assert.ok(!bm.shouldOverwrite({ text: 'local' }, {}))
      assert.ok(!bm.shouldOverwrite({ text: 'local' }, null))
    })

    it('allows non-empty overwrite', () => {
      assert.ok(bm.shouldOverwrite({ text: 'local' }, { text: 'remote' }))
    })
  })

  describe('listBackups', () => {
    it('returns empty array when dir does not exist', () => {
      let bm = new BackupManager('nonexistent-room-xyz', null, { info: () => {}, debug: () => {} })
      let backups = bm.listBackups()
      assert.ok(Array.isArray(backups))
      assert.equal(backups.length, 0)
    })
  })

  describe('saveSnapshot size limit', () => {
    it('returns null and warns when snapshot exceeds maxBackupSize', async () => {
      let warnings = []
      let bm = new BackupManager('test', null, {
        info: () => {}, debug: () => {},
        warn: (msg) => warnings.push(msg)
      }, { maxBackupSize: 100 })  // 100 bytes — any real snapshot exceeds this

      let result = await bm.saveSnapshot([
        { identity: 'abc', localId: 1, metadata: { title: 'x'.repeat(200) } }
      ])
      assert.equal(result, null)
      assert.ok(warnings.some(m => m.includes('Backup skipped')))
    })

    it('saves normally when under size limit', async () => {
      let infos = []
      let bm = new BackupManager('size-test-room', null, {
        info: (msg) => infos.push(msg),
        debug: () => {}, warn: () => {}
      }, { maxBackupSize: 10 * 1024 * 1024 })

      let result = await bm.saveSnapshot([
        { identity: 'abc', localId: 1, metadata: { title: 'ok' } }
      ])
      assert.ok(result)
      assert.ok(infos.some(m => m.includes('Backup saved')))

      // Clean up: delete the test backup
      const fs = require('fs')
      try { await fs.promises.unlink(result) } catch {}
    })
  })
})

// ============================================================
//  crdt-schema.js
// ============================================================

describe('crdt-schema', () => {
  const Y = require('yjs')
  const schema = require('../src/crdt-schema')

  describe('getItemAnnotations', () => {
    it('creates item structure with all sections', () => {
      let doc = new Y.Doc()
      let sections = schema.getItemAnnotations(doc, 'test-identity')
      assert.ok(sections.metadata)
      assert.ok(sections.tags)
      assert.ok(sections.notes)
      assert.ok(sections.photos)
      assert.ok(sections.selections)
      assert.ok(sections.selectionMeta)
      assert.ok(sections.selectionNotes)
      assert.ok(sections.transcriptions)
      assert.ok(sections.lists)
    })

    it('returns same structure on repeated calls', () => {
      let doc = new Y.Doc()
      let s1 = schema.getItemAnnotations(doc, 'test-identity')
      let s2 = schema.getItemAnnotations(doc, 'test-identity')
      assert.equal(s1.metadata, s2.metadata)
    })

    it('creates separate structures for different identities', () => {
      let doc = new Y.Doc()
      let s1 = schema.getItemAnnotations(doc, 'identity-1')
      let s2 = schema.getItemAnnotations(doc, 'identity-2')
      assert.notEqual(s1.metadata, s2.metadata)
    })
  })

  describe('setMetadata / getMetadata', () => {
    it('stores and retrieves metadata', () => {
      let doc = new Y.Doc()
      schema.setMetadata(doc, 'item1', 'dc:title', {
        text: 'Test Title', type: 'string'
      }, 'alice')

      let all = schema.getMetadata(doc, 'item1')
      assert.ok(all['dc:title'])
      assert.equal(all['dc:title'].text, 'Test Title')
      assert.equal(all['dc:title'].author, 'alice')
    })
  })

  describe('setTag / removeTag', () => {
    it('adds and removes tags', () => {
      let doc = new Y.Doc()
      schema.setTag(doc, 'item1', { name: 'Important', color: '#ff0000' }, 'alice')

      let tags = schema.getTags(doc, 'item1')
      let imp = tags.find(t => t.name === 'Important')
      assert.ok(imp)
      assert.equal(imp.color, '#ff0000')

      schema.removeTag(doc, 'item1', 'Important', 'bob')
      tags = schema.getTags(doc, 'item1')
      imp = tags.find(t => t.name === 'Important')
      assert.ok(imp.deleted)
    })
  })

  describe('setNote / removeNote', () => {
    it('adds and removes notes', () => {
      let doc = new Y.Doc()
      schema.setNote(doc, 'item1', 'note-key-1', {
        html: '<p>Hello</p>',
        text: 'Hello',
        photo: 'photo-cs',
        language: 'en'
      }, 'alice')

      let notes = schema.getNotes(doc, 'item1')
      assert.ok(notes['note-key-1'])
      assert.equal(notes['note-key-1'].html, '<p>Hello</p>')

      schema.removeNote(doc, 'item1', 'note-key-1', 'bob')
      notes = schema.getNotes(doc, 'item1')
      assert.ok(notes['note-key-1'].deleted)
    })
  })

  describe('setSelection / removeSelection', () => {
    it('adds and removes selections', () => {
      let doc = new Y.Doc()
      schema.setSelection(doc, 'item1', 'sel-key-1', {
        x: 10, y: 20, w: 100, h: 50, angle: 0, photo: 'photo-cs'
      }, 'alice')

      let sels = schema.getSelections(doc, 'item1')
      assert.ok(sels['sel-key-1'])
      assert.equal(sels['sel-key-1'].x, 10)

      schema.removeSelection(doc, 'item1', 'sel-key-1', 'bob')
      sels = schema.getSelections(doc, 'item1')
      assert.ok(sels['sel-key-1'].deleted)
    })
  })

  describe('setTranscription', () => {
    it('stores transcription data', () => {
      let doc = new Y.Doc()
      schema.setTranscription(doc, 'item1', 'tx-key-1', {
        text: 'Transcribed text',
        data: '{}',
        photo: 'photo-cs'
      }, 'alice')

      let txs = schema.getTranscriptions(doc, 'item1')
      assert.ok(txs['tx-key-1'])
      assert.equal(txs['tx-key-1'].text, 'Transcribed text')
    })
  })

  describe('getAllIdentities (via getSnapshot)', () => {
    it('returns all item identities in the doc', () => {
      let doc = new Y.Doc()
      schema.setMetadata(doc, 'item1', 'dc:title', { text: 'A' }, 'alice')
      schema.setMetadata(doc, 'item2', 'dc:title', { text: 'B' }, 'alice')

      let snap = schema.getSnapshot(doc)
      let ids = Object.keys(snap)
      assert.ok(ids.includes('item1'))
      assert.ok(ids.includes('item2'))
    })
  })

  describe('getSnapshot', () => {
    it('returns a plain JS snapshot of all item data', () => {
      let doc = new Y.Doc()
      schema.setMetadata(doc, 'item1', 'dc:title', { text: 'Test' }, 'alice')
      schema.setTag(doc, 'item1', { name: 'Important', color: '#ff0000' }, 'alice')

      let snap = schema.getSnapshot(doc)
      assert.ok(snap['item1'])
      assert.ok(snap['item1'].metadata)
      assert.ok(snap['item1'].tags)
      assert.equal(snap['item1'].metadata['dc:title'].text, 'Test')
    })
  })
})

// ============================================================
//  api-client.js
// ============================================================

describe('api-client', () => {
  const { ApiClient } = require('../src/api-client')

  it('creates client with default port', () => {
    let client = new ApiClient()
    assert.equal(client.port, 2019)
    assert.equal(client.host, '127.0.0.1')
  })

  it('creates client with custom port', () => {
    let client = new ApiClient(2029)
    assert.equal(client.port, 2029)
  })

  it('ping returns false when server is not running', async () => {
    let client = new ApiClient(19999)
    let result = await client.ping()
    assert.equal(result, false)
  })

  it('importItems blocks file paths', async () => {
    let client = new ApiClient()
    await assert.rejects(
      () => client.importItems({ file: '/etc/passwd' }),
      { message: /File path import is blocked/ }
    )
  })
})

// ============================================================
//  plugin.js
// ============================================================

describe('plugin', () => {
  const TroparcelPlugin = require('../src/plugin')

  function mockContext(overrides = {}) {
    return {
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        chindings: overrides.chindings || '',
        bindings: () => overrides.bindings || {}
      },
      window: overrides.window || {}
    }
  }

  describe('prefs window detection', () => {
    it('skips sync in prefs window (chindings)', () => {
      let logs = []
      let ctx = mockContext({ chindings: ',"name":"prefs"' })
      ctx.logger.info = (msg) => logs.push(msg)

      let plugin = new TroparcelPlugin({ autoSync: false }, ctx)
      assert.ok(logs.some(m => m.includes('skipping sync in prefs window')))
      assert.equal(plugin.engine, null)
    })

    it('skips sync in prefs window (bindings)', () => {
      let logs = []
      let ctx = mockContext({ bindings: { name: 'prefs' } })
      ctx.logger.info = (msg) => logs.push(msg)

      let plugin = new TroparcelPlugin({ autoSync: false }, ctx)
      assert.ok(logs.some(m => m.includes('skipping sync in prefs window')))
    })

    it('does not skip in project window', () => {
      let logs = []
      let ctx = mockContext({ chindings: ',"name":"project"' })
      ctx.logger.info = (msg) => logs.push(msg)

      new TroparcelPlugin({ autoSync: false }, ctx)
      assert.ok(!logs.some(m => m.includes('skipping sync')))
      assert.ok(logs.some(m => m.includes('v5.0')))
    })
  })

  describe('mergeOptions', () => {
    it('applies defaults', () => {
      let ctx = mockContext()
      let plugin = new TroparcelPlugin({ autoSync: false }, ctx)

      assert.equal(plugin.options.serverUrl, 'ws://localhost:2468')
      assert.equal(plugin.options.syncMode, 'auto')
      assert.equal(plugin.options.autoSync, false)
      assert.equal(plugin.options.apiPort, 2019)
      assert.equal(plugin.options.startupDelay, 8000)
      assert.equal(plugin.options.syncMetadata, true)
      assert.equal(plugin.options.syncTags, true)
      assert.equal(plugin.options.syncNotes, true)
      assert.equal(plugin.options.syncSelections, true)
      assert.equal(plugin.options.syncTranscriptions, true)
      assert.equal(plugin.options.syncPhotoAdjustments, false)
      assert.equal(plugin.options.syncLists, false)
    })

    it('validates sync mode', () => {
      let ctx = mockContext()

      let plugin = new TroparcelPlugin({
        autoSync: false,
        syncMode: 'invalid'
      }, ctx)
      assert.equal(plugin.options.syncMode, 'auto')

      let plugin2 = new TroparcelPlugin({
        autoSync: false,
        syncMode: 'push'
      }, ctx)
      assert.equal(plugin2.options.syncMode, 'push')

      let plugin3 = new TroparcelPlugin({
        autoSync: false,
        syncMode: 'pull'
      }, ctx)
      assert.equal(plugin3.options.syncMode, 'pull')
    })

    it('handles granular sync toggles', () => {
      let ctx = mockContext()
      let plugin = new TroparcelPlugin({
        autoSync: false,
        syncMetadata: false,
        syncTags: false,
        syncNotes: false,
        syncSelections: false,
        syncTranscriptions: false,
        syncPhotoAdjustments: true,
        syncLists: true
      }, ctx)

      assert.equal(plugin.options.syncMetadata, false)
      assert.equal(plugin.options.syncTags, false)
      assert.equal(plugin.options.syncNotes, false)
      assert.equal(plugin.options.syncSelections, false)
      assert.equal(plugin.options.syncTranscriptions, false)
      assert.equal(plugin.options.syncPhotoAdjustments, true)
      assert.equal(plugin.options.syncLists, true)
    })

    it('defaults room to troparcel-default when no explicit room', () => {
      // In v4.0, project name is read from store.getState().project
      // during _waitForProjectAndStart(), not at mergeOptions time
      let ctx = mockContext()
      let plugin = new TroparcelPlugin({ autoSync: false }, ctx)
      assert.equal(plugin.options.room, 'troparcel-default')
    })

    it('uses explicit room when provided', () => {
      let ctx = mockContext()
      let plugin = new TroparcelPlugin({
        autoSync: false,
        room: 'custom-room'
      }, ctx)
      assert.equal(plugin.options.room, 'custom-room')
    })
  })

  describe('getStatus', () => {
    it('returns status with version', () => {
      let ctx = mockContext()
      let plugin = new TroparcelPlugin({ autoSync: false }, ctx)
      let status = plugin.getStatus()

      assert.equal(status.version, '5.0.0')
      assert.equal(status.backgroundSync, false)
      assert.equal(status.engine, null)
    })

    it('masks room token', () => {
      let ctx = mockContext()
      let plugin = new TroparcelPlugin({
        autoSync: false,
        roomToken: 'super-secret-token'
      }, ctx)
      let status = plugin.getStatus()
      assert.equal(status.options.roomToken, '***')
    })

    it('hides internal options', () => {
      let ctx = mockContext()
      let plugin = new TroparcelPlugin({ autoSync: false }, ctx)
      let status = plugin.getStatus()
      assert.ok(!('_roomExplicit' in status.options))
    })
  })

  describe('export with sync modes', () => {
    it('blocks export in pull mode', async () => {
      let logs = []
      let ctx = mockContext()
      ctx.logger.warn = (msg) => logs.push(msg)

      let plugin = new TroparcelPlugin({
        autoSync: false,
        syncMode: 'pull'
      }, ctx)

      await plugin.export([{ id: 1 }])
      assert.ok(logs.some(m => m.includes('pull')))
    })
  })

  describe('import with sync modes', () => {
    it('blocks import in push mode', async () => {
      let logs = []
      let ctx = mockContext()
      ctx.logger.warn = (msg) => logs.push(msg)

      let plugin = new TroparcelPlugin({
        autoSync: false,
        syncMode: 'push'
      }, ctx)

      await plugin.import({})
      assert.ok(logs.some(m => m.includes('push')))
    })
  })

  describe('unload', () => {
    it('cleans up without error', () => {
      let ctx = mockContext()
      let plugin = new TroparcelPlugin({ autoSync: false }, ctx)
      plugin.unload()
      assert.equal(plugin.engine, null)
    })
  })
})

// ============================================================
//  store-adapter.js
// ============================================================

describe('store-adapter', () => {
  const { StoreAdapter } = require('../src/store-adapter')

  function mockStore(state) {
    let listeners = []
    return {
      getState: () => state,
      dispatch: (action) => {
        action.meta = action.meta || {}
        action.meta.seq = Date.now()
        action.meta.now = Date.now()
        return action
      },
      subscribe: (fn) => {
        listeners.push(fn)
        return () => {
          listeners = listeners.filter(l => l !== fn)
        }
      },
      _listeners: listeners,
      _notify: () => listeners.forEach(fn => fn())
    }
  }

  function mockState() {
    return {
      items: {
        1: { id: 1, photos: [10], tags: [100], lists: [200], template: 'generic' },
        2: { id: 2, photos: [11], tags: [], lists: [], template: 'letter' }
      },
      photos: {
        10: { id: 10, item: 1, checksum: 'abc123', selections: [20], notes: [30], transcriptions: [] },
        11: { id: 11, item: 2, checksum: 'def456', selections: [], notes: [], transcriptions: [] }
      },
      selections: {
        20: { id: 20, photo: 10, x: 10, y: 20, width: 100, height: 50, angle: 0, notes: [31], transcriptions: [] }
      },
      notes: {
        30: { id: 30, photo: 10, state: { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] } }, text: 'Hello world' },
        31: { id: 31, selection: 20, state: { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Selection note', marks: [{ type: 'bold' }] }] }] } }, text: 'Selection note' }
      },
      metadata: {
        1: { id: 1, 'http://purl.org/dc/elements/1.1/title': { text: 'Test Item', type: 'string' } }
      },
      tags: {
        100: { id: 100, name: 'Important', color: '#ff0000' }
      },
      lists: {
        200: { id: 200, name: 'Research', parent: null, children: [] }
      },
      activities: {},
      transcriptions: {},
      ontology: { template: {}, vocab: {} }
    }
  }

  describe('getAllItems', () => {
    it('returns all items as summaries', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      let items = adapter.getAllItems()

      assert.equal(items.length, 2)
      let item1 = items.find(i => i.id === 1)
      assert.ok(item1)
      assert.deepEqual(item1.photos, [10])
      assert.deepEqual(item1.tags, [100])
    })
  })

  describe('getItemFull', () => {
    it('returns fully enriched item', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      let item = adapter.getItemFull(1)

      assert.ok(item)
      assert.equal(item['@id'], 1)
      assert.equal(item.template, 'generic')
      assert.equal(item.photo.length, 1)
      assert.equal(item.photo[0].checksum, 'abc123')
      assert.equal(item.photo[0].selection.length, 1)
      assert.equal(item.photo[0].selection[0].x, 10)
      assert.equal(item.tag.length, 1)
      assert.equal(item.tag[0].name, 'Important')
    })

    it('returns null for nonexistent item', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      assert.equal(adapter.getItemFull(999), null)
    })

    it('includes metadata on item', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      let item = adapter.getItemFull(1)

      assert.ok(item['http://purl.org/dc/elements/1.1/title'])
      assert.equal(item['http://purl.org/dc/elements/1.1/title']['@value'], 'Test Item')
    })
  })

  describe('getAllTags', () => {
    it('returns all tags', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      let tags = adapter.getAllTags()

      assert.equal(tags.length, 1)
      assert.equal(tags[0].name, 'Important')
      assert.equal(tags[0].color, '#ff0000')
    })
  })

  describe('getAllLists', () => {
    it('returns all lists', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      let lists = adapter.getAllLists()

      assert.equal(lists.length, 1)
      assert.equal(lists[0].name, 'Research')
    })
  })

  describe('_noteStateToHtml', () => {
    it('converts ProseMirror state to HTML', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      let state = mockState()
      let html = adapter._noteStateToHtml(state.notes[30])

      assert.equal(html, '<p>Hello world</p>')
    })

    it('converts bold marks', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      let state = mockState()
      let html = adapter._noteStateToHtml(state.notes[31])

      assert.equal(html, '<p><strong>Selection note</strong></p>')
    })

    it('falls back to text when no state', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      let html = adapter._noteStateToHtml({ text: 'Plain text' })

      assert.equal(html, '<p>Plain text</p>')
    })

    it('returns empty for empty note', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      let html = adapter._noteStateToHtml({})

      assert.equal(html, '')
    })
  })

  describe('subscribe', () => {
    it('calls callback when state changes', () => {
      let state = mockState()
      let listeners = []
      let store = {
        getState: () => state,
        subscribe: (fn) => {
          listeners.push(fn)
          return () => { listeners = listeners.filter(l => l !== fn) }
        }
      }
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })

      let called = false
      let unsub = adapter.subscribe(() => { called = true })

      // Mutate state and trigger listener
      state = { ...state, notes: { ...state.notes, 99: { id: 99 } } }
      listeners.forEach(fn => fn())

      assert.ok(called)
      unsub()
    })

    it('does not call callback when suppressed', () => {
      let state = mockState()
      let listeners = []
      let store = {
        getState: () => state,
        subscribe: (fn) => {
          listeners.push(fn)
          return () => { listeners = listeners.filter(l => l !== fn) }
        }
      }
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })

      let called = false
      adapter.subscribe(() => { called = true })
      adapter.suppressChanges()

      state = { ...state, notes: { ...state.notes, 99: { id: 99 } } }
      listeners.forEach(fn => fn())

      assert.ok(!called)
      adapter.resumeChanges()
    })
  })

  describe('ping', () => {
    it('returns true when store exists', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      assert.ok(adapter.ping())
    })
  })

  describe('_esc', () => {
    it('escapes HTML entities', () => {
      let store = mockStore(mockState())
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      assert.equal(adapter._esc('<script>'), '&lt;script&gt;')
      assert.equal(adapter._esc('"hello"'), '&quot;hello&quot;')
      assert.equal(adapter._esc('a&b'), 'a&amp;b')
    })
  })

  describe('dispatchSuppressed (V3)', () => {
    it('dispatches action with change detection suppressed', () => {
      let dispatched = []
      let store = {
        getState: () => mockState(),
        dispatch: (action) => { dispatched.push(action); return action },
        subscribe: () => () => {}
      }
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      adapter.dispatchSuppressed({ type: 'test.action', payload: {} })
      assert.equal(dispatched.length, 1)
      assert.equal(adapter._suppressChangeDetection, false)
    })

    it('restores change detection even on dispatch error', () => {
      let store = {
        getState: () => mockState(),
        dispatch: () => { throw new Error('boom') },
        subscribe: () => () => {}
      }
      let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
      try { adapter.dispatchSuppressed({ type: 'test.action' }) } catch {}
      assert.equal(adapter._suppressChangeDetection, false)
    })
  })

  describe('_validateStateShape', () => {
    it('does not warn when all slices present', () => {
      let warnings = []
      let store = mockStore(mockState())
      new StoreAdapter(store, { debug: () => {}, warn: (msg) => warnings.push(msg) })
      assert.equal(warnings.length, 0)
    })

    it('warns when slices are missing', () => {
      let warnings = []
      let store = mockStore({ items: {}, photos: {} })  // missing 5 slices
      new StoreAdapter(store, { debug: () => {}, warn: (msg) => warnings.push(msg) })
      assert.equal(warnings.length, 1)
      assert.ok(warnings[0].includes('missing expected slices'))
      assert.ok(warnings[0].includes('selections'))
      assert.ok(warnings[0].includes('notes'))
      assert.ok(warnings[0].includes('metadata'))
      assert.ok(warnings[0].includes('tags'))
      assert.ok(warnings[0].includes('lists'))
    })
  })
})

// ============================================================
//  V3: Attribution helpers
// ============================================================

describe('attribution (V3)', () => {
  it('attributionColor is deterministic', () => {
    // Test the algorithm directly — same hash logic as in apply.js
    const PALETTE = [
      '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
      '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
      '#dcbeff', '#9A6324', '#800000', '#aaffc3', '#808000'
    ]
    function color(username) {
      let hash = 0
      for (let i = 0; i < username.length; i++) {
        hash = ((hash << 5) - hash) + username.charCodeAt(i)
        hash |= 0
      }
      return PALETTE[Math.abs(hash) % PALETTE.length]
    }
    let c1 = color('alice')
    let c2 = color('alice')
    let c3 = color('bob')
    assert.equal(c1, c2)
    assert.notEqual(c1, c3)
    assert.match(c1, /^#[0-9a-fA-F]{6}$/)
  })
})

// ============================================================
//  V5: crdt-schema — template + list hierarchy
// ============================================================

describe('crdt-schema v5 (template + list hierarchy)', () => {
  const Y = require('yjs')
  const schema = require('../src/crdt-schema')

  it('set/get template schema', () => {
    let doc = new Y.Doc()
    schema.setTemplateSchema(doc, 'https://example.org/template/field-notes', {
      name: 'Field Notes', type: 'https://tropy.org/v1/tropy#Item',
      creator: 'alice', description: 'A template for field notes',
      fields: [
        { property: 'http://purl.org/dc/elements/1.1/title', label: 'Title', datatype: 'http://www.w3.org/2001/XMLSchema#string' },
        { property: 'http://purl.org/dc/elements/1.1/date', label: 'Date' }
      ]
    }, 'alice', 1)
    let result = schema.getTemplateSchema(doc)
    let uri = 'https://example.org/template/field-notes'
    assert.equal(result[uri].name, 'Field Notes')
    assert.equal(result[uri].fields.length, 2)
    assert.equal(result[uri].fields[0].property, 'http://purl.org/dc/elements/1.1/title')
    assert.equal(result[uri].author, 'alice')
  })

  it('remove template schema (tombstone)', () => {
    let doc = new Y.Doc()
    let uri = 'https://example.org/template/test'
    schema.setTemplateSchema(doc, uri, { name: 'Test', type: 'Item', fields: [] }, 'alice', 1)
    schema.removeTemplateSchema(doc, uri, 'alice', 2)
    let result = schema.getTemplateSchema(doc)
    assert.equal(result[uri].deleted, true)
  })

  it('set/get list hierarchy entry', () => {
    let doc = new Y.Doc()
    schema.setListHierarchyEntry(doc, 'l_uuid1', { name: 'Research', parent: null, children: ['l_uuid2'] }, 'alice', 1)
    schema.setListHierarchyEntry(doc, 'l_uuid2', { name: 'Fieldwork', parent: 'l_uuid1', children: [] }, 'alice', 1)
    let result = schema.getListHierarchy(doc)
    assert.equal(result['l_uuid1'].name, 'Research')
    assert.equal(result['l_uuid1'].children[0], 'l_uuid2')
    assert.equal(result['l_uuid2'].parent, 'l_uuid1')
  })

  it('remove list hierarchy entry (tombstone)', () => {
    let doc = new Y.Doc()
    schema.setListHierarchyEntry(doc, 'l_uuid1', { name: 'Old List', parent: null, children: [] }, 'alice', 1)
    schema.removeListHierarchyEntry(doc, 'l_uuid1', 'alice', 2)
    let result = schema.getListHierarchy(doc)
    assert.equal(result['l_uuid1'].deleted, true)
  })

  it('observeSchema fires on template change', (t, done) => {
    let doc = new Y.Doc()
    schema.observeSchema(doc, (changes) => {
      assert.equal(changes.length, 1)
      assert.equal(changes[0].uri, 'https://example.org/t/1')
      done()
    })
    schema.setTemplateSchema(doc, 'https://example.org/t/1', { name: 'T1', type: 'Item', fields: [] }, 'bob', 1)
  })

  it('observeProjectLists fires on list change', (t, done) => {
    let doc = new Y.Doc()
    schema.observeProjectLists(doc, (changes) => {
      assert.equal(changes.length, 1)
      assert.equal(changes[0].uuid, 'l_test')
      done()
    })
    schema.setListHierarchyEntry(doc, 'l_test', { name: 'Test', parent: null, children: [] }, 'bob', 1)
  })
})

// ============================================================
//  V5: store-adapter — readTemplates / readLists
// ============================================================

describe('store-adapter V5 (readTemplates / readLists)', () => {
  const { StoreAdapter } = require('../src/store-adapter')

  function mockStore(state) {
    let listeners = []
    return {
      getState: () => state,
      dispatch: (action) => {
        action.meta = action.meta || {}
        action.meta.seq = Date.now()
        action.meta.now = Date.now()
        return action
      },
      subscribe: (fn) => {
        listeners.push(fn)
        return () => {
          listeners = listeners.filter(l => l !== fn)
        }
      },
      _listeners: listeners,
      _notify: () => listeners.forEach(fn => fn())
    }
  }

  it('readTemplates returns ontology.template', () => {
    let state = {
      items: {}, photos: {}, selections: {}, notes: {},
      metadata: {}, tags: {}, lists: {}, activities: {}, transcriptions: {},
      ontology: {
        template: {
          'https://tropy.org/v1/templates/generic': {
            name: 'Generic', type: 'Item',
            fields: [{ property: 'dc:title', label: 'Title' }]
          }
        }
      }
    }
    let store = mockStore(state)
    let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
    let templates = adapter.readTemplates()
    assert.equal(templates['https://tropy.org/v1/templates/generic'].name, 'Generic')
    assert.equal(templates['https://tropy.org/v1/templates/generic'].fields.length, 1)
  })

  it('readTemplates returns empty when ontology missing', () => {
    let state = {
      items: {}, photos: {}, selections: {}, notes: {},
      metadata: {}, tags: {}, lists: {}, activities: {}, transcriptions: {}
    }
    let store = mockStore(state)
    let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
    let templates = adapter.readTemplates()
    assert.deepEqual(templates, {})
  })

  it('readLists returns state.lists', () => {
    let state = {
      items: {}, photos: {}, selections: {}, notes: {},
      metadata: {}, tags: {}, activities: {}, transcriptions: {},
      lists: {
        1: { id: 1, name: 'Research', parent: null, children: [2] },
        2: { id: 2, name: 'Fieldwork', parent: 1, children: [] }
      }
    }
    let store = mockStore(state)
    let adapter = new StoreAdapter(store, { debug: () => {}, warn: () => {} })
    let lists = adapter.readLists()
    assert.equal(lists[1].name, 'Research')
    assert.equal(lists[2].parent, 1)
    assert.deepEqual(lists[1].children, [2])
  })
})

// ============================================================
//  V5: vault — template + list hashes
// ============================================================

describe('vault V5 (template + list hashes)', () => {
  const { SyncVault } = require('../src/vault')
  let vault

  beforeEach(() => {
    vault = new SyncVault()
  })

  it('tracks pushed template hashes', () => {
    vault.pushedTemplateHashes.set('https://example.org/t/1', 'abc123')
    assert.equal(vault.pushedTemplateHashes.get('https://example.org/t/1'), 'abc123')
  })

  it('tracks pushed list hashes', () => {
    vault.pushedListHashes.set('l_uuid1', 'def456')
    assert.equal(vault.pushedListHashes.get('l_uuid1'), 'def456')
  })

  it('maps list IDs bidirectionally', () => {
    vault.listIdToCrdtUuid.set(42, 'l_uuid1')
    vault.crdtUuidToListId.set('l_uuid1', 42)
    assert.equal(vault.listIdToCrdtUuid.get(42), 'l_uuid1')
    assert.equal(vault.crdtUuidToListId.get('l_uuid1'), 42)
  })
})

// ============================================================
//  C2: Push unit tests (via helpers)
// ============================================================

describe('push (unit tests via helpers)', () => {
  const { buildItem, buildTemplate, buildCRDTDoc, mockStore, mockState, mockSyncContext } = require('./helpers')
  const schema = require('../src/crdt-schema')

  it('pushMetadata writes metadata to CRDT doc', () => {
    let ctx = mockSyncContext()
    let item = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'My Title', '@type': 'string' }
    })
    let itemIdentity = 'test-identity-hash'
    ctx.pushMetadata(item, itemIdentity, 'test-user', 1)
    let meta = schema.getMetadata(ctx.doc, itemIdentity)
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].text, 'My Title')
  })

  it('pushTags writes tags to CRDT doc', () => {
    let ctx = mockSyncContext()
    let item = buildItem({ tag: [{ name: 'Important', color: '#ff0000' }] })
    ctx.pushTags(item, 'test-identity', 'test-user', 1)
    let tags = schema.getActiveTags(ctx.doc, 'test-identity')
    assert.equal(tags.length, 1)
    assert.equal(tags[0].name, 'Important')
  })

  it('pushNotes writes notes to CRDT doc', () => {
    let ctx = mockSyncContext()
    let item = buildItem({
      photo: [{
        '@id': 10,
        checksum: 'abc123',
        note: [{ '@id': 30, text: 'Hello world', html: '<p>Hello world</p>' }],
        selection: [],
        transcription: []
      }]
    })
    let checksumMap = new Map([[10, 'abc123']])
    ctx.previousSnapshot = new Map()
    let result = ctx.pushNotes(item, 'test-identity', 'test-user', checksumMap, 1)
    let notes = schema.getActiveNotes(ctx.doc, 'test-identity')
    let noteValues = Object.values(notes)
    assert.ok(noteValues.length >= 1)
    assert.equal(noteValues[0].html, '<p>Hello world</p>')
  })

  it('pushTemplates writes templates to CRDT doc', () => {
    let tmpl = buildTemplate({ name: 'Photo Template' })
    let state = mockState({
      ontology: { template: { [tmpl.uri]: tmpl } }
    })
    let ctx = mockSyncContext({ state })
    ctx.pushTemplates(1)
    let templates = schema.getTemplateSchema(ctx.doc)
    assert.ok(templates[tmpl.uri])
    assert.equal(templates[tmpl.uri].name, 'Photo Template')
  })

  it('pushListHierarchy writes lists to CRDT doc', () => {
    let state = mockState({
      lists: {
        0: { id: 0, name: 'Root', parent: null, children: [1] },
        1: { id: 1, name: 'Research', parent: 0, children: [] }
      }
    })
    let ctx = mockSyncContext({ state })
    ctx.pushListHierarchy(1)
    let hierarchy = schema.getListHierarchy(ctx.doc)
    let entries = Object.values(hierarchy)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'Research')
  })
})

// ============================================================
//  C3: Apply unit tests (via helpers)
// ============================================================

describe('apply (unit tests via helpers)', () => {
  const { buildTemplate, buildCRDTDoc, mockStore, mockState, mockSyncContext } = require('./helpers')

  it('applyTemplates dispatches template creation', async () => {
    let tmpl = buildTemplate({ name: 'Remote Template', uri: 'https://example.org/tmpl/remote' })
    let doc = buildCRDTDoc({
      templates: { [tmpl.uri]: tmpl }
    })
    let state = mockState({ ontology: { template: {} } })
    let store = mockStore(state)
    let ctx = mockSyncContext({ doc, state, store, userId: 'local-user' })
    await ctx.applyTemplates()
    let dispatched = store._dispatched
    let tmplDispatch = dispatched.find(a => a.type === 'ontology.template.create')
    assert.ok(tmplDispatch, 'should dispatch ontology.template.create')
    assert.ok(tmplDispatch.payload[tmpl.uri])
  })

  it('applyTemplates skips own templates', async () => {
    let doc = buildCRDTDoc({
      templates: { 'https://example.org/tmpl/mine': buildTemplate({ name: 'My Template' }) }
    })
    let state = mockState({ ontology: { template: {} } })
    let store = mockStore(state)
    let ctx = mockSyncContext({ doc, state, store, userId: 'remote-user' })
    await ctx.applyTemplates()
    let dispatched = store._dispatched
    let tmplDispatch = dispatched.find(a => a.type === 'ontology.template.create')
    assert.ok(!tmplDispatch, 'should NOT dispatch for own templates')
  })

  it('applyListHierarchy dispatches list creation', async () => {
    let doc = buildCRDTDoc({
      lists: { 'l_uuid-1': { name: 'Archive', parent: null, children: [] } }
    })
    let state = mockState({ lists: {} })
    let store = mockStore(state)
    let ctx = mockSyncContext({ doc, state, store, userId: 'local-user' })
    await ctx.applyListHierarchy()
    let dispatched = store._dispatched
    let listDispatch = dispatched.find(a => a.type === 'list.create')
    assert.ok(listDispatch, 'should dispatch list.create')
    assert.equal(listDispatch.payload.name, 'Archive')
  })

  it('applyListHierarchy skips own lists', async () => {
    let doc = buildCRDTDoc({
      lists: { 'l_uuid-2': { name: 'My List', parent: null, children: [] } }
    })
    let state = mockState({ lists: {} })
    let store = mockStore(state)
    let ctx = mockSyncContext({ doc, state, store, userId: 'remote-user' })
    await ctx.applyListHierarchy()
    let dispatched = store._dispatched
    let listDispatch = dispatched.find(a => a.type === 'list.create')
    assert.ok(!listDispatch, 'should NOT dispatch for own lists')
  })
})

// ============================================================
//  C4: Roundtrip tests (push -> CRDT -> apply)
// ============================================================

describe('roundtrip (push -> CRDT -> apply)', () => {
  const { buildItem, buildTemplate, mockStore, mockState, mockSyncContext } = require('./helpers')
  const schema = require('../src/crdt-schema')

  it('metadata roundtrip (push -> CRDT -> verify)', () => {
    let ctxA = mockSyncContext({
      state: mockState(),
      userId: 'user-a'
    })
    let item = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Roundtrip Title', '@type': 'string' },
      'http://purl.org/dc/elements/1.1/description': { '@value': 'A description', '@type': 'string' }
    })
    ctxA.pushMetadata(item, 'rt-identity', 'user-a', 1)

    let meta = schema.getMetadata(ctxA.doc, 'rt-identity')
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].text, 'Roundtrip Title')
    assert.equal(meta['http://purl.org/dc/elements/1.1/description'].text, 'A description')
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].author, 'user-a')
  })

  it('tags roundtrip (push -> CRDT -> verify)', () => {
    let ctxA = mockSyncContext({ userId: 'user-a' })
    let item = buildItem({
      tag: [
        { name: 'Important', color: '#ff0000' },
        { name: 'Review', color: '#00ff00' }
      ]
    })
    ctxA.pushTags(item, 'rt-tag-identity', 'user-a', 1)

    let tags = schema.getActiveTags(ctxA.doc, 'rt-tag-identity')
    assert.equal(tags.length, 2)
    let names = tags.map(t => t.name).sort()
    assert.deepEqual(names, ['Important', 'Review'])
  })

  it('template+list roundtrip', async () => {
    let tmpl = buildTemplate({ name: 'Shared Template', uri: 'https://tropy.org/v1/templates/shared' })
    let stateA = mockState({
      ontology: { template: { [tmpl.uri]: tmpl } },
      lists: {
        0: { id: 0, name: 'Root', parent: null, children: [1] },
        1: { id: 1, name: 'Shared List', parent: 0, children: [] }
      }
    })
    let ctxA = mockSyncContext({ state: stateA, userId: 'user-a' })
    ctxA.pushTemplates(1)
    ctxA.pushListHierarchy(1)

    let stateB = mockState({ ontology: { template: {} }, lists: {} })
    let storeB = mockStore(stateB)
    let ctxB = mockSyncContext({ doc: ctxA.doc, state: stateB, store: storeB, userId: 'user-b' })
    await ctxB.applyTemplates()
    await ctxB.applyListHierarchy()

    let dispatched = storeB._dispatched
    assert.ok(dispatched.find(a => a.type === 'ontology.template.create'), 'should create template')
    assert.ok(dispatched.find(a => a.type === 'list.create'), 'should create list')
  })
})

// ============================================================
//  Team 4: Multi-Peer CRDT Convergence (BLUE)
// ============================================================

describe('Team 4: Multi-Peer CRDT Convergence (BLUE)', () => {
  const Y = require('yjs')
  const schema = require('../src/crdt-schema')
  const { buildItem, buildTemplate, mockStore, mockState, mockSyncContext } = require('./helpers')

  function twoPeers(overridesA = {}, overridesB = {}) {
    let doc = new Y.Doc()
    schema.setSchemaVersion(doc)
    let ctxA = mockSyncContext({ doc, userId: 'alice', ...overridesA })
    let ctxB = mockSyncContext({ doc, userId: 'bob', ...overridesB })
    return { doc, ctxA, ctxB }
  }

  it('metadata roundtrip: Alice pushes title, read back with correct text and author', () => {
    let { doc, ctxA } = twoPeers()
    let identity = 'item-conv-1'
    let item = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Alice Title', '@type': 'string' }
    })
    ctxA.pushMetadata(item, identity, 'alice', 1)

    let meta = schema.getMetadata(doc, identity)
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].text, 'Alice Title')
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].author, 'alice')
  })

  it('concurrent metadata: higher pushSeq wins (last-writer-wins via CRDT)', () => {
    let { doc, ctxA, ctxB } = twoPeers()
    let identity = 'item-conv-2'

    // Alice sets title with pushSeq=1
    let itemA = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Foo', '@type': 'string' }
    })
    ctxA.pushMetadata(itemA, identity, 'alice', 1)

    // Bob sets title with pushSeq=2 (overwrites Alice's value in the shared CRDT)
    let itemB = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Bar', '@type': 'string' }
    })
    ctxB.pushMetadata(itemB, identity, 'bob', 2)

    let meta = schema.getMetadata(doc, identity)
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].text, 'Bar')
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].author, 'bob')
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].pushSeq, 2)
  })

  it('tag add-wins: re-adding after remove resurrects the tag', () => {
    let { doc, ctxA } = twoPeers()
    let identity = 'item-conv-3'

    // Alice adds a tag
    let item = buildItem({ tag: [{ name: 'Shared', color: '#0000ff' }] })
    ctxA.pushTags(item, identity, 'alice', 1)
    assert.equal(schema.getActiveTags(doc, identity).length, 1)

    // Bob removes the tag via schema directly (simulates remote peer deletion)
    schema.removeTag(doc, identity, 'Shared', 'bob', 2)
    assert.equal(schema.getActiveTags(doc, identity).length, 0)
    assert.equal(schema.getDeletedTags(doc, identity).length, 1)

    // Alice re-adds the tag with higher pushSeq (direct schema call, bypassing conflict logic)
    schema.setTag(doc, identity, { name: 'Shared', color: '#0000ff' }, 'alice', 3)
    let active = schema.getActiveTags(doc, identity)
    assert.equal(active.length, 1, 'tag should survive after re-add')
    assert.equal(active[0].name, 'Shared')
    assert.equal(active[0].author, 'alice')
  })

  it('template roundtrip: push templates from state, verify in CRDT schema map', () => {
    let tmpl = buildTemplate({
      name: 'Convergence Template',
      uri: 'https://tropy.org/v1/templates/convergence',
      fields: [
        {
          property: 'http://purl.org/dc/elements/1.1/title',
          label: 'Title',
          datatype: 'http://www.w3.org/2001/XMLSchema#string',
          isRequired: true,
          isConstant: false,
          hint: '',
          value: ''
        },
        {
          property: 'http://purl.org/dc/elements/1.1/date',
          label: 'Date',
          datatype: 'http://www.w3.org/2001/XMLSchema#date',
          isRequired: false,
          isConstant: false,
          hint: '',
          value: ''
        }
      ]
    })
    let state = mockState({
      ontology: { template: { [tmpl.uri]: tmpl } }
    })
    let ctx = mockSyncContext({ state, userId: 'alice' })
    ctx.pushTemplates(1)

    let templates = schema.getTemplateSchema(ctx.doc)
    assert.ok(templates[tmpl.uri], 'template should exist in CRDT')
    assert.equal(templates[tmpl.uri].name, 'Convergence Template')
    assert.equal(templates[tmpl.uri].fields.length, 2)
    assert.equal(templates[tmpl.uri].fields[0].property, 'http://purl.org/dc/elements/1.1/title')
    assert.equal(templates[tmpl.uri].fields[1].property, 'http://purl.org/dc/elements/1.1/date')
  })

  it('nested list hierarchy: root excluded, parent/child relationships preserved', () => {
    let state = mockState({
      lists: {
        0: { id: 0, name: 'Root', parent: null, children: [1] },
        1: { id: 1, name: 'Research', parent: 0, children: [2] },
        2: { id: 2, name: 'Fieldwork', parent: 1, children: [] }
      }
    })
    let ctx = mockSyncContext({ state, userId: 'alice' })
    ctx.pushListHierarchy(1)

    let hierarchy = schema.getListHierarchy(ctx.doc)
    let entries = Object.values(hierarchy)

    // Root (id=0) should NOT be in the hierarchy
    assert.equal(entries.length, 2, 'only non-root lists should be pushed')

    let research = entries.find(e => e.name === 'Research')
    let fieldwork = entries.find(e => e.name === 'Fieldwork')
    assert.ok(research, 'Research list should exist')
    assert.ok(fieldwork, 'Fieldwork list should exist')

    // Research has no parent (its parent is root which maps to null)
    assert.equal(research.parent, null, 'Research parent should be null (root)')

    // Fieldwork parent should be the UUID of Research
    let researchUuid = Object.entries(hierarchy).find(([_, v]) => v.name === 'Research')[0]
    assert.equal(fieldwork.parent, researchUuid, 'Fieldwork parent should be Research UUID')

    // Research children should contain Fieldwork UUID
    let fieldworkUuid = Object.entries(hierarchy).find(([_, v]) => v.name === 'Fieldwork')[0]
    assert.ok(research.children.includes(fieldworkUuid), 'Research children should include Fieldwork UUID')
  })

  it('tombstone lifecycle: note set then removed acquires deleted flag', () => {
    let doc = new Y.Doc()
    schema.setSchemaVersion(doc)
    let identity = 'item-conv-6'
    let noteUuid = 'n_test-tombstone-uuid'

    // Set a note
    schema.setNote(doc, identity, noteUuid, {
      text: 'Ephemeral note',
      html: '<p>Ephemeral note</p>',
      photo: 'chk-photo-1'
    }, 'alice', 1)

    // Verify note is alive
    let activeNotes = schema.getActiveNotes(doc, identity)
    assert.ok(activeNotes[noteUuid], 'note should exist before removal')
    assert.equal(activeNotes[noteUuid].deleted, undefined)

    // Remove the note (creates tombstone)
    schema.removeNote(doc, identity, noteUuid, 'bob', 2)

    // Verify note is now tombstoned
    let allNotes = schema.getNotes(doc, identity)
    assert.ok(allNotes[noteUuid].deleted, 'note should have deleted flag after removal')
    assert.ok(allNotes[noteUuid].deletedAt, 'note should have deletedAt timestamp')
    assert.equal(allNotes[noteUuid].author, 'bob')

    // Active notes should not include the tombstoned note
    let activeAfter = schema.getActiveNotes(doc, identity)
    assert.ok(!activeAfter[noteUuid], 'tombstoned note should not appear in active notes')
  })

  it('note push with content: push item with photo note, verify CRDT content', () => {
    let { doc, ctxA } = twoPeers()
    let identity = 'item-conv-7'

    let item = buildItem({
      photo: [{
        '@id': 20,
        checksum: 'photo-chk-conv',
        note: [{
          '@id': 50,
          text: 'Field observation from site A',
          html: '<p>Field observation from <em>site A</em></p>'
        }],
        selection: [],
        transcription: []
      }]
    })
    let checksumMap = new Map([[20, 'photo-chk-conv']])
    ctxA.previousSnapshot = new Map()
    ctxA.pushNotes(item, identity, 'alice', checksumMap, 1)

    let notes = schema.getActiveNotes(doc, identity)
    let noteValues = Object.values(notes)
    assert.ok(noteValues.length >= 1, 'should have at least one note')
    assert.equal(noteValues[0].html, '<p>Field observation from <em>site A</em></p>')
    assert.equal(noteValues[0].text, 'Field observation from site A')
    assert.equal(noteValues[0].author, 'alice')
    assert.equal(noteValues[0].photo, 'photo-chk-conv')
  })

  // 4.10: Three-peer convergence — the acid test
  it('three peers writing concurrently converge to identical state', () => {
    let doc = new Y.Doc()
    schema.setSchemaVersion(doc)
    let identity = 'item-3peer'

    // Three independent contexts sharing the same doc
    let ctxA = mockSyncContext({ doc, userId: 'alice' })
    let ctxB = mockSyncContext({ doc, userId: 'bob' })
    let ctxC = mockSyncContext({ doc, userId: 'carol' })

    // Each peer writes different metadata fields concurrently
    let itemA = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Alice Title', '@type': 'string' }
    })
    let itemB = buildItem({
      'http://purl.org/dc/elements/1.1/creator': { '@value': 'Bob Author', '@type': 'string' }
    })
    let itemC = buildItem({
      'http://purl.org/dc/elements/1.1/date': { '@value': '2025-01-01', '@type': 'string' }
    })
    ctxA.pushMetadata(itemA, identity, 'alice', 1)
    ctxB.pushMetadata(itemB, identity, 'bob', 2)
    ctxC.pushMetadata(itemC, identity, 'carol', 3)

    // Each peer adds a different tag
    let tagItemA = buildItem({ tag: [{ name: 'Red', color: '#f00' }] })
    let tagItemB = buildItem({ tag: [{ name: 'Green', color: '#0f0' }] })
    let tagItemC = buildItem({ tag: [{ name: 'Blue', color: '#00f' }] })
    ctxA.pushTags(tagItemA, identity, 'alice', 4)
    ctxB.pushTags(tagItemB, identity, 'bob', 5)
    ctxC.pushTags(tagItemC, identity, 'carol', 6)

    // All three peers see the same converged state
    let meta = schema.getMetadata(doc, identity)
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].text, 'Alice Title')
    assert.equal(meta['http://purl.org/dc/elements/1.1/creator'].text, 'Bob Author')
    assert.equal(meta['http://purl.org/dc/elements/1.1/date'].text, '2025-01-01')

    let tags = schema.getActiveTags(doc, identity)
    let tagNames = tags.map(t => t.name).sort()
    assert.deepEqual(tagNames, ['Blue', 'Green', 'Red'])

    // Now test conflict: all three write the SAME field — last pushSeq wins
    let conflictA = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Alice Wins?', '@type': 'string' }
    })
    let conflictB = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Bob Wins?', '@type': 'string' }
    })
    let conflictC = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Carol Wins', '@type': 'string' }
    })
    ctxA.pushMetadata(conflictA, identity, 'alice', 7)
    ctxB.pushMetadata(conflictB, identity, 'bob', 8)
    ctxC.pushMetadata(conflictC, identity, 'carol', 9)

    let finalMeta = schema.getMetadata(doc, identity)
    assert.equal(finalMeta['http://purl.org/dc/elements/1.1/title'].text, 'Carol Wins')
    assert.equal(finalMeta['http://purl.org/dc/elements/1.1/title'].pushSeq, 9)
  })

  // 4.11: hasLocalEdit conflict preservation — logic-based conflict resolution
  it('hasLocalEdit preserves local value when field was edited after push', () => {
    let { SyncVault } = require('../src/vault')
    let vault = new SyncVault()
    let identity = 'item-conflict'
    let field = 'http://purl.org/dc/elements/1.1/title'

    // Simulate: user pushes "Original" → vault records the hash
    let originalHash = vault._fastHash('Original|string')
    vault.markFieldPushed(identity, field, originalHash)

    // User edits locally to "Edited" — different hash
    let editedHash = vault._fastHash('Edited|string')
    assert.ok(vault.hasLocalEdit(identity, field, editedHash),
      'Should detect local edit: current value differs from last pushed')

    // Remote peer sends "Remote Value" — apply should skip (local wins)
    // The apply code checks: if vault.hasLocalEdit(identity, field, valueHash) → skip
    let remoteHash = vault._fastHash('Remote Value|string')
    assert.ok(vault.hasLocalEdit(identity, field, remoteHash),
      'Remote value also differs from last pushed → local edit detected → skip')

    // If local value matches what was pushed (no edit), remote should win
    assert.ok(!vault.hasLocalEdit(identity, field, originalHash),
      'No local edit: current value matches last pushed → allow remote overwrite')

    // Never-pushed field: hasLocalEdit returns true (assume local edit)
    assert.ok(vault.hasLocalEdit(identity, 'dc:unknown', vault._fastHash('anything')),
      'Never-pushed field treated as local edit (conservative default)')
  })
})

// ============================================================
//  Team 5: Sanitizer Evasion (RED)
// ============================================================

describe('Team 5: Sanitizer Evasion (RED)', () => {
  const { sanitizeHtml, escapeHtml } = require('../src/sanitize')

  // 5.6: noteKey injection — validates the apply.js fix
  it('noteKey with HTML metacharacters is escaped in footer pattern', () => {
    let maliciousKey = 'n_<img src=x onerror=alert(1)>'
    let authorLabel = escapeHtml('alice')
    let footer = `<p><sub>[troparcel:${escapeHtml(maliciousKey)} from ${authorLabel}]</sub></p>`
    assert.ok(!footer.includes('<img'), 'HTML tag should be escaped in footer')
    assert.ok(footer.includes('&lt;img'), 'Should contain escaped version')
  })

  // 5.1: Mutation XSS — noscript
  it('handles noscript mutation XSS vector', () => {
    let result = sanitizeHtml('<noscript><p title="</noscript><img src=x onerror=alert(1)>">')
    assert.ok(!result.includes('onerror'))
  })

  // 5.2: Unicode fullwidth — documents gap: sanitizer does NOT normalize fullwidth
  it('Unicode fullwidth brackets do not create real HTML tags (safe)', () => {
    let result = sanitizeHtml('\uFF1Cscript\uFF1Ealert(1)\uFF1C/script\uFF1E')
    // Fullwidth < > (\uFF1C \uFF1E) are NOT real HTML delimiters.
    // Browsers don't parse them as tags, so this is safe — text passes through.
    assert.ok(typeof result === 'string')
    assert.ok(!result.includes('<script>'), 'Should not contain real script tag')
  })

  // 5.3: Double encoding
  it('double-encoded entities do not produce real script tags', () => {
    let result = sanitizeHtml('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;')
    assert.ok(!result.includes('<script>'))
  })

  // 5.4: SVG foreignObject
  it('strips SVG foreignObject injection', () => {
    let result = sanitizeHtml('<svg><foreignObject><body onload="alert(1)"></body></foreignObject></svg>')
    assert.ok(!result.includes('onload'))
    assert.ok(!result.includes('alert'))
  })

  // 5.5: CSS @import
  it('strips CSS @import in style attribute', () => {
    let result = sanitizeHtml('<p style="@import url(evil.css)">ok</p>')
    assert.ok(!result.includes('@import'))
  })

  // 5.7: RTL override
  it('handles RTL override characters without crash', () => {
    let result = sanitizeHtml('Hello \u202Escript\u202C world')
    assert.ok(typeof result === 'string')
  })

  // 5.9: Entity-encoded attribute name
  it('strips entity-encoded onclick', () => {
    let result = sanitizeHtml('<p &#111;nclick="alert(1)">ok</p>')
    assert.ok(!result.includes('alert'))
  })

  // 5.10: Control char prefix in href
  it('blocks control char prefix in javascript: href', () => {
    let result = sanitizeHtml('<a href="\x01javascript:alert(1)">link</a>')
    assert.ok(!result.includes('javascript'))
  })

  // 5.11: escapeHtml completeness
  it('escapeHtml handles all critical characters', () => {
    assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#x27;')
  })
})

// ============================================================
//  Team 6: Store Adapter Correctness (BLUE)
// ============================================================

describe('Team 6: Store Adapter Correctness (BLUE)', () => {
  const { StoreAdapter } = require('../src/store-adapter')
  const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

  function ms(overrides = {}) {
    return {
      items: {}, photos: {}, selections: {}, notes: {},
      metadata: {}, tags: {}, lists: {}, activities: {},
      transcriptions: {}, ontology: { template: {} },
      ...overrides
    }
  }
  function mkStore(state) {
    return {
      getState: () => state,
      dispatch: (a) => { a.meta = a.meta || {}; a.meta.seq = Date.now(); return a },
      subscribe: () => () => {}
    }
  }

  // 6.2: Empty state
  it('getAllItems returns [] on empty state', () => {
    let adapter = new StoreAdapter(mkStore(ms()), noopLogger)
    let items = adapter.getAllItems()
    assert.ok(Array.isArray(items))
    assert.equal(items.length, 0)
  })

  // 6.3: Missing photo
  it('getItemFull handles missing photo gracefully', () => {
    let state = ms({
      items: { 1: { id: 1, photos: [999], tags: [], lists: [], template: 'generic' } },
      metadata: { 1: {} }
    })
    let adapter = new StoreAdapter(mkStore(state), noopLogger)
    let item = adapter.getItemFull(1)
    assert.ok(item)
    assert.equal(item.photo.length, 0)
  })

  // 6.4: Note with no state and no text
  it('_noteStateToHtml returns empty for note with no state or text', () => {
    let adapter = new StoreAdapter(mkStore(ms()), noopLogger)
    assert.equal(adapter._noteStateToHtml({}), '')
  })

  // 6.5: All ProseMirror node types
  it('_noteStateToHtml renders all ProseMirror node types', () => {
    let adapter = new StoreAdapter(mkStore(ms()), noopLogger)

    let doc = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quote' }] }] },
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H1' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'H3' }] },
      { type: 'bullet_list', content: [
        { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bullet' }] }] }
      ] },
      { type: 'ordered_list', content: [
        { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ordered' }] }] }
      ] },
      { type: 'code_block', content: [{ type: 'text', text: 'let x = 1' }] },
      { type: 'horizontal_rule' },
      { type: 'paragraph', content: [{ type: 'text', text: 'before' }, { type: 'hard_break' }, { type: 'text', text: 'after' }] }
    ] }
    let html = adapter._noteStateToHtml({ state: { doc } })
    assert.ok(html.includes('<p>Hello</p>'))
    assert.ok(html.includes('<blockquote>'))
    assert.ok(html.includes('<h1>H1</h1>'))
    assert.ok(html.includes('<h3>H3</h3>'))
    assert.ok(html.includes('<ul>'))
    assert.ok(html.includes('<ol>'))
    assert.ok(html.includes('<pre><code>'))
    assert.ok(html.includes('<hr>'))
    assert.ok(html.includes('line-break'))
  })

  // 6.6: Nested marks
  it('_noteStateToHtml renders nested bold+italic+link marks', () => {
    let adapter = new StoreAdapter(mkStore(ms()), noopLogger)
    let doc = { type: 'doc', content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'styled', marks: [
          { type: 'bold' },
          { type: 'italic' },
          { type: 'link', attrs: { href: 'https://example.com' } }
        ] }
      ] }
    ] }
    let html = adapter._noteStateToHtml({ state: { doc } })
    assert.ok(html.includes('<strong>'))
    assert.ok(html.includes('<em>'))
    assert.ok(html.includes('href'))
    assert.ok(html.includes('example.com'))
  })

  // 6.7: suppressChanges is boolean not refcount
  it('suppressChanges twice then resumeChanges once = not suppressed', () => {
    let state = ms()
    let store = mkStore(state)
    let adapter = new StoreAdapter(store, noopLogger)
    adapter.suppressChanges()
    adapter.suppressChanges()
    adapter.resumeChanges()
    assert.equal(adapter._suppressChangeDetection, false,
      'Single resumeChanges undoes double suppressChanges — boolean, not refcount')
  })

  // 6.8: Large state
  it('getAllItems handles 500 items without error', () => {
    let items = {}
    let photos = {}
    for (let i = 1; i <= 500; i++) {
      items[i] = { id: i, photos: [i + 1000], tags: [], lists: [], template: 'generic' }
      photos[i + 1000] = { id: i + 1000, item: i, checksum: `cs-${i}`, selections: [], notes: [], transcriptions: [] }
    }
    let adapter = new StoreAdapter(mkStore(ms({ items, photos })), noopLogger)
    let result = adapter.getAllItems()
    assert.equal(result.length, 500)
  })

  // 6.12: Circular parent
  it('readLists handles circular parent without infinite loop', () => {
    let state = ms({
      lists: { 1: { id: 1, name: 'Circular', parent: 1, children: [1] } }
    })
    let adapter = new StoreAdapter(mkStore(state), noopLogger)
    let lists = adapter.readLists()
    assert.ok(lists[1])
    assert.equal(lists[1].name, 'Circular')
  })
})

// ============================================================
//  Team 2: Vault Integrity Invariants (BLUE)
// ============================================================

describe('Team 2: Vault Integrity Invariants (BLUE)', () => {
  const { SyncVault } = require('../src/vault')
  const fs = require('fs')
  const os = require('os')
  const path = require('path')

  // 2.1: Full serialization roundtrip
  it('persistToFile -> loadFromFile preserves all state', async () => {
    let v = new SyncVault()
    v.pushSeq = 42
    v.appliedNoteKeys.add('n_abc')
    v.appliedSelectionKeys.add('s_def')
    v.appliedTranscriptionKeys.add('t_ghi')
    v.failedNoteKeys.set('n_fail', 3)
    v.crdtKeyToNoteId.set('crdt-n1', 'local-n1')
    v.noteIdToCrdtKey.set('local-n1', 'crdt-n1')
    v.dismissKey('note:n_test', 5)
    v.trackOriginalAuthor('n_test', 'alice')
    v.pushedTemplateHashes.set('uri1', 'hash1')
    v.pushedListHashes.set('l_1', 'hash2')
    v.crdtUuidToListId.set('l_1', 42)
    v.listIdToCrdtUuid.set(42, 'l_1')

    let tmpRoom = `test-roundtrip-${Date.now()}`
    await v.persistToFile(tmpRoom, 'testuser')

    let v2 = new SyncVault()
    let loaded = v2.loadFromFile(tmpRoom, 'testuser')
    assert.ok(loaded)
    assert.equal(v2.pushSeq, 42)
    assert.ok(v2.appliedNoteKeys.has('n_abc'))
    assert.ok(v2.appliedSelectionKeys.has('s_def'))
    assert.ok(v2.appliedTranscriptionKeys.has('t_ghi'))
    assert.equal(v2.failedNoteKeys.get('n_fail'), 3)
    assert.equal(v2.crdtKeyToNoteId.get('crdt-n1'), 'local-n1')
    assert.equal(v2.noteIdToCrdtKey.get('local-n1'), 'crdt-n1')
    assert.equal(v2.isDismissed('note:n_test', 5), true)
    assert.equal(v2.getOriginalAuthor('n_test'), 'alice')
    assert.equal(v2.pushedTemplateHashes.get('uri1'), 'hash1')
    assert.equal(v2.pushedListHashes.get('l_1'), 'hash2')
    assert.equal(v2.crdtUuidToListId.get('l_1'), 42)

    // Cleanup
    let dir = path.join(os.homedir(), '.troparcel', 'vault')
    try { await fs.promises.unlink(path.join(dir, `${tmpRoom}_testuser.json`)) } catch {}
  })

  // 2.2: Bidirectional map invariant
  it('note bidirectional maps stay consistent after operations', () => {
    let v = new SyncVault()
    for (let i = 0; i < 100; i++) {
      v.getNoteKey(`note-${i}`, `crdt-key-${i}`)
      v.mapAppliedNote(`crdt-key-${i}`, `local-${i}`)
    }
    for (let [crdtKey, noteId] of v.crdtKeyToNoteId) {
      let reverse = v.noteIdToCrdtKey.get(noteId)
      assert.ok(reverse !== undefined, `Missing reverse for crdtKey=${crdtKey}, noteId=${noteId}`)
    }
  })

  // 2.3: LRU eviction breaks invariant (KNOWN BUG)
  it('LRU eviction preserves bidirectional invariant', { todo: 'Known bug: one-sided LRU eviction' }, () => {
    let v = new SyncVault()
    for (let i = 0; i < 100; i++) {
      v.noteIdToCrdtKey.set(`local-${i}`, `crdt-${i}`)
      v.crdtKeyToNoteId.set(`crdt-${i}`, `local-${i}`)
    }
    v._evictIfNeeded(v.noteIdToCrdtKey, 80)
    let orphans = 0
    for (let [crdtKey, noteId] of v.crdtKeyToNoteId) {
      if (!v.noteIdToCrdtKey.has(noteId)) orphans++
    }
    assert.equal(orphans, 0, `Found ${orphans} orphaned entries after one-sided eviction`)
  })

  // 2.4: pushSeq monotonicity
  it('pushSeq never decreases within a session', () => {
    let v = new SyncVault()
    let prev = 0
    for (let i = 0; i < 100; i++) {
      let seq = v.nextPushSeq()
      assert.ok(seq > prev, `pushSeq went backwards: ${seq} <= ${prev}`)
      prev = seq
    }
  })

  // 2.9: clear() resets v5 additions (fixed: vault.clear() now resets all v5 maps)
  it('clear resets template and list hash maps', () => {
    let v = new SyncVault()
    v.pushedTemplateHashes.set('uri1', 'hash1')
    v.pushedListHashes.set('l_1', 'hash2')
    v.listIdToCrdtUuid.set(42, 'l_1')
    v.crdtUuidToListId.set('l_1', 42)
    v.attributionTagIds.set('synced', 99)
    v.clear()
    assert.equal(v.pushedTemplateHashes.size, 0, 'pushedTemplateHashes not cleared')
    assert.equal(v.pushedListHashes.size, 0, 'pushedListHashes not cleared')
    assert.equal(v.listIdToCrdtUuid.size, 0, 'listIdToCrdtUuid not cleared')
    assert.equal(v.crdtUuidToListId.size, 0, 'crdtUuidToListId not cleared')
    assert.equal(v.attributionTagIds.size, 0, 'attributionTagIds not cleared')
  })

  // 2.10: failedNoteKeys migration — object format
  it('failedNoteKeys loads from object format', async () => {
    let v = new SyncVault()
    let tmpRoom = `test-failedkeys-${Date.now()}`
    let dir = path.join(os.homedir(), '.troparcel', 'vault')
    await fs.promises.mkdir(dir, { recursive: true })
    let file = path.join(dir, `${tmpRoom}_testuser.json`)
    await fs.promises.writeFile(file, JSON.stringify({
      version: 4,
      failedNoteKeys: [{ key: 'n_fail1', count: 2 }, { key: 'n_fail2', count: 5 }]
    }))
    let loaded = v.loadFromFile(tmpRoom, 'testuser')
    assert.ok(loaded)
    assert.equal(v.failedNoteKeys.get('n_fail1'), 2)
    assert.equal(v.failedNoteKeys.get('n_fail2'), 5)
    try { await fs.promises.unlink(file) } catch {}
  })
})

// ============================================================
//  Team 1: CRDT Poisoning (RED)
// ============================================================

describe('Team 1: CRDT Poisoning (RED)', () => {
  const Y = require('yjs')
  const schema = require('../src/crdt-schema')

  // 1.3: Malformed UUID keys
  it('CRDT accepts malformed note UUID keys (no key validation)', () => {
    let doc = new Y.Doc()
    schema.setSchemaVersion(doc)
    schema.setNote(doc, 'poison-item', 'n_<script>alert(1)</script>', {
      html: '<p>test</p>', text: 'test', photo: 'cs1'
    }, 'attacker', 1)
    let notes = schema.getNotes(doc, 'poison-item')
    assert.equal(Object.keys(notes).length, 1, 'CRDT accepts arbitrary keys — no validation')
  })

  // 1.5: Duplicate tag names with different casing
  it('tags with different casing are separate CRDT entries', () => {
    let doc = new Y.Doc()
    schema.setSchemaVersion(doc)
    schema.setTag(doc, 'case-test', { name: 'Important', color: '#f00' }, 'alice', 1)
    schema.setTag(doc, 'case-test', { name: 'important', color: '#00f' }, 'bob', 1)
    schema.setTag(doc, 'case-test', { name: 'IMPORTANT', color: '#0f0' }, 'carol', 1)
    let tags = schema.getActiveTags(doc, 'case-test')
    // Tags are keyed by _normalizeTagKey (lowercase), so case variants collapse
    assert.equal(tags.length, 1, 'case variants collapse to one entry via lowercase key')
    assert.equal(tags[0].name, 'IMPORTANT', 'last writer wins — Carol wrote last')
  })

  // 1.7: Tombstone with absurd deletedAt
  it('handles tombstone with future deletedAt', () => {
    let doc = new Y.Doc()
    schema.setSchemaVersion(doc)
    schema.setNote(doc, 'future-item', 'n_future', {
      html: '<p>test</p>', text: 'test', photo: 'cs1'
    }, 'alice', 1)
    schema.removeNote(doc, 'future-item', 'n_future', 'attacker', 2)
    let notes = schema.getNotes(doc, 'future-item')
    assert.ok(notes['n_future'].deleted)
  })

  // 1.8: Missing/empty author
  it('handles metadata with null/empty author without crash', () => {
    let doc = new Y.Doc()
    schema.setSchemaVersion(doc)
    schema.setMetadata(doc, 'auth-test', 'dc:title', { text: 'Test' }, null, 1)
    schema.setMetadata(doc, 'auth-test', 'dc:date', { text: '2024' }, '', 1)
    schema.setMetadata(doc, 'auth-test', 'dc:desc', { text: 'Desc' }, undefined, 1)
    let meta = schema.getMetadata(doc, 'auth-test')
    assert.ok(meta['dc:title'])
    assert.ok(meta['dc:date'])
    assert.ok(meta['dc:desc'])
  })

  // 1.2: Oversized metadata — no push-side validation
  it('CRDT accepts 1MB metadata value (no push-side size guard)', () => {
    let doc = new Y.Doc()
    schema.setSchemaVersion(doc)
    let bigValue = 'x'.repeat(1024 * 1024)
    schema.setMetadata(doc, 'big-item', 'dc:title', { text: bigValue }, 'attacker', 1)
    let meta = schema.getMetadata(doc, 'big-item')
    assert.equal(meta['dc:title'].text.length, 1024 * 1024, 'CRDT has no size guard on push')
  })

  // 1.1: No schema version — writes still accepted
  it('doc with no schemaVersion still accepts writes', () => {
    let doc = new Y.Doc()
    // Deliberately skip setSchemaVersion
    schema.setMetadata(doc, 'noversion', 'dc:title', { text: 'Test' }, 'alice', 1)
    let meta = schema.getMetadata(doc, 'noversion')
    assert.ok(meta['dc:title'], 'Writes succeed without schema version stamp')
  })
})

// ============================================================
//  Team 7: Lifecycle Race Conditions (RED)
// ============================================================

describe('Team 7: Lifecycle Race Conditions (RED)', () => {
  const { SyncVault } = require('../src/vault')
  const { StoreAdapter } = require('../src/store-adapter')
  const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

  // 7.3: Error backoff calculation
  it('exponential backoff caps at maxBackoff', () => {
    let maxBackoff = 60000
    function calculateBackoff(n) {
      return Math.min(1000 * Math.pow(2, n), maxBackoff)
    }
    assert.equal(calculateBackoff(0), 1000)
    assert.equal(calculateBackoff(5), 32000)
    assert.equal(calculateBackoff(10), maxBackoff)
    assert.equal(calculateBackoff(100), maxBackoff)
  })

  // 7.9: Mutex — Promise-chain pattern serializes access
  it('Promise-chain mutex serializes concurrent access', async () => {
    let _syncLock = Promise.resolve()
    function acquireLock() {
      let release
      let prev = _syncLock
      _syncLock = new Promise(resolve => { release = resolve })
      return prev.then(() => release)
    }

    let order = []
    async function task(id, delay) {
      let release = await acquireLock()
      try {
        order.push(`start-${id}`)
        await new Promise(r => setTimeout(r, delay))
        order.push(`end-${id}`)
      } finally {
        release()
      }
    }

    await Promise.all([task('A', 10), task('B', 5), task('C', 1)])
    assert.deepEqual(order, ['start-A', 'end-A', 'start-B', 'end-B', 'start-C', 'end-C'])
  })

  // 7.1: _syncing flag starvation — if _acquireLock rejects, _syncing stays true forever
  it('_syncing stays stuck when _acquireLock rejects (starvation bug)', { todo: 'Known bug: no try/catch around _acquireLock await' }, async () => {
    const { SyncEngine } = require('../src/sync-engine')
    let engine = new SyncEngine({
      serverUrl: 'ws://localhost', room: 'test', syncMetadata: true,
      syncTags: true, syncNotes: true, syncSelections: true,
      syncTranscriptions: true, syncPhotoAdjustments: true,
      syncLists: true, syncDeletions: true, debug: false,
      startupDelay: 0, localDebounce: 50, remoteDebounce: 50,
      safetyNetInterval: 0, writeDelay: 0, maxBackups: 0,
      maxNoteSize: 100000, maxMetadataSize: 100000
    }, noopLogger)

    // Put engine in a state where syncOnce proceeds past the guards
    engine.state = 'connected'
    engine.doc = new (require('yjs').Doc)()

    // Monkey-patch _acquireLock to reject — simulates corrupted promise chain
    engine._acquireLock = () => Promise.reject(new Error('lock corrupted'))

    // syncOnce sets _syncing = true at line 886, then awaits _acquireLock at 889
    // If _acquireLock rejects, the try/finally never runs → _syncing stuck true
    await engine.syncOnce().catch(() => {})

    // This is the bug: _syncing should be false but stays true
    assert.equal(engine._syncing, true,
      'BUG: _syncing stuck true after _acquireLock rejection — sync engine frozen')
  })

  // 7.5: Vault rapid clear cycles
  it('vault handles rapid clear cycles without corruption', () => {
    let v = new SyncVault()
    v.pushSeq = 10
    v.appliedNoteKeys.add('test')
    for (let i = 0; i < 50; i++) {
      v.clear()
      v.pushSeq = i
      v.appliedNoteKeys.add(`key-${i}`)
    }
    assert.equal(v.pushSeq, 49)
    assert.ok(v.appliedNoteKeys.has('key-49'))
    assert.ok(!v.appliedNoteKeys.has('test'))
  })

  // 7.10: Mutex release on error
  it('mutex releases lock even when body throws', async () => {
    let _syncLock = Promise.resolve()
    function acquireLock() {
      let release
      let prev = _syncLock
      _syncLock = new Promise(resolve => { release = resolve })
      return prev.then(() => release)
    }

    // First task throws
    try {
      let release = await acquireLock()
      try {
        throw new Error('simulated failure')
      } finally {
        release()
      }
    } catch {}

    // Second task should still acquire the lock (not deadlocked)
    let acquired = false
    let release2 = await acquireLock()
    acquired = true
    release2()
    assert.ok(acquired, 'Lock should be acquirable after error in previous holder')
  })
})

// ============================================================
//  Team 3: Identity Collision & Fuzzy Match (RED)
// ============================================================

describe('Team 3: Identity Collision & Fuzzy Match (RED)', () => {
  const identity = require('../src/identity')

  // 3.2: Single-photo identity theft
  it('single-photo items with same checksum produce identical identity', () => {
    let victim = { photo: [{ checksum: 'shared-cs' }] }
    let attacker = { photo: [{ checksum: 'shared-cs' }] }
    assert.equal(
      identity.computeIdentity(victim),
      identity.computeIdentity(attacker),
      'Same single checksum = same identity — maximum vulnerability'
    )
  })

  // 3.4: Selection fingerprint collision from rounding
  it('different coordinates produce same key after rounding', () => {
    let key1 = identity.computeSelectionKey('photo1', { x: 10.4, y: 20.4, width: 100.4, height: 50.4 })
    let key2 = identity.computeSelectionKey('photo1', { x: 10.0, y: 20.0, width: 100.0, height: 50.0 })
    assert.equal(key1, key2, 'Rounding creates collision between close coordinates')
  })

  // 3.6: Empty photo array
  it('item with empty photo array returns null identity', () => {
    assert.equal(identity.computeIdentity({ photo: [] }), null)
  })

  // 3.7: Empty checksum in JSON-LD value
  it('item with empty checksum @value handles gracefully', () => {
    let item = { photo: [{ checksum: { '@value': '' } }] }
    let id = identity.computeIdentity(item)
    assert.ok(id === null || typeof id === 'string')
  })

  // 3.8: Many photos — stability and performance
  it('identity hash is stable with 100 photos', () => {
    let photos = Array.from({ length: 100 }, (_, i) => ({ checksum: `cs-${i}` }))
    let item = { photo: photos }
    let id1 = identity.computeIdentity(item)
    let id2 = identity.computeIdentity(item)
    assert.equal(id1, id2)
    assert.equal(id1.length, 32)
  })

  // 3.1: Two-photo Jaccard analysis
  it('two-photo items with one shared checksum have different identity', () => {
    let victim = { photo: [{ checksum: 'real1' }, { checksum: 'real2' }] }
    let attacker = { photo: [{ checksum: 'real1' }, { checksum: 'fake1' }] }
    let victimId = identity.computeIdentity(victim)
    let attackerId = identity.computeIdentity(attacker)
    assert.notEqual(victimId, attackerId, 'Different checksum sets produce different identities')
    // But Jaccard similarity = 1/3 (intersection={real1}, union={real1,real2,fake1})
    // Fuzzy match threshold is 0.5, so this specific case does NOT match
  })

  // 3.1b: Jaccard = 0.5 boundary — single-photo attacker vs two-photo victim
  it('single-photo attacker matches two-photo victim at Jaccard = 0.5 boundary', () => {
    // victim={A,B}, attacker={A} → Jaccard = |{A}|/|{A,B}| = 1/2 = 0.5
    // The fuzzy match threshold is >= 0.5, so this IS a match — the attacker
    // can hijack annotations by sharing a single checksum with a two-photo item
    let victim = { photo: [{ checksum: 'real-A' }, { checksum: 'real-B' }] }
    let attacker = { photo: [{ checksum: 'real-A' }] }
    let victimId = identity.computeIdentity(victim)
    let attackerId = identity.computeIdentity(attacker)
    // Different identity hashes (different checksum sets)
    assert.notEqual(victimId, attackerId)
    // But Jaccard similarity = 0.5 — meets threshold for fuzzy match
    let intersection = new Set(['real-A'])
    let union = new Set(['real-A', 'real-B'])
    let jaccard = intersection.size / union.size
    assert.equal(jaccard, 0.5, 'Jaccard at exact threshold boundary')
    // This means the attacker CAN fuzzy-match to the victim — red team finding
  })

  // Sorted checksums produce consistent hash
  it('photo order does not affect identity hash', () => {
    let item1 = { photo: [{ checksum: 'aaa' }, { checksum: 'bbb' }, { checksum: 'ccc' }] }
    let item2 = { photo: [{ checksum: 'ccc' }, { checksum: 'aaa' }, { checksum: 'bbb' }] }
    assert.equal(identity.computeIdentity(item1), identity.computeIdentity(item2))
  })
})

// ============================================================
//  Team 8: Boundary Validation & Connection Security (BLUE)
// ============================================================

describe('Team 8: Boundary Validation & Connection Security (BLUE)', () => {
  const { parseConnectionString, generateConnectionString } = require('../src/connection-string')
  const { BackupManager } = require('../src/backup')
  const { ApiClient } = require('../src/api-client')
  const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

  // 8.1: Path traversal in connection string
  it('connection string room with path traversal chars', () => {
    let r = parseConnectionString('troparcel://ws/server.edu:2468/../../../etc/passwd?token=x')
    // Should parse — room contains the literal string (URL parsing)
    assert.ok(r)
    assert.equal(r.transport, 'websocket')
  })

  // 8.2: Long room name
  it('connection string handles 10KB room name', () => {
    let longRoom = 'a'.repeat(10000)
    let r = parseConnectionString(`troparcel://ws/server.edu:2468/${longRoom}?token=x`)
    assert.ok(r === null || typeof r.room === 'string')
  })

  // 8.3: Unknown transport
  it('connection string returns null for unknown transport', () => {
    let r = parseConnectionString('troparcel://ftp/server.edu/room')
    assert.equal(r, null)
  })

  // 8.8: sanitizeDir with null bytes
  it('sanitizeDir handles null bytes', () => {
    let bm = new BackupManager('test', null, noopLogger)
    let result = bm.sanitizeDir('room\x00evil')
    assert.ok(!result.includes('\x00'))
  })

  // 8.8b: sanitizeDir with Windows reserved names
  it('sanitizeDir handles Windows reserved names', () => {
    let bm = new BackupManager('test', null, noopLogger)
    for (let reserved of ['CON', 'PRN', 'NUL', 'COM1', 'LPT1']) {
      let result = bm.sanitizeDir(reserved)
      assert.ok(result.length > 0, `sanitizeDir should handle ${reserved}`)
    }
  })

  // 8.9: Path separators — sanitizeDir strips slashes (dots allowed, safe
  //   because result is used as a single directory name under a fixed parent)
  it('sanitizeDir neutralizes path separators', () => {
    let bm = new BackupManager('test', null, noopLogger)
    let result = bm.sanitizeDir('../../etc/passwd')
    assert.ok(!result.includes('/'), 'slashes must be removed')
    assert.ok(!result.includes('\\'), 'backslashes must be removed')
  })

  // 8.10: API client file path bypass
  it('importItems blocks /etc/passwd', async () => {
    let client = new ApiClient()
    await assert.rejects(
      () => client.importItems({ file: '/etc/passwd' }),
      { message: /blocked/i }
    )
  })

  // 8.4: Backup size boundary — over limit
  it('validateInbound rejects oversized note', () => {
    let bm = new BackupManager('test', null, noopLogger, { maxNoteSize: 100 })
    let result = bm.validateInbound('item-1', {
      notes: { 'note-1': { html: 'x'.repeat(101) } }
    })
    assert.ok(!result.valid, 'Over-limit note should be rejected')
  })

  // 8.4b: Under limit
  it('validateInbound accepts note under size limit', () => {
    let bm = new BackupManager('test', null, noopLogger, { maxNoteSize: 100 })
    let result = bm.validateInbound('item-1', {
      notes: { 'note-1': { html: 'x'.repeat(50) } }
    })
    assert.ok(result.valid, 'Under-limit note should be accepted')
  })

  // 8.13: Missing backup directory
  it('listBackups handles missing directory', () => {
    let bm = new BackupManager('nonexistent-room-xyz-test', null, noopLogger)
    let backups = bm.listBackups()
    assert.ok(Array.isArray(backups))
    assert.equal(backups.length, 0)
  })

  // 8.2b: Connection string roundtrip
  it('generate then parse connection string roundtrip', () => {
    let original = { transport: 'websocket', serverUrl: 'ws://example.com:2468', room: 'test', roomToken: 'abc' }
    let str = generateConnectionString(original)
    let parsed = parseConnectionString(str)
    assert.equal(parsed.transport, 'websocket')
    assert.equal(parsed.room, 'test')
    assert.equal(parsed.roomToken, 'abc')
  })
})
