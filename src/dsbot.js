// Reads the DS Bot team file as a third party: state.json is written whole and replaced
// atomically, so a plain read always sees a whole team. Nothing here writes to it.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// A group line longer than TEXT_KEPT keeps only its start in state.json; the whole text
// (up to the read limit) sits in <home>/group-lines/<roomId>/<seq>.txt.
export const groupLinePath = (home, roomId, seq) => join(home, 'group-lines', roomId, `${seq}.txt`)

// `mtimeMs` is when the host last wrote the team file — the moment the lines in this
// snapshot were appended — so it serves as the received-at time for lines the bridge has
// not seen before.
export async function readTeam(statePath) {
  const [text, info] = await Promise.all([readFile(statePath, 'utf8'), stat(statePath)])
  const state = JSON.parse(text)
  return {
    rooms: state.rooms ?? {},
    bots: state.bots ?? {},
    revision: state.revision ?? 0,
    mtimeMs: info.mtimeMs,
    readAt: Date.now(),
  }
}

export async function stamp(statePath) {
  try {
    const { mtimeMs, size } = await stat(statePath)
    return `${mtimeMs}:${size}`
  } catch {
    return ''
  }
}

export async function fullLineText(home, roomId, line) {
  const head = typeof line.text === 'string' ? line.text : ''
  if (typeof line.length !== 'number' || line.length <= head.length) return head
  try {
    const whole = await readFile(groupLinePath(home, roomId, line.seq), 'utf8')
    return whole.length > head.length ? whole : head
  } catch {
    return head
  }
}

// Line kinds are round events ("resumed", "stopped", "done", "cut"), not messages.
export const isEventLine = (line) => line.kind !== undefined
