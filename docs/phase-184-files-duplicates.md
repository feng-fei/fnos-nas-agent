# Phase 184 · 重复文件扫描接口

## 背景

清单里「文件管理」一节点名了几项机主真正会用的能力：找出重复文件、看清空间被谁占掉。仓库此前已经有 `duplicate-detector.mjs`（两阶段：先按大小分组、再对同大小候选算哈希），但**没有任何入口能调用它**，属于「有能力没有入口」的典型缺口。

本阶段只做一件轻量的事：给文件页补一个只读接口 `GET /api/files/duplicates`，并把扫描语义抽成可单测的编排层。

## 改动

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `apps/fnos-nas-agent/app/duplicate-scan.mjs` | 新增 | `createDuplicateScanner({ listEntries, readHash })` → `scan({ dir, limit, maxHashBytes })`，把文件浏览器/文件管理器适配成 `duplicate-detector` 需要的回调 |
| `apps/fnos-nas-agent/app/server.mjs` | 修改 | 新增 `duplicateScanner` 装配、`GET /api/files/duplicates` 路由、`duplicateScanLimiter`（3 次/分钟）、审计名 `files.duplicates` |
| `tests/phase-184-files-duplicates.test.mjs` | 新增 | 5 个用例：分组正确性、空文件与超限跳过、哈希失败降级、非法参数、HTTP 鉴权/限流/只读 |

## 接口契约

```
GET /api/files/duplicates?path=<目录>&limit=<1..500>
```

- 需要 Agent 会话（`nas_agent_session` cookie），未登录返回 `401`；
- 非 GET 返回 `405`（只读接口）；
- `limit` 非整数或越界返回 `400`，提示 `limit must be between 1 and 500`；
- 同一会话 3 次/分钟，超出返回 `429` 且带 `retry-after: 60`。

响应：

```json
{
  "dir": "/vol1/1000/docker",
  "listed": 42,
  "truncated": false,
  "scanned": 42,
  "candidates": 12,
  "groups": [
    { "size": 1048576, "hash": "<sha256>", "paths": ["/a.bin", "/b.bin"], "wastedBytes": 1048576 }
  ],
  "skipped": [{ "path": "/big.iso", "reason": "too-large" }],
  "note": "只比较当前目录下的文件，不递归子目录；超过 64MiB 的文件只按大小分组、不做哈希。"
}
```

`skipped.reason` 取值：`too-large` / `hash-failed` / `invalid-hash` / `list-failed` / `invalid-entry`。

## 红线

- **只读**：不删除、不移动、不改名；扫描结果只用来给机主看。
- **不递归**：只扫一层目录，避免一次请求打穿整个存储池；这也是「轻量」的取舍。
- **只对同大小候选算哈希**：大小唯一的文件永远不进哈希阶段，64MiB 以上的文件直接跳过哈希并在 `skipped` 里说明原因。
- **不回显文件内容**：响应里只有路径、大小、哈希与分类计数。
- **扫描失败不抛 500 细节**：`list-failed` 等异常降级到 `skipped`，避免把本机路径/权限细节变成 5xx 堆栈。

## 验证

```
node --check apps/fnos-nas-agent/app/duplicate-scan.mjs
node --test tests/phase-184-files-duplicates.test.mjs
```

结果：`5/5 pass`。其中 HTTP 用例覆盖 401 / 400 / 405；分组语义用纯函数用例覆盖（Windows 上文件浏览器按设计拒绝无描述符路径的目录扫描，因此扫描语义不依赖真实文件系统）。

## 遗留

- 前端入口（文件页工具栏「查找重复」按钮 + 分组结果区）已在 Phase 186 补齐：只渲染「大小 × 份数 + 每组路径」，并提示“只比对当前目录，不递归”。
- 递归扫描、跨目录去重（例如全盘找重复）不在本阶段范围；需要时用 `files.inspect` 之类的显式动作逐层展开。
