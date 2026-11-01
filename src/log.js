// One JSON object per line, append-only. The bridge's own diagnostics; message bodies are
// not written here — only which line went where and when.
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export class JsonlLog {
  constructor(path) {
    this.path = path
    this.queue = Promise.resolve()
    this.ready = mkdir(dirname(path), { recursive: true })
  }

  write(event, fields = {}) {
    const record = { t: new Date().toISOString(), event, ...fields }
    const line = `${JSON.stringify(record)}\n`
    this.queue = this.queue
      .then(() => this.ready)
      .then(() => appendFile(this.path, line, { mode: 0o600 }))
      .catch(() => {})
    return this.queue
  }
}
