// A small Matrix client for the bridge: the handful of client-server API calls it
// needs, over fetch. No SDK dependency yet, so the E2EE step can choose its own
// without fighting this one.
export class MatrixError extends Error {
  constructor(method, path, status, body) {
    const detail = body?.error ?? body?.raw ?? ''
    super(`${method} ${path} -> ${status}${detail ? `: ${detail}` : ''}`)
    this.status = status
    this.body = body
    this.errcode = body?.errcode
  }
}

export class MatrixClient {
  constructor({ homeserverUrl, accessToken, userId }) {
    this.homeserverUrl = homeserverUrl.replace(/\/+$/, '')
    this.accessToken = accessToken
    this.userId = userId
  }

  async request(method, path, body, { timeoutMs = 20_000, query } = {}) {
    const url = new URL(`${this.homeserverUrl}/_matrix/client/v3${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const response = await fetch(url, {
      method,
      headers: {
        // No header at all for the anonymous calls (registration): an empty Bearer token
        // is rejected before the request body is even read.
        ...(this.accessToken === '' ? {} : { authorization: `Bearer ${this.accessToken}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let parsed
    try { parsed = text === '' ? {} : JSON.parse(text) } catch { parsed = { raw: text.slice(0, 500) } }
    if (!response.ok) throw new MatrixError(method, path, response.status, parsed)
    return parsed
  }

  whoami() {
    return this.request('GET', '/account/whoami')
  }

  // Sending with a transaction id makes a retry idempotent: the homeserver keeps the
  // event it already created for that id, so a lost response cannot double-post.
  async sendMessage(roomId, txnId, content) {
    const id = encodeURIComponent(roomId)
    const tx = encodeURIComponent(txnId)
    return this.request('PUT', `/rooms/${id}/send/m.room.message/${tx}`, content, { timeoutMs: 30_000 })
  }

  async createRoom({ name, topic, invite = [], encrypted = false, powerLevels }) {
    const initial_state = encrypted
      ? [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
      : []
    // The creator must be at 100 from the start: with an explicit override the server does
    // not add the creator to `users` by itself, and users_default 0 then leaves the room
    // with nobody able to send state (that was the 403 on power_levels).
    const override = powerLevels ?? { users: { [this.userId]: 100 }, users_default: 0, invite: 50 }
    return this.request('POST', '/createRoom', {
      name,
      ...(topic ? { topic } : {}),
      invite,
      preset: 'private_chat',
      visibility: 'private',
      initial_state,
      power_level_content_override: override,
    }, { timeoutMs: 30_000 })
  }

  joinRoom(roomIdOrAlias) {
    return this.request('POST', `/join/${encodeURIComponent(roomIdOrAlias)}`, {})
  }

  invite(roomId, userId) {
    return this.request('POST', `/rooms/${encodeURIComponent(roomId)}/invite`, { user_id: userId })
  }

  // Give a user full control of a room the bridge created for them.
  async makeAdmin(roomId, userId) {
    const id = encodeURIComponent(roomId)
    const current = await this.request('GET', `/rooms/${id}/state/m.room.power_levels/`)
    const content = { ...current, users: { ...(current.users ?? {}), [userId]: 100 } }
    await this.request('PUT', `/rooms/${id}/state/m.room.power_levels/`, content, { timeoutMs: 30_000 })
  }

  async setRoomName(roomId, name) {
    await this.request('PUT', `/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`, { name })
  }

  // Media upload lives outside /_matrix/client/v3: continuwuity only answers the older
  // /_matrix/media/v3 path (the /_matrix/client/v1 one is M_UNRECOGNIZED there).
  async uploadMedia(bytes, mime, filename = 'avatar.png') {
    const url = new URL(`${this.homeserverUrl}/_matrix/media/v3/upload`)
    url.searchParams.set('filename', filename)
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': mime },
      body: bytes,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let parsed
    try { parsed = text === '' ? {} : JSON.parse(text) } catch { parsed = { raw: text.slice(0, 300) } }
    if (!response.ok) throw new MatrixError('POST', '/_matrix/media/v3/upload', response.status, parsed)
    if (typeof parsed.content_uri !== 'string') throw new MatrixError('POST', '/_matrix/media/v3/upload', 200, { error: 'no content_uri in the answer' })
    return parsed.content_uri
  }

  async setProfileAvatar(mxc) {
    await this.request('PUT', `/profile/${encodeURIComponent(this.userId)}/avatar_url`, { avatar_url: mxc })
  }

  async setRoomAvatar(roomId, mxc) {
    await this.request('PUT', `/rooms/${encodeURIComponent(roomId)}/state/m.room.avatar/`, { url: mxc })
  }

  // A member event replaces the whole membership content, so the nickname goes back in.
  async setMemberLook(roomId, userId, { displayname, avatarUrl }) {
    await this.request('PUT', `/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`, {
      membership: 'join',
      ...(displayname === undefined ? {} : { displayname }),
      ...(avatarUrl === undefined ? {} : { avatar_url: avatarUrl }),
    })
  }
}
