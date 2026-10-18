/**
 * Path canonicalization for workspace identity.
 * @module @deepseek-ai/dsh-workspace/src/paths
 */

import { realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/**
 * Check whether a path names one fixed Host location without process cwd or
 * current-drive resolution.
 * @param path - Candidate Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns Whether the path is fully qualified on that platform.
 */
export function fullyQualifiedWorkspacePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/**
 * Check whether a POSIX-absolute path names a remote location rather than a
 * location fully qualified on this host (for example `/home/dev` on Windows).
 * @param path - Candidate Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns Whether the path is POSIX-absolute but not host-qualified.
 */
export function remoteWorkspacePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return !fullyQualifiedWorkspacePath(path, platform) && posix.isAbsolute(path)
}

/**
 * Derive a non-empty default title from a canonical Workspace path.
 * @param path - Canonical Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns The final segment when present, otherwise the complete root spelling.
 */
export function defaultWorkspaceTitle(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' && !remoteWorkspacePath(path, platform) ? win32 : posix
  return pathApi.basename(path) || pathApi.parse(path).root
}

/**
 * Canonicalize a fully qualified directory path via `fs.realpath`: trailing
 * slashes, `..` segments, and symlinks are all resolved. This is the ONE
 * uniqueness canon of the package — workspace paths are stored canonicalized,
 * uniqueness is string equality of canonicalized paths (a symlink to an
 * existing workspace's directory collides), and attach-time session `cwd`
 * checks go through the same canon. Relative paths reject before `realpath` can
 * resolve them from the Host cwd or current Windows drive. A path that does not
 * exist rejects with the original `ENOENT` — this is `create`'s reject path (a
 * workspace must point at an existing directory). A POSIX path that is not
 * host-qualified is a remote workspace path: it is normalized lexically here,
 * and the owning service verifies existence through its filesystem provider.
 * @param path - The path to canonicalize.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns the canonical absolute path.
 */
export async function realpathNormalize(path: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (fullyQualifiedWorkspacePath(path, platform)) return await realpath(path)
  if (remoteWorkspacePath(path, platform)) {
    const normalized = posix.normalize(path)
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  }
  throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
}

/** Result of inspecting one candidate workspace or session-cwd path. */
export interface WorkspacePathInspection {
  /** Canonical path in the namespace that owns it. */
  path: string
  /** Whether the canonical path is an existing directory, missing, or another kind. */
  kind: 'directory' | 'missing' | 'other'
}

/**
 * Whether a path belongs to a remote filesystem provider rather than the host:
 * POSIX-absolute and not host-qualified, while the mounted provider cannot map
 * it back to a host path.
 * @param fs - filesystem provider, when mounted.
 * @param path - candidate path.
 * @param platform - host platform; injectable for deterministic tests.
 * @returns whether the mounted provider owns the path.
 */
export function remoteProviderPath(fs: FileSystem | undefined, path: string, platform: NodeJS.Platform = process.platform): boolean {
  return remoteWorkspacePath(path, platform) && fs?.processPathFromHostPath(path) === undefined
}

/**
 * Inspect one candidate workspace path in the namespace that owns it.
 * @param fs - filesystem provider, when mounted.
 * @param path - candidate absolute path.
 * @param platform - host platform; injectable for deterministic tests.
 * @returns the canonical path and its kind.
 * @throws when the path is not fully qualified for its namespace or resolution fails.
 */
export async function inspectWorkspacePath(
  fs: FileSystem | undefined, path: string, platform: NodeJS.Platform = process.platform,
): Promise<WorkspacePathInspection> {
  if (!remoteProviderPath(fs, path, platform)) {
    if (!fullyQualifiedWorkspacePath(path, platform)) {
      throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
    }
    const canonical = await realpathNormalize(path, platform)
    return { path: canonical, kind: (await stat(canonical)).isDirectory() ? 'directory' : 'other' }
  }
  if (fs === undefined) throw new TypeError(`Workspace path '${path}' requires a filesystem provider`)
  const target = await fs.resolve(path)
  const canonical = fs.processPath(target)
  const info = await fs.stat(target)
  if (info === undefined) return { path: canonical, kind: 'missing' }
  return { path: canonical, kind: info.type === 'directory' ? 'directory' : 'other' }
}
