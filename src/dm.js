// Direct messages: one Matrix DM room per Bot, mirroring that Bot's own chat with the user.
//
//   room → Bot:  a message from the allowlisted user account is injected into the Bot's own
//                chat (sessionId = the Bot's id), through the same GUI API as group lines
//   Bot → room:  the Bot's chat is read from the GUI's `chat` endpoint and new user/Bot
//                items are posted into the DM room by that Bot's own account
//
// The DM record lives in state/bridge.json under the Bot's id with `dm: true`, so a restart
// reuses the room instead of making a new one.
import { MatrixClient } from './matrix.js'

export class DirectMessages {
  constructor({ store, accounts, config, injector }) {
    this.store = store
    this.accounts = accounts
    this.config = config
    this.injector = injector
    this.log = config.log
  }

  /** The DM room of one Bot, created on first sight and kept in the bridge state. */
  async ensure(bot) {
    const record = this.store.room(bot.id)
    if (record?.matrixRoomId && record.dm === true && record.goneAt === undefined) return record
    const account = this.store.bot(bot.id)
    if (account === undefined) return undefined
    const client = this.accounts.clientFor(account)
    // A DM room for this Bot may already exist (made by hand, or before the state was
    // lost). Adopt it instead of inviting the user into a second copy; the adoption starts
    // at the current chat position so the whole history is not replayed into it.
    const adopted = await this.adoptDm(bot, client)
    if (adopted !== undefined) {
      await this.store.setRoom(bot.id, adopted)
      this.log('dm-adopted', { bot: bot.name, bot_id: bot.id, room_id: adopted.matrixRoomId })
      return adopted
    }
    const invite = [this.config.userMxid].filter(Boolean)
    const created = await client.createRoom({
      name: bot.name,
      topic: `DS Bot 私聊 · ${bot.name}`,
      invite,
      encrypted: this.config.encrypted,
      powerLevels: { users: { ...(this.config.userMxid ? { [this.config.userMxid]: 100 } : {}) }, users_default: 0, events_default: 0, state_default: 50, invite: 50 },
      isDirect: true,
    })
    const next = {
      matrixRoomId: created.room_id,
      name: bot.name,
      dm: true,
      creatorBotId: bot.id,
      members: [bot.id],
      cursor: 0,
      createdAt: Date.now(),
    }
    await this.store.setRoom(bot.id, next)
    this.log('dm-created', { bot: bot.name, bot_id: bot.id, room_id: created.room_id })
    return next
  }

  async adoptDm(bot, client) {
    const taken = new Set(Object.values(this.store.rooms()).map(record => record.matrixRoomId).filter(Boolean))
    let joined = []
    try {
      joined = (await client.request('GET', '/joined_rooms')).joined_rooms ?? []
    } catch {
      return undefined
    }
    for (const roomId of joined) {
      if (taken.has(roomId)) continue
      let name
      try {
        name = (await client.request('GET', `/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`)).name
      } catch {
        continue
      }
      if (name !== bot.name) continue
      const page = await this.chatOf(bot.id)
      const latest = (page?.items ?? []).filter(item => typeof item.seq === 'number').at(-1)?.seq ?? 0
      return {
        matrixRoomId: roomId,
        name: bot.name,
        dm: true,
        creatorBotId: bot.id,
        members: [bot.id],
        cursor: latest,
        createdAt: Date.now(),
        adopted: true,
      }
    }
    return undefined
  }

  /** Posts the Bot's new chat lines (and the user's own, when they typed in DS Bot) into the DM. */
  async forward(bot) {
    const record = this.store.room(bot.id)
    if (record?.dm !== true || record.goneAt !== undefined) return
    const account = this.store.bot(bot.id)
    if (account === undefined) return
    const page = await this.chatOf(bot.id)
    const items = (page?.items ?? []).filter(item => (item.kind === 'bot' || item.kind === 'user') && typeof item.seq === 'number')
    let last = record.cursor ?? 0
    const fresh = items.filter(item => item.seq > last)
    if (fresh.length === 0) return
    const client = this.accounts.clientFor(account)
    for (const item of fresh) {
      const text = typeof item.text === 'string' ? item.text : ''
      if (text.trim() === '') {
        last = item.seq
        continue
      }
      // A line this bridge injected from Matrix must not travel back into the DM.
      if (item.kind === 'user' && this.config.wasInjected?.(bot.id, text)) {
        this.log('echo-skipped', { bot_id: bot.id, room_id: record.matrixRoomId, seq: item.seq })
        last = item.seq
        continue
      }
      try {
        await client.sendMessage(record.matrixRoomId, `dsbot.dm.${bot.id}.${item.seq}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100), {
          msgtype: 'm.text',
          body: text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (truncated by the bridge)` : text,
          'org.dsbot.bot_id': bot.id,
          'org.dsbot.dm': true,
          'org.dsbot.from_user': item.kind === 'user',
        })
        last = item.seq
        record.cursor = last
        await this.store.setRoom(bot.id, record)
        this.log('dm-sent', { bot_id: bot.id, room_id: record.matrixRoomId, seq: item.seq, from_user: item.kind === 'user' })
      } catch (error) {
        this.log('dm-send-failed', { bot_id: bot.id, room_id: record.matrixRoomId, seq: item.seq, message: error?.message ?? String(error), errcode: error?.errcode })
        return
      }
    }
  }

  /** The Bot's own chat, as the GUI shows it. */
  async chatOf(botId) {
    try {
      const response = await this.injector.call({ endpoint: 'chat', payload: { botId } })
      if (response.status !== 200) return undefined
      const parsed = JSON.parse(response.text)
      return parsed?.ok === true ? parsed.value : undefined
    } catch {
      return undefined
    }
  }
}

export { MatrixClient }
