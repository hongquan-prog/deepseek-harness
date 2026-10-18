/** Browse backend of the directory-picker seam over the connected WSL filesystem. */
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import {
  DirectoryPicker, DirectoryPickerError,
  type DirectoryEntry, type DirectoryListing, type DirectoryPickerBrowseCapability,
} from '@deepseek-ai/dsh-host-directory-picker'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-ssh'

/** Deployment-owned browse limits. */
export interface Config {
  /** Maximum child directories reported in one level; the tail is truncated. */
  maxEntries?: number
}

const configSchema = z.object({
  maxEntries: z.number().int().min(1).max(10_000).default(1000),
}).strict()

/** The caller's abort reason, never the seam's business error. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
}

/** Race one promise against the caller's cancellation. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await work
  if (signal.aborted) throw abortReason(signal)
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(abortReason(signal)) }
    signal.addEventListener('abort', aborted, { once: true })
    void work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', aborted) })
  })
}

/** Ancestor chain from the POSIX root to `target` inclusive. */
function ancestry(target: string): DirectoryEntry[] {
  const chain = ['/']
  let current = ''
  for (const segment of target.split('/').filter(segment => segment.length > 0)) {
    current += `/${segment}`
    chain.push(current)
  }
  return chain.map(path => ({ name: path === '/' ? '/' : posix.basename(path), path, hidden: false }))
}

/** One caller-facing message for a failed remote listing. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The `ctx.directoryPicker` browse implementation backed by `ctx.fs` and the
 * connected WSL helper: listings name distribution paths, never host paths.
 */
export default class WslDirectoryPicker extends DirectoryPicker {
  static inject = ['fs', 'ssh']
  static Config: schema<Config> = schema.object({
    maxEntries: schema.number().default(1000),
  })

  private readonly maxEntries: number

  private readonly browse = {
    kind: 'browse' as const,
    list: async (path?: string, signal?: AbortSignal): Promise<DirectoryListing> => await this.list(path, signal),
    createDirectory: async (path: string, name: string): Promise<string> => await this.createDirectory(path, name),
  }

  /**
   * @param ctx - owning context with `fs` and `ssh`.
   * @param config - optional browse limits.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.maxEntries = configSchema.parse(config).maxEntries
  }

  /**
   * The browse interaction capability.
   * @returns the stable `browse` capability object.
   */
  capability(): DirectoryPickerBrowseCapability {
    return this.browse
  }

  private async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const home = (await untilAborted(this.ctx.ssh.ready, signal)).workspace
    const requested = path ?? home
    if (!posix.isAbsolute(requested)) {
      throw new DirectoryPickerError('directory-unreadable', requested, `cannot list "${requested}": not an absolute distribution path`)
    }
    let target: FsTarget
    try {
      target = await this.ctx.fs.resolve(requested, signal === undefined ? undefined : { signal })
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      throw new DirectoryPickerError('directory-unreadable', requested, `cannot list ${requested}: ${messageOf(error)}`)
    }
    const canonical = this.ctx.fs.processPath(target)
    let entries
    try {
      entries = await this.ctx.fs.listDir(target, signal)
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      throw new DirectoryPickerError('directory-unreadable', requested, `cannot list ${requested}: ${messageOf(error)}`)
    }
    const directories = entries
      .filter(entry => entry.type === 'directory')
      .sort((left, right) => left.name.localeCompare(right.name))
    return {
      path: canonical,
      home,
      crumbs: ancestry(canonical),
      entries: directories.slice(0, this.maxEntries).map(entry => ({
        name: entry.name,
        path: posix.join(canonical, entry.name),
        hidden: entry.name.startsWith('.'),
      })),
      truncated: directories.length > this.maxEntries,
    }
  }

  private createDirectory(path: string, name: string): Promise<string> {
    return Promise.reject(new DirectoryPickerError('directory-create-failed', path,
      `cannot create "${name}" in ${path}: directory creation inside the distribution is not supported yet`))
  }
}
