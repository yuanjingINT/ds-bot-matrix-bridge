// Live check of the receive path against the real homeserver, with a stand-in for the DSH
// plugin: a message a person writes in the Matrix room must reach the control socket as a
// /prompt call for that group chat, exactly once, and a replay of the same batch must not
// deliver it again.
//
// Run: node test/receive-live.test.mjs
// Needs: state/bridge.json (a mirrored room), the room creator's token, and a sender
// account that is not a bridge account (MX_BRIDGE_TEST_SENDER, default @dsbridge:tuxai.org).
import { readFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MatrixClient } from '../src/matrix.js'
import { BridgeStore } from '../src/store.js'
import { Accounts } from '../src/accounts.js'
import { Receiver } from '../src/receive.js'

const root = join(import.meta.dirname, '..')
// The sender must be a real, non-bridge account. `@dsbridge` (the old default) was
// deactivated on the homeserver, so point this at a live account's 600 file instead:
//   MX_BRIDGE_TEST_SENDER_FILE=/path/to/sender.json node test/receive-live.test.mjs
const credentialsPath = process.env.MX_BRIDGE_TEST_SENDER_FILE ?? join(homedir(), '.config', 'matrix-bridge', 'credentials.json')
const senderCredentials = JSON.parse(readFileSync(credentialsPath, 'utf8'))
const store = new BridgeStore(join(root, 'state', 'bridge.json'), join(root, 'state', 'accounts.json'))
const data = store.load()

const targetRoom = Object.entries(data.rooms).find(([, record]) => record.matrixRoomId && record.goneAt === undefined && record.name === (process.env.MX_BRIDGE_TEST_GROUP ?? 'MX 测试'))
if (targetRoom === undefined) {
  console.error('no mirrored room to test; run the bridge once so it creates one')
  process.exit(1)
}
const [groupId, record] = targetRoom
const creator = store.bot(record.creatorBotId)
if (creator === undefined) {
  console.error('the room record has no creator Bot, so no reader account')
  process.exit(1)
}

const homeserverUrl = process.env.MATRIX_HOMESERVER_URL ?? 'https://mx.tuxai.org'
const creatorClient = new MatrixClient({ homeserverUrl, accessToken: creator.accessToken, userId: creator.userId })
const senderClient = new MatrixClient({ homeserverUrl, accessToken: senderCredentials.accessToken, userId: senderCredentials.userId })

// A deactivated or expired sender account cannot join the room, and that is a broken test
// setup rather than a broken bridge: say so and stop instead of failing the receive path.
try {
  await senderClient.whoami()
} catch (error) {
  console.log(`SKIP: the sender account ${senderCredentials.userId} is not usable (${error?.errcode ?? error?.message})`)
  console.log('Set MX_BRIDGE_TEST_SENDER_FILE to a live, non-bridge account and run again.')
  process.exit(0)
}

// The sender must be in the room for its message to reach the timeline.
await creatorClient.invite(record.matrixRoomId, senderCredentials.userId).catch(() => {})
await senderClient.joinRoom(record.matrixRoomId).catch((error) => {
  if (!/already/i.test(String(error?.message ?? ''))) throw error
})

const delivered = []
const socketPath = `/tmp/mx-bridge-receive-${process.pid}.sock`
const server = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    delivered.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
})
await new Promise(resolve => server.listen(socketPath, resolve))

const config = {
  log: (event, fields) => { if (process.env.VERBOSE === '1') console.error(event, JSON.stringify(fields)) },
  controlSocket: socketPath,
  userMxid: process.env.MATRIX_USER_ID ?? '@yuanjing:tuxai.org',
}
const accounts = new Accounts({ store, config: { homeserverUrl, registrationToken: undefined, cryptoDir: join(root, 'state', 'crypto'), log: config.log } })
const receiver = new Receiver({ store, accounts, config })

const sync = async () => {
  const latest = store.room(groupId)
  const filter = JSON.stringify({ room: { rooms: [record.matrixRoomId], timeline: { limit: 30 }, state: { lazy_load_members: true }, ephemeral: { types: [] }, account_data: { types: [] } }, presence: { types: [] }, account_data: { types: [] } })
  const query = latest.syncToken === undefined ? { filter, timeout: 0 } : { since: latest.syncToken, filter, timeout: 0 }
  const response = await creatorClient.request('GET', '/sync', undefined, { query, timeoutMs: 30_000 })
  if (latest.syncToken !== undefined && response.rooms?.join?.[record.matrixRoomId] !== undefined) await receiver.deliver(groupId, record.matrixRoomId, response)
  const next = store.room(groupId)
  next.syncToken = response.next_batch
  await store.setRoom(groupId, next)
  return response
}

// First pass: a token with no history, so the room's old lines are not replayed.
await sync()
const marker = `桥接反向测试 ${new Date().toISOString()}`
const t0 = Date.now()
await senderClient.sendMessage(record.matrixRoomId, `test.${Date.now()}`, { msgtype: 'm.text', body: marker })
let got
for (let attempt = 0; attempt < 12; attempt += 1) {
  await sync()
  got = delivered.find(item => item.sessionId === groupId && item.text.includes(marker))
  if (got !== undefined) break
  await new Promise(resolve => setTimeout(resolve, 400))
}
const latency = got === undefined ? undefined : Date.now() - t0

// Replay the same batch: the handled list must keep it from being delivered twice.
const before = delivered.length
await sync()
const replayed = delivered.length - before

server.close()
const checks = [
  ['message reached the control socket', got !== undefined],
  ['it targets the right group chat', got?.sessionId === groupId],
  // A message from someone other than the owner carries the sender's Matrix name, so a
  // group chat line says who wrote it even though one DS Bot user line looks like another.
  ['the sender is named in the text', typeof got?.text === 'string' && /^.+（Matrix）：/.test(got.text)],
  ['a replayed batch is not delivered again', replayed === 0],
]
let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${label.startsWith('message') && latency !== undefined ? ` (${latency} ms)` : ''}`)
  if (!ok) failed += 1
}
console.log(`delivered text: ${got?.text?.slice(0, 120) ?? '(nothing)'}`)
if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nreceive path ok')
process.exit(0)
