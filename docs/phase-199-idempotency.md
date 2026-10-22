# Phase 199 — 幂等控制（纯函数层）

## 背景

重试是 NAS 上最常见的重复副作用来源：一次 `file.rename`、一次删除、一次服务重启，客户端没收到响应就会再发一遍。如果没有幂等控制，第二遍会真的再执行一次。Phase 199 只交付**判断层**：给定「同一个 key + 同样的 action/params」时，回答应该 `execute`、`replay`、等待 `in-progress`、报 `conflict` 还是 `reject`。

这一层刻意不做事：

- 不执行动作，不持久化记录，不联网，不读文件；
- 不引入第三方依赖，不做哈希，不调用 `node:crypto`；
- 不认证调用方，token 不是授权凭据。

记录只活在进程内，重启即丢；上层（路由 / 执行器）负责在真正执行前后调用 `begin` / `complete` / `fail`。

新增文件（未修改任何既有文件）：

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/idempotency.mjs` | 纯函数存储：key 归一化、稳定指纹、决策状态机 |
| `tests/phase-199-idempotency.test.mjs` | 28 个用例，覆盖决策、边界、TTL/LRU 与源码纯度 |
| `docs/phase-199-idempotency.md` | 本文档 |

## 导出 API 与字段

### 常量

```js
IDEMPOTENCY_DECISIONS = Object.freeze({
  EXECUTE: "execute",
  REPLAY: "replay",
  IN_PROGRESS: "in-progress",
  CONFLICT: "conflict",
  REJECT: "reject"
})
MAX_KEY_LENGTH = 128
MAX_RECORDS = 500
DEFAULT_TTL_MS = 24 * 60 * 60 * 1000   // 86400000
```

### `normalizeIdempotencyKey(value) → string | null`

- 仅接受字符串；先 `trim()`，再做白名单校验；
- 允许字符：`[A-Za-z0-9._:-]`；长度 1..128（按 trim 后的长度）；
- 空串、纯空白、超长、`/`、内部空格、换行、中文、非字符串一律返回 `null`；
- 返回的是归一化后的 key，调用方应使用返回值，而不是原始输入。

### `fingerprintRequest(action, params) → string | null`

- `action`：非空字符串，长度 ≤128（保留原始值，不 trim）；否则 `null`；
- `params`：仅允许可无损表达的 JSON 数据——`null`、布尔、有限数字、字符串、数组、普通对象（原型为 `Object.prototype` 或 `null`）；
- 拒绝：函数、`undefined`、`Symbol`、`BigInt`、`NaN`/`Infinity`、稀疏数组、`Date`/`Map`/`Set`/类实例、循环引用、嵌套深度 >16；
- 序列化稳定：对象键排序、递归；数组保持顺序；数字用 `JSON.stringify`；
- 序列化结果超过 **4096 字符**时截断到 4096，并在记录上留 `notes: ["params-truncated"]`；
- 返回格式为 `${action.length}:${action}:${boundedSerialized}`——action 带长度前缀，params 无法通过分隔符伪造 action；纯字符串比较，无哈希。

### `createIdempotencyStore({ now, ttlMs = DEFAULT_TTL_MS, maxRecords = MAX_RECORDS } = {})`

- `now`：可选函数，返回毫秒数；缺省 `() => Date.now()`。必须是有限数字，否则抛 `TypeError`；
- `ttlMs` / `maxRecords`：正整数；非法值直接抛 `TypeError`，不静默回退默认值；
- 返回冻结对象：`{ begin, complete, fail, lookup, prune, size }`。

#### `begin({ key, action, params })`

| 情况 | 返回 |
| --- | --- |
| key 非法 | `{ decision: "reject", reason: "invalid-key" }` |
| action 非法 | `{ decision: "reject", reason: "invalid-action" }` |
| params 不可序列化 | `{ decision: "reject", reason: "invalid-params" }` |
| 从未见过（或已完成记录已过期） | `{ decision: "execute", token }`，并记一条 `in-progress` 记录 |
| 同 key + 同指纹，且已完成 | `{ decision: "replay", result }` |
| 同 key + 同指纹，且进行中 | `{ decision: "in-progress" }` |
| 同 key + 不同指纹 | `{ decision: "conflict" }`，原记录保持不变 |
| 容量已满且无可淘汰的已完成记录 | `{ decision: "reject", reason: "capacity" }` |

- `token` 形如 `t1`、`t2`，是进程内自增序号；仅用于让调用方区分「这是哪一次执行」，**不是**不可猜测的凭据，不能当授权用；
- `conflict` 不更新原记录，也不会用新参数覆盖旧结果。

#### `complete({ key, result })`

- 进行中 → 置为 `completed`，记录 `result`、`completedAt = now()`、`expiresAt = completedAt + ttlMs`，返回 `{ ok: true }`；
- 未知 / 已过期 → `{ ok: false, reason: "unknown-key" }`；
- 已完成 → `{ ok: false, reason: "already-completed" }`，**不覆盖**首次结果；
- key 非法 → `{ ok: false, reason: "invalid-key" }`；
- `result` 不做 JSON 校验、不复制；本层只负责原样保存与回放，调用方应保证持久化意图下结果是可序列化的。

#### `fail({ key })`

- 进行中 → 删除该记录（下一次 `begin` 可以重新 `execute`），返回 `{ ok: true }`；
- 已完成 → `{ ok: false, reason: "already-completed" }`，不允许把成功结果回退；
- 未知 / 已过期 → `{ ok: false, reason: "unknown-key" }`；
- key 非法 → `{ ok: false, reason: "invalid-key" }`。

#### `lookup(key) → object | null`

- key 非法或不存在 / 已过期 → `null`；
- 否则返回冻结快照：

```js
{
  key, status,            // "in-progress" | "completed"
  result,                 // in-progress 时为 undefined
  fingerprint,            // 见 fingerprintRequest
  notes,                  // 冻结数组，可能含 "params-truncated"
  createdAt,              // begin 时刻
  completedAt,            // in-progress 时为 null
  expiresAt               // in-progress 时为 null
}
```

- `lookup` 会刷新该记录的 `lastAccess`，参与 LRU 排序。

#### `prune() → number`

- 清理所有已过期的 `completed` 记录，返回删除条数；`in-progress` 不清理。

#### `size() → number`

- 先按当前时钟清理过期记录，再返回当前记录数（`in-progress` + 未过期 `completed`）。

## 语义与安全边界

### 决策状态机

1. **先归一化，再决策**：key 与 params 的校验都在触碰存储之前完成；被拒绝的请求不会留下任何记录。
2. **同 key 不同请求 = 冲突，而不是覆盖**：`action` 或 `params` 任一不同即 `conflict`。冲突不会改写原记录，避免「第二次调用改写了第一次的结果」。
3. **`complete` / `fail` 以 key 为唯一定位**：本层不校验 token，因为 token 只是进程内序号。这是纯函数层的信任边界——谁能拿到 key，谁就能结算这条记录。
4. **TTL 从完成时刻起算**：`expiresAt = completedAt + ttlMs`。长时间 `in-progress` 不会因为 `begin` 时间久远而提前过期；过期判断用「`now >= expiresAt`」，到期瞬间即视为不存在。
5. **过期即删除**：`begin` / `lookup` / `complete` / `fail` / `prune` / `size` 都会先清理过期记录；`lookup` 对过期记录返回 `null`，`begin` 对过期记录按「从未见过」重新 `execute`。
6. **LRU 只淘汰已完成记录**：容量达到 `maxRecords` 时，按 `lastAccess` 最小者淘汰；时间相同则按插入顺序（Map 顺序）淘汰最早的一条。`in-progress` 永不淘汰，也永不按 TTL 过期。
7. **容量耗尽**：如果 `maxRecords` 条记录全是 `in-progress`，没有可淘汰对象，`begin` 返回 `reject/capacity`，而不是突破上限或淘汰进行中的记录。这是本阶段新增的第三种 reject 原因（前两种是 `invalid-key` / `invalid-params`），上层应把它当作「暂时不能接新请求」，不要盲目重试。
8. **结果只来自 `complete`**：`replay` 返回的永远是首次 `complete` 写入的 `result`；本层不会合成、猜测或从 params 推导结果。

### 「不猜」原则

- **不猜 key**：非法 key（空、超长、含 `/`、空格、中文、换行）直接 `invalid-key`，不会 trim 成别的值、不会替换成随机值、不会自动生成 key。
- **不猜 params**：`undefined`、函数、`Symbol`、`BigInt`、循环引用、稀疏数组、类实例等无法无损表达的值一律 `invalid-params`；不会像 `JSON.stringify` 那样丢掉 `undefined` 字段后再当成功处理。
- **不猜状态**：未知、已过期、已失败的记录不会被当成成功；`lookup` 返回 `null`，`complete` / `fail` 返回 `unknown-key`。
- **不猜结果**：`in-progress` 时没有结果可给，就明确返回 `in-progress`；重复 `complete` 不会用第二次的 `result` 覆盖第一次。
- **不猜容量**：没有可淘汰的已完成记录时拒绝新请求（`capacity`），而不是悄悄超过 `maxRecords` 或牺牲进行中的请求。
- **不猜时钟**：`now()` 返回非有限数字时抛 `TypeError`，而不是落回系统时间继续跑。

### 其他边界

- **零 I/O、零依赖**：模块没有任何 `import`、`require`、`crypto`、`fs`、`http`、`fetch`；测试中有源码纯度断言。
- **不改传入 params**：序列化只读，不排序原对象、不写回；冻结对象也可安全传入（有测试覆盖）。
- **有界**：key ≤128、action ≤128、params 指纹 ≤4096+action 前缀、记录 ≤`maxRecords`、嵌套深度 ≤16。
- **LRU 时间戳粒度**：`lastAccess` 使用注入时钟；同一毫秒内的多次访问时间相同，淘汰按插入顺序兜底。
- **截断碰撞**：params 序列化超过 4096 字符会截断；两个只有 4096 字符之后不同的超大 params 会得到相同指纹，从而被判为 `replay`。本阶段按需求不引入哈希依赖，调用方应让 params 保持小而稳定（或用业务 key 区分大对象）。

## 测试结果

执行：

```powershell
node --test tests/phase-199-idempotency.test.mjs
```

结果：**28 tests / 28 pass / 0 fail**（Node v22.22.0，约 160 ms）。

覆盖点：

- 常量值与 `Object.freeze`；store 方法集合与初始为空；
- key 归一化：trim、128 字符边界、白名单字符；空 / 超长 / 斜杠 / 空格 / 中文 / 非字符串拒绝；
- 主路径：`execute → complete → replay`；重复 `begin` 返回 `in-progress`；
- 冲突：同 key 不同 action、同 key 不同 params，均不覆盖；原 params 仍 replay 首次结果；
- 非法 action（空、纯空白、非字符串、超长）；
- 非法 params：函数、`undefined`（顶层与嵌套）、`Symbol`、`BigInt`、稀疏数组、循环引用、40 层嵌套、`Date`、`Map`、`NaN`、`Infinity`、类实例；
- 稳定序列化：对象键顺序不同、嵌套顺序不同，指纹一致；action 与 params 任一不同则指纹不同；
- TTL：未到期 replay、到期瞬间视为不存在并重新 `execute`；TTL 从完成时刻起算（`begin` 后 60s 才完成仍从完成时计时）；
- `prune` / `size`：只清过期 `completed`，`in-progress` 不过期；
- `maxRecords`：按 `lastAccess` 淘汰最久未用的已完成记录；`in-progress` 保留；全为 `in-progress` 时 `reject/capacity`；
- `complete` / `fail` 未知 key、非法 key；`fail` 后可重试、已完成不可回退；重复 `complete` 不覆盖；
- 冻结 params 不被修改；4096 字符截断与 `params-truncated` 留痕；
- 构造参数非法（`ttlMs` / `maxRecords` / `now`）抛 `TypeError`；
- 源码纯度：无 `import` / `require(` / `crypto` / `node:fs` / `node:http` / `fetch(`。

## 遗留

- **只在进程内**：不持久化，重启后已完成记录全部丢失，同一请求可能再次 `execute`。真正的跨重启幂等需要持久化层（Phase 后续）。
- **`in-progress` 无租约**：进程崩溃、调用方忘记 `complete` / `fail` 时，该记录既不过期也不淘汰，会一直占着容量，最终让 `begin` 返回 `reject/capacity`。当前只能靠调用方 `finally { fail }` 或重启进程清理。
- **无跨进程 / 多实例协调**：同一 key 打到两个实例会各自 `execute`；本层不提供分布式锁。
- **截断碰撞**：见上文；如需消除，应引入哈希（会破坏「零依赖/纯字符串比较」的本阶段约束）。
- **结果不设上限**：`result` 原样保存在内存里，超大结果会占用内存；上层应只回放小结果（如 id、状态、摘要）。
- **未接入路由 / UI / 执行器**：本阶段只交付纯函数层；`complete` / `fail` 的调用时机、HTTP 状态映射（建议 `conflict` → 409、`in-progress` → 409/425、`capacity` → 429/503）留给接入阶段。
- **key 的信任模型**：`complete` / `fail` 只认 key；如果后续暴露到 HTTP，必须把 key 绑定到已认证会话或高熵请求 id，不能让客户端随意猜别人的 key。
