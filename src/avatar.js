// A Bot's Matrix avatar. DS Bot keeps a Bot's look as an uploaded image (a data URL in
// avatar.image) or as one of its own inks (avatar.shape / color, drawn by the web client).
// Matrix needs a real file, so a Bot with an image gets that image and a Bot with only an
// ink gets a flat square in exactly that ink: in Element, where avatars are round, a Bot
// still looks like itself.
//
// The PNG is written here rather than pulled from an image library: one solid colour,
// 128×128, RGBA, deflated. That keeps the bridge dependency-free.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

// The inks DS Bot ships (client.js INKS), first value = the colour shown by default.
const INKS = {
  deepseek: '#4D6BFE',
  charcoal: '#141416',
  graphite: '#2D2D2D',
  rose: '#EC2F6B',
  sky: '#0AA8D6',
  tangerine: '#FF6900',
  cobalt: '#082DFF',
  black: '#000000',
  brown: '#A27952',
  red: '#FF3E51',
  orange: '#FF781C',
  yellow: '#FFAF38',
  green: '#00C972',
  cyan: '#1CC3B0',
  blue: '#2A92FE',
  violet: '#A97EFE',
  magenta: '#FF5EB1',
  gray: '#959595',
  aurora: '#00B8D4',
}
// Renamed inks in older teams.
const LEGACY = { kimi: 'charcoal', zai: 'graphite', minimax: 'rose', stepfun: 'sky', mimo: 'tangerine', qwen: 'cobalt' }
const DEFAULT_INK = INKS.deepseek

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const crc32 = (buffer) => {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const hexToRgb = (hex) => {
  const value = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : DEFAULT_INK
  return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16))
}

/** A 128×128 RGBA PNG of one colour. */
export function squarePng(hex, size = 128) {
  const [r, g, b] = hexToRgb(hex)
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < size; x += 1) {
      const at = y * stride + 1 + x * 4
      // A soft diagonal keeps the square from looking like a broken image while staying
      // readable as one flat colour at avatar size.
      const light = Math.round(18 * (1 - (x + y) / (2 * size)))
      raw[at] = Math.min(255, r + light)
      raw[at + 1] = Math.min(255, g + light)
      raw[at + 2] = Math.min(255, b + light)
      raw[at + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// A Bot's picture: its own image when it has one, else a rounded square in the Bot's ink
// with the first character of its name on it. Drawing goes through ImageMagick and the
// system CJK font, which is how 桥 and 验 can be rendered at all; without them the plain
// ink square is used so an upload never fails.
const AVATAR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'state', 'avatars')
const CJK_FONT = ['/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc']

/** The character that stands for a Bot: 桥 for 桥接, C for Chief. */
export function glyphOf(name) {
  const text = String(name ?? '').trim()
  if (text === '') return '?'
  const first = [...text][0]
  return /^[a-z]$/i.test(first) ? first.toUpperCase() : first
}

function renderGlyph(ink, glyph, name) {
  mkdirSync(AVATAR_DIR, { recursive: true, mode: 0o700 })
  const cache = join(AVATAR_DIR, `${ink.replace('#', '')}-${[...glyph].map(char => char.codePointAt(0).toString(16)).join('_')}.png`)
  try {
    return readFileSync(cache)
  } catch { /* not cached yet */ }
  const font = CJK_FONT.find(path => existsSync(path))
  if (font === undefined) return undefined
  try {
    // A CJK glyph needs a larger point size than a single Latin capital to fill the tile.
    const cjk = !/^[A-Z0-9]$/.test(glyph)
    const args = [
      '-size', '128x128', 'xc:none',
      '-fill', ink, '-draw', 'roundrectangle 0,0,127,127,30,30',
      '-fill', '#ffffff', '-font', font,
      '-pointsize', cjk ? '72' : '76',
      '-gravity', 'center', '-annotate', cjk ? '+0+2' : '+0+0',
      glyph, 'png:-',
    ]
    const bytes = execFileSync('magick', args, { maxBuffer: 8 * 1024 * 1024 })
    if (bytes.length === 0) return undefined
    if (bytes.length <= 160_000) writeFileSync(cache, bytes, { mode: 0o600 })
    return bytes
  } catch {
    return undefined
  }
}

/** What to upload for a Bot: its own image if it has one, else its initialled tile. */
export function avatarFor(bot) {
  const image = bot?.avatar?.image
  if (typeof image === 'string' && image.startsWith('data:')) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(image)
    if (match !== null) {
      const mime = match[1]
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) {
        const bytes = match[2] === ';base64' ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
        if (bytes.length > 0 && bytes.length <= 160_000) return { bytes, mime, kind: 'image' }
      }
    }
  }
  const color = bot?.color ?? bot?.avatar?.color
  const ink = INKS[LEGACY[color] ?? color] ?? (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_INK)
  const glyph = glyphOf(bot?.name)
  const drawn = renderGlyph(ink, glyph, bot?.name)
  if (drawn !== undefined) return { bytes: drawn, mime: 'image/png', kind: `glyph:${ink}:${glyph}` }
  return { bytes: squarePng(ink), mime: 'image/png', kind: `ink:${ink}` }
}

/** A stable fingerprint of the look, so an unchanged Bot is not re-uploaded every pass. */
export const lookOf = (bot) => {
  const image = bot?.avatar?.image
  if (typeof image === 'string' && image !== '') return `image:${image.length}:${image.slice(-24)}`
  return `glyph:${bot?.color ?? bot?.avatar?.color ?? 'deepseek'}:${glyphOf(bot?.name)}`
}
