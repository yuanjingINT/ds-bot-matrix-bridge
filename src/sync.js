// The whole bridge in one process: DS Bot group chats → Matrix rooms (forward) and Matrix
// rooms → DS Bot group chats (receive, through the DSH-side plugin).
//
// Same loop as index.js for the forward half; the receive half needs the
// matrix-bridge-host plugin to be mounted in the DSH profile (see README). Without it the
// bridge still forwards and says once that receiving is off.
import { watch } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { JsonlLog } from './log.js'
import { Bridge } from './bridge.js'
import { acquireLock } from './lock.js'
import { Receiver } from './receive.js'
import { InviteAccepter } from './invites.js'
import { GuiInjector } from './injector.js'
import { loadSettings } from './settings.js'

const settings = loadSettings()
const log = new JsonlLog(process.env.MATRIX_BRIDGE_LOG ?? `${settings.root}/logs/bridge.jsonl`)
const config = {
  ...settings,
  log: (event, fields) => {
    void log.write(event, fields)
    if (process.env.MATRIX_BRIDGE_VERBOSE === '1' || ['error', 'send-failed', 'account-failed', 'room-failed', 'receive-failed', 'receive-error'].includes(event)) {
      console.error(`[${event}]`, JSON.stringify(fields))
    }
  },
}

const bridge = new Bridge(config)
// sync.js is the production entry point, so it takes the same single-instance lock as
// index.js: two processes would mirror and receive the same lines twice.
const releaseLock = acquireLock(join(settings.root, 'state', 'bridge.lock'))
// Delivery goes through the GUI's own API by default (no profile change); the plugin
// socket stays available as the richer route later.
const injector = new GuiInjector({ tokenFile: settings.guiTokenFile, baseUrl: settings.guiUrl, log: config.log })
const receiver = new Receiver({
  store: bridge.store,
  accounts: bridge.accounts,
  config: {
    ...config,
    injector,
    guiTokenFile: settings.guiTokenFile,
    // The receive half tells the forward half what it just injected, so the same line is
    // not mirrored back into the room as a second (Bot-authored) copy.
    onInjected: (groupId, text) => bridge.noteInjected(groupId, text),
  },
})
const joiner = new InviteAccepter({ homeserverUrl: settings.homeserverUrl, tokenFile: settings.userTokenFile, log: config.log })
const AUTOJOIN_EVERY_MS = 10_000
const once = process.argv.includes('--once')

let pluginReady = false
let blockedLoggedAt = 0
const BLOCKED_LOG_EVERY_MS = 60_000
const checkDelivery = async () => {
  const health = await receiver.health()
  // A listener on the socket is not proof of anything: the test stub answers /health too.
  // Only the plugin names itself and its version, so anything else keeps receiving off.
  // The plugin names itself and its version; the GUI channel is proven by a real probe
  // (both `verified`). A bare `ok` from anything listening on a socket is not enough.
  const isPlugin = health?.ok === true && health?.verified === true
    && (health?.transport === 'gui-http' || (health?.name === 'matrix-bridge-host' && typeof health?.version === 'string'))
  if (isPlugin) {
    if (!pluginReady) config.log('receive-ready', { transport: health.transport ?? 'plugin', name: health.name, version: health.version, socket: settings.controlSocket })
    pluginReady = true
    return true
  }
  // Without the plugin the bridge can only forward. Say that in the log, with the reason,
  // instead of silently never producing a receive-start line.
  const now = Date.now()
  if (pluginReady || now - blockedLoggedAt >= BLOCKED_LOG_EVERY_MS) {
    if (pluginReady) config.log('receive-unavailable', { socket: settings.controlSocket, reason: health?.reason ?? 'the DSH plugin stopped answering' })
    else if (health !== undefined) {
      config.log('receive-blocked', {
        socket: settings.controlSocket,
        reason: health?.reason ?? `the socket answered, but not as the plugin (name=${health?.name ?? 'none'}, version=${health?.version ?? 'none'})`,
      })
    }
    else config.log('receive-blocked', {
      reason: health?.reason ?? 'the GUI token is missing',
      hint: 'put the DSH web launch token in the gui_token file (README), or install the matrix-bridge-host plugin',
    })
    blockedLoggedAt = now
  }
  pluginReady = false
  return false
}

let lastAutojoin = 0
const tick = async () => {
  await bridge.tick()
  // Accepting the user's invites is cheap but not free; every 10s is enough.
  if (Date.now() - lastAutojoin >= AUTOJOIN_EVERY_MS) {
    lastAutojoin = Date.now()
    await joiner.accept()
  }
  if (!settings.receiveEnabled) return
  if (!(await checkDelivery())) return
  await receiver.reconcile(Object.keys(bridge.store.rooms()).map(id => ({ id })))
}

if (once) {
  await tick()
  await receiver.stop()
  process.exit(0)
}

let timer
let closed = false
let watcher
let debounce
const stop = async (signal) => {
  if (closed) return
  closed = true
  clearInterval(timer)
  watcher?.close()
  // The lock goes first: a /sync that is still in flight must not keep the next start from
  // taking over, and a stop that waits on it would hang past the service manager's timeout.
  releaseLock()
  // A long poll can take 25s to unwind; give it a moment, then leave regardless.
  const hard = setTimeout(() => {
    config.log('stopped', { signal, forced: true })
    process.exit(0)
  }, 4_000)
  hard.unref?.()
  await receiver.stop().catch(() => {})
  await bridge.current.catch(() => {})
  clearTimeout(hard)
  config.log('stopped', { signal })
  process.exit(0)
}
process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))

// The host replaces state.json atomically; the directory watcher sees the rename the
// bridge is after, where a watcher on the file itself would not.
try {
  watcher = watch(dirname(settings.teamStatePath), (event, filename) => {
    if (filename !== 'state.json') return
    clearTimeout(debounce)
    debounce = setTimeout(() => void tick(), 80)
  })
} catch (error) {
  config.log('watch-failed', { message: error?.message ?? String(error), path: settings.teamStatePath })
}

timer = setInterval(() => void tick(), settings.pollMs)
// Ask the delivery path before claiming anything: reporting `receive: "on"` while the
// inbound is broken is how a stub socket once looked healthy for half an hour.
const receiveAtStart = !settings.receiveEnabled ? 'off' : ((await checkDelivery()) ? 'on' : 'blocked')
config.log('started', {
  mode: 'full',
  homeserver: settings.homeserverUrl,
  teamStatePath: settings.teamStatePath,
  userMxid: settings.userMxid,
  pollMs: settings.pollMs,
  encrypted: settings.encrypted,
  receive: receiveAtStart,
  controlSocket: settings.controlSocket,
  userAccount: joiner.available ? 'token found' : 'no token (invites are not accepted for the user)',
  registrationToken: settings.registrationToken === undefined ? 'missing' : 'set',
})

await tick()
