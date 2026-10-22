/* ==================================================================
 * notifications.js —— Phase 179：统一通知中心（UI11）
 *
 * 职责：把「异常 / 待审批 / 任务完成」三类事件汇总成一个只读通知中心，
 *      提供按类型过滤、未读计数、清空已读等**纯函数**，便于 node --test 断言。
 *
 * 对照矩阵：UI11 统一通知中心（此前 Open）。
 *
 * 安全约定（不可放宽）：
 *   - 所有通知文本都通过 `textContent` 写入；本文件**不含** innerHTML /
 *     outerHTML / insertAdjacentHTML / document.write；
 *   - 通知项**不携带凭据**：凭据字段被丢弃，凭据形态的字符串被替换为
 *     「[已隐藏]」；
 *   - 不发起任何网络请求；数据由调用方从既有只读接口取回后传入。
 *
 * 集成方式：本文件是 ES module。浏览器端请以
 *   <script type="module" src="/ui/notifications.js"></script>
 * 引入；模块加载完成后把自己的纯函数挂到 `window.Notifications`，供
 * 经典脚本 pages.js 调用（与 app/ui/model-settings.js 一致的双轨做法）。
 * ================================================================== */

/** 三类通知。 */
export const NOTIFICATION_TYPES = Object.freeze(["exception", "approval", "task"]);

const TYPE_LABELS = Object.freeze({
  exception: "异常",
  approval: "待审批",
  task: "任务完成"
});

const LEVEL_LABELS = Object.freeze({
  critical: "严重",
  warning: "警告",
  info: "提示"
});

const LEVEL_TONES = Object.freeze({
  critical: "danger",
  warning: "warn",
  info: "info"
});

/** 会被丢弃的凭据字段名（小写比较）。 */
const CREDENTIAL_FIELDS = Object.freeze([
  "apikey",
  "api_key",
  "key",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "password",
  "passwd",
  "secret",
  "authorization",
  "cookie",
  "credentials",
  "credential",
  "privatekey",
  "private_key",
  "session"
]);

/** 凭据形态的字符串。命中即替换，不回显原文。 */
const SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bASIA[0-9A-Z]{12,}/g,
  /\bAIza[A-Za-z0-9_-]{10,}/g,
  /\bya29\.[A-Za-z0-9_-]{10,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S{4,}/gi
]);

/* ------------------------------------------------------------------
 * 基础工具
 * ---------------------------------------------------------------- */

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toPlainObject(value) {
  return isPlainObject(value) ? value : {};
}

function parseTimestamp(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ------------------------------------------------------------------
 * 1) 凭据清洗
 * ---------------------------------------------------------------- */

/**
 * 清洗一段文本中的凭据形态内容。
 *
 * @param {unknown} value
 * @returns {{text:string, redacted:boolean}}
 */
export function scrubNotificationText(value) {
  const input = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  let redacted = false;
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    if (!pattern.test(output)) continue;
    redacted = true;
    output = output.replace(pattern, "[已隐藏]");
    pattern.lastIndex = 0;
  }
  return { text: output, redacted };
}

/**
 * 丢弃对象里的凭据字段（浅层 + 一层嵌套）。
 *
 * @param {object} record
 * @returns {object} 不含凭据字段的副本
 */
export function stripCredentialFields(record) {
  const source = toPlainObject(record);
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLowerCase().replace(/[-\s]/g, "");
    if (CREDENTIAL_FIELDS.includes(key.toLowerCase()) || CREDENTIAL_FIELDS.includes(normalized)) continue;
    if (isPlainObject(value)) {
      result[key] = stripCredentialFields(value);
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.map(item => (isPlainObject(item) ? stripCredentialFields(item) : item));
      continue;
    }
    result[key] = value;
  }
  return result;
}

/* ------------------------------------------------------------------
 * 2) 通知分类与规范化
 * ---------------------------------------------------------------- */

/**
 * 判断一条原始事件属于哪类通知。
 * 无法归类的返回 "" —— 通知中心只收录这三类事件。
 *
 * @param {object} raw
 * @returns {string} "exception" | "approval" | "task" | ""
 */
export function classifyNotification(raw) {
  const record = toPlainObject(raw);
  const declared = text(record.type).toLowerCase();
  if (NOTIFICATION_TYPES.includes(declared)) return declared;

  const kind = text(record.kind).toLowerCase();
  if (kind === "exception") return "exception";
  if (kind === "approval") return "approval";
  if (kind === "task") return "task";

  if (record.error || record.errorCode || record.statusCode) return "exception";
  if (record.approvalId || record.pendingApproval) return "approval";
  if (text(record.status).toLowerCase() === "completed" && record.taskId) return "task";
  return "";
}

/**
 * 规范化一条通知。无法归类或缺少标题的返回 null。
 *
 * @param {object} raw
 * @param {{now?: number}} [options]
 * @returns {object|null}
 */
export function normalizeNotification(raw, options = {}) {
  const record = toPlainObject(raw);
  const type = classifyNotification(record);
  if (!type) return null;

  const title = scrubNotificationText(text(record.title) || text(record.message) || text(record.summary));
  if (!title.text) return null;

  const detail = scrubNotificationText(text(record.detail) || text(record.description) || text(record.error));
  const levelRaw = text(record.level).toLowerCase();
  const level = Object.prototype.hasOwnProperty.call(LEVEL_LABELS, levelRaw)
    ? levelRaw
    : type === "exception" ? "warning" : type === "approval" ? "info" : "info";

  const at = text(record.at) || text(record.createdAt) || text(record.timestamp) || "";
  const id = text(record.id) || [type, text(record.taskId) || text(record.approvalId) || text(record.errorCode) || title.text]
    .join(":");

  return {
    id,
    type,
    typeLabel: TYPE_LABELS[type],
    title: title.text,
    detail: detail.text,
    at,
    level,
    levelLabel: LEVEL_LABELS[level],
    tone: LEVEL_TONES[level],
    source: text(record.source) || text(record.origin) || "",
    read: record.read === true,
    redacted: title.redacted || detail.redacted
  };
}

/**
 * 从三个来源汇总通知。
 *
 * @param {{exceptions?:Array<object>, approvals?:Array<object>, tasks?:Array<object>}} sources
 * @returns {{items:Array<object>, ignored:number}}
 */
export function collectNotifications(sources) {
  const data = toPlainObject(sources);
  const pools = [
    Array.isArray(data.exceptions) ? data.exceptions : [],
    Array.isArray(data.approvals) ? data.approvals : [],
    Array.isArray(data.tasks) ? data.tasks : []
  ];
  const items = [];
  let ignored = 0;
  const seen = new Set();
  for (const pool of pools) {
    for (const raw of pool) {
      const notification = normalizeNotification(raw);
      if (!notification) {
        ignored += 1;
        continue;
      }
      if (seen.has(notification.id)) continue;
      seen.add(notification.id);
      items.push(notification);
    }
  }
  items.sort((left, right) => {
    const leftAt = parseTimestamp(left.at) ?? 0;
    const rightAt = parseTimestamp(right.at) ?? 0;
    if (rightAt !== leftAt) return rightAt - leftAt;
    return left.id.localeCompare(right.id);
  });
  return { items, ignored };
}

/* ------------------------------------------------------------------
 * 3) 汇总、过滤与已读状态
 * ---------------------------------------------------------------- */

/**
 * 统计通知数量与未读数。
 *
 * @param {Array<object>} items
 * @returns {{total:number,unread:number,read:number,byType:object,unreadByType:object}}
 */
export function summarizeNotifications(items) {
  const list = Array.isArray(items) ? items : [];
  const byType = {};
  const unreadByType = {};
  for (const type of NOTIFICATION_TYPES) {
    byType[type] = { label: TYPE_LABELS[type], total: 0, unread: 0 };
    unreadByType[type] = 0;
  }
  let unread = 0;
  for (const item of list) {
    const record = toPlainObject(item);
    const type = NOTIFICATION_TYPES.includes(record.type) ? record.type : "";
    if (!type) continue;
    byType[type].total += 1;
    if (record.read !== true) {
      byType[type].unread += 1;
      unreadByType[type] += 1;
      unread += 1;
    }
  }
  return {
    total: list.length,
    unread,
    read: list.length - unread,
    byType,
    unreadByType
  };
}

/**
 * 按类型 / 未读状态过滤。
 *
 * @param {Array<object>} items
 * @param {{type?: string, unreadOnly?: boolean}} [filter]
 * @returns {Array<object>}
 */
export function filterNotifications(items, filter = {}) {
  const list = Array.isArray(items) ? items : [];
  const type = text(filter.type);
  const unreadOnly = filter.unreadOnly === true;
  return list.filter(item => {
    const record = toPlainObject(item);
    if (type && record.type !== type) return false;
    if (unreadOnly && record.read === true) return false;
    return true;
  });
}

/**
 * 标记为已读。ids 为空表示全部标记已读。返回新数组，不修改入参。
 *
 * @param {Array<object>} items
 * @param {Array<string>} [ids]
 * @returns {Array<object>}
 */
export function markNotificationsRead(items, ids = []) {
  const list = Array.isArray(items) ? items : [];
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(item => text(item)).filter(Boolean));
  return list.map(item => {
    const record = toPlainObject(item);
    if (record.read === true) return { ...record };
    if (wanted.size === 0 || wanted.has(text(record.id))) return { ...record, read: true };
    return { ...record };
  });
}

/**
 * 清空已读通知（只保留未读）。
 *
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function clearReadNotifications(items) {
  const list = Array.isArray(items) ? items : [];
  return list.filter(item => toPlainObject(item).read !== true);
}

/**
 * 切换单条通知的已读状态。
 *
 * @param {Array<object>} items
 * @param {string} id
 * @returns {Array<object>}
 */
export function toggleNotificationRead(items, id) {
  const list = Array.isArray(items) ? items : [];
  const target = text(id);
  return list.map(item => {
    const record = toPlainObject(item);
    if (text(record.id) !== target) return { ...record };
    return { ...record, read: record.read !== true };
  });
}

/* ------------------------------------------------------------------
 * 4) DOM 渲染（只走 textContent）
 * ---------------------------------------------------------------- */

function resolveDocument(options) {
  if (options && options.document) return options.document;
  return typeof globalThis.document === "undefined" ? null : globalThis.document;
}

function createElement(doc, tag, className, content) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}

function resetContainer(container) {
  if (!container) return;
  if (typeof container.replaceChildren === "function") {
    container.replaceChildren();
    return;
  }
  container.textContent = "";
}

/**
 * 渲染通知列表。所有文本都通过 textContent 写入。
 *
 * @param {object} container
 * @param {Array<object>} items
 * @param {{document?: object}} [options]
 * @returns {object} 渲染出的根节点
 */
export function renderNotificationList(container, items, options = {}) {
  const doc = resolveDocument(options);
  if (!doc || !container) return null;
  const list = Array.isArray(items) ? items : [];

  resetContainer(container);
  const root = createElement(doc, "section", "notifications");
  if (!list.length) {
    root.append(createElement(doc, "p", "notifications__empty", "暂无通知。"));
    container.append(root);
    return root;
  }

  const listNode = createElement(doc, "ul", "notifications__list");
  for (const item of list) {
    const record = toPlainObject(item);
    const node = createElement(doc, "li", `notifications__item notifications__item--${record.type || "info"}`);
    if (record.read !== true) node.append(createElement(doc, "span", "notifications__dot", "●"));
    node.append(createElement(doc, "span", "notifications__type", TYPE_LABELS[record.type] || "通知"));
    node.append(createElement(doc, "span", "notifications__title", record.title || ""));
    if (record.detail) node.append(createElement(doc, "span", "notifications__detail", record.detail));
    if (record.at) node.append(createElement(doc, "span", "notifications__time", record.at));
    listNode.append(node);
  }
  root.append(listNode);
  container.append(root);
  return root;
}

/**
 * 渲染未读计数徽标。
 *
 * @param {object} container
 * @param {object} summary summarizeNotifications() 的结果
 * @param {{document?: object}} [options]
 * @returns {object} 渲染出的根节点
 */
export function renderNotificationSummary(container, summary, options = {}) {
  const doc = resolveDocument(options);
  if (!doc || !container) return null;
  const model = toPlainObject(summary);
  const unread = Number.isFinite(Number(model.unread)) ? Number(model.unread) : 0;

  resetContainer(container);
  const root = createElement(doc, "div", "notifications__summary");
  root.append(createElement(doc, "span", "notifications__summary-count", `未读 ${unread}`));
  root.append(createElement(doc, "span", "notifications__summary-total", `共 ${model.total ?? 0} 条`));
  const byType = toPlainObject(model.byType);
  for (const type of NOTIFICATION_TYPES) {
    const bucket = toPlainObject(byType[type]);
    root.append(createElement(
      doc,
      "span",
      `notifications__summary-type notifications__summary-type--${type}`,
      `${TYPE_LABELS[type]} ${bucket.unread ?? 0}/${bucket.total ?? 0}`
    ));
  }
  container.append(root);
  return root;
}

/**
 * 渲染完整的通知中心（摘要 + 列表）。
 *
 * @param {object} container
 * @param {{items?: Array<object>, summary?: object, filter?: object}} state
 * @param {{document?: object}} [options]
 * @returns {object} 渲染出的根节点
 */
export function renderNotificationCenter(container, state, options = {}) {
  const doc = resolveDocument(options);
  if (!doc || !container) return null;
  const model = toPlainObject(state);
  const items = Array.isArray(model.items) ? model.items : [];
  const summary = toPlainObject(model.summary) || summarizeNotifications(items);
  const visible = filterNotifications(items, model.filter || {});

  resetContainer(container);
  const root = createElement(doc, "section", "notification-center");
  const head = createElement(doc, "header", "notification-center__head");
  head.append(createElement(doc, "h2", "notification-center__title", "通知中心"));
  head.append(createElement(doc, "span", "notification-center__count", `未读 ${summary.unread ?? 0}`));
  root.append(head);

  const byType = toPlainObject(summary.byType);
  const filters = createElement(doc, "p", "notification-center__filters");
  filters.append(createElement(doc, "span", "notification-center__filter-label", "全部"));
  for (const type of NOTIFICATION_TYPES) {
    const bucket = toPlainObject(byType[type]);
    filters.append(createElement(
      doc,
      "span",
      `notification-center__filter notification-center__filter--${type}`,
      `${TYPE_LABELS[type]} ${bucket.unread ?? 0}`
    ));
  }
  root.append(filters);

  if (!visible.length) {
    root.append(createElement(doc, "p", "notification-center__empty", "没有符合条件的通知。"));
  } else {
    const list = createElement(doc, "ul", "notification-center__list");
    for (const item of visible) {
      const record = toPlainObject(item);
      const node = createElement(doc, "li", `notification-center__item notification-center__item--${record.type || "info"}`);
      if (record.read !== true) node.append(createElement(doc, "span", "notification-center__dot", "●"));
      node.append(createElement(doc, "span", "notification-center__type", TYPE_LABELS[record.type] || "通知"));
      node.append(createElement(doc, "span", "notification-center__title", record.title || ""));
      if (record.detail) node.append(createElement(doc, "span", "notification-center__detail", record.detail));
      if (record.at) node.append(createElement(doc, "span", "notification-center__time", record.at));
      list.append(node);
    }
    root.append(list);
  }
  container.append(root);
  return root;
}

/* ------------------------------------------------------------------
 * 5) 与既有页面（index.html + pages.js）的接线
 * ---------------------------------------------------------------- */

if (typeof window !== "undefined") {
  window.Notifications = Object.freeze({
    NOTIFICATION_TYPES,
    scrubNotificationText,
    stripCredentialFields,
    classifyNotification,
    normalizeNotification,
    collectNotifications,
    summarizeNotifications,
    filterNotifications,
    markNotificationsRead,
    clearReadNotifications,
    toggleNotificationRead,
    renderNotificationList,
    renderNotificationSummary,
    renderNotificationCenter
  });
  if (typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event("notifications-ready"));
  }
}
