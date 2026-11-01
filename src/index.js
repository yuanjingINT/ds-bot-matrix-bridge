// Entry point: load settings, then keep the bridge running. It watches the team file so a
// new group line reaches Matrix right away, and polls as well so a missed file event (or a
// rename the watcher does not see) still gets picked up.
import { readFileSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './env.js'
import { JsonlLog } from './log.js'
import { Bridge } from './bridge.js'
import { acquireLock } from './lock.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
loadEnv(process.env.MATRIX_BRIDGE_ENV ?? join(root, '.env'))

const readConfig = () => {
  try {
    return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`config.json is not valid JSON: ${error.message}`)
  }
}

const fileConfig = readConfig()
const once = process.argv.includes('--once')

const required = (name) => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

const teamStatePath = process.env.DSH_BOT_STATE ?? fileConfig.teamStatePath ?? join(homedir(), '.dsh', 'bot', 'state.json')
const homeserverUrl = required('MATRIX_HOMESERVER_URL')
const log = new JsonlLog(process.env.MATRIX_BRIDGE_LOG ?? join(root, 'logs', 'bridge.jsonl'))

// The registration token lives in its own 600 file, so rotating it never means editing
// the bridge's settings or its saved state.
const registrationToken = (() => {
  if (process.env.MATRIX_REGISTRATION_TOKEN) return process.env.MATRIX_REGISTRATION_TOKEN
  const file = process.env.MATRIX_REGISTRATION_TOKEN_FILE ?? fileConfig.registrationTokenFile
  if (!file) return undefined
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return undefined
  }
})()

const config = {
  homeserverUrl,
  registrationToken,
  userMxid: process.env.MATRIX_USER_ID ?? fileConfig.userMxid ?? '',
  userDisplayName: fileConfig.userDisplayName ?? '用户',
  // Extra accounts invited into every room the bridge creates (验收's observer account,
  // until the acceptance run is over).
  extraInvites: Array.isArray(fileConfig.extraInvites) ? fileConfig.extraInvites : [],
  teamStatePath,
  home: dirname(teamStatePath),
  statePath: join(root, 'state', 'bridge.json'),
  accountsPath: join(root, 'state', 'accounts.json'),
  cryptoDir: join(root, 'state', 'crypto'),
  pollMs: Number(process.env.MATRIX_BRIDGE_POLL_MS ?? fileConfig.pollMs ?? 2000),
  activePollMs: Number(process.env.MATRIX_BRIDGE_ACTIVE_POLL_MS ?? fileConfig.activePollMs ?? 500),
  encrypted: fileConfig.encrypted === true,
  onGroupDeleted: fileConfig.onGroupDeleted ?? 'notify',
  log: (event, fields) => {
    void log.write(event, fields)
    if (process.env.MATRIX_BRIDGE_VERBOSE === '1' || ['error', 'send-failed', 'account-failed', 'room-failed'].includes(event)) {
      console.error(`[${event}]`, JSON.stringify(fields))
    }
  },
}

const bridge = new Bridge(config)
const releaseLock = acquireLock(join(root, 'state', 'bridge.lock'))

if (once) {
  await schedule()
  releaseLock()
  process.exit(0)
}

let timer
let closed = false
const stop = async (signal) => {
  if (closed) return
  closed = true
  clearTimeout(timer)
  watcher?.close()
  await bridge.current
  releaseLock()
  config.log('stopped', { signal })
  process.exit(0)
}
process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))

// The host replaces state.json atomically, so watch the directory and react to the name,
// not to a file handle that the rename would invalidate.
let watcher
let debounce
try {
  watcher = watch(dirname(teamStatePath), (event, filename) => {
    if (filename !== 'state.json') return
    clearTimeout(debounce)
    debounce = setTimeout(() => void bridge.tick(), 80)
  })
} catch (error) {
  config.log('watch-failed', { message: error?.message ?? String(error), path: teamStatePath })
}

// Polling is adaptive: after a send, look again quickly, then back off while the team is
// quiet. The file watcher handles the fast path; this is the safety net.
let lastActivity = Date.now()
const schedule = async () => {
  const sentBefore = bridge.sent
  await bridge.tick()
  if (bridge.sent !== sentBefore) lastActivity = Date.now()
  if (closed) return
  const delay = Date.now() - lastActivity < 30_000 ? config.activePollMs : config.pollMs
  timer = setTimeout(() => void schedule(), delay)
}
config.log('started', {
  homeserver: homeserverUrl,
  teamStatePath,
  userMxid: config.userMxid,
  pollMs: config.pollMs,
  encrypted: config.encrypted,
  registrationToken: config.registrationToken === undefined ? 'missing' : 'set',
})

await schedule()
