'use strict'

/**
 * Cut the explainer film from the footage test/e2e/film.js recorded.
 *
 *   node test/e2e/edit.js <footage dir> <out.mp4>
 *
 * The two windows sit side by side on a 2560×1440 canvas; a camera (zooms
 * and pans, eased) moves over it, as the table SHOTS says, and the result
 * is 1920×1080 with captions, a title card, an end card and crossfades.
 * Times in SHOTS are seconds from the scene's start in scenes.json.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const SRC = path.resolve(process.argv[2])
const OUT = path.resolve(process.argv[3] || path.join(SRC, 'troparcel.mp4'))
const WORK = path.join(SRC, 'edit')
const FONT = '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf'
const BOLD = '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'
const SERIF = '/usr/share/fonts/truetype/noto/NotoSerif-Regular.ttf'
const FPS = 24
const BG = '0x17181a'
const FADE = 0.45

// Canvas: windows at y 320..1120; alice x 0..1280, bob (or carol) x 1280..2560.
const Y = 320
const L = (x, y) => [x, Y + y]         // a point in the left window
const R = (x, y) => [1280 + x, Y + y]  // a point in the right window
const WIDE = { z: 1, at: [1280, 720] }

// Camera keyframes per scene: { t, z, at: [cx, cy] }. Moves ease between them.
const SHOTS = {
  'same-photos': [{ t: 0, ...WIDE }, { t: 6.5, ...WIDE }],
  title: [
    { t: 0, ...WIDE }, { t: 0.9, z: 2.3, at: L(260, 160) },
    { t: 3.0, z: 2.3, at: L(260, 160) }, { t: 3.9, z: 2.3, at: R(260, 160) },
    { t: 5.1, z: 2.3, at: R(260, 160) }, { t: 6.0, ...WIDE }
  ],
  note: [
    { t: 0, ...WIDE }, { t: 0.9, z: 1.9, at: L(720, 520) },
    { t: 3.6, z: 1.9, at: L(720, 520) }, { t: 4.6, z: 1.9, at: R(640, 560) },
    { t: 7.8, z: 1.9, at: R(640, 560) }, { t: 8.6, ...WIDE }
  ],
  tags: [
    { t: 0, ...WIDE }, { t: 0.9, z: 2.3, at: L(200, 200) },
    { t: 3.2, z: 2.3, at: L(200, 200) }, { t: 4.1, z: 2.3, at: R(200, 200) },
    { t: 7.4, z: 2.3, at: R(200, 200) }, { t: 8.4, z: 2.3, at: R(220, 200) },
    { t: 11.0, z: 2.3, at: R(220, 200) }, { t: 11.8, ...WIDE }
  ],
  reply: [
    { t: 0, ...WIDE }, { t: 1.5, z: 1.9, at: R(640, 520) },
    { t: 4.6, z: 1.9, at: R(640, 520) }, { t: 5.6, z: 2.1, at: L(220, 700) },
    { t: 8.6, z: 2.1, at: L(220, 700) }, { t: 9.4, ...WIDE }
  ],
  newcomer: [
    { t: 0, ...WIDE }, { t: 9, ...WIDE }, { t: 10.2, z: 1.8, at: R(640, 400) },
    { t: 18.2, z: 1.8, at: R(640, 400) }
  ]
}

const run = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/,/g, '\\,').replace(/%/g, '\\%')

/** An ffmpeg expression of `it` (input time) that eases through the keyframes. */
function curve(keys, pick) {
  let v = keys.map(pick)
  let expr = String(v[v.length - 1])
  for (let i = keys.length - 2; i >= 0; i--) {
    let a = keys[i].t, b = keys[i + 1].t
    let p = `clip((it-${a})/${Math.max(b - a, 0.001)},0,1)`
    let seg = `${v[i]}+(${v[i + 1] - v[i]})*(${p})*(${p})*(3-2*(${p}))`
    expr = `if(lt(it,${b}),${seg},${expr})`
  }
  return expr
}

/** zoompan for a 2× canvas (5120×2880): top-left from centre and zoom, kept inside. */
function camera(keys) {
  let z = curve(keys, k => k.z)
  let cx = curve(keys, k => k.at[0] * 2)
  let cy = curve(keys, k => k.at[1] * 2)
  return `zoompan=z='${z}':x='clip(${cx}-iw/zoom/2,0,iw-iw/zoom)':y='clip(${cy}-ih/zoom/2,0,ih-ih/zoom)':d=1:s=1920x1080:fps=${FPS}`
}

function caption(text) {
  if (!text) return 'null'
  return `drawbox=x=0:y=ih-150:w=iw:h=150:color=black@0.55:t=fill,` +
    `drawtext=fontfile=${BOLD}:text='${esc(text)}':fontsize=40:fontcolor=white:x=(w-text_w)/2:y=h-98`
}

/** Two recordings side by side on the canvas, with name labels. */
function canvas(left, right, names, out, { rightDelay = 0, waiting = '' } = {}) {
  let r = rightDelay
    ? `[1:v]tpad=start_duration=${rightDelay}:color=${BG}[r];`
    : '[1:v]null[r];'
  let label = (name, x) => `drawtext=fontfile=${FONT}:text='${esc(name)}':fontsize=44:fontcolor=0xd8d8d8:x=${x}-text_w/2:y=230`
  let wait = waiting ? `,drawtext=fontfile=${FONT}:text='${esc(waiting)}':fontsize=40:fontcolor=0xbbbbbb:x=1920-text_w/2:y=700:enable='lt(t,${rightDelay})'` : ''
  run(['-i', left, '-i', right, '-filter_complex',
    `${r}[0:v][r]hstack=inputs=2,pad=2560:1440:0:${Y}:color=${BG},` +
    `${label(names[0], 640)},${label(names[1], 1920)},drawbox=x=1279:y=${Y}:w=2:h=800:color=0x000000:t=fill${wait}[v]`,
    '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p', out])
}

function scene(src, start, length, keys, text, out) {
  run(['-ss', String(start), '-t', String(length), '-i', src, '-filter_complex',
    `[0:v]scale=5120:2880:flags=lanczos,${camera(keys)},${caption(text)},format=yuv420p[v]`,
    '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', out])
}

function card(lines, length, out) {
  let draw = lines.map(([text, font, size, y, color]) =>
    `drawtext=fontfile=${font}:text='${esc(text)}':fontsize=${size}:fontcolor=${color || 'white'}:x=(w-text_w)/2:y=${y}`).join(',')
  run(['-f', 'lavfi', '-i', `color=c=${BG}:s=1920x1080:r=${FPS}:d=${length}`, '-vf', `${draw},format=yuv420p`,
    '-c:v', 'libx264', '-crf', '16', out])
}

function join(parts, out) {
  let inputs = parts.flatMap(p => ['-i', p])
  let len = parts.map(p => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString()))
  let chain = ''
  let prev = '[0:v]'
  let offset = 0
  for (let i = 1; i < parts.length; i++) {
    offset += len[i - 1] - FADE
    let label = i === parts.length - 1 ? '[v]' : `[x${i}]`
    chain += `${prev}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}${label};`
    prev = label
    offset = offset // running total of the joined stream's length minus fades
  }
  run([...inputs, '-filter_complex', chain.replace(/;$/, ''), '-map', '[v]', '-r', String(FPS),
    '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out])
}

function main() {
  fs.mkdirSync(WORK, { recursive: true })
  let scenes = JSON.parse(fs.readFileSync(path.join(SRC, 'scenes.json'), 'utf8'))
  let scenes6 = JSON.parse(fs.readFileSync(path.join(SRC, 'scenes6.json'), 'utf8'))
  let dur = f => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())
  // film.js starts recording, waits 1 s, then marks scene 0, and waits 1 s after
  // the last mark: the recording's lead-in is its length minus the marked span.
  let lead = dur(path.join(SRC, 'alice.mp4')) - (scenes[scenes.length - 1].at + 1)

  let main = path.join(WORK, 'canvas.mp4')
  canvas(path.join(SRC, 'alice.mp4'), path.join(SRC, 'bob.mp4'), ["alice\u2019s Tropy", "bob\u2019s Tropy"], main)
  let six = path.join(WORK, 'canvas6.mp4')
  let carolAt = scenes6.find(s => s.name === 'carol-recording').at
  canvas(path.join(SRC, 'alice6.mp4'), path.join(SRC, 'carol.mp4'), ["alice\u2019s Tropy", "carol\u2019s Tropy (new, empty)"], six,
    { rightDelay: carolAt, waiting: 'carol starts Tropy with an empty project\u2026' })

  let parts = []
  let title = path.join(WORK, '00-title.mp4')
  card([
    ['Troparcel', SERIF, 120, 380],
    ['Annotate the same photos together, each in your own Tropy project', FONT, 42, 560, '0xcfcfcf'],
    ['Real, unedited Tropy windows. The camera moves; the software does not.', FONT, 30, 660, '0x8a8a8a']
  ], 4.5, title)
  parts.push(title)

  scenes.slice(0, -1).forEach((s, i) => {
    let next = scenes[i + 1]
    let out = path.join(WORK, `${String(i + 1).padStart(2, '0')}-${s.name}.mp4`)
    scene(main, lead + s.at, next.at - s.at, SHOTS[s.name], s.caption, out)
    parts.push(out)
  })
  let out6 = path.join(WORK, '06-newcomer.mp4')
  let end6 = scenes6.find(s => s.name === 'end').at
  scene(six, 0, Math.min(end6, dur(six)), SHOTS.newcomer, scenes6[0].caption, out6)
  parts.push(out6)

  let end = path.join(WORK, '99-end.mp4')
  card([
    ['Troparcel', SERIF, 96, 330],
    ['github.com/micahchoo/Troparcel', FONT, 44, 480, '0xcfcfcf'],
    ['A plugin for Tropy (tropy.org). AGPL-3.0.', FONT, 30, 570, '0x9a9a9a'],
    ['Letter to Lord Castlereagh, discussing Indian debt, trade, etc.: public domain,', FONT, 26, 760, '0x8a8a8a'],
    ['Digital Public Library of America via Wikimedia Commons.', FONT, 26, 800, '0x8a8a8a']
  ], 5, end)
  parts.push(end)

  join(parts, OUT)
  console.log(`[edit] ${OUT}: ${dur(OUT).toFixed(1)} s`)
}

main()
