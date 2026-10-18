/** WSL browse backend maps distribution directories onto the picker contract. */
import { Context, Service } from '@deepseek-ai/cordis'
import { DirectoryPickerError, type DirectoryPickerBrowseCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { describe, expect, it } from 'vitest'
import WslDirectoryPicker from '../src/index.ts'

interface FakeEntry { name: string; type: 'file' | 'directory' | 'other' }

interface SetupOptions {
  maxEntries?: number
  entries?: FakeEntry[]
  resolveFailure?: unknown
  listFailure?: unknown
  resolveAbort?: AbortController
  listAbort?: AbortController
  pendingReady?: boolean
}

/** Filesystem capability the picker reads; every path is a distribution path. */
class FakeFs extends Service {
  constructor(ctx: Context, private readonly options: SetupOptions = {}) { super(ctx, 'fs') }

  get entries(): FakeEntry[] {
    return this.options.entries ?? [
      { name: 'beta', type: 'directory' },
      { name: '.config', type: 'directory' },
      { name: 'alpha', type: 'directory' },
      { name: 'notes.txt', type: 'file' },
    ]
  }

  async resolve(path: string): Promise<{ targetKey: string; displayPath: string }> {
    if (this.options.resolveAbort !== undefined) {
      this.options.resolveAbort.abort(new Error('resolve aborted'))
      throw new Error('resolve aborted')
    }
    if (this.options.resolveFailure !== undefined) throw this.options.resolveFailure
    return { targetKey: path, displayPath: path }
  }

  processPath(target: { targetKey: string }): string { return target.targetKey }

  async listDir(): Promise<FakeEntry[]> {
    if (this.options.listAbort !== undefined) {
      this.options.listAbort.abort(new Error('list aborted'))
      throw new Error('list aborted')
    }
    if (this.options.listFailure !== undefined) throw this.options.listFailure
    return this.entries
  }
}

/** Connection whose negotiated workspace roots the picker's Home crumb. */
class FakeSsh extends Service {
  readonly ready: Promise<{ workspace: string }>
  constructor(ctx: Context, options: SetupOptions = {}) {
    super(ctx, 'ssh')
    this.ready = options.pendingReady === true ? new Promise(() => {}) : Promise.resolve({ workspace: '/home/dev' })
  }
}

async function setup(options: SetupOptions = {}): Promise<{ ctx: Context; browse: DirectoryPickerBrowseCapability }> {
  const ctx = new Context()
  await ctx.plugin(FakeSsh, options)
  await ctx.plugin(FakeFs, options)
  await ctx.plugin(WslDirectoryPicker, options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries })
  return { ctx, browse: ctx.directoryPicker.capability() as DirectoryPickerBrowseCapability }
}

describe('WSL directory picker', () => {
  it('lists sorted child directories with distribution paths and ancestry', async () => {
    const { ctx, browse } = await setup()
    try {
      const listing = await browse.list('/home/dev/project')
      expect(listing).toMatchObject({
        path: '/home/dev/project',
        home: '/home/dev',
        truncated: false,
        crumbs: [
          { path: '/', name: '/' },
          { path: '/home', name: 'home' },
          { path: '/home/dev', name: 'dev' },
          { path: '/home/dev/project', name: 'project' },
        ],
      })
      expect(listing.entries).toEqual([
        { name: '.config', path: '/home/dev/project/.config', hidden: true },
        { name: 'alpha', path: '/home/dev/project/alpha', hidden: false },
        { name: 'beta', path: '/home/dev/project/beta', hidden: false },
      ])
    } finally { await ctx.fiber.dispose() }
  })

  it('roots an unspecified listing at the negotiated workspace', async () => {
    const { ctx, browse } = await setup()
    try {
      expect((await browse.list()).path).toBe('/home/dev')
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects host-relative or non-directory requests with typed failures', async () => {
    const { ctx, browse } = await setup()
    try {
      await expect(browse.list('relative/path')).rejects.toBeInstanceOf(DirectoryPickerError)
      await expect(browse.createDirectory('/home/dev', 'new')).rejects.toMatchObject({ code: 'directory-create-failed' })
    } finally { await ctx.fiber.dispose() }
  })

  it('truncates a level beyond the configured bound', async () => {
    const { ctx, browse } = await setup({ maxEntries: 2 })
    try {
      const listing = await browse.list('/home/dev/project')
      expect(listing.entries).toHaveLength(2)
      expect(listing.truncated).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('maps listing failures and preserves the caller abort reason', async () => {
    const broken = await setup({ resolveFailure: 'transport lost' })
    try {
      await expect(broken.browse.list('/home/dev/project')).rejects.toMatchObject({ code: 'directory-unreadable' })
      await expect(broken.browse.list('/home/dev/project')).rejects.toThrow('transport lost')
    } finally { await broken.ctx.fiber.dispose() }

    const errored = await setup({ resolveFailure: new Error('provider failed') })
    try {
      await expect(errored.browse.list('/home/dev/project')).rejects.toThrow('provider failed')
    } finally { await errored.ctx.fiber.dispose() }

    const pending = await setup({ pendingReady: true })
    try {
      const signal = new AbortController()
      const listing = pending.browse.list('/home/dev/project', signal.signal)
      signal.abort(new Error('caller cancelled'))
      await expect(listing).rejects.toThrow('caller cancelled')
    } finally { await pending.ctx.fiber.dispose() }

    const stringReason = await setup({ pendingReady: true })
    try {
      const signal = new AbortController()
      const listing = stringReason.browse.list('/home/dev/project', signal.signal)
      signal.abort('plain reason')
      await expect(listing).rejects.toThrow('plain reason')
    } finally { await stringReason.ctx.fiber.dispose() }
  })

  it('honors a signal that is already aborted and one that resolves normally', async () => {
    const { ctx, browse } = await setup()
    try {
      const aborted = new AbortController()
      aborted.abort(new Error('already cancelled'))
      await expect(browse.list('/home/dev/project', aborted.signal)).rejects.toThrow('already cancelled')
      const healthy = new AbortController()
      expect((await browse.list('/home/dev/project', healthy.signal)).path).toBe('/home/dev/project')
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves aborts that surface while resolving or listing', async () => {
    const resolving = new AbortController()
    const resolveFailure = await setup({ resolveAbort: resolving })
    try {
      await expect(resolveFailure.browse.list('/home/dev/project', resolving.signal)).rejects.toThrow('resolve aborted')
    } finally { await resolveFailure.ctx.fiber.dispose() }

    const listing = new AbortController()
    const listFailure = await setup({ listAbort: listing })
    try {
      await expect(listFailure.browse.list('/home/dev/project', listing.signal)).rejects.toThrow('list aborted')
    } finally { await listFailure.ctx.fiber.dispose() }

    const listingBroken = await setup({ listFailure: 'listing lost' })
    try {
      await expect(listingBroken.browse.list('/home/dev/project')).rejects.toThrow('listing lost')
    } finally { await listingBroken.ctx.fiber.dispose() }
  })
})
