/* pages/files.js —— 文件区。交互定稿见工作区原型 file-manager-ui.html
 * （列表/网格、多选批量、复制剪切粘贴、上传、预览）；UI-3 按该定稿整体接入。
 * UI-1 先给真实数据链路的浏览骨架。 */

import { h, clear } from "../h.js";
import { callJson } from "../api.js";
import { toast } from "../ui.js";
import { formatBytes, formatDateTime } from "../format.js";

const KIND_ICON = { image:"🖼️", video:"🎬", audio:"🎵", archive:"🗜️", code:"📄", doc:"📘", file:"📄" };

let currentPath = "/vol1";

export function render(root){
  const crumbs = h("nav", { class:"row", "aria-label":"目录路径", style:"flex-wrap:wrap;gap:2px" });
  const listCard = h("div", { class:"card" },
    h("div", { class:"card__head" },
      h("h2", { class:"card__title" }, "浏览"),
      h("span", { style:"flex:1" }),
      h("span", { class:"badge badge--info" }, "UI-3 接入完整操作")),
    h("div", { class:"card__body" },
      crumbs,
      h("div", { id:"file-rows", class:"list", style:"margin-top:8px" })));

  root.append(
    h("div", { class:"banner banner--info" },
      "交互定稿已完成：多选批量（重命名 / 移动 / 复制剪切粘贴 / 删除）、上传进度、预览抽屉。本骨架先跑通数据链路，UI-3 整体接入。"),
    listCard,
    h("div", { class:"row row--wrap", style:"gap:8px" },
      h("button", { class:"btn", onclick:() => toast("批量操作：UI-3 接入（定稿见原型）") }, "✏️ 批量重命名"),
      h("button", { class:"btn", onclick:() => toast("查重扫描：UI-3 接入") }, "🔍 重复文件"),
      h("button", { class:"btn", onclick:() => toast("上传：UI-3 接入") }, "⬆ 上传")));

  async function load(){
    clear(crumbs);
    const parts = currentPath.split("/").filter(Boolean);
    crumbs.append(h("button", { class:"btn btn--ghost btn--sm", onclick:() => go("/") }, "🏠 卷"));
    let acc = "";
    for(const [i, p] of parts.entries()){
      acc += "/" + p;
      const target = acc;
      crumbs.append(h("span", { class:"muted" }, "/"),
        h("button", { class:"btn btn--ghost btn--sm" + (i === parts.length - 1 ? "" : ""), onclick:() => go(target) }, p));
    }
    const rows = clear(document.getElementById("file-rows"));
    try{
      const data = await callJson("filesList", { query:{ path:currentPath, offset:0 } });
      const entries = data.entries || [];
      if(!entries.length){
        rows.append(h("div", { class:"empty" }, h("div", { class:"big" }, "📂"), "这个文件夹是空的"));
        return;
      }
      for(const e of entries){
        rows.append(h("div", { class:"list__row", style:"cursor:pointer",
            onclick:() => { if(e.type === "dir") go(join(currentPath, e.name)); else toast("预览抽屉：UI-3 接入"); } },
          h("span", { class:"list__ico" }, e.type === "dir" ? "📁" : (KIND_ICON[e.kind] || "📄")),
          h("div", { class:"list__main" },
            h("div", { class:"list__title" }, e.name),
            h("div", { class:"list__meta" },
              (e.type === "dir" ? ((e.children ?? "") ? e.children + " 项" : "文件夹") : formatBytes(e.size)) +
              " · " + formatDateTime(e.mtime))),
          e.type === "file" ? h("span", { class:"badge" }, "文件") : null));
      }
    }catch(error){ toast(error.message, "err"); }
  }
  function go(path){ currentPath = path; load(); }
  load();
}
function join(base, name){ return (base === "/" ? "" : base) + "/" + name; }
