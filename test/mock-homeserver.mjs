// A mock homeserver: enough of the client-server API for the bridge's own tests (register
// with a token, profiles, rooms, invites, joins, state, and message sends), plus the two
// failure modes that matter — a lost response after the event was stored, and a slow
// homeserver — so ordering and idempotency can be checked without touching a real server.
import { createServer } from 'node:http'

export async function startMockHomeserver({ serverName = 'tuxai.test', registrationToken = 'test-token' } = {}) {
  const users = new Map() // userId → { password, token, deviceId, displayname }
  const rooms = new Map() // roomId → { name, topic, invites:Set, members:Set, events:[], state:Map }
  const events = []
  const txnSeen = new Map() // `${token}:${roomId}:${txnId}` → event_id
  const counters = { room: 0, event: 0 }
  const log = []
  let failNextWith = undefined
  let delayMs = 0

  const send = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(text)
  }
  const fail = (res, status, errcode, error) => send(res, status, { errcode, error })

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    // Media upload sends bytes, not JSON: parsing those as JSON would throw here instead of
    // answering the request the bridge actually made.
    const isJson = String(req.headers['content-type'] ?? '').includes('application/json')
    const json = isJson && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}
    const url = new URL(req.url, 'http://mock')
    const path = url.pathname.replace(/^\/_matrix\/client\/v3/, '')
    log.push({ method: req.method, path })
    if (delayMs > 0) await new Promise(done => setTimeout(done, delayMs))

    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const me = [...users.entries()].find(([, user]) => user.token === token)?.[0]

    if (req.method === 'POST' && path === '/register') {
      const auth = json.auth ?? {}
      // continuwuity's user-interactive auth: the first call answers with a session, the
      // token is checked on the call that carries it back.
      if (auth.session === undefined) {
        return send(res, 401, { session: 'uia-session', flows: [{ stages: ['m.login.registration_token'] }], params: {} })
      }
      if (auth.type !== 'm.login.registration_token' || auth.token !== registrationToken) {
        return fail(res, 401, 'M_UNAUTHORIZED', 'bad registration token')
      }
      const localpart = String(json.username ?? '')
      if (!/^[a-z][a-z0-9._=-]{0,31}$/.test(localpart)) return fail(res, 400, 'M_INVALID_USERNAME', 'invalid username')
      const userId = `@${localpart}:${serverName}`
      if (users.has(userId)) return fail(res, 400, 'M_USER_IN_USE', 'User ID already taken.')
      const deviceId = `DEV${localpart.toUpperCase().slice(0, 6)}`
      users.set(userId, { password: json.password, token: `tok-${localpart}`, deviceId, displayname: localpart })
      return send(res, 200, { user_id: userId, access_token: `tok-${localpart}`, device_id: deviceId })
    }

    if (path.startsWith('/profile/') && req.method === 'PUT') {
      const userId = decodeURIComponent(path.split('/')[2])
      const user = users.get(userId)
      if (user === undefined) return fail(res, 404, 'M_NOT_FOUND', 'Unknown user')
      if (json.displayname !== undefined) user.displayname = json.displayname
      if (json.avatar_url !== undefined) user.avatarUrl = json.avatar_url
      return send(res, 200, {})
    }

    if (me === undefined) return fail(res, 401, 'M_UNKNOWN_TOKEN', 'Unknown access token')

    // The bridge uploads a Bot's avatar through the media API, which lives outside
    // /_matrix/client/v3.
    if (req.method === 'POST' && path === '/_matrix/media/v3/upload') {
      counters.event += 1
      return send(res, 200, { content_uri: `mxc://${serverName}/mock${counters.event}` })
    }

    if (req.method === 'POST' && path === '/createRoom') {
      counters.room += 1
      const roomId = `!room${counters.room}:${serverName}`
      const room = {
        name: json.name ?? '',
        topic: json.topic ?? '',
        invites: new Set(json.invite ?? []),
        members: new Set([me]),
        events: [],
        state: new Map(),
        powerLevels: json.power_level_content_override ?? null,
      }
      // The name and topic are creation-time state, as on a real homeserver.
      if (json.name !== undefined) room.state.set('m.room.name|', { name: json.name })
      if (json.topic !== undefined) room.state.set('m.room.topic|', { topic: json.topic })
      rooms.set(roomId, room)
      return send(res, 200, { room_id: roomId })
    }

    const roomMatch = path.match(/^\/rooms\/([^/]+)\/(.+)$/)
    if (roomMatch) {
      const roomId = decodeURIComponent(roomMatch[1])
      const rest = roomMatch[2]
      const room = rooms.get(roomId)
      if (room === undefined) return fail(res, 404, 'M_NOT_FOUND', 'Unknown room')
      if (rest === 'invite') {
        room.invites.add(json.user_id)
        return send(res, 200, {})
      }
      if (rest === 'leave') {
        room.members.delete(me)
        return send(res, 200, {})
      }
      if (rest.startsWith('state/')) {
        const [, type, rawKey] = rest.split('/')
        const key = rawKey === undefined ? '' : decodeURIComponent(rawKey)
        if (req.method === 'GET') {
          const stored = room.state.get(`${type}|${key}`)
          if (stored === undefined) return fail(res, 404, 'M_NOT_FOUND', 'state not set')
          return send(res, 200, stored)
        }
        room.state.set(`${type}|${key}`, json)
        return send(res, 200, { event_id: `$state${counters.event += 1}` })
      }
      const sendMatch = rest.match(/^send\/([^/]+)\/([^/]+)$/)
      if (sendMatch) {
        const txnKey = `${token}:${roomId}:${decodeURIComponent(sendMatch[2])}`
        if (txnSeen.has(txnKey)) return send(res, 200, { event_id: txnSeen.get(txnKey) })
        counters.event += 1
        const eventId = `$evt${counters.event}:${serverName}`
        txnSeen.set(txnKey, eventId)
        const event = { event_id: eventId, room_id: roomId, sender: me, type: decodeURIComponent(sendMatch[1]), content: json, origin_server_ts: Date.now() }
        room.events.push(event)
        events.push(event)
        if (failNextWith !== undefined) {
          const status = failNextWith
          failNextWith = undefined
          // The event is stored, then the response is lost: exactly the retry case.
          return fail(res, status, 'M_UNKNOWN', 'gateway timed out')
        }
        return send(res, 200, { event_id: eventId })
      }
    }

    const joinMatch = path.match(/^\/join\/(.+)$/)
    if (req.method === 'POST' && joinMatch) {
      const roomId = decodeURIComponent(joinMatch[1])
      const room = rooms.get(roomId)
      if (room === undefined) return fail(res, 404, 'M_NOT_FOUND', 'Unknown room')
      if (!room.invites.has(me)) return fail(res, 403, 'M_FORBIDDEN', 'not invited')
      room.members.add(me)
      return send(res, 200, { room_id: roomId })
    }

    // The bridge syncs once before it asks what the account has joined, so a fresh account
    // never looks like "in no rooms" and get a duplicate room created.
    if (req.method === 'GET' && path === '/sync') {
      counters.sync = (counters.sync ?? 0) + 1
      return send(res, 200, { next_batch: `s${counters.sync}`, rooms: { join: {} } })
    }

    if (req.method === 'GET' && path === '/joined_rooms') {
      const joined = [...rooms.entries()].filter(([, room]) => room.members.has(me)).map(([roomId]) => roomId)
      return send(res, 200, { joined_rooms: joined })
    }

    if (req.method === 'GET' && path === '/account/whoami') return send(res, 200, { user_id: me })
    return fail(res, 404, 'M_UNRECOGNIZED', `mock has no ${req.method} ${path}`)
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`

  return {
    url,
    serverName,
    registrationToken,
    users,
    rooms,
    events,
    log,
    // Queue one lost response (the event is still stored) to prove retries are idempotent.
    failNextResponse(status = 502) {
      failNextWith = status
    },
    setDelay(ms) {
      delayMs = ms
    },
    eventsIn(roomId) {
      return (rooms.get(roomId)?.events ?? []).map(event => ({ sender: event.sender, ...event.content }))
    },
    async close() {
      await new Promise(resolve => server.close(resolve))
    },
  }
}
