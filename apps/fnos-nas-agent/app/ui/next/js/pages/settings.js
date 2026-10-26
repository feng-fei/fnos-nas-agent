/* pages/settings.js —— 设置区（UI-5）。四组设置全部接真实契约：
 * 模型服务（CRUD/测试/默认/用量/预设）、Skill（状态机/批量/导入/远程导入）、
 * 知识库（统计/冲突/列表/两步写入）、安全边界（执行模式/安检/能力位图）。 */

import { h, clear } from "../h.js";
import { callJson, routeUrl } from "../api.js";
import { toast, confirmModal, openModal } from "../ui.js";
import { formatDateTime, formatDisplayValue } from "../format.js";

/* Skill 状态机（与 skills.mjs 的 TRANSITIONS 对齐；服务端仍是唯一裁决者） */
const SKILL_TRANSITIONS = {
  pending_review:["approved", "rejected"],
  approved:["enabled", "disabled", "rejected"],
  enabled:["disabled"],
  disabled:["approved", "rejected"],
  rejected:[],
};
const SKILL_STATE_LABEL = { pending_review:"待审核", approved:"已批准", enabled:"已启用", disabled:"已停用", rejected:"已拒绝" };
const STATE_BADGE = { pending_review:"badge--warn", approved:"badge--info", enabled:"badge--ok", disabled:"", rejected:"badge--danger" };
const KNOWLEDGE_SOURCES = ["official-doc", "field-observation", "manual-confirmation"];

export function render(root, ctx){
  let group = ctx.sub && ["models", "skills", "knowledge", "security"].includes(ctx.sub) ? ctx.sub : "models";
  const content = h("div");
  const groups = [
    { id:"models", title:"模型服务" }, { id:"skills", title:"Skill 管理" },
    { id:"knowledge", title:"知识库" }, { id:"security", title:"安全边界" },
  ];
  function draw(){
    const g = groups.find(x => x.id === group);
    history.replaceState(null, "", "#/settings/" + g.id);
    content.replaceChildren(h("p", { class:"muted", style:"margin:0 2px 10px" }, g.title + " · 加载中…"));
    if(group === "models") drawModels();
    else if(group === "skills") drawSkills();
    else if(group === "knowledge") drawKnowledge();
    else drawSecurity();
  }
  const tabs = h("div", { class:"subtabs", role:"tablist" },
    groups.map(g => h("button", { role:"tab", dataset:{ tab:g.id }, class:g.id === group ? "on" : "",
      onclick:() => { group = g.id;
        tabs.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.tab === group));
        draw(); } }, g.title)));
  root.append(tabs, content);
  draw();

  /* ================= 模型服务 ================= */
  function drawModels(){
    const wrap = h("div");
    content.replaceChildren(wrap);
    const listCard = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "服务商"),
        h("span", { style:"flex:1" }),
        h("button", { class:"btn btn--primary btn--sm", onclick:() => providerModal(null) }, "＋ 添加服务商")),
      h("div", { class:"card__body" }, h("p", { class:"muted", style:"margin:0" }, "读取中…")));
    const usageCard = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "用量统计"),
        h("p", { class:"card__sub" }, "来自模型通道的真实计量")),
      h("div", { class:"card__body" }, h("p", { class:"muted", style:"margin:0" }, "读取中…")));
    wrap.append(listCard, usageCard);
    callJson("modelsUsage").then(u => {
      usageCard.querySelector(".card__body").replaceChildren(renderValue(u));
    }).catch(() => usageCard.querySelector(".card__body").replaceChildren(
      h("p", { class:"muted", style:"margin:0" }, "用量暂不可用。")));
    callJson("modelsList").then(data => {
      const body = clear(listCard.querySelector(".card__body"));
      const providers = data.providers || [];
      if(!providers.length){ body.append(h("p", { class:"muted", style:"margin:0" }, "尚未添加服务商。")); return; }
      const list = h("div", { class:"stack" });
      for(const p of providers){
        const actions = h("div", { class:"row row--wrap", style:"gap:6px;margin-top:8px" });
        if(!p.isDefault) actions.append(h("button", { class:"btn btn--sm", onclick:async () => {
          try{ await callJson("modelSetDefault", { params:{ id:p.id } }); toast("已设为默认", "ok"); drawModels(); }
          catch(error){ toast(error.message, "err"); } } }, "设为默认"));
        actions.append(h("button", { class:"btn btn--sm", onclick:async () => {
          try{ const r = await callJson("modelTest", { params:{ id:p.id } });
            openModal("连接测试 · " + p.name, h("pre", { class:"code" },
              JSON.stringify(formatDisplayValue(r.test || r), null, 2).slice(0, 2000)),
              [{ label:"关闭", onClick:c => c() }]);
          }catch(error){ toast(error.message, "err"); } } }, "测试"));
        actions.append(h("button", { class:"btn btn--sm", onclick:() => providerModal(p) }, "编辑"));
        actions.append(h("button", { class:"btn btn--sm btn--danger", onclick:() => confirmModal("删除服务商",
          "将删除「" + p.name + "」（密钥一并清除，不可恢复）。", "删除", async () => {
            try{ await callJson("modelRemove", { params:{ id:p.id } }); toast("已删除", "ok"); drawModels(); }
            catch(error){ toast(error.message, "err"); } }) }, "删除"));
        list.append(h("div", { class:"card", style:"margin:0" },
          h("div", { class:"card__head" },
            h("h3", { class:"card__title" }, p.name),
            p.isDefault ? h("span", { class:"badge badge--ok" }, "默认") : null,
            h("span", { class:"badge " + (p.enabled ? "badge--info" : "") }, p.enabled ? "已启用" : "已停用"),
            h("span", { class:"badge " + (p.hasApiKey ? "badge--ok" : "badge--warn") }, p.hasApiKey ? "密钥已存" : "无密钥")),
          h("div", { class:"card__body" },
            h("dl", { class:"kv" },
              h("dt", null, "模型"), h("dd", null, p.model || "—"),
              h("dt", null, "接口"), h("dd", { style:"word-break:break-all" }, p.endpoint || "—"),
              p.lastTest ? [h("dt", null, "最近测试"), h("dd", null,
                (p.lastTest.ok ? "✅ " : "❌ ") + (p.lastTest.message || "") + " · " + formatDateTime(p.lastTest.at))] : null),
            actions)));
      }
      body.replaceChildren(list);
    }).catch(error => {
      listCard.querySelector(".card__body").replaceChildren(
        h("div", { class:"banner banner--warn", style:"margin:0" }, error.message));
    });
  }

  function providerModal(existing){
    const isEdit = Boolean(existing);
    const name = h("input", { class:"input", value:existing?.name || "", maxlength:80 });
    const endpoint = h("input", { class:"input", value:existing?.endpoint || "",
      placeholder:"https://api.deepseek.com（base 或完整 /v1/chat/completions）" });
    const model = h("input", { class:"input", value:existing?.model || "", maxlength:160 });
    const apiKey = h("input", { class:"input", type:"password", maxlength:2048,
      placeholder:isEdit ? "留空保留已存密钥" : "必填" });
    const enabled = h("input", { type:"checkbox", checked:existing ? existing.enabled : true });
    const clearKey = isEdit ? h("input", { type:"checkbox" }) : null;
    const errEl = h("p", { class:"error", role:"alert" });
    const presetsBox = h("div", { class:"row row--wrap", style:"gap:6px;margin-bottom:10px" });
    callJson("modelsPresets").then(r => {
      for(const preset of (r.presets || []).slice(0, 8))
        presetsBox.append(h("button", { class:"btn btn--ghost btn--sm", onclick:() => {
          if(preset.name) name.value = preset.name;
          if(preset.endpoint) endpoint.value = preset.endpoint;
          if(preset.model) model.value = preset.model;
        } }, preset.name || preset.endpoint));
    }).catch(() => {});
    const body = h("div", null,
      presetsBox,
      h("div", { class:"field" }, h("label", { class:"field__label" }, "显示名称"), name),
      h("div", { class:"field" }, h("label", { class:"field__label" }, "API Endpoint"),
        endpoint, h("p", { class:"field__hint" }, "必须 HTTPS；可填 base（自动补全 /chat/completions）或完整地址；不支持查询串/账号密码。")),
      h("div", { class:"field" }, h("label", { class:"field__label" }, "模型 ID"), model),
      h("div", { class:"field" }, h("label", { class:"field__label" }, "API Key"), apiKey,
        isEdit ? h("p", { class:"field__hint" }, "密钥加密存储；UI 只能写入或清除，永远读不回。") : null),
      isEdit ? h("label", { class:"checkbox" }, clearKey, h("span", "清除已存密钥（将同时停用该服务商）")) : null,
      h("label", { class:"checkbox" }, enabled, h("span", "启用该服务商")),
      errEl);
    openModal(isEdit ? "编辑服务商" : "添加服务商", body,
      [{ label:"取消", onClick:c => c() },
       { label:isEdit ? "保存" : "添加", cls:"btn--primary", onClick:async c => {
          errEl.textContent = "";
          const payload = { name:name.value.trim(), endpoint:endpoint.value.trim(), model:model.value.trim(),
            enabled:enabled.checked };
          if(apiKey.value) payload.apiKey = apiKey.value;
          if(isEdit && clearKey.checked) payload.clearApiKey = true;
          try{
            if(isEdit) await callJson("modelUpdate", { params:{ id:existing.id }, body:payload });
            else await callJson("modelAdd", { body:payload });
            toast(isEdit ? "已保存" : "已添加", "ok"); c(); drawModels();
          }catch(error){ errEl.textContent = error.message; }
       } }]);
  }

  /* ================= Skill 管理 ================= */
  function drawSkills(){
    const wrap = h("div");
    content.replaceChildren(wrap);
    const toolbar = h("div", { class:"row row--wrap", style:"gap:8px;margin-bottom:10px" },
      h("button", { class:"btn btn--primary btn--sm", onclick:() => skillImportModal() }, "⬆ 导入 ZIP"),
      h("button", { class:"btn btn--sm", onclick:() => skillRemoteModal() }, "🌐 远程导入"),
      h("button", { class:"btn btn--ghost btn--sm", onclick:drawSkills }, "刷新"));
    const listCard = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "已登记 Skill"),
        h("p", { class:"card__sub" }, "导入后进入隔离待审核；启用不授予任何额外权限，导入内容永不执行")),
      h("div", { class:"card__body" }, h("p", { class:"muted", style:"margin:0" }, "读取中…")));
    wrap.append(toolbar, listCard);
    callJson("skillsList").then(data => {
      const body = clear(listCard.querySelector(".card__body"));
      const skills = data.skills || [];
      if(!skills.length){ body.append(h("p", { class:"muted", style:"margin:0" }, "还没有登记任何 Skill。")); return; }
      const list = h("div", { class:"stack" });
      for(const s of skills){
        const targets = SKILL_TRANSITIONS[s.state] || [];
        const actions = h("div", { class:"row row--wrap", style:"gap:6px;margin-top:8px" });
        if(s.name.toLowerCase() === "fnos" && ["approved", "enabled"].includes(s.state)){
          actions.append(h("button", { class:"btn btn--sm", onclick:() => confirmModal("安装官方 CLI",
            "将从该 Skill 的隔离归档中安装官方 fnOS CLI（仅 Linux x64/ARM64），并放置到 Agent 私有目录。", "安装", async () => {
              try{ const r = await callJson("skillInstallCli", { params:{ id:s.id }, body:{} });
                openModal("官方 CLI 安装结果", h("pre", { class:"code" },
                  JSON.stringify(formatDisplayValue(r), null, 2).slice(0, 3000)), [{ label:"关闭", onClick:c => c() }]);
              }catch(error){ toast(error.message, "err"); }
            }) }, "安装官方 CLI"));
        }
        for(const target of targets){
          actions.append(h("button", { class:"btn btn--sm" + (target === "rejected" ? " btn--danger" : ""),
            onclick:() => skillTransition(s, target) }, "→ " + SKILL_STATE_LABEL[target]));
        }
        actions.append(h("button", { class:"btn btn--ghost btn--sm", onclick:() => confirmModal("删除 Skill",
          "将删除「" + s.name + "」及其隔离归档记录。", "删除", async () => {
            try{ await callJson("skillRemove", { params:{ id:s.id } }); toast("已删除", "ok"); drawSkills(); }
            catch(error){ toast(error.message, "err"); } }) }, "删除"));
        list.append(h("div", { class:"card", style:"margin:0" },
          h("div", { class:"card__head" },
            h("h3", { class:"card__title" }, s.name),
            h("span", { class:"badge " + (STATE_BADGE[s.state] || "") }, SKILL_STATE_LABEL[s.state] || s.state),
            s.version ? h("span", { class:"badge" }, "v" + s.version) : null,
            s.manifestReview ? h("span", { class:"badge " + (s.manifestReview.status === "manifest_parsed" ? "badge--ok" : "badge--warn") },
              s.manifestReview.status === "manifest_parsed" ? "清单已解析" : "清单待审") : null),
          h("div", { class:"card__body" },
            h("dl", { class:"kv" },
              h("dt", null, "登记时间"), h("dd", null, formatDateTime(s.createdAt)),
              s.archiveSha256 ? [h("dt", null, "归档摘要"), h("dd", { style:"font-family:var(--font-mono);font-size:11px;word-break:break-all" }, String(s.archiveSha256).slice(0, 32) + "…")] : null,
              s.note ? [h("dt", null, "备注"), h("dd", null, s.note)] : null),
            actions)));
      }
      body.replaceChildren(list);
    }).catch(error => {
      listCard.querySelector(".card__body").replaceChildren(
        h("div", { class:"banner banner--warn", style:"margin:0" }, error.message));
    });
  }
  function skillTransition(skill, target){
    const note = h("input", { class:"input", maxlength:500, placeholder:"审核备注（可留空）" });
    openModal("状态流转：" + SKILL_STATE_LABEL[target],
      h("div", { class:"field" }, h("label", { class:"field__label" },
        "将「" + skill.name + "」从 " + SKILL_STATE_LABEL[skill.state] + " 流转到 " + SKILL_STATE_LABEL[target]), note),
      [{ label:"取消", onClick:c => c() },
       { label:"确认流转", cls:"btn--primary", onClick:async c => {
          try{ await callJson("skillTransition", { params:{ id:skill.id }, body:{ state:target, note:note.value } });
            toast("已流转", "ok"); c(); drawSkills();
          }catch(error){ toast(error.message, "err"); }
       } }]);
  }
  function skillImportModal(){
    const nameInput = h("input", { class:"input", maxlength:100, placeholder:"留空则取文件名" });
    const versionInput = h("input", { class:"input", maxlength:40, placeholder:"如 1.0.0" });
    const sourceInput = h("select", { class:"select" },
      h("option", { value:"official" }, "官方发布"), h("option", { value:"manual" }, "手动收集"));
    const fileInput = h("input", { type:"file", accept:".zip", multiple:true });
    const bar = h("i", { style:"display:block;height:100%;width:0;background:var(--accent)" });
    const progress = h("div", { style:"height:6px;background:var(--surface-3);border-radius:3px;overflow:hidden;margin-top:8px" }, bar);
    const status = h("p", { class:"muted", style:"font-size:12px;margin:6px 0 0" }, "选择一个或多个 ZIP（单个 ≤ 25 MiB）");
    openModal("导入 Skill ZIP（进入隔离区，不执行）",
      h("div", null,
        h("div", { class:"field" }, h("label", { class:"field__label" }, "Skill 名称"), nameInput),
        h("div", { class:"field" }, h("label", { class:"field__label" }, "版本"), versionInput),
        h("div", { class:"field" }, h("label", { class:"field__label" }, "来源"), sourceInput),
        h("div", { class:"field" }, h("label", { class:"field__label" }, "ZIP 归档"), fileInput, progress, status)),
      [{ label:"关闭", onClick:c => c() },
       { label:"开始导入", cls:"btn--primary", onClick:async c => {
          const files = [...(fileInput.files || [])];
          if(!files.length){ toast("请选择 ZIP 文件", "err"); return; }
          const oversized = files.find(f => f.size > 25 * 1024 * 1024);
          if(oversized){ toast("「" + oversized.name + "」超过 25 MiB", "err"); return; }
          let done = 0, failed = 0;
          for(const [i, file] of files.entries()){
            status.textContent = "上传中 " + (i + 1) + "/" + files.length + "：" + file.name;
            const ok = await new Promise(resolve => {
              const xhr = new XMLHttpRequest();
              xhr.open("POST", routeUrl("skillImport"), true);
              xhr.withCredentials = true;
              xhr.setRequestHeader("content-type", "application/zip");
              xhr.setRequestHeader("x-skill-name", (nameInput.value.trim() || file.name.replace(/\.zip$/i, "")).slice(0, 100));
              xhr.setRequestHeader("x-skill-version", versionInput.value.trim().slice(0, 40));
              xhr.setRequestHeader("x-skill-source", sourceInput.value);
              xhr.upload.addEventListener("progress", ev => {
                if(ev.lengthComputable) bar.style.width = Math.round(((i + ev.loaded / ev.total) / files.length) * 100) + "%";
              });
              xhr.addEventListener("load", () => {
                if(xhr.status >= 200 && xhr.status < 300) resolve(true);
                else{ let msg = "导入失败（HTTP " + xhr.status + "）";
                  try{ msg = JSON.parse(xhr.responseText || "{}").error || msg; }catch{}
                  toast(file.name + "：" + msg, "err"); resolve(false); }
              });
              xhr.addEventListener("error", () => { toast(file.name + "：网络错误", "err"); resolve(false); });
              xhr.send(file);
            });
            ok ? done++ : failed++;
          }
          toast("导入完成：成功 " + done + " · 失败 " + failed, failed ? "err" : "ok");
          c(); drawSkills();
       } }]);
  }
  function skillRemoteModal(){
    const name = h("input", { class:"input", maxlength:100 });
    const version = h("input", { class:"input", maxlength:40 });
    const url = h("input", { class:"input", placeholder:"ZIP 下载地址（HTTPS）" });
    openModal("远程导入 Skill",
      h("div", null,
        h("div", { class:"field" }, h("label", { class:"field__label" }, "名称"), name),
        h("div", { class:"field" }, h("label", { class:"field__label" }, "版本"), version),
        h("div", { class:"field" }, h("label", { class:"field__label" }, "归档 URL"), url),
        h("p", { class:"field__hint" }, "由服务端下载并进入同一套隔离审核流程；抓取地址与大小受策略限制。")),
      [{ label:"取消", onClick:c => c() },
       { label:"导入", cls:"btn--primary", onClick:async c => {
          const urlText = url.value.trim();
          try{
            const lines = urlText.split(/\s+/).filter(Boolean);
            if(lines.length > 1){
              await callJson("skillImportRemoteBatch", { body:{ items:lines.map(u => ({ url:u,
                name:name.value.trim(), version:version.value.trim() })) } });
              toast("已提交批量远程导入：" + lines.length + " 个", "ok");
            }else{
              await callJson("skillImportRemote", { body:{ name:name.value.trim(), version:version.value.trim(), url:urlText } });
              toast("已提交远程导入", "ok");
            }
            c(); drawSkills();
          }catch(error){ toast(error.message, "err"); }
       } }]);
  }

  /* ================= 知识库 ================= */
  function drawKnowledge(){
    const wrap = h("div");
    content.replaceChildren(wrap);
    const statsCard = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "统计")),
      h("div", { class:"card__body" }, h("p", { class:"muted", style:"margin:0" }, "读取中…")));
    const conflictsCard = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "冲突"),
        h("p", { class:"card__sub" }, "同一主题存在不同结论时并列展示，不做自动取舍")),
      h("div", { class:"card__body" }, h("p", { class:"muted", style:"margin:0" }, "读取中…")));
    const writeCard = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "两步写入"),
        h("p", { class:"card__sub" }, "先预览（服务端校验并给出理由），确认后凭 previewId 提交")),
      h("div", { class:"card__body" }, buildKnowledgeWrite()));
    const listCard = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "条目"),
        h("span", { style:"flex:1" }),
        h("button", { class:"btn btn--ghost btn--sm", onclick:drawKnowledge }, "刷新")),
      h("div", { class:"card__body" }, h("p", { class:"muted", style:"margin:0" }, "读取中…")));
    wrap.append(statsCard, conflictsCard, writeCard, listCard);

    callJson("knowledgeStats").then(s => statsCard.querySelector(".card__body").replaceChildren(renderValue(s)))
      .catch(() => statsCard.querySelector(".card__body").replaceChildren(h("p", { class:"muted", style:"margin:0" }, "统计暂不可用。")));
    callJson("knowledgeConflicts").then(c => conflictsCard.querySelector(".card__body").replaceChildren(renderValue(c)))
      .catch(() => conflictsCard.querySelector(".card__body").replaceChildren(h("p", { class:"muted", style:"margin:0" }, "冲突读取暂不可用。")));
    callJson("knowledgeList", { query:{ limit:30 } }).then(data => {
      const entries = data.entries || data.items || [];
      const body = clear(listCard.querySelector(".card__body"));
      if(!entries.length){ body.append(h("p", { class:"muted", style:"margin:0" }, "知识库为空。")); return; }
      const list = h("div", { class:"stack" });
      for(const entry of entries){
        list.append(h("div", { class:"card", style:"margin:0" },
          h("div", { class:"card__head" },
            h("h3", { class:"card__title" }, entry.title || entry.topic || "（无标题）"),
            h("span", { class:"badge badge--info" }, entry.source || "—"),
            entry.archived ? h("span", { class:"badge" }, "已归档") : null,
            h("span", { class:"badge " + (entry.confidence === "high" ? "badge--ok" : "badge--warn") }, entry.confidence || "—")),
          h("div", { class:"card__body" },
            h("p", { class:"muted", style:"font-size:12px;margin:0" },
              (entry.topic ? "主题：" + entry.topic + " · " : "") + formatDateTime(entry.createdAt || entry.updatedAt)))));
      }
      body.replaceChildren(list);
    }).catch(() => listCard.querySelector(".card__body").replaceChildren(
      h("p", { class:"muted", style:"margin:0" }, "条目读取暂不可用。")));
  }
  function buildKnowledgeWrite(){
    const title = h("input", { class:"input", maxlength:200 });
    const topic = h("input", { class:"input", maxlength:200 });
    const source = h("select", { class:"select" },
      KNOWLEDGE_SOURCES.map(s => h("option", { value:s }, s)));
    const claims = h("textarea", { class:"textarea", style:"font-family:var(--font-mono);font-size:12px",
      placeholder:'[\n  { "statement": "…", "evidence": "…" }\n]' });
    const previewOut = h("div");
    let previewId = null;
    const commitBtn = h("button", { class:"btn btn--sm", disabled:true, onclick:doCommit }, "② 提交（previewId）");
    function invalidatePreview(){
      if(!previewId) return;
      callJson("knowledgeCancel", { body:{ previewId } }).catch(() => {});
      previewId = null; commitBtn.disabled = true;
    }
    for(const el of [title, topic, source, claims]) el.addEventListener("input", invalidatePreview);
    async function payload(){
      let parsedClaims = [];
      try{ parsedClaims = claims.value.trim() ? JSON.parse(claims.value) : []; }
      catch{ toast("claims 必须是 JSON 数组", "err"); throw new Error("invalid"); }
      return { operation:"write", input:{ title:title.value.trim(), topic:topic.value.trim(), source:source.value, claims:parsedClaims } };
    }
    async function doPreview(){
      let body;
      try{ body = await payload(); }catch{ return; }
      previewOut.replaceChildren(h("p", { class:"muted", style:"font-size:12px;margin:0" }, "预览中…"));
      try{
        const r = await callJson("knowledgePreview", { body });
        previewId = r.previewId || null;
        previewOut.replaceChildren(h("pre", { class:"code", style:"max-height:220px" },
          JSON.stringify(formatDisplayValue(r), null, 2).slice(0, 6000)));
        commitBtn.disabled = !previewId;
        if(previewId) toast("预览通过，可以提交", "ok");
      }catch(error){
        previewId = null; commitBtn.disabled = true;
        previewOut.replaceChildren(h("div", { class:"banner banner--warn", style:"margin:0;white-space:pre-wrap" },
          "预览被拒绝：" + error.message + (error.data?.reasons ? "\n· " + error.data.reasons.join("\n· ") : "")));
      }
    }
    async function doCommit(){
      if(!previewId){ toast("请先生成预览", "err"); return; }
      try{
        const r = await callJson("knowledgeCommit", { body:{ previewId } });
        toast("已提交入库", "ok");
        previewOut.replaceChildren(h("pre", { class:"code", style:"max-height:220px" },
          JSON.stringify(formatDisplayValue(r), null, 2).slice(0, 4000)));
        commitBtn.disabled = true; previewId = null;
      }catch(error){ toast(error.message, "err"); }
    }
    return h("div", null,
      h("div", { class:"field" }, h("label", { class:"field__label" }, "标题"), title),
      h("div", { class:"field" }, h("label", { class:"field__label" }, "主题"), topic),
      h("div", { class:"field" }, h("label", { class:"field__label" }, "来源"), source),
      h("div", { class:"field" }, h("label", { class:"field__label" }, "claims（JSON 数组）"), claims),
      h("div", { class:"row", style:"gap:8px" },
        h("button", { class:"btn btn--primary btn--sm", onclick:doPreview }, "① 生成预览"), commitBtn),
      previewOut);
  }

  /* ================= 安全边界 ================= */
  function drawSecurity(){
    const wrap = h("div");
    content.replaceChildren(wrap);
    const modeCard = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "执行模式"),
        h("p", { class:"card__sub" }, "normal 正常 · read-only 全局只读 · halted 紧急停机；停机状态下控制台仍可恢复")),
      h("div", { class:"card__body" }, h("p", { class:"muted", style:"margin:0" }, "读取中…")));
    const inspectionCard = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "安全检查"),
        h("p", { class:"card__sub" }, "由服务端执行的只读安检，结论如实呈现")),
      h("div", { class:"card__body" },
        h("button", { class:"btn btn--primary btn--sm", onclick:runInspection }, "运行安检"),
        h("div", { id:"inspection-out", style:"margin-top:8px" })));
    const capCard = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "设备能力位图"),
        h("p", { class:"card__sub" }, "agent-host 视角的能力评估")),
      h("div", { class:"card__body" }, h("p", { class:"muted", style:"margin:0" }, "读取中…")));
    const boundary = h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "边界声明")),
      h("div", { class:"card__body" },
        h("ul", { style:"font-size:13px;padding-left:18px;margin:0", class:"stack" },
          h("li", null, "任意命令执行、导入 Skill 的代码执行：永久关闭"),
          h("li", null, "删除等破坏性操作：服务端一次性确认，60 秒内单次有效"),
          h("li", null, "API Key 加密存储，UI 永远读不回明文"),
          h("li", null, "审计只记路由与结果状态，不记参数与密钥"))));
    wrap.append(modeCard, inspectionCard, capCard, boundary);

    function drawMode(){
      callJson("executionModeGet").then(r => {
        const labels = { normal:"正常", "read-only":"全局只读", halted:"紧急停机" };
        const seg = h("div", { class:"seg", role:"group" },
          (r.modes || ["normal", "read-only", "halted"]).map(m =>
            h("button", { class:r.mode === m ? "on" : "", onclick:() => setMode(m, r.mode) }, labels[m] || m)));
        modeCard.querySelector(".card__body").replaceChildren(
          seg, h("p", { class:"field__hint", style:"margin-top:8px" }, "当前：" + r.mode + "（来源：" + (r.source || "default") + "）"));
      }).catch(() => modeCard.querySelector(".card__body").replaceChildren(
        h("p", { class:"muted", style:"margin:0" }, "执行模式读取暂不可用。")));
    }
    function setMode(next, current){
      const warning = next === "halted" ? "\n停机后所有操作（含文件与管理）都会被拒绝，只能从本控制台恢复。" :
        next === "read-only" ? "\n只读模式下所有写操作与上传会被拒绝。" : "\n恢复正常模式后，写操作将重新可用。";
      confirmModal("切换执行模式", "从「" + current + "」切换到「" + next + "」。" + warning, "确认切换", async () => {
        try{ await callJson("executionMode", { body:{ mode:next } }); toast("已切换到 " + next, "ok"); }
        catch(error){ toast(error.message, "err"); }
        drawMode();
      });
    }
    async function runInspection(){
      const out = document.getElementById("inspection-out");
      out.replaceChildren(h("p", { class:"muted", style:"font-size:12px;margin:0" }, "安检运行中…"));
      try{
        const r = await callJson("securityInspection", { body:{} });
        out.replaceChildren(h("pre", { class:"code", style:"max-height:320px" },
          JSON.stringify(formatDisplayValue(r), null, 2).slice(0, 12000)));
      }catch(error){ out.replaceChildren(h("div", { class:"banner banner--warn", style:"margin:0" }, error.message)); }
    }
    callJson("systemCapabilities").then(r => capCard.querySelector(".card__body").replaceChildren(renderValue(r)))
      .catch(() => capCard.querySelector(".card__body").replaceChildren(h("p", { class:"muted", style:"margin:0" }, "能力位图暂不可用。")));
    drawMode();
  }
}
