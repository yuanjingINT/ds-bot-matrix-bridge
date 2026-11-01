#!/usr/bin/env node
// Cleans up duplicate Matrix rooms the bridge left behind: every room the owner is in that
// carries a live group's name but is not the room the bridge writes to now. Rooms of other
// names are never touched, and neither are the live rooms.
//
//   node scripts/cleanup-rooms.mjs --dry-run   # what would be left, with no change
//   node scripts/cleanup-rooms.mjs             # leave them as the owner
//
// The owner's token is read from settings.userTokenFile (default
// ~/.dsh/bot/workspace/.secrets/matrix_user_token, 0600). It is used and never printed.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MatrixClient } from '../src/matrix.js'
import { loadSettings } from '../src/settings.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const settings = loadSettings({ needsHomeserver: true })

const tokenFile = settings.userTokenFile
let token
try {
  token = readFileSync(tokenFile, 'utf8').trim()
} catch {
  console.error(`no owner token at ${tokenFile}`)
  process.exit(1)
}
if (token === '') {
  console.error(`the owner token file ${tokenFile} is empty`)
  process.exit(1)
}

const state = JSON.parse(readFileSync(join(root, 'state', 'bridge.json'), 'utf8'))
const live = new Map()
for (const record of Object.values(state.rooms ?? {})) {
  if (record?.matrixRoomId !== undefined && record.goneAt === undefined) live.set(record.matrixRoomId, record.name)
}
if (live.size === 0) {
  console.error('no live room in state/bridge.json; nothing to compare against')
  process.exit(1)
}

const client = new MatrixClient({ homeserverUrl: settings.homeserverUrl, accessToken: token, userId: settings.userMxid })
const { joined_rooms: ids = [] } = await client.request('GET', '/joined_rooms')
const rooms = []
for (const roomId of ids) {
  let name
  try {
    name = (await client.request('GET', `/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`))?.name
  } catch { /* unnamed or unreadable */ }
  rooms.push({ roomId, name })
}

const liveNames = new Set(live.values())
const stale = rooms.filter(room => !live.has(room.roomId) && liveNames.has(room.name))

console.log(`the owner is in ${rooms.length} room(s); ${live.size} live, ${stale.length} duplicate(s)`)
for (const [roomId, name] of live) console.log(`  live     ${name}  ${roomId}`)
let left = 0
for (const room of stale) {
  if (dryRun) {
    console.log(`  stale    ${room.name}  ${room.roomId}  (would leave)`)
    continue
  }
  try {
    await client.request('POST', `/rooms/${encodeURIComponent(room.roomId)}/leave`, {})
    left += 1
    console.log(`  left     ${room.name}  ${room.roomId}`)
  } catch (error) {
    console.log(`  failed   ${room.name}  ${room.roomId}  ${error?.message ?? String(error)}`)
  }
}
console.log(dryRun ? '\ndry run: nothing was changed' : `\nleft ${left} duplicate room(s); the live rooms are untouched`)
