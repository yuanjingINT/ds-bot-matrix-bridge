// Optional zero-click joining: if the user puts their own access token in a 600 file, the
// bridge accepts the invites the Bots send to that account. Only that account is used, and
// the token is never logged, echoed, or written anywhere.
//
// Without the file this module does nothing, and the invites simply wait in Element.
import { readFileSync } from 'node:fs'

const INVITE_FILTER = JSON.stringify({
  room: {
    timeline: { limit: 0 },
    state: { limit: 0 },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
})

export class InviteAccepter {
  constructor({ homeserverUrl, tokenFile, log }) {
    this.homeserverUrl = homeserverUrl.replace(/\/+$/, '')
    this.tokenFile = tokenFile
    this.log = log
    this.token = undefined
    this.enabled = undefined
    this.retryAt = new Map()
    this.lastRun = 0
    this.busy = false
  }

  /** Reads the token once; a missing or empty file turns the feature off for good. */
  load() {
    if (this.enabled !== undefined) return this.enabled
    try {
      const token = readFileSync(this.tokenFile, 'utf8').trim()
      if (token === '') {
        this.enabled = false
        this.log('user-autojoin-off', { reason: 'the token file is empty', file: this.tokenFile })
        return false
      }
      this.token = token
      this.enabled = true
      this.log('user-autojoin-on', { file: this.tokenFile })
      return true
    } catch (error) {
      this.enabled = false
      this.log('user-autojoin-off', { reason: error?.code === 'ENOENT' ? 'no token file' : 'the token file cannot be read', file: this.tokenFile })
      return false
    }
  }

  async api(path, body, method) {
    const response = await fetch(`${this.homeserverUrl}/_matrix/client/v3${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text()
    let parsed
    try { parsed = text === '' ? {} : JSON.parse(text) } catch { parsed = { raw: text.slice(0, 200) } }
    if (!response.ok) {
      const error = new Error(`${method ?? 'POST'} ${path} -> ${response.status}: ${parsed?.error ?? ''}`)
      error.errcode = parsed?.errcode
      error.status = response.status
      throw error
    }
    return parsed
  }

  /** Joins every room the user account has been invited to. Throttled by the caller. */
  async accept() {
    if (!this.load()) return
    if (this.busy) return
    this.busy = true
    try {
      const sync = await this.api(`/sync?timeout=0&filter=${encodeURIComponent(INVITE_FILTER)}`)
      const invites = Object.keys(sync?.rooms?.invite ?? {})
      for (const roomId of invites) {
        const retryAt = this.retryAt.get(roomId)
        if (retryAt !== undefined && Date.now() < retryAt) continue
        try {
          await this.api(`/join/${encodeURIComponent(roomId)}`, {})
          this.retryAt.delete(roomId)
          this.log('user-invite-accepted', { room_id: roomId })
        } catch (error) {
          // A refused invite is retried, but not on every pass.
          this.retryAt.set(roomId, Date.now() + 60_000)
          this.log('user-invite-failed', { room_id: roomId, errcode: error?.errcode, status: error?.status, message: error?.message ?? String(error) })
        }
      }
    } catch (error) {
      // The account token may have been revoked: say so once, keep the bridge forwarding.
      if (error?.status === 401 || error?.errcode === 'M_UNKNOWN_TOKEN') {
        this.enabled = false
        this.token = undefined
        this.log('user-autojoin-off', { reason: 'the token is no longer valid', file: this.tokenFile })
      } else {
        this.log('user-autojoin-error', { message: error?.message ?? String(error), status: error?.status })
      }
    } finally {
      this.busy = false
    }
  }
}
