'use strict'

const http = require('http')
const crypto = require('crypto')
const { page } = require('./dashboard-page')

/**
 * Troparcel's dashboard: a page in the browser, served by the plugin, that
 * shows what Tropy has no place for: whether sync works, who is online,
 * what arrived, what needs a decision, and how to invite someone.
 *
 *   let dash = new Dashboard({ status, act, logger })
 *   let url = await dash.start()   // http://127.0.0.1:<port>/<secret>/
 *   dash.open()                    // in the default browser
 *
 * `status()` returns what the page shows; `act(name, input)` performs a
 * button (setup, sync now, resolve a conflict…) and returns a message.
 *
 * Only this computer can reach it, and only with the secret in the address:
 * the server listens on 127.0.0.1 alone, refuses any other Host (so a web
 * page cannot reach it through DNS rebinding), and takes actions only as
 * POSTs of JSON, which a cross-site form cannot send.
 */
class Dashboard {
  constructor({ status, act, logger, secret, port, onStart }) {
    this.status = status
    this.act = act
    this.logger = logger
    this.secret = secret || crypto.randomBytes(18).toString('base64url')
    this.preferredPort = port || 0
    this.onStart = onStart
    this.server = null
    this.url = null
  }

  /** Listen, on the port used last time if it is free (an open page keeps working). */
  async start() {
    if (this.url) return this.url
    try {
      await this._listen(this.preferredPort)
    } catch {
      await this._listen(0)
    }
    this.url = `http://127.0.0.1:${this.port}/${this.secret}/`
    if (this.onStart) this.onStart({ port: this.port, secret: this.secret })
    return this.url
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      let server = http.createServer((req, res) => this._handle(req, res).catch(err => {
        this._json(res, 500, { error: err.message })
      }))
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        this.port = server.address().port
        resolve()
      })
    })
  }

  async _handle(req, res) {
    if (req.headers.host !== `127.0.0.1:${this.port}`) return this._json(res, 403, { error: 'wrong host' })
    let url = new URL(req.url, `http://127.0.0.1:${this.port}`)
    let prefix = `/${this.secret}/`
    if (!url.pathname.startsWith(prefix)) return this._json(res, 404, { error: 'not found' })
    let route = url.pathname.slice(prefix.length)

    if (req.method === 'GET' && route === '') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:"
      })
      return res.end(page())
    }
    if (req.method === 'GET' && route === 'api/status') {
      return this._json(res, 200, await this.status())
    }
    if (req.method === 'POST' && route.startsWith('api/')) {
      if (!String(req.headers['content-type']).startsWith('application/json')) {
        return this._json(res, 415, { error: 'send JSON' })
      }
      let body = ''
      for await (let chunk of req) {
        body += chunk
        if (body.length > 65536) return this._json(res, 413, { error: 'too large' })
      }
      let input = body ? JSON.parse(body) : {}
      try {
        let message = await this.act(route.slice(4), input)
        return this._json(res, 200, { ok: true, message })
      } catch (err) {
        return this._json(res, 400, { ok: false, error: err.message })
      }
    }
    this._json(res, 404, { error: 'not found' })
  }

  _json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  /** Open the dashboard in the default browser (not under test: TROPARCEL_NO_BROWSER). */
  async open() {
    let url = await this.start()
    if (process.env.TROPARCEL_NO_BROWSER) return url
    try {
      let { shell } = require('electron')
      if (shell && shell.openExternal) {
        await shell.openExternal(url)
        return url
      }
    } catch { /* not in Electron, or no shell here */ }
    let { spawn } = require('child_process')
    let [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
    try {
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
    } catch (err) {
      this.logger.warn(`Troparcel: could not open the browser (${err.message}); open ${url}`)
    }
    return url
  }

  stop() {
    if (this.server) this.server.close()
    this.server = null
    this.url = null
  }
}

module.exports = { Dashboard }
