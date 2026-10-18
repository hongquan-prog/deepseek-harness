/** Administrative watches over the real helper and their bounded, injectable lifecycle. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RemoteWatches, type RemoteWatchFactory, type RemoteWatchHandle } from '../src/helper-watch.ts'
import { infoSchema, watchChangeSchema, watchIdSchema, type SshWatchId } from '../src/schemas.ts'
import { createHelperHarness } from './fixtures/helper.ts'

const watchOpenSchema = z.object({ id: watchIdSchema }).strict()
const watchId = (): SshWatchId => watchIdSchema.parse(randomUUID())

/** Controllable platform watch: tests decide when changes and failures arrive. */
class FakeWatch implements RemoteWatchHandle {
  private readonly changes: ((filename?: string | Buffer | null) => void)[] = []
  private readonly errors: ((error: Error) => void)[] = []
  closed = false

  onChange(listener: (filename?: string | Buffer | null) => void): void { this.changes.push(listener) }
  onError(listener: (error: Error) => void): void { this.errors.push(listener) }
  close(): void { this.closed = true }
  emitChange(filename?: string): void { for (const listener of this.changes) listener(filename) }
  emitError(error: Error): void { for (const listener of this.errors) listener(error) }
}

describe('SSH helper watches', () => {
  it('publishes a directory invalidation and closes the watch', async () => {
    const helper = await createHelperHarness()
    try {
      const opened = await helper.client.request('fs.watchOpen', {
        id: watchId(), target: { targetKey: helper.root, displayPath: helper.root },
      }, watchOpenSchema)
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      const next = helper.client.request('fs.watchNext', { id: opened.id }, watchChangeSchema)
      await writeFile(join(helper.root, 'trigger.txt'), 'change')
      expect(await next).toEqual({ changed: true })
      await helper.client.request('fs.watchClose', { id: opened.id }, z.null())
      await expect(helper.client.request('fs.watchNext', { id: opened.id }, watchChangeSchema))
        .rejects.toThrow('Unknown SSH watch')
    } finally { await helper.close() }
  }, 20_000)

  it('keeps watch polls and closes outside the ordinary request budget', async () => {
    const helper = await createHelperHarness()
    try {
      const opened = await helper.client.request('fs.watchOpen', {
        id: watchId(), target: { targetKey: helper.root, displayPath: helper.root },
      }, watchOpenSchema)
      const polls = Array.from({ length: 128 }, () =>
        helper.client.request('fs.watchNext', { id: opened.id }, watchChangeSchema)
          .then(() => 'changed', (error: unknown) => error))
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      const info = await helper.client.request('fs.stat', {
        target: { targetKey: helper.root, displayPath: helper.root },
      }, infoSchema)
      expect(info?.type).toBe('directory')
      await helper.client.request('fs.watchClose', { id: opened.id }, z.null())
      const settled = await Promise.all(polls)
      expect(settled.every(result => result instanceof Error)).toBe(true)
    } finally { await helper.close() }
  }, 20_000)

  it('coalesces changes, waits with a bound, and surfaces platform failures', async () => {
    const fake = new FakeWatch()
    const watches = new RemoteWatches(2, 5, () => fake)
    try {
      const id = watchId()
      watches.open(id, '/virtual')
      fake.emitChange()
      expect(await watches.next(id)).toEqual({ changed: true })
      expect(await watches.next(id)).toEqual({ changed: false })
      const pending = watches.next(id)
      fake.emitChange()
      expect(await pending).toEqual({ changed: true })

      const failing = watches.next(id)
      fake.emitError(new Error('platform watch failed'))
      await expect(failing).rejects.toThrow('platform watch failed')
      await expect(watches.next(id)).rejects.toThrow('platform watch failed')
      await expect(watches.next(watchId())).rejects.toThrow('Unknown SSH watch')
    } finally { await watches.closeAll() }
  })

  it('honors cancellation, capacity and close without leaking waiters', async () => {
    const fake = new FakeWatch()
    const watches = new RemoteWatches(1, 5_000, () => fake)
    const id = watchId()
    watches.open(id, '/virtual')
    expect(() => { watches.open(watchId(), '/virtual') }).toThrow('capacity unavailable')

    const cancelled = new AbortController()
    const pending = watches.next(id, cancelled.signal)
    cancelled.abort('plain reason')
    await expect(pending).rejects.toThrow('plain reason')

    const errorReason = new AbortController()
    const errorPending = watches.next(id, errorReason.signal)
    errorReason.abort(new Error('error reason'))
    await expect(errorPending).rejects.toThrow('error reason')

    const closed = watches.next(id)
    watches.close(id)
    await expect(closed).rejects.toThrow('closed before an invalidation')
    expect(fake.closed).toBe(true)
    watches.close(id)
    fake.emitChange()
    fake.emitError(new Error('after close'))
    await expect(watches.next(id)).rejects.toThrow('Unknown SSH watch')
    await watches.closeAll()
  })

  it('observes an absent target through its parent and filters sibling events', async () => {
    const fake = new FakeWatch()
    const seen: string[] = []
    const factory: RemoteWatchFactory = (path) => {
      seen.push(path)
      if (path === '/virtual/missing.txt') throw new Error('ENOENT')
      return fake
    }
    const watches = new RemoteWatches(1, 20, factory)
    const id = watchId()
    watches.open(id, '/virtual/missing.txt')
    expect(seen).toEqual(['/virtual/missing.txt', '/virtual'])
    fake.emitChange('sibling.txt')
    expect(await watches.next(id)).toEqual({ changed: false })
    fake.emitChange('missing.txt')
    expect(await watches.next(id)).toEqual({ changed: true })
    fake.emitChange()
    expect(await watches.next(id)).toEqual({ changed: true })
  })

  it('refuses a watch the platform factory rejects', () => {
    const throwing: RemoteWatchFactory = () => { throw 'unsupported platform' }
    const watches = new RemoteWatches(1, 5, throwing)
    expect(() => { watches.open(watchId(), '/virtual') }).toThrow("SSH watch failed for '/virtual': unsupported platform")

    const denied: RemoteWatchFactory = () => { throw new Error('platform denied') }
    const refusing = new RemoteWatches(1, 5, denied)
    expect(() => { refusing.open(watchId(), '/virtual') }).toThrow("SSH watch failed for '/virtual': platform denied")
  })

  it('watches an absent path through the real parent directory', async () => {
    const directory = await mkdtemp('/tmp/dsh-watch-')
    const watches = new RemoteWatches(1, 500)
    try {
      const id = watchId()
      watches.open(id, join(directory, 'created-later.txt'))
      await writeFile(join(directory, 'created-later.txt'), 'created')
      await expect.poll(async () => await watches.next(id), { timeout: 2_000 }).toEqual({ changed: true })
    } finally {
      await watches.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('watches a real temporary directory through the default factory', async () => {
    const directory = await mkdtemp('/tmp/dsh-watch-')
    const watches = new RemoteWatches(1, 30)
    try {
      const id = watchId()
      watches.open(id, directory)
      await writeFile(join(directory, 'event.txt'), 'event')
      await expect.poll(async () => await watches.next(id), { timeout: 2_000 }).toEqual({ changed: true })
    } finally {
      await watches.closeAll()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
