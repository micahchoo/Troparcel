'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

/**
 * Who wrote an entry, proven rather than claimed.
 *
 * A name in an entry's `author` field is whatever its writer typed, so a
 * member could write, or retract, as someone else. Each member therefore
 * has an ed25519 key pair and signs what they author; others check the
 * signature against the key they pinned for that name the first time they
 * saw it (trust on first use).
 *
 *   let me = Signer.load(dir, 'alice')        // makes the key pair once
 *   value.sig = me.sign('notes', key, value)
 *
 *   let ring = new Keyring(pinned, members)   // pinned: name → key, kept
 *   ring.verify('notes', key, value)          // true, false, or 'unsigned'
 *
 * A signature covers the section, the full key and the value with its
 * fields in sorted order, without `sig`: a signed value cannot be moved to
 * another key, and a writer cannot reuse it with changed fields.
 *
 * An entry whose author has no key anywhere (written by Troparcel 6.0) is
 * 'unsigned' and accepted, so a group can upgrade one member at a time.
 * Once a name has a key, its entries must be signed with it.
 */

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(k => k !== 'sig' && value[k] !== undefined).sort()
      .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

function message(section, key, value) {
  return Buffer.from(`troparcel/1\n${section}\n${key}\n${canonical(value)}`)
}

class Signer {
  constructor(userId, privateKey, publicKey) {
    this.userId = userId
    this._private = privateKey
    this.publicKey = publicKey // base64 of the raw 32-byte key
  }

  /** This member's key pair from `dir`, made and saved on first use. */
  static load(dir, userId) {
    let file = path.join(dir, `${String(userId).replace(/[^a-zA-Z0-9_.@-]/g, '_')}.json`)
    try {
      let { privateKey, publicKey } = JSON.parse(fs.readFileSync(file, 'utf8'))
      return new Signer(userId, crypto.createPrivateKey(privateKey), publicKey)
    } catch {
      let pair = crypto.generateKeyPairSync('ed25519')
      let publicKey = rawPublicKey(pair.publicKey)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({
        privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        publicKey
      }), { mode: 0o600 })
      return new Signer(userId, pair.privateKey, publicKey)
    }
  }

  sign(section, key, value) {
    return crypto.sign(null, message(section, key, value), this._private).toString('base64')
  }
}

class Keyring {
  /**
   * @param {Map<string,string>} pinned  name → public key, kept by the vault
   * @param {() => object} members        the room's published keys, name → { publicKey }
   */
  constructor(pinned, members) {
    this.pinned = pinned
    this.members = members
    this._keys = new Map()
  }

  /** The key for `name`: pinned, or pinned now from the room. */
  keyOf(name) {
    if (!name) return null
    if (!this.pinned.has(name)) {
      let published = this.members()[name]
      if (published && published.publicKey) this.pinned.set(name, published.publicKey)
    }
    return this.pinned.get(name) || null
  }

  /** true if `value` is signed by its author; false if not; 'unsigned' if the author has no key. */
  verify(section, key, value) {
    if (!value || !value.author) return 'unsigned'
    let pub = this.keyOf(value.author)
    if (!pub) return value.sig ? false : 'unsigned'
    if (!value.sig) return false
    try {
      return crypto.verify(null, message(section, key, value), this._key(pub), Buffer.from(value.sig, 'base64'))
    } catch {
      return false
    }
  }

  /** Whether the room's published key for `name` differs from the pinned one. */
  conflicts(name) {
    let published = this.members()[name]
    return !!(published && this.pinned.has(name) && published.publicKey !== this.pinned.get(name))
  }

  _key(pub) {
    let k = this._keys.get(pub)
    if (!k) {
      k = crypto.createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub, 'base64')]),
        format: 'der', type: 'spki'
      })
      this._keys.set(pub, k)
    }
    return k
  }
}

// DER prefix of an ed25519 SubjectPublicKeyInfo; the raw key follows it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function rawPublicKey(keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' }).subarray(ED25519_SPKI_PREFIX.length).toString('base64')
}

module.exports = { Signer, Keyring, canonical }
