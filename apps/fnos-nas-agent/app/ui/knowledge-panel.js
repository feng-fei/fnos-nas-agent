/* ==================================================================
 * knowledge-panel.js —— Phase 179：知识库面板 / 应用管理（只读） / 来源与版本呈现
 *
 * 职责：把「网页信息获取 + 知识沉淀 + 只读运维视图」拆成若干**纯函数**，
 *      便于在 node --test 中直接断言；不依赖 DOM、不发起任何网络请求。
 *
 * 覆盖的对照矩阵条目：
 *   - 知识库面板：检索条目、展示来源与可信度、显式标注 stale / expired / conflict；
 *     **长期记忆绝不当作实时状态呈现**（历史记录必须带明确标签）。
 *   - B02 官方文档优先：来源分类后官方来源排在最前。
 *   - B05 页面变化监控：只做**呈现层**的两次抓取证据哈希对比，抓取本身由
 *     app/web-fetch.mjs 负责，本模块不调度、不联网。
 *   - B06 版本查询：版本列表与版本对比的呈现模型。
 *   - B09 来源引用：引用带来源名称、链接与采集时间。
 *   - UI06 应用管理页：只读展示容器 / 镜像 / 部署与更新状态；**没有数据就是
 *     「未采集」**，绝不显示成空白或「正常」。
 *
 * 安全约定（不可放宽）：
 *   - 所有文本都通过 `textContent` 写入；本文件**不含** innerHTML /
 *     outerHTML / insertAdjacentHTML / document.write；
 *   - 不接收、不返回、不回显 API Key 明文；凭据只以指纹（fingerprint）出现；
 *   - 不发起任何网络请求；网络出口由 app/network-policy.mjs 与
 *     app/web-fetch.mjs 负责，本模块只做呈现。
 *
 * 集成方式：本文件是 ES module。浏览器端请以
 *   <script type="module" src="/ui/knowledge-panel.js"></script>
 * 引入；模块加载完成后把自己的纯函数挂到 `window.KnowledgePanel`，供
 * 经典脚本 pages.js 调用（与 app/ui/model-settings.js 一致的双轨做法）。
 * ================================================================== */

/** 默认的条目时效（7 天）。超过后标记为「可能过期」，超过 2 倍标记为「已过期」。 */
export const DEFAULT_KNOWLEDGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 进入「可能过期」的时间占比。 */
const STALE_RATIO = 0.75;

/** 单次查询返回的最大条数。 */
const MAX_KNOWLEDGE_RESULTS = 100;

/** 来源类型。official 排在最前（官方文档优先）。 */
export const SOURCE_KINDS = Object.freeze([
  "official",
  "vendor",
  "operator",
  "community",
  "memory",
  "unknown"
]);

const SOURCE_LABELS = Object.freeze({
  official: "官方文档",
  vendor: "厂商文档",
  operator: "运维记录",
  community: "社区资料",
  memory: "长期记忆",
  unknown: "未标注来源"
});

/** 各来源类型的基础可信度分值。 */
const SOURCE_WEIGHTS = Object.freeze({
  official: 90,
  vendor: 75,
  operator: 60,
  community: 55,
  memory: 40,
  unknown: 30
});

const CREDIBILITY_LABELS = Object.freeze({
  high: "可信度高",
  medium: "可信度中",
  low: "可信度低",
  unknown: "可信度未知"
});

const FRESHNESS_LABELS = Object.freeze({
  fresh: "内容较新",
  stale: "可能已过期",
  expired: "已过期",
  unknown: "时效未知"
});

const APP_GROUP_LABELS = Object.freeze({
  containers: "容器",
  images: "镜像",
  deployments: "部署"
});

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

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function parseTimestamp(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * FNV-1a 32 位哈希。用于页面变化监控的**呈现层**对比。
 * 纯前端实现，不依赖 WebCrypto，因此可以在 node --test 中直接断言。
 *
 * @param {unknown} value
 * @returns {string} 8 位十六进制
 */
export function hashText(value) {
  const input = typeof value === "string" ? value : String(value ?? "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 取证据正文的稳定片段，用于哈希对比。
 * @param {object} evidence
 * @returns {string}
 */
export function hashEvidence(evidence) {
  const source = toPlainObject(evidence);
  const body = text(source.excerpt) || text(source.body) || text(source.text) || text(source.title);
  return hashText(body);
}

/* ------------------------------------------------------------------
 * 1) 来源分类与排序（B02 官方文档优先）
 * ---------------------------------------------------------------- */

/**
 * 分类一个来源。来源可以是对象 {kind,url,title,collectedAt} 或一个 URL 字符串。
 * 没有任何显式 kind 时归为 "unknown" —— 不猜测「官方」，避免把社区页面
 * 伪装成官方文档。
 *
 * @param {unknown} source
 * @returns {{kind:string,label:string,isOfficial:boolean,weight:number,
 *            url:string,title:string,collectedAt:string,publishedAt:string}}
 */
export function classifySource(source) {
  const record = isPlainObject(source) ? source : { url: text(source) };
  const declared = text(record.kind).toLowerCase();
  const kind = SOURCE_KINDS.includes(declared) ? declared : "unknown";
  return {
    kind,
    label: SOURCE_LABELS[kind],
    isOfficial: kind === "official",
    weight: SOURCE_WEIGHTS[kind],
    url: text(record.url),
    title: text(record.title),
    collectedAt: text(record.collectedAt),
    publishedAt: text(record.publishedAt)
  };
}

/**
 * 来源排序：官方文档优先，其次厂商 / 运维 / 社区 / 长期记忆 / 未标注。
 * 同权重保持原有顺序（稳定排序）。
 *
 * @param {Array<unknown>} sources
 * @returns {Array<object>} 分类后的来源数组
 */
export function orderSources(sources) {
  const list = Array.isArray(sources) ? sources : [];
  return list
    .map((source, index) => ({ source: classifySource(source), index }))
    .sort((left, right) => {
      if (right.source.weight !== left.source.weight) return right.source.weight - left.source.weight;
      return left.index - right.index;
    })
    .map(item => item.source);
}

/* ------------------------------------------------------------------
 * 2) 可信度（B02 / 知识库面板）
 * ---------------------------------------------------------------- */

/**
 * 评估一个条目的可信度。
 * 基础分来自来源类型；有无采集时间、有无链接会小幅调整；过期 / 可能过期会扣分。
 * 条目自带 `credibility`（0-100 的显式分值）时以它为准。
 *
 * @param {object} entry
 * @param {{now?: number, ttlMs?: number}} [options]
 * @returns {{score:number|null,level:string,label:string,reasons:string[]}}
 */
export function evaluateCredibility(entry, options = {}) {
  const record = toPlainObject(entry);
  const source = classifySource(record.source);
  const reasons = [];
  let score = source.weight;

  if (source.collectedAt) {
    score += 5;
    reasons.push("有采集时间");
  } else {
    reasons.push("缺少采集时间");
  }
  if (source.url) {
    score += 5;
    reasons.push("有可追溯链接");
  } else {
    reasons.push("缺少可追溯链接");
  }

  const freshness = evaluateFreshness(record, options);
  if (freshness.state === "expired") {
    score -= 20;
    reasons.push("内容已过期");
  } else if (freshness.state === "stale") {
    score -= 10;
    reasons.push("内容可能已过期");
  }

  const explicit = clampScore(record.credibility);
  if (explicit !== null) {
    score = explicit;
    reasons.push("使用条目显式可信度");
  }

  const clamped = clampScore(score);
  const level = clamped === null
    ? "unknown"
    : clamped >= 80 ? "high" : clamped >= 55 ? "medium" : "low";
  return {
    score: clamped,
    level,
    label: CREDIBILITY_LABELS[level],
    reasons
  };
}

/* ------------------------------------------------------------------
 * 3) 时效：fresh / stale / expired
 * ---------------------------------------------------------------- */

/**
 * 评估条目时效。
 *
 * @param {object} entry
 * @param {{now?: number, ttlMs?: number}} [options]
 * @returns {{state:string,label:string,ageMs:number|null,stale:boolean,expired:boolean}}
 */
export function evaluateFreshness(entry, options = {}) {
  const record = toPlainObject(entry);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const ttl = Number.isFinite(Number(record.ttlMs))
    ? Number(record.ttlMs)
    : Number.isFinite(Number(options.ttlMs))
      ? Number(options.ttlMs)
      : DEFAULT_KNOWLEDGE_TTL_MS;
  const source = classifySource(record.source);
  const stamp = parseTimestamp(record.updatedAt) || parseTimestamp(source.collectedAt);

  if (stamp === null) {
    return { state: "unknown", label: FRESHNESS_LABELS.unknown, ageMs: null, stale: false, expired: false };
  }
  const ageMs = Math.max(0, now - stamp);
  const expired = ageMs > ttl;
  const stale = !expired && ageMs > ttl * STALE_RATIO;
  const state = expired ? "expired" : stale ? "stale" : "fresh";
  return { state, label: FRESHNESS_LABELS[state], ageMs, stale, expired };
}

/* ------------------------------------------------------------------
 * 4) 冲突检测
 * ---------------------------------------------------------------- */

function normalizeTitle(value) {
  return text(value).toLowerCase().replace(/[\s·、,，.。:：;；!！?？"'“”‘’()（）\[\]【】]/g, "");
}

/**
 * 检测标题相同但内容不同的条目 —— 视为冲突（同一件事有两种说法）。
 * 标题与正文都相同的是重复，不是冲突。
 *
 * @param {Array<object>} entries
 * @returns {Record<string,{conflict:boolean,with:string[],label:string}>}
 */
export function detectConflicts(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const groups = new Map();
  for (const entry of list) {
    const record = toPlainObject(entry);
    const key = normalizeTitle(record.title);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const result = {};
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const signatures = new Set(group.map(item => hashText(text(item.excerpt) || text(item.body))));
    for (const item of group) {
      const id = text(item.id);
      if (!id) continue;
      const others = group.filter(other => text(other.id) !== id).map(other => text(other.id));
      const conflicted = signatures.size > 1;
      const previous = result[id] || { conflict: false, with: [], label: "" };
      result[id] = {
        conflict: previous.conflict || conflicted,
        with: [...new Set([...previous.with, ...others])].filter(Boolean),
        label: conflicted ? `与 ${others.length} 条记录内容冲突` : previous.label
      };
    }
  }
  return result;
}

/* ------------------------------------------------------------------
 * 5) 长期记忆 ≠ 实时状态
 * ---------------------------------------------------------------- */

/**
 * 判断条目是不是实时采集的结果。
 * @param {object} entry
 * @returns {boolean}
 */
export function isRealtimeEvidence(entry) {
  const record = toPlainObject(entry);
  if (record.realtime === false) return false;
  if (record.memory === true) return false;
  const kind = text(record.kind).toLowerCase();
  if (kind === "memory" || kind === "long-term-memory") return false;
  return true;
}

/**
 * 描述条目的时效边界。长期记忆必须显式说明「不代表当前实时状态」。
 *
 * @param {object} entry
 * @returns {{realtime:boolean,label:string,note:string}}
 */
export function describeMemoryBoundary(entry) {
  const record = toPlainObject(entry);
  if (isRealtimeEvidence(record)) {
    return { realtime: true, label: "实时采集", note: "" };
  }
  return {
    realtime: false,
    label: "长期记忆（历史记录）",
    note: "该条目来自长期记忆，记录的是历史情况，不代表当前实时状态。"
  };
}

/* ------------------------------------------------------------------
 * 6) 知识库视图
 * ---------------------------------------------------------------- */

function normalizeEntry(entry, index) {
  const record = toPlainObject(entry);
  const source = classifySource(record.source);
  const tags = Array.isArray(record.tags)
    ? record.tags.map(item => text(item)).filter(Boolean)
    : [];
  return {
    id: text(record.id) || `entry-${index + 1}`,
    title: text(record.title) || "(无标题)",
    excerpt: text(record.excerpt) || text(record.body) || text(record.summary),
    tags,
    source,
    updatedAt: text(record.updatedAt),
    ttlMs: Number.isFinite(Number(record.ttlMs)) ? Number(record.ttlMs) : null,
    credibility: record.credibility,
    kind: text(record.kind),
    memory: record.memory === true,
    // Phase 216：归档标记必须一路带到视图，否则渲染层看不到「已归档」，
    // 会给归档条目画出一整排本不该存在的维护按钮。
    archived: record.archived === true,
    realtime: record.realtime
  };
}

function matchesQuery(entry, query) {
  const needle = text(query).toLowerCase();
  if (!needle) return true;
  const haystack = [
    entry.title,
    entry.excerpt,
    entry.source.title,
    entry.source.url,
    entry.tags.join(" ")
  ].join(" ").toLowerCase();
  return haystack.includes(needle);
}

/**
 * 构建知识库视图。
 *
 * @param {Array<object>} entries
 * @param {{query?: string, now?: number, ttlMs?: number, limit?: number}} [options]
 * @returns {object} 视图模型
 */
export function buildKnowledgeView(entries, options = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeEntry);
  const conflicts = detectConflicts(list);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const limit = Math.min(MAX_KNOWLEDGE_RESULTS, Math.max(1, Number(options.limit) || MAX_KNOWLEDGE_RESULTS));

  const matched = list.filter(entry => matchesQuery(entry, options.query));
  const results = matched
    .map(entry => {
      const credibility = evaluateCredibility(entry, { now, ttlMs: options.ttlMs });
      const freshness = evaluateFreshness(entry, { now, ttlMs: options.ttlMs });
      const boundary = describeMemoryBoundary(entry);
      const conflict = conflicts[entry.id] || { conflict: false, with: [], label: "" };
      const badges = [];
      if (entry.source.isOfficial) badges.push({ label: "官方来源", tone: "ok" });
      if (freshness.stale) badges.push({ label: FRESHNESS_LABELS.stale, tone: "warn" });
      if (freshness.expired) badges.push({ label: FRESHNESS_LABELS.expired, tone: "danger" });
      if (conflict.conflict) badges.push({ label: conflict.label, tone: "danger" });
      if (!boundary.realtime) badges.push({ label: boundary.label, tone: "muted" });
      return {
        id: entry.id,
        title: entry.title,
        excerpt: entry.excerpt,
        tags: entry.tags,
        source: entry.source,
        credibility,
        freshness,
        conflict,
        boundary,
        badges,
        stale: freshness.stale,
        expired: freshness.expired,
        archived: entry.archived === true,
        realtime: boundary.realtime
      };
    })
    .sort((left, right) => {
      // B02：官方来源优先；同来源按可信度，再按更新时间，再按 id 稳定排序。
      if (right.source.weight !== left.source.weight) return right.source.weight - left.source.weight;
      const leftScore = left.credibility.score ?? 0;
      const rightScore = right.credibility.score ?? 0;
      if (rightScore !== leftScore) return rightScore - leftScore;
      const leftAt = parseTimestamp(left.freshness === null ? "" : left.source.collectedAt) ?? 0;
      const rightAt = parseTimestamp(right.source.collectedAt) ?? 0;
      if (rightAt !== leftAt) return rightAt - leftAt;
      return left.id.localeCompare(right.id);
    })
    .slice(0, limit);

  return {
    query: text(options.query),
    total: list.length,
    matched: matched.length,
    results,
    summary: {
      total: list.length,
      matched: matched.length,
      official: results.filter(item => item.source.isOfficial).length,
      stale: results.filter(item => item.stale).length,
      expired: results.filter(item => item.expired).length,
      conflicts: results.filter(item => item.conflict.conflict).length,
      memoryOnly: results.filter(item => !item.realtime).length
    }
  };
}

/* ------------------------------------------------------------------
 * 7) 来源引用（B09）与版本对比（B06）
 * ---------------------------------------------------------------- */

/**
 * 构造一条来源引用。引用必须带来源名称、链接与采集时间。
 *
 * @param {object} entry
 * @returns {{label:string,citation:string,url:string,sourceLabel:string,
 *            collectedAt:string,isOfficial:boolean}}
 */
export function buildCitation(entry) {
  const record = toPlainObject(entry);
  const source = classifySource(record.source);
  const title = text(record.title) || "(无标题)";
  const collectedAt = source.collectedAt || "未知采集时间";
  return {
    label: "来源：" + (source.title || source.url || source.label),
    citation: `${title} — ${source.title || source.label}（${source.label}），采集于 ${collectedAt}`,
    url: source.url,
    sourceLabel: source.label,
    collectedAt,
    isOfficial: source.isOfficial
  };
}

function compareVersionStrings(left, right) {
  const parse = value => text(value).replace(/^v/i, "").split(".").map(part => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 构建版本查询视图（B06）。
 *
 * @param {Array<object>} versions [{version, releasedAt, channel, notes, latest}]
 * @param {{current?: string}} [options]
 * @returns {{current:string,versions:Array<object>,summary:string}}
 */
export function buildVersionView(versions, options = {}) {
  const list = (Array.isArray(versions) ? versions : []).map(item => {
    const record = toPlainObject(item);
    return {
      version: text(record.version),
      releasedAt: text(record.releasedAt),
      channel: text(record.channel) || "stable",
      notes: text(record.notes),
      latest: record.latest === true
    };
  });
  const current = text(options.current);
  const ordered = list
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const order = compareVersionStrings(right.item.version, left.item.version);
      if (order !== 0) return order;
      return left.index - right.index;
    })
    .map(({ item }) => item);
  // "latest" is the highest version actually present, not the first entry of
  // the input: the source order is not guaranteed to be the release order.
  const latestVersion = ordered[0]?.version || "";
  const sorted = ordered.map(item => ({
    ...item,
    isCurrent: Boolean(current) && item.version === current,
    isLatest: item.latest === true || item.version === latestVersion
  }));

  const latest = sorted.find(item => item.isLatest);
  return {
    current,
    versions: sorted,
    summary: latest
      ? `最新版本 ${latest.version}（${latest.releasedAt || "发布时间未知"}）${current ? `，当前运行 ${current}` : ""}`
      : "暂无版本信息"
  };
}

/**
 * 比较两个版本，给出可读的差异说明。
 *
 * @param {string} from
 * @param {string} to
 * @returns {{from:string,to:string,changed:boolean,summary:string}}
 */
export function compareVersions(from, to) {
  const left = text(from);
  const right = text(to);
  const changed = left !== right;
  return {
    from: left,
    to: right,
    changed,
    summary: changed ? `从 ${left || "未知版本"} 升级到 ${right || "未知版本"}` : `当前已是 ${left || "未知版本"}`
  };
}

/* ------------------------------------------------------------------
 * 8) 页面变化监控（B05，仅呈现层）
 * ---------------------------------------------------------------- */

/**
 * 比较两次抓取证据，给出「页面是否变化」的提示。
 * 本函数**不抓取、不联网**，只比较已经拿到的证据。
 *
 * @param {object} previous
 * @param {object} current
 * @returns {{changed:boolean,url:string,previousHash:string,currentHash:string,
 *            previousAt:string,currentAt:string,summary:string}}
 */
export function compareEvidenceSnapshots(previous, current) {
  const before = toPlainObject(previous);
  const after = toPlainObject(current);
  const previousHash = text(before.hash) || hashEvidence(before);
  const currentHash = text(after.hash) || hashEvidence(after);
  const changed = previousHash !== currentHash;
  return {
    changed,
    url: text(after.url) || text(before.url),
    previousHash,
    currentHash,
    previousAt: text(before.fetchedAt) || text(before.collectedAt),
    currentAt: text(after.fetchedAt) || text(after.collectedAt),
    summary: changed
      ? `页面内容已变化（${previousHash} → ${currentHash}）`
      : `页面内容无变化（${currentHash}）`
  };
}

/* ------------------------------------------------------------------
 * 9) 应用管理页（UI06，只读）
 * ---------------------------------------------------------------- */

/**
 * 描述一个值的采集状态。没有数据就是「未采集」，不是空白，也不是「正常」。
 *
 * @param {unknown} value
 * @returns {{collected:boolean,label:string}}
 */
export function describeCollectionState(value) {
  if (value === null || value === undefined) return { collected: false, label: "未采集" };
  if (typeof value === "string") return value.trim() ? { collected: true, label: value.trim() } : { collected: false, label: "未采集" };
  if (typeof value === "number") return Number.isFinite(value) ? { collected: true, label: String(value) } : { collected: false, label: "未采集" };
  if (typeof value === "boolean") return { collected: true, label: value ? "是" : "否" };
  if (Array.isArray(value)) return value.length ? { collected: true, label: `${value.length} 项` } : { collected: false, label: "未采集" };
  if (isPlainObject(value)) return Object.keys(value).length ? { collected: true, label: "已采集" } : { collected: false, label: "未采集" };
  return { collected: false, label: "未采集" };
}

const SECTION_STATUS_LABELS = Object.freeze({
  ok: "正常",
  unknown: "未采集",
  unavailable: "接口不可用"
});

function describeUpdateState(item) {
  const record = toPlainObject(item);
  if (record.updateAvailable === true) return { update: "available", updateLabel: "有可用更新", tone: "warn" };
  const version = text(record.version);
  const latest = text(record.latest);
  if (version && latest && version !== latest) return { update: "available", updateLabel: `有可用更新（${version} → ${latest}）`, tone: "warn" };
  if (version) return { update: "current", updateLabel: "已是当前版本", tone: "ok" };
  return { update: "unknown", updateLabel: "未采集", tone: "muted" };
}

function buildAppGroup(id, items) {
  const list = Array.isArray(items) ? items : [];
  const rows = list.map((item, index) => {
    const record = isPlainObject(item) ? item : { name: text(item) };
    const state = describeUpdateState(record);
    const name = text(record.name) || text(record.id) || `${APP_GROUP_LABELS[id]} ${index + 1}`;
    const detailParts = [];
    if (text(record.image)) detailParts.push(text(record.image));
    if (text(record.status)) detailParts.push(text(record.status));
    if (text(record.version)) detailParts.push("版本 " + text(record.version));
    const detail = describeCollectionState(detailParts.join(" · "));
    return {
      name,
      detail: detail.collected ? detail.label : "未采集",
      collected: detail.collected,
      update: state.update,
      updateLabel: state.updateLabel,
      tone: state.tone
    };
  });
  const state = describeCollectionState(rows);
  return {
    id,
    label: APP_GROUP_LABELS[id] || id,
    status: rows.length ? "ok" : "unknown",
    statusLabel: rows.length ? "已采集" : "未采集",
    items: rows,
    note: rows.length ? "" : "未采集"
  };
}

/**
 * 构建应用管理页的只读视图（UI06）。
 *
 * 输入是 /api/system/snapshot 的返回（{generatedAt, sections:[{id,title,status,values}]}），
 * 也可以直接传入 {containers, images, deployments} 形式的数据源，便于测试。
 *
 * @param {object} snapshot
 * @param {{collectedAt?: string}} [options]
 * @returns {object} 视图模型
 */
export function buildAppInventoryView(snapshot, options = {}) {
  const data = toPlainObject(snapshot);
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const sectionViews = sections.map(section => {
    const record = toPlainObject(section);
    const status = text(record.status) || "unknown";
    const values = toPlainObject(record.values);
    const rows = Object.entries(values).map(([key, value]) => {
      const state = describeCollectionState(value);
      return {
        label: key,
        value: state.label,
        collected: state.collected,
        tone: state.collected ? "ok" : "muted"
      };
    });
    return {
      id: text(record.id),
      title: text(record.title) || text(record.id),
      status,
      statusLabel: SECTION_STATUS_LABELS[status] || "未知状态",
      note: text(record.note),
      rows,
      collected: status === "ok"
    };
  });

  const dockerSection = sectionViews.find(section => section.id === "docker");
  const dockerValues = toPlainObject(
    (sections.find(section => text(toPlainObject(section).id) === "docker") || {}).values
  );
  const groups = [
    buildAppGroup("containers", data.containers || dockerValues.containers),
    buildAppGroup("images", data.images || dockerValues.images),
    buildAppGroup("deployments", data.deployments || dockerValues.deployments)
  ];

  return {
    generatedAt: text(data.generatedAt),
    collectedAt: text(options.collectedAt) || text(data.generatedAt),
    sections: sectionViews,
    groups,
    summary: {
      sections: sectionViews.length,
      collectedSections: sectionViews.filter(section => section.collected).length,
      missingSections: sectionViews.filter(section => !section.collected).length,
      groups: groups.length,
      collectedGroups: groups.filter(group => group.items.length).length,
      missingGroups: groups.filter(group => !group.items.length).length
    }
  };
}

/* ------------------------------------------------------------------
 * 10) DOM 渲染（只走 textContent）
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

function appendAll(parent, children) {
  for (const child of children) {
    if (child) parent.append(child);
  }
}

/**
 * 渲染知识库面板。所有文本都通过 textContent 写入。
 *
 * @param {object} container DOM 容器
 * @param {object} view buildKnowledgeView() 的结果
 * @param {{document?: object}} [options]
 * @returns {object} 渲染出的根节点
 */
/**
 * 条目级动作：按钮只声明意图，实际的两步写入由 knowledge-write.js 处理。
 * `verification` 是服务端接受的枚举值，界面不发明新状态。
 */
const ENTRY_ACTIONS = Object.freeze([
  Object.freeze({ id: "verify", label: "核验", verification: "verified" }),
  Object.freeze({ id: "stale", label: "标记过期", verification: "stale" }),
  Object.freeze({ id: "archive", label: "归档", verification: null })
]);

export function renderKnowledgePanel(container, view, options = {}) {
  const doc = resolveDocument(options);
  if (!doc || !container) return null;
  const model = toPlainObject(view);
  const results = Array.isArray(model.results) ? model.results : [];

  resetContainer(container);
  const root = createElement(doc, "section", "knowledge-panel");
  const head = createElement(doc, "header", "knowledge-panel__head");
  head.append(createElement(doc, "h2", "knowledge-panel__title", "知识库"));
  const summary = toPlainObject(model.summary);
  head.append(createElement(
    doc,
    "p",
    "knowledge-panel__summary",
    `共 ${summary.total ?? results.length} 条，匹配 ${summary.matched ?? results.length} 条 · 官方来源 ${summary.official ?? 0} 条 · 可能过期 ${summary.stale ?? 0} 条 · 已过期 ${summary.expired ?? 0} 条 · 冲突 ${summary.conflicts ?? 0} 条`
  ));
  root.append(head);

  if (!results.length) {
    root.append(createElement(doc, "p", "knowledge-panel__empty", "未采集到知识条目。"));
    container.append(root);
    return root;
  }

  const list = createElement(doc, "ul", "knowledge-panel__list");
  for (const item of results) {
    const record = toPlainObject(item);
    const entry = createElement(doc, "li", "knowledge-panel__item");
    entry.append(createElement(doc, "p", "knowledge-panel__item-title", record.title));
    const citation = buildCitation(record);
    entry.append(createElement(doc, "p", "knowledge-panel__item-source", citation.citation));
    const credibility = toPlainObject(record.credibility);
    const freshness = toPlainObject(record.freshness);
    entry.append(createElement(
      doc,
      "p",
      "knowledge-panel__item-meta",
      `可信度：${credibility.label || "可信度未知"}${credibility.score === null || credibility.score === undefined ? "" : `（${credibility.score}）`} · 时效：${freshness.label || "时效未知"}`
    ));
    if (record.excerpt) entry.append(createElement(doc, "p", "knowledge-panel__item-excerpt", record.excerpt));
    const boundary = toPlainObject(record.boundary);
    if (boundary && boundary.realtime === false) {
      entry.append(createElement(doc, "p", "knowledge-panel__item-note", boundary.note || boundary.label));
    }
    const badges = createElement(doc, "p", "knowledge-panel__item-badges");
    for (const badge of Array.isArray(record.badges) ? record.badges : []) {
      const item2 = toPlainObject(badge);
      badges.append(createElement(doc, "span", `knowledge-panel__badge knowledge-panel__badge--${item2.tone || "muted"}`, item2.label));
    }
    entry.append(badges);
    // Phase 214：条目级动作（核验 / 标记过期 / 归档）。这些按钮只声明「想做什么」，
    // 真正的两步走（预览 → 提交）在 knowledge-write.js 里，读写边界不混在一起。
    if (record.id) {
      if (record.archived) {
        entry.append(createElement(doc, "p", "knowledge-panel__item-note", "已归档，不再参与检索。"));
      } else {
        const actions = createElement(doc, "div", "knowledge-panel__actions");
        for (const action of ENTRY_ACTIONS) {
          const button = createElement(doc, "button", "btn btn--ghost btn--small", action.label);
          button.type = "button";
          button.dataset.knowledgeAction = action.id;
          button.dataset.knowledgeId = String(record.id);
          button.dataset.knowledgeTitle = String(record.title || "");
          actions.append(button);
        }
        entry.append(actions);
      }
    }
    list.append(entry);
  }
  root.append(list);
  container.append(root);
  return root;
}

/**
 * 渲染应用管理页（只读）。没有数据的分组显示「未采集」。
 *
 * @param {object} container
 * @param {object} view buildAppInventoryView() 的结果
 * @param {{document?: object}} [options]
 * @returns {object} 渲染出的根节点
 */
export function renderAppInventory(container, view, options = {}) {
  const doc = resolveDocument(options);
  if (!doc || !container) return null;
  const model = toPlainObject(view);
  const groups = Array.isArray(model.groups) ? model.groups : [];

  resetContainer(container);
  const root = createElement(doc, "section", "app-inventory");
  root.append(createElement(doc, "h2", "app-inventory__title", "应用与部署（只读）"));
  const summary = toPlainObject(model.summary);
  root.append(createElement(
    doc,
    "p",
    "app-inventory__summary",
    `分组 ${summary.groups ?? groups.length} 个 · 已采集 ${summary.collectedGroups ?? 0} 个 · 未采集 ${summary.missingGroups ?? 0} 个`
  ));

  for (const group of groups) {
    const record = toPlainObject(group);
    const section = createElement(doc, "section", "app-inventory__group");
    section.append(createElement(doc, "h3", "app-inventory__group-title", record.label || record.id));
    section.append(createElement(doc, "p", "app-inventory__group-status", record.statusLabel || "未采集"));
    const items = Array.isArray(record.items) ? record.items : [];
    if (!items.length) {
      section.append(createElement(doc, "p", "app-inventory__empty", "未采集"));
    } else {
      const list = createElement(doc, "ul", "app-inventory__list");
      for (const item of items) {
        const entry = toPlainObject(item);
        const row = createElement(doc, "li", "app-inventory__item");
        row.append(createElement(doc, "span", "app-inventory__item-name", entry.name));
        row.append(createElement(doc, "span", "app-inventory__item-detail", entry.detail || "未采集"));
        row.append(createElement(doc, "span", `app-inventory__item-update app-inventory__item-update--${entry.tone || "muted"}`, entry.updateLabel || "未采集"));
        list.append(row);
      }
      section.append(list);
    }
    root.append(section);
  }
  container.append(root);
  return root;
}

/* ------------------------------------------------------------------
 * 11) 与既有页面（index.html + pages.js）的接线
 * ---------------------------------------------------------------- */

if (typeof window !== "undefined") {
  window.KnowledgePanel = Object.freeze({
    SOURCE_KINDS,
    DEFAULT_KNOWLEDGE_TTL_MS,
    classifySource,
    orderSources,
    evaluateCredibility,
    evaluateFreshness,
    detectConflicts,
    isRealtimeEvidence,
    describeMemoryBoundary,
    buildKnowledgeView,
    buildCitation,
    buildVersionView,
    compareVersions,
    hashText,
    hashEvidence,
    compareEvidenceSnapshots,
    describeCollectionState,
    buildAppInventoryView,
    renderKnowledgePanel,
    renderAppInventory
  });
  if (typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event("knowledge-panel-ready"));
  }
}
