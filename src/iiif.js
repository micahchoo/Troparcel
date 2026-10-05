'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/**
 * Publish Tropy items as IIIF: Presentation 3 manifests whose notes,
 * selections and transcriptions are W3C Web Annotations.
 *
 *   let out = toIIIF(jsonld, { baseUrl: 'https://example.edu/letters' })
 *   // out.collection, out.manifests: [{ file, json }], out.images: [{ source, file }]
 *   await writeIIIF(jsonld, '/srv/www/letters', { baseUrl })
 *
 * The input is what Tropy hands an export plugin (src/selectors/export.js):
 * compact JSON-LD, `@vocab` Tropy's namespace, items holding photos holding
 * notes, transcriptions and selections.
 *
 *   item          → Manifest, its metadata and tags as `metadata`
 *   photo         → Canvas, painted with the image
 *   note          → Annotation, motivation commenting, on the canvas
 *   selection note → the same, on `<canvas>#xywh=x,y,w,h`
 *   transcription → Annotation, motivation supplementing
 *
 * A note that came from a collaborator carries Troparcel's footer; it is
 * dropped and its author becomes the annotation's `creator`.
 */

const PRESENTATION = 'http://iiif.io/api/presentation/3/context.json'
// Troparcel's author line on a collaborator's note: 6.1+ (a link), and 6.0 (text).
const FOOTERS = [
  /<p>(?:<sub>)?<a href="troparcel:[^"]*">(?:<sub>)?— (?:withdrawn by )?([^<]+?)(?:<\/sub>)?<\/a>(?:<\/sub>)?<\/p>\s*$/,
  /<p><sub>\[troparcel:[^\]]*? (?:from|retracted by) ([^\]—]+?) — safe to delete, do not edit\]<\/sub><\/p>\s*$/
]

function toIIIF(doc, { baseUrl }) {
  if (!baseUrl) throw new Error('IIIF needs the address the files will be published at (baseUrl)')
  let base = String(baseUrl).replace(/\/+$/, '')
  let graph = Array.isArray(doc) ? doc : (doc['@graph'] || [doc])
  let manifests = []
  let images = new Map()

  for (let item of graph) {
    let photos = list(item.photo)
    if (photos.length === 0) continue
    let slug = slugOf(item, photos)
    let mid = `${base}/manifests/${slug}.json`
    let comments = []

    let canvases = photos.map((photo, i) => {
      let cid = `${base}/canvas/${slug}/${i + 1}`
      let ext = extension(photo)
      let image = `${base}/images/${photo.checksum}${ext}`
      if (photo.path) images.set(photo.checksum, { source: value(photo.path), file: `images/${photo.checksum}${ext}` })

      for (let note of list(photo.note)) comments.push(noteAnnotation(note, cid, `${cid}/note/${comments.length + 1}`))
      for (let tr of list(photo.transcription)) comments.push(transcription(tr, cid, `${cid}/tr/${comments.length + 1}`))
      for (let sel of list(photo.selection)) {
        let target = `${cid}#xywh=${[sel.x, sel.y, sel.width, sel.height].map(n => Math.round(Number(value(n)))).join(',')}`
        for (let note of list(sel.note)) comments.push(noteAnnotation(note, target, `${cid}/note/${comments.length + 1}`))
        for (let tr of list(sel.transcription)) comments.push(transcription(tr, target, `${cid}/tr/${comments.length + 1}`))
      }

      let width = Number(value(photo.width)) || undefined
      let height = Number(value(photo.height)) || undefined
      return {
        id: cid,
        type: 'Canvas',
        label: { none: [String(value(photo.title) || value(photo.filename) || `Photo ${i + 1}`)] },
        ...(width && height ? { width, height } : {}),
        items: [{
          id: `${cid}/page`,
          type: 'AnnotationPage',
          items: [{
            id: `${cid}/page/image`,
            type: 'Annotation',
            motivation: 'painting',
            body: { id: image, type: 'Image', format: value(photo.mimetype) || undefined, width, height },
            target: cid
          }]
        }]
      }
    })

    let manifest = {
      '@context': PRESENTATION,
      id: mid,
      type: 'Manifest',
      label: { none: [String(value(item.title) || `Item ${manifests.length + 1}`)] },
      metadata: metadataOf(item),
      items: canvases
    }
    if (comments.length > 0) {
      manifest.annotations = [{ id: `${mid}#annotations`, type: 'AnnotationPage', items: comments }]
    }
    manifests.push({ file: `manifests/${slug}.json`, json: manifest })
  }

  let collection = {
    '@context': PRESENTATION,
    id: `${base}/collection.json`,
    type: 'Collection',
    label: { none: ['Tropy export'] },
    items: manifests.map(m => ({ id: m.json.id, type: 'Manifest', label: m.json.label }))
  }
  return { collection, manifests, images: [...images.values()] }
}

/** Write the collection, the manifests and copies of the images under `dir`. */
async function writeIIIF(doc, dir, opts) {
  let out = toIIIF(doc, opts)
  await fs.promises.mkdir(path.join(dir, 'manifests'), { recursive: true })
  await fs.promises.mkdir(path.join(dir, 'images'), { recursive: true })
  for (let { source, file } of out.images) {
    let dest = path.join(dir, file)
    if (!fs.existsSync(dest)) await fs.promises.copyFile(source, dest)
  }
  for (let { file, json } of out.manifests) {
    await fs.promises.writeFile(path.join(dir, file), JSON.stringify(json, null, 2))
  }
  await fs.promises.writeFile(path.join(dir, 'collection.json'), JSON.stringify(out.collection, null, 2))
  return out
}

function noteAnnotation(note, target, id) {
  let html = String(value(note.html) || '')
  let creator = null
  let m = FOOTERS.map(f => html.match(f)).find(Boolean)
  if (m) {
    creator = m[1].trim()
    html = html.slice(0, m.index)
  }
  if (!html) html = escapeHtml(String(value(note.text) || ''))
  let anno = {
    id,
    type: 'Annotation',
    motivation: 'commenting',
    body: { type: 'TextualBody', value: html, format: 'text/html' },
    target
  }
  let lang = note.html && note.html['@language']
  if (lang) anno.body.language = lang
  if (creator) anno.creator = { type: 'Person', name: creator }
  return anno
}

function transcription(tr, target, id) {
  return {
    id,
    type: 'Annotation',
    motivation: 'supplementing',
    body: { type: 'TextualBody', value: String(value(tr.text) || ''), format: 'text/plain' },
    target
  }
}

const SKIP = new Set(['@type', '@id', 'template', 'photo', 'tag', 'list'])

function metadataOf(item) {
  let out = []
  for (let [key, v] of Object.entries(item)) {
    if (SKIP.has(key)) continue
    let text = value(v)
    if (text == null || text === '') continue
    out.push({ label: { none: [labelOf(key)] }, value: { none: [String(text)] } })
  }
  let tags = list(item.tag).map(value).filter(Boolean)
  if (tags.length) out.push({ label: { none: ['Tags'] }, value: { none: [tags.join(', ')] } })
  return out
}

function labelOf(key) {
  let name = String(key).split(/[#/:]/).pop()
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** A literal's value: a plain value, `{ @value }`, or `{ @id }`. */
function value(v) {
  if (Array.isArray(v)) return value(v[0])
  if (v && typeof v === 'object') return v['@value'] ?? v['@id'] ?? null
  return v
}

function list(v) {
  if (v == null) return []
  if (Array.isArray(v)) return v
  if (v['@list']) return v['@list']
  return [v]
}

/** A stable file name: the item's photos' checksums, hashed. */
function slugOf(item, photos) {
  return crypto.createHash('sha256').update(photos.map(p => value(p.checksum)).sort().join(':')).digest('hex').slice(0, 16)
}

function extension(photo) {
  let ext = path.extname(String(value(photo.filename) || value(photo.path) || ''))
  if (ext) return ext.toLowerCase()
  let sub = String(value(photo.mimetype) || '').split('/')[1] || 'bin'
  return '.' + sub.replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')
}

function escapeHtml(s) {
  return `<p>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
}

module.exports = { toIIIF, writeIIIF }
