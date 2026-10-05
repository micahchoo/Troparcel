'use strict'

// Loaded before every test file (`node --import`). A test must never write
// to the owner's home folder: vaults, backups, keys and downloaded photos
// default to ~/.troparcel, so HOME points at a temp folder for the run.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'troparcel-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }))
