'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { install, tropys } = require('../bin/troparcel')

function home() {
  let h = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'))
  fs.mkdirSync(path.join(h, '.var', 'app', 'org.tropy.Tropy', 'config', 'tropy'), { recursive: true })
  return h
}

test('installs into the Flatpak Tropy and adds a Troparcel entry', () => {
  let h = home()
  assert.deepEqual(tropys(h, {}).map(t => t[0]), ['Tropy (Flatpak)'])
  let { done } = install({ home: h, env: {} })
  let plugins = path.join(h, '.var', 'app', 'org.tropy.Tropy', 'config', 'tropy', 'plugins')
  for (let f of ['index.js', 'package.json', 'icon.svg']) assert.ok(fs.existsSync(path.join(plugins, 'troparcel', f)), f)
  let config = JSON.parse(fs.readFileSync(path.join(plugins, 'config.json'), 'utf8'))
  assert.deepEqual(config, [{ plugin: 'troparcel', name: 'Troparcel', options: {} }])
  assert.equal(done.length, 1)
})

test('keeps an existing entry and its name, backs up the old plugin, fills in what was given', () => {
  let h = home()
  let plugins = path.join(h, '.var', 'app', 'org.tropy.Tropy', 'config', 'tropy', 'plugins')
  fs.mkdirSync(path.join(plugins, 'troparcel'), { recursive: true })
  fs.writeFileSync(path.join(plugins, 'troparcel', 'package.json'), JSON.stringify({ version: '5.0.0' }))
  fs.writeFileSync(path.join(plugins, 'config.json'), JSON.stringify([{ plugin: 'troparcel', name: 'B', options: { debug: true } }]))
  install({ home: h, env: {}, connection: 'troparcel://folder/tropy-letters', name: 'Ada L.' })
  let config = JSON.parse(fs.readFileSync(path.join(plugins, 'config.json'), 'utf8'))
  assert.equal(config.length, 1)
  assert.equal(config[0].name, 'B')
  assert.deepEqual(config[0].options, { debug: true, connection: 'troparcel://folder/tropy-letters', userId: 'Ada L.' })
  let backups = fs.readdirSync(path.join(h, '.troparcel', 'plugin-backups'))
  assert.match(backups[0], /^troparcel-5\.0\.0-/)
})

test('says what to do when Tropy is not installed', () => {
  let h = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'))
  assert.throws(() => install({ home: h, env: {} }), /found no Tropy on this computer/)
})
