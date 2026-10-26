/* pages/system.js —— 系统区（UI-4）。七个子页签承接旧「诊断与运维」堆叠页的 13 组能力。
 * 只读分区直接 GET 渲染；写侧动作（巡检/体检/证据抽取/部署校验等）用 JSON 输入 + 显式按钮，
 * 结果与失败一律如实呈现（延续 phase-211「界面只显示服务端返回的结论」）。 */

import { h, clear } from "../h.js";
import { callJson } from "../api.js";
import { toast, confirmModal } from "../ui.js";
import { formatDisplayValue } from "../format.js";

/* value 渲染：对象 → kv；数组 → 可折叠列表；其他 → 标量。只做展示，不做业务判断。 */
function renderValue(value){
  if(value === null || value === undefined || value === "") return h("span", { class:"muted" }, "—");
  if(typeof value === "boolean") return h("span", { class:"badge " + (value ? "badge--ok" : "badge--warn") }, value ? "是" : "否");
  if(!Array.isArray(value) && typeof value === "object"){
    const entries = Object.entries(value).slice(0, 40);
    return h("dl", { class:"kv" },
      entries.map(([k, v]) => {
        const shown = v !== null && typeof v === "object"
          ? JSON.stringify(formatDisplayValue(v)).slice(0, 300) : formatDisplayValue(v, k);
        return [h("dt", null, k), h("dd", null, String(shown))];
      }).flat());
  }
  if(Array.isArray(value)){
    if(!value.length) return h("span", { class:"muted" }, "（空）");
    const wrap = h("div", { class:"stack", style:"gap:6px" });
    for(const item of value.slice(0, 12)){
      if(item && typeof item === "object"){
        const title = item.title || item.name || item.route || item.id || item.workflowId || item.mount || item.disk || "条目";
        wrap.append(h("details", { class:"card", style:"margin:0" },
          h("summary", { style:"padding:7px 11px;cursor:pointer;font-size:13px" }, String(title)),
          h("pre", { class:"code", style:"margin:0;border:0;border-top:1px solid var(--border);border-radius:0;max-height:200px" },
            JSON.stringify(formatDisplayValue(item), null, 2).slice(0, 2500))));
      }else wrap.append(h("div", { style:"font-size:13px" }, String(item)));
    }
    if(value.length > 12) wrap.append(h("p", { class:"muted", style:"font-size:11px;margin:0" }, "… 共 " + value.length + " 项，仅显示前 12 条"));
    return wrap;
  }
  return h("span", null, String(formatDisplayValue(value)));
}

const SUBTABS = [
  { id:"overview", title:"概览", note:"设备档案、健康检查计划与更新检查；系统快照在 UI-1 已接通。",
    sections:[
      { title:"系统快照", route:"systemSnapshot" },
      { title:"设备档案", route:"deviceProfiles" },
      { title:"健康检查计划", route:"healthChecks" },
      { title:"更新检查", action:{ route:"systemUpdateCheck", body:{}, label:"立即检查更新" } },
    ] },
  { id:"network", title:"网络与证书", note:"网络体检、策略、接口与连通性巡检。",
    sections:[
      { title:"网络诊断", route:"networkDiagnostics" },
      { title:"网络策略", route:"networkPolicy" },
      { title:"网络接口", route:"networkInterfaces" },
      { title:"连通性巡检", action:{ route:"networkCheck", body:{}, label:"执行巡检" } },
      { title:"证书体检", action:{ route:"certificateCheck", body:{ host:"192.168.1.20", port:443 }, label:"体检证书", json:true } },
    ] },
  { id:"services", title:"容器与服务", note:"服务状态、容器资源统计与建议。",
    sections:[
      { title:"服务状态", route:"systemServices" },
      { title:"容器资源统计", route:"dockerStats" },
      { title:"Docker 建议", action:{ route:"dockerAdvice", body:{}, label:"生成建议" } },
    ] },
  { id:"storage", title:"存储健康", note:"SMART、温度、容量预测与系统事件。",
    sections:[
      { title:"SMART", route:"systemSmart" },
      { title:"温度", route:"systemThermal" },
      { title:"容量预测", route:"capacityForecast" },
      { title:"系统事件", route:"systemEvents", query:{ limit:20 } },
    ] },
  { id:"automation", title:"自动化", note:"工作流、触发规则评估、运行手册与 MCP。",
    sections:[
      { title:"工作流", route:"workflowsList" },
      { title:"MCP 服务器", route:"mcpStatus" },
      { title:"运行手册", route:"runbooksList" },
      { title:"运行手册统计", route:"runbooksStats" },
      { title:"触发规则评估（只评估，不执行）", action:{ route:"workflowTriggersEvaluate", body:{}, label:"评估触发条件", json:true } },
      { title:"新建运行手册（只存文字，不执行）", action:{ route:"runbookCreate", body:{ title:"", content:"" }, label:"保存", json:true } },
    ] },
  { id:"audit", title:"审计与轨迹", note:"操作审计、工具调用轨迹与待确认写动作。",
    sections:[
      { title:"最近操作审计", route:"auditList", query:{ limit:20 } },
      { title:"工具调用轨迹", route:"agentTrace", query:{ limit:20 } },
      { title:"待确认写动作", route:"writeActions" },
    ] },
  { id:"reports", title:"诊断报告", note:"一键诊断、证据抽取、部署与组合校验、历史。",
    sections:[
      { title:"诊断历史", route:"diagnosesList" },
      { title:"诊断统计", route:"diagnosesStats" },
      { title:"生成诊断报告", action:{ route:"diagnosticsReport", body:{}, label:"生成" } },
      { title:"诊断证据抽取", action:{ route:"diagnosticsEvidence", body:{}, label:"抽取证据", json:true } },
      { title:"日志证据", action:{ route:"diagnosticsLogEvidence", body:{ lines:200, filter:"" }, label:"抽取日志证据", json:true } },
      { title:"部署前校验", action:{ route:"deployPrecheck", body:{}, label:"校验", json:true } },
      { title:"技能组合校验", action:{ route:"compositionsValidate", body:{}, label:"校验组合", json:true } },
    ] },
];

export function render(root, ctx){
  let active = ctx.sub && SUBTABS.some(t => t.id === ctx.sub) ? ctx.sub : "overview";
  const content = h("div");

  function sectionCard(section){
    const body = h("div", { class:"card__body" }, h("p", { class:"muted", style:"margin:0" }, "读取中…"));
    const card = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h3", { class:"card__title" }, section.title)),
      body);
    if(section.action) buildAction(section, body);
    else callJson(section.route, { query:section.query }).then(data => {
      clear(body).append(renderValue(data));
    }).catch(error => {
      clear(body).append(h("div", { class:"banner banner--warn", style:"margin:0" },
        error.status === 501 ? "该能力在此部署未启用。" : error.message));
    });
    return card;
  }

  function buildAction(section, body){
    const a = section.action;
    const textarea = h("textarea", { class:"textarea", style:"min-height:72px;font-family:var(--font-mono);font-size:12px" });
    textarea.value = a.body && Object.keys(a.body).length ? JSON.stringify(a.body, null, 2) : "";
    const result = h("div");
    clear(body);
    if(a.json) body.append(h("div", { class:"field" }, textarea));
    body.append(h("div", { class:"row", style:"gap:8px;margin-bottom:8px" },
      h("button", { class:"btn btn--primary btn--sm", onclick:run }, a.label || "执行"),
      h("span", { class:"muted", style:"font-size:11px" }, "结果只做展示；是否可用由服务端策略裁决")));
    body.append(result);
    async function run(){
      let payload = a.body || {};
      if(a.json){
        try{ payload = textarea.value.trim() ? JSON.parse(textarea.value) : {}; }
        catch{ toast("JSON 格式错误", "err"); return; }
      }
      result.replaceChildren(h("p", { class:"muted", style:"font-size:12px;margin:0" }, "执行中…"));
      try{
        const data = await callJson(a.route, { body:payload });
        result.replaceChildren(h("pre", { class:"code", style:"max-height:300px" },
          JSON.stringify(formatDisplayValue(data), null, 2).slice(0, 12000)));
      }catch(error){
        result.replaceChildren(h("div", { class:"banner banner--warn", style:"margin:0;white-space:pre-wrap" },
          error.message + (error.code ? "（" + error.code + "）" : "")));
      }
    }
  }

  function draw(){
    const tab = SUBTABS.find(t => t.id === active);
    content.replaceChildren(
      h("div", { class:"banner banner--info" }, tab.note),
      ...tab.sections.map(sectionCard));
    history.replaceState(null, "", "#/system/" + tab.id);
  }
  const tabs = h("div", { class:"subtabs", role:"tablist" },
    SUBTABS.map(t => h("button", { role:"tab", dataset:{ tab:t.id }, class:t.id === active ? "on" : "",
      onclick:event => {
        active = t.id;
        tabs.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.tab === active));
        draw();
      } }, t.title)));

  root.append(tabs, content);
  draw();
}
