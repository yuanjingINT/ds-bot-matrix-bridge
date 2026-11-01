// Reads the bridge's .env without a dependency. Values never leave the process.
import { readFileSync } from 'node:fs'

const unquote = (value) => {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function loadEnv(path = '.env') {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    // The process environment wins, so a shell can override the file.
    if (process.env[key] === undefined) process.env[key] = unquote(line.slice(at + 1))
  }
  return true
}
