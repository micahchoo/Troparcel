'use strict'

// Writes a small, valid RGB PNG whose pixels depend on `seed`, so every seed
// gives a different file and therefore a different Tropy checksum.

const fs = require('node:fs')
const zlib = require('node:zlib')

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (let b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  let len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  let body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(seed, width = 64, height = 48) {
  let ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  let rows = []
  for (let y = 0; y < height; y++) {
    let row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = (x * 4 + seed * 37) & 0xff
      row[2 + x * 3] = (y * 5 + seed * 91) & 0xff
      row[3 + x * 3] = ((x ^ y) + seed * 13) & 0xff
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function writePng(path, seed) {
  fs.writeFileSync(path, png(seed))
  return path
}

module.exports = { png, writePng }
