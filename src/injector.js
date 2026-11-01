// The way a Matrix message becomes a user message in a DS Bot group chat, today: the
// DSH web GUI's own API.
//
// The GUI authenticates with a signed cookie that is minted from the launch token in its
// start-up URL. The bridge reads that token from a 600 file, exchanges it for the cookie in
// memory (never on disk, never in a log line), and then POSTs the same `send` call the
// composer makes. A 401 means the cookie expired or the GUI restarted: the bridge mints a
// new one and retries once.
//
// This is an internal API: it needs no plugin and no profile change, but a DSH upgrade
// could move it. Streaming, progress lines and cards need the plugin route instead.
import { readFileSync } from 'node:fs'

const COOKIE_NAME = 'dsh-auth-'
const DEFAULT_BASE = 'http://127.0.0.1:3080'

export class GuiInjector {
  constructor({ tokenFile, baseUrl = process.env.DSH_WEB_URL ?? DEFAULT_BASE, log }) {
    this.tokenFile = tokenFile
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.log = log
    this.cookie = undefined
    this.token = undefined
  }

  /** Reads the launch token once. No file means injection is off, and only forwarding runs. */
  available() {
    if (this.cookie !== undefined) return true
    try {
      const token = readFileSync(this.tokenFile, 'utf8').trim()
      if (token === '') return false
      this.token = token
      return true
    } catch {
      return false
    }
  }

  /** Exchanges the launch token for the GUI's session cookie. */
  async mintCookie() {
    if (!this.available()) throw new Error(`no GUI token at ${this.tokenFile}`)
    const response = await fetch(`${this.baseUrl}/?token=${encodeURIComponent(this.token)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    const pairs = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
    const cookies = []
    for (const raw of pairs) {
      const [pair] = raw.split(';')
      if (pair.startsWith(COOKIE_NAME)) cookies.push(pair.trim())
    }
    if (cookies.length === 0) {
      throw new Error(`the GUI did not accept the launch token (HTTP ${response.status})`)
    }
    this.cookie = cookies.join('; ')
    // Only the fact that a cookie was minted is logged, never the value.
    this.log('cookie-minted', { base: this.baseUrl })
    return this.cookie
  }

  async call(body) {
    if (this.cookie === undefined) await this.mintCookie()
    const response = await fetch(`${this.baseUrl}/api/bot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    })
    return { status: response.status, text: await response.text() }
  }

  /** Delivers one line into a group chat as the user. Throws when the GUI refuses it. */
  async send(sessionId, text) {
    let result = await this.call({ endpoint: 'send', payload: { sessionId, text } })
    // A restarted GUI invalidates the cookie; mint a fresh one and try exactly once more.
    if (result.status === 401) {
      this.cookie = undefined
      await this.mintCookie()
      result = await this.call({ endpoint: 'send', payload: { sessionId, text } })
    }
    if (result.status !== 200) {
      throw new Error(`the GUI refused the message (HTTP ${result.status}): ${result.text.slice(0, 200)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(result.text)
    } catch {
      throw new Error(`the GUI answered with something that is not JSON: ${result.text.slice(0, 200)}`)
    }
    if (parsed?.ok !== true) {
      throw new Error(`the GUI refused the message: ${parsed?.error?.message ?? result.text.slice(0, 200)}`)
    }
    return parsed
  }
}
