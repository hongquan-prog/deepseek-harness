---
description: "WSL distribution connection over wsl.exe carrying the POSIX helper and its loopback streams."
kind: "package-reference"
---

# @deepseek-ai/dsh-wsl

English | [中文](README.zh.md)

## Summary

`dsh-wsl` provides `ctx.ssh` backed by a helper process running inside a WSL distribution. Files, ordinary processes, terminals and sandbox enforcement run in the distribution while the Harness stays on Windows. The paired `fs-ssh`, `subprocess-ssh` and `sandbox-ssh` providers consume it unchanged because it implements the same connection surface as `dsh-ssh`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-wsl` in place of `dsh-ssh`, then mount the existing remote providers. Distribution selection, the helper artifact and the default workspace are deployment-owned configuration; no model argument selects them.

| Field | Meaning |
|---|---|
| `wsl` | `wsl.exe` path or command name. Defaults to `wsl.exe`. |
| `distro` | Installed distribution name passed to `-d`. |
| `workspace` | Absolute Linux directory; becomes the helper process cwd and the default path-resolution root. |
| `helper` | Absolute helper entry inside the distribution. |
| `launch` | `{ kind: 'node-script', node, nodeArgs? }` runs the entry with the distribution's Node; `{ kind: 'executable' }` runs a self-contained helper. |
| `helperHash` | Optional lowercase SHA-256 of the installed helper; a mismatch refuses the connection. |
| `requestTimeoutMs` | Administrative request deadline. Defaults to 30 seconds. |
| `maxFrameBytes` | Maximum JSON payload bytes per request or response. Defaults to 64 MiB. |
| `maxPending` | Maximum ordinary requests. Defaults to 128. |
| `leaseMs` | Remote helper lease refreshed by heartbeats. Defaults to 30 seconds. |

The host must provide a Windows WSL2 installation with localhost forwarding enabled, and the distribution must contain either a Node 22.19-or-newer executable plus the helper entry or a self-contained helper executable. Startup rejects a non-Linux helper, a mismatched launch kind or a mismatched helper digest. An unknown distribution, a missing `wsl.exe` and a helper that exits during the handshake all fail readiness with the captured WSL diagnostics instead of degrading to local execution.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The connection spawns `wsl.exe -d <distro> --cd <workspace> -- <helper command>` and speaks the shared private helper frame protocol over the child's stdin and stdout. The helper creates its stream endpoints as private Unix sockets, which a Windows client cannot open; `stream.relay` republishes one reserved endpoint on an ephemeral `127.0.0.1` port, and the client completes TLS-PSK through that bridge. A relay accepts a single connection and expires when idle, so the port alone grants nothing without the administrative capability.

Heartbeats refresh the helper lease; transport loss rejects pending operations and terminates the child. Disposal sends the helper's `close` operation when reachable, destroys stream sockets, and escalates the child from `SIGTERM` to `SIGKILL` after the request deadline. Diagnostics are decoded from wsl.exe's UTF-16 output when present and the helper's UTF-8 stderr otherwise.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH connection](../ssh/README.md) — the same helper protocol over OpenSSH.
- [SSH subsystem](../../../docs/subsystems/ssh.md) — shared execution coordinates and transport ownership.
- [WSL documentation](https://learn.microsoft.com/windows/wsl/) — distribution and networking prerequisites.

-----

<a id="model-experience"></a>
## Model Experience

None, as distribution selection, helper installation and stream capabilities are private deployment details and consumers own every model-visible operation.

#### KV Cache effect

This provider contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

- **Localhost forwarding is required** — streams are published on `127.0.0.1` inside the distribution; a host that disables `localhostForwarding` cannot reach them, and no bind-address fallback exists yet.
- **Source helpers need a toolchain** — `launch.kind: 'node-script'` requires a compatible Node executable and, for source checkouts, the tsx loader inside the distribution; installing a self-contained helper remains deferred work.
- **PTC needs an executable helper** — `ptcLaunch` throws for script deployments because their helper carries no embedded worker.
- **One distribution per connection** — mounting several distributions or pooling connections is deferred.
- **Relay availability** — a published port accepts one connection and expires after 30 seconds without one; any local process can consume the slot, so a retry opens a new relay request.
- **No file watching** — the helper exposes no watch operation, so external distribution changes do not invalidate the remote file tree yet.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The private protocol is shared with `dsh-ssh`; new helper-only methods may land within one wire version because the installed helper digest pins the exact method set. `tests/fixtures/wsl-shim.mjs` translates the wsl.exe command line into one local helper process so transport tests run without a Windows host.

</details>
