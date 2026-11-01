// Receiving turns on only for the real DSH plugin. A stand-in that answers /health (the
// one used to test the receive loop before the plugin is mounted) must never count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Receiver } from '../src/receive.js'

async function withSocket(answer, run) {
  const socketPath = join(tmpdir(), `mx-health-${process.pid}-${Math.random().toString(16).slice(2)}.sock`)
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(answer))
  })
  await new Promise(resolve => server.listen(socketPath, resolve))
  try {
    return await run(socketPath)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

const receiverOn = socketPath => new Receiver({
  store: { room: () => undefined, rooms: () => ({}), bots: () => ({}) },
  accounts: {},
  config: { controlSocket: socketPath, userMxid: '', log: () => {} },
})

test('the real plugin turns receiving on', async () => {
  await withSocket({ ok: true, name: 'matrix-bridge-host', version: '0.1.0' }, async (socketPath) => {
    const health = await receiverOn(socketPath).health()
    assert.equal(health.ok, true)
    assert.equal(health.version, '0.1.0')
  })
})

test('a stand-in on the socket does not pass as the plugin', async () => {
  await withSocket({ ok: true, name: 'stub', version: 'stub' }, async (socketPath) => {
    const health = await receiverOn(socketPath).health()
    assert.equal(health.ok, false)
    assert.match(health.reason, /not matrix-bridge-host/)
  })
})

test('nothing on the socket is reported as a reason, not as ready', async () => {
  const health = await receiverOn(join(tmpdir(), 'mx-health-does-not-exist.sock')).health()
  assert.equal(health.ok, false)
  assert.match(health.reason, /ENOENT|cannot|no such/i)
})
