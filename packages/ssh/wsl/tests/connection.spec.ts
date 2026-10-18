/** The WSL connection drives a real helper through a wsl.exe-shaped launch. */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WslConnection, type Config } from '../src/index.ts'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const shim = join(repositoryRoot, 'packages/ssh/wsl/tests/fixtures/wsl-shim.mjs')
const helperEntry = join(repositoryRoot, 'packages/ssh/ssh/src/helper-entry.ts')
let workspace = ''

/** Read one converted process stream to EOF. */
async function readAll(stream: Readable | undefined): Promise<string> {
  if (stream === undefined) throw new Error('process stream was not published')
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    stream.once('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    stream.once('error', reject)
    stream.resume()
  })
}

const config = (): Config => ({
  wsl: shim,
  distro: 'Ubuntu-Test',
  workspace,
  helper: helperEntry,
  launch: { kind: 'node-script', node: process.execPath, nodeArgs: ['--import', 'tsx/esm'] },
  leaseMs: 30_000,
})

describe.skipIf(process.platform === 'win32')('WSL connection', () => {
  let ctx: Context

  beforeAll(async () => {
    const scratch = join(repositoryRoot, 'tmp')
    await mkdir(scratch, { recursive: true })
    workspace = await realpath(await mkdtemp(join(scratch, 'wsl-connection-')))
    ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(WslConnection, config())
    await ctx.plugin(SshFileSystem)
    await ctx.plugin(SshSubprocessRuntime)
  }, 60_000)

  afterAll(async () => {
    await ctx?.fiber.dispose()
    if (workspace !== '') await rm(workspace, { recursive: true, force: true })
  })

  it('reads, writes and guards files in the distribution workspace', async () => {
    const target = await ctx.fs.resolve('note.txt')
    const created = await ctx.fs.writeText(target, 'first', { kind: 'createIfAbsent' })
    expect(created).toMatchObject({ operation: 'create', before: null, after: 'first' })
    const updated = await ctx.fs.writeText(target, 'second', { kind: 'replaceIfVersion', version: created.version })
    expect(updated.after).toBe('second')
    await expect(ctx.fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: created.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    expect(await ctx.fs.readText(target)).toBe('second')
    const directory = await ctx.fs.resolve('.')
    expect((await ctx.fs.listDir(directory)).map(entry => entry.name)).toContain('note.txt')
  })

  it('runs a process and returns its output through the relayed streams', async () => {
    const handle = ctx.subprocess.spawn({
      argv: ['/bin/sh', '-c', 'uname -s; pwd'], cwd: workspace,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 5000,
    })
    const out = await readAll(handle.stdout)
    const err = await readAll(handle.stderr)
    expect(await handle.done).toMatchObject({ exitCode: 0, signal: null })
    expect(err).toBe('')
    const platform = process.platform === 'darwin' ? 'Darwin' : 'Linux'
    expect(out).toBe(`${platform}\n${workspace}\n`)
  }, 30_000)
})

describe.skipIf(process.platform === 'win32')('WSL startup failures', () => {
  it('reports an unknown distribution with wsl diagnostics', async () => {
    const ctx = new Context()
    const connection = new WslConnection(ctx, { ...config(), distro: 'missing-distro' })
    try { await expect(connection.ready).rejects.toThrow(/missing-distro/u) }
    finally { await connection.dispose(); await ctx.fiber.dispose() }
  })

  it('reports a missing WSL executable', async () => {
    const ctx = new Context()
    const connection = new WslConnection(ctx, { ...config(), wsl: '/nonexistent/wsl.exe' })
    try { await expect(connection.ready).rejects.toThrow(/WSL executable not found/u) }
    finally { await connection.dispose(); await ctx.fiber.dispose() }
  })
})
