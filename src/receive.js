// Matrix → DS Bot. Each Matrix room the bridge created is read with the account that
// created it (that account is in the room by definition), one long-poll /sync per room, and
// a message a person wrote there is delivered to the DS Bot group chat through the
// matrix-bridge-host control socket (see ../plugin/index.js).
//
// Reliability shape:
//   - the sync token is saved only after every event of the batch was delivered, so a
//     crash replays the batch rather than losing it;
//   - a delivered event id is remembered per room, so the replay cannot post a message
//     twice;
//   - the first sync of a room takes next_batch without delivering history, so a room
//     that already has lines is not replayed into the group chat.
import { request as httpRequest } from 'node:http'

const SYNC_TIMEOUT_MS = 25_000
const HANDLED_KEPT = 300
// What /sync asks for: this room only, message events only.
const filterFor = roomId => JSON.stringify({
  room: {
    rooms: [roomId],
    timeline: { limit: 30 },
    state: { lazy_load_members: true },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
  presence: { types: [] },
  account_data: { types: [] },
})

export class Receiver {
  /**
   * @param {object} options
   * @param {any} options.store
   * @param {import('./accounts.js').Accounts} options.accounts
   * @param {{log:Function, controlSocket:string, userMxid:string, syncTimeoutMs?:number}} options.config
   */
  constructor({ store, accounts, config }) {
    this.store = store
    this.accounts = accounts
    this.config = config
    this.log = config.log
    this.loops = new Map()
    this.stopping = false
    this.socketPath = config.controlSocket
    // Bridge accounts are never inbound. The store knows the Bots' own accounts; this set
    // adds historical ones (@dsbridge, Dito's bot) so an old bridge still running on the
    // same rooms cannot echo back in, even though it is not in the store.
    this.ignoredSenders = new Set(Array.isArray(config.ignoredSenders) ? config.ignoredSenders : [])
  }

  /** Reconciles one reader loop per mirrored room; a room the bridge stops mirroring ends its loop. */
  async reconcile(rooms) {
    const live = new Set()
    for (const room of rooms) {
      const record = this.store.room(room.id)
      if (record?.matrixRoomId === undefined || record.goneAt !== undefined) continue
      live.add(room.id)
      if (this.loops.has(room.id)) continue
      const reader = this.readerFor(record)
      if (reader === undefined) continue
      const controller = new AbortController()
      const task = this.run(room.id, controller.signal)
        .catch(error => this.log('receive-failed', { group_id: room.id, room_id: record.matrixRoomId, message: error?.message ?? String(error), errcode: error?.errcode }))
        .finally(() => this.loops.delete(room.id))
      this.loops.set(room.id, { controller, task })
      this.log('receive-start', { group_id: room.id, room_id: record.matrixRoomId, reader: reader.userId })
    }
    for (const [groupId, loop] of this.loops) {
      if (live.has(groupId)) continue
      loop.controller.abort()
      this.loops.delete(groupId)
    }
  }

  readerFor(record) {
    const creatorId = record.creatorBotId
    if (creatorId !== undefined && this.store.bot(creatorId)?.accessToken) return this.store.bot(creatorId)
    const member = (record.members ?? []).map(botId => this.store.bot(botId)).find(bot => bot?.accessToken)
    return member
  }

  async stop() {
    this.stopping = true
    for (const [, loop] of this.loops) loop.controller.abort()
    await Promise.allSettled([...this.loops.values()].map(loop => loop.task))
    this.loops.clear()
  }

  async run(groupId, signal) {
    let backoff = 1_000
    while (!this.stopping && !signal.aborted) {
      const record = this.store.room(groupId)
      if (record?.matrixRoomId === undefined) return
      const reader = this.readerFor(record)
      if (reader === undefined) return
      const client = this.accounts.clientFor(reader)
      const since = record.syncToken
      try {
        const filter = filterFor(record.matrixRoomId)
        const query = since === undefined
          ? { filter, timeout: 0 }
          : { since, filter, timeout: SYNC_TIMEOUT_MS }
        const response = await client.request('GET', '/sync', undefined, {
          query,
          timeoutMs: SYNC_TIMEOUT_MS + 15_000,
        })
        backoff = 1_000
        if (typeof response.next_batch !== 'string') throw new Error('/sync returned no next_batch')
        if (since !== undefined) await this.deliver(groupId, record.matrixRoomId, response)
        // The token moves only after the batch is delivered (see the header).
        const latest = this.store.room(groupId)
        latest.syncToken = response.next_batch
        latest.syncedAt = Date.now()
        await this.store.setRoom(groupId, latest)
        if (this.config.onSynced !== undefined) this.config.onSynced(groupId, latest)
      } catch (error) {
        if (signal.aborted || this.stopping) return
        const status = error?.status
        // A token the homeserver no longer knows is dropped, so the loop can start over
        // instead of failing forever.
        if (error?.errcode === 'M_UNKNOWN_POS' || error?.errcode === 'M_UNKNOWN_TOKEN') {
          this.log('receive-reset', { group_id: groupId, room_id: record.matrixRoomId, errcode: error?.errcode })
          const latest = this.store.room(groupId)
          delete latest.syncToken
          await this.store.setRoom(groupId, latest)
          continue
        }
        this.log('receive-error', { group_id: groupId, room_id: record.matrixRoomId, status, errcode: error?.errcode, message: error?.message ?? String(error) })
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  async deliver(groupId, matrixRoomId, response) {
    const join = response?.rooms?.join ?? {}
    const room = join[matrixRoomId]
    if (room === undefined) return
    // Member names come with the timeline's state (lazy-loaded), so a sender that has not
    // spoken before still shows a name.
    const names = new Map()
    for (const event of room.state?.events ?? []) {
      if (event?.type === 'm.room.member' && typeof event.state_key === 'string') {
        names.set(event.state_key, event.content?.displayname ?? event.state_key)
      }
    }
    for (const event of room.timeline?.events ?? []) {
      if (event?.type === 'm.room.member' && typeof event.state_key === 'string') {
        names.set(event.state_key, event.content?.displayname ?? event.state_key)
      }
      if (event?.type !== 'm.room.message') continue
      if (event.content?.msgtype !== 'm.text' && event.content?.msgtype !== 'm.notice') continue
      const handled = this.store.room(groupId)?.handled ?? []
      if (typeof event.event_id === 'string' && handled.includes(event.event_id)) continue
      // The bridge's own accounts are an echo, not a person: dropped before the allowlist so
      // the log says "echo" instead of "not allowed" (see isBridgeAccount).
      if (this.isBridgeAccount(event.sender)) {
        this.log('ignored-sender', {
          group_id: groupId,
          room_id: matrixRoomId,
          event_id: event.event_id ?? null,
          sender: event.sender ?? null,
          reason: this.ignoredSenders.has(event.sender) ? 'sender is a known bridge account' : 'sender is a DS Bot account',
        })
        const echo = this.store.room(groupId)
        echo.handled = [...(echo.handled ?? []), event.event_id].filter(Boolean).slice(-HANDLED_KEPT)
        await this.store.setRoom(groupId, echo)
        continue
      }
      // Only the configured accounts may speak as a person here; anyone else in the room
      // is dropped (and remembered, so a replay does not re-log it).
      if (!this.allowed(event.sender)) {
        this.log('skipped', {
          group_id: groupId,
          room_id: matrixRoomId,
          event_id: event.event_id ?? null,
          sender: event.sender ?? null,
          reason: 'sender is not in allowedSenders',
        })
        const skipped = this.store.room(groupId)
        skipped.handled = [...(skipped.handled ?? []), event.event_id].filter(Boolean).slice(-HANDLED_KEPT)
        await this.store.setRoom(groupId, skipped)
        continue
      }
      const line = this.textOf(event, names)
      if (line === undefined) continue
      await this.post(groupId, line)
      const latest = this.store.room(groupId)
      latest.handled = [...(latest.handled ?? []), event.event_id].filter(Boolean).slice(-HANDLED_KEPT)
      await this.store.setRoom(groupId, latest)
      this.log('received', {
        group_id: groupId,
        room_id: matrixRoomId,
        event_id: event.event_id ?? null,
        sender: event.sender ?? null,
        length: line.length,
        t_recv_mx: Date.now(),
      })
    }
  }

  /** Whether this sender may speak as a person into the DS Bot group chat. */
  allowed(userId) {
    const list = this.config.allowedSenders
    if (!Array.isArray(list) || list.length === 0) return false
    return typeof userId === 'string' && list.includes(userId)
  }

  /** A message written by a bridge account is the bridge's own echo; it never goes back in. */
  isBridgeAccount(userId) {
    if (typeof userId !== 'string') return true
    if (this.ignoredSenders.has(userId)) return true
    return Object.values(this.store.bots()).some(record => record?.userId === userId)
  }

  textOf(event, names) {
    const sender = event.sender
    if (this.isBridgeAccount(sender)) return undefined
    const raw = event.content?.body
    if (typeof raw !== 'string' || raw.trim() === '') return undefined
    const body = raw.length > 8_000 ? `${raw.slice(0, 8_000)}…（共 ${raw.length} 字，其余省略）` : raw
    if (this.config.userMxid !== '' && sender === this.config.userMxid) return body
    const name = names.get(sender) ?? (typeof sender === 'string' ? sender.replace(/^@/, '').split(':')[0] : 'Matrix')
    return `${name}（Matrix）：${body}`
  }

  /** Hands one line to the DSH-side plugin over its UNIX socket. */
  post(groupId, text) {
    const payload = JSON.stringify({ sessionId: groupId, text })
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.socketPath,
        path: '/prompt',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        timeout: 40_000,
      }, (response) => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode !== 200) {
            reject(new Error(`control socket answered ${response.statusCode}: ${body.slice(0, 300)}`))
            return
          }
          resolve()
        })
      })
      request.on('timeout', () => request.destroy(new Error('the control socket did not answer in time')))
      request.on('error', reject)
      request.end(payload)
    })
  }

  /**
   * Whether the DSH plugin is up; the bridge refuses to start receiving without it. A
   * failure comes back as {ok:false, reason} rather than undefined, so the log can say why
   * receiving is off instead of only that it is.
   */
  health() {
    return new Promise((resolve) => {
      const request = httpRequest({ socketPath: this.socketPath, path: '/health', method: 'GET', timeout: 3_000 }, (response) => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode !== 200) {
            resolve({ ok: false, reason: `control socket answered ${response.statusCode}: ${body.slice(0, 200)}` })
            return
          }
          try {
            const parsed = JSON.parse(body)
            resolve(parsed?.ok === true ? parsed : { ok: false, reason: `unexpected health body: ${body.slice(0, 200)}` })
          } catch {
            resolve({ ok: false, reason: `health is not JSON: ${body.slice(0, 200)}` })
          }
        })
      })
      request.on('timeout', () => { request.destroy(); resolve({ ok: false, reason: 'the control socket did not answer in time' }) })
      request.on('error', (error) => resolve({ ok: false, reason: `${error?.code ?? 'error'}: ${error?.message ?? String(error)}` }))
      request.end()
    })
  }
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})
