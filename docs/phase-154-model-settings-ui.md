# Phase 154 — Model Settings UI

腾讯 Marvis 桌面端的大模型管理面板具备四个明确的产品要点：API Key 只以指纹
形式出现、编辑时永不回显明文；保存失败时错误被定位到**具体字段**而不是一段
整体提示；「新增供应商」与「配置凭据」分成两步向导；凭据测试与端点校验给出
可判读的状态。

本阶段把上面四点实现为一个**不依赖 DOM 的纯函数模块**，放在
`apps/fnos-nas-agent/app/ui/model-settings.js`，配套一份只新增、不覆盖既有
样式的样式表 `apps/fnos-nas-agent/app/ui/model-settings.css`。本阶段**不修改**
任何既有文件：既有的 `app/ui/index.html`、`app/ui/pages.js`、`app/ui/core.js`、
`app/ui/styles.css` 与全部后端模块保持原样，模块的挂载由后续集成步骤完成。

## 1. 背景：Marvis 对照

逆向结论（详见交付报告 `C:\Users\Administrator\.dsh\ungrouped\reports\marvis-ui-report.md`）
中与模型管理直接相关的部分：

| Marvis 行为 | 逆向证据 | 本阶段对应实现 |
| --- | --- | --- |
| 列表只回 `api_key_fingerprint`，形如 `sk-...XXXX` | bundle 常量 `Lbe(e)=\`sk-...${e.trim().slice(-4)||"****"}\`` | `fingerprintSecret()` 返回 `sha256:` + 前 8 位十六进制；明文永不进入渲染路径 |
| 编辑时 `apiKey` 回填空，提交前另调详情接口取回 | bundle `m1n(config)` / `A1n()` | `validateProviderForm(form, { requireApiKey:false, hasStoredKey:true })` 允许留空表示保留 |
| 错误码映射到字段：`Unreachable→baseUrl`、`InvalidKey→apiKey`、`ModelNotFound→modelId`、`Duplicate→displayName` | bundle `p1n(code)` | `locateProviderError(error, codeMap)` 把后端 `code` 定位到字段 |
| 两步向导：`step = "provider" \| "form"` | bundle `g1n` @6433217 | `buildProviderWizardSteps()` 返回 provider → credentials → model → confirm 四步 |
| 面板视觉：列表容器 24px 圆角、列表项 64px 高、输入框 12px 圆角、字段错误红 `#f75040`、外链蓝 `#0080ff` | `treemap-KZPCXAKY-DLtJrR72.css` 的 `_modelPanel_*` / `_modelForm_*` | `model-settings.css` 中同名视觉基线 |

Marvis 的指纹是「明文末 4 位」，强度低；本阶段改用 sha256 摘要前 8 位，
既保持「一眼可辨、不可还原」的交互语义，又不泄露明文片段。

## 2. 变更边界

本阶段**只新增**四个文件：

| 文件 | 作用 |
| --- | --- |
| `apps/fnos-nas-agent/app/ui/model-settings.js` | ES module，导出 8 个纯函数；无 DOM、无网络、无全局副作用 |
| `apps/fnos-nas-agent/app/ui/model-settings.css` | 样式；所有类名以 `.model-settings__` 开头 |
| `tests/phase-154-model-settings-ui.test.mjs` | `node --test` 用例 |
| `docs/phase-154-model-settings-ui.md` | 本文档 |

明确**没有**发生的事：

- 没有修改 `app/ui/index.html`、`app/ui/pages.js`、`app/ui/core.js`、`app/ui/styles.css`；
- 没有修改 `model-provider-store.mjs`、`model-chat-adapter.mjs`、`server.mjs` 或任何后端模块；
- 没有新增、修改或删除任何 HTTP 路由；
- 没有修改 `model-providers.json` 的存储结构（仍然是 version 1 的
  `name / endpoint / model / apiKey / enabled / fallback`）；
- 没有修改 `README.md`、`docs/README.md`、`scripts/check-release-gates.mjs`；
- 没有执行 `git commit`。

后端能力完全没有变化：凭据仍然由 `model-provider-store.mjs` 以
AES-256-GCM 信封加密保存（`model-provider-store.mjs:193-202`），主密钥文件
`model-provider.key`；`publicProvider()`（`:68`）继续只暴露 `hasApiKey` 布尔值。

## 3. 导出 API 约定

```js
import {
  escapeHtml,
  fingerprintSecret,
  validateProviderForm,
  locateProviderError,
  buildProviderWizardSteps,
  summarizeWizard,
  describeCredentialState,
  renderProviderCard
} from "/ui/model-settings.js";
```

| 导出 | 签名 | 返回 | 说明 |
| --- | --- | --- | --- |
| `escapeHtml` | `(value: unknown) => string` | 转义后的文本 | `& < > " '` 五个字符；null/undefined → `""` |
| `fingerprintSecret` | `(secret: unknown) => Promise<string \| null>` | `"sha256:1a2b3c4d"` 或 `null` | 空串 / 空白 / 非字符串 → `null`；用 `crypto.subtle.digest("SHA-256", …)` |
| `validateProviderForm` | `(form: object, options?: {requireApiKey?: boolean, hasStoredKey?: boolean}) => {valid: boolean, errors: Record<string,string>}` | 字段级错误表 | 输入别名：`baseUrl \| endpoint`、`modelId \| model`；一次返回**全部**出错字段 |
| `locateProviderError` | `(error: unknown, codeMap?: Record<string,string>) => {field: string, message: string}` | 字段名 + 文案 | `codeMap` 把后端 `code` 映射到字段；未知码落到 `field: ""`（整体错误） |
| `buildProviderWizardSteps` | `(values: object, options?) => Array<{key, title, fields: string[], valid: boolean}>` | 步骤数组 | 固定四步：`provider` / `credentials` / `model` / `confirm`；每步 `valid` 只取决于**自己**的字段 |
| `summarizeWizard` | `(steps: Array<{key,valid}>) => {stepIndex, totalSteps, stepKey, canSubmit, isComplete}` | 进度摘要 | `stepKey` 指向第一个未通过的步骤 |
| `describeCredentialState` | `(record: object) => {key, keyLabel, keyTone, test, testLabel, testTone, summary}` | 凭据与测试状态 | 只读 `{hasKey, keyFingerprint, lastTestAt, lastTestOk}`；**忽略**记录中的任何其它字段 |
| `renderProviderCard` | `(provider: object, state?: object) => string` | 安全 HTML 字符串 | 所有服务端字段经 `escapeHtml()`；徽标含「当前默认 / 已启用 / 已停用 / 备用模型 / 上次调用失败」 |

字段级错误文案（`validateProviderForm`）：

| 字段 | 文案 |
| --- | --- |
| `name` | 请填写服务商名称 |
| `baseUrl` | 请填写正确的接口地址 / 接口地址必须以 http:// 或 https:// 开头 |
| `apiKey` | 请填写 API Key / API Key 不能包含空格 |
| `modelId` | 请填写模型 ID |

## 4. 安全设计

1. **不回显密钥。** `describeCredentialState()` 只接受四个白名单字段；即使调用方
   把整条服务端记录（含 `apiKey`）传进来，返回值里也不含明文。测试
   「describeCredentialState never leaks a plaintext secret even when the record
   carries one」把这一点钉死。
2. **指纹而非明文片段。** `fingerprintSecret()` 返回 sha256 摘要前 8 位，
   不像 Marvis 那样暴露明文末 4 位；指纹本身也不能反推密钥。
3. **空值语义明确。** 空串 / 空白 / 非字符串一律视为「没有密钥」，返回 `null`，
   避免把 `undefined` 渲染成 `"undefined"` 之类的脏字符串。
4. **编辑留空 = 保留原值。** 只有在 `hasStoredKey === true` 时才允许 `apiKey`
   为空；否则仍然报「请填写 API Key」。
5. **端点协议校验。** 只接受 `http:` / `https:`；`ftp:`、`file:`、
   `javascript:` 等一律拒绝并给出字段级文案。解析失败与协议不符是两种不同的
   错误，便于区分「填错了」和「协议不对」。
6. **HTML 转义防注入。** `renderProviderCard()` 对 `id / name / endpoint / model`
   以及指纹、状态文案统一 `escapeHtml()`；属性值同样转义，因此
   `"><script>alert(1)</script>` 无法逃逸出 `data-provider-id`。
7. **样式不越界。** `model-settings.css` 里的选择器全部带 `.model-settings__`
   前缀，不覆盖 `.card` / `.btn` / `.input` 等既有全局类。
8. **不新增传输面。** 本阶段没有新增任何网络请求，也没有把密钥发往新端点；
   凭据仍然只在提交表单时发往既有的 `/api/models`。

## 5. 未改变的红线

- 未执行任何腾讯 Marvis 可执行文件（逆向阶段全程只读）；
- 未修改 Marvis 安装目录与用户数据目录；
- 未修改 `fnos-nas-agent` 的任何既有文件；
- 未修改后端加密存储格式与主密钥机制；
- 未新增 HTTP 路由、未放宽任何鉴权 / 限流 / 白名单规则；
- 未执行 `git commit`。

## 6. 测试清单

```bash
node --test tests/phase-154-model-settings-ui.test.mjs
```

共 23 个用例，全部通过（`# pass 23 / # fail 0`）：

| # | 用例 | 覆盖点 |
| --- | --- | --- |
| 1 | fingerprintSecret returns a sha256 prefixed 8 hex digit fingerprint | 指纹格式与长度 |
| 2 | fingerprintSecret is stable for the same secret and differs for another | 稳定性与区分度 |
| 3 | fingerprintSecret returns null for empty, blank and non string secrets | 空值语义 |
| 4 | fingerprintSecret never contains the plaintext secret | 指纹不泄露明文 |
| 5 | validateProviderForm accepts a complete form | 合法表单通过 |
| 6 | validateProviderForm reports a missing name on the name field | 字段级定位：name |
| 7 | validateProviderForm reports a missing API key on the apiKey field | 字段级定位：apiKey |
| 8 | validateProviderForm reports a missing model id on the modelId field | 字段级定位：modelId |
| 9 | validateProviderForm rejects a non http(s) endpoint protocol | 协议校验（ftp/file/javascript） |
| 10 | validateProviderForm accepts plain http endpoints and rejects malformed ones | http 可用、非法地址报错 |
| 11 | validateProviderForm accepts the endpoint and model aliases used by the existing form | 与既有表单字段别名兼容 |
| 12 | validateProviderForm allows an empty API key only when editing with a stored key | 编辑留空语义 |
| 13 | validateProviderForm returns every failing field at once | 一次返回全部错误字段 |
| 14 | locateProviderError maps a backend code onto the offending field | 后端错误码 → 字段 |
| 15 | buildProviderWizardSteps returns at least three ordered steps with fields | 向导步骤完整性 |
| 16 | buildProviderWizardSteps marks each step valid only when its own fields are filled | 逐步依赖 |
| 17 | summarizeWizard reports the first incomplete step | 进度摘要 |
| 18 | describeCredentialState never leaks a plaintext secret even when the record carries one | 状态不含明文 |
| 19 | describeCredentialState distinguishes missing key and failed test | 未配置 / 测试失败态 |
| 20 | renderProviderCard escapes user supplied values so markup cannot be injected | HTML 转义防注入 |
| 21 | renderProviderCard shows the default badge and the unavailable hint | 徽标与失败提示 |
| 22 | renderProviderCard escapes attribute values as well | 属性值转义 |
| 23 | escapeHtml neutralises the five dangerous characters | 转义原语 |

## 7. 集成说明

本阶段**没有**接入页面；以下为后续集成步骤（由集成方在
`app/ui/index.html` 与 `app/ui/pages.js` 中完成）：

1. **引入模块。** `model-settings.js` 是 ES module，而现有 `index.html` 用传统
   `<script>` 加载 `core.js` → `pages.js`（两者共享全局词法作用域）。
   两种可行做法：
   - 在 `index.html` 增加
     `<script type="module" src="/ui/model-settings.js"></script>`，并由该
     module 内部 `import` 后把需要的能力挂到 `window`（推荐，避免污染既有
     全局作用域）；
   - 或把纯函数复制进 `pages.js`（不推荐，会产生第二份实现）。
2. **引入样式。** 在 `index.html` 的 `<head>` 中增加
   `<link rel="stylesheet" href="/ui/model-settings.css">`。
3. **挂载点建议。**
   - `#model-provider-list`（`index.html:447`）：改为用
     `renderProviderCard(item, { keyFingerprint, lastTestAt, lastTestOk })`
     渲染条目，替换现有 `document.createElement` 逐字段拼装的卡片逻辑
     （`pages.js:83-93` 附近）。
   - `#model-provider-form`（`index.html:462`）：提交前调用
     `validateProviderForm({ name, baseUrl, apiKey, modelId }, { requireApiKey, hasStoredKey })`，
     把 `errors` 逐字段写到对应输入框下方的 `.model-settings__field-error`；
     `valid === false` 时不发起请求。
   - `#model-provider-error`（`index.html:503`）：把服务端返回的
     `{ error, code }` 交给 `locateProviderError(error, { MODEL_INVALID_ENDPOINT: "baseUrl", MODEL_KEY_REQUIRED: "apiKey", MODEL_INVALID_FIELD: "modelId" })`，
     有字段的落到字段旁，没有字段的留在整体错误位。
   - 新增向导容器：在「添加或编辑服务商」卡片（`index.html:451-505`）内放一个
     `.model-settings__wizard` 容器，由 `buildProviderWizardSteps(values)` 驱动
     四步进度条（`.model-settings__wizard-steps`）。
   - API Key 输入框继续使用 `type="password"`；回显策略保持「编辑留空表示保留
     已保存密钥」（`pages.js:103` 已有该 placeholder 语义）。
4. **指纹的来源。** 服务端目前只暴露 `hasApiKey` 布尔值，没有指纹字段。
   若要在 UI 展示指纹，需要后端在 `publicProvider()` 中额外返回
   `keyFingerprint`（可由 `model-provider-store.mjs` 解密后计算 sha256 前 8 位，
   或在保存时一并落库）。**在此之前**，UI 只能显示「已配置密钥 / 未配置密钥」。
5. **凭据测试状态。** `publicProvider()` 已返回 `lastTest`
   （`{ ok, at, message, statusCode, durationMs }`）；把它映射成
   `describeCredentialState()` 需要的 `{ lastTestAt: lastTest.at, lastTestOk: lastTest.ok }`
   即可显示「最近连接测试成功 / 失败（时间）」。

## 8. 后续建议

1. 在 `model-provider-store.mjs` 的 `publicProvider()` 中补 `keyFingerprint`
   （sha256 前 8 位），使 UI 能显示 Marvis 式的指纹徽标。
2. 把向导状态（当前步、已完成步）提到 `pages.js` 的模块级变量，刷新页面后
   仍停留在同一步。
3. `renderProviderCard()` 目前只输出展示结构；「编辑 / 测试连接 / 设为默认 /
   删除」按钮建议由既有 `pages.js` 在渲染后绑定，避免把事件处理塞进纯函数。
4. 为 `locateProviderError()` 补一张完整的 `code → field` 常量表，覆盖
   `MODEL_PROVIDER_LIMIT`、`MODEL_PROVIDER_DISABLED`、`MODEL_PROVIDER_NOT_FOUND`
   等既有错误码。
5. 若后续引入 Marvis 的「模型不可用（unavailable）」态，可在
   `describeCredentialState()` 上增加 `unavailableReason` 字段与对应徽标
   （Marvis 文案：「该模型上次调用失败，建议检查配置或前往服务商平台查看」）。
