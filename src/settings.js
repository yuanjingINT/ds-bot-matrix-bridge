// Settings shared by the bridge's entry points: the team file, the homeserver, the
// control socket the DSH plugin listens on, and the saved state. No secret is read here
// except the registration token, which stays in memory and never reaches a log line.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from './env.js'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`${path} is not valid JSON: ${error.message}`)
  }
}

const required = (name) => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

export function loadSettings({ needsHomeserver = true } = {}) {
  loadEnv(process.env.MATRIX_BRIDGE_ENV ?? join(root, '.env'))
  const fileConfig = readJson(join(root, 'config.json'))
  const teamStatePath = process.env.DSH_BOT_STATE ?? fileConfig.teamStatePath ?? join(homedir(), '.dsh', 'bot', 'state.json')
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
  return {
    root,
    homeserverUrl: needsHomeserver ? required('MATRIX_HOMESERVER_URL') : (process.env.MATRIX_HOMESERVER_URL ?? ''),
    registrationToken,
    userMxid: process.env.MATRIX_USER_ID ?? fileConfig.userMxid ?? '',
    userDisplayName: fileConfig.userDisplayName ?? '用户',
    extraInvites: Array.isArray(fileConfig.extraInvites) ? fileConfig.extraInvites : [],
    teamStatePath,
    home: dirname(teamStatePath),
    statePath: join(root, 'state', 'bridge.json'),
    accountsPath: join(root, 'state', 'accounts.json'),
    cryptoDir: join(root, 'state', 'crypto'),
    pollMs: Number(process.env.MATRIX_BRIDGE_POLL_MS ?? fileConfig.pollMs ?? 2000),
    encrypted: fileConfig.encrypted === true,
    onGroupDeleted: fileConfig.onGroupDeleted ?? 'notify',
    // The DSH plugin's socket (plugin/index.js). The bridge never writes the team file and
    // never needs the browser cookie the /api/bot route wants.
    controlSocket: process.env.MATRIX_BRIDGE_CONTROL ?? fileConfig.controlSocket ?? join(homedir(), '.config', 'matrix-bridge', 'control.sock'),
    receiveEnabled: process.env.MATRIX_BRIDGE_RECEIVE !== '0' && fileConfig.receive !== false,
  }
}
