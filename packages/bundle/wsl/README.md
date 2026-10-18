---
description: "The dsh WSL bundle: filesystem, process and sandbox providers running in one WSL distribution."
kind: "package-bundle"
---

# @deepseek-ai/dsh-wsl-bundle

English | [中文](README.zh.md)

## Summary

`dsh-wsl-bundle` moves the Harness execution world into one WSL distribution while the UI stays on Windows. Its `cordis.patch.yml` disables the local filesystem, ordinary-process and sandbox providers and inserts the `dsh-wsl` connection with the paired `dsh-fs-ssh`, `dsh-subprocess-ssh` and `dsh-sandbox-ssh` providers. Files, commands and confinement then resolve inside the distribution through the shared POSIX helper.

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

Install the bundle into a base-backed profile, then restart that profile:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-wsl-bundle
```

The bundle is a patch layer, not a runtime plugin. Its rows are patched in after every bundle layer but before the profile's own `cordis.patch.yml`, so a profile entry that names `wsl-ssh`, `wsl-subprocess`, `wsl-sandbox` or `wsl-fs` configures or disables that row and wins.

Every deployment coordinate resolves from explicit configuration first and falls back to the environment: `DSH_WSL_EXE`, `DSH_WSL_DISTRO`, `DSH_WSL_WORKSPACE`, `DSH_WSL_HELPER`, `DSH_WSL_NODE`, `DSH_WSL_NODE_ARGS` (a JSON string array) and `DSH_WSL_HELPER_HASH`. The environment cannot select the self-contained executable launch; configure `launch` explicitly for that deployment. The sandbox policy needs the same Linux workspace: its `workspaceRoot` here comes from `DSH_WSL_WORKSPACE` and fails the load when that is unset, so a profile that configures `wsl-ssh.workspace` explicitly must also patch the `sandbox-policy` row with the same directory.

The bundle also replaces the adaptive host directory picker with the WSL browse backend and its existing in-app dialog, so workspace selection lists distribution directories instead of host drives.

The host must provide WSL2 with localhost forwarding and a distribution containing the helper (a Node executable plus the helper entry, or a self-contained executable). See [`dsh-wsl`](../../ssh/wsl/README.md) for the connection contract and failure behavior.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A loader patch cannot rename an existing row, so the bundle disables the shipped `subprocess`, `sandbox` and `fs-sandbox` rows and inserts four `wsl-*` rows. Service availability, not row order, decides activation. The connection owns `ctx.ssh`; the paired providers keep their existing contracts and only change where their effects run.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [WSL connection](../../ssh/wsl/README.md) — helper launch, streams and diagnostics.
- [SSH provider family](../../ssh/README.md) — the same provider contracts over OpenSSH.
- [WSL documentation](https://learn.microsoft.com/windows/wsl/) — distribution and networking prerequisites.

-----

<a id="model-experience"></a>
## Model Experience

None, as the bundle only composes execution providers and consumers own every model-visible operation.

#### KV Cache effect

This bundle contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

- **Local packages are not yet published** — `dsh plugin add` resolves the bundle and its providers from the registry, so an unpublished release can only be linked for composition tests.
- **One distribution and one helper** — multiple distributions and connection pools remain deferred.
- **Localhost forwarding is required** — a host that disables it cannot reach the stream relays.
- **Shell tools stay local** — `bash`/`pwsh` tool selection and terminal ownership are not patched yet, so model commands do not automatically run in the distribution.
- **Workspace selection is manual** — `DSH_WSL_WORKSPACE` and the sandbox policy must name the same Linux directory; the desktop picker and file watching follow later.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`dsh-wsl` resolves explicit configuration over the environment, so a profile patch may set only the fields it wants and keep the rest from the environment. The patch file is validated by composing it over a base-backed profile with `dsh --profile headless --patch packages/bundle/wsl/cordis.patch.yml --dump-config`.

</details>
