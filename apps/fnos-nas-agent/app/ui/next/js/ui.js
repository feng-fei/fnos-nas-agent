/* ui.js —— 轻量反馈层：toast / 模态 / 确认。全部 textContent 渲染。 */

import { h, clear } from "./h.js";

export function toast(message, kind){
  const host = document.getElementById("toast-host");
  if(!host) return;
  const t = h("div", { class:"toast" + (kind ? " toast--" + kind : ""), role:"status" }, message);
  host.append(t);
  setTimeout(() => t.remove(), 3200);
}

export function openModal(title, bodyEl, buttons){
  const host = document.getElementById("modal-host");
  if(!host) return () => {};
  clear(host);
  const close = () => { host.classList.remove("open"); clear(host); document.removeEventListener("keydown", onKey, true); };
  const onKey = event => { if(event.key === "Escape"){ event.preventDefault(); close(); } };
  host.append(
    h("div", { class:"modal", onclick:event => { if(event.target.classList.contains("modal")) close(); } },
      h("div", { class:"modal__panel", role:"dialog", "aria-label":title },
        h("div", { class:"modal__head" }, title),
        h("div", { class:"modal__body" }, bodyEl),
        h("div", { class:"modal__foot" },
          (buttons || []).map(b => h("button", { class:"btn " + (b.cls || ""), onclick:() => b.onClick(close) }, b.label))))));
  host.classList.add("open");
  document.addEventListener("keydown", onKey, true);
  const first = bodyEl.querySelector && bodyEl.querySelector("input,textarea,select,button.btn");
  if(first) first.focus();
  return close;
}

export function confirmModal(title, message, okLabel, onOk){
  openModal(title,
    h("div", { class:"banner banner--warn", style:"white-space:pre-line;margin:0" }, message),
    [{ label:"取消", onClick:close => close() },
     { label:okLabel || "确认", cls:"btn--danger", onClick:close => { close(); onOk(); } }]);
}

export function spinnerCard(text){
  return h("div", { class:"empty" }, h("div", { class:"big" }, "⏳"), text || "加载中…");
}
