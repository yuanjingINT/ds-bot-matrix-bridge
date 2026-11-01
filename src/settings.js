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
  const userMxid = process.env.MATRIX_USER_ID ?? fileConfig.userMxid ?? ''
  return {
    root,
    homeserverUrl: needsHomeserver ? required('MATRIX_HOMESERVER_URL') : (process.env.MATRIX_HOMESERVER_URL ?? ''),
    registrationToken,
    userMxid,
    // Who may speak into the group chats from Matrix. Everyone else's messages are
    // dropped with a `skipped` line, so a room guest cannot impersonate the owner.
    allowedSenders: (() => {
      const fromEnv = process.env.MATRIX_ALLOWED_SENDERS
      if (fromEnv !== undefined && fromEnv !== '') return fromEnv.split(',').map(item => item.trim()).filter(Boolean)
      if (Array.isArray(fileConfig.allowedSenders) && fileConfig.allowedSenders.length > 0) return fileConfig.allowedSenders
      return userMxid === '' ? [] : [userMxid]
    })(),
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
    // The GUI's own API: token file, base URL. Deliver a Matrix line as the user through it.
    guiTokenFile: process.env.DSH_GUI_TOKEN_FILE ?? fileConfig.guiTokenFile ?? join(homedir(), '.dsh', 'bot', 'workspace', '.secrets', 'gui_token'),
    guiUrl: process.env.DSH_WEB_URL ?? fileConfig.guiUrl ?? 'http://127.0.0.1:3080',
    controlSocket: process.env.MATRIX_BRIDGE_CONTROL ?? fileConfig.controlSocket ?? join(homedir(), '.config', 'matrix-bridge', 'control.sock'),
    receiveEnabled: process.env.MATRIX_BRIDGE_RECEIVE !== '0' && fileConfig.receive !== false,
    // Optional: the user's own access token, so invites can be accepted for them. Absent
    // means invites wait in Element, which is fine.
    userTokenFile: process.env.MATRIX_USER_TOKEN_FILE ?? fileConfig.userTokenFile ?? join(homedir(), '.dsh', 'bot', 'workspace', '.secrets', 'matrix_user_token'),
    // Accounts whose messages are never taken as inbound: the Bots' own accounts are found
    // through the store, and older bridge accounts (@dsbridge, Dito's bot) are listed here,
    // so an old bridge still running on the same rooms cannot echo into a group chat.
    ignoredSenders: (() => {
      const fromEnv = (process.env.MATRIX_BRIDGE_IGNORED_SENDERS ?? '').split(',').map(value => value.trim()).filter(Boolean)
      const fromFile = Array.isArray(fileConfig.ignoredSenders) ? fileConfig.ignoredSenders : []
      return [...new Set([...fromFile, ...fromEnv])]
    })(),
  }
}
