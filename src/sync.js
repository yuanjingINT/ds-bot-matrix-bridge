// The whole bridge in one process: DS Bot group chats → Matrix rooms (forward) and Matrix
// rooms → DS Bot group chats (receive, through the DSH-side plugin).
//
// Same loop as index.js for the forward half; the receive half needs the
// matrix-bridge-host plugin to be mounted in the DSH profile (see README). Without it the
// bridge still forwards and says once that receiving is off.
import { watch } from 'node:fs'
import { dirname } from 'node:path'
import { JsonlLog } from './log.js'
import { Bridge } from './bridge.js'
import { Receiver } from './receive.js'
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
const receiver = new Receiver({ store: bridge.store, accounts: bridge.accounts, config })
const once = process.argv.includes('--once')

let pluginReady = false
let blockedLoggedAt = 0
const BLOCKED_LOG_EVERY_MS = 60_000
const checkPlugin = async () => {
  const health = await receiver.health()
  if (health?.ok === true) {
    if (!pluginReady) config.log('receive-ready', { socket: settings.controlSocket, plugin: health.version ?? 'unknown' })
    pluginReady = true
    return true
  }
  // Without the plugin the bridge can only forward. Say that in the log, with the reason,
  // instead of silently never producing a receive-start line.
  const now = Date.now()
  if (pluginReady || now - blockedLoggedAt >= BLOCKED_LOG_EVERY_MS) {
    if (pluginReady) config.log('receive-unavailable', { socket: settings.controlSocket, reason: health?.reason ?? 'the DSH plugin stopped answering' })
    else config.log('receive-blocked', {
      socket: settings.controlSocket,
      reason: health?.reason ?? 'the DSH plugin is not mounted',
      hint: 'install the matrix-bridge-host plugin in the DSH profile (README, step 2) and restart the app',
    })
    blockedLoggedAt = now
  }
  pluginReady = false
  return false
}

const tick = async () => {
  await bridge.tick()
  if (!settings.receiveEnabled) return
  if (!(await checkPlugin())) return
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
  await receiver.stop()
  await bridge.current
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
config.log('started', {
  mode: 'full',
  homeserver: settings.homeserverUrl,
  teamStatePath: settings.teamStatePath,
  userMxid: settings.userMxid,
  pollMs: settings.pollMs,
  encrypted: settings.encrypted,
  receive: settings.receiveEnabled ? 'on' : 'off',
  controlSocket: settings.controlSocket,
  registrationToken: settings.registrationToken === undefined ? 'missing' : 'set',
})

await tick()
