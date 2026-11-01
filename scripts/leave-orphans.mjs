#!/usr/bin/env node
// Leaves every Matrix room the bridge no longer mirrors — the rooms left behind when a
// group's room was rebuilt. The Bots leave with their own tokens; the user's account
// leaves only if its token is in the 600 file (see README, zero-click joining). Without
// that token the script still leaves for the Bots and prints what the user has to leave.
//
//   node scripts/leave-orphans.mjs           # bots leave, user is reported
//   node scripts/leave-orphans.mjs --dry-run # only list
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const state = JSON.parse(readFileSync(join(root, 'state', 'bridge.json'), 'utf8'))
const keep = new Set(Object.values(state.rooms ?? {}).map(record => record.matrixRoomId).filter(Boolean))
const homeserver = (process.env.MATRIX_HOMESERVER_URL ?? 'https://mx.tuxai.org').replace(/\/+$/, '')
const tokenFile = process.env.MATRIX_USER_TOKEN_FILE ?? join(homedir(), '.dsh', 'bot', 'workspace', '.secrets', 'matrix_user_token')

const api = async (token, method, path, body) => {
  const response = await fetch(`${homeserver}/_matrix/client/v3${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) }
}

const invited = []
for (const [botId, bot] of Object.entries(state.bots ?? {})) {
  if (bot.leftAt) continue
  const joined = await api(bot.accessToken, 'GET', '/joined_rooms')
  const orphans = (joined.body.joined_rooms ?? []).filter(roomId => !keep.has(roomId))
  invited.push(...orphans)
  for (const roomId of orphans) {
    if (dryRun) {
      console.log(`${bot.userId} would leave ${roomId}`)
      continue
    }
    const left = await api(bot.accessToken, 'POST', `/rooms/${encodeURIComponent(roomId)}/leave`, {})
    console.log(`${bot.userId} leave ${roomId} -> ${left.status}`)
  }
}

const userToken = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : ''
if (userToken === '') {
  console.log(`\nno user token at ${tokenFile}: the user has to leave these rooms in Element:`)
  for (const roomId of [...new Set(invited)]) console.log(`  ${roomId}`)
  process.exit(0)
}

const mine = await api(userToken, 'GET', '/joined_rooms')
const orphans = (mine.body.joined_rooms ?? []).filter(roomId => !keep.has(roomId))
for (const roomId of orphans) {
  if (dryRun) {
    console.log(`user would leave ${roomId}`)
    continue
  }
  const left = await api(userToken, 'POST', `/rooms/${encodeURIComponent(roomId)}/leave`, {})
  console.log(`user leave ${roomId} -> ${left.status}`)
}
if (orphans.length === 0) console.log('user: no orphan rooms left')
