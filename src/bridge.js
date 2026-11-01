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
      await this.ensureMembers(room.id, record, members)
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
    const client = this.accounts.clientFor(creator)
    const others = members.filter(botId => botId !== creatorId)
    const invite = [...new Set([
      this.config.userMxid,
      ...(this.config.extraInvites ?? []),
      ...others.map(botId => this.store.bot(botId)?.userId),
    ].filter(Boolean))]
    const created = await client.createRoom({
      name: room.name,
      topic: `DS Bot 群聊 · ${room.name}`,
      invite,
      encrypted: this.config.encrypted,
      powerLevels: this.powerLevelsFor(creatorId, members),
    })
    const next = {
      matrixRoomId: created.room_id,
      name: room.name,
      creatorBotId: creatorId,
      members,
      cursor: 0,
      createdAt: Date.now(),
    }
    await this.store.setRoom(room.id, next)
    this.log('room-created', { group_id: room.id, group: room.name, room_id: created.room_id, creator: creator.userId, encrypted: this.config.encrypted })
    await this.setPowerLevels(client, next, members)
    for (const botId of others) {
      try {
        await this.accounts.join(botId, next.matrixRoomId)
      } catch (error) {
        this.log('join-failed', { group_id: room.id, room_id: next.matrixRoomId, bot_id: botId, message: error?.message ?? String(error), errcode: error?.errcode })
      }
      await this.inviteUser(botId, next.matrixRoomId)
    }
    return next
  }

  // The user gets 100, every member Bot 50. The room's creator is left out on purpose:
  // Matrix gives the creator 100 implicitly, and listing it (especially at 50) makes the
  // roomserver refuse the whole event with 403, leaving the room unadministrable.
  powerLevelsFor(creatorId, members) {
    const users = {}
    if (this.config.userMxid) users[this.config.userMxid] = 100
    const creator = this.store.bot(creatorId)?.userId
    for (const botId of members) {
      const userId = this.store.bot(botId)?.userId
      if (userId && userId !== creator) users[userId] = 50
    }
    return { users, users_default: 0, events_default: 0, state_default: 50, invite: 50, kick: 50, ban: 50, redact: 50 }
  }

  async setPowerLevels(client, record, members) {
    const users = {}
    if (this.config.userMxid) users[this.config.userMxid] = 100
    const creator = this.store.bot(record.creatorBotId)?.userId
    for (const botId of members) {
      const userId = this.store.bot(botId)?.userId
      if (userId && userId !== creator) users[userId] = 50
    }
    try {
      await client.request('PUT', `/rooms/${encodeURIComponent(record.matrixRoomId)}/state/m.room.power_levels/`, {
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
      await this.inviteUser(botId, record.matrixRoomId)
    }
    record.members = members
    await this.store.setRoom(roomId, record)
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
      if (liveIds.has(roomId) || record.goneAt !== undefined) continue
      record.goneAt = Date.now()
      await this.store.setRoom(roomId, record)
      this.log('room-gone', { group_id: roomId, room_id: record.matrixRoomId, name: record.name })
      if (this.config.onGroupDeleted === 'ignore') continue
      const creator = this.store.bot(record.creatorBotId)
      if (creator === undefined) continue
      try {
        await this.accounts.clientFor(creator).sendMessage(record.matrixRoomId, `dsbot-gone-${record.goneAt}`, {
          msgtype: 'm.notice',
          body: `群聊「${record.name}」已在 DS Bot 中删除，这个房间不再接收新消息。`,
        })
      } catch (error) {
        this.log('room-gone-notice-failed', { group_id: roomId, room_id: record.matrixRoomId, message: error?.message ?? String(error) })
      }
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
  // user was not around when the room was made. Joining an existing room is a no-op.
  async inviteUser(botId, roomId) {
    const userMxid = this.config.userMxid
    if (!userMxid) return
    const client = this.accounts.clientOf(botId)
    if (client === undefined) return
    try {
      await client.invite(roomId, userMxid)
    } catch (error) {
      if (error?.errcode !== 'M_FORBIDDEN' && error?.status !== 403) {
        this.log('invite-user-failed', { room_id: roomId, bot_id: botId, message: error?.message ?? String(error), errcode: error?.errcode })
      }
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
