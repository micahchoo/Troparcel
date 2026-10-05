#!/usr/bin/env node
'use strict'

/**
 * Install Troparcel into every Tropy on this computer.
 *
 *   npx github:micahchoo/Troparcel install
 *   npx github:micahchoo/Troparcel install --connection troparcel://folder/tropy-letters --name "Ada L."
 *
 * For each Tropy found (Linux, Flatpak, macOS, Windows), it backs up any
 * Troparcel already there, copies the plugin in, and adds a "Troparcel"
 * entry to Tropy's plugin settings if there is none. With no connection
 * given, Troparcel opens its setup page in the browser when Tropy starts.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const FILES = ['index.js', 'package.json', 'icon.svg']

/** [label, plugins folder] for each Tropy that has been run on this computer. */
function tropys(home = os.homedir(), env = process.env) {
  let candidates = [
    ['Tropy (Flatpak)', path.join(home, '.var', 'app', 'org.tropy.Tropy', 'config', 'tropy')],
    ['Tropy', path.join(home, '.config', 'tropy')],
    ['Tropy', path.join(home, 'Library', 'Application Support', 'Tropy')],
    ['Tropy', path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Tropy')]
  ]
  return candidates
    .filter(([, dir]) => fs.existsSync(dir))
    .map(([label, dir]) => [label, path.join(dir, 'plugins')])
}

function install({ home = os.homedir(), env = process.env, connection, name } = {}) {
  let missing = FILES.filter(f => !fs.existsSync(path.join(ROOT, f)))
  if (missing.length) throw new Error(`the plugin is not built (${missing.join(', ')} missing): run npm run build`)
  let version = require(path.join(ROOT, 'package.json')).version
  let found = tropys(home, env)
  if (found.length === 0) {
    throw new Error('found no Tropy on this computer. Install Tropy from https://tropy.org and open it once, then run this again.')
  }
  let done = []
  for (let [label, plugins] of found) {
    let dest = path.join(plugins, 'troparcel')
    if (fs.existsSync(path.join(dest, 'package.json'))) {
      let old = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version || 'old'
      let backup = path.join(home, '.troparcel', 'plugin-backups', `troparcel-${old}-${Date.now()}`)
      fs.mkdirSync(backup, { recursive: true })
      for (let f of fs.readdirSync(dest)) fs.copyFileSync(path.join(dest, f), path.join(backup, f))
    }
    fs.mkdirSync(dest, { recursive: true })
    for (let f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dest, f))

    let configFile = path.join(plugins, 'config.json')
    let config = []
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch { /* none yet */ }
    if (!Array.isArray(config)) config = []
    let entry = config.find(e => e.plugin === 'troparcel' && !(e.options || {}).iiifFolder)
    if (!entry) {
      entry = { plugin: 'troparcel', name: 'Troparcel', options: {} }
      config.push(entry)
    }
    if (connection) entry.options = { ...entry.options, connection }
    if (name) entry.options = { ...entry.options, userId: name }
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
    done.push({ label, dest, entry: entry.name || 'troparcel' })
  }
  return { version, done }
}

function main(argv) {
  let [command, ...rest] = argv
  let opt = k => { let i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined }
  if (command !== 'install') {
    console.log('Usage: npx github:micahchoo/Troparcel install [--connection <invite>] [--name <your name>]')
    return command ? 1 : 0
  }
  try {
    let { version, done } = install({ connection: opt('--connection'), name: opt('--name') })
    for (let d of done) console.log(`Installed Troparcel ${version} for ${d.label}: ${d.dest}`)
    let configured = opt('--connection') && opt('--name')
    console.log(configured
      ? '\nRestart Tropy. Troparcel connects to your group when a project opens.'
      : '\nRestart Tropy. A setup page opens in your browser: choose your name, then join your group or start a room.')
    console.log(`Later, File › Export › ${done[0].entry} opens that page again.`)
    return 0
  } catch (err) {
    console.error(`Could not install Troparcel: ${err.message}`)
    return 1
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { install, tropys }
