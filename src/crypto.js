// End-to-end encryption, without matrix-bot-sdk.
//
// DS Bot's Matrix accounts need to read and write in encrypted rooms. matrix-bot-sdk 0.8
// cannot do the job: its RustEngine throws on SignatureUpload (so a device can never be
// verified) and it has no cross-signing API. The Rust machine underneath it, though, is
// fine. So this module borrows only the machine and drives the HTTP itself:
//
//   machine.outgoingRequests()  → we send each request to the homeserver
//   machine.encryptRoomEvent()  → we send the returned m.room.encrypted content
//   machine.decryptRoomEvent()  → the plaintext of an inbound event
//
// Request types we deliberately do not send:
//   4 SignatureUpload — would throw in bot-sdk; device signatures are uploaded by
//                       scripts/device-verify.mjs instead (our own chain of trust)
//   5 RoomMessage     — this bridge posts room messages itself
//   6 KeysBackup      — no server-side key backup: a new device means lost history, by choice
import { mkdirSync } from 'node:fs'
import {
  DeviceId, EncryptionAlgorithm, EncryptionSettings, HistoryVisibility,
  OlmMachine, RequestType, RoomId, StoreType, UserId,
} from '@matrix-org/matrix-sdk-crypto-nodejs'

export class Crypto {
  /**
   * @param {object} options
   * @param {{request:Function}} options.client the bridge's fetch client
   * @param {string} options.userId
   * @param {string} options.deviceId
   * @param {string} options.storePath directory for this device's crypto store
   * @param {string} [options.passphrase] encrypts the store file at rest
   */
  constructor({ client, userId, deviceId, storePath, passphrase, log = () => {} }) {
    this.client = client
    this.userId = userId
    this.deviceId = deviceId
    this.storePath = storePath
    this.passphrase = passphrase
    this.log = log
    this.machine = undefined
    this.pumping = undefined
  }

  async init() {
    if (this.machine !== undefined) return this.machine
    mkdirSync(this.storePath, { recursive: true, mode: 0o700 })
    // The bindings want UserId/DeviceId objects, not strings: passing strings fails with
    // "failed to create napi ref". The store path is a directory, not a file.
    this.machine = await OlmMachine.initialize(
      new UserId(this.userId),
      new DeviceId(this.deviceId),
      this.storePath,
      this.passphrase ?? undefined,
      StoreType.Sqlite,
    )
    return this.machine
  }

  /**
   * Sends everything the machine asks to send, until it asks for nothing more. Requests it
   * asks for that we do not implement are logged and dropped, never thrown.
   */
  async pump() {
    // One pump at a time: the machine may hand out the same request twice otherwise.
    if (this.pumping !== undefined) return this.pumping
    this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined })
    return this.pumping
  }

  async pumpOnce() {
    await this.init()
    let sent = 0
    for (let round = 0; round < 20; round += 1) {
      const requests = await this.machine.outgoingRequests()
      if (requests.length === 0) break
      for (const request of requests) {
        const handled = await this.send(request)
        if (handled) sent += 1
      }
    }
    return sent
  }

  /** One machine request over the client-server API. Returns true when it was sent. */
  async send(request) {
    const body = request.body === undefined ? undefined : JSON.parse(String(request.body))
    switch (request.type) {
      case RequestType.KeysUpload: {
        const answer = await this.client.request('POST', '/keys/upload', body, { timeoutMs: 30_000 })
        await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(answer))
        this.log('crypto-keys-upload', { userId: this.userId, oneTimeKeyCounts: Object.keys(answer?.one_time_key_counts ?? {}).length })
        return true
      }
      case RequestType.KeysQuery: {
        const answer = await this.client.request('POST', '/keys/query', body, { timeoutMs: 30_000 })
        await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(answer))
        this.log('crypto-keys-query', { userId: this.userId, devices: Object.values(body?.device_keys ?? {}).reduce((all, perUser) => all + Object.keys(perUser).length, 0) })
        return true
      }
      case RequestType.KeysClaim: {
        const answer = await this.client.request('POST', '/keys/claim', body, { timeoutMs: 30_000 })
        await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(answer))
        this.log('crypto-keys-claim', { userId: this.userId, users: Object.keys(body?.one_time_keys ?? {}).length })
        return true
      }
      case RequestType.ToDevice: {
        // A room key share: this is the request that makes a room readable by the others.
        await this.client.request('PUT', `/sendToDevice/${encodeURIComponent(request.event_type)}/${encodeURIComponent(request.txn_id ?? request.id)}`, body, { timeoutMs: 30_000 })
        await this.machine.markRequestAsSent(request.id, request.type, '{}')
        this.log('crypto-to-device', { userId: this.userId, event_type: request.event_type })
        return true
      }
      case RequestType.SignatureUpload:
      case RequestType.RoomMessage:
      case RequestType.KeysBackup:
        // See the header: signatures come from our own verification flow, room messages are
        // posted by the bridge, and there is no server-side key backup.
        this.log('crypto-request-skipped', { userId: this.userId, type: request.type })
        return false
      default:
        this.log('crypto-request-unknown', { userId: this.userId, type: request.type })
        return false
    }
  }

  /** Feeds the machine what /sync handed us: to-device messages and changed devices. */
  async receiveSyncChanges({ toDeviceEvents = [], changedDevices = {}, oneTimeKeyCounts = {}, unusedFallbackKeys = [] }) {
    await this.init()
    const deviceLists = {
      changed: changedDevices?.changed ?? [],
      left: changedDevices?.left ?? [],
    }
    await this.machine.receiveSyncChanges(
      JSON.stringify(toDeviceEvents),
      deviceLists,
      oneTimeKeyCounts,
      unusedFallbackKeys,
    )
  }

  /**
   * Everything the machine needs before it can encrypt in a room: the member list it
   * tracks, their device keys, and a megolm session shared with them. Without this the
   * machine panics with "Session wasn't created nor shared" — it has no recipients.
   */
  async prepareRoom(roomId) {
    await this.init()
    const response = await this.client.request('GET', `/rooms/${encodeURIComponent(roomId)}/joined_members`)
    const members = Object.keys(response?.joined ?? {}).map(userId => new UserId(userId))
    if (members.length === 0) throw new Error(`room ${roomId} has no joined members to share keys with`)
    await this.machine.updateTrackedUsers(members)
    // Their device keys must be known before a session can be shared with their devices.
    for (let round = 0; round < 3; round += 1) {
      const missing = await this.machine.getMissingSessions(members)
      if (missing === null) break
      await this.send(missing)
    }
    await this.pump()
    const settings = new EncryptionSettings()
    settings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2
    settings.historyVisibility = HistoryVisibility.Joined
    settings.rotationPeriod = BigInt(604_800_000)
    settings.rotationPeriodMessages = BigInt(100)
    const requests = await this.machine.shareRoomKey(new RoomId(roomId), members, settings)
    for (const request of requests) {
      // A key share is a to-device request: the same pump handles it.
      await this.send(request)
    }
    this.log('crypto-room-ready', { userId: this.userId, roomId, members: members.length, keyShares: requests.length })
  }

  /** Turns one room event into m.room.encrypted content for it. */
  async encrypt(roomId, eventType, content) {
    await this.init()
    const encrypted = await this.machine.encryptRoomEvent(new RoomId(roomId), eventType, JSON.stringify(content))
    return JSON.parse(encrypted)
  }

  /** The plaintext of an event, or a thrown error the caller logs as decrypt-failed. */
  async decrypt(roomId, event) {
    await this.init()
    const eventJson = JSON.stringify({
      type: event.type,
      event_id: event.event_id,
      sender: event.sender,
      content: event.content,
      origin_server_ts: event.origin_server_ts,
      unsigned: event.unsigned ?? {},
    })
    return this.machine.decryptRoomEvent(eventJson, new RoomId(roomId))
  }

  close() {
    this.machine?.close()
    this.machine = undefined
  }
}

export { RequestType }
