// One Matrix account per DS Bot: created on demand with the homeserver's registration
// token, then used as that Bot's identity. Each account keeps its own device id and (from
// the E2EE step on) its own crypto store under state/crypto/<botId>.
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MatrixClient } from './matrix.js'
import { freeLocalpart } from './slug.js'

const randomPassword = () => randomBytes(24).toString('base64url')

export class Accounts {
  /**
   * @param {object} options
   * @param {import('./store.js').BridgeStore} options.store
   * @param {{homeserverUrl:string, registrationToken?:string, serverName:string, cryptoDir:string, log:Function}} options.config
   */
  constructor({ store, config }) {
    this.store = store
    this.config = config
    this.clients = new Map()
  }

  clientFor(record) {
    const cached = this.clients.get(record.userId)
    if (cached !== undefined) return cached
    const client = new MatrixClient({
      homeserverUrl: this.config.homeserverUrl,
      accessToken: record.accessToken,
      userId: record.userId,
    })
    this.clients.set(record.userId, client)
    return client
  }

  clientOf(botId) {
    const record = this.store.bot(botId)
    return record === undefined ? undefined : this.clientFor(record)
  }

  /** The account of one Bot, created when the Bot first needs one. */
  async ensure(bot) {
    const existing = this.store.bot(bot.id)
    if (existing !== undefined && existing.userId && existing.accessToken) {
      if (existing.name !== bot.name) await this.rename(bot.id, bot.name)
      return existing
    }
    const record = await this.register(bot)
    await this.store.setBot(bot.id, record)
    this.config.log('account', { bot: bot.name, botId: bot.id, userId: record.userId, localpart: record.localpart })
    return record
  }

  async register(bot) {
    const token = this.config.registrationToken
    if (token === undefined || token === '') {
      throw new Error('MATRIX_REGISTRATION_TOKEN is not set, so no Matrix account can be created for a new Bot')
    }
    const localpart = freeLocalpart(bot.name, this.store.takenLocalparts())
    const password = randomPassword()
    const anonymous = new MatrixClient({ homeserverUrl: this.config.homeserverUrl, accessToken: '', userId: '' })
    const body = {
      username: localpart,
      password,
      inhibit_login: false,
      initial_device_display_name: `DS Bot · ${bot.name}`,
      auth: { type: 'm.login.registration_token', token },
    }
    let response
    try {
      response = await anonymous.request('POST', '/register', body, { timeoutMs: 30_000 })
    } catch (error) {
      // continuwuity answers the first call with a 401 and a UIA session; the token is
      // accepted on the second call, which carries that session back.
      const session = error?.status === 401 ? error.body?.session : undefined
      if (session === undefined) throw error
      response = await anonymous.request('POST', '/register', { ...body, auth: { ...body.auth, session } }, { timeoutMs: 30_000 })
    }
    if (typeof response.access_token !== 'string' || typeof response.user_id !== 'string') {
      throw new Error(`registration of ${localpart} returned no access token`)
    }
    const record = {
      localpart,
      userId: response.user_id,
      deviceId: response.device_id,
      accessToken: response.access_token,
      password,
      name: bot.name,
      displayName: bot.name,
      createdAt: Date.now(),
    }
    // The device's crypto store is the Bot's own, never another Bot's and never another
    // bridge's (see README, E2EE step).
    mkdirSync(join(this.config.cryptoDir, bot.id), { recursive: true, mode: 0o700 })
    await this.clientFor(record).request('PUT', `/profile/${encodeURIComponent(record.userId)}/displayname`, { displayname: bot.name })
    return record
  }

  /** A Bot the user renamed shows its new name; its account id stays as it was. */
  async rename(botId, name) {
    const record = this.store.bot(botId)
    if (record === undefined || record.displayName === name) return
    const client = this.clientFor(record)
    await client.request('PUT', `/profile/${encodeURIComponent(record.userId)}/displayname`, { displayname: name })
    record.displayName = name
    record.name = name
    await this.store.setBot(botId, record)
    this.config.log('renamed', { botId, userId: record.userId, name })
  }

  /** The Bot's own nickname inside one room, so a per-room name wins over the profile. */
  async setRoomNick(botId, roomId, name) {
    const record = this.store.bot(botId)
    if (record === undefined) return
    await this.clientFor(record).request(
      'PUT',
      `/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(record.userId)}`,
      { membership: 'join', displayname: name },
    )
  }

  async join(botId, roomId) {
    const record = this.store.bot(botId)
    if (record === undefined) return
    const client = this.clientFor(record)
    try {
      await client.joinRoom(roomId)
    } catch (error) {
      // Already in the room is not an error for a mirrored Bot.
      if (error?.errcode !== 'M_BAD_STATE' && !String(error?.message ?? '').includes('already')) throw error
    }
    try { await this.setRoomNick(botId, roomId, record.displayName ?? record.name) } catch { /* nickname is cosmetic */ }
  }

  /** Forget the token of an account that no longer mirrors anything (kept for history). */
  async markLeft(botId) {
    const record = this.store.bot(botId)
    if (record === undefined) return
    record.leftAt ??= Date.now()
    await this.store.setBot(botId, record)
  }

  async leave(botId, roomId) {
    const record = this.store.bot(botId)
    if (record === undefined) return
    await this.clientFor(record).request('POST', `/rooms/${encodeURIComponent(roomId)}/leave`, {})
  }
}
