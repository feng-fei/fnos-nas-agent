/* pages/home.js —— 总览：健康、执行模式、存储、任务与模型概要。
 * 数据：/api/overview + /api/health（UI-1 先给骨架与真实链路，卡片随 UI-3 充实）。 */

import { h } from "../h.js";
import { store, effect } from "../store.js";
import { callJson } from "../api.js";
import { spinnerCard, toast } from "../ui.js";
import { formatBytes, formatDurationSeconds } from "../format.js";

export function render(root, ctx){
  root.append(spinnerCard("正在读取总览…"));

  ctx.stop(effect(() => {
    store.refreshTick(); // 订阅刷新
    load(root);
  }));
}

let loadedFor = -1;
async function load(root){
  const tick = store.refreshTick();
  if(tick === loadedFor && root.dataset.loaded === "1") return;
  loadedFor = tick; root.dataset.loaded = "1";
  try{
    const [overview, diagnostics] = await Promise.all([
      callJson("overview").catch(() => null),
      callJson("diagnostics").catch(() => null),
    ]);
    root.replaceChildren();

    /* 状态卡组 */
    const health = overview?.health || store.health();
    const mode = health?.executionMode || "normal";
    const modeBadge = { normal:["正常","badge--ok"], "read-only":["只读","badge--warn"], halted:["已停机","badge--danger"] }[mode] || [mode,""];
    root.append(
      h("div", { class:"grid-stats" },
        h("div", { class:"stat" },
          h("div", { class:"stat__label" }, "服务状态"),
          h("div", { class:"stat__value" }, health?.ok === false ? "状态异常" : "运行正常"),
          h("div", { class:"stat__hint" }, "版本 " + (health?.version || "—"))),
        h("div", { class:"stat" },
          h("div", { class:"stat__label" }, "执行模式"),
          h("div", { class:"stat__value" }, h("span", { class:"badge " + modeBadge[1] }, modeBadge[0])),
          h("div", { class:"stat__hint" }, "来源：" + (health?.executionModeSource || "default"))),
        h("div", { class:"stat" },
          h("div", { class:"stat__label" }, "任务"),
          h("div", { class:"stat__value" }, overview?.tasks ? (overview.tasks.running + "/" + overview.tasks.queued) : "—"),
          h("div", { class:"stat__hint" }, overview?.tasks ? `运行中/排队 · 历史 ${overview.tasks.completed ?? "—"}` : "—")),
        h("div", { class:"stat" },
          h("div", { class:"stat__label" }, "模型服务"),
          h("div", { class:"stat__value" }, overview?.models?.activeProviderName || "未配置"),
          h("div", { class:"stat__hint" }, overview?.models ? overview.models.providerCount + " 个服务商" : ""))));

    /* 存储 */
    const storage = overview?.storage || diagnostics?.storage || [];
    if(storage.length){
      const rows = storage.map(v => {
        const pct = v.available ? Math.round(v.usedBytes / v.totalBytes * 100) : 0;
        return h("div", { class:"row" },
          h("b", { style:"min-width:52px" }, v.label || "—"),
          v.available
            ? h("div", { style:"flex:1" },
                h("div", { style:"height:8px;background:var(--surface-3);border-radius:4px;overflow:hidden" },
                  h("i", { style:"display:block;height:100%;width:" + pct + "%;background:var(--accent)" })),
                h("div", { class:"stat__hint" },
                  formatBytes(v.usedBytes) + " / " + formatBytes(v.totalBytes) + " · 可用 " + formatBytes(v.freeBytes)))
            : h("span", { class:"badge badge--warn" }, "无法读取"));
      });
      root.append(
        h("div", { class:"card" },
          h("div", { class:"card__head" },
            h("h2", { class:"card__title" }, "存储"),
            h("p", { class:"card__sub" }, "来自系统诊断的只读快照")),
          h("div", { class:"card__body" }, h("div", { class:"stack" }, rows))));
    }

    /* 系统信息 */
    if(diagnostics?.system){
      const s = diagnostics.system;
      root.append(h("div", { class:"card" },
        h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "系统"),
          h("p", { class:"card__sub" }, "只读诊断，不含进程详情")),
        h("div", { class:"card__body" },
          h("dl", { class:"kv" },
            h("dt", null, "平台"), h("dd", null, s.platform + " " + (s.release || "") + " / " + s.arch),
            h("dt", null, "Node.js"), h("dd", null, s.nodeVersion || "—"),
            h("dt", null, "运行时间"), h("dd", null, formatDurationSeconds(s.uptimeSeconds)),
            h("dt", null, "CPU"), h("dd", null, (diagnostics.cpu?.model || "—") + "（" + (diagnostics.cpu?.logicalCores ?? "—") + " 核，负载 " + (diagnostics.cpu?.loadAverage || []).map(n => Number(n).toFixed(2)).join(" / ") + "）"),
            h("dt", null, "内存"), h("dd", null, diagnostics.memory ? formatBytes(diagnostics.memory.usedBytes) + " / " + formatBytes(diagnostics.memory.totalBytes) : "—")))));
    }
  }catch(error){
    toast(error.message, "err");
  }
}
