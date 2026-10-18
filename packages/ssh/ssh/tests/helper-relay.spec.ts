/** Loopback relay containment and lifetime; the helper RPC path is covered by the stdio spec. */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamRelays } from '../src/helper-relay.ts'

/** Resolve only when a fresh loopback connection is refused. */
async function refused(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED') resolve(true)
      else reject(error)
    })
  })
}

describe('StreamRelays', () => {
  let root = ''
  let relays: StreamRelays | undefined

  afterEach(async () => {
    await relays?.close()
    relays = undefined
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  it('rejects stream paths outside the helper root', async () => {
    root = await mkdtemp('/tmp/dsh-relay-')
    relays = new StreamRelays(root)
    await expect(relays.open('/etc/hosts')).rejects.toThrow('outside the helper root')
    await expect(relays.open(`${root}/../elsewhere`)).rejects.toThrow('outside the helper root')
    await expect(relays.open(`${root}/a\0b`)).rejects.toThrow('outside the helper root')
  })

  it('closes a relay with an active bridge', async () => {
    root = await mkdtemp('/tmp/dsh-relay-')
    const upstream = createServer((socket) => {
      socket.on('error', () => {})
      socket.write('upstream')
    })
    await new Promise<void>((resolve) => { upstream.listen(join(root, 'stdout'), resolve) })
    try {
      relays = new StreamRelays(root)
      const { port } = await relays.open(join(root, 'stdout'))
      const client = createConnection({ host: '127.0.0.1', port })
      client.on('error', () => {})
      await once(client, 'connect')
      const received = await new Promise<string>((resolve, reject) => {
        client.once('data', (chunk: Buffer) => { resolve(chunk.toString()) })
        client.once('error', reject)
      })
      expect(received).toBe('upstream')
      await relays.close()
      await once(client, 'close')
    } finally {
      upstream.close()
    }
  })

  it('bounds concurrently published relays', async () => {
    root = await mkdtemp('/tmp/dsh-relay-')
    relays = new StreamRelays(root, 30_000, 2)
    await relays.open(join(root, 'one'))
    await relays.open(join(root, 'two'))
    await expect(relays.open(join(root, 'three'))).rejects.toThrow('capacity unavailable')
  })

  it('expires an unconnected relay and closes a published one on shutdown', async () => {
    root = await mkdtemp('/tmp/dsh-relay-')
    relays = new StreamRelays(root, 25)
    const expired = await relays.open(join(root, 'stdout'))
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    expect(await refused(expired.port)).toBe(true)
    const published = await relays.open(join(root, 'stderr'))
    expect(await refused(published.port)).toBe(false)
    await relays.close()
    expect(await refused(published.port)).toBe(true)
  })
})
