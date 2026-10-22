/**
 * Phase 172 — 受控 Web 取证的证据转换（模块 06「受控 Web 取证」的证据层）
 *
 * 抓取由调用方完成，本模块只负责把「抓取结果」变成**可归档、可审计、有限**
 * 的证据对象。刻意不包含任何网络访问代码：既不 fetch，也不解析 DNS，
 * 更没有真实抓取实现——网络出口的裁决在 `network-policy.mjs` 里。
 *
 * 红线：
 *   - 页面正文**不会**原样进入证据：只保留去标签、压空白、截断后的纯文本摘要；
 *   - 摘要长度有硬上限，超限截断并留下 `truncated` 标记；
 *   - 证据内容做密钥/令牌脱敏，且只记录被过滤的字段名，不记录原文；
 *   - 策略判定为拒绝时，产出的证据是**拒绝记录**，不携带任何正文。
 *
 * 脱敏思路与 `app/diagnostic-evidence.mjs` 里的 `redact()` 一致（赋值形态的
 * 密钥、常见令牌形态）；那一份是模块私有函数，未对外导出，因此此处按同等
 * 强度自带实现，不改动那个文件。
 */

import { Buffer } from "node:buffer";

/** 证据正文摘要的默认上限。 */
export const MAX_EVIDENCE_TEXT_LENGTH = 4000;

/** 证据正文摘要的硬上限（调用方给再大的值也不会突破）。 */
export const MAX_EVIDENCE_TEXT_LENGTH_HARD = 20000;

/** 证据标题上限。 */
export const MAX_EVIDENCE_TITLE_LENGTH = 200;

/** 证据里记录的来源 URL 长度上限。 */
export const MAX_EVIDENCE_URL_LENGTH = 2048;

/** 形如 `apiKey=xxx` / `token: xxx` 的赋值，值会被替换掉。 */
const SECRET_ASSIGNMENT_PATTERN = /\b(api[-_]?key|apikey|secret|token|password|passwd|pwd|credential|authorization|bearer|private[-_]?key|access[-_]?key|refresh[-_]?key|client[-_]?secret|session[-_]?id)\b(\s*[:=]\s*)("?)([^\s"',;)}\]]{1,})/gi;

/** 形如 `sk-xxx` / `ghp_xxx` / `AKIA...` / JWT 的常见令牌形态。 */
const SECRET_TOKEN_PATTERN = /\b(sk|pk|ghp|gho|ghs|ghu|ghr|xox[baprs]|AKIA|ASIA|AIza|ya29|github_pat)[-_][A-Za-z0-9_\-.]{8,}\b/g;

/** JWT（eyJ 开头，三段 base64url）。 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** 敏感字段名（大小写不敏感，按子串匹配）。 */
const SENSITIVE_FIELD_PATTERN = /(api[-_]?key|apikey|secret|token|password|passwd|pwd|credential|authorization|bearer|private[-_]?key|access[-_]?key|refresh[-_]?key|client[-_]?secret|session[-_]?id|cookie)/i;

/** 常见 HTML 实体。 */
const ENTITIES = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", "\""],
  ["&apos;", "'"],
  ["&#39;", "'"],
  ["&nbsp;", " "],
  ["&#x27;", "'"],
  ["&#47;", "/"]
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 解码常见的 HTML 实体。
 *
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    const known = ENTITIES.get(match.toLowerCase()) ?? ENTITIES.get(match);
    if (known) return known;
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
    }
    return match;
  });
}

/**
 * 把 HTML 剥成纯文本：去掉脚本、样式、注释与标签，实体解码后压空白。
 *
 * @param {string} html
 * @returns {{title: string, text: string}}
 */
export function htmlToText(html) {
  const raw = String(html ?? "");
  const titleMatch = /<title[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(raw);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  const stripped = raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  const flattened = decodeEntities(stripped).replace(/\s+/g, " ").trim();
  return { title, text: flattened };
}

/**
 * 抹掉文本里的密钥形态，并记录被过滤的字段名（只记字段名，不记原文）。
 *
 * @param {string} value
 * @returns {{text: string, fields: string[]}}
 */
export function redactWebText(value) {
  const fields = new Set();
  let out = String(value ?? "");
  out = out.replace(SECRET_ASSIGNMENT_PATTERN, (match, key, separator) => {
    fields.add(String(key).toLowerCase());
    return `${key}${separator}[已隐藏]`;
  });
  out = out.replace(SECRET_TOKEN_PATTERN, () => {
    fields.add("token");
    return "[已隐藏令牌]";
  });
  out = out.replace(JWT_PATTERN, () => {
    fields.add("token");
    return "[已隐藏令牌]";
  });
  // HTML 属性形态：name="apiKey" value="..." —— 键名本身需要记录。
  out = out.replace(/\b(name|id|data-[\w-]*)(\s*=\s*)("?)([A-Za-z0-9_.\-]*)("?)/g, (match, key, separator, quote, keyName) => {
    if (SENSITIVE_FIELD_PATTERN.test(keyName)) {
      fields.add(keyName.toLowerCase());
      return `${key}${separator}${quote}[已隐藏]${quote}`;
    }
    return match;
  });
  return { text: out, fields: [...fields].sort() };
}

/**
 * 把抓取结果转换成可归档的证据对象。
 *
 * @param {object} input
 * @param {string} input.url 抓取来源 URL
 * @param {number} [input.status] HTTP 状态码
 * @param {string} [input.contentType] 响应 Content-Type
 * @param {string} [input.body] 响应正文（HTML 或纯文本）
 * @param {string} [input.fetchedAt] 抓取时间（ISO 字符串）
 * @param {object} [input.policyDecision] `network-policy` 的判定结果
 * @param {number} [input.maxLength] 摘要长度上限
 * @returns {object} 证据对象
 */
export function buildWebEvidence({
  url = "",
  status = 0,
  contentType = "",
  body = "",
  fetchedAt = "",
  policyDecision = null,
  maxLength = MAX_EVIDENCE_TEXT_LENGTH
} = {}) {
  const rawUrl = text(url);
  const limit = Math.max(0, Math.min(Number.parseInt(maxLength, 10) || MAX_EVIDENCE_TEXT_LENGTH, MAX_EVIDENCE_TEXT_LENGTH_HARD));
  const policyAllowed = policyDecision ? policyDecision.allowed !== false : true;
  const policyReason = policyDecision?.reason ? String(policyDecision.reason) : "allowed";

  const base = {
    type: "web-evidence",
    source: "web",
    url: rawUrl.slice(0, MAX_EVIDENCE_URL_LENGTH),
    status: Number.isInteger(status) ? status : 0,
    contentType: text(contentType).slice(0, 120),
    fetchedAt: text(fetchedAt).slice(0, 40),
    policy: Object.freeze({ allowed: policyAllowed, reason: policyReason })
  };

  // 策略拒绝：产出拒绝记录，不携带任何正文——绝不静默降级。
  if (!policyAllowed) {
    return Object.freeze({
      ...base,
      allowed: false,
      title: "",
      excerpt: "",
      length: 0,
      bytes: 0,
      truncated: false,
      redactedFields: []
    });
  }

  const rawBody = typeof body === "string" ? body : "";
  const bytes = Buffer.byteLength(rawBody, "utf8");
  const looksLikeHtml = /<\s*[a-z!/]/i.test(rawBody);
  const { title, text: plain } = looksLikeHtml
    ? htmlToText(rawBody)
    : { title: "", text: decodeEntities(rawBody).replace(/\s+/g, " ").trim() };

  const redacted = redactWebText(plain);
  const excerpt = redacted.text.length > limit ? `${redacted.text.slice(0, limit)}…` : redacted.text;

  return Object.freeze({
    ...base,
    allowed: true,
    title: title.slice(0, MAX_EVIDENCE_TITLE_LENGTH),
    excerpt,
    length: excerpt.length,
    bytes,
    truncated: redacted.text.length > limit,
    redactedFields: Object.freeze(redacted.fields)
  });
}
