---
description: "Browse directory-picker backend over the connected WSL filesystem."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-wsl

English | [中文](README.zh.md)

## Summary

`dsh-host-directory-picker-wsl` serves the in-app directory browser from the connected WSL distribution instead of the host filesystem. A listing names distribution paths, so the workspace picker can select `/home/...` directories that the WSL filesystem, process and sandbox providers then operate on.

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

Mount this backend instead of the adaptive picker (`@deepseek-ai/dsh-host-directory-picker-auto`) in a WSL profile, together with the existing client dialog (`@deepseek-ai/dsh-client-ui-directory-picker-browse`). It requires `ctx.fs` and `ctx.ssh`: listings run through the filesystem provider, and the picker's Home crumb and default directory come from the connection's negotiated workspace.

The backend exposes the `browse` capability: one directory level per call, POSIX ancestry crumbs, hidden dot-entries flagged for the client to filter, and at most 1000 child directories per level. Host paths, relative paths and drive-letter paths reject as unreadable. Creating a directory inside the distribution is not supported yet; the client surfaces that failure.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`list()` resolves the requested path through `ctx.fs.resolve`, reads the level with `ctx.fs.listDir`, and reports the provider's canonical process path. Only directory entries enter the bounded, name-sorted result; a cut level reports `truncated`. The stable `browse` capability object is created once per service lifetime, as the seam requires.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Directory picker seam](../directory-picker/README.md) — capability contract and alternate backends.
- [WSL connection](../../ssh/wsl/README.md) — the filesystem and connection this backend reads.
- [WSL bundle](../../bundle/wsl/README.md) — composition that mounts this backend.

-----

<a id="model-experience"></a>
## Model Experience

None, as the browse backend returns directory listings to the workspace UI without contributing model context.

#### KV Cache effect

This backend contributes no request-prefix content.

## Known Limitations and Deferred Work

- **No directory creation** — `createDirectory` rejects with `directory-create-failed`; creating folders inside the distribution needs a guarded mkdir operation on the filesystem seam.
- **One connected distribution** — listings follow the single `ctx.fs`/`ctx.ssh` pair; multi-distro browsing is deferred.
- **Bounded levels** — more than 1000 child directories are reported as truncated; no paging exists yet.
- **Symlinked directories** — entries are classified by the provider, so a symlink the provider reports as `other` is not offered for entry.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Home crumb is the connection's negotiated workspace rather than a discovered `$HOME`, so the picker opens where the profile already points. Replace it with a helper-reported home if cross-workspace browsing becomes the default.

</details>
