// 知识库写入：两步走（预览 → 提交）。
//
// 这个模块只做一件事：把「写一条知识」做成「先看清要存什么，再落库」。
// 之所以单独成文件，是因为 pages.js 里的知识库区块有一条既有守卫：
// 只读面板不得出现写请求。写入放在这里，读与写的边界就写在代码结构里。
//
// 安全边界：
// - 每一步都由服务端判定（preview 返回预览与 previewId，commit 只认 previewId）；
// - 预览结果一旦与当前表单不一致就作废，必须重新预览，避免「预览 A、提交 B」；
// - 所有渲染用 textContent，知识内容是外部输入，不能拼 HTML。

const SOURCES = Object.freeze([
  ["official-doc", "官方文档"],
  ["field-observation", "实地观察"],
  ["manual-confirmation", "人工确认"]
]);

const VERIFICATIONS = Object.freeze([
  ["unverified", "未核验"],
  ["verified", "已核验"],
  ["stale", "可能过期"],
  ["conflicted", "存在冲突"]
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function buildKnowledgePayload(form) {
  const title = text(form?.title);
  const source = text(form?.source);
  const verification = text(form?.verification) || "unverified";
  const tags = text(form?.tags)
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
  return {
    title,
    summary: text(form?.summary),
    body: typeof form?.body === "string" ? form.body : "",
    source,
    verification,
    tags
  };
}

export function normalizePreview(payload) {
  if (!payload || payload.ok !== true || typeof payload.previewId !== "string") return null;
  return {
    previewId: payload.previewId,
    operation: typeof payload.operation === "string" ? payload.operation : "write",
    entry: payload.entry || {},
    warnings: list(payload.warnings),
    redactedFields: list(payload.redactedFields),
    existing: payload.existing || null,
    requiresForce: payload.requiresForce === true
  };
}

export function describePreview(preview) {
  if (!preview) return [];
  const entry = preview.entry || {};
  const lines = [
    "标题：" + (entry.title || "未采集"),
    "条目 ID：" + (entry.id || "未采集"),
    "来源：" + (entry.source || "未采集"),
    "核验状态：" + (entry.verification || "未采集"),
    "采集时间：" + (entry.collectedAt || "未记录"),
    "摘要：" + (entry.summary || "未填写"),
    "标签：" + (list(entry.tags).length ? list(entry.tags).join("、") : "无")
  ];
  if (preview.redactedFields.length) lines.push("以下字段被服务端脱敏后才入库：" + preview.redactedFields.join("、"));
  if (preview.warnings.length) lines.push("提醒：" + preview.warnings.join("、"));
  if (preview.existing) lines.push("将覆盖已有条目，" + "旧版本会留在版本历史里。");
  return lines;
}

function mount(options = {}) {
  const root = options.root || document.querySelector("#knowledge-write");
  if (!root) return null;
  const api = options.api || globalThis.api;
  const onSaved = typeof options.onSaved === "function" ? options.onSaved : () => {};
  const el = (id) => root.querySelector("#" + id);
  const status = el("knowledge-write-status");
  const result = el("knowledge-write-result");
  const previewButton = el("knowledge-preview");
  const commitButton = el("knowledge-commit");
  let preview = null;
  let formSignature = "";

  const sourceSelect = el("knowledge-new-source");
  const verificationSelect = el("knowledge-new-verification");
  if (sourceSelect && !sourceSelect.options.length) {
    for (const [value, label] of SOURCES) sourceSelect.append(new Option(label, value));
  }
  if (verificationSelect && !verificationSelect.options.length) {
    for (const [value, label] of VERIFICATIONS) verificationSelect.append(new Option(label, value));
  }

  function readForm() {
    const form = {
      title: el("knowledge-new-title")?.value || "",
      summary: el("knowledge-new-summary")?.value || "",
      body: el("knowledge-new-body")?.value || "",
      source: el("knowledge-new-source")?.value || "",
      verification: el("knowledge-new-verification")?.value || "unverified",
      tags: el("knowledge-new-tags")?.value || ""
    };
    formSignature = JSON.stringify(form);
    return form;
  }

  function invalidatePreview(message) {
    preview = null;
    if (commitButton) commitButton.disabled = true;
    if (result) result.replaceChildren();
    if (message && status) status.textContent = message;
  }

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  function renderPreview(next) {
    if (!result) return;
    result.replaceChildren();
    const head = document.createElement("p");
    head.className = "muted";
    head.textContent = "预览（尚未写入）：提交后才会入库。";
    result.append(head);
    for (const line of describePreview(next)) {
      const item = document.createElement("p");
      item.textContent = line;
      result.append(item);
    }
    if (next.entry?.body) {
      const body = document.createElement("pre");
      body.className = "knowledge-write__body";
      body.textContent = next.entry.body;
      result.append(body);
    }
  }

  async function runPreview() {
    const form = readForm();
    if (!form.title) return setStatus("请先填写标题。");
    if (!form.source) return setStatus("请先选择来源。");
    setStatus("正在预览…");
    if (commitButton) commitButton.disabled = true;
    try {
      const response = await api("/api/knowledge/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "write", input: form })
      });
      const payload = await response.json();
      if (!response.ok) {
        invalidatePreview();
        setStatus("预览被拒绝：" + (payload.error || "服务端未给出原因"));
        if (Array.isArray(payload.reasons) && payload.reasons.length && result) {
          const reasons = document.createElement("div");
          for (const reason of payload.reasons) {
            const line = document.createElement("p");
            line.className = "error";
            line.textContent = reason;
            reasons.append(line);
          }
          result.append(reasons);
        }
        return;
      }
      const normalized = normalizePreview(payload);
      if (!normalized) {
        invalidatePreview("预览响应缺少 previewId，已放弃本次写入。");
        return;
      }
      preview = normalized;
      formSignature = JSON.stringify(form);
      renderPreview(normalized);
      if (commitButton) commitButton.disabled = false;
      setStatus("预览完成。确认内容无误后再提交。");
    } catch (error) {
      invalidatePreview();
      setStatus("预览失败：" + (error?.message || "请求失败"));
    }
  }

  async function runCommit() {
    if (!preview) return setStatus("请先预览，再提交。");
    if (JSON.stringify(readForm()) !== formSignature) {
      invalidatePreview("表单已改动，请重新预览后再提交。");
      return;
    }
    setStatus("正在提交…");
    if (commitButton) commitButton.disabled = true;
    try {
      const response = await api("/api/knowledge/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ previewId: preview.previewId })
      });
      const payload = await response.json();
      if (!response.ok) {
        invalidatePreview("提交被拒绝：" + (payload.error || "服务端未给出原因"));
        return;
      }
      const stored = payload.entry || {};
      setStatus("已写入：" + (stored.title || "（未采集标题）") + "。");
      for (const id of ["knowledge-new-title", "knowledge-new-summary", "knowledge-new-body", "knowledge-new-tags"]) {
        const field = el(id);
        if (field) field.value = "";
      }
      invalidatePreview();
      setStatus("已写入：" + (stored.title || "（未采集标题）") + "。");
      onSaved(stored);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("knowledge-saved", { detail: { entry: stored } }));
    } catch (error) {
      invalidatePreview("提交失败：" + (error?.message || "请求失败"));
    }
  }

  previewButton?.addEventListener("click", () => {
    runPreview();
  });
  commitButton?.addEventListener("click", () => {
    runCommit();
  });
  for (const id of ["knowledge-new-title", "knowledge-new-summary", "knowledge-new-body", "knowledge-new-source", "knowledge-new-verification", "knowledge-new-tags"]) {
    const field = el(id);
    field?.addEventListener("input", () => {
      if (preview) invalidatePreview("表单已改动，请重新预览后再提交。");
    });
  }
  return { preview: runPreview, commit: runCommit, describePreview, normalizePreview };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const boot = () => {
    const panel = mount();
    if (!panel) return;
    window.KnowledgeWrite = panel;
    window.dispatchEvent(new CustomEvent("knowledge-write-ready"));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}
