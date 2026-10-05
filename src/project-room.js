'use strict'

const fs = require('fs')
const path = require('path')
const schema = require('./crdt-schema')

/**
 * A project room: photos travel with the room, so a member who lacks an
 * item gets it, photos and all. (In an overlay room, the default, photos
 * stay on each computer and only annotations travel.)
 *
 *   let room = new ProjectRoom({ doc, transport, adapter, vault, dir, logger, origin })
 *   await room.share(localIndex)   // record each item; upload its photos once
 *   await room.importMissing()     // import room items this project lacks
 *
 * Only the item and its photos are imported. The item's metadata, notes,
 * tags and the rest arrive by ordinary sync, since the photos' checksums,
 * and so the item's identity, are the same as on the computer they came
 * from.
 *
 * A photo is a blob on the transport, named by its MD5: the checksum Tropy
 * gives it. Downloads are kept in `dir`, and the imported photos point
 * there.
 */

const TROPY = 'https://tropy.org/v1/tropy#'
// The photo fields Tropy's JSON-LD import reads (src/common/export.js).
const PHOTO_FIELDS = [
  'checksum', 'mimetype', 'filename', 'width', 'height', 'size',
  'orientation', 'page', 'density', 'color'
]
const IMPORT_BATCH = 50

class ProjectRoom {
  constructor({ doc, transport, adapter, vault, dir, logger, origin, roomKey = null }) {
    this.doc = doc
    this.roomKey = roomKey // an encrypted room: photos are sealed (room-key.js)
    this.transport = transport
    this.adapter = adapter
    this.vault = vault
    this.dir = dir
    this.logger = logger
    this.origin = origin
    this._recorded = new WeakSet() // item objects whose record is current
    this._waiting = new Set()      // identities waiting for a photo
  }

  /**
   * Write each item's record and upload each photo not yet shared.
   * `localIndex`: identity → { localId, item }.
   */
  async share(localIndex) {
    let uploads = []
    this.doc.transact(() => {
      for (let [identity, { localId, item }] of localIndex) {
        if (item && this._recorded.has(item)) continue
        let raw = this.adapter.getItem(localId)
        if (!raw) continue
        let photos = (raw.photos || []).map(id => this.adapter.getPhoto(id)).filter(Boolean)
        if (photos.length === 0) continue
        schema.setItemRecord(this.doc, identity, {
          template: raw.template,
          photos: photos.map(pickPhotoFields)
        })
        for (let p of photos) {
          if (!this.vault.sharedPhotos.has(p.checksum)) uploads.push(p)
        }
        if (item) this._recorded.add(item)
      }
    }, this.origin)

    let shared = 0
    for (let p of uploads) {
      if (this.vault.sharedPhotos.has(p.checksum)) continue
      try {
        if (p.protocol && p.protocol !== 'file') continue
        await this._upload(p.checksum, await fs.promises.readFile(p.path))
        this.vault.sharedPhotos.add(p.checksum)
        this.vault.markDirty()
        shared++
      } catch (err) {
        this.logger.warn(`[troparcel] could not share photo ${p.filename || p.checksum}: ${err.message}`)
      }
    }
    if (shared > 0) this.logger.info(`[troparcel] shared ${shared} photo(s)`)
    return shared
  }

  /**
   * Import the room's items this project lacks. An item is skipped when any
   * of its photos is already here (the item was merged or split; matching
   * handles it) or when it has an alias (it is an old form of another
   * item). An item whose photos have not all reached the room waits for a
   * later cycle. Returns the number of items imported.
   */
  async importMissing() {
    let local = new Set(this.adapter.getAllChecksums())
    let ready = []
    for (let identity of schema.getIdentities(this.doc)) {
      let record = schema.getItemRecord(this.doc, identity)
      if (!record || !Array.isArray(record.photos) || record.photos.length === 0) continue
      if (schema.resolveAlias(this.doc, identity)) continue
      if (record.photos.some(p => local.has(p.checksum))) continue
      let files = await this._download(record.photos)
      if (!files) {
        if (!this._waiting.has(identity)) {
          this._waiting.add(identity)
          this.logger.info(`[troparcel] item ${identity.slice(0, 8)} waits for its photos to reach the room`)
        }
        continue
      }
      this._waiting.delete(identity)
      ready.push({ record, files })
      for (let p of record.photos) local.add(p.checksum)
    }

    let imported = 0
    for (let i = 0; i < ready.length; i += IMPORT_BATCH) {
      let batch = ready.slice(i, i + IMPORT_BATCH)
      try {
        await this.adapter.importItems(batch.map(toJsonLd), batch.map(b => b.record.photos[0].checksum))
        imported += batch.length
      } catch (err) {
        this.logger.warn(`[troparcel] could not import ${batch.length} item(s): ${err.message}`)
      }
    }
    if (imported > 0) this.logger.info(`[troparcel] imported ${imported} item(s) from the room`)
    return imported
  }

  async _upload(checksum, bytes) {
    if (!this.roomKey) return this.transport.putBlob(checksum, bytes)
    return this.transport.putBlob(this.roomKey.blobName(checksum), this.roomKey.sealBlob(bytes), { sealed: true })
  }

  /** A photo's plain bytes, or null. In an encrypted room, opened and checked. */
  async _fetch(checksum) {
    if (!this.roomKey) return this.transport.getBlob(checksum)
    let sealed = await this.transport.getBlob(this.roomKey.blobName(checksum), { sealed: true })
    if (!sealed) return null
    let bytes = this.roomKey.openBlob(sealed)
    let md5 = require('crypto').createHash('md5').update(bytes).digest('hex')
    if (md5 !== checksum) throw new Error(`photo ${checksum} opened to other bytes (${md5})`)
    return bytes
  }

  /** Local paths of the photos, downloading those not here; null if any is missing. */
  async _download(photos) {
    let files = []
    for (let p of photos) {
      let file = path.join(this.dir, p.checksum + extension(p))
      if (!fs.existsSync(file)) {
        let bytes
        try { bytes = await this._fetch(p.checksum) } catch (err) {
          this.logger.warn(`[troparcel] could not download photo ${p.checksum}: ${err.message}`)
          return null
        }
        if (!bytes) return null
        await fs.promises.mkdir(this.dir, { recursive: true })
        let tmp = `${file}.part`
        await fs.promises.writeFile(tmp, bytes)
        await fs.promises.rename(tmp, file)
      }
      files.push(file)
    }
    return files
  }
}

function pickPhotoFields(photo) {
  let out = {}
  for (let f of PHOTO_FIELDS) if (photo[f] != null) out[f] = photo[f]
  return out
}

function extension(photo) {
  let ext = photo.filename && path.extname(photo.filename)
  if (ext) return ext.toLowerCase()
  let sub = String(photo.mimetype || '').split('/')[1] || 'bin'
  return '.' + sub.replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')
}

/** One item in Tropy's JSON-LD export form, with full IRIs. */
function toJsonLd({ record, files }) {
  let lit = value => [{ '@value': value }]
  let node = {
    '@type': [`${TROPY}Item`],
    [`${TROPY}photo`]: [{
      '@list': record.photos.map((p, i) => {
        let photo = {
          '@type': [`${TROPY}Photo`],
          [`${TROPY}path`]: lit(files[i]),
          [`${TROPY}protocol`]: lit('file')
        }
        for (let f of PHOTO_FIELDS) if (p[f] != null) photo[`${TROPY}${f}`] = lit(p[f])
        return photo
      })
    }]
  }
  if (record.template) node[`${TROPY}template`] = [{ '@id': record.template }]
  return node
}

module.exports = { ProjectRoom, toJsonLd }
