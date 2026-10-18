/** Launch construction and configuration admission for the WSL connection. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { WslConnection, wslHelperArgs, type Config, type WslLaunchTarget } from '../src/index.ts'

const target: WslLaunchTarget = {
  wsl: 'wsl.exe',
  distro: 'Ubuntu-24.04',
  workspace: '/home/dev/project',
  helper: '/opt/dsh/helper-entry.ts',
  launch: { kind: 'node-script', node: '/usr/bin/node', nodeArgs: ['--import', 'tsx/esm'] },
}

describe('wslHelperArgs', () => {
  it('runs the Node helper with the distribution, workspace and node options', () => {
    expect(wslHelperArgs(target)).toEqual([
      '-d', 'Ubuntu-24.04', '--cd', '/home/dev/project', '--',
      '/usr/bin/node', '--import', 'tsx/esm', '/opt/dsh/helper-entry.ts',
    ])
  })

  it('runs a self-contained helper without a Node interpreter', () => {
    expect(wslHelperArgs({ ...target, launch: { kind: 'executable' } })).toEqual([
      '-d', 'Ubuntu-24.04', '--cd', '/home/dev/project', '--', '/opt/dsh/helper-entry.ts',
    ])
  })

  it('keeps a distro name with spaces as one argument', () => {
    expect(wslHelperArgs({ ...target, distro: 'Ubuntu Test' }).slice(0, 2)).toEqual(['-d', 'Ubuntu Test'])
  })

  it('omits absent node options', () => {
    expect(wslHelperArgs({ ...target, launch: { kind: 'node-script', node: '/usr/bin/node' } })).toEqual([
      '-d', 'Ubuntu-24.04', '--cd', '/home/dev/project', '--', '/usr/bin/node', '/opt/dsh/helper-entry.ts',
    ])
  })
})

describe('WslConnection configuration', () => {
  const config: Config = { ...target }

  it.each([
    { workspace: 'relative/path' },
    { helper: 'opt/helper.ts' },
    { launch: { kind: 'node-script', node: 'remote/node' } },
    { helperHash: 'not-a-digest' },
    { requestTimeoutMs: 0 },
    { maxPending: 129 },
    { leaseMs: 2999 },
  ] satisfies Partial<Config>[])('rejects invalid deployment configuration before spawning: %j', (invalid) => {
    const ctx = new Context()
    try { expect(() => new WslConnection(ctx, { ...config, ...invalid })).toThrow() }
    finally { void ctx.fiber.dispose() }
  })
})
