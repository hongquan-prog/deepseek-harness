---
description: "基于已连接 WSL 文件系统的 browse 目录选择器后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-wsl

[English](README.md) | 中文

## 概述

`dsh-host-directory-picker-wsl` 让应用内目录浏览器读取已连接的 WSL 发行版，而不是宿主文件系统。列表给出的是发行版路径，因此工作区选择器可以选中 `/home/...` 目录，随后由 WSL 的文件系统、进程与沙箱 provider 在其上工作。

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

在 WSL profile 中用它替换自适应选择器（`@deepseek-ai/dsh-host-directory-picker-auto`），并挂载既有的客户端对话框（`@deepseek-ai/dsh-client-ui-directory-picker-browse`）。它需要 `ctx.fs` 与 `ctx.ssh`：列表通过文件系统 provider 读取，选择器的 Home 面包屑与默认目录来自连接协商出的工作区。

后端暴露 `browse` 能力：每次调用列一层、给出 POSIX 祖先面包屑、把点开头的隐藏项标记给客户端过滤、每层最多 1000 个子目录。宿主路径、相对路径与盘符路径都会以不可读拒绝。发行版内创建目录暂不支持，客户端会看到该失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

`list()` 先经 `ctx.fs.resolve` 解析请求路径，再用 `ctx.fs.listDir` 读取该层，并报告 provider 的规范进程路径。只有目录项进入有界、按名称排序的结果；被截断的层会标记 `truncated`。稳定的 `browse` 能力对象每个服务生命周期只创建一次，符合 seam 的要求。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [目录选择器 seam](../directory-picker/README.zh.md) —— 能力契约与其他后端。
- [WSL 连接](../../ssh/wsl/README.zh.md) —— 本后端读取的文件系统与连接。
- [WSL bundle](../../bundle/wsl/README.zh.md) —— 挂载本后端的组合。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 browse 后端只向工作区 UI 返回目录列表，不贡献模型上下文。

#### KV Cache 影响

本后端不贡献请求前缀内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **不能创建目录** —— `createDirectory` 以 `directory-create-failed` 拒绝；发行版内建文件夹需要文件系统 seam 上带守卫的 mkdir 操作。
- **单一已连接发行版** —— 列表跟随唯一的 `ctx.fs`/`ctx.ssh` 组合；多发行版浏览仍是后续工作。
- **层级有界** —— 超过 1000 个子目录会报告截断；暂无分页。
- **符号链接目录** —— 条目由 provider 分类，被报告为 `other` 的链接不会提供进入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

Home 面包屑是连接协商出的工作区，而不是探测到的 `$HOME`，这样选择器会打开 profile 已指向的位置。如果跨工作区浏览成为默认行为，再改为 helper 报告的主目录。

</details>
