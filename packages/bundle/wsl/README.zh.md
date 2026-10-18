---
description: "dsh WSL bundle：在一个 WSL 发行版内运行文件系统、进程与沙箱 provider。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-wsl-bundle

[English](README.md) | 中文

## 概述

`dsh-wsl-bundle` 把 Harness 的执行世界搬进一个 WSL 发行版，而 UI 留在 Windows。它的 `cordis.patch.yml` 会禁用本地的文件系统、普通进程与沙箱 provider，插入 `dsh-wsl` 连接以及配套的 `dsh-fs-ssh`、`dsh-subprocess-ssh`、`dsh-sandbox-ssh`。文件、命令与隔离随后都通过共享的 POSIX helper 在发行版内解析。

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

把 bundle 安装进一个基于 base 的 profile，然后重启该 profile：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-wsl-bundle
```

bundle 是补丁层，不是运行时插件。它的行在全部 bundle 层之后、profile 自己的 `cordis.patch.yml` 之前被应用，因此 profile 中命名 `wsl-ssh`、`wsl-subprocess`、`wsl-sandbox` 或 `wsl-fs` 的条目会配置或禁用对应行并生效。

每一项部署坐标都先取显式配置，缺失时回退环境变量：`DSH_WSL_EXE`、`DSH_WSL_DISTRO`、`DSH_WSL_WORKSPACE`、`DSH_WSL_HELPER`、`DSH_WSL_NODE`、`DSH_WSL_NODE_ARGS`（JSON 字符串数组）与 `DSH_WSL_HELPER_HASH`。环境变量不能选择自包含可执行文件的 launch，这种部署要显式配置 `launch`。沙箱策略需要同一个 Linux 工作区：它的 `workspaceRoot` 在这里来自 `DSH_WSL_WORKSPACE`，未设置时装载即失败；因此显式配置 `wsl-ssh.workspace` 的 profile 必须同时用同一目录 patch `sandbox-policy` 行。

bundle 还会用 WSL browse 后端与既有的应用内对话框替换宿主的自适应目录选择器，因此工作区选择列出的是发行版目录而不是宿主盘符。

宿主必须提供启用了 localhost 转发的 WSL2，发行版内要有 helper（Node 可执行文件加 helper 入口，或自包含可执行文件）。连接契约与失败行为见 [`dsh-wsl`](../../ssh/wsl/README.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

loader 补丁不能重命名已有行，因此 bundle 禁用随附的 `subprocess`、`sandbox` 与 `fs-sandbox` 行，再插入四个 `wsl-*` 行。激活由服务可用性决定，而不是行顺序。连接拥有 `ctx.ssh`；配套 provider 保持既有契约，只改变效果发生的位置。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [WSL 连接](../../ssh/wsl/README.zh.md) —— helper 启动、流与诊断。
- [SSH provider 家族](../../ssh/README.zh.md) —— 同一组 provider 契约经由 OpenSSH。
- [WSL 文档](https://learn.microsoft.com/windows/wsl/) —— 发行版与网络前提。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 bundle 只组合执行 provider，每项面向模型的操均由消费方负责。

#### KV Cache 影响

本 bundle 不贡献请求前缀内容。面向模型的工具与结果由消费方负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **本地包尚未发布** —— `dsh plugin add` 从 registry 解析 bundle 与 provider，因此未发布的版本只能以 link 方式做组合测试。
- **单发行版、单 helper** —— 多发行版与连接池仍是后续工作。
- **必须启用 localhost 转发** —— 关闭它的宿主无法访问流中继。
- **持久终端与新建文件夹尚未接线** —— bundle 启用沙箱化 bash 执行器并禁用宿主 PowerShell 执行器；agent preset 按已挂载执行器的方言选择面向模型的 shell 工具，因此命令经发行版的 subprocess 与 sandbox 运行。持久终端归属与目录选择器的「新建文件夹」仍是后续工作；`createDirectory` 目前以 `directory-create-failed` 拒绝。
- **工作区仍需手工选择** —— `DSH_WSL_WORKSPACE` 与沙箱策略必须指向同一个 Linux 目录。应用内选择器与文件监听已接线；选择器暂不能新建文件夹。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

`dsh-wsl` 先解析显式配置再回退环境变量，因此 profile 补丁可以只设置想覆盖的字段，其余继续来自环境。补丁文件通过在一个基于 base 的 profile 上运行 `dsh --profile headless --patch packages/bundle/wsl/cordis.patch.yml --dump-config` 来验证组合结果。

</details>
