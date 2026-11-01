// Only the configured accounts may speak into a DS Bot group chat from Matrix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Receiver } from '../src/receive.js'

const USER = '@yuanjing:tuxai.org'
const ROOM = '!room:tuxai.org'

function makeReceiver(overrides = {}) {
  const room = { matrixRoomId: ROOM, handled: [] }
  const store = {
    room: () => room,
    setRoom: async () => {},
    bots: () => ({}),
  }
  const events = []
  const receiver = new Receiver({
    store,
    accounts: {},
    config: {
      userMxid: USER,
      allowedSenders: [USER],
      controlSocket: '/nonexistent',
      log: (event, fields) => events.push({ event, ...fields }),
      ...overrides,
    },
  })
  const delivered = []
  receiver.post = async (groupId, text) => { delivered.push({ groupId, text }) }
  return { receiver, delivered, events, room }
}

const message = (id, sender, body) => ({ type: 'm.room.message', event_id: id, sender, content: { msgtype: 'm.text', body } })

test('a message from the allowed account is delivered as the user', async () => {
  const { receiver, delivered, events } = makeReceiver()
  await receiver.deliver('g1', ROOM, {
    rooms: { join: { [ROOM]: { timeline: { events: [message('$a', USER, '你好')] } } } },
  })
  assert.deepEqual(delivered, [{ groupId: 'g1', text: '你好' }])
  assert.ok(events.some(e => e.event === 'received' && e.sender === USER))
})

test('a message from anyone else is dropped and logged as skipped', async () => {
  const { receiver, delivered, events, room } = makeReceiver()
  await receiver.deliver('g1', ROOM, {
    rooms: {
      join: {
        [ROOM]: {
          state: { events: [{ type: 'm.room.member', state_key: '@verify-a:tuxai.org', content: { displayname: '验收A' } }] },
          timeline: { events: [message('$b', '@verify-a:tuxai.org', '我是验收A')] },
        },
      },
    },
  })
  assert.equal(delivered.length, 0, 'nothing is injected')
  const skipped = events.find(e => e.event === 'skipped')
  assert.ok(skipped !== undefined)
  assert.equal(skipped.sender, '@verify-a:tuxai.org')
  // The event may be remembered in the store (so a replay stays quiet) or not; either way
  // it must never reach the group chat.
  assert.ok(delivered.length === 0)
})

test('a replay of the same batch delivers nothing twice', async () => {
  const { receiver, delivered } = makeReceiver()
  const batch = { rooms: { join: { [ROOM]: { timeline: { events: [message('$c', USER, '一次')] } } } } }
  await receiver.deliver('g1', ROOM, batch)
  await receiver.deliver('g1', ROOM, batch)
  assert.equal(delivered.length, 1)
})

test('a historical bridge account is dropped as an echo, even when it is allowlisted', async () => {
  const { receiver, delivered, events } = makeReceiver({
    allowedSenders: [USER, '@dsbridge:tuxai.org'],
    ignoredSenders: ['@dsbridge:tuxai.org'],
  })
  await receiver.deliver('g1', ROOM, {
    rooms: { join: { [ROOM]: { timeline: { events: [message('$b', '@dsbridge:tuxai.org', '老桥回灌')] } } } },
  })
  assert.deepEqual(delivered, [])
  const ignored = events.find(e => e.event === 'ignored-sender')
  assert.ok(ignored, 'the drop is logged')
  assert.equal(ignored.event_id, '$b')
  assert.equal(ignored.sender, '@dsbridge:tuxai.org')
})

test('a dropped echo is not logged twice when the same batch is replayed', async () => {
  const { receiver, events } = makeReceiver({ ignoredSenders: ['@dsbridge:tuxai.org'] })
  const batch = { rooms: { join: { [ROOM]: { timeline: { events: [message('$c', '@dsbridge:tuxai.org', 'x')] } } } } }
  await receiver.deliver('g1', ROOM, batch)
  await receiver.deliver('g1', ROOM, batch)
  assert.equal(events.filter(e => e.event === 'ignored-sender').length, 1)
})
