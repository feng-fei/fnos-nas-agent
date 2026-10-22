/* ==================================================================
 * model-settings.js —— Phase 154：Marvis 风格「大模型管理」UI 组件
 *
 * 职责：把「服务商 / 模型凭据」的管理界面拆成若干**纯函数**，便于在
 *      node --test 中直接断言，不依赖 DOM、不发起网络请求。
 *
 * 背景（Marvis 对照）：腾讯 Marvis 桌面端的大模型管理面板具备四个要点——
 *   1) API Key 只显示指纹（`sk-...XXXX`），编辑时永不回显明文；
 *   2) 保存失败时把错误定位到**具体字段**（baseUrl / apiKey / modelId …）；
 *   3) 「新增供应商」与「配置凭据」分成两步向导；
 *   4) 凭据测试与端点校验给出明确状态。
 *   本模块按同一语义实现，但指纹算法改用 sha256 前 8 位（Marvis 用末 4 位明文
 *   派生，强度不足）。
 *
 * 安全约定（不可放宽）：
 *   - 本模块**永不**接收、返回或渲染 API Key 明文；
 *   - 凭据状态只由 {hasKey, keyFingerprint, lastTestAt, lastTestOk} 派生；
 *   - 所有进入 HTML 的用户输入都必须经过 escapeHtml()。
 *
 * 集成方式：本文件是 ES module。浏览器端请以
 *   <script type="module" src="/ui/model-settings.js"></script>
 *   引入，或在已有 module 脚本中 `import { … } from "/ui/model-settings.js"`。
 *   现有 index.html 使用传统 script + 全局词法作用域，因此**不要**在此文件
 *   中声明会与 core.js / pages.js 冲突的顶层标识符。
 * ================================================================== */

const FINGERPRINT_PREFIX = "sha256:";
const FINGERPRINT_HEX_LENGTH = 8;

/** Marvis 风格的中文字段级错误文案。 */
const FIELD_MESSAGES = Object.freeze({
  name: "请填写服务商名称",
  baseUrl: "请填写正确的接口地址",
  apiKey: "请填写 API Key",
  modelId: "请填写模型 ID",
  presetId: "请选择一个模型提供商"
});

/* ------------------------------------------------------------------
 * 基础工具
 * ---------------------------------------------------------------- */

/**
 * HTML 转义。所有插入 HTML 字符串的用户输入都必须经过这里。
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------------------------------------------
 * 1) 密钥指纹
 * ---------------------------------------------------------------- */

/**
 * 计算 API Key 的 sha256 指纹（只取前 8 位十六进制）。
 * 空值 / 非字符串返回 null —— 表示「没有密钥」。
 *
 * @param {unknown} secret 待指纹化的密钥明文；调用方负责不落盘、不打日志。
 * @returns {Promise<string|null>} 形如 "sha256:1a2b3c4d"
 */
export async function fingerprintSecret(secret) {
  const value = text(secret);
  if (!value) return null;
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== "function") {
    throw new Error("当前运行环境不支持 WebCrypto SHA-256 摘要。");
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await subtle.digest("SHA-256", bytes);
  return FINGERPRINT_PREFIX + hex(digest).slice(0, FINGERPRINT_HEX_LENGTH);
}

/* ------------------------------------------------------------------
 * 2) 字段级校验
 * ---------------------------------------------------------------- */

/**
 * 校验服务商表单，返回字段级错误。
 *
 * 接受的输入别名（与现有 index.html 表单字段对齐）：
 *   name      ← name
 *   baseUrl   ← baseUrl | endpoint
 *   apiKey    ← apiKey
 *   modelId   ← modelId | model
 *
 * @param {object} form
 * @param {{requireApiKey?: boolean, hasStoredKey?: boolean}} [options]
 *        requireApiKey：新增时为 true（默认）；编辑时传 false。
 *        hasStoredKey：已保存过密钥时，编辑留空视为「保留原值」。
 * @returns {{valid: boolean, errors: Record<string,string>}}
 */
export function validateProviderForm(form, options = {}) {
  const source = form && typeof form === "object" ? form : {};
  const requireApiKey = options.requireApiKey !== false;
  const hasStoredKey = options.hasStoredKey === true;
  const errors = {};

  const name = text(source.name);
  if (!name) errors.name = FIELD_MESSAGES.name;

  const baseUrl = text(source.baseUrl !== undefined ? source.baseUrl : source.endpoint);
  if (!baseUrl) {
    errors.baseUrl = FIELD_MESSAGES.baseUrl;
  } else {
    let parsed = null;
    try {
      parsed = new URL(baseUrl);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      errors.baseUrl = FIELD_MESSAGES.baseUrl;
    } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.baseUrl = "接口地址必须以 http:// 或 https:// 开头";
    } else if (!parsed.hostname) {
      errors.baseUrl = FIELD_MESSAGES.baseUrl;
    }
  }

  const apiKey = text(source.apiKey);
  // 新增时密钥必填；编辑时只有在「确实存在已保存密钥」的前提下才允许留空。
  const keyMissing = !apiKey;
  if (requireApiKey ? keyMissing : (keyMissing && !hasStoredKey)) {
    errors.apiKey = FIELD_MESSAGES.apiKey;
  } else if (apiKey && /\s/.test(apiKey)) {
    errors.apiKey = "API Key 不能包含空格";
  }

  const modelId = text(source.modelId !== undefined ? source.modelId : source.model);
  if (!modelId) errors.modelId = FIELD_MESSAGES.modelId;

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * 把后端返回的错误（{error, code}）定位到字段。
 * 未知错误码退化为整体错误（field = ""）。
 *
 * @param {unknown} error  捕获到的 Error 或后端 JSON
 * @param {Record<string,string>} [codeMap] code → 字段名
 * @returns {{field: string, message: string}}
 */
export function locateProviderError(error, codeMap = {}) {
  const payload = error && typeof error === "object" ? error : {};
  const code = text(payload.code);
  const message = text(payload.error || (error instanceof Error ? error.message : ""));
  const field = codeMap[code];
  if (field) return { field, message: message || "该字段填写有误，请检查后重试。" };
  return { field: "", message: message || "保存失败，请稍后重试。" };
}

/* ------------------------------------------------------------------
 * 3) 两步向导
 * ---------------------------------------------------------------- */

const WIZARD_STEPS = Object.freeze([
  Object.freeze({ key: "provider", title: "选择模型提供商", fields: Object.freeze(["presetId", "name"]) }),
  Object.freeze({ key: "credentials", title: "填写接口地址与密钥", fields: Object.freeze(["baseUrl", "apiKey"]) }),
  Object.freeze({ key: "model", title: "选择模型并测试", fields: Object.freeze(["modelId"]) }),
  Object.freeze({ key: "confirm", title: "确认保存", fields: Object.freeze([]) })
]);

/**
 * 构建「新增服务商 / 配置凭据」向导的步骤数组。
 *
 * @param {object} values {presetId, name, baseUrl, apiKey, modelId}
 * @param {{requireApiKey?: boolean, hasStoredKey?: boolean}} [options]
 * @returns {Array<{key: string, title: string, fields: string[], valid: boolean}>}
 */
export function buildProviderWizardSteps(values, options = {}) {
  const source = values && typeof values === "object" ? values : {};
  const requireApiKey = options.requireApiKey !== false;
  const hasStoredKey = options.hasStoredKey === true;

  const presetId = text(source.presetId);
  const name = text(source.name);
  const baseUrl = text(source.baseUrl !== undefined ? source.baseUrl : source.endpoint);
  const apiKey = text(source.apiKey);
  const modelId = text(source.modelId !== undefined ? source.modelId : source.model);

  const providerValid = Boolean(presetId) || Boolean(name);
  const credentialsValid = Boolean(baseUrl) && (Boolean(apiKey) || hasStoredKey || !requireApiKey);
  const modelValid = Boolean(modelId);

  const validity = {
    provider: providerValid,
    credentials: credentialsValid,
    model: modelValid
  };

  return WIZARD_STEPS.map(step => ({
    key: step.key,
    title: step.title,
    fields: [...step.fields],
    valid: step.key === "confirm"
      ? validity.provider && validity.credentials && validity.model
      : validity[step.key]
  }));
}

/**
 * 向导进度：返回第几步、以及是否可以提交。
 * @param {Array<{key:string,valid:boolean}>} steps
 */
export function summarizeWizard(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const currentIndex = list.findIndex(step => !step.valid);
  const activeIndex = currentIndex === -1 ? list.length - 1 : currentIndex;
  return {
    stepIndex: activeIndex,
    totalSteps: list.length,
    stepKey: list[activeIndex] ? list[activeIndex].key : "",
    canSubmit: list.length > 0 && list.every(step => step.valid),
    isComplete: list.length > 0 && list.every(step => step.valid)
  };
}

/* ------------------------------------------------------------------
 * 4) 凭据状态
 * ---------------------------------------------------------------- */

/**
 * 描述凭据状态。**只**读取 {hasKey, keyFingerprint, lastTestAt, lastTestOk}，
 * 忽略记录中的任何其它字段（例如 apiKey 明文），因此调用方即使误传完整
 * 记录也不会泄露密钥。
 *
 * @param {object} record
 * @returns {{key: string, keyLabel: string, keyTone: string,
 *            test: string, testLabel: string, testTone: string,
 *            summary: string}}
 */
export function describeCredentialState(record) {
  const source = record && typeof record === "object" ? record : {};
  const hasKey = source.hasKey === true;
  const fingerprint = text(source.keyFingerprint);
  const lastTestAt = text(source.lastTestAt);
  const lastTestOk = source.lastTestOk === true;

  let key = "missing";
  let keyLabel = "未配置密钥";
  let keyTone = "muted";
  if (hasKey && fingerprint) {
    key = "configured";
    keyLabel = "已配置密钥 · " + fingerprint;
    keyTone = "ok";
  } else if (hasKey) {
    key = "configured";
    keyLabel = "已配置密钥";
    keyTone = "ok";
  }

  let test = "untested";
  let testLabel = "尚未测试连接";
  let testTone = "muted";
  if (lastTestAt) {
    test = lastTestOk ? "passed" : "failed";
    testLabel = (lastTestOk ? "最近连接测试成功" : "最近连接测试失败") + "（" + lastTestAt + "）";
    testTone = lastTestOk ? "ok" : "danger";
  }

  return {
    key,
    keyLabel,
    keyTone,
    test,
    testLabel,
    testTone,
    summary: keyLabel + " · " + testLabel
  };
}

/* ------------------------------------------------------------------
 * 5) 服务商卡片
 * ---------------------------------------------------------------- */

function badge(label, tone) {
  return '<span class="model-settings__badge model-settings__badge--' + escapeHtml(tone) + '">' + escapeHtml(label) + "</span>";
}

/**
 * 渲染一个服务商卡片的安全 HTML 字符串。
 * 所有来自服务端的字段都经过 escapeHtml()。
 *
 * @param {object} provider {id, name, endpoint, model, enabled, fallback, isDefault, hasApiKey, lastTest}
 * @param {object} [state] {keyFingerprint, lastTestAt, lastTestOk, busy}
 * @returns {string}
 */
export function renderProviderCard(provider, state = {}) {
  const item = provider && typeof provider === "object" ? provider : {};
  const extra = state && typeof state === "object" ? state : {};

  const labels = [];
  if (item.isDefault) labels.push("当前默认");
  else if (item.enabled) labels.push("已启用");
  else labels.push("已停用");
  if (item.fallback) labels.push("备用模型");

  const credential = describeCredentialState({
    hasKey: item.hasApiKey === true,
    keyFingerprint: extra.keyFingerprint,
    lastTestAt: extra.lastTestAt || (item.lastTest && item.lastTest.at) || "",
    lastTestOk: extra.lastTestOk !== undefined
      ? extra.lastTestOk === true
      : Boolean(item.lastTest && item.lastTest.ok)
  });

  const parts = [];
  parts.push('<article class="model-settings__card" data-provider-id="' + escapeHtml(item.id) + '">');
  parts.push('<div class="model-settings__card-main">');
  parts.push('<p class="model-settings__card-title">' + escapeHtml(item.name) + "</p>");
  parts.push('<p class="model-settings__card-meta">模型：' + escapeHtml(item.model) + "；Endpoint：" + escapeHtml(item.endpoint) + "</p>");
  parts.push('<p class="model-settings__card-credential model-settings__card-credential--' + escapeHtml(credential.keyTone) + '">' + escapeHtml(credential.keyLabel) + "</p>");
  parts.push('<p class="model-settings__card-test model-settings__card-test--' + escapeHtml(credential.testTone) + '">' + escapeHtml(credential.testLabel) + "</p>");
  parts.push("</div>");
  parts.push('<div class="model-settings__card-badges">');
  for (const label of labels) parts.push(badge(label, "muted"));
  if (credential.test === "failed") parts.push(badge("上次调用失败", "danger"));
  parts.push("</div>");
  parts.push("</article>");
  return parts.join("");
}

/* ------------------------------------------------------------------
 * 6) 与既有页面（index.html + pages.js）的接线
 *
 * 本文件是 ES module，而 index.html 用传统 <script> 加载 core.js / pages.js。
 * 因此模块在加载完成后把自己的纯函数挂到 window 上，供 pages.js 调用；
 * 挂载只暴露纯函数，不暴露任何凭据。
 * ---------------------------------------------------------------- */

if (typeof window !== "undefined") {
  window.ModelSettings = Object.freeze({
    escapeHtml,
    fingerprintSecret,
    validateProviderForm,
    locateProviderError,
    buildProviderWizardSteps,
    summarizeWizard,
    describeCredentialState,
    renderProviderCard
  });
  window.dispatchEvent(new Event("model-settings-ready"));
}
