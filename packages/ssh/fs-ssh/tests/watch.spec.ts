/** Watching through the real helper end to end: an external write reaches the provider callback. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SshFileSystem } from '../src/index.ts'
import { createHelperHarness } from '../../ssh/tests/fixtures/helper.ts'

class Policy extends Service {
  constructor(ctx: Context) { super(ctx, 'sandboxPolicy') }
  get defaultMode(): 'workspace-write' { return 'workspace-write' }
  resolve(): SandboxExecutionPolicy { return { mode: 'workspace-write', workspaceRoot: '/remote/work' } }
}

describe.skipIf(process.platform === 'win32')('SSH filesystem watching', () => {
  it('reports an external write and stops on unwatch', async () => {
    const helper = await createHelperHarness()
    const ctx = new Context()
    ctx.provide('ssh', helper.connection as never)
    await ctx.plugin(Policy)
    await ctx.plugin(SshFileSystem)
    onTestFinished(async () => { await ctx.fiber.dispose(); await helper.close() })
    const target = await ctx.fs.resolve('.')
    const events: (Error | undefined)[] = []
    const stop = await ctx.fs.watch(target, (error) => { events.push(error) }, new AbortController().signal)
    await writeFile(join(helper.root, 'watched.txt'), 'changed')
    await expect.poll(() => events.length).toBeGreaterThan(0)
    expect(events[0]).toBeUndefined()
    await stop()
  }, 20_000)

  it('watches a file target and closes while a poll is pending', async () => {
    const helper = await createHelperHarness()
    const ctx = new Context()
    ctx.provide('ssh', helper.connection as never)
    await ctx.plugin(Policy)
    await ctx.plugin(SshFileSystem)
    onTestFinished(async () => { await ctx.fiber.dispose(); await helper.close() })
    const file = join(helper.root, 'watched-file.txt')
    await writeFile(file, 'before')
    const target = await ctx.fs.resolve(file)
    const events: (Error | undefined)[] = []
    const stop = await ctx.fs.watch(target, (error) => { events.push(error) }, new AbortController().signal)
    await writeFile(file, 'after')
    await expect.poll(() => events.length).toBeGreaterThan(0)
    await stop()

    const pending = await ctx.fs.watch(target, vi.fn(), new AbortController().signal)
    await pending()
  }, 20_000)

  it('rejects an already-cancelled watcher before polling', async () => {
    const helper = await createHelperHarness()
    const ctx = new Context()
    ctx.provide('ssh', helper.connection as never)
    await ctx.plugin(Policy)
    await ctx.plugin(SshFileSystem)
    onTestFinished(async () => { await ctx.fiber.dispose(); await helper.close() })
    const target = await ctx.fs.resolve('.')
    const cancelled = AbortSignal.abort(new Error('watcher cancelled'))
    await expect(ctx.fs.watch(target, vi.fn(), cancelled)).rejects.toMatchObject({ code: 'FS_ABORTED' })
  }, 20_000)
})
