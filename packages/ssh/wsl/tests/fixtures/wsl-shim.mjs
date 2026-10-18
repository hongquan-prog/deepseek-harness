#!/usr/bin/env node
/** Translate the wsl.exe command line into one local helper process for transport tests. */
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const valueOf = (flag) => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const separator = args.indexOf('--')
if (separator === -1) {
  process.stderr.write('wsl-shim: missing -- separator\n')
  process.exit(64)
}
const distro = valueOf('-d')
if (distro === 'missing-distro') {
  // wsl.exe reports an unknown distribution as UTF-16 diagnostics with a non-zero exit.
  process.stderr.write(Buffer.from('wsl: distribution missing-distro was not found\r\n', 'utf16le'))
  process.exit(1)
}
const command = args.slice(separator + 1)
const child = spawn(command[0], command.slice(1), { cwd: valueOf('--cd'), stdio: 'inherit' })
child.once('error', (error) => {
  process.stderr.write(`wsl-shim: ${error.message}\n`)
  process.exit(127)
})
child.once('exit', (code) => { process.exit(code ?? 1) })
