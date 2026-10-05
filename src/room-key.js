'use strict'

const crypto = require('crypto')

/**
 * End-to-end encryption for a room. The key travels in the connection
 * string (`key=`) and never reaches the server, which stores and relays
 * ciphertext.
 *
 *   let rk = RoomKey.generate()            // or new RoomKey(base64url)
 *   let sealed = rk.seal('notes', key, value)
 *   rk.open('notes', key, sealed)           // value, or null
 *
 * What the server can still read: entry keys (item identities are hashes,
 * entries are UUIDs; metadata keys are property URIs, so which fields are
 * used, not what they hold), each name's public key, and the two fields a
 * tombstone purge needs (`deleted`, `deletedAt`). Tag keys, which would be
 * tag names, are an HMAC instead (`tagKey`). Photos are sealed whole
 * (`sealBlob`).
 *
 * AES-256-GCM, with the entry's section and full key as associated data:
 * a sealed value cannot be moved to another entry. In an encrypted room a
 * value that is not sealed, or does not open, reads as absent: someone
 * with the room token but not the key cannot inject entries.
 */
class RoomKey {
  constructor(secret) {
    let raw = Buffer.from(String(secret), 'base64url')
    if (raw.length !== 32) throw new Error('a room key is 32 bytes, in base64url (43 characters)')
    this._enc = Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.alloc(0), 'troparcel/1 values', 32))
    this._mac = Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.alloc(0), 'troparcel/1 tags', 32))
    this._blob = Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.alloc(0), 'troparcel/1 photos', 32))
    this._names = Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.alloc(0), 'troparcel/1 photo names', 32))
  }

  /** A new random room key, as the connection string carries it. */
  static generate() {
    return crypto.randomBytes(32).toString('base64url')
  }

  seal(section, key, value) {
    let iv = crypto.randomBytes(12)
    let cipher = crypto.createCipheriv('aes-256-gcm', this._enc, iv)
    cipher.setAAD(Buffer.from(`${section}\n${key}`))
    let body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    let out = { enc: Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64') }
    if (value && value.deleted) {
      out.deleted = true
      if (value.deletedAt) out.deletedAt = value.deletedAt
    }
    return out
  }

  open(section, key, sealed) {
    if (!sealed || typeof sealed.enc !== 'string') return null
    try {
      let raw = Buffer.from(sealed.enc, 'base64')
      let decipher = crypto.createDecipheriv('aes-256-gcm', this._enc, raw.subarray(0, 12))
      decipher.setAAD(Buffer.from(`${section}\n${key}`))
      decipher.setAuthTag(raw.subarray(12, 28))
      return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString())
    } catch {
      return null
    }
  }

  /** The room key for a tag: an HMAC of its lowercase name, not the name. */
  tagKey(name) {
    return 't_' + crypto.createHmac('sha256', this._mac).update(String(name).toLowerCase()).digest('hex').slice(0, 32)
  }

  /** Where a sealed photo is stored: an HMAC of its checksum, not the checksum. */
  blobName(checksum) {
    return crypto.createHmac('sha256', this._names).update(String(checksum)).digest('hex').slice(0, 32)
  }

  sealBlob(bytes) {
    let iv = crypto.randomBytes(12)
    let cipher = crypto.createCipheriv('aes-256-gcm', this._blob, iv)
    let body = Buffer.concat([cipher.update(bytes), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), body])
  }

  openBlob(sealed) {
    let decipher = crypto.createDecipheriv('aes-256-gcm', this._blob, sealed.subarray(0, 12))
    decipher.setAuthTag(sealed.subarray(12, 28))
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()])
  }
}

module.exports = { RoomKey }
