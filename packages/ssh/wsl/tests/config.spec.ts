/** Launch construction and configuration admission for the WSL connection. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { resolveWslConfig, WSL_ENV, WslConnection, wslHelperArgs, type Config, type WslLaunchTarget } from '../src/index.ts'

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

describe('resolveWslConfig', () => {
  const environment = {
    [WSL_ENV.wsl]: '/env/wsl.exe',
    [WSL_ENV.distro]: 'Ubuntu-Env',
    [WSL_ENV.workspace]: '/home/env',
    [WSL_ENV.helper]: '/opt/env-helper.mjs',
    [WSL_ENV.node]: '/usr/bin/env-node',
    [WSL_ENV.nodeArgs]: '["--import","tsx/esm"]',
    [WSL_ENV.helperHash]: 'd'.repeat(64),
  }

  it('falls back to the environment for every absent coordinate', () => {
    expect(resolveWslConfig({}, environment)).toMatchObject({
      wsl: '/env/wsl.exe', distro: 'Ubuntu-Env', workspace: '/home/env', helper: '/opt/env-helper.mjs',
      launch: { kind: 'node-script', node: '/usr/bin/env-node', nodeArgs: ['--import', 'tsx/esm'] },
      helperHash: 'd'.repeat(64),
    })
  })

  it('lets explicit configuration override each environment default', () => {
    expect(resolveWslConfig({
      wsl: '/explicit/wsl.exe',
      distro: 'Ubuntu-Explicit',
      workspace: '/home/explicit',
      helper: '/opt/explicit.mjs',
      launch: { kind: 'executable' },
      helperHash: 'e'.repeat(64),
    }, environment)).toMatchObject({
      wsl: '/explicit/wsl.exe', distro: 'Ubuntu-Explicit', workspace: '/home/explicit',
      helper: '/opt/explicit.mjs', launch: { kind: 'executable' }, helperHash: 'e'.repeat(64),
    })
  })

  it('treats an empty explicit value like an absent one', () => {
    expect(resolveWslConfig({ distro: '', workspace: '', helper: '', wsl: '' }, environment)).toMatchObject({
      wsl: '/env/wsl.exe', distro: 'Ubuntu-Env', workspace: '/home/env', helper: '/opt/env-helper.mjs',
    })
  })

  it('reports the missing coordinate with its environment variable', () => {
    expect(() => resolveWslConfig({ helper: '/opt/h.mjs', launch: { kind: 'executable' } }, {}))
      .toThrow(/distro.*DSH_WSL_DISTRO/u)
    expect(() => resolveWslConfig({ distro: 'D', workspace: '/w', helper: '/h' }, {}))
      .toThrow(/launch.*DSH_WSL_NODE/u)
  })

  it('uses a bare node-script launch when the environment has no node options', () => {
    const resolved = resolveWslConfig({}, {
      [WSL_ENV.distro]: 'Ubuntu-Env',
      [WSL_ENV.workspace]: '/home/env',
      [WSL_ENV.helper]: '/opt/env-helper.mjs',
      [WSL_ENV.node]: '/usr/bin/env-node',
    })
    expect(resolved.launch).toEqual({ kind: 'node-script', node: '/usr/bin/env-node', nodeArgs: [] })
  })

  it('rejects malformed node options in the environment', () => {
    expect(() => resolveWslConfig({}, { ...environment, [WSL_ENV.nodeArgs]: 'not-json' }))
      .toThrow(/DSH_WSL_NODE_ARGS/u)
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
