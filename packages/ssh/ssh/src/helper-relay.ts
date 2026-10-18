/** Loopback TCP bridges to private Unix stream endpoints for clients that cannot open them. */
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { posix } from 'node:path'
import { SSH_MAX_PROCESS_HANDLES } from './protocol.ts'

/** One published loopback listener and every socket it owns. */
interface Relay {
  readonly server: Server
  readonly sockets: Set<Socket>
  timer?: NodeJS.Timeout
}

/**
 * Owns the loopback relays of one helper and releases them on helper shutdown.
 * A relay republishes one reserved Unix stream endpoint on an ephemeral
 * `127.0.0.1` port; it forwards opaque bytes, so TLS-PSK still runs between the
 * real client and the reserved endpoint.
 */
export class StreamRelays {
  private readonly relays = new Set<Relay>()
  private readonly root: string

  /**
   * @param root - the helper's private stream root; only paths below it are relayable.
   * @param idleMs - how long an unconnected relay stays published.
   * @param maxRelays - concurrent published relays; bounds ports and timers one client can hold.
   */
  constructor(
    root: string,
    private readonly idleMs = 30_000,
    private readonly maxRelays = SSH_MAX_PROCESS_HANDLES * 4,
  ) {
    this.root = posix.normalize(root)
  }

  /**
   * Publish one reserved Unix stream endpoint on an ephemeral loopback TCP port.
   * The first accepted connection is bridged byte-for-byte; the listener then closes.
   * @param path - a stream endpoint below the helper's private root.
   * @returns the loopback port a forwarded client can connect to.
   * @throws when the path is outside the private root or the listener cannot bind.
   */
  async open(rawPath: string): Promise<{ port: number }> {
    const path = posix.normalize(rawPath)
    if (!path.startsWith(`${this.root}/`) || path.includes('\0')) {
      throw new Error('SSH relay path is outside the helper root')
    }
    if (this.relays.size >= this.maxRelays) throw new Error('SSH relay capacity unavailable')
    const sockets = new Set<Socket>()
    const server = createServer({ allowHalfOpen: true }, (client) => {
      clearTimeout(relay.timer)
      server.close()
      const upstream = createConnection({ path, allowHalfOpen: true })
      sockets.add(client)
      sockets.add(upstream)
      const teardown = (): void => {
        client.destroy()
        upstream.destroy()
        sockets.delete(client)
        sockets.delete(upstream)
        void this.closeRelay(relay)
      }
      client.on('error', teardown)
      upstream.on('error', teardown)
      client.on('close', teardown)
      upstream.on('close', teardown)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    const relay: Relay = { server, sockets }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.relays.add(relay)
    /* v8 ignore next -- A listener error after bind is not deterministically reachable; it only retires the relay. */
    server.on('error', () => { void this.closeRelay(relay) })
    relay.timer = setTimeout(() => { void this.closeRelay(relay) }, this.idleMs)
    relay.timer.unref()
    const address = server.address()
    /* v8 ignore next -- A listening TCP server always reports an AddressInfo. */
    if (address === null || typeof address === 'string') throw new Error('SSH relay did not publish a loopback port')
    return { port: address.port }
  }

  /** Close every published relay and bridge. */
  async close(): Promise<void> {
    await Promise.all([...this.relays].map(async (relay) => { await this.closeRelay(relay) }))
  }

  private async closeRelay(relay: Relay): Promise<void> {
    if (!this.relays.delete(relay)) return
    clearTimeout(relay.timer)
    for (const socket of relay.sockets) socket.destroy()
    relay.sockets.clear()
    await new Promise<void>((resolve) => { relay.server.close(() => { resolve() }) })
  }
}
