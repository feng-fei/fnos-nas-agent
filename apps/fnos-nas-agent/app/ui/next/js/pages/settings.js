/* pages/settings.js —— 设置区：模型服务 / Skill 管理 / 知识库 / 安全边界。
 * UI-5 从旧 pages.js 与 model-settings.js、knowledge-*.js 迁移。 */

import { h } from "../h.js";
import { callJson } from "../api.js";
import { toast, openModal } from "../ui.js";

const GROUPS = [
  { id:"models",    icon:"🧠", title:"模型服务",    desc:"多服务商、连接测试、运行时切换、用量统计", route:"models* usage presets", status:"UI-5 迁移" },
  { id:"skills",    icon:"🧩", title:"Skill 管理",  desc:"上传隔离、审核状态机、批量流转、远程导入", route:"skills*", status:"UI-5 迁移" },
  { id:"knowledge", icon:"📚", title:"知识库",      desc:"条目、来源与时效、冲突、两步写入、通知", route:"knowledge*", status:"UI-5 迁移" },
  { id:"security",  icon:"🛡️", title:"安全边界",    desc:"执行模式（正常/只读/停机）、能力清单、安全检查", route:"execution-mode security/inspection capabilities", status:"UI-5 迁移" },
];

export function render(root){
  const list = h("div", { class:"stack" });
  for(const g of GROUPS){
    list.append(h("div", { class:"card" },
      h("div", { class:"card__head", style:"align-items:center" },
        h("span", { style:"font-size:22px" }, g.icon),
        h("div", { style:"flex:1;min-width:0" },
          h("h2", { class:"card__title" }, g.title),
          h("p", { class:"card__sub" }, g.desc)),
        h("span", { class:"badge badge--info" }, g.status)),
      h("div", { class:"card__foot" },
        h("code", { style:"font-size:11px;color:var(--text-faint)" }, g.route),
        h("span", { style:"flex:1" }),
        h("button", { class:"btn btn--sm", onclick:() => openDetail(g) }, "查看"))));
  }
  root.append(
    h("div", { class:"banner banner--info" },
      "设置区按“一组一卡”组织；进入每组后是独立的全功能页，不再共用旧 UI 的巨型表单。"),
    list);

  function openDetail(g){
    if(g.id === "models"){
      callJson("modelsList").then(data => {
        const providers = data?.providers || [];
        openModal("模型服务 · " + providers.length + " 个服务商",
          h("div", { class:"list" },
            providers.length ? providers.map(p =>
              h("div", { class:"list__row" },
                h("span", { class:"badge " + (p.isDefault ? "badge--ok" : "") }, p.isDefault ? "默认" : "备用"),
                h("div", { class:"list__main" },
                  h("div", { class:"list__title" }, p.name),
                  h("div", { class:"list__meta" }, p.model + " · " + (p.enabled ? "已启用" : "已停用") + (p.hasApiKey ? " · 密钥已存" : " · 无密钥")))))
            : h("p", { class:"muted" }, "尚未添加服务商。")),
          [{ label:"关闭", onClick:close => close() }]);
      }).catch(() => {});
    }else{
      callJson("sessionInfo").catch(() => {});
      toast(g.title + "：UI-5 迁移", "ok");
    }
  }
}
