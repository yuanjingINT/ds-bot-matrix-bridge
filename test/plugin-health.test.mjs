// Delivery health: receiving turns on only when there is a real route into DS Bot and it
// answers. The route today is the GUI's own API, reached through the injector's probe, so
// these tests drive the receiver with a stand-in injector instead of a socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Receiver } from '../src/receive.js'

const receiverWith = (injector) => new Receiver({
  store: { room: () => undefined, rooms: () => ({}), bots: () => ({}) },
  accounts: {},
  config: { injector, guiTokenFile: '/nonexistent/gui_token', userMxid: '', log: () => {} },
})

test('a working route turns receiving on, and says which transport it is', async () => {
  const injector = {
    available: () => true,
    ping: async () => ({ ok: true, transport: 'gui-http', verified: true }),
  }
  const health = await receiverWith(injector).health()
  assert.equal(health.ok, true)
  assert.equal(health.verified, true)
  assert.equal(health.transport, 'gui-http')
})

test('a route whose probe fails is reported with its reason, not silently dropped', async () => {
  const injector = {
    available: () => true,
    ping: async () => ({ ok: false, reason: 'the GUI did not accept the launch token' }),
  }
  const health = await receiverWith(injector).health()
  assert.equal(health.ok, false)
  assert.match(health.reason, /launch token/)
})

test('no token means no receiving, with the file that is missing in the reason', async () => {
  const injector = { available: () => false }
  const health = await receiverWith(injector).health()
  assert.equal(health.ok, false)
  assert.match(health.reason, /gui_token/)
})

test('a probe result is cached briefly, so a quiet tick is not a request per second', async () => {
  let calls = 0
  const injector = {
    available: () => true,
    ping: async () => { calls += 1; return { ok: true, transport: 'gui-http', verified: true } },
  }
  const receiver = receiverWith(injector)
  await receiver.health()
  await receiver.health()
  await receiver.health()
  assert.equal(calls, 1)
})
