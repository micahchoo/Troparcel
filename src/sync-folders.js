'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * Folders that a sync client (Nextcloud, Dropbox, …) keeps in step across
 * computers. A folder-first room is a folder inside one of them, named the
 * same for every member: `troparcel://folder/tropy-letters` finds
 * …/Nextcloud/tropy-letters on one computer and …/Dropbox/tropy-letters
 * on another, so one invite works for the whole group.
 */

const HOME = () => os.homedir()

/** [label, path] for each sync root that exists on this computer. */
function syncRoots(home = HOME()) {
  let candidates = [
    ['Nextcloud', 'Nextcloud'], ['ownCloud', 'ownCloud'], ['Dropbox', 'Dropbox'],
    ['Google Drive', 'Google Drive'], ['Google Drive', 'GoogleDrive'], ['Google Drive', 'My Drive'],
    ['OneDrive', 'OneDrive'], ['Syncthing', 'Sync'], ['Syncthing', 'Syncthing'],
    ['pCloud', 'pCloudDrive'], ['Seafile', 'Seafile'], ['Box', 'Box'], ['iCloud Drive', 'iCloudDrive']
  ].map(([label, rel]) => [label, path.join(home, rel)])
  // macOS keeps most clients under ~/Library/CloudStorage/<Provider-account>
  let cloud = path.join(home, 'Library', 'CloudStorage')
  try {
    for (let name of fs.readdirSync(cloud)) {
      candidates.push([name.split('-')[0].replace(/([a-z])([A-Z])/g, '$1 $2'), path.join(cloud, name)])
    }
  } catch { /* not macOS */ }
  let seen = new Set()
  return candidates.filter(([, p]) => {
    if (seen.has(p)) return false
    seen.add(p)
    try { return fs.statSync(p).isDirectory() } catch { return false }
  })
}

/** The folder `name` in a sync root (or one level down), or null. */
function findRoomFolder(name, roots = syncRoots()) {
  let clean = String(name).trim()
  for (let [, root] of roots) {
    let direct = path.join(root, clean)
    if (isDir(direct)) return direct
  }
  for (let [, root] of roots) {
    let children = []
    try { children = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()) } catch { continue }
    for (let child of children) {
      let nested = path.join(root, child.name, clean)
      if (isDir(nested)) return nested
    }
  }
  return null
}

/** Make the room folder `name` in `root`; returns its path. */
function createRoomFolder(root, name) {
  let dir = path.join(root, String(name).trim())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

module.exports = { syncRoots, findRoomFolder, createRoomFolder }
