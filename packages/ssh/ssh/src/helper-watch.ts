/** Bounded file-system watches for one helper, polled by administrative RPC. */
import { watch } from 'node:fs'
import { posix } from 'node:path'
import type { SshWatchId } from './schemas.ts'

/** One platform watch as this manager needs it; injectable for deterministic tests. */
export interface RemoteWatchHandle {
  /** Observe a content change or a directory rename; the platform may name the entry. */
  onChange(listener: (filename?: string | Buffer | null) => void): void
  /** Observe a platform watcher failure. */
  onError(listener: (error: Error) => void): void
  /** Stop receiving platform events. */
  close(): void
}

/** Starts one platform watch; the default uses `node:fs`. */
export type RemoteWatchFactory = (path: string) => RemoteWatchHandle

const startPlatformWatch: RemoteWatchFactory = (path) => {
  const watcher = watch(path, { persistent: false, encoding: 'utf8' })
  return {
    onChange: (listener) => {
      watcher.on('change', (_event, filename) => { listener(filename) })
    },
    onError: (listener) => { watcher.on('error', listener) },
    close: () => { watcher.close() },
  }
}

interface Waiter {
  resolve(changed: boolean): void
  reject(error: Error): void
}

interface WatchRecord {
  readonly watcher: RemoteWatchHandle
  /** Base name to match when an absent target forced a parent-directory watch. */
  readonly filter?: string
  changed: boolean
  closed: boolean
  error?: Error
  readonly waiters: Set<Waiter>
}

/**
 * Owns the helper's file-system watches. `next` long-polls: it resolves true on
 * the next invalidation, false after the bounded wait, and rejects on abort or
 * watch failure. Capacity and cleanup belong to the helper that constructs it.
 */
export class RemoteWatches {
  private readonly watches = new Map<SshWatchId, WatchRecord>()

  /**
   * @param limit - concurrent watches this helper accepts.
   * @param waitMs - longest a single `next` waits before reporting no change.
   * @param startWatch - platform watch factory; tests inject a controllable one.
   */
  constructor(
    private readonly limit: number,
    private readonly waitMs = 20_000,
    private readonly startWatch: RemoteWatchFactory = startPlatformWatch,
  ) {}

  /**
   * Start watching one path.
   * @param id - helper-issued reservation identity.
   * @param path - absolute path to observe; the target may be absent.
   * @throws when capacity is exhausted or the platform refuses the watch.
   */
  open(id: SshWatchId, path: string): void {
    if (this.watches.size >= this.limit) throw new Error('SSH watch capacity unavailable')
    let watcher: RemoteWatchHandle
    let filter: string | undefined
    try {
      watcher = this.startWatch(path)
    } catch (error) {
      // An absent target is observed through its parent; events are filtered by
      // base name, but over-invalidation is safer than a missed creation.
      try {
        watcher = this.startWatch(posix.dirname(path))
        filter = posix.basename(path)
      } catch {
        throw new Error(`SSH watch failed for '${path}': ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const record: WatchRecord = { watcher, ...(filter === undefined ? {} : { filter }), changed: false, closed: false, waiters: new Set() }
    watcher.onChange((filename) => {
      if (filter !== undefined && filename != null && filename !== filter) return
      this.signal(record)
    })
    watcher.onError((error) => { this.fail(record, error) })
    this.watches.set(id, record)
  }

  /**
   * Await the next invalidation for one watch.
   * @param id - watch identity returned by its owner.
   * @param signal - cancels this poll without closing the watch.
   * @returns whether an invalidation arrived before the wait bound.
   * @throws when the watch is unknown, failed or cancelled.
   */
  async next(id: SshWatchId, signal?: AbortSignal): Promise<{ changed: boolean }> {
    const record = this.watches.get(id)
    if (record === undefined) throw new Error('Unknown SSH watch')
    if (record.error !== undefined) throw record.error
    if (record.changed) {
      record.changed = false
      return { changed: true }
    }
    const watch = record
    signal?.throwIfAborted()
    return await new Promise<{ changed: boolean }>((resolve, reject) => {
      /** Detach this poll from every source that can still settle it. */
      function settle(): void {
        watch.waiters.delete(waiter)
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      const waiter: Waiter = {
        resolve: (changed) => { settle(); resolve({ changed }) },
        reject: (error) => { settle(); reject(error) },
      }
      const timer = setTimeout(() => { waiter.resolve(false) }, this.waitMs)
      timer.unref()
      const abort = (): void => {
        waiter.reject(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason)))
      }
      watch.waiters.add(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  /**
   * Stop one watch and settle its pending polls.
   * @param id - watch identity.
   */
  close(id: SshWatchId): void {
    const record = this.watches.get(id)
    if (record === undefined) return
    this.watches.delete(id)
    this.retire(id, record)
  }

  /** Stop every watch; helper shutdown awaits this. */
  closeAll(): Promise<void> {
    for (const [id, record] of [...this.watches]) {
      this.watches.delete(id)
      this.retire(id, record)
    }
    return Promise.resolve()
  }

  private retire(id: SshWatchId, record: WatchRecord): void {
    record.closed = true
    record.watcher.close()
    for (const waiter of [...record.waiters]) {
      waiter.reject(new Error(`SSH watch '${String(id)}' closed before an invalidation arrived`))
    }
  }

  private signal(record: WatchRecord): void {
    if (record.closed) return
    const waiter = record.waiters.values().next().value
    if (waiter === undefined) {
      record.changed = true
      return
    }
    waiter.resolve(true)
  }

  private fail(record: WatchRecord, error: Error): void {
    if (record.closed) return
    record.error = error
    for (const waiter of [...record.waiters]) waiter.reject(error)
  }
}
