/* router.js —— hash 路由：#/zone[/sub]。五区导航，唯一事实来源是 ZONES。 */

import { store } from "./store.js";

export const ZONES = [
  { id:"home",     title:"总览",     icon:"🏠", sub:"健康状态、容量与异常一览", subtabs:null },
  { id:"chat",     title:"对话",     icon:"💬", sub:"自然语言操作 NAS 的主入口", subtabs:null },
  { id:"files",    title:"文件",     icon:"📁", sub:"浏览、整理与传输", subtabs:null },
  { id:"system",   title:"系统",     icon:"🖥️", sub:"设备、网络、容器与运维", subtabs:null },
  { id:"settings", title:"设置",     icon:"⚙️", sub:"模型、Skill、知识库与安全", subtabs:null },
];

export function currentRoute(){
  let hash = "";
  try{ hash = decodeURIComponent(location.hash.replace(/^#\/?/, "")); }catch{ hash = ""; }
  const [zone, sub] = hash.split("/");
  const found = ZONES.find(z => z.id === zone);
  return { id: found ? found.id : "home", sub: sub || null, valid: Boolean(found) };
}

/* routes: { [zoneId]: { render(root, ctx) } }，ctx = { sub, stop(cb) } */
export function startRouter(routes, pageRoot){
  let disposables = [];
  function apply(){
    const route = currentRoute();
    store.route.set({ id:route.id, sub:route.sub });
    for(const stop of disposables) stop();
    disposables = [];
    const zone = ZONES.find(z => z.id === route.id);
    document.title = zone.title + " · fnos-nas-agent";
    document.querySelectorAll("[data-zone]").forEach(link =>
      link.classList.toggle("is-active", link.dataset.zone === route.id));
    const titleEl = document.getElementById("page-title");
    const subEl = document.getElementById("page-sub");
    if(titleEl) titleEl.textContent = zone.title;
    if(subEl) subEl.textContent = zone.sub;
    const impl = routes[route.id] || routes.home;
    pageRoot.replaceChildren();
    const ctx = { sub:route.sub, stop(fn){ disposables.push(fn); } };
    try{ impl.render(pageRoot, ctx); }
    catch(error){
      pageRoot.replaceChildren(Object.assign(document.createElement("div"),
        { className:"empty", textContent:"页面加载失败：" + error.message }));
    }
  }
  window.addEventListener("hashchange", apply);
  apply();
  return { navigate(id, sub){ location.hash = "#/" + id + (sub ? "/" + sub : ""); } };
}
