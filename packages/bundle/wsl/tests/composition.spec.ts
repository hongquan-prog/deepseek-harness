/** The bundle patch composes over a base-backed profile; mounting is covered by the provider packages. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const bundleRoot = join(repositoryRoot, 'packages/bundle/wsl')
let patch = ''
let home = ''

/** Compose the headless profile plus this bundle and return the printed tree. */
async function dumpConfig(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const launch = resolveExampleLaunch({
      srcBin: join(repositoryRoot, 'apps/cli/src/bin.ts'),
      configArgs: ['--profile', 'web', '--patch', patch, '--dump-config'],
      tsconfigPath: join(repositoryRoot, 'tsconfig.json'),
      env: {
        DSH_HOME: home,
        DSH_WSL_DISTRO: 'Ubuntu-24.04',
        DSH_WSL_WORKSPACE: '/home/dev/project',
        DSH_WSL_NODE: '/usr/bin/node',
        DSH_WSL_HELPER: '/opt/dsh/helper-entry.js',
      },
    })
    const child = spawn(launch.command, launch.args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...launch.env },
    })
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { errors.push(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
      else reject(new Error(`dsh --dump-config exited ${String(code)}: ${Buffer.concat(errors).toString('utf8')}`))
    })
  })
}

describe('WSL bundle composition', () => {
  beforeAll(async () => {
    const manifest = JSON.parse(await readFile(join(bundleRoot, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string } } }
    patch = join(bundleRoot, manifest.dsh.bundle.patch)
    home = await mkdtemp('/tmp/dsh-wsl-bundle-')
  })
  afterAll(async () => { if (home !== '') await rm(home, { recursive: true, force: true }) })

  it('disables the local providers and inserts the WSL rows', async () => {
    const tree = await dumpConfig()
    expect(tree).toContain("- id: subprocess\n  name: '@deepseek-ai/dsh-subprocess-local'\n  disabled: true")
    expect(tree).toContain("- id: sandbox\n  name: '@deepseek-ai/dsh-sandbox-local'\n  disabled: true")
    expect(tree).toContain("- id: wsl-ssh\n  name: '@deepseek-ai/dsh-wsl'")
    expect(tree).toContain("- id: wsl-subprocess\n  name: '@deepseek-ai/dsh-subprocess-ssh'")
    expect(tree).toContain("- id: wsl-sandbox\n  name: '@deepseek-ai/dsh-sandbox-ssh'")
    expect(tree).toContain("- id: wsl-fs\n  name: '@deepseek-ai/dsh-fs-ssh'")
    expect(tree).toContain("- id: fs-sandbox\n  name: '@deepseek-ai/dsh-fs-sandbox'\n  disabled: true")
    expect(tree).toContain("- id: sandbox-policy\n  name: '@deepseek-ai/dsh-sandbox-policy'\n  config:\n    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'")
    expect(tree).toContain("- id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-auto'\n  disabled: true")
    expect(tree).toContain("- id: wsl-directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-wsl'")
    expect(tree).toContain("- id: wsl-directory-picker-browse\n  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'")
    expect(tree).toContain('workspaceRoot: !!js')
  }, 60_000)

  it('mounts the bash executor and lets the preset pick its tool from shellKind', async () => {
    const source = await readFile(patch, 'utf8')
    expect(source).toContain('- id: bash-sandbox\n  disabled: false\n  config:\n    timeoutMs: 60000')
    expect(source).toContain('- id: pwsh-sandbox\n  disabled: true')
    expect(source).not.toContain('- id: tool-bash')
    expect(source).not.toContain('- id: tool-pwsh')
    const tree = await dumpConfig()
    expect(tree).toContain("- id: bash-sandbox\n  name: '@deepseek-ai/dsh-bash-sandbox'\n  disabled: false")
    expect(tree).toContain("- id: pwsh-sandbox\n  name: '@deepseek-ai/dsh-pwsh-sandbox'\n  disabled: true")
    // The Web surface keeps the host-plane tools disabled; presets own the
    // model-facing pair and select it from the mounted executor.
    expect(tree).toContain("- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n  disabled: true")
    expect(tree).toContain("- id: tool-pwsh\n  name: '@deepseek-ai/dsh-tool-pwsh'\n  disabled: true")
    expect(tree).toContain("ctx.get('shell')?.shellKind !== 'bash'")
    expect(tree).toContain("ctx.get('shell')?.shellKind !== 'pwsh'")
  })
})
