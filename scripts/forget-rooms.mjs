#!/usr/bin/env node
// Leaves every Matrix room the bridge created and forgets the mapping, so the next run
// builds them again from the DS Bot team (backlog included). For rooms made before a fix
// in room creation, or to force a clean re-sync.
//
//   node scripts/forget-rooms.mjs                       # all rooms
//   node scripts/forget-rooms.mjs <group-id>            # one group
//   node scripts/forget-rooms.mjs all --to <new-room-id>  # migrate first (tombstone), then leave
//
// The old rooms stay in the users' room lists (nobody but the user can leave for them);
// this only stops the bridge from writing to them.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const toIndex = args.indexOf('--to')
const replacement = toIndex === -1 ? undefined : args[toIndex + 1]
const wanted = args.find(arg => !arg.startsWith('--') && arg !== replacement)
const state = JSON.parse(readFileSync(join(root, 'state', 'bridge.json'), 'utf8'))

const rooms = Object.entries(state.rooms ?? {}).filter(([groupId]) => wanted === undefined || groupId === wanted)
if (rooms.length === 0) {
  console.error('no matching room in state/bridge.json')
  process.exit(1)
}

for (const [groupId, record] of rooms) {
  const roomId = record.matrixRoomId
  // Matrix migration: name the replacement in the old room, then leave it.
  if (replacement !== undefined) {
    for (const [botId, bot] of Object.entries(state.bots ?? {})) {
      if (!(record.members ?? []).includes(botId)) continue
      const tombstone = await fetch(`https://mx.tuxai.org/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.tombstone/`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${bot.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body: '这个群对应的房间已重建，请到新房间继续。', replacement_room: replacement }),
      })
      console.log(`tombstone ${bot.userId} ${roomId} -> ${tombstone.status}`)
      if (tombstone.ok) break
    }
  }
  for (const [botId, bot] of Object.entries(state.bots ?? {})) {
    if (!(record.members ?? []).includes(botId)) continue
    const response = await fetch(`https://mx.tuxai.org/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bot.accessToken}`, 'content-type': 'application/json' },
      body: '{}',
    })
    console.log(`leave ${bot.userId} ${roomId} -> ${response.status}`)
  }
  delete state.rooms[groupId]
}
writeFileSync(join(root, 'state', 'bridge.json'), JSON.stringify(state, null, 1), { mode: 0o600 })
console.log(`forgot ${rooms.length} room(s); the next bridge run creates them again`)
