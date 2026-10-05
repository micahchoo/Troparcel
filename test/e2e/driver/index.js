'use strict'

/**
 * Test only. Installed by test/e2e/harness.js into a test Tropy's own data
 * folder, never shipped. It lets a test do what a person does in the
 * window, and see what they see, where Tropy's HTTP API cannot:
 *
 *   GET  /state?path=nav.mode     any part of the project window's state
 *   POST /dispatch  { action }    any Tropy action, as a menu would send it
 *   POST /export    { items, plugin }   File > Export with plugin entry #plugin
 *
 * Commands resolve when Tropy has finished them (their activity is gone).
 */

const http = require('http')

class TestDriver {
  constructor(options, context) {
    this.context = context
    let logger = context.logger || {}
    let prefs = typeof logger.chindings === 'string' && logger.chindings.includes('"name":"prefs"')
    if (prefs || !options.port) return
    this.server = http.createServer((req, res) => this.handle(req, res).catch(err => {
      res.writeHead(500)
      res.end(String(err && err.stack || err))
    }))
    this.server.listen(Number(options.port), '127.0.0.1')
  }

  get store() {
    return this.context.window && this.context.window.store
  }

  async handle(req, res) {
    let url = new URL(req.url, 'http://driver')
    let store = this.store
    if (!store) {
      res.writeHead(503)
      return res.end('no project window yet')
    }
    let reply = (value) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(value === undefined ? null : value))
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      let value = store.getState()
      for (let k of (url.searchParams.get('path') || '').split('.').filter(Boolean)) value = value == null ? value : value[k]
      return reply(value)
    }

    let body = ''
    for await (let chunk of req) body += chunk
    let input = body ? JSON.parse(body) : {}

    if (req.method === 'POST' && url.pathname === '/dispatch') {
      return reply(await this.run(input.action))
    }
    if (req.method === 'POST' && url.pathname === '/export') {
      return reply(await this.run({
        type: 'item.export',
        payload: input.items,
        meta: { cmd: 'project', plugin: String(input.plugin) }
      }))
    }
    res.writeHead(404)
    res.end()
  }

  /** Dispatch; for a command, wait until Tropy has finished it. */
  run(action) {
    let store = this.store
    let sent = store.dispatch(action)
    let seq = sent && sent.meta && sent.meta.seq
    if (!action.meta || !action.meta.cmd || !seq) return Promise.resolve({ seq })
    return new Promise((resolve, reject) => {
      let seen = false
      let timer = setTimeout(() => { unsub(); reject(new Error(`${action.type} did not finish`)) }, 60000)
      let check = () => {
        let running = !!(store.getState().activities || {})[seq]
        if (running) seen = true
        else if (seen) { clearTimeout(timer); unsub(); resolve({ seq }) }
      }
      let unsub = store.subscribe(check)
      check()
    })
  }

  unload() {
    if (this.server) this.server.close()
  }
}

module.exports = TestDriver
