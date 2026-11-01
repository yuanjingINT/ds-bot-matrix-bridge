// The bridge's own saved state: which Matrix account each Bot got, which Matrix room
// each group maps to, and how far each room has been mirrored. It holds access tokens,
// so the file is written 0600 and never leaves the machine.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

const EMPTY = {
  version: 1,
  // botId → { localpart, userId, deviceId, accessToken, password, name, displayName, createdAt, leftAt? }
  bots: {},
  // dsBot room id → { matrixRoomId, name, creatorBotId, members, cursor, goneAt? }
  rooms: {},
}

export class BridgeStore {
  constructor(path, accountsPath) {
    this.path = path
    // A token-free view of the accounts, for checking which Bot sent what. No secrets.
    this.accountsPath = accountsPath ?? `${path.replace(/\.json$/, '')}.accounts.json`
    this.data = undefined
    this.writing = Promise.resolve()
  }

  /** Writes the public inventory: names, user ids, device ids, crypto store paths only. */
  publishAccounts(cryptoDir) {
    const data = this.load()
    const bots = {}
    for (const [botId, record] of Object.entries(data.bots)) {
      bots[botId] = {
        name: record.name ?? record.displayName ?? '',
        localpart: record.localpart ?? '',
        userId: record.userId ?? '',
        deviceId: record.deviceId ?? '',
        cryptoStore: cryptoDir === undefined ? undefined : `${cryptoDir}/${botId}`,
        createdAt: record.createdAt ?? null,
        leftAt: record.leftAt ?? null,
        rooms: Object.fromEntries(
          Object.entries(data.rooms)
            .filter(([, room]) => (room.members ?? []).includes(botId))
            .map(([roomId, room]) => [roomId, room.matrixRoomId ?? null]),
        ),
      }
    }
    const snapshot = JSON.stringify({ updatedAt: new Date().toISOString(), bots }, null, 1)
    mkdirSync(dirname(this.accountsPath), { recursive: true })
    writeFileSync(this.accountsPath, snapshot, { mode: 0o644 })
    return this.accountsPath
  }

  load() {
    if (this.data !== undefined) return this.data
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`cannot read ${this.path}: ${error.message}`)
      // Missing or unreadable state: take the backup rather than rebuilding every room.
      try {
        parsed = JSON.parse(readFileSync(`${this.path}.bak`, 'utf8'))
      } catch {
        parsed = undefined
      }
    }
    this.data = {
      ...JSON.parse(JSON.stringify(EMPTY)),
      ...(parsed ?? {}),
    }
    this.data.bots ??= {}
    this.data.rooms ??= {}
    // Older builds kept the account password here. The access token is enough to act as
    // the Bot, so the password is dropped on load and never comes back.
    for (const record of Object.values(this.data.bots)) delete record.password
    return this.data
  }

  // Every mutation goes through save(), which writes the whole file atomically: a crash
  // leaves either the old state or the new one, so a cursor never points past a message
  // that was not sent.
  // fsync both the file and its directory: a cursor that survived a power cut must never
  // point behind an event the homeserver already accepted, and must never point past one
  // it did not.
  save() {
    const snapshot = JSON.stringify(this.data, null, 1)
    const run = this.writing.then(async () => {
      mkdirSync(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      const handle = await open(temp, 'w', 0o600)
      try {
        await handle.writeFile(snapshot)
        await handle.sync()
      } finally {
        await handle.close()
      }
      chmodSync(temp, 0o600)
      await rename(temp, this.path)
      // A second copy: losing bridge.json must never mean "no rooms exist, create new
      // ones". load() restores from it instead of starting empty.
      try { copyFileSync(this.path, `${this.path}.bak`) } catch { /* backup is best effort */ }
      try {
        const dir = await open(dirname(this.path), 'r')
        try { await dir.sync() } finally { await dir.close() }
      } catch { /* some filesystems refuse a directory fsync; the file sync already ran */ }
    })
    this.writing = run.catch(() => {})
    return run
  }

  bots() {
    return this.load().bots
  }

  rooms() {
    return this.load().rooms
  }

  bot(botId) {
    return this.load().bots[botId]
  }

  setBot(botId, record) {
    this.load().bots[botId] = record
    return this.save()
  }

  room(roomId) {
    return this.load().rooms[roomId]
  }

  setRoom(roomId, record) {
    this.load().rooms[roomId] = record
    return this.save()
  }

  // User ids already claimed, so a new Bot never takes another one's account.
  takenLocalparts() {
    return new Set(Object.values(this.load().bots).map(bot => bot.localpart).filter(Boolean))
  }

  userIds() {
    return new Set(Object.values(this.load().bots).map(bot => bot.userId).filter(Boolean))
  }
}

export { EMPTY }
