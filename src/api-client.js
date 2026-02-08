'use strict'

const http = require('http')

/**
 * API Client — talks to Tropy's localhost HTTP API.
 *
 * Tropy exposes a REST API on localhost (default port 2019 for latest,
 * 2029 for stable).  This client provides methods to read items,
 * metadata, tags, notes, and to write annotations back.
 */
class ApiClient {
  constructor(port = 2019, logger = null) {
    this.port = port
    this.host = '127.0.0.1'
    this.logger = logger
  }

  /**
   * Check if the Tropy API is reachable.
   */
  async ping() {
    try {
      let res = await this.get('/')
      return res && res.status === 'ok'
    } catch {
      return false
    }
  }

  /**
   * Get all items in the project.
   * Returns an array of item summaries (id, template, etc.)
   */
  async getItems(query = {}) {
    let params = new URLSearchParams()
    if (query.q) params.set('q', query.q)
    if (query.tag) params.set('tag', query.tag)
    if (query.sort) params.set('sort', query.sort)
    let qs = params.toString()
    return this.get(`/project/items${qs ? '?' + qs : ''}`)
  }

  /**
   * Get a single item by ID (JSON-LD).
   */
  async getItem(id) {
    return this.get(`/project/items/${id}`)
  }

  /**
   * Get photos for an item.
   */
  async getPhotos(itemId) {
    return this.get(`/project/items/${itemId}/photos`)
  }

  /**
   * Get tags for an item.
   */
  async getItemTags(itemId) {
    return this.get(`/project/items/${itemId}/tags`)
  }

  /**
   * Get metadata for a subject (item, photo, or selection).
   */
  async getMetadata(subjectId) {
    return this.get(`/project/data/${subjectId}`)
  }

  /**
   * Save metadata for a subject.
   * @param {number} subjectId
   * @param {Object} data - metadata object { [propertyUri]: { text, type } }
   */
  async saveMetadata(subjectId, data) {
    return this.postJson(`/project/data/${subjectId}`, data)
  }

  /**
   * Get all tags in the project.
   */
  async getTags() {
    return this.get('/project/tags')
  }

  /**
   * Create a new tag.
   */
  async createTag(name, color = null, items = null) {
    return this.post('/project/tags', { name, color, item: items })
  }

  /**
   * Add tags to an item.
   * @param {number} itemId
   * @param {number[]} tagIds
   */
  async addTagsToItem(itemId, tagIds) {
    return this.post(`/project/items/${itemId}/tags`, { tag: tagIds })
  }

  /**
   * Get a note by ID.
   * @param {number} noteId
   * @param {string} format - 'json', 'html', 'plain', 'md'
   */
  async getNote(noteId, format = 'html') {
    return this.get(`/project/notes/${noteId}?format=${format}`)
  }

  /**
   * Create a new note.
   * @param {Object} params - { html, language, photo, selection }
   */
  async createNote(params) {
    return this.postJson('/project/notes', params)
  }

  /**
   * Delete a note.
   */
  async deleteNote(noteId) {
    return this.request('DELETE', `/project/notes/${noteId}`)
  }

  /**
   * Get a photo by ID.
   */
  async getPhoto(photoId) {
    return this.get(`/project/photos/${photoId}`)
  }

  /**
   * Get a selection by ID.
   */
  async getSelection(selectionId) {
    return this.get(`/project/selections/${selectionId}`)
  }

  /**
   * Get transcriptions for an item.
   */
  async getTranscriptions(itemId) {
    return this.get(`/project/items/${itemId}/transcriptions`)
  }

  /**
   * Get lists.
   */
  async getLists(id = null) {
    return this.get(`/project/lists${id != null ? '/' + id : ''}`)
  }

  /**
   * Import items into Tropy.
   * Only accepts JSON-LD data — file paths are intentionally not supported
   * to prevent path traversal from remote sources (#10 in audit).
   * @param {Object} params - { data: JSON-LD items, list: list id }
   */
  async importItems(params) {
    let body = new URLSearchParams()
    if (params.data) body.set('data', JSON.stringify(params.data))
    if (params.list) body.set('list', params.list)
    // Note: params.file deliberately omitted — accepting file paths from
    // CRDT data would allow a malicious collaborator to trigger arbitrary
    // local file reads via Tropy's import mechanism.

    return this.request('POST', '/project/import', body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded'
    })
  }

  /**
   * Get project version info.
   */
  async getVersion() {
    return this.get('/version')
  }

  // --- HTTP primitives ---

  async get(path) {
    return this.request('GET', path)
  }

  async post(path, data) {
    let body = new URLSearchParams()
    for (let [key, value] of Object.entries(data)) {
      if (value != null) {
        if (Array.isArray(value)) {
          for (let v of value) body.append(key, v)
        } else {
          body.set(key, value)
        }
      }
    }
    return this.request('POST', path, body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded'
    })
  }

  async postJson(path, data) {
    return this.request('POST', path, JSON.stringify(data), {
      'Content-Type': 'application/json'
    })
  }

  request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      let options = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'Accept': 'application/json',
          ...headers
        }
      }

      if (body) {
        options.headers['Content-Length'] = Buffer.byteLength(body)
      }

      let req = http.request(options, (res) => {
        let chunks = []

        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          let raw = Buffer.concat(chunks).toString()

          if (res.statusCode >= 400) {
            let err = new Error(`API ${method} ${path}: ${res.statusCode}`)
            err.status = res.statusCode
            err.body = raw
            reject(err)
            return
          }

          if (!raw || raw.length === 0) {
            resolve(null)
            return
          }

          try {
            resolve(JSON.parse(raw))
          } catch {
            resolve(raw)
          }
        })
      })

      req.on('error', (err) => {
        if (this.logger) {
          this.logger.debug(`API request failed: ${method} ${path}`, {
            error: err.message
          })
        }
        reject(err)
      })

      req.setTimeout(10000, () => {
        req.destroy(new Error(`API timeout: ${method} ${path}`))
      })

      if (body) req.write(body)
      req.end()
    })
  }
}

module.exports = { ApiClient }
