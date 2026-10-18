/** Remote workspace paths normalize without touching the host filesystem. */
import { describe, expect, it } from 'vitest'
import { defaultWorkspaceTitle, inspectWorkspacePath, realpathNormalize, remoteProviderPath, remoteWorkspacePath } from '../src/paths.ts'

describe('remote workspace paths', () => {
  it('classifies POSIX-absolute non-host paths as remote', () => {
    expect(remoteWorkspacePath('/home/dev/project', 'win32')).toBe(true)
    expect(remoteWorkspacePath('/home/dev', 'linux')).toBe(false)
    expect(remoteWorkspacePath('C:\\dev', 'win32')).toBe(false)
    expect(remoteWorkspacePath('relative', 'win32')).toBe(false)
  })

  it('normalizes remote paths lexically instead of touching the host filesystem', async () => {
    expect(await realpathNormalize('/home/dev/../dev//project/', 'win32')).toBe('/home/dev/project')
    expect(await realpathNormalize('/home/dev/project', 'win32')).toBe('/home/dev/project')
  })

  it('derives remote titles from POSIX segments', () => {
    expect(defaultWorkspaceTitle('/home/dev/project', 'win32')).toBe('project')
    expect(defaultWorkspaceTitle('C:\\dev\\project', 'win32')).toBe('project')
  })

  it('still rejects relative paths', async () => {
    await expect(realpathNormalize('relative', 'win32')).rejects.toThrow('not fully qualified')
  })

  it('inspects remote paths through the mounted filesystem', async () => {
    const fs: {
      processPathFromHostPath(path: string): string | undefined
      resolve(path: string): Promise<{ targetKey: string; displayPath: string }>
      processPath(target: { targetKey: string }): string
      stat(): Promise<{ type: string; version: string } | undefined>
    } = {
      processPathFromHostPath: () => undefined,
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
      processPath: (target: { targetKey: string }) => target.targetKey,
      stat: async () => ({ type: 'directory', version: 'v1' }),
    }
    expect(remoteProviderPath(fs as never, '/home/dev', 'win32')).toBe(true)
    expect(await inspectWorkspacePath(fs as never, '/home/dev', 'win32')).toEqual({ path: '/home/dev', kind: 'directory' })
    fs.stat = async () => ({ type: 'file', version: 'v1' })
    expect((await inspectWorkspacePath(fs as never, '/home/dev/file', 'win32')).kind).toBe('other')
    fs.stat = async () => undefined
    expect((await inspectWorkspacePath(fs as never, '/home/dev/missing', 'win32')).kind).toBe('missing')
  })

  it('keeps drive-less Windows spellings local and invalid', async () => {
    const fs = {
      processPathFromHostPath: (path: string) => path,
      resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
      processPath: (target: { targetKey: string }) => target.targetKey,
      stat: async () => ({ type: 'directory', version: 'v1' }),
    }
    expect(remoteProviderPath(fs as never, '/foo', 'win32')).toBe(false)
    await expect(inspectWorkspacePath(fs as never, '/foo', 'win32')).rejects.toThrow('not fully qualified')
  })

  it('requires a filesystem provider for a remote path', async () => {
    await expect(inspectWorkspacePath(undefined, '/home/dev', 'win32')).rejects.toThrow('requires a filesystem provider')
  })

  it('inspects a host directory without a provider', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const directory = await mkdtemp('/tmp/dsh-workspace-inspect-')
    try {
      expect((await inspectWorkspacePath(undefined, directory)).kind).toBe('directory')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
