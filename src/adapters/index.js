'use strict'

const { WebSocketAdapter } = require('./websocket')
const { FileAdapter } = require('./file')

/**
 * The transport for resolved options: `transport` is 'websocket' (a
 * Troparcel server) or 'file' (a shared folder). See connection-string.js.
 * A function is called as the factory instead (tests, embedders).
 */
function createTransport(doc, options, logger) {
  if (typeof options.transport === 'function') return options.transport(doc, options, logger)
  switch (options.transport || 'websocket') {
    case 'websocket': return new WebSocketAdapter(doc, options, logger)
    case 'file': return new FileAdapter(doc, options, logger)
    default: throw new Error(`unknown transport "${options.transport}"`)
  }
}

module.exports = { createTransport }
