// The bridge loop. Every tick reads the DS Bot team file, makes Matrix match it (an
// account per Bot, a room per group, membership of the room's members), then mirrors
// every group line the room has not seen yet. The team file is only ever read.
//
// Reliability shape: the cursor advances only after the homeserver acknowledged the
// event, and every send carries a deterministic transaction id, so a retry after a lost
// response (or a restart mid-send) cannot post the same line twice.
import { fullLineText, isEventLine, readTeam } from './dsbot.js'
import { Accounts } from './accounts.js'
import { BridgeStore } from './store.js'
import { renderEventLine, renderLine } from './format.js'
import { DirectMessages } from './dm.js'

// A sync that only completes the account's view: no timeline, no state.
const ADOPT_SYNC_FILTER = JSON.stringify({
  room: { timeline: { limit: 0 }, state: { limit: 0 }, ephemeral: { types: [] }, account_data: { types: [] } },
  presence: { types: [] },
  account_data: { types: [] },
})

const TOPIC_MAX = 900
/** The group's own description, as the room topic. Host → Matrix only. */
const topicOf = room => {
  const notice = typeof room?.notice === 'string' ? room.notice.trim() : ''
  if (notice === '') return ''
  return notice.length > TOPIC_MAX ? `${notice.slice(0, TOPIC_MAX)}…` : notice
}

const txnIdOf = (roomId, seq) => `dsbot.${roomId}.${seq}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)

export class Bridge {
  constructor(config) {
    this.config = config
    this.log = config.log
    this.store = new BridgeStore(config.statePath, config.accountsPath)
    this.accounts = new Accounts({ store: this.store, config })
    this.running = false
    this.again = false
    this.sent = 0
    // Texts the receive side just injected as the user, so the forward side does not send
    // them straight back to Matrix as a Bot message ("回声").
    this.injected = new Map()
    // Direct messages: one DM room per Bot, mirroring that Bot's own chat.
    this.dm = new DirectMessages({
      store: this.store,
      accounts: this.accounts,
      config: { ...config, wasInjected: (id, text) => this.wasInjected(id, text) },
      injector: config.injector,
    })
  }

  /** Called by the receive side after a Matrix line became a user message in the group. */
  noteInjected(groupId, text) {
    const normalized = String(text).replace(/\s+/g, ' ').trim()
    if (normalized === '') return
    this.injected.set(`${groupId}\u0000${normalized}`, Date.now())
    // Only the last few minutes matter; anything older is a genuinely new message.
    const cutoff = Date.now() - 10 * 60_000
    for (const [key, at] of this.injected) if (at < cutoff) this.injected.delete(key)
  }

  wasInjected(groupId, text) {
    const normalized = String(text).replace(/\s+/g, ' ').trim()
    const at = this.injected.get(`${groupId}\u0000${normalized}`)
    return at !== undefined && Date.now() - at < 10 * 60_000
  }

  // One pass at a time; a trigger that lands during a pass runs once more at the end.
  tick() {
    if (this.running) {
      this.again = true
      return this.current
    }
    this.running = true
    this.current = this.pass()
      .catch(error => this.log('error', { message: error?.message ?? String(error), stack: error?.stack }))
      .finally(() => {
        this.running = false
        if (this.again) {
          this.again = false
          void this.tick()
        }
      })
    return this.current
  }

  async pass() {
    const team = await readTeam(this.config.teamStatePath)
    await this.reconcileAccounts(team)
    const live = await this.reconcileRooms(team)
    for (const room of live) await this.forward(room, team)
    // Direct messages travel the other way: one DM room per Bot, fed from its own chat.
    if (this.dm.injector !== undefined) {
      for (const bot of Object.values(team.bots)) {
        if (!bot?.id) continue
        try {
          await this.dm.ensure(bot)
          await this.dm.forward(bot)
        } catch (error) {
          this.log('dm-failed', { bot: bot.name, bot_id: bot.id, message: error?.message ?? String(error), errcode: error?.errcode })
        }
      }
    }
    // The token-free account inventory 验收 checks senders against.
    this.store.publishAccounts(this.config.cryptoDir)
  }

  // --- accounts ---------------------------------------------------------------

  async reconcileAccounts(team) {
    for (const bot of Object.values(team.bots)) {
      if (!bot?.id) continue
      try {
        await this.accounts.ensure(bot)
      } catch (error) {
        this.log('account-failed', { group_id: null, bot: bot.name, bot_id: bot.id, message: error?.message ?? String(error), errcode: error?.errcode })
      }
    }
  }

  // --- rooms ------------------------------------------------------------------

  async reconcileRooms(team) {
    const live = []
    for (const room of Object.values(team.rooms)) {
      if (!room?.id) continue
      live.push(room)
      try {
        await this.ensureRoom(room, team)
      } catch (error) {
        this.log('room-failed', { group_id: room.id, group: room.name, message: error?.message ?? String(error), errcode: error?.errcode })
      }
    }
    await this.retireGoneRooms(team, new Set(live.map(room => room.id)))
    return live
  }

  membersOf(room, team) {
    return (room.members ?? []).filter(botId => team.bots[botId] !== undefined)
  }

  async ensureRoom(room, team) {
    const members = this.membersOf(room, team)
    const record = this.store.room(room.id)
    if (record?.matrixRoomId && record.goneAt === undefined) {
      if (record.name !== room.name) await this.renameRoom(room.id, record, room.name)
      await this.syncTopic(room.id, record, room)
      await this.ensureMembers(room.id, record, members)
      await this.syncRoomAvatar(room.id, record, record.creatorBotId)
      return record
    }
    // A group that comes back after being deleted (same id is unlikely) or that the
    // bridge saw before its Matrix room existed gets a fresh room.
    const creatorId = members.includes(room.admin) ? room.admin : members[0]
    if (creatorId === undefined) {
      this.log('room-skipped', { group_id: room.id, group: room.name, reason: 'the group has no Bot member left' })
      return undefined
    }
    const creator = this.store.bot(creatorId)
    if (creator === undefined) return undefined
    // Before making a room, check whether one of our accounts is already in a room with
    // this group's name: after a lost state file, adopting beats creating a duplicate.
    const adoption = await this.adoptExistingRoom(room, members)
    if (adoption.unavailable !== undefined) {
      // Without a trustworthy joined-room list, creating now would duplicate a room that
      // already exists (and lose the messages written while the duplicate was made). The
      // next tick tries again.
      this.log('room-create-deferred', { group_id: room.id, group: room.name, reason: adoption.unavailable })
      return undefined
    }
    if (adoption.room !== undefined) {
      const adopted = adoption.room
      await this.store.setRoom(room.id, adopted)
      this.log('room-adopted', { group_id: room.id, group: room.name, room_id: adopted.matrixRoomId })
      await this.ensureMembers(room.id, adopted, members)
      return adopted
    }
    const client = this.accounts.clientFor(creator)
    const others = members.filter(botId => botId !== creatorId)
    const invite = [...new Set([
      this.config.userMxid,
      ...(this.config.extraInvites ?? []),
      ...others.map(botId => this.store.bot(botId)?.userId),
    ].filter(Boolean))]
    const created = await client.createRoom({
      name: room.name,
      ...(topicOf(room) === '' ? {} : { topic: topicOf(room) }),
      invite,
      encrypted: this.config.encrypted,
      powerLevels: this.powerLevelsFor(creatorId, members, creator.userId),
    })
    // A room its creator cannot administer is not a usable room. The map cannot tell us
    // (the creator is implicit), so probe the permission instead: writing the very levels
    // it already has must be allowed for the creator.
    const levels = await client.request('GET', `/rooms/${encodeURIComponent(created.room_id)}/state/m.room.power_levels/`).catch(() => undefined)
    try {
      await client.request('PUT', `/rooms/${encodeURIComponent(created.room_id)}/state/m.room.power_levels/`, levels ?? {}, { timeoutMs: 20_000 })
    } catch (error) {
      this.log('power-levels-unverified', {
        group_id: room.id,
        group: room.name,
        room_id: created.room_id,
        creator: creator.userId,
        status: error?.status,
        errcode: error?.errcode,
        users: levels?.users ?? null,
      })
      throw new Error(`the new room ${created.room_id} is not administrable by its creator ${creator.userId}: ${error?.message ?? error}`)
    }
    if (record?.matrixRoomId && record.matrixRoomId !== created.room_id) {
      // The group came back (or the room had to be rebuilt): migrate the old room instead
      // of abandoning it, so the user's client follows the pointer.
      await this.upgradeRoom(record.matrixRoomId, created.room_id, record.members ?? members)
    }
    const next = {
      matrixRoomId: created.room_id,
      name: room.name,
      kind: 'group',
      creatorBotId: creatorId,
      members,
      cursor: 0,
      createdAt: Date.now(),
    }
    await this.store.setRoom(room.id, next)
    this.log('room-created', { group_id: room.id, group: room.name, room_id: created.room_id, creator: creator.userId, encrypted: this.config.encrypted })
    await this.setPowerLevels(client, next, members)
    await this.syncRoomAvatar(room.id, next, creatorId)
    for (const botId of others) {
      try {
        await this.accounts.join(botId, next.matrixRoomId)
      } catch (error) {
        this.log('join-failed', { group_id: room.id, room_id: next.matrixRoomId, bot_id: botId, message: error?.message ?? String(error), errcode: error?.errcode })
      }
      await this.inviteUser(botId, room.id, next.matrixRoomId)
    }
    return next
  }

  // The user gets 100, the room's creator Bot 100, every other member Bot 50. The creator
  // has to be in the map: continuwuity does not give the creator 100 implicitly once an
  // explicit `users` map is set, so leaving it out leaves the room unadministrable (avatar,
  // name, E2EE state would all be 403 for the very account that made the room).
  powerLevelsFor(creatorId, members, creatorUserId) {
    return {
      users: this.powerUsers(creatorId, members, creatorUserId),
      users_default: 0,
      events_default: 0,
      state_default: 50,
      invite: 50,
      kick: 50,
      ban: 50,
      redact: 50,
    }
  }

  // The creator is left out on purpose (see matrix.js): the homeserver gives it 100
  // implicitly, and naming it in a later power_levels event is refused with 403.
  //
  // `creatorUserId` is the id the creating account actually has; the store lookup is only a
  // fallback, because at creation time the account record may not be written yet.
  powerUsers(creatorId, members, creatorUserId) {
    const users = {}
    if (this.config.userMxid) users[this.config.userMxid] = 100
    const creator = creatorUserId ?? this.store.bot(creatorId)?.userId
    for (const botId of members) {
      const userId = this.store.bot(botId)?.userId
      if (userId && userId !== creator) users[userId] = 50
    }
    return users
  }

  // The room looks like the Bot that leads it: the same picture the Bot shows in its own
  // account, so a group is recognisable in the room list without opening it.
  async syncRoomAvatar(groupId, record, creatorBotId) {
    if (record?.matrixRoomId === undefined || creatorBotId === undefined) return
    const creator = this.store.bot(creatorBotId)
    if (creator?.avatarMxc === undefined) return
    if (record.avatarMxc === creator.avatarMxc) return
    try {
      await this.sendState(record, '/state/m.room.avatar/', { url: creator.avatarMxc })
      record.avatarMxc = creator.avatarMxc
      await this.store.setRoom(groupId, record)
      this.log('room-avatar', { room_id: record.matrixRoomId, mxc: creator.avatarMxc })
    } catch (error) {
      this.log('room-avatar-failed', { room_id: record.matrixRoomId, message: error?.message ?? String(error) })
    }
  }

  // Sending room state needs power 50. The creator Bot should have it, but a room made
  // before that was fixed can leave the creator at 0 while another member holds 50, so try
  // the creator first and then every other member; the one that worked is remembered.
  stateCandidates(record) {
    const ids = [record.stateBotId, record.creatorBotId, ...(record.members ?? [])]
      .filter((id, index, all) => id !== undefined && all.indexOf(id) === index)
    return ids.map(botId => ({ botId, record: this.store.bot(botId) })).filter(entry => entry.record?.accessToken !== undefined)
  }

  async sendState(record, path, body) {
    let last
    for (const { botId, record: account } of this.stateCandidates(record)) {
      try {
        await this.accounts.clientFor(account).request('PUT', `/rooms/${encodeURIComponent(record.matrixRoomId)}${path}`, body)
        if (record.stateBotId !== botId) {
          record.stateBotId = botId
          const groupId = Object.keys(this.store.rooms()).find(key => this.store.room(key) === record)
          if (groupId !== undefined) await this.store.setRoom(groupId, record)
        }
        return { botId, account }
      } catch (error) {
        last = error
        if (error?.status !== 403 && error?.errcode !== 'M_FORBIDDEN') throw error
      }
    }
    throw last ?? new Error('no Bot account in the room can send state')
  }

  // Finds a room one of the member accounts already joined whose name matches the group.
  // The adoption starts at the current sequence, so old lines are not re-posted.
  //
  // Returns {room} when a match is found, {} when the accounts are definitely in no such
  // room, and {unavailable} when the joined list cannot be trusted: a fresh account that
  // has not synced yet answers /joined_rooms with nothing, and creating on that answer is
  // how a restart rebuilds a room that already exists. So each account syncs once before it
  // is asked, and a failed sync means "cannot tell", never "no room".
  async adoptExistingRoom(room, members) {
    const mapped = new Set(Object.values(this.store.rooms()).map(record => record.matrixRoomId))
    let asked = 0
    let failed = undefined
    for (const botId of members) {
      const client = this.accounts.clientOf(botId)
      if (client === undefined) continue
      try {
        // The initial sync is what makes the account's room list complete; nothing from it
        // is used here beyond that.
        await client.request('GET', '/sync', undefined, {
          query: { filter: ADOPT_SYNC_FILTER, timeout: 0 },
          timeoutMs: 20_000,
        })
      } catch (error) {
        failed = error?.message ?? String(error)
        this.log('adopt-sync-failed', { group_id: room.id, room: room.name, bot_id: botId, message: failed })
        continue
      }
      let joined
      try {
        joined = (await client.request('GET', '/joined_rooms')).joined_rooms
      } catch (error) {
        failed = error?.message ?? String(error)
        this.log('adopt-joined-failed', { group_id: room.id, room: room.name, bot_id: botId, message: failed })
        continue
      }
      if (!Array.isArray(joined)) {
        failed = '/joined_rooms returned no list'
        this.log('adopt-joined-failed', { group_id: room.id, room: room.name, bot_id: botId, message: failed })
        continue
      }
      asked += 1
      for (const matrixRoomId of joined) {
        if (mapped.has(matrixRoomId)) continue
        let name
        try {
          name = (await client.request('GET', `/rooms/${encodeURIComponent(matrixRoomId)}/state/m.room.name/`)).name
        } catch {
          continue
        }
        if (name !== room.name) continue
        return {
          room: {
            matrixRoomId,
            name: room.name,
            creatorBotId: botId,
            members,
            cursor: typeof room.seq === 'number' ? room.seq : 0,
            createdAt: Date.now(),
            adopted: true,
          },
        }
      }
    }
    if (asked === 0) return { unavailable: failed ?? 'no member account could list its rooms' }
    return {}
  }

  async setPowerLevels(client, record, members) {
    const users = this.powerUsers(record.creatorBotId, members)
    try {
      await this.sendState(record, '/state/m.room.power_levels/', {
        users,
        users_default: 0,
        events_default: 0,
        state_default: 50,
        invite: 50,
        kick: 50,
        ban: 50,
        redact: 50,
      })
    } catch (error) {
      this.log('power-levels-failed', { room_id: record.matrixRoomId, message: error?.message ?? String(error) })
    }
  }

  // A Bot that joined the group after its Matrix room was made gets an invite and a join.
  // A Bot that left the group keeps its Matrix membership: the history stays its own.
  async ensureMembers(roomId, record, members) {
    const known = new Set(record.members ?? [])
    const added = members.filter(botId => !known.has(botId))
    if (added.length === 0) return
    const creator = this.store.bot(record.creatorBotId)
    const creatorClient = creator === undefined ? undefined : this.accounts.clientFor(creator)
    for (const botId of added) {
      const account = this.store.bot(botId)
      if (account === undefined || creatorClient === undefined) continue
      try {
        await creatorClient.invite(record.matrixRoomId, account.userId)
      } catch (error) {
        if (error?.errcode !== 'M_FORBIDDEN') this.log('invite-failed', { group_id: roomId, room_id: record.matrixRoomId, bot_id: botId, message: error?.message ?? String(error) })
      }
      try {
        await this.accounts.join(botId, record.matrixRoomId)
      } catch (error) {
        this.log('join-failed', { group_id: roomId, room_id: record.matrixRoomId, bot_id: botId, message: error?.message ?? String(error) })
      }
      await this.inviteUser(botId, roomId, record.matrixRoomId)
    }
    record.members = members
    await this.store.setRoom(roomId, record)
  }

  // Matrix's own migration semantics: m.room.tombstone in the old room names the
  // replacement, clients then show "this room has been upgraded → open the new one".
  // Each Bot that is still in the old room posts it (the room's creator first) and leaves.
  async upgradeRoom(oldRoomId, newRoomId, botIds, note) {
    if (!oldRoomId || !newRoomId || oldRoomId === newRoomId) return
    const body = note ?? '这个群对应的房间已重建，请到新房间继续。'
    const creator = Object.values(this.store.rooms()).find(room => room.matrixRoomId === oldRoomId)?.creatorBotId
    const ordered = [...new Set([creator, ...botIds].filter(Boolean))]
    for (const botId of ordered) {
      const account = this.store.bot(botId)
      if (account === undefined) continue
      const client = this.accounts.clientFor(account)
      try {
        await client.request('PUT', `/rooms/${encodeURIComponent(oldRoomId)}/state/m.room.tombstone/`, {
          body,
          replacement_room: newRoomId,
        })
        this.log('room-upgraded', { old_room_id: oldRoomId, new_room_id: newRoomId, by: account.userId })
      } catch (error) {
        this.log('room-upgrade-failed', { old_room_id: oldRoomId, new_room_id: newRoomId, by: account.userId, message: error?.message ?? String(error), errcode: error?.errcode })
        continue
      }
      try {
        await this.accounts.leave(botId, oldRoomId)
      } catch (error) {
        this.log('leave-failed', { room_id: oldRoomId, bot_id: botId, message: error?.message ?? String(error) })
      }
    }
  }

  // The group description in DS Bot is the room topic in Matrix. It is compared on every
  // pass like the name, so an edit lands within a tick; Matrix edits are overwritten on
  // purpose, because the group chat is the source of truth.
  async syncTopic(roomId, record, room) {
    const topic = topicOf(room)
    if (record.topic === topic) return
    if (topic === '' && record.topic === undefined) return
    const creator = this.store.bot(record.creatorBotId)
    if (creator === undefined) return
    try {
      await this.accounts.clientFor(creator).setRoomTopic(record.matrixRoomId, topic)
      record.topic = topic
      await this.store.setRoom(roomId, record)
      this.log('room-topic', { group_id: roomId, room_id: record.matrixRoomId, length: topic.length })
    } catch (error) {
      this.log('room-topic-failed', { group_id: roomId, room_id: record.matrixRoomId, message: error?.message ?? String(error), errcode: error?.errcode })
    }
  }

  async renameRoom(roomId, record, name) {
    const creator = this.store.bot(record.creatorBotId)
    if (creator === undefined) return
    try {
      await this.accounts.clientFor(creator).setRoomName(record.matrixRoomId, name)
      record.name = name
      await this.store.setRoom(roomId, record)
      this.log('room-renamed', { group_id: roomId, room_id: record.matrixRoomId, name })
    } catch (error) {
      this.log('room-rename-failed', { group_id: roomId, room_id: record.matrixRoomId, message: error?.message ?? String(error) })
    }
  }

  // The group is gone from DS Bot: the room is told once and then left alone, so its
  // history stays readable and the bridge simply stops writing to it.
  async retireGoneRooms(team, liveIds) {
    for (const [roomId, record] of Object.entries(this.store.rooms())) {
      // A DM is not a group: it lives while its Bot does, and is never retired here.
      if (record.dm === true) continue
      if (liveIds.has(roomId) || record.retired === true) continue
      record.goneAt ??= Date.now()
      if (record.goneLogged !== true) {
        record.goneLogged = true
        this.log('room-gone', { group_id: roomId, room_id: record.matrixRoomId, name: record.name })
      }
      const creator = this.store.bot(record.creatorBotId)
      if (this.config.onGroupDeleted !== 'ignore' && record.noticeSent !== true && creator !== undefined) {
        try {
          await this.accounts.clientFor(creator).sendMessage(record.matrixRoomId, `dsbot-gone-${record.goneAt}`, {
            msgtype: 'm.notice',
            body: `群聊「${record.name}」已在 DS Bot 中删除，这个房间不再接收新消息。`,
          })
          record.noticeSent = true
        } catch (error) {
          this.log('room-gone-notice-failed', { group_id: roomId, room_id: record.matrixRoomId, message: error?.message ?? String(error) })
        }
      }
      // Each Bot steps out, so a deleted group holds no seat in the room; the history stays
      // readable for the user.
      for (const botId of record.members ?? []) {
        if (this.store.bot(botId) === undefined) continue
        try {
          await this.accounts.leave(botId, record.matrixRoomId)
        } catch (error) {
          this.log('room-gone-leave-failed', { group_id: roomId, room_id: record.matrixRoomId, bot_id: botId, message: error?.message ?? String(error) })
        }
      }
      record.retired = true
      await this.store.setRoom(roomId, record)
    }
  }

  // --- forwarding -------------------------------------------------------------

  async forward(room, team) {
    const record = this.store.room(room.id)
    if (record?.matrixRoomId === undefined || record.goneAt !== undefined) return
    if (typeof room.seq !== 'number') return
    let cursor = record.cursor ?? 0
    const seqs = (room.log ?? []).map(line => line.seq).filter(seq => typeof seq === 'number')
    if (seqs.length === 0) return
    const oldest = Math.min(...seqs)
    // The team file keeps the latest lines only. If it dropped lines the bridge never
    // sent, jump forward and say so instead of waiting for them forever.
    if (cursor < oldest - 1) {
      this.log('gap', { group_id: room.id, group: room.name, from: cursor + 1, to: oldest - 1, reason: 'lines were dropped from the team file before the bridge sent them' })
      cursor = oldest - 1
      record.cursor = cursor
      await this.store.setRoom(room.id, record)
    }
    for (const line of (room.log ?? [])) {
      if (typeof line.seq !== 'number' || line.seq <= cursor) continue
      // A line this bridge itself injected came from Matrix; sending it back would show
      // every user message twice. The user's own copy is already in the room.
      if (line.botId === undefined && this.wasInjected(room.id, await fullLineText(this.config.home, room.id, line))) {
        this.log('echo-skipped', { group_id: room.id, room_id: record.matrixRoomId, seq: line.seq })
        cursor = line.seq
        record.cursor = cursor
        await this.store.setRoom(room.id, record)
        continue
      }
      // Already mirrored on an earlier run (dedupe table, e.g. after restoring a backup
      // of the state): skip it rather than trust the cursor alone.
      if (record.recent?.[String(line.seq)] !== undefined) {
        cursor = line.seq
        record.cursor = cursor
        await this.store.setRoom(room.id, record)
        continue
      }
      const sent = await this.sendLine(room, record, line, team)
      if (sent === undefined) return
      cursor = line.seq
    }
  }

  /** Sends one line; returns the send report, or undefined when it must be retried. */
  async sendLine(room, record, line, team) {
    const client = this.senderFor(room, line)
    if (client === undefined) {
      this.log('send-skipped', { group_id: room.id, room_id: record.matrixRoomId, seq: line.seq, reason: 'no Matrix account can send this line' })
      return undefined
    }
    const content = isEventLine(line)
      ? renderEventLine({ room, line, config: this.config })
      : renderLine({ room, line, text: await fullLineText(this.config.home, room.id, line), config: this.config })
    const txnId = txnIdOf(room.id, line.seq)
    // A send that was in flight when the process died is picked up again with the same
    // transaction id: the homeserver returns the event it already made, so nothing is
    // posted twice.
    const recovering = record.pending?.seq === line.seq && record.pending?.txn === txnId
    record.pending = { seq: line.seq, txn: txnId, at: Date.now() }
    await this.store.setRoom(room.id, record)
    const tSent = Date.now()
    try {
      const response = await client.sendMessage(record.matrixRoomId, txnId, content)
      const tAck = Date.now()
      this.sent += 1
      record.cursor = line.seq
      delete record.pending
      record.recent ??= {}
      record.recent[String(line.seq)] = response.event_id ?? null
      // The bridge's own event is known before /sync ever sees it: remembering it as handled
      // saves one echo round per message (a `sent` plus an `ignored-sender` otherwise).
      if (typeof response.event_id === 'string') {
        record.handled = [...(record.handled ?? []), response.event_id].filter(Boolean).slice(-300)
      }
      const keep = Object.keys(record.recent)
      for (const key of keep.slice(0, Math.max(0, keep.length - 50))) delete record.recent[key]
      await this.store.setRoom(room.id, record)
      this.log(recovering ? 'resent' : 'sent', {
        recovered: recovering,
        group_id: room.id,
        room_id: record.matrixRoomId,
        seq: line.seq,
        event_id: response.event_id ?? null,
        who: content.displayname,
        from_user: line.botId === undefined,
        t_recv_ds: Math.round(team.mtimeMs),
        t_sent_mx: tSent,
        t_ack_mx: tAck,
        latency_ms: tAck - Math.round(team.mtimeMs),
      })
      return response
    } catch (error) {
      this.log('send-failed', {
        group_id: room.id,
        room_id: record.matrixRoomId,
        seq: line.seq,
        t_recv_ds: Math.round(team.mtimeMs),
        t_sent_mx: tSent,
        message: error?.message ?? String(error),
        errcode: error?.errcode,
        status: error?.status,
      })
      return undefined
    }
  }

  // Each Bot that joins a room invites the user too, so the invite shows up even if the
  // user was not around when the room was made. A failed invite is retried with backoff
  // and logged: silently swallowing it makes "we never added you" impossible to debug.
  async inviteUser(botId, groupId, roomId) {
    const userMxid = this.config.userMxid
    if (!userMxid) return
    const record = this.store.room(groupId)
    const key = `${botId}:${userMxid}`
    const previous = record?.invites?.[key]
    if (previous?.nextAt !== undefined && Date.now() < previous.nextAt) return
    const client = this.accounts.clientOf(botId)
    if (client === undefined) return
    try {
      await client.invite(roomId, userMxid)
      if (previous !== undefined && record !== undefined) {
        delete record.invites[key]
        await this.store.setRoom(groupId, record)
      }
      this.log('invited', { group_id: groupId, room_id: roomId, bot_id: botId, user: userMxid })
    } catch (error) {
      const message = error?.message ?? String(error)
      // Already in the room is the normal case on every pass after the first.
      if (/already in the room|already a member/i.test(message) || error?.errcode === 'M_BAD_STATE') {
        if (previous !== undefined && record !== undefined) {
          delete record.invites[key]
          await this.store.setRoom(groupId, record)
        }
        return
      }
      const attempts = (previous?.attempts ?? 0) + 1
      const nextAt = Date.now() + Math.min(120_000, 5_000 * 2 ** Math.min(attempts, 5))
      if (record !== undefined) {
        record.invites ??= {}
        record.invites[key] = { attempts, nextAt, error: error?.errcode ?? message.slice(0, 120) }
        await this.store.setRoom(groupId, record)
      }
      this.log('invite-user-failed', { group_id: groupId, room_id: roomId, bot_id: botId, attempts, next_at: nextAt, errcode: error?.errcode, status: error?.status, message })
    }
  }

  // The Bot that wrote the line sends it. A line the user wrote in the group has no Bot
  // of its own, so the room's creator (or any member) relays it, labelled as the user.
  senderFor(room, line) {
    if (line.botId !== undefined && this.store.bot(line.botId) !== undefined) return this.accounts.clientOf(line.botId)
    const creatorId = this.store.room(room.id)?.creatorBotId
    if (creatorId !== undefined && this.store.bot(creatorId) !== undefined) return this.accounts.clientOf(creatorId)
    const fallback = (room.members ?? []).find(botId => this.store.bot(botId) !== undefined)
    return fallback === undefined ? undefined : this.accounts.clientOf(fallback)
  }
}
