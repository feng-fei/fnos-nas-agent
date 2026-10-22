# Phase 158 — Windows 绝对路径守卫

本阶段修掉一个**真实的生产缺陷**：在 Windows 上，`createSkillInstaller()` 拒绝
每一个绝对路径，导致带 `AGENT_DATA_DIR` 的服务无法启动，本仓库大量 HTTP 测试
在 Windows 开发机上整体失败。

## 1. 缺陷

`apps/fnos-nas-agent/app/skill-installer.mjs:52` 附近的守卫原本是：

```js
if (!resolve(dataDir).startsWith("/")) throw new Error(...);
```

`resolve()` 来自 `node:path`。在 POSIX 上绝对路径以 `/` 开头，这个判断成立；在
Windows 上 `resolve("C:\\agent-data")` 返回的是**盘符开头**的路径，永远不以 `/`
开头，于是守卫恒为真：`AGENT_DATA_DIR=C:\agent-data` 被判定为非法。

后果不是「某个功能不能用」，而是服务**起不来**：HTTP 测试在准备数据目录时
统一失败，与功能本身无关的用例一起变红，掩盖真实回归。

## 2. 修复

守卫改用 `node:path` 的 `isAbsolute()`，它在每个平台上都有正确的语义：

```js
if (!isAbsolute(dataDir)) throw new Error(...);
```

模块其余部分继续使用 `resolve()`，因为那里是真正做文件系统访问，需要归一化。

回归测试：`tests/phase-158-windows-absolute-path.test.mjs`，断言：

* `isAbsolute()` 被用于守卫判断，而不是 `startsWith("/")`；
* 模块不再出现以 `/` 前缀判断绝对路径的写法；
* 在 Windows 上，盘符路径被接受为绝对路径；
* 相对路径仍然被拒绝。

## 3. 影响

这个缺陷是 Windows 上 18 个失败用例的共同根因。修复之后：

* 带 `AGENT_DATA_DIR` 的服务可以正常启动；
* Phase 151 的直聊通道（依赖数据目录）在 Windows 上可被端到端测试；
* 全量测试的环境性失败数量从基线的 83 项下降。

## 4. 边界

* 本阶段只改 `apps/fnos-nas-agent/app/skill-installer.mjs` 一个生产文件；
* 不改变 POSIX 下的行为，也不放宽任何目录边界规则；
* 不引入任何平台相关的依赖。
