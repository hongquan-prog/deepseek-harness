/** WSL execution world: one helper process per connection over wsl.exe stdio and loopback streams. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { HelperPtcLaunch, SshHello, SshService } from '@deepseek-ai/dsh-ssh'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '@deepseek-ai/dsh-ssh/protocol'
import { helloSchema, relaySchema, type SshStreamEndpoint } from '@deepseek-ai/dsh-ssh/schemas'
import { authenticateStream } from '@deepseek-ai/dsh-ssh/stream-security'

/** Installed helper invocation inside the distribution. */
export type WslHelperLaunch = {
  /** Run the helper entry with the distribution's own Node executable. */
  kind: 'node-script'
  /** Absolute Node executable inside the distribution. */
  node: string
  /** Node CLI options before the entry (source deployments use the tsx loader). */
  nodeArgs?: string[]
} | {
  /** Run a self-contained helper executable. */
  kind: 'executable'
}

/** The launch coordinates that select one distribution, workspace and helper. */
export interface WslLaunchTarget {
  /** Windows `wsl.exe` path or command name. */
  wsl: string
  /** Installed distribution name passed to `-d`. */
  distro: string
  /** Absolute directory inside the distribution; becomes the helper process cwd. */
  workspace: string
  /** Absolute helper entry inside the distribution. */
  helper: string
  /** Invocation shape for that helper. */
  launch: WslHelperLaunch
}

/** Environment variables that supply deployment coordinates missing from configuration. */
export const WSL_ENV = {
  wsl: 'DSH_WSL_EXE',
  distro: 'DSH_WSL_DISTRO',
  workspace: 'DSH_WSL_WORKSPACE',
  helper: 'DSH_WSL_HELPER',
  node: 'DSH_WSL_NODE',
  nodeArgs: 'DSH_WSL_NODE_ARGS',
  helperHash: 'DSH_WSL_HELPER_HASH',
} as const

/**
 * Deployment-owned WSL configuration. Explicit fields win over {@link WSL_ENV};
 * a field absent from both sources fails startup instead of defaulting silently.
 */
export interface Config {
  /** Windows `wsl.exe` path or command name; falls back to `DSH_WSL_EXE`, then `wsl.exe`. */
  wsl?: string
  /** Installed distribution name passed to `-d`; falls back to `DSH_WSL_DISTRO`. */
  distro?: string
  /** Absolute directory inside the distribution; falls back to `DSH_WSL_WORKSPACE`. */
  workspace?: string
  /** Absolute helper entry inside the distribution; falls back to `DSH_WSL_HELPER`. */
  helper?: string
  /** Helper invocation; falls back to a node-script launch from `DSH_WSL_NODE`. */
  launch?: WslHelperLaunch
  /** Lowercase SHA-256 of the installed helper; falls back to `DSH_WSL_HELPER_HASH`. */
  helperHash?: string
  /** Administrative request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
}

const configSchema = z.object({
  wsl: z.string().min(1).refine(value => !/[\0\r\n]/u.test(value), 'expected a command without control characters').default('wsl.exe'),
  distro: z.string().min(1).refine(value => !/[\0\r\n]/u.test(value), 'expected a distribution name without control characters'),
  workspace: z.string().startsWith('/').refine(value => !value.includes('\0'), 'expected an absolute POSIX path'),
  helper: z.string().startsWith('/').refine(value => !value.includes('\0'), 'expected an absolute POSIX path'),
  launch: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('node-script'),
      node: z.string().startsWith('/').refine(value => !value.includes('\0'), 'expected an absolute POSIX path'),
      nodeArgs: z.array(z.string().refine(value => !value.includes('\0'), 'expected an argument without NUL')).default([]),
    }).strict(),
    z.object({ kind: z.literal('executable') }).strict(),
  ]),
  helperHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  requestTimeoutMs: z.number().int().positive().max(2_147_483_647).default(30_000),
  maxFrameBytes: z.number().int().positive().max(64 * 1024 * 1024).default(64 * 1024 * 1024),
  maxPending: z.number().int().positive().max(128).default(128),
  leaseMs: z.number().int().min(3000).max(600_000).default(30_000),
}).strict()

type ResolvedConfig = z.infer<typeof configSchema>

/**
 * Resolve deployment coordinates from explicit configuration over environment defaults.
 * @param input - partial connection configuration; every explicit field wins.
 * @param env - environment holding {@link WSL_ENV} fallbacks.
 * @returns the validated, complete connection configuration.
 * @throws when a required coordinate is absent from both sources or invalid.
 */
export function resolveWslConfig(input: Config, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const present = (value: string | undefined): string | undefined => value === undefined || value === '' ? undefined : value
  const fromEnvironment = (name: keyof typeof WSL_ENV): string | undefined => present(env[WSL_ENV[name]])
  const required = (field: 'distro' | 'workspace' | 'helper'): string => {
    const value = present(input[field]) ?? fromEnvironment(field)
    if (value === undefined) {
      throw new Error(`WSL configuration is missing '${field}'; set config.${field} or ${WSL_ENV[field]}`)
    }
    return value
  }
  let launch = input.launch
  if (launch === undefined) {
    const node = fromEnvironment('node')
    if (node !== undefined) {
      const rawArgs = fromEnvironment('nodeArgs')
      let nodeArgs: string[] | undefined
      if (rawArgs !== undefined) {
        try { nodeArgs = z.array(z.string()).parse(JSON.parse(rawArgs)) }
        catch (error) {
          throw new Error(`WSL environment ${WSL_ENV.nodeArgs} must be a JSON array of strings`, { cause: error })
        }
      }
      launch = { kind: 'node-script', node, ...(nodeArgs === undefined ? {} : { nodeArgs }) }
    }
  }
  if (launch === undefined) {
    throw new Error(`WSL configuration is missing 'launch'; set config.launch or ${WSL_ENV.node}`)
  }
  return configSchema.parse({
    wsl: present(input.wsl) ?? fromEnvironment('wsl') ?? 'wsl.exe',
    distro: required('distro'),
    workspace: required('workspace'),
    helper: required('helper'),
    launch,
    helperHash: present(input.helperHash) ?? fromEnvironment('helperHash'),
    requestTimeoutMs: input.requestTimeoutMs,
    maxFrameBytes: input.maxFrameBytes,
    maxPending: input.maxPending,
    leaseMs: input.leaseMs,
  })
}

/**
 * Build the `wsl.exe` argument list that starts one helper inside a distribution.
 * @param target - selected distribution, workspace and helper invocation.
 * @returns arguments after the WSL executable itself.
 */
export function wslHelperArgs(target: WslLaunchTarget): string[] {
  const command = target.launch.kind === 'node-script'
    ? [target.launch.node, ...(target.launch.nodeArgs ?? []), target.helper]
    : [target.helper]
  return ['-d', target.distro, '--cd', target.workspace, '--', ...command]
}

/** One WSL-run helper connection consumed by the filesystem, subprocess and sandbox providers. */
export class WslConnection extends Service implements SshService {
  static Config: schema<Config> = schema.object({
    wsl: schema.string(),
    distro: schema.string(),
    workspace: schema.string(),
    helper: schema.string(),
    launch: schema.union([
      schema.object({
        kind: schema.const('node-script').required(),
        node: schema.string().required(),
        nodeArgs: schema.array(schema.string()),
      }),
      schema.object({ kind: schema.const('executable').required() }),
    ]),
    helperHash: schema.string(),
    requestTimeoutMs: schema.number().default(30_000),
    maxFrameBytes: schema.number().default(64 * 1024 * 1024),
    maxPending: schema.number().default(128),
    leaseMs: schema.number().default(30_000),
  })

  /** Verified helper coordinates; callers must await this before remote work. */
  readonly ready: Promise<SshHello>
  private readonly config: ResolvedConfig
  private rpc: SshRpcPeer | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly sockets = new Set<Socket>()
  private readonly diagnostics: Buffer[] = []
  private diagnosticBytes = 0
  private disposal: Promise<void> | undefined
  private failure: Error | undefined
  private remote: SshHello | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    this.config = resolveWslConfig(config)
    this.ready = this.start()
    void this.ready.catch((error: unknown) => {
      /* v8 ignore next -- start rejects only Error values. */
      this.fail(error instanceof Error ? error : new Error(String(error)))
    })
    ctx.effect(() => () => this.dispose())
  }

  /** Hold plugin readiness until the helper identity and platform are verified. */
  async [Service.init](): Promise<void> { await this.ready }

  /**
   * Send one helper operation; cancellation never replays an ambiguous mutation.
   * @param method - the private helper operation.
   * @param params - JSON request fields validated by the helper.
   * @param result - response validation before returning provider-visible data.
   * @param signal - cancellation, which does not undo completed remote effects.
   * @param wait - allow a process observation to outlast the administrative deadline.
   * @returns the validated remote result.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait = false): Promise<T> {
    this.assertOpen()
    await this.ready
    this.assertOpen()
    const rpc = this.rpc
    /* v8 ignore next -- readiness rejects before a resolved connection can lack its transport. */
    if (rpc === undefined) throw new Error('WSL connection has no helper transport')
    const bounded = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    return await rpc.request(method, params, result, bounded)
  }

  /**
   * Open one authenticated stream endpoint through the helper's loopback relay.
   * @param endpoint - private coordinates issued by this connection's helper.
   * @param signal - cancellation of allocation and the resulting socket.
   * @returns a paused socket; attach a consumer before resuming it.
   */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    return await this.track(this.establishStream(endpoint, signal))
  }

  /** PTC launch configuration; WSL supports only a self-contained helper executable. */
  get ptcLaunch(): HelperPtcLaunch {
    const hello = this.remote
    if (hello === undefined) throw new Error('WSL helper is not ready')
    if (this.config.launch.kind !== 'executable') throw new Error('WSL PTC requires a self-contained helper executable')
    return { kind: 'embedded', executable: hello.executable }
  }

  /** Release helper-owned resources and transport. */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async establishStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    const hello = await this.ready
    this.assertOpen()
    const rpc = this.rpc
    /* v8 ignore next -- readiness rejects before a resolved connection can lack its transport. */
    if (rpc === undefined) throw new Error('WSL connection has no helper transport')
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    if (!endpoint.path.startsWith(`${hello.root}/`) || /[:\r\n\0]/u.test(endpoint.path)) throw new Error('WSL helper returned an invalid stream path')
    combined.throwIfAborted()
    const relay = await rpc.request('stream.relay', { path: endpoint.path }, relaySchema,
      AbortSignal.any([combined, AbortSignal.timeout(this.config.requestTimeoutMs)]))
    const socket = createConnection({ host: '127.0.0.1', port: relay.port, allowHalfOpen: true })
    this.sockets.add(socket)
    socket.once('close', () => { this.sockets.delete(socket) })
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          combined.removeEventListener('abort', aborted)
          socket.off('connect', connected)
          socket.off('error', failed)
          socket.off('close', closed)
        }
        const connected = (): void => { cleanup(); resolve() }
        const failed = (error: Error): void => { cleanup(); reject(error) }
        const closed = (): void => { failed(new Error('WSL relay closed before stream establishment')) }
        const aborted = (): void => {
          socket.destroy(combined.reason instanceof Error ? combined.reason : new Error(String(combined.reason)))
        }
        socket.once('connect', connected)
        socket.once('error', failed)
        socket.once('close', closed)
        combined.addEventListener('abort', aborted, { once: true })
      })
      const authenticated = await authenticateStream(socket, endpoint.capability, this.config.requestTimeoutMs, combined)
      this.sockets.add(authenticated)
      authenticated.on('error', () => { authenticated.destroy() })
      authenticated.once('close', () => { this.sockets.delete(authenticated) })
      return authenticated
    } catch (error) {
      socket.destroy()
      this.sockets.delete(socket)
      throw error
    }
  }

  private async start(): Promise<SshHello> {
    /* v8 ignore next -- start runs during construction, before disposal can set closed. */
    if (this.closed) throw new Error('WSL connection closed before startup')
    const child = spawn(this.config.wsl, wslHelperArgs(this.config), { windowsHide: true })
    this.child = child
    this.childClosed = new Promise((resolve) => { child.once('close', () => { resolve() }) })
    child.stderr.on('data', (chunk: Buffer) => { this.recordDiagnostics(chunk) })
    child.once('error', (error: Error) => { this.fail(error) })
    child.once('close', () => { this.fail(new Error('WSL helper disconnected; remote outcomes and cleanup are unknown')) })
    const rpc = new SshRpcPeer(child.stdout, child.stdin, this.config.maxFrameBytes, this.config.maxPending)
    this.rpc = rpc
    rpc.once('closed', (error: Error) => { this.fail(error) })
    let hello: SshHello
    try {
      hello = await rpc.request('hello', {
        protocol: SSH_PROTOCOL_VERSION, workspace: this.config.workspace, leaseMs: this.config.leaseMs,
      }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    } catch (error) {
      /* v8 ignore next -- the peer rejects only Error values. */
      throw this.diagnosed(error instanceof Error ? error : new Error(String(error)))
    }
    if (hello.platform !== 'linux') throw new Error(`WSL helper reported '${hello.platform}'; a Linux distribution is required`)
    if (hello.kind !== this.config.launch.kind) throw new Error('WSL helper runtime differs from the configured launch kind')
    if (this.config.helperHash !== undefined && hello.hash !== this.config.helperHash) throw new Error('WSL helper digest differs from the configured artifact')
    this.remote = hello
    this.startHeartbeat(rpc)
    return hello
  }

  private startHeartbeat(rpc: SshRpcPeer): void {
    let pending: Promise<unknown> | undefined
    this.heartbeat = setInterval(() => {
      pending ??= rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(Math.floor(this.config.leaseMs / 2)))
        .catch((error: unknown) => {
          /* v8 ignore next -- the peer rejects only Error values. */
          this.fail(error instanceof Error ? error : new Error(String(error)))
        })
        .finally(() => { pending = undefined })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new Error('WSL connection is closing'))
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      await this.ready.catch(() => {})
      if (this.failure === undefined && this.rpc !== undefined) {
        await this.rpc.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs)).catch(() => {})
      }
    } finally {
      this.rpc?.close()
      // TLS wrappers release their reads before their underlying sockets close.
      const socketClosures = [...this.sockets].reverse().map(socket => new Promise<void>((resolve) => {
        if (socket.closed) {
          resolve()
          return
        }
        socket.once('close', () => { resolve() })
        socket.destroy()
      }))
      this.child?.kill('SIGTERM')
      const force = setTimeout(() => { this.child?.kill('SIGKILL') }, this.config.requestTimeoutMs)
      try { await this.childClosed } finally { clearTimeout(force) }
      await Promise.all(socketClosures)
      /* v8 ignore next -- streams settle on lifetime abort, so the drain is a defensive guard. */
      while (this.operations.size > 0) await Promise.allSettled([...this.operations])
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('WSL connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation) }).catch(() => {})
    return operation
  }

  private fail(reason: Error): void {
    // Disposal owns its own teardown; transport events after that are not failures.
    if (this.closed || this.failure !== undefined) return
    const detail = 'code' in reason && reason.code === 'ENOENT'
      ? `WSL executable not found: '${this.config.wsl}'`
      : reason.message
    const diagnostics = this.diagnosticsText()
    this.failure = diagnostics === ''
      ? new Error(detail, { cause: reason })
      : new Error(`${detail}\nWSL diagnostics: ${diagnostics}`, { cause: reason })
    this.lifetime.abort(this.failure)
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.rpc?.close(this.failure)
    for (const socket of [...this.sockets].reverse()) socket.destroy(this.failure)
    this.child?.kill('SIGTERM')
  }

  private diagnosed(reason: Error): Error {
    const diagnostics = this.diagnosticsText()
    return diagnostics === '' ? reason : new Error(`${reason.message}\nWSL diagnostics: ${diagnostics}`, { cause: reason })
  }

  private recordDiagnostics(chunk: Buffer): void {
    this.diagnostics.push(chunk)
    this.diagnosticBytes += chunk.length
    while (this.diagnosticBytes > 8192 && this.diagnostics.length > 1) {
      const dropped = this.diagnostics.shift()
      /* v8 ignore next -- the loop condition guarantees a buffered chunk. */
      if (dropped === undefined) break
      this.diagnosticBytes -= dropped.length
    }
  }

  private diagnosticsText(): string {
    const buffer = Buffer.concat(this.diagnostics)
    // wsl.exe emits UTF-16LE diagnostics; the helper's own stderr is UTF-8.
    const text = buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')
    return text.replaceAll('\0', '').trim().slice(0, 4000)
  }
}

export default WslConnection
