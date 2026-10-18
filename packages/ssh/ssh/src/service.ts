/** The helper-connection surface shared by SSH and alternative execution transports. */
import type { Socket } from 'node:net'
import type { z } from 'zod'
import type { helloSchema, SshStreamEndpoint } from './schemas.ts'

/** Verified helper identity returned by the `hello` handshake. */
export type SshHello = z.infer<typeof helloSchema>

/** PTC worker launch exposed by a helper that carries its own runtime. */
export type HelperPtcLaunch =
  | { kind: 'embedded'; executable: string }
  | { kind: 'node-script'; executable: string; bootstrapPath: string }

/**
 * One version-matched helper connection consumed by the filesystem, subprocess
 * and sandbox providers.
 */
export interface SshService {
  /** Verified helper coordinates; callers await this before remote work. */
  readonly ready: Promise<SshHello>
  /**
   * Send one administrative request.
   * @param method - the private helper operation.
   * @param params - JSON request fields validated by the helper.
   * @param result - validation for the remote response.
   * @param signal - cancellation; completed remote effects are not rolled back.
   * @param wait - allow a process observation to outlast the administrative deadline.
   * @returns the validated remote result.
   */
  request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait?: boolean): Promise<T>
  /**
   * Open one authenticated stream endpoint published by this connection's helper.
   * @param endpoint - private coordinates issued by the helper.
   * @param signal - cancellation of stream allocation and the resulting socket.
   * @returns a paused socket; attach a consumer before resuming it.
   */
  connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket>
  /** PTC launch configuration; implementations throw when their helper carries no runtime. */
  readonly ptcLaunch: HelperPtcLaunch
  /** Release helper-owned resources and transport. */
  dispose(): Promise<void>
}
