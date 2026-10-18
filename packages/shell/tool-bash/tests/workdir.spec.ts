/** Relative workdirs follow the session directory's path semantics, not the host's. */
import { describe, expect, it } from 'vitest'
import { resolveWorkdir } from '../src/index.ts'

describe('bash workdir resolution', () => {
  it('joins relative workdirs onto POSIX session directories', () => {
    expect(resolveWorkdir('src', '/home/dev/project')).toBe('/home/dev/project/src')
    expect(resolveWorkdir('../sibling', '/home/dev/project')).toBe('/home/dev/sibling')
    expect(resolveWorkdir(undefined, '/home/dev/project')).toBe('/home/dev/project')
  })

  it('keeps absolute workdirs and Windows session directories', () => {
    expect(resolveWorkdir('/var/log', '/home/dev/project')).toBe('/var/log')
    expect(resolveWorkdir('src', 'C:\\dev\\project')).toBe('C:\\dev\\project\\src')
    expect(resolveWorkdir('src', undefined)).toBe('src')
  })
})
