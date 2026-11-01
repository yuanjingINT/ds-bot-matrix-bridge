// A stand-in for the DSH plugin (../plugin/index.js), for checking the receive path when
// the plugin is not mounted in the profile yet. It answers the same three routes the bridge
// uses and appends every /prompt call it receives to a JSONL file, so a message written in
// Matrix can be followed all the way to the last hop before the DS Bot group chat.
//
// It never touches the team state or the DSH process: the message stops here.
//
// Run: node test/stub-control-socket.mjs [--socket PATH] [--out PATH]
// Defaults: ~/.config/matrix-bridge/control.sock, /tmp/matrix-bridge-stub-prompts.jsonl
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const argOf = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const socketPath = argOf('--socket') ?? join(homedir(), '.config', 'matrix-bridge', 'control.sock')
const outPath = argOf('--out') ?? '/tmp/matrix-bridge-stub-prompts.jsonl'

mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
// A stale socket from a dead process would make listen() fail.
if (existsSync(socketPath)) rmSync(socketPath)

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const url = new URL(request.url ?? '/', 'http://bridge')
    if (url.pathname === '/health' || url.pathname === '/version') {
      const body = JSON.stringify({ ok: true, name: 'matrix-bridge-host', version: 'stub', socket: socketPath })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if (request.method === 'POST' && url.pathname === '/prompt') {
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end('{"ok":false,"error":"body is not JSON"}')
        return
      }
      appendFileSync(outPath, `${JSON.stringify({ t: new Date().toISOString(), ...body })}\n`)
      const answer = JSON.stringify({ ok: true, sessionId: body.sessionId })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(answer) })
      response.end(answer)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"ok":false}')
  })
})

server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600)
  console.log(`stub plugin listening on ${socketPath}`)
  console.log(`prompts are appended to ${outPath}`)
})

const stop = () => {
  server.close(() => {
    try { rmSync(socketPath) } catch { /* already gone */ }
    process.exit(0)
  })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
