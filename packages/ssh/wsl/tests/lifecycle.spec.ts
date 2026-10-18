/** Connection lifecycle over mocked child, relay sockets and TLS dialer; real helpers run in connection.spec.ts. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '@deepseek-ai/dsh-ssh/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { WslConnection, type Config } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn(), authenticate: vi.fn() }))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: transport.spawn,
}))
vi.mock('node:net', async importOriginal => ({
  ...await importOriginal<typeof import('node:net')>(),
  createConnection: transport.connect,
}))
vi.mock('@deepseek-ai/dsh-ssh/stream-security', () => ({ authenticateStream: transport.authenticate }))

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stubborn = false
  readonly kill = vi.fn((signal: NodeJS.Signals): boolean => {
    if (this.stubborn && signal === 'SIGTERM') return true
    this.exitCode = 0
    queueMicrotask(() => { this.emit('close', 0, null) })
    return true
  })
}

class FakeSocket extends EventEmitter {
  closed = false
  readonly destroy = vi.fn((_error?: Error): this => {
    if (this.closed) return this
    this.closed = true
    queueMicrotask(() => { this.emit('close') })
    return this
  })
}

interface HelloOptions {
  platform?: string
  kind?: 'node-script' | 'executable'
  hash?: string
}

interface InstallOptions {
  hello?: HelloOptions | 'ignore'
  heartbeat?: 'ok' | 'ignore'
  close?: 'ok' | 'reject'
  stubborn?: boolean
}

const baseConfig: Config = {
  wsl: '/fake/wsl.exe',
  distro: 'Ubuntu-Test',
  workspace: '/workspace',
  helper: '/opt/helper.mjs',
  launch: { kind: 'node-script', node: '/usr/bin/node' },
  requestTimeoutMs: 200,
  leaseMs: 3000,
}

const helloRequest = z.looseObject({ workspace: z.string() })
const peers: SshRpcPeer[] = []
const authenticatedSockets: FakeSocket[] = []
let ctx: Context | undefined
let connection: WslConnection | undefined
let connectionChild: FakeChild | undefined

/** Mount a helper-side peer over the spawned child's pipes with scripted responses. */
function install(options: InstallOptions = {}): FakeChild {
  const child = new FakeChild()
  child.stubborn = options.stubborn === true
  transport.spawn.mockReturnValue(child)
  const peer = new SshRpcPeer(child.stdin, child.stdout, 64 * 1024 * 1024, 128, async (method, params, signal) => {
    if (method === 'hello') {
      if (options.hello === 'ignore') {
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('hello aborted')) }, { once: true })
        })
      }
      const input = helloRequest.parse(params)
      return {
        protocol: SSH_PROTOCOL_VERSION,
        hash: options.hello?.hash ?? 'a'.repeat(64),
        kind: options.hello?.kind ?? 'node-script',
        platform: options.hello?.platform ?? 'linux',
        nodeVersion: 'v22.0.0',
        executable: '/usr/bin/node',
        root: '/tmp/fake-helper',
        workspace: input.workspace,
      }
    }
    if (method === 'heartbeat') {
      if (options.heartbeat === 'ignore') {
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('heartbeat aborted')) }, { once: true })
        })
      }
      return null
    }
    if (method === 'stream.relay') return { port: 4567 }
    if (method === 'close') {
      if (options.close === 'reject') throw new Error('close refused')
      return null
    }
    throw new Error(`unexpected helper request ${method}`)
  })
  peers.push(peer)
  return child
}

/** Mount one connection on its own Context so each case owns the `ssh` registration. */
function mount(options: InstallOptions = {}, overrides: Partial<Config> = {}): WslConnection {
  connectionChild = install(options)
  ctx = new Context()
  connection = new WslConnection(ctx, { ...baseConfig, ...overrides })
  return connection
}

async function connect(options: InstallOptions = {}, overrides: Partial<Config> = {}): Promise<WslConnection> {
  const mounted = mount(options, overrides)
  await mounted.ready
  return mounted
}

beforeEach(() => {
  transport.spawn.mockReset()
  transport.connect.mockReset().mockImplementation(() => {
    const socket = new FakeSocket()
    queueMicrotask(() => { socket.emit('connect') })
    return socket
  })
  authenticatedSockets.length = 0
  transport.authenticate.mockReset().mockImplementation(async () => {
    const socket = new FakeSocket()
    authenticatedSockets.push(socket)
    return socket
  })
})

afterEach(async () => {
  await connection?.dispose().catch(() => {})
  connection = undefined
  connectionChild = undefined
  await ctx?.fiber.dispose()
  ctx = undefined
  for (const peer of peers.splice(0)) peer.close()
})

describe.skipIf(process.platform === 'win32')('WSL connection lifecycle', () => {
  it('reports PTC launch only for a self-contained executable helper', async () => {
    const pending = mount({ hello: 'ignore' })
    expect(() => pending.ptcLaunch).toThrow('not ready')
    await pending.dispose()

    const script = await connect()
    expect(() => script.ptcLaunch).toThrow('self-contained helper executable')

    const executable = await connect({ hello: { kind: 'executable' } }, { launch: { kind: 'executable' } })
    expect(executable.ptcLaunch).toEqual({ kind: 'embedded', executable: '/usr/bin/node' })
  })

  it('fails readiness with spawn, handshake and identity errors', async () => {
    const erroredChild = new FakeChild()
    transport.spawn.mockReturnValue(erroredChild)
    const errored = new Error('spawn /fake/wsl.exe ENOENT') as NodeJS.ErrnoException
    errored.code = 'ENOENT'
    ctx = new Context()
    connection = new WslConnection(ctx, baseConfig)
    erroredChild.emit('error', errored)
    await expect(connection.ready).rejects.toThrow('WSL executable not found')
    await expect(connection.request('heartbeat', {}, z.null())).rejects.toThrow('WSL executable not found')
    await connection.dispose()

    const closing = mount()
    connectionChild?.stderr.write(Buffer.from('wsl: '.repeat(2500), 'utf16le'))
    connectionChild?.stderr.write(Buffer.from('wsl: '.repeat(2500), 'utf16le'))
    connectionChild?.emit('close', 1, null)
    await expect(closing.ready).rejects.toThrow('WSL helper disconnected')
    await closing.dispose()

    const silent = mount()
    connectionChild?.emit('close', 1, null)
    await expect(silent.ready).rejects.toThrow('WSL helper disconnected')
    await silent.dispose()

    await expect(connect({ hello: { platform: 'darwin' } })).rejects.toThrow('a Linux distribution is required')
    await expect(connect({ hello: { kind: 'executable' } })).rejects.toThrow('runtime differs from the configured launch kind')
    await expect(connect({ hello: { hash: 'b'.repeat(64) } }, { helperHash: 'c'.repeat(64) }))
      .rejects.toThrow('digest differs from the configured artifact')
  })

  it('closes the helper, sockets and child during disposal', async () => {
    mount({ close: 'reject' })
    const ready = connection
    if (ready === undefined || connectionChild === undefined) throw new Error('connection was not mounted')
    await ready.ready
    await ready.connectStream({ path: '/tmp/fake-helper/out', capability: 'd'.repeat(64) })
    await ready.connectStream({ path: '/tmp/fake-helper/err', capability: 'e'.repeat(64) })
    const first = authenticatedSockets[0]
    const second = authenticatedSockets[1]
    if (first === undefined || second === undefined) throw new Error('streams were not authenticated')
    second.closed = true
    expect(first.closed).toBe(false)
    expect(first.destroy.mock.calls.length).toBe(0)
    await ready.dispose()
    expect(first.destroy.mock.calls.length).toBe(1)
    expect(first.closed).toBe(true)
    expect(connectionChild.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('escalates to SIGKILL when the child ignores termination', async () => {
    mount({ stubborn: true }, { requestTimeoutMs: 50 })
    const ready = connection
    if (ready === undefined || connectionChild === undefined) throw new Error('connection was not mounted')
    await ready.ready
    await ready.dispose()
    expect(connectionChild.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('fails the connection when heartbeats stop arriving', async () => {
    const ready = await connect({ heartbeat: 'ignore' }, { leaseMs: 3000 })
    const stream = await ready.connectStream({ path: '/tmp/fake-helper/out', capability: 'f'.repeat(64) })
    await expect.poll(() => stream.closed, { timeout: 4000 }).toBe(true)
    await expect(ready.request('heartbeat', {}, z.null())).rejects.toThrow()
  })

  it('establishes streams through the loopback relay and reports stream failures', async () => {
    const ready = await connect()
    const stream = await ready.connectStream({ path: '/tmp/fake-helper/out', capability: 'a'.repeat(64) })
    stream.emit('error', new Error('stream reset'))
    stream.emit('close')
    expect(authenticatedSockets.at(-1)?.closed).toBe(true)

    await expect(ready.connectStream({ path: '/elsewhere/out', capability: 'a'.repeat(64) })).rejects.toThrow('invalid stream path')
    const aborted = new AbortController()
    aborted.abort(new Error('caller cancelled'))
    await expect(ready.connectStream({ path: '/tmp/fake-helper/out', capability: 'a'.repeat(64) }, aborted.signal)).rejects.toThrow('caller cancelled')

    transport.connect.mockImplementationOnce(() => {
      const socket = new FakeSocket()
      queueMicrotask(() => { socket.emit('error', new Error('connection refused')) })
      return socket
    })
    await expect(ready.connectStream({ path: '/tmp/fake-helper/out', capability: 'a'.repeat(64) })).rejects.toThrow('connection refused')

    transport.connect.mockImplementationOnce(() => {
      const socket = new FakeSocket()
      queueMicrotask(() => { socket.emit('close') })
      return socket
    })
    await expect(ready.connectStream({ path: '/tmp/fake-helper/out', capability: 'a'.repeat(64) })).rejects.toThrow('closed before stream establishment')

    for (const reason of [new Error('stream cancelled'), 'stream cancelled']) {
      const pending = new AbortController()
      transport.connect.mockImplementationOnce(() => new FakeSocket())
      const reachedConnect = transport.connect.mock.calls.length
      const connecting = ready.connectStream({ path: '/tmp/fake-helper/out', capability: 'a'.repeat(64) }, pending.signal)
      await expect.poll(() => transport.connect.mock.calls.length, { timeout: 1000 }).toBeGreaterThan(reachedConnect)
      pending.abort(reason)
      await expect(connecting).rejects.toThrow('closed before stream establishment')
    }
  })

  it('waits for in-flight stream operations before disposal completes', async () => {
    const ready = await connect()
    transport.connect.mockImplementationOnce(() => new FakeSocket())
    const pending = ready.connectStream({ path: '/tmp/fake-helper/out', capability: 'a'.repeat(64) })
    await ready.dispose()
    await expect(pending).rejects.toThrow()
  })
})
