// Live E2EE smoke test: one Bot account, one throwaway room, real homeserver.
//
//   1. keys/upload through the machine's own request pump
//   2. m.room.encryption set on the room (the creator has implicit power 100)
//   3. one m.room.message encrypted by the machine and sent as m.room.encrypted
//   4. the same event read back and decrypted, proving the round trip
//
// The room is left behind closed: the script makes it, uses it, and forgets it.
//
// Run: node scripts/e2ee-smoke.mjs [--keep]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { MatrixClient } from '../src/matrix.js'
import { BridgeStore } from '../src/store.js'
import { Crypto } from '../src/crypto.js'

const root = join(import.meta.dirname, '..')
const store = new BridgeStore(join(root, 'state', 'bridge.json'), join(root, 'state', 'accounts.json'))
const data = store.load()
const bot = Object.values(data.bots).find(record => record.localpart === (process.env.E2EE_BOT ?? 'chief'))
if (bot === undefined) {
  console.error(`no account for E2EE_BOT=${process.env.E2EE_BOT ?? 'chief'}`)
  process.exit(1)
}

const homeserverUrl = process.env.MATRIX_HOMESERVER_URL ?? 'https://mx.tuxai.org'
const log = (event, fields) => console.log(`[${event}]`, JSON.stringify(fields ?? {}))
const client = new MatrixClient({ homeserverUrl, accessToken: bot.accessToken, userId: bot.userId })
const crypto = new Crypto({
  client,
  userId: bot.userId,
  deviceId: bot.deviceId,
  storePath: join(root, 'state', 'crypto', bot.userId.replace(/[^a-z0-9]/gi, '_')),
  log,
})

let roomId
let failed = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  if (!ok) failed += 1
}

try {
  await crypto.init()
  // Zero requests is normal on a second run: the store already holds the uploaded keys.
  const uploaded = await crypto.pump()
  console.log(`info  the machine pumped ${uploaded} request(s) (0 = keys already uploaded)`)

  const query = await client.request('POST', '/keys/query', { device_keys: { [bot.userId]: [] } })
  const devices = query?.device_keys?.[bot.userId] ?? {}
  check('the homeserver knows this device', devices[bot.deviceId] !== undefined, `${Object.keys(devices).length} device(s)`)

  const created = await client.createRoom({ name: `e2ee-smoke-${Date.now()}`, invite: [], encrypted: true })
  roomId = created.room_id
  check('the room was created with encryption', true, roomId)

  const state = await client.request('GET', `/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`)
  check('m.room.encryption is in the room state', state?.algorithm === 'm.megolm.v1.aes-sha2', state?.algorithm)

  await crypto.prepareRoom(roomId)
  check('the room key was shared with the room members', true)

  const marker = `e2ee round trip ${new Date().toISOString()}`
  const encrypted = await crypto.encrypt(roomId, 'm.room.message', { msgtype: 'm.text', body: marker })
  check('the machine produced m.room.encrypted content', encrypted?.algorithm === 'm.megolm.v1.aes-sha2', encrypted?.algorithm)

  const sent = await client.sendMessage(roomId, `e2ee.${Date.now()}`, encrypted)
  check('the encrypted event was accepted', typeof sent.event_id === 'string', sent.event_id)

  const back = await client.request('GET', `/rooms/${encodeURIComponent(roomId)}/messages`, undefined, {
    query: { dir: 'b', limit: 5 },
  })
  const event = (back?.chunk ?? []).find(item => item.event_id === sent.event_id)
  check('the event can be read back', event !== undefined)

  const decrypted = await crypto.decrypt(roomId, event)
  const body = JSON.parse(decrypted.event ?? '{}')?.content?.body ?? decrypted.content?.body
  check('it decrypts to the original text', body === marker, String(body).slice(0, 40))
} catch (error) {
  console.log(`FAIL  ${error?.message ?? error}`)
  failed += 1
} finally {
  if (roomId !== undefined && !process.argv.includes('--keep')) {
    await client.request('POST', `/rooms/${encodeURIComponent(roomId)}/leave`, {}).catch(() => {})
    console.log('left the throwaway room')
  }
  crypto.close()
}

console.log(failed === 0 ? '\nE2EE smoke test passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
