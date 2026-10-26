/* pages/system.js —— 系统区：子页签组织 13 组运维能力（替代旧 UI 的单页堆叠）。
 * UI-1 给出分区骨架与路由占位；各子页随 UI-4 从旧 pages.js 迁移。 */

import { h } from "../h.js";
import { callJson } from "../api.js";
import { formatBytes, formatDateTime } from "../format.js";

const SUBTABS = [
  { id:"overview",  title:"概览",     note:"设备档案、健康检查计划、更新检查", apis:"device-profiles / health-checks / update-check" },
  { id:"network",   title:"网络与证书", note:"网络体检、策略、接口、证书到期", apis:"network/* certificate-check" },
  { id:"services",  title:"容器与服务", note:"服务状态、容器资源统计、Docker 建议", apis:"system/services docker/*" },
  { id:"storage",   title:"存储健康",   note:"SMART、温度、容量预测、系统事件", apis:"system/smart thermal capacity-forecast events" },
  { id:"automation",title:"自动化",   note:"工作流、触发规则、运行手册、MCP", apis:"workflows runbooks mcp" },
  { id:"audit",     title:"审计与轨迹", note:"操作审计、工具调用轨迹、待确认写动作", apis:"audit agent/trace write-actions" },
  { id:"reports",   title:"诊断报告",   note:"一键诊断、证据抽取、历史报告", apis:"diagnostics/* diagnoses/* deploy compositions" },
];

export function render(root, ctx){
  let active = ctx.sub && SUBTABS.some(t => t.id === ctx.sub) ? ctx.sub : "overview";
  const content = h("div");

  function draw(){
    const tab = SUBTABS.find(t => t.id === active);
    content.replaceChildren(
      h("div", { class:"banner banner--info" },
        "「", tab.title, "」子页在 UI-4 迁移。对应数据接口：", h("code", null, tab.apis), "。"));
    if(active === "overview"){
      content.append(buildOverviewCard());
    }else if(active === "audit"){
      content.append(buildAuditCard());
    }
  }

  const tabs = h("div", { class:"subtabs", role:"tablist" },
    SUBTABS.map(t => h("button", { role:"tab", dataset:{ tab:t.id },
      class: t.id === active ? "on" : "",
      onclick:event => {
        active = t.id;
        tabs.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.tab === active));
        history.replaceState(null, "", "#/system/" + t.id);
        draw();
      } }, t.title)));

  root.append(tabs, content);
  draw();
}

function buildOverviewCard(){
  const card = h("div", { class:"card" },
    h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "设备概览"),
      h("p", { class:"card__sub" }, "UI-4 完整迁移；以下为已接通的快照接口")),
    h("div", { class:"card__body" }, h("p", { class:"muted" }, "正在读取系统快照…")));
  callJson("systemSnapshot").then(snapshot => {
    const body = h("dl", { class:"kv" },
      h("dt", null, "系统"), h("dd", null, (snapshot?.os?.name || "—") + " " + (snapshot?.os?.version || "")),
      h("dt", null, "内核"), h("dd", null, snapshot?.os?.kernel || "—"),
      h("dt", null, "CPU"), h("dd", null, (snapshot?.cpu?.model || "—") + " · " + (snapshot?.cpu?.usagePercent ?? "—") + "%"),
      h("dt", null, "内存"), h("dd", null, (snapshot?.memory?.usedPercent ?? "—") + "%"));
    for(const v of snapshot?.volumes || []){
      body.append(h("dt", null, v.mount), h("dd", null, formatBytes(v.totalBytes) + " · 已用 " + v.usedPercent + "%"));
    }
    card.querySelector(".card__body").replaceChildren(body);
  }).catch(() => {
    card.querySelector(".card__body").replaceChildren(
      h("p", { class:"muted" }, "快照接口未返回数据（演示模式外需要登录的会话）。"));
  });
  return card;
}

function buildAuditCard(){
  const card = h("div", { class:"card" },
    h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "最近操作"),
      h("p", { class:"card__sub" }, "只含路由与结果状态，不含参数与密钥")),
    h("div", { class:"card__body" }, h("p", { class:"muted" }, "加载中…")));
  callJson("auditList", { query:{ limit:12 } }).then(data => {
    const items = data?.events || data?.items || [];
    const rows = h("div", { class:"list" });
    for(const item of items.slice(0, 12)){
      rows.append(h("div", { class:"list__row" },
        h("span", { class:"badge " + (item.statusCode >= 400 ? "badge--danger" : "badge--ok") }, item.statusCode ?? "—"),
        h("div", { class:"list__main" },
          h("div", { class:"list__title" }, item.route || item.event || "—"),
          h("div", { class:"list__meta" }, formatDateTime(item.at || item.timestamp)))));
    }
    card.querySelector(".card__body").replaceChildren(
      items.length ? rows : h("p", { class:"muted" }, "暂无审计事件。"));
  }).catch(() => {
    card.querySelector(".card__body").replaceChildren(h("p", { class:"muted" }, "审计接口未返回数据。"));
  });
  return card;
}
