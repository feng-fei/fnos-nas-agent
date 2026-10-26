/* h.js —— DOM 构建助手。字符串子节点一律走 textContent，杜绝 HTML 注入面。
 * 用法：h("div", {class:"row", onclick:fn, dataset:{id:"1"}}, childA, [childB, "text"]) */

export function h(tag, props, ...children){
  const el = document.createElement(tag);
  if(props) for(const [k,v] of Object.entries(props)){
    if(v === false || v === null || v === undefined) continue;
    if(k === "class") el.className = v;
    else if(k === "dataset") Object.assign(el.dataset, v);
    else if(k === "style") el.style.cssText = v;
    else if(k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  appendChildren(el, children);
  return el;
}
function appendChildren(el, children){
  for(const c of children){
    if(c === null || c === undefined || c === false) continue;
    if(Array.isArray(c)) appendChildren(el, c);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}
export function clear(node){ node.replaceChildren(); return node; }
export const $id = id => document.getElementById(id);
