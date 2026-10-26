/* pages/files.js —— 文件管理（UI-3）。交互定稿来自工作区原型 file-manager-ui.html。
 * 真实契约：GET /api/files（roots/parentPath/entries/totalEntries，服务端排序与搜索）；
 * POST /api/files/operation：mkdir | rename | move | delete（delete 返回 202 审批）；
 * 上传为 application/octet-stream 原始字节 + ?path=&name=；预览 GET /api/files/preview。
 * 说明：服务端没有复制语义（只有 mkdir/rename/move/delete），「复制」按钮在非演示模式禁用，
 * 剪切/移动完全可用；复制能力登记为后续服务端阶段。 */

import { h, clear } from "../h.js";
import { callJson, routeUrl } from "../api.js";
import { toast, confirmModal, openModal } from "../ui.js";
import { formatBytes, formatDateTime } from "../format.js";

const PREVIEW = window.__UI_PREVIEW__ === true;
const PAGE = 60;
const ICON = { image:"🖼️", video:"🎬", audio:"🎵", archive:"🗜️", code:"📄", doc:"📘", file:"📄" };
const COPY_SUPPORTED = PREVIEW; // 服务端暂无 copy 语义

function kindIcon(e){
  if(e.type === "directory") return "📁";
  const ext = (e.name.slice(e.name.lastIndexOf(".") + 1) || "").toLowerCase();
  if(/\.(jpe?g|png|gif|webp|bmp|raw|heic)$/.test(ext)) return ICON.image;
  if(/\.(mp4|mkv|mov|avi|webm|ts)$/.test(ext)) return ICON.video;
  if(/\.(mp3|flac|wav|m4a|ape)$/.test(ext)) return ICON.audio;
  if(/\.(zip|rar|7z|tar|gz|xz|zst|iso)$/.test(ext)) return ICON.archive;
  if(/\.(md|txt|json|conf|ini|ya?ml|log|csv)$/.test(ext)) return ICON.doc;
  return ICON.file;
}

export function render(root, ctx){
  const state = {
    path:"", data:null, sort:"directories-first", q:"", type:"all", offset:0,
    selection:new Set(), clipboard:null, view:"list",
  };
  try{ state.view = localStorage.getItem("ui2.files.view") === "grid" ? "grid" : "list"; }catch{}

  /* ---------------- 外壳节点 ---------------- */
  const rootsRow = h("div", { class:"row row--wrap", style:"gap:8px;margin-bottom:10px" });
  const crumbs = h("nav", { class:"row", style:"flex-wrap:wrap;gap:2px", "aria-label":"目录路径" });
  const searchInput = h("input", { class:"input", type:"search", placeholder:"搜索当前目录…", style:"max-width:200px;min-height:36px" });
  const typeSel = h("select", { class:"select", style:"max-width:110px;min-height:36px" },
    h("option", { value:"all" }, "全部"), h("option", { value:"directory" }, "文件夹"), h("option", { value:"file" }, "文件"));
  const sortSel = h("select", { class:"select", style:"max-width:150px;min-height:36px" },
    h("option", { value:"directories-first" }, "目录优先"), h("option", { value:"name-asc" }, "名称 A→Z"),
    h("option", { value:"name-desc" }, "名称 Z→A"), h("option", { value:"size-desc" }, "大小"),
    h("option", { value:"modified-desc" }, "修改时间"));
  const viewSeg = h("div", { class:"seg" },
    h("button", { class:state.view === "list" ? "on" : "", dataset:{ view:"list" }, onclick:() => setView("list") }, "☰"),
    h("button", { class:state.view === "grid" ? "on" : "", dataset:{ view:"grid" }, onclick:() => setView("grid") }, "▦"));
  const metaRow = h("div", { class:"row", style:"justify-content:space-between;margin:6px 2px 10px;font-size:12px;color:var(--text-mute)" });
  const content = h("div");
  const selectAll = h("input", { type:"checkbox", class:"chk", style:"width:16px;height:16px;accent-color:var(--accent)",
    onchange:event => {
      if(event.target.checked) for(const e of state.data?.entries || []) state.selection.add(e.path);
      else state.selection.clear();
      drawEntries();
    } });

  const selCount = h("b", null, "0");
  const batchBar = h("div", { style:"position:fixed;left:50%;bottom:calc(var(--tabbar-h) + 14px);transform:translateX(-50%);z-index:40;" +
      "background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);padding:8px 10px;" +
      "display:none;gap:6px;align-items:center;max-width:min(94vw,760px)" },
    h("span", { class:"muted", style:"font-size:12px;padding:0 4px" }, "已选 ", selCount, " 项"),
    btn("bat-copy", "📋 复制", () => copySel(), COPY_SUPPORTED ? "" : "服务端暂不支持复制（仅移动）；接入 copy 语义后启用"),
    btn("bat-cut", "✂️ 剪切", () => cutSel()),
    btn("bat-move", "📦 移动", () => moveModal([...selectedEntries()])),
    btn("bat-rename", "✏️ 批量改名", () => batchRenameModal([...selectedEntries()])),
    btn("bat-del", "🗑 删除", () => deleteConfirm([...selectedEntries()])),
    h("button", { class:"btn btn--ghost btn--sm", onclick:() => { state.selection.clear(); drawEntries(); } }, "取消"));
  function btn(id, label, onClick, title){
    return h("button", { class:"btn btn--sm", id, title: title || "", onclick:onClick, disabled: title ? true : false }, label);
  }
  function selectedEntries(){
    return (state.data?.entries || []).filter(e => state.selection.has(e.path));
  }

  const pasteBtn = h("button", { class:"btn btn--sm", hidden:true, onclick:() => paste() });
  const clipText = h("span");
  const clipBar = h("div", { class:"row", style:"gap:8px;margin:0 0 10px;padding:7px 12px;border-radius:10px;background:var(--accent-soft);color:var(--accent);font-size:12px;display:none" },
    clipText, h("span", { style:"flex:1" }),
    h("button", { class:"btn btn--ghost btn--sm", onclick:() => { state.clipboard = null; syncClip(); } }, "清空剪贴板"));
  function syncClip(){
    const clip = state.clipboard;
    if(clip && clip.items.length){
      clipBar.style.display = "flex";
      clipText.textContent = "剪贴板：" + (clip.mode === "copy" ? "复制" : "剪切") + " " + clip.items.length + " 项";
      pasteBtn.hidden = false;
      pasteBtn.textContent = "📋 粘贴 " + clip.items.length + " 项";
      const sameDir = clip.mode === "cut" && clip.items.every(it => parentOf(it.path) === state.path);
      pasteBtn.disabled = sameDir;
    }else{ clipBar.style.display = "none"; pasteBtn.hidden = true; }
  }
  function parentOf(p){ const i = p.replace(/\/+$/, "").lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); }

  /* ---------------- 数据加载 ---------------- */
  let loadSeq = 0;
  async function load(offset = 0){
    const seq = ++loadSeq;
    content.replaceChildren(h("div", { class:"skeleton" }), h("div", { class:"skeleton" }));
    try{
      const data = await callJson("filesList", { query:{
        path:state.path, limit:PAGE, offset, sort:state.sort, q:state.q, type:state.type } });
      if(seq !== loadSeq) return;
      state.data = data; state.offset = offset;
      state.path = data.path || state.path;
      if(!state.path && data.roots?.length){ state.path = data.roots[0].path; return load(0); }
      drawAll();
    }catch(error){
      content.replaceChildren(h("div", { class:"empty" }, h("div", { class:"big" }, "⚠️"), error.message));
    }
  }
  function go(path){ state.path = path; state.selection.clear(); load(0); }

  function drawAll(){
    const d = state.data;
    if(!d) return;
    drawRoots(d.roots || []);
    drawCrumbs(d);
    syncClip();
    const total = d.totalEntries ?? 0;
    metaRow.replaceChildren(
      h("span", null, "匹配 " + total + " 项 / 目录共 " + (d.totalDirectoryEntries ?? 0) + " 项" +
        (total ? " · 显示 " + ((d.offset ?? 0) + 1) + "–" + Math.min((d.offset ?? 0) + (d.entries || []).length, total) : "")),
      h("span", { class:"row", style:"gap:10px;align-items:center" },
        h("label", { class:"row", style:"gap:5px;cursor:pointer" }, selectAll, "全选"),
        h("button", { class:"btn btn--ghost btn--sm", disabled:!d.parentPath, onclick:() => go(d.parentPath) }, "↑ 上级"),
        h("button", { class:"btn btn--ghost btn--sm", disabled:(d.offset ?? 0) <= 0, onclick:() => load(Math.max(0, state.offset - PAGE)) }, "‹ 上一页"),
        h("button", { class:"btn btn--ghost btn--sm",
          disabled:(d.offset ?? 0) + (d.entries || []).length >= total, onclick:() => load(state.offset + PAGE) }, "下一页 ›")));
    drawEntries();
  }
  function drawRoots(roots){
    clear(rootsRow);
    if(!roots.length) return;
    for(const r of roots){
      rootsRow.append(h("button", { class:"btn btn--sm" + (state.path === r.path || state.path.startsWith(r.path.replace(/\/+$/, "") + "/") ? " btn--primary" : ""),
        onclick:() => go(r.path) }, "💽 " + (r.name || r.path)));
    }
  }
  function drawCrumbs(d){
    clear(crumbs);
    crumbs.append(h("button", { class:"btn btn--ghost btn--sm", onclick:() => go(d.roots?.[0]?.path || "/") }, "🏠"));
    const match = (d.roots || []).filter(r => state.path === r.path || state.path.startsWith(r.path.replace(/\/+$/, "") + "/"))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if(!match) return;
    let acc = match.path.replace(/\/+$/, "");
    const parts = [{ name:match.name || match.path, path:match.path }];
    for(const part of state.path.slice(match.path.replace(/\/+$/, "").length).split("/").filter(Boolean)){
      acc += "/" + part; parts.push({ name:part, path:acc });
    }
    parts.forEach((p, i) => {
      if(i) crumbs.append(h("span", { class:"muted" }, "/"));
      crumbs.append(i === parts.length - 1
        ? h("b", { style:"font-size:13px;padding:4px 6px" }, p.name)
        : h("button", { class:"btn btn--ghost btn--sm", onclick:() => go(p.path) }, p.name));
    });
  }
  function drawEntries(){
    const d = state.data; if(!d) return;
    const entries = d.entries || [];
    selCount.textContent = state.selection.size;
    const hasSel = state.selection.size > 0;
    batchBar.style.display = hasSel ? "flex" : "none";
    if(!entries.length){
      content.replaceChildren(h("div", { class:"empty" },
        h("div", { class:"big" }, state.q ? "🔍" : "📂"),
        state.q ? "没有匹配的文件" : "这个文件夹是空的"));
      return;
    }
    content.replaceChildren(state.view === "list" ? drawList(entries) : drawGrid(entries));
  }
  function drawList(entries){
    const list = h("div", { class:"card", style:"padding:0;overflow:hidden" });
    for(const e of entries){
      const sel = state.selection.has(e.path);
      const cut = state.clipboard?.mode === "cut" && state.clipboard.items.some(it => it.path === e.path);
      list.append(h("div", { class:"list__row", style:"cursor:pointer" +
          (sel ? ";background:var(--accent-soft)" : "") + (cut ? ";opacity:.5" : ""),
          onclick:event => { if(event.target.tagName !== "INPUT" && !event.target.closest("button")) activate(e); } },
        h("input", { type:"checkbox", class:"chk", checked:sel,
          onchange:event => { event.target.checked ? state.selection.add(e.path) : state.selection.delete(e.path); drawEntries(); },
          onclick:event => event.stopPropagation() }),
        h("span", { class:"list__ico" }, kindIcon(e)),
        h("div", { class:"list__main" },
          h("div", { class:"list__title" }, e.name),
          h("div", { class:"list__meta" },
            (e.type === "directory" ? "文件夹" : formatBytes(e.sizeBytes)) + " · " + formatDateTime(e.modifiedAt))),
        h("button", { class:"btn btn--ghost btn--sm", title:"操作",
          onclick:event => { event.stopPropagation(); entryMenu(e); } }, "⋯")));
    }
    return list;
  }
  function drawGrid(entries){
    const grid = h("div", { style:"display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:10px" });
    for(const e of entries){
      const sel = state.selection.has(e.path);
      grid.append(h("div", { style:"background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px 8px;" +
          "text-align:center;cursor:pointer;position:relative" + (sel ? ";border-color:var(--accent);background:var(--accent-soft)" : ""),
          onclick:event => { if(event.target.tagName !== "INPUT") activate(e); } },
        h("input", { type:"checkbox", class:"chk", checked:sel,
          style:"position:absolute;top:6px;left:6px;width:16px;height:16px;accent-color:var(--accent)",
          onchange:event => { event.target.checked ? state.selection.add(e.path) : state.selection.delete(e.path); drawEntries(); },
          onclick:event => event.stopPropagation() }),
        h("div", { style:"height:56px;display:grid;place-items:center;font-size:30px" }, kindIcon(e)),
        h("div", { style:"font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, e.name),
        h("div", { style:"font-size:11px;color:var(--text-faint)" }, e.type === "directory" ? "文件夹" : formatBytes(e.sizeBytes))));
    }
    return grid;
  }
  function setView(v){
    state.view = v;
    try{ localStorage.setItem("ui2.files.view", v); }catch{}
    viewSeg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
    drawEntries();
  }
  function activate(e){
    if(e.type === "directory") go(e.path);
    else previewModal(e);
  }

  /* ---------------- 单项操作 ---------------- */
  function entryMenu(e){
    const actions = [];
    if(e.type === "file"){
      actions.push(["预览", () => previewModal(e)]);
      actions.push(["下载", () => { location.href = routeUrl("fileDownload", { query:{ path:e.path } }); }]);
      actions.push(["SHA-256 校验和", () => checksumModal(e)]);
    }
    actions.push(["重命名", () => renameModal(e)]);
    actions.push(["移动到…", () => moveModal([e])]);
    actions.push(["删除", () => deleteConfirm([e]), "btn--danger"]);
    const close = openModal(e.name,
      h("div", { style:"display:grid;gap:8px" },
        actions.map(([label, run, cls]) => h("button", { class:"btn" + (cls ? " " + cls : ""),
          style:"justify-content:flex-start", onclick:() => { close(); run(); } }, label))),
      [{ label:"关闭", onClick:c => c() }]);
  }
  function renameModal(e){
    const input = h("input", { class:"input", value:e.name, maxlength:255 });
    const close = openModal("重命名",
      h("div", { class:"field" }, h("label", { class:"field__label" }, "新名称"), input,
        h("p", { class:"field__hint" }, "同名冲突会被拒绝。")),
      [{ label:"取消", onClick:c => c() },
       { label:"保存", cls:"btn--primary", onClick:async c => {
          const name = input.value.trim();
          if(!name || name === e.name){ c(); return; }
          try{ await callJson("fileOperation", { body:{ action:"rename", path:e.path, name } });
            toast("已重命名", "ok"); c(); load(state.offset);
          }catch(error){ toast(error.message, "err"); }
       } }]);
    input.addEventListener("keydown", ev => { if(ev.key === "Enter") input.closest(".modal__panel").querySelector(".btn--primary").click(); });
  }
  async function checksumModal(e){
    try{
      const r = await callJson("fileChecksum", { query:{ path:e.path } });
      openModal("SHA-256 · " + e.name,
        h("pre", { class:"code", style:"word-break:break-all" }, r.sha256 || r.checksum || JSON.stringify(r)),
        [{ label:"复制", cls:"btn--primary", onClick:c => { navigator.clipboard?.writeText(r.sha256 || r.checksum || ""); c(); toast("已复制", "ok"); } },
         { label:"关闭", onClick:c => c() }]);
    }catch(error){ toast(error.message, "err"); }
  }

  /* ---------------- 批量改名（服务端 plan/apply） ---------------- */
  function batchRenameModal(sel){
    if(!sel.length) return;
    const mode = h("select", { class:"select" },
      h("option", { value:"serial" }, "序号：名称-001"),
      h("option", { value:"add" }, "添加前后缀"),
      h("option", { value:"replace" }, "查找替换"),
      h("option", { value:"normalize" }, "规范化（小写/空格）"));
    const row = h("div", { class:"field" });
    const previewBox = h("pre", { class:"code", style:"max-height:170px" }, "…");
    function rule(){
      if(mode.value === "serial") return { mode:"serial", start:1, step:1, width:3, separator:"-", keepExtension:true };
      if(mode.value === "add"){
        const [prefix, suffix] = row.querySelectorAll("input");
        return { mode:"add", prefix:prefix.value, suffix:suffix.value };
      }
      if(mode.value === "replace"){
        const [find, replaceTo] = row.querySelectorAll("input");
        return { mode:"replace", find:find.value, replace:replaceTo.value, caseSensitive:false };
      }
      return { mode:"normalize", lowercase:true, spacesTo:"-", trim:true };
    }
    function buildRow(){
      clear(row);
      if(mode.value === "add"){
        row.append(h("label", { class:"field__label" }, "前缀 / 后缀"),
          h("div", { class:"row", style:"gap:8px" },
            h("input", { class:"input", placeholder:"前缀", oninput:refresh }), 
            h("input", { class:"input", placeholder:"后缀", oninput:refresh })));
      }else if(mode.value === "replace"){
        row.append(h("label", { class:"field__label" }, "查找 / 替换为"),
          h("div", { class:"row", style:"gap:8px" },
            h("input", { class:"input", placeholder:"查找", oninput:refresh }),
            h("input", { class:"input", placeholder:"替换为", oninput:refresh })));
      }else{
        row.append(h("p", { class:"field__hint" },
          mode.value === "serial" ? "生成「原名-001」样式；保留扩展名。" : "转小写、空格转连字符、去首尾空白。"));
      }
    }
    async function refresh(){
      previewBox.textContent = "规划中…";
      try{
        const plan = await callJson("fileRenamePlan", { body:{ entries:sel.map(e => ({ name:e.name, path:e.path,
          kind:e.type === "file" ? "file" : "directory" })), rule:rule() } });
        previewBox.textContent = (plan.plan || []).map(it => (it.from || "").split("/").pop() + "  →  " + (it.to || "").split("/").pop())
          .join("\n") + (plan.summary ? "\n共 " + plan.summary.planned + " 项" + (plan.summary.conflicts ? " · 冲突 " + plan.summary.conflicts : "") : "") +
          (plan.errors?.length ? "\n错误：" + plan.errors.map(x => x.message).join("；") : "");
      }catch(error){ previewBox.textContent = "规划失败：" + error.message; }
    }
    mode.addEventListener("change", () => { buildRow(); refresh(); });
    buildRow(); refresh();
    openModal("批量重命名（" + sel.length + " 项）",
      h("div", null,
        h("div", { class:"field" }, h("label", { class:"field__label" }, "模式"), mode),
        row, previewBox,
        h("p", { class:"field__hint" }, "先由服务端生成计划并检查冲突，确认后一次性应用。")),
      [{ label:"取消", onClick:c => c() },
       { label:"应用", cls:"btn--primary", onClick:async c => {
          try{
            const r = await callJson("fileRenameApply", { body:{ entries:sel.map(e => ({ name:e.name, path:e.path,
              kind:e.type === "file" ? "file" : "directory" })), rule:rule(), confirm:true } });
            toast("已重命名 " + (r.summary?.planned ?? sel.length) + " 项", "ok");
            c(); state.selection.clear(); load(state.offset);
          }catch(error){ toast(error.message, "err"); }
       } }]);
  }

  /* ---------------- 移动（文件夹选择器） ---------------- */
  function moveModal(sel){
    if(!sel.length) return;
    let cur = state.path;
    const crumbsEl = h("div", { class:"row", style:"flex-wrap:wrap;gap:2px;margin-bottom:8px" });
    const listEl = h("div", { class:"card", style:"margin:0;max-height:280px;overflow:auto" });
    function canDrop(dest){
      if(dest === state.path) return "不能移动到当前目录";
      for(const e of sel){
        if(e.type !== "directory") continue;
        const base = e.path.replace(/\/+$/, "");
        if(dest === base || dest.startsWith(base + "/")) return "不能移动到其自身子目录";
      }
      return null;
    }
    async function drawPicker(){
      clear(crumbsEl);
      crumbsEl.append(h("button", { class:"btn btn--ghost btn--sm", onclick:() => { cur = "/"; drawPicker(); } }, "🏠"));
      cur.split("/").filter(Boolean).forEach((p, i, all) => {
        const target = "/" + all.slice(0, i + 1).join("/");
        crumbsEl.append(h("span", { class:"muted" }, "/"),
          h("button", { class:"btn btn--ghost btn--sm", onclick:() => { cur = target; drawPicker(); } }, p));
      });
      listEl.replaceChildren(h("div", { class:"empty", style:"padding:18px" }, "…"));
      try{
        const data = await callJson("filesList", { query:{ path:cur, type:"directory", limit:100, sort:"name-asc" } });
        clear(listEl);
        for(const dir of data.entries || []){
          if(sel.some(e => e.path === dir.path)) continue;
          const dest = dir.path;
          const why = canDrop(dest);
          listEl.append(h("div", { class:"list__row", style:"cursor:pointer" + (why ? ";opacity:.4" : ""),
              onclick:() => { if(why){ toast(why, "err"); return; } cur = dest; drawPicker(); } },
            h("span", { class:"list__ico" }, "📁"), h("div", { class:"list__main" }, h("div", { class:"list__title" }, dir.name))));
        }
        if(!listEl.childElementCount) listEl.append(h("p", { class:"muted", style:"padding:12px" }, "（无子文件夹）"));
      }catch(error){ listEl.replaceChildren(h("p", { class:"muted", style:"padding:12px" }, error.message)); }
    }
    drawPicker();
    openModal("移动 " + sel.length + " 项到…",
      h("div", null, crumbsEl, listEl, h("p", { class:"field__hint" }, "点击文件夹进入；确认后移动到当前所在目录。")),
      [{ label:"取消", onClick:c => c() },
       { label:"移动到此处", cls:"btn--primary", onClick:async c => {
          const why = canDrop(cur);
          if(why){ toast(why, "err"); return; }
          let ok = 0;
          for(const e of sel){
            try{ await callJson("fileOperation", { body:{ action:"move", path:e.path, destination:cur } }); ok++; }
            catch(error){ toast(error.message, "err"); break; }
          }
          if(ok){ toast("已移动 " + ok + " 项", "ok"); }
          if(state.clipboard?.mode === "cut") state.clipboard = null;
          c(); state.selection.clear(); syncClip(); load(state.offset);
       } }]);
  }

  /* ---------------- 删除（服务端一次性审批） ---------------- */
  async function deleteConfirm(sel){
    if(!sel.length) return;
    confirmModal("删除确认",
      "即将删除以下 " + sel.length + " 项：\n" + sel.slice(0, 6).map(e => "· " + e.name).join("\n") +
      (sel.length > 6 ? "\n… 等" : "") + "\n\n删除会进入服务端一次性确认流程。", "删除", async () => {
        for(const e of sel){
          try{
            const r = await callJson("fileOperation", { body:{ action:"delete", path:e.path } });
            if(r && r.approvalRequired) approvalModal(r.approval);
          }catch(error){ toast(error.message, "err"); break; }
        }
        state.selection.clear(); load(state.offset);
      });
  }
  function approvalModal(approval){
    if(!approval) return;
    openModal("⚠️ " + (approval.title || "危险操作") + " · 需要确认",
      h("div", null,
        h("div", { class:"banner banner--warn", style:"white-space:pre-line" },
          (approval.description || "此操作可能造成数据丢失。") + "\n目标：" + (approval.target || "") +
          "\n截止：" + formatDateTime(approval.expiresAt)),
        approval.args ? h("pre", { class:"code" }, JSON.stringify(approval.args, null, 2)) : null),
      [{ label:"拒绝", onClick:c => { callJson("actionDeny", { params:{ id:approval.id }, body:{} }).catch(() => {}); c(); } },
       { label:"确认执行", cls:"btn--danger", onClick:async c => {
          try{ await callJson("actionConfirm", { params:{ id:approval.id }, body:{} }); toast("已执行", "ok"); }
          catch(error){ toast(error.message, "err"); }
          c(); load(state.offset);
       } }]);
  }

  /* ---------------- 新建文件夹 / 上传 ---------------- */
  function mkdirModal(){
    const input = h("input", { class:"input", placeholder:"文件夹名称", maxlength:255 });
    const close = openModal("新建文件夹",
      h("div", { class:"field" }, h("label", { class:"field__label" }, "名称（创建于 " + (state.path || "存储卷") + "）"), input),
      [{ label:"取消", onClick:c => c() },
       { label:"创建", cls:"btn--primary", onClick:async c => {
          const name = input.value.trim(); if(!name) return;
          try{ await callJson("fileOperation", { body:{ action:"mkdir", path:state.path, name } });
            toast("已创建", "ok"); c(); load(state.offset);
          }catch(error){ toast(error.message, "err"); }
       } }]);
    input.addEventListener("keydown", ev => { if(ev.key === "Enter") input.closest(".modal__panel").querySelector(".btn--primary").click(); });
  }
  const uploadInput = h("input", { type:"file", multiple:true, hidden:true,
    onchange:event => { startUpload([...event.target.files]); event.target.value = ""; } });
  const uploadList = h("div");
  const uploadPanel = h("div", { style:"position:fixed;right:16px;bottom:calc(var(--tabbar-h) + 14px);z-index:45;width:min(88vw,320px);" +
      "background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);display:none" },
    h("div", { class:"row", style:"justify-content:space-between;padding:9px 13px;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)" },
      "上传任务", h("button", { class:"btn btn--ghost btn--sm", onclick:() => uploadPanel.style.display = "none" }, "收起")),
    uploadList);
  function startUpload(files){
    if(!files.length) return;
    uploadPanel.style.display = "block";
    for(const file of files){
      const bar = h("i", { style:"display:block;height:100%;width:0;background:var(--accent)" });
      const item = h("div", { style:"padding:9px 13px;border-bottom:1px solid var(--border);font-size:12px" },
        h("div", { style:"white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px" }, file.name + "（" + formatBytes(file.size) + "）"),
        h("div", { style:"height:5px;background:var(--surface-3);border-radius:3px;overflow:hidden" }, bar));
      uploadList.prepend(item);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", routeUrl("fileUpload", { query:{ path:state.path, name:file.name } }));
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.upload.addEventListener("progress", ev => { if(ev.lengthComputable) bar.style.width = Math.round(ev.loaded / ev.total * 100) + "%"; });
      xhr.addEventListener("load", () => {
        if(xhr.status >= 200 && xhr.status < 300){ item.style.color = "var(--ok)"; toast("上传完成：" + file.name, "ok"); }
        else{ item.style.color = "var(--danger)"; let msg = "上传失败"; try{ msg = JSON.parse(xhr.responseText).error || msg; }catch{} toast(file.name + "：" + msg, "err"); }
        if(state.path) load(state.offset);
      });
      xhr.addEventListener("error", () => { item.style.color = "var(--danger)"; toast(file.name + "：网络错误", "err"); });
      xhr.send(file);
    }
  }
  const dropzone = h("div", { style:"position:fixed;inset:0;z-index:80;display:none;place-items:center;" +
      "background:color-mix(in srgb,var(--accent) 12%,transparent);border:3px dashed var(--accent);pointer-events:none" },
    h("span", { style:"background:var(--surface);padding:14px 26px;border-radius:14px;font-weight:600" }, "松开鼠标，上传到当前目录"));
  let dragDepth = 0;
  window.addEventListener("dragenter", () => { dragDepth++; dropzone.style.display = "grid"; });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("dragleave", () => { if(--dragDepth <= 0){ dragDepth = 0; dropzone.style.display = "none"; } });
  window.addEventListener("drop", e => {
    e.preventDefault(); dragDepth = 0; dropzone.style.display = "none";
    if(e.dataTransfer?.files?.length) startUpload([...e.dataTransfer.files]);
  });

  /* ---------------- 预览 ---------------- */
  async function previewModal(e){
    const body = h("div", null, h("p", { class:"muted" }, "读取中…"));
    const dl = h("a", { class:"btn btn--primary btn--sm", href:routeUrl("fileDownload", { query:{ path:e.path } }) }, "⬇ 下载");
    const close = openModal(e.name, h("div", null,
      h("dl", { class:"kv", style:"margin-bottom:10px" },
        h("dt", null, "大小"), h("dd", null, formatBytes(e.sizeBytes)),
        h("dt", null, "修改时间"), h("dd", null, formatDateTime(e.modifiedAt)),
        h("dt", null, "路径"), h("dd", null, e.path)),
      h("div", { class:"row", style:"gap:8px;margin-bottom:10px" }, dl,
        h("button", { class:"btn btn--sm", onclick:() => checksumModal(e) }, "#️⃣ 校验和")),
      body), [{ label:"关闭", onClick:c => c() }]);
    try{
      const r = await callJson("filePreview", { query:{ path:e.path } });
      body.replaceChildren(
        typeof r.content === "string" && r.content
          ? h("pre", { class:"code", style:"max-height:320px" }, r.content.slice(0, 20000))
          : h("div", { class:"banner banner--info" }, "二进制或受限文件不支持文本预览，可下载后查看。"));
    }catch(error){
      body.replaceChildren(h("div", { class:"banner banner--warn" }, error.message));
    }
  }

  /* ---------------- 剪贴板 ---------------- */
  function copySel(){
    const sel = selectedEntries(); if(!sel.length) return;
    state.clipboard = { mode:"copy", items:sel.map(e => ({ path:e.path, name:e.name, type:e.type })) };
    syncClip(); toast("已复制 " + sel.length + " 项", "ok");
  }
  function cutSel(){
    const sel = selectedEntries(); if(!sel.length) return;
    state.clipboard = { mode:"cut", items:sel.map(e => ({ path:e.path, name:e.name, type:e.type })) };
    syncClip(); drawEntries(); toast("已剪切 " + sel.length + " 项，去目标目录粘贴", "ok");
  }
  async function paste(){
    const clip = state.clipboard; if(!clip) return;
    if(clip.mode === "copy" && !COPY_SUPPORTED){ toast("服务端暂不支持复制语义（仅移动）；该能力已登记后续阶段", "err"); return; }
    let ok = 0;
    for(const it of clip.items){
      if(clip.mode === "cut" && parentOf(it.path) === state.path) continue;
      try{
        if(clip.mode === "cut"){
          await callJson("fileOperation", { body:{ action:"move", path:it.path, destination:state.path } });
          ok++;
        }
      }catch(error){ toast(error.message, "err"); break; }
    }
    if(ok){ toast("已移入 " + ok + " 项", "ok"); if(clip.mode === "cut") state.clipboard = null; }
    syncClip(); load(state.offset);
  }

  /* ---------------- 快捷键 ---------------- */
  const onKeyDown = event => {
    if(document.getElementById("modal-host").classList.contains("open")) return;
    if(storeRoute() !== "files") return;
    const t = event.target;
    if(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if(!(event.ctrlKey || event.metaKey)) return;
    const k = event.key.toLowerCase();
    if(k === "c" && state.selection.size){ event.preventDefault(); copySel(); }
    else if(k === "x" && state.selection.size){ event.preventDefault(); cutSel(); }
    else if(k === "v" && state.clipboard && !pasteBtn.disabled){ event.preventDefault(); paste(); }
  };
  window.addEventListener("keydown", onKeyDown, true);
  ctx.stop(() => window.removeEventListener("keydown", onKeyDown, true));
  function storeRoute(){ try{ return decodeURIComponent(location.hash.replace(/^#\/?/, "")).split("/")[0]; }catch{ return ""; } }

  /* ---------------- 工具栏事件 ---------------- */
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = searchInput.value.trim(); load(0); }, 250);
  });
  typeSel.addEventListener("change", () => { state.type = typeSel.value; load(0); });
  sortSel.addEventListener("change", () => { state.sort = sortSel.value; load(0); });

  /* ---------------- 组装 ---------------- */
  root.append(
    h("div", { class:"toolbar", style:"display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px" },
      crumbs,
      searchInput, typeSel, sortSel, viewSeg,
      h("button", { class:"btn btn--sm", onclick:mkdirModal }, "＋ 文件夹"),
      h("button", { class:"btn btn--primary btn--sm", onclick:() => uploadInput.click() }, "⬆ 上传"),
      pasteBtn),
    rootsRow, clipBar, metaRow, content, batchBar,
    uploadPanel, dropzone, uploadInput);
  load(0);
}
