'use strict'

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

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

    it('falls back to template+title+date when no checksums', () => {
      let item = {
        template: 'https://tropy.org/v1/templates/generic',
        'http://purl.org/dc/elements/1.1/title': 'Test Item',
        'http://purl.org/dc/elements/1.1/date': '2024-01-01'
      }
      let id = identity.computeIdentity(item)
      assert.ok(id)
      assert.equal(id.length, 32)
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
      assert.ok(vault.hasItemChanged('item1', { title: 'Test' }))
    })

    it('returns false after marking pushed', () => {
      vault.markPushed('item1', { title: 'Test' })
      assert.ok(!vault.hasItemChanged('item1', { title: 'Test' }))
    })

    it('returns true when item content changes', () => {
      vault.markPushed('item1', { title: 'Test' })
      assert.ok(vault.hasItemChanged('item1', { title: 'Changed' }))
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

  describe('clear', () => {
    it('resets all state', () => {
      vault.hasCRDTChanged({ foo: 'bar' })
      vault.markPushed('item1', { title: 'Test' })
      vault.appliedNoteKeys.add('note-1')
      vault.updateAnnotationCount(10)

      vault.clear()

      assert.equal(vault.lastCRDTHash, null)
      assert.equal(vault.pushedHashes.size, 0)
      assert.equal(vault.appliedNoteKeys.size, 0)
      assert.equal(vault.annotationCount, 0)
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

    it('warns on tombstone flood', () => {
      let result = bm.validateInbound('item-1', {
        tags: {
          'tag1': { deleted: true },
          'tag2': { deleted: true },
          'tag3': { deleted: true },
          'tag4': { color: '#000' }
        }
      })
      assert.ok(!result.valid)
      assert.ok(result.warnings[0].includes('Tombstone flood'))
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

  describe('user registration', () => {
    it('registers and deregisters users', () => {
      let doc = new Y.Doc()
      schema.registerUser(doc, 123, 'alice')

      let users = schema.getUsers(doc)
      let alice = users.find(u => u.userId === 'alice')
      assert.ok(alice)

      schema.deregisterUser(doc, 123)
      users = schema.getUsers(doc)
      alice = users.find(u => u.userId === 'alice')
      assert.ok(!alice)
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
      assert.ok(logs.some(m => m.includes('v3.1')))
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

    it('uses project name for room if not explicit', () => {
      let ctx = mockContext({
        window: { project: { name: 'my-project' } }
      })
      let plugin = new TroparcelPlugin({ autoSync: false }, ctx)
      assert.equal(plugin.options.room, 'my-project')
    })

    it('prefers explicit room over project name', () => {
      let ctx = mockContext({
        window: { project: { name: 'my-project' } }
      })
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

      assert.equal(status.version, '3.1.0')
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
