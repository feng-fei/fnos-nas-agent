# Phase 208 - 设备与用户偏好档案

## 背景

清单里的 K03（设备档案）目前只实现为 `apps/fnos-nas-agent/app/device-capability.mjs` 的一次性能力位图：探测一次得出 `ready / partial / not-ready`，结果用完即丢。它回答的是「这台机器**现在**能做什么」，不回答「这台机器**是什么**」，所以每次排查或对话都要重新探测，设备离线时连"型号 / 固件 / 内存 / 磁盘"这些基本事实都拿不到。

K05（用户偏好）同样没有落点：`quietHours`、`preferredModel`、`notifyLevel` 这类设置要么散落在前端本地存储，要么根本没有入口。K08（过期信息管理）则要求系统能判断一条事实"还新不新"，而位图式探测结果没有时间戳，天然无法回答。

Phase 208 只做存储与语义这一层：把"设备是什么"和"用户希望它怎么工作"变成一份**可持久化、可合并、可判断新鲜度**的档案，并守住"不存凭据、不泄露序列号、不留脏文件"的边界。HTTP 路由与 UI 接线刻意不在本阶段（见「遗留」）。

## 新增或变更代码

| 文件 | 变化 |
| --- | --- |
| `apps/fnos-nas-agent/app/device-profile.mjs` | 新增。归一化 / 合并 / 新鲜度 / 脱敏 / 持久化存储五个能力，零第三方依赖。 |
| `tests/phase-208-device-profile.test.mjs` | 新增。28 个用例锁死字段校验、合并语义、三态新鲜度、脱敏与原子写路径。 |
| `docs/phase-208-device-profile.md` | 新增。本文件。 |

未修改任何已有文件。`device-capability.mjs`、`server.mjs`、`runbook-store.mjs` 均保持原样；本模块只复用 `serial-write-queue.mjs` 的写队列约定。

## 模块导出

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `PROFILE_FIELDS` | `readonly string[]` | 十个白名单档案字段，顺序即 `changedFields` 的报告顺序。 |
| `PREFERENCE_KEYS` | `readonly string[]` | 五个合法偏好键。 |
| `MAX_PROFILES` | `number` | `50`，单库档案上限。 |
| `DEFAULT_STALE_AFTER_MS` | `number` | `90 * 24 * 60 * 60 * 1000`（90 天）。 |
| `SCHEMA_VERSION` | `number` | `1`，落盘格式版本。 |
| `DEVICE_PROFILE_FILE_NAME` | `string` | `"device-profiles.json"`。 |
| `PROFILE_ID_PATTERN` | `RegExp` | `/^[a-z0-9][a-z0-9._-]{0,63}$/`，长度 1–64。 |
| `normalizeProfile(input, { now, id })` | `=> { ok, profile, droppedFields } \| { ok: false, reason, field? }` | 纯函数。未知字段丢弃但计数，不做静默截断。 |
| `mergeProfile(existing, incoming, { now })` | `=> { profile, changedFields, droppedFields } \| { ok: false, reason }` | 对象深合并、数组整体替换、`null` 删除字段；`createdAt` 保留旧值。 |
| `profileFreshness(profile, { now, staleAfterMs })` | `=> { state, ageDays, staleAfterMs }` | K08 判定：`fresh` / `stale` / `unknown`。 |
| `redactProfile(profile)` | `=> object` | 返回新对象，不改入参：序列号遮罩、敏感偏好键删除。 |
| `createDeviceProfileStore({ dataDir, fs, now })` | `=> { put, get, list, remove, state }` | 五个方法全部返回 Promise；`dataDir` 为空即纯内存库；`fs` 可注入内存实现。 |

## 字段表与校验

`normalizeProfile` 是唯一的写入口，白名单之外的一切都进 `droppedFields` 而不是落盘。

| 字段 | 类型 | 校验 / 归一 | 失败 reason |
| --- | --- | --- | --- |
| `id` | string | 命中 `/^[a-z0-9][a-z0-9._-]{0,63}$/`；`options.id` 优先于 `input.id` | `invalid-id` |
| `hostname` `model` `firmware` `kernel` `cpuModel` `timezone` `locale` | string | trim 后非空；超长截断到 200 字符；空串视为未提供 | `field-type-invalid`（非字符串） |
| `cpuCores` | integer | `Number.isInteger` 且 `>= 0` | `cpu-cores-invalid` |
| `memoryBytes` | integer | `Number.isInteger` 且 `>= 0`，单位字节，不设上限 | `memory-bytes-invalid` |
| `disks` | array | 最多 64 项；每项 `{ name, sizeBytes, serial? }`，`name` 非空且 ≤ 100 字符，`sizeBytes` 为整数且 `>= 0` | `disks-invalid` / `disks-too-many` / `disk-entry-invalid` / `disk-size-invalid` |
| `disks[].serial` | string | 脱敏后只保留后 4 位：`"WD-SN123456"` → `"*******3456"`；长度 ≤ 4 一律 `"****"`；对已脱敏值幂等 | — |
| `preferences` | object | 只接受 5 个白名单键；字符串 trim 后截断 200 字符；有限数字与布尔转成字符串；其余键进 `droppedFields` | `preferences-invalid`（非对象） |
| `createdAt` / `updatedAt` | ISO 字符串 | `Date.parse` 成功则保留原值（从磁盘读回的档案依赖这一点），否则取 `now` | — |

`preferences` 白名单：`quietHours`、`preferredModel`、`preferredLanguage`、`notifyLevel`、`maintenanceWindow`。

丢弃策略是显式的：未知顶层字段按插入顺序进 `droppedFields`，未知偏好键记作 `preferences.<key>`，调用方（将来的路由）可以据此提示"有字段没被接受"，而不是让用户以为保存成功。

## 合并与过期语义

`mergeProfile` 用于「读旧档案 + 收新补丁」：

| 输入形态 | 合并结果 |
| --- | --- |
| 普通对象（如 `preferences`） | 逐键深合并，未提及的键保留 |
| 数组（如 `disks`） | 整体替换，不做逐项合并 |
| 值为 `null` | 删除该键（用于"清空时区"这类操作） |
| `createdAt` | 永远取 `existing.createdAt`，补丁改不动它 |
| `updatedAt` | 取 `now` |
| `id` | 两边都有且不同 → `{ ok: false, reason: "id-mismatch" }`；只有一边有 → 用那一边 |

`changedFields` 只列真正变化的字段（对数组和对象做值比较），顺序固定：先 `PROFILE_FIELDS` 顺序，再 `preferences.<key>` 按 `PREFERENCE_KEYS` 顺序。这样前端可以精确高亮"这次更新改了什么"，审计也可以只记变化项。

`profileFreshness` 是 K08 的判定核心：

| 状态 | 条件 |
| --- | --- |
| `fresh` | `updatedAt` 可解析，且 `ageMs <= staleAfterMs`（恰好等于阈值的边界算新鲜） |
| `stale` | `updatedAt` 可解析，且 `ageMs > staleAfterMs` |
| `unknown` | 缺 `updatedAt`、为空或无法解析 |

`ageDays` 为 `floor(max(0, now - updatedAt) / 一天)`，未来时间戳按 0 天处理，不会出现负数。`staleAfterMs` 默认 90 天；传入负数或非有限值时回退默认值，而不是把一切都判成过期。

设计取向是「不知道」绝不等于「新鲜」：`unknown` 会让调用方主动重新探测，而不是拿着三年前的档案当事实用。

## 持久化与原子写

存储文件为 `<dataDir>/device-profiles.json`，单文件承载整库，信封格式：

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-04-01T09:00:00.000Z",
  "profiles": [{ "id": "nas-01", "hostname": "nas-01", "disks": [], "preferences": {}, "createdAt": "…", "updatedAt": "…" }]
}
```

写入严格复刻本仓库 `runbook-store.mjs` 的原子写路径：

1. `mkdir(dataDir, { recursive: true, mode: 0o700 })`；
2. 创建同目录临时文件 `.device-profiles-<uuid>.tmp`，以 `"wx"` + `0o600` 打开（已存在即失败，不覆盖别人）；
3. `handle.writeFile(payload)` → `handle.sync()`（fsync）→ `handle.close()`；
4. `rename(temp, <dataDir>/device-profiles.json)` —— 读者要么看到旧文件，要么看到完整新文件；
5. `chmod(file, 0o600)` 兜底权限；
6. 任何一步失败都会 `unlink` 临时文件，不留下半成品。

`put` / `remove` 经 `serial-write-queue.mjs` 串行化，避免并发读改写互相覆盖；`get` / `list` / `state` 只读，首次调用时幂等装载一次（`load()` 并发调用共享同一个 Promise）。

装载策略（`recovered` / `recoveryReason` 记进 `state()`）：

| 磁盘上的情况 | 启动结果 |
| --- | --- |
| 文件不存在 | 空库，`recovered: true`（无需恢复） |
| JSON 解析失败 | 空库，`recovered: false`，`recoveryReason: "corrupt-file"` |
| `schemaVersion` 不符或形状不对 | 空库，`recovered: false`，`recoveryReason: "schema-mismatch"` |
| 读取失败且不是 `ENOENT`（如权限） | 空库，`recovered: false`，`recoveryReason: "read-failed"`，并置 `writable: false` |

关键取舍：**损坏文件按空库启动，但绝不在同一位置静默写回空库把证据抹掉**。前三种情况下一次 `put` 会原子替换掉坏文件（这是恢复手段）；而 `read-failed` 只读不写，`put` / `remove` 返回 `{ ok: false, reason: "store-not-writable" }`。

单条档案坏掉不会带走整库：装载时逐条过 `normalizeProfile`，非法条目跳过，重复 `id` 只保留第一条，最多接纳 `MAX_PROFILES` 条。`put` 在库已满时只拒绝**新增**，已存在的 `id` 仍可更新，返回 `{ ok: false, reason: "profile-limit", limit: 50 }`。`list()` 按 `updatedAt` 降序、`id` 升序返回。

`dataDir` 为空时是纯内存库（`state().persisted === false`），测试和"先上线不落盘"的灰度期都能直接用。

## 安全边界

- **序列号脱敏**：`normalizeProfile` 在内存里就只保留后 4 位；`redactProfile` 落盘前再遮一次，且对已遮罩的值幂等，不会叠星号。全库任意位置都不存在完整序列号。
- **不存凭据**：`preferences` 只接受白名单键；键名命中 `/pass|token|secret|key/i` 的键在脱敏阶段**整体删除，值根本不参与序列化**。`normalizeProfile` 的丢弃是第一道防线，`store.put` 写入前的 `redactProfile` 是第二道，调用方绕过归一也写不进敏感键。
- **文件权限**：临时文件 `0o600`、rename 后再 `chmod 0o600`，目录 `0o700`；在共享 NAS 上同机其他账号读不到档案。
- **原子替换**：坏文件不会被追加写或截断写，`rename` 保证读者永远看到完整 JSON；失败路径清理临时文件。
- **路径安全**：`id` 只用于内存键和 JSON 字段，不拼文件路径（整库单文件），模式里也不允许 `/`、`\`，不存在目录穿越面。
- **错误信息**：各方法只回稳定的 `reason` 码；`persist-failed` 只带底层 `error.message`，不回传档案内容。
- **无网络、无第三方依赖**：模块不发起任何 I/O 之外的访问，也不 import 任何 npm 包。
- 已知局限：后 4 位序列号仍可能用于识别设备，这属于可接受的残余信息；档案是明文 JSON，机密性依赖文件权限与本机账号体系，不做加密。

## 测试结果

```
node --check apps/fnos-nas-agent/app/device-profile.mjs     # 通过
node --test tests/phase-208-device-profile.test.mjs         # tests 28 / pass 28 / fail 0
```

用例覆盖（`tests/phase-208-device-profile.test.mjs`）：

| 分组 | 覆盖点 | 用例数 |
| --- | --- | --- |
| normalize | 全字段归一与时间戳、未知字段丢弃、`memoryBytes` 负数/小数/字符串/0、序列号脱敏与幂等、非法 id（大写/空格/分隔符/超长）、偏好白名单与 200 字符截断、畸形磁盘、非对象输入与非字符串字段 | 8 |
| merge | 深合并 + 数组替换 + `createdAt` 保留、`changedFields` 精确性、`null` 删除、id 冲突与非法补丁 | 4 |
| freshness | fresh/ageDays、90 天阈值外的 stale、缺时间戳/不可解析的 unknown、自定义阈值与边界 | 4 |
| redact | 删敏感键、遮罩、不修改入参、序列化后不含敏感键名与值 | 1 |
| store | put/get/list 往返与重启装载、remove、50 条上限且存量可更新、损坏文件恢复为空库、schema 不符、跳过坏条目、写盘内容安全（无原始序列号/`sk-live…`/`hunter2`，含 `"*******3456"`，`"wx"` + `0600`、无残留 `.tmp`）、持久化失败保留旧文件、不可读文件拒写、纯内存模式、真实临时目录往返 | 11 |

测试里的文件系统是可注入的内存实现（记录 `opens` / `chmods` / `renames`），因此断言的是**实际写盘的字符串**和**实际调用参数**，而不是解析后的对象；另有一条用例走真实 `mkdtemp` 目录，防止内存实现与真实 fs 行为漂移。

## 遗留（由 Lead 接线）

- **HTTP 路由未接**：`server.mjs` 尚无 `/api/system/device-profiles`。建议在 `auditRoute()` 增加 `system.device-profile` 动作，并在 system 路由段加 `GET /api/system/device-profiles`（list + state）、`GET /api/system/device-profiles/:id`、`PUT /api/system/device-profiles/:id`、`DELETE /api/system/device-profiles/:id`；`GET` 走 `list()` / `get()`，`PUT` 走 `normalizeProfile` + `mergeProfile` + `store.put()`，并在响应里带 `changedFields` 与 `freshness`。
- **UI 未接**：建议在 `apps/fnos-nas-agent/app/ui/index.html` 的 `#tools-card`（NAS 工具）下新增「设备档案」面板：档案摘要 + 最后一次更新时间 + `freshness` 徽标 + 偏好编辑表单；`pages.js` 里补渲染函数。
- **采集器未接**：档案字段目前完全由调用方提供，尚未从 `system-snapshot.mjs` / `system-capabilities.mjs` 自动回填。K03 的位图结果可以在体检后顺带写入一份档案，但那是接线阶段的事。
- **过期清理未做**：K08 只实现"判定"，没有自动归档或删除陈旧档案的策略；若后续需要，可在 `state()` 之外加一个只读的 `staleProfiles()`。
- **偏好是设备级**：当前一份档案对应一台设备，没有按用户区分；多用户场景需要等会话/账号模型确定后再扩展。
- **格式迁移**：`schemaVersion = 1` 是起点，尚无迁移函数；版本不符时按空库启动并记录 `schema-mismatch`，升级时要补一条显式迁移路径。
