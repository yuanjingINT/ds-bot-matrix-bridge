// One bridge per machine: two processes on the same state would both mirror the same
// group lines (each with its own idea of the cursor) and fight over bridge.json.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => {
        try { unlinkSync(path) } catch { /* already gone */ }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const holder = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
      if (alive(holder)) throw new Error(`another bridge is running (pid ${holder}, lock ${path})`)
      // A lock left behind by a crashed process: take it over.
      try { unlinkSync(path) } catch { /* raced with another starter */ }
    }
  }
  throw new Error(`could not take the bridge lock at ${path}`)
}
