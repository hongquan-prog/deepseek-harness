/** The helper's transport is a pair of OS pipes; SSH forwarding is not part of its contract. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '../src/protocol.ts'
import {
  doneSchema, editResultSchema, entriesSchema, helloSchema, infoSchema, preparedSchema, relaySchema, targetSchema, writeResultSchema,
} from '../src/schemas.ts'
import { authenticateStream } from '../src/stream-security.ts'

const helperEntry = fileURLToPath(new URL('../src/helper-entry.ts', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const maxFrameBytes = 64 * 1024 * 1024
const maxPending = 128

const policy = (workspaceRoot: string) => ({ mode: 'workspace-write', workspaceRoot })
/** Every forwarded stream this file opened, so an interrupted test cannot leak one. */
const openSockets = new Set<Socket>()

/** Read one forwarded stream to EOF; the helper closes it with the owning process. */
async function collect(stream: Readable): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    stream.once('end', () => { resolve(Buffer.concat(chunks)) })
    stream.once('error', reject)
    stream.resume()
  })
}

/** Prove one stream capability with TLS-PSK and track every socket for teardown. */
async function authenticate(raw: Socket, capability: string): Promise<Socket> {
  openSockets.add(raw)
  raw.once('close', () => { openSockets.delete(raw) })
  try {
    await once(raw, 'connect')
    const secured = await authenticateStream(raw, capability, 5000)
    openSockets.add(secured)
    secured.once('close', () => { openSockets.delete(secured) })
    return secured
  } catch (error) {
    raw.destroy()
    openSockets.delete(raw)
    throw error
  }
}

/** Connect one reserved Unix stream endpoint. */
function connectStream(path: string, capability: string): Promise<Socket> {
  return authenticate(createConnection({ path, allowHalfOpen: true }), capability)
}

/** Connect one loopback relay publishing a reserved Unix stream endpoint. */
function connectRelay(port: number, capability: string): Promise<Socket> {
  return authenticate(createConnection({ host: '127.0.0.1', port, allowHalfOpen: true }), capability)
}

/** Resolve only when a fresh loopback connection is refused. */
async function expectRefused(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error(`relay port ${port} still accepts connections`))
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED') resolve()
      else reject(error)
    })
  })
}

describe.skipIf(process.platform === 'win32')('SSH helper over a plain child-process pipe', () => {
  let child: ChildProcessWithoutNullStreams | undefined
  let peer: SshRpcPeer | undefined
  let root = ''
  // The helper owns this private root; the last test proves it disappears.
  let helperRoot = ''
  let facts: z.infer<typeof helloSchema>
  const stderrChunks: Buffer[] = []

  const stderrText = (): string => Buffer.concat(stderrChunks).toString('utf8')

  beforeAll(async () => {
    const created = await mkdtemp('/tmp/dsh-helper-stdio-')
    try { root = await realpath(created) } catch (error) {
      await rm(created, { recursive: true, force: true })
      throw error
    }
    // The helper must not depend on SSH environment inherited from the test runner; source-plane
    // imports resolve through the root tsconfig paths, as `pnpm dsh` does.
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SSH_'))),
      TSX_TSCONFIG_PATH: join(repositoryRoot, 'tsconfig.json'),
    }
    const spawned = spawn(process.execPath, ['--import', 'tsx/esm', helperEntry], { cwd: repositoryRoot, env })
    child = spawned
    spawned.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })
    const started = new SshRpcPeer(spawned.stdout, spawned.stdin, maxFrameBytes, maxPending)
    peer = started
    try {
      facts = await started.request('hello', { protocol: SSH_PROTOCOL_VERSION, workspace: root, leaseMs: 30_000 }, helloSchema)
      helperRoot = facts.root
    } catch (error) {
      throw new Error(`helper handshake failed: ${String(error)}\nhelper stderr: ${stderrText()}`, { cause: error })
    }
  }, 60_000)

  afterAll(async () => {
    for (const socket of openSockets) socket.destroy()
    openSockets.clear()
    peer?.close()
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      // SIGTERM reaches the helper's own cleanup so a failed test leaves no private root or child.
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), new Promise((resolve) => { setTimeout(resolve, 5000).unref() })])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    if (helperRoot !== '') await rm(helperRoot, { recursive: true, force: true })
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  it('negotiates the workspace and reports the source-launched helper identity', () => {
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux'
    expect(facts).toMatchObject({ protocol: SSH_PROTOCOL_VERSION, kind: 'node-script', platform, workspace: root })
    expect(facts.nodeVersion).toBe(process.version)
  })

  it('lists, reads, writes, edits and guards versions through the pipe', async () => {
    if (peer === undefined) throw new Error('helper was not started')
    const target = await peer.request('fs.resolve', { path: 'note.txt' }, targetSchema)
    const created = await peer.request('fs.write', {
      target, content: 'first', expected: { kind: 'createIfAbsent' }, policy: policy(root),
    }, writeResultSchema)
    expect(created).toMatchObject({ operation: 'create', before: null, after: 'first' })
    await expect(peer.request('fs.write', {
      target, content: 'stale', expected: { kind: 'replaceIfVersion', version: 'stale' }, policy: policy(root),
    }, writeResultSchema)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    const written = await peer.request('fs.write', {
      target, content: 'second', expected: { kind: 'replaceIfVersion', version: created.version }, policy: policy(root),
    }, writeResultSchema)
    const edited = await peer.request('fs.edit', {
      target, edit: { oldString: 'second', newString: 'third', replaceAll: false },
      expected: { version: written.version }, policy: policy(root),
    }, editResultSchema)
    expect(edited.after).toBe('third')
    expect(await peer.request('fs.readText', { target }, z.string())).toBe('third')
    expect(await peer.request('fs.stat', { target }, infoSchema)).toMatchObject({ type: 'file', size: 5 })
    const directory = await peer.request('fs.resolve', { path: '.' }, targetSchema)
    expect((await peer.request('fs.list', { target: directory }, entriesSchema)).map(entry => entry.name)).toContain('note.txt')
  })

  it('runs a child process and returns its output through the forwarded streams', async () => {
    if (peer === undefined) throw new Error('helper was not started')
    const prepared = await peer.request('process.prepare', {
      argv: ['/bin/sh', '-c', 'uname -s; pwd'], cwd: root, graceMs: 5000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    }, preparedSchema)
    const stdoutEndpoint = prepared.streams.stdout
    const stderrEndpoint = prepared.streams.stderr
    if (stdoutEndpoint === undefined || stderrEndpoint === undefined) throw new Error('helper did not publish stdout and stderr endpoints')
    const stdoutSocket = await connectStream(stdoutEndpoint.path, stdoutEndpoint.capability)
    const stderrSocket = await connectStream(stderrEndpoint.path, stderrEndpoint.capability)
    const outputs = Promise.all([collect(stdoutSocket), collect(stderrSocket)])
    // A failed start/done must not surface the stream rejections as unhandled errors.
    void outputs.catch(() => {})
    await peer.request('process.start', { id: prepared.id }, z.object({}).strict())
    const done = await peer.request('process.done', { id: prepared.id }, doneSchema)
    const [out, err] = await outputs
    expect(done.outcome).toMatchObject({ exitCode: 0, signal: null })
    expect(err.toString('utf8')).toBe('')
    const platform = process.platform === 'darwin' ? 'Darwin' : 'Linux'
    expect(out.toString('utf8')).toBe(`${platform}\n${root}\n`)
  }, 30_000)

  it('republishes one reserved stream on loopback TCP', async () => {
    if (peer === undefined) throw new Error('helper was not started')
    const prepared = await peer.request('process.prepare', {
      argv: ['/bin/sh', '-c', 'printf relayed'], cwd: root, graceMs: 5000,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    }, preparedSchema)
    const stdoutEndpoint = prepared.streams.stdout
    const stderrEndpoint = prepared.streams.stderr
    if (stdoutEndpoint === undefined || stderrEndpoint === undefined) throw new Error('helper did not publish stdout and stderr endpoints')
    await expect(peer.request('stream.relay', { path: '/etc/hosts' }, relaySchema)).rejects.toThrow('outside the helper root')
    const relay = await peer.request('stream.relay', { path: stdoutEndpoint.path }, relaySchema)
    const outputs = Promise.all([
      collect(await connectRelay(relay.port, stdoutEndpoint.capability)),
      collect(await connectStream(stderrEndpoint.path, stderrEndpoint.capability)),
    ])
    void outputs.catch(() => {})
    await peer.request('process.start', { id: prepared.id }, z.object({}).strict())
    const done = await peer.request('process.done', { id: prepared.id }, doneSchema)
    const [out, err] = await outputs
    expect(done.outcome).toMatchObject({ exitCode: 0, signal: null })
    expect(out.toString('utf8')).toBe('relayed')
    expect(err.toString('utf8')).toBe('')
    await expectRefused(relay.port)
  })

  it('closes its private root when the transport ends', async () => {
    if (peer === undefined || child === undefined) throw new Error('helper was not started')
    await access(helperRoot)
    const exited = once(child, 'exit')
    child.stdin.end()
    await exited
    expect(child.exitCode).toBe(0)
    await expect(access(helperRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
