import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireLock } from '../src/lock.js'

test('a second bridge refuses to start on the same state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mxbridge-lock-'))
  const path = join(dir, 'bridge.lock')
  const release = acquireLock(path)
  assert.throws(() => acquireLock(path), /another bridge is running/)
  release()
  const second = acquireLock(path)
  second()
})

test('a lock left by a dead process is taken over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mxbridge-lock-'))
  const path = join(dir, 'bridge.lock')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, '999999999')
  const release = acquireLock(path)
  release()
})
