// matrix-bridge-host: the only DS Bot-side hook the bridge needs.
//
// A Matrix room message has to become a user message in a DS Bot group chat, and the
// group's Session is the only door into it: exactly what the web composer does when the
// user types there. That call lives inside the DSH process, so the bridge talks to this
// plugin over a private UNIX socket instead of touching the team file or the HTTP API
// (which only a browser cookie may reach).
//
// The plugin adds no tools, no UI, and no prompt text. It exposes three routes on a
// 0600 socket under the user's home:
//   POST /prompt  { sessionId, text }  -> a user message in that Session (a group chat)
//   GET  /health                        -> liveness, for the bridge's start-up check
//   GET  /version                       -> plugin version, so a stale install is visible
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'matrix-bridge-host'
export const inject = ['sessionController']

const VERSION = '0.1.0'
const MAX_TEXT = 20_000

const defaultSocket = () => join(homedir(), '.config', 'matrix-bridge', 'control.sock')

const readBody = request => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  request.on('data', (chunk) => {
    size += chunk.length
    if (size > 1_000_000) {
      reject(Object.assign(new Error('body too large'), { status: 413 }))
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  request.on('error', reject)
})

const reply = (response, status, body) => {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

export function apply(ctx, config = {}) {
  const socketPath = config.socketPath ?? defaultSocket()
  const enabled = config.enabled !== false
  if (!enabled) return

  const handle = async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://bridge')
      if (request.method === 'GET' && url.pathname === '/health') return reply(response, 200, { ok: true, name, version: VERSION })
      if (request.method === 'GET' && url.pathname === '/version') return reply(response, 200, { name, version: VERSION })
      if (request.method === 'POST' && url.pathname === '/prompt') {
        const body = JSON.parse(await readBody(request) || '{}')
        const sessionId = String(body.sessionId ?? '')
        const text = String(body.text ?? '').trim()
        if (sessionId === '') return reply(response, 400, { ok: false, error: 'sessionId is required' })
        if (text === '') return reply(response, 400, { ok: false, error: 'text is empty' })
        if (text.length > MAX_TEXT) return reply(response, 400, { ok: false, error: `text is longer than ${MAX_TEXT} characters` })
        // Same shape the web composer uses: the group's Session takes the message as one
        // more user turn, and the round it opens posts the line into the group log.
        await ctx.sessionController.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, AbortSignal.timeout(30_000))
        return reply(response, 200, { ok: true })
      }
      return reply(response, 404, { ok: false, error: 'no such route' })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      return reply(response, status, { ok: false, error: error?.message ?? String(error) })
    }
  }

  const server = createServer((request, response) => { void handle(request, response) })

  ctx.effect(() => {
    // A socket left behind by a killed host would make listen() fail with EADDRINUSE.
    try { rmSync(socketPath, { force: true }) } catch { /* nothing to remove */ }
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600) } catch { /* the umask decides when this fails */ }
    })
    server.on('error', (error) => {
      ctx.logger?.('matrix-bridge-host: control socket failed: %s', error?.message ?? error)
    })
    return () => {
      server.close()
      try { rmSync(socketPath, { force: true }) } catch { /* already gone */ }
    }
  }, 'matrix-bridge: control socket')
}
