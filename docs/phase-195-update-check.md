# Phase 195 — 升级检查与版本比较（纯函数）

本阶段交付「拿到当前版本与候选最新版本之后怎么判」的那一层：版本语法解析、版本比较、
升级结论、FPK manifest 版本提取。它**不联网、不读文件、不执行命令**；`latest` 从哪来、
怎么拉取、怎么缓存、怎么验签，全部留给调用方。

- 模块：`apps/fnos-nas-agent/app/update-check.mjs`（ESM，零依赖，零 `import`）
- 测试：`tests/phase-195-update-check.test.mjs`（node:test，31 个用例）
- 自验：`node --check apps/fnos-nas-agent/app/update-check.mjs`、
  `node --check tests/phase-195-update-check.test.mjs`、
  `node --test tests/phase-195-update-check.test.mjs`

---

## 1. 背景

仓库里已经有 `apps/fnos-nas-agent/app/version.mjs` 的 `APP_VERSION`（当前 `0.2.1`），
FPK manifest 里也有自己的 `version`，但在本阶段之前，没有任何地方能把这两者与「候选新版本」
放在一起判断。常见的三种错误做法都会在这里出事：

1. **字符串比较**。`"1.10.0" < "1.9.9"` 在字典序下成立，但语义化版本里 `1.10.0` 更新；
   `"1.2.3-rc.1" > "1.2.3"` 在字典序下也成立，但预发布版本必须低于同号正式版。
2. **`parseFloat` 比较**。`parseFloat("1.2.3")` 得到 `1.2`，`parseFloat("1.2.3-beta")` 也是
   `1.2`，预发布与正式版被抹成同一个数；build 元数据同样被丢掉。
3. **拿不到 latest 就当「已是最新」**。拉取失败、manifest 解析失败、字段缺失时默认
   「没有更新」，等于把一次未知伪装成一次确定的「已是最新」——这是本阶段最想避免的结论。

所以本层把「版本串 → 结构化字段 → 比较结果 → 升级结论」拆成纯函数，全部可离线单测；
真正的网络与文件访问由调用方实现。本层也不读 `version.mjs`：当前版本由调用方显式传入，
这样同一套逻辑既能检查 Agent 自身，也能检查任意 FPK。

## 2. 导出 API 与字段

### `VERSION_PATTERN`（`RegExp`）

语义化版本正则，形状为 `x.y.z`，可选 `-pre`，可选 `+build`。捕获组依次是
`major`、`minor`、`patch`、`pre`、`build`。它只匹配**规范化后**的字符串：不含前后空白、
不含 `v` 前缀（这部分宽容度由 `parseVersion` 提供）。非 `g` 正则，`test`/`exec` 无状态。

### `parseVersion(text)` → `{ major, minor, patch, pre, build, raw } | null`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `major` / `minor` / `patch` | `number` | 非负安全整数；超出 `Number.isSafeInteger` 范围视为非法 |
| `pre` | `string \| null` | 预发布串（如 `"rc.1"`），没有则为 `null` |
| `build` | `string \| null` | 构建元数据（如 `"build.7"`），没有则为 `null` |
| `raw` | `string` | **调用方传进来的原始字符串**，保留前后空白与 `v` 前缀，供审计 |

- 允许前后空白，允许 `v` / `V` 前缀（`"v1.2.3"`、`" V1.2.3 "` 均可）；只有 `v` 后紧跟
  数字时才剥离，`"version1.2.3"` 不会被误读。
- 非字符串（`null`、`undefined`、数字、对象、数组、函数、Symbol）、空串、缺段、
  非数字段、预发布为空、前导零、超出安全整数 → `null`，不抛错。
- 数字段按 SemVer 2.0.0 拒绝前导零：`"01.2.3"`、`"1.2.3-01"` 都是 `null`。

### `compareVersions(a, b)` → `-1 | 0 | 1`

`a < b` 返回 `-1`，相等返回 `0`，`a > b` 返回 `1`。

- 任一参数无法解析 → 抛 `TypeError`（**不猜顺序**）；传入已解析对象同样抛 `TypeError`，
  本函数只接受版本字符串。
- 先比 `major`、`minor`、`patch`（数值）；再比预发布：预发布低于同号正式版；
  两段预发布逐段比较，数字段按数值、字母段按字典序、数字段低于字母段，
  前缀相同则段数少的更低。
- build 元数据不参与比较：`1.2.3+aaa` 与 `1.2.3+bbb` 相等。

### `isNewerAvailable({ current, latest })` → `boolean`

只有**两侧都能解析且 `latest > current`** 才返回 `true`；任一侧非法、缺字段、
传入非对象，一律返回 `false`。注意 `false` 同时覆盖「已是最新」与「不知道」两种情况，
调用方不能据此声称「已是最新」——要区分请用 `buildUpdateVerdict`。

### `parseManifestVersion(input)` → `{ major, minor, patch, pre, build, raw } | null`

入参可以是 JSON 文本，也可以是已解析的普通对象（方便调用方复用结果）。查找顺序：

1. 根对象的 `version`；
2. 根对象下**一层**子对象里的 `version`。

失败一律 `null`：非法 JSON、根不是对象、缺字段、`version` 非字符串、版本不合法、
嵌套超过一层、多个子对象给出**不同**版本（歧义）。多个子对象给出同一个版本时不算歧义。
`raw` 保留 manifest 里 `version` 字段的原始字符串。

### `buildUpdateVerdict({ current, latest, channel })` → `{ status, current, latest, channel, notes }`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `"up-to-date" \| "update-available" \| "unknown"` | 结论 |
| `current` / `latest` | `string \| null` | 字符串原样回显；非字符串回显 `null` |
| `channel` | `string` | 校验后的通道，缺省 `"stable"` |
| `notes` | `string[]` | 稳定标识的原因列表 |

结论规则：

- 任一侧无法解析 → `unknown`，`notes` 写 `current-missing` / `current-invalid` /
  `latest-missing` / `latest-invalid`；
- 两版相等（含只差 build）→ `up-to-date`；
- `latest > current` → `update-available`；
- `latest < current` → `unknown` + `downgrade-not-offered`（本层不提供降级）；
- `channel` 只接受 `"stable"` / `"beta"` / `"any"`，缺省 `"stable"`；非法值（含 `null`、
  大写、空串、非字符串）抛 `TypeError`。它只做白名单校验与透传，不参与比较。

`options` 不是对象（含 `null`）时抛 `TypeError`；不传参数等价于 `{}`，结论是
`unknown` + 两条 missing 备注。

### 常量

- `UPDATE_CHANNELS`：`["stable", "beta", "any"]`
- `DEFAULT_UPDATE_CHANNEL`：`"stable"`
- `UPDATE_STATUSES`：`{ UP_TO_DATE: "up-to-date", UPDATE_AVAILABLE: "update-available", UNKNOWN: "unknown" }`
- `UPDATE_NOTES`：`{ CURRENT_MISSING, CURRENT_INVALID, LATEST_MISSING, LATEST_INVALID, DOWNGRADE_NOT_OFFERED }`
  对应 `current-missing`、`current-invalid`、`latest-missing`、`latest-invalid`、`downgrade-not-offered`

## 3. 语义与安全边界（含「不猜」原则）

### 3.1 版本语法：严格 SemVer 2.0.0

- `major.minor.patch` 是三段十进制非负整数，**不允许前导零**。理由不是形式主义：
  若允许 `01.2.3`，它会在数值上等于 `1.2.3`，而 `raw` 又不同，`buildUpdateVerdict`
  就会把两个不同的字符串报成 `up-to-date`。拒绝它则结论是 `unknown`，不猜。
- 预发布由 `.` 分隔的标识符组成：纯数字段不允许前导零；含字母或连字符的段是字母段，
  允许 `0-9A-Za-z-`，例如 `alpha`、`rc.1`、`x-y`、`0.3.7`。
- build 元数据同样按 `.` 分隔，但允许前导零（`+build.01` 合法），且不参与比较。
- 空标识符（`1.2.3-`、`1.2.3-rc..1`、`1.2.3+`）一律非法。
- 数字段必须落在安全整数范围内。`9007199254740992.0.0` 返回 `null`，而不是一个已经
  丢精度的近似值——比较两个被截断的数字等于猜测。

### 3.2 比较：先核心，再预发布，永不比较 build

1. `major`、`minor`、`patch` 逐段按数值比较；
2. 核心相同时：无预发布 > 有预发布（`1.0.0` > `1.0.0-rc.1`）；
3. 都有预发布时逐段比较：两边都是纯数字 → 按数值（用长度 + 字典序实现，不转
   `Number`，因此 `99999999999999999999` 这类超长数字也不会丢精度）；一边数字一边字母 →
   数字段更低；两边都是字母 → 按码元字典序；
4. 所有公共段相同 → 段数少的一侧更低（`alpha` < `alpha.1`）；
5. 全部相同 → `0`。build 从不参与。

### 3.3 结论：「unknown」永远优先，绝不冒充「已是最新」

- 任一侧解析失败就是 `unknown`，即使另一侧看起来完全正常。`notes` 必须写明原因，
  且 `status` 绝不会是 `up-to-date`。
- `latest < current` 是**降级**，本层不提供，返回 `unknown` + `downgrade-not-offered`。
- `isNewerAvailable` 返回 `false` 不等于「已是最新」，只是「没有证据表明更新」；
  是否展示「已是最新」由 `buildUpdateVerdict` 的 `up-to-date` 决定。
- `channel` 只校验、回显，不改变比较结果。版本串本身不携带通道标记，`stable` 通道
  与 `beta` 通道对同一对版本给出相同结论；「stable 通道是否忽略 `-beta` 版本」属于
  拉取层的过滤策略，不在本层猜测。
- 本层不联网、不读文件、不读 `version.mjs`：`current` 与 `latest` 都由调用方传入。

### 3.4 manifest 提取：根优先，只下探一层，歧义即失败

- 根对象的 `version` 优先级最高；根没有可用版本时才看下一层子对象的 `version`。
- 只下探一层：`{ a: { b: { version } } }` → `null`，因为契约没有承诺无限深度，
  猜层级等于猜格式。
- 同一层多个子对象若给出不同版本，无法判断哪个才是包的版本 → `null`；
  给出同一个版本（即使写法不同，如 `1.2.3` 与 `v1.2.3`）则返回该版本。
- 非法 JSON、根不是普通对象（数组、`null`、字符串标量）、`version` 非字符串、
  版本不合法 → `null`，不抛错。调用方据此走 `unknown` 分支。

### 3.5 「不猜」原则的落点

- **不猜顺序**：`compareVersions` 对非法输入抛 `TypeError`，而不是用字符串兜底。
- **不猜版本**：`parseVersion` 无法确定时返回 `null`；不补段（`1.2` 不会变成 `1.2.0`）、
  不剥离任意前缀、不做前导零归一化。
- **不猜优先级**：build 明确忽略（SemVer 规定），预发布按固定规则比较，不凭「看起来更新」。
- **不猜来源**：`parseManifestVersion` 不猜 manifest 的层级结构，不猜字段别名，
  只认 `version`；歧义直接 `null`。
- **不猜结论**：`buildUpdateVerdict` 在任一侧未知时只说 `unknown`，`notes` 说明原因；
  绝不把未知折叠成 `up-to-date` 或 `update-available`。
- **不猜通道**：`channel` 只接受白名单值，非法值抛 `TypeError`，不会默默退回默认值。

### 3.6 安全边界

- **纯函数**：模块没有任何 `import`，不使用 `node:` 内建模块，不读文件、不联网、
  不执行命令、不读环境变量、不取当前时间、不使用随机数；相同输入永远得到相同输出。
  测试里有一条静态用例断言源码不含 `import` / `require(` / `node:` 前缀 /
  `fetch(` / `process.`。
- **输入即不可信**：所有入口先做类型与语法校验；解析失败不抛错（`null` / `unknown`），
  只有「调用方用错了 API」（非法版本传给比较、非法通道、非对象 options）才抛 `TypeError`。
- **不产生越权数据**：结论只回显调用方传入的字符串，不拼接命令、不生成路径、
  不把 manifest 内容写进 `notes`。
- **有界性**：`notes` 是固定的稳定标识；版本数字段限制为安全整数；预发布数字段用字符串
  比较，不受 `Number` 精度限制。模块本身不设版本串长度上限，调用方应在采集层限制
  manifest 大小（推荐 ≤ 1 MiB）。
- **零副作用**：不修改入参，不缓存，不注册全局状态。

### 3.7 语义取舍

- **拒绝前导零（严格 SemVer）而非宽容归一化**：见 3.1，避免「数值相等但原文不同」被
  报成 `up-to-date`。
- **超出安全整数的核心段判非法**：宁可 `unknown`，也不拿丢精度的数字比较。
- **预发布字母段按 ASCII 码元序**：`1.0.0-Alpha < 1.0.0-alpha`，与 SemVer 的 ASCII
  排序一致；中文等非 ASCII 字符不允许出现在版本串里。
- **build 差异不提示**：`1.2.3+build.1` 与 `1.2.3+build.2` 判 `up-to-date` 且 `notes` 为空。
  若产品需要提示「构建号变了」，应在后续阶段显式增加 note，而不是让 build 参与比较。
- **`raw` 保留原文**（含空白与 `v` 前缀），结构化字段是规范化后的值；这样审计能看到
  用户/源站到底给了什么。
- **missing 与 invalid 分开记**：`undefined` / `null` / 空白串记 `*-missing`，其余无法解析
  的值记 `*-invalid`，便于 UI 区分「没拿到数据」和「数据是坏的」。
- **`channel` 只校验不回退**：只有 `undefined` 用默认值；显式传 `null` 或非法字符串是
  调用方错误，抛 `TypeError`。
- **`parseManifestVersion` 额外接受已解析对象**：契约写的是「JSON 文本」，但调用方通常
  已经 `JSON.parse` 过一次；多接受一种入参不改变任何判定语义，已写入测试与本文档。

## 4. 测试结果

执行（Node v22.22.0，Windows，本机，无网络、无真机、无文件读写测试数据）：

```text
node --check apps/fnos-nas-agent/app/update-check.mjs
node --check tests/phase-195-update-check.test.mjs
node --test tests/phase-195-update-check.test.mjs
```

结果为 **31 tests / 31 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**
（TAP 汇总：`# tests 31`、`# pass 31`、`# fail 0`，耗时约 0.16 s）。

覆盖点：

- `VERSION_PATTERN`：正式版、预发布、build、二者组合、捕获组顺序；拒绝空白/`v` 前缀、
  缺段、多段、非数字段、空标识符、下划线、`01.2.3`；
- `parseVersion`：字段与 `raw`、空白与 `v`/`V` 前缀、非字符串、空串、缺段、空预发布、
  前导零、超出安全整数、最大安全整数边界；
- `compareVersions`：三段数值、`1.10.0 > 1.9.9`、预发布低于正式版、预发布逐段
  （数字按值、字母按字典序、数字低于字母、段数少年纪低）、超长数字不丢精度、
  build 忽略、非法侧抛 `TypeError`；
- `isNewerAvailable`：true / false / 相等 / 降级 / 只差 build / 预发布 / 非法 / 缺字段 /
  非对象入参；
- `parseManifestVersion`：扁平 manifest、一层嵌套、根优先、对象入参、非法 JSON、
  缺字段、非法版本、非对象根、两层嵌套、重复版本不歧义、不同版本歧义；
- `buildUpdateVerdict`：`up-to-date`、`update-available`、降级 `unknown`、
  非法/缺失两侧的 notes、输入回显、channel 默认/校验/透传、非对象入参抛错、
  「unknown 绝不等于 up-to-date」遍历；
- 常量值快照；
- 源码纯度：无 `import`、无 `require(`、无 `node:` 内建模块、无网络调用、无 `process.` 读取。

## 5. 遗留

1. **`docs/README.md` 未登记（本阶段硬约束）。** 任务只允许新建 3 个文件，因此没有修改
   `docs/README.md`。仓库既有 `tests/docs-links.test.mjs` 要求「docs/README.md 列出 docs/
   下每个文档」，所以全量 `node --test` 会因本文件报出
   `every document must be listed in docs/README.md: phase-195-update-check.md`。
   接线时需向 `docs/README.md` 补一条 `phase-195-update-check.md` 链接。
2. **没有接线。** 本阶段不新增 HTTP 路由、UI 卡片、工具注册或后台任务；也没有读取
   `APP_VERSION`。调用方负责传入 `{ current, latest }`，并把 `status` 映射成界面文案。
3. **没有拉取层。** latest 的来源（官方更新源、FPK 仓库、GitHub Release）、HTTP 超时与
   重试、缓存/ETag、来源签名或哈希校验，均不在本层；本层只保证「拿到两个版本串之后
   不误判」。
4. **channel 不筛选预发布。** 若产品要求「stable 通道不提示 `-beta` 版本」，需要在拉取层
   过滤，或在本层新增「通道 + 版本标记」的匹配规则；当前 `channel` 仅做白名单与透传。
5. **FPK manifest 的真实层级未真机确认。** 本层支持根 `version` 与一层嵌套 `version`；
   如果真机 manifest 的版本在更深层或换了字段名，需要扩展 `parseManifestVersion` 并补测试。
6. **build 差异不提示。** 只差 build 的版本判 `up-to-date` 且 `notes` 为空；是否要提示由
   后续阶段决定。
7. **没有版本串长度上限。** 采集层应先限制 manifest 大小（推荐 ≤ 1 MiB），避免把超大文本
   送进解析。
8. **不支持降级。** `latest < current` 固定为 `unknown` + `downgrade-not-offered`；
   若未来要做回滚，需要新增独立结论（例如 `downgrade-available`），而不是复用本层。
