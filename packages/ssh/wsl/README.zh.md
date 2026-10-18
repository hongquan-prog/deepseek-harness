---
description: "经由 wsl.exe 承载 POSIX helper 及其环回流（loopback）的 WSL 发行版连接。"
kind: "package-reference"
---

# @deepseek-ai/dsh-wsl

[English](README.md) | 中文

## 概述

`dsh-wsl` 用一个运行在 WSL 发行版内的 helper 进程提供 `ctx.ssh`。文件、普通进程、终端与沙箱强制执行都发生在发行版内，而 Harness 留在 Windows 上。它实现与 `dsh-ssh` 相同的连接面，因此配套的 `fs-ssh`、`subprocess-ssh`、`sandbox-ssh` 无需改动即可消费它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用 `dsh-wsl` 取代 `dsh-ssh` 挂载，再挂载既有的远端 provider。发行版选择、helper 制品与默认工作区都是部署方配置，没有任何模型参数能选择它们。

| 字段 | 含义 |
|---|---|
| `wsl` | `wsl.exe` 的路径或命令名，默认 `wsl.exe`。 |
| `distro` | 传给 `-d` 的已安装发行版名称。 |
| `workspace` | 发行版内的绝对 Linux 目录，作为 helper 进程 cwd 与默认路径解析根。 |
| `helper` | 发行版内 helper 入口的绝对路径。 |
| `launch` | `{ kind: 'node-script', node, nodeArgs? }` 用发行版自己的 Node 运行入口；`{ kind: 'executable' }` 运行自包含 helper。 |
| `helperHash` | 可选的小写 SHA-256；与安装的 helper 不符时拒绝连接。 |
| `requestTimeoutMs` | 管理请求截止时间，默认 30 秒。 |
| `maxFrameBytes` | 单个请求或响应的最大 JSON 负载字节数，默认 64 MiB。 |
| `maxPending` | 普通请求上限，默认 128。 |
| `leaseMs` | 由心跳续期的远端 helper 租约，默认 30 秒。 |

宿主必须提供启用了 localhost 转发的 Windows WSL2 安装，发行版内必须有 Node 22.19 或更新版本的可执行文件加 helper 入口，或者一个自包含的 helper 可执行文件。启动时会拒绝非 Linux 的 helper、不匹配的 launch 类型或不匹配的 helper 摘要。发行版不存在、`wsl.exe` 缺失、helper 在握手期间退出，都会让 readiness 失败并带上捕获到的 WSL 诊断，而不是静默降级为本地执行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

连接会启动 `wsl.exe -d <distro> --cd <workspace> -- <helper command>`，并通过子进程的 stdin/stdout 使用共享的私有 helper 帧协议。helper 把流端点创建为私有 Unix 套接字，Windows 客户端无法打开；`stream.relay` 会把一个已预留端点重新发布到临时的 `127.0.0.1` 端口，客户端再经这座桥完成 TLS-PSK。一个中继只接受一个连接，空闲后过期，因此仅有端口而没有管理能力值并不能取得任何东西。

心跳会刷新 helper 租约；传输中断会拒绝待处理操作并终止子进程。销毁时在可达的情况下发送 helper 的 `close` 操作，销毁流套接字，并在请求截止时间后把子进程从 `SIGTERM` 升级到 `SIGKILL`。诊断优先按 wsl.exe 的 UTF-16 输出解码，否则按 helper 的 UTF-8 stderr 解码。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 连接](../ssh/README.zh.md) —— 同一 helper 协议经由 OpenSSH。
- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) —— 共享执行坐标与传输归属。
- [WSL 文档](https://learn.microsoft.com/windows/wsl/) —— 发行版与网络前提。

-----

<a id="model-experience"></a>
## 模型体验

无，因为发行版选择、helper 安装与流能力令牌属于私有部署细节，每项面向模型的操作均由消费方负责。

#### KV Cache 影响

本提供方不贡献请求前缀内容。面向模型的工具与结果由消费方负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **必须启用 localhost 转发** —— 流发布在发行版内的 `127.0.0.1` 上；关闭 `localhostForwarding` 的宿主无法访问，目前也没有绑定地址的降级方案。
- **源码 helper 需要工具链** —— `launch.kind: 'node-script'` 要求兼容的 Node 可执行文件；源码检出还需要发行版内的 tsx loader。安装自包含 helper 仍是后续工作。
- **PTC 需要可执行 helper** —— 脚本部署的 helper 不携带内嵌 worker，`ptcLaunch` 会抛错。
- **每连接一个发行版** —— 同时挂载多个发行版或连接池化仍是后续工作。
- **中继可用性** —— 已发布端口只接受一个连接，且 30 秒无人连接后过期；任何本机进程都能抢占该槽位，重试需要重新发起 `stream.relay` 请求。
- **没有文件监听** —— helper 尚未暴露 watch 操作，发行版内的外部改动还不会让远端文件树失效。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

私有协议与 `dsh-ssh` 共享；新增的 helper-only 方法可以落在同一个 wire 版本内，因为安装的 helper 摘要钉住了精确的方法集。`tests/fixtures/wsl-shim.mjs` 把 wsl.exe 命令行翻译成本地 helper 进程，使传输测试不需要 Windows 宿主也能运行。

</details>
