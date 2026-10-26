/* main.js —— 引导：会话检查 → 认证卡或工作台；渲染导航；绑定顶栏动作。 */

import { h, clear, $id } from "./h.js";
import { store, requestRefresh } from "./store.js";
import { callJson } from "./api.js";
import { toast } from "./ui.js";
import { ZONES, startRouter } from "./router.js";
import * as home from "./pages/home.js";
import * as chat from "./pages/chat.js";
import * as files from "./pages/files.js";
import * as system from "./pages/system.js";
import * as settings from "./pages/settings.js";

const PREVIEW = window.__UI_PREVIEW__ === true;
if(PREVIEW){
  const badge = $id("env-badge");
  badge.hidden = false;
  badge.textContent = "演示数据";
  $id("btn-logout").hidden = true;
}

/* ---------------- 导航渲染（桌面 rail + 移动 tabbar 共用 ZONES） ---------------- */
function renderNav(){
  const rail = $id("nav-rail");
  const tabbar = $id("tabbar");
  clear(rail).append(...ZONES.map(zone =>
    h("button", { class:"nav-rail__link", dataset:{ zone:zone.id }, onclick:() => location.hash = "#/" + zone.id },
      h("span", { class:"ico" }, zone.icon), h("span", null, zone.title))));
  clear(tabbar).append(...ZONES.map(zone =>
    h("button", { class:"tabbar__link", dataset:{ zone:zone.id }, onclick:() => location.hash = "#/" + zone.id },
      h("span", { class:"ico" }, zone.icon), h("span", null, zone.title))));
  const isDesktop = matchMedia("(min-width:1120px)").matches;
  $id("nav-toggle").hidden = isDesktop;
  tabbar.hidden = isDesktop;
}
const desktopMql = matchMedia("(min-width:1120px)");
if(typeof desktopMql.addEventListener === "function") desktopMql.addEventListener("change", renderNav);
else if(typeof desktopMql.addListener === "function") desktopMql.addListener(renderNav);
$id("nav-toggle").addEventListener("click", () => {
  const rail = $id("nav-rail");
  rail.classList.toggle("nav-rail--open");
});

/* ---------------- 会话状态机 ---------------- */
const authLayer = $id("auth-layer");
function showAuthCard(which){
  authLayer.hidden = false;
  $id("form-setup").hidden = which !== "setup";
  $id("form-login").hidden = which !== "login";
  $id("auth-loading").hidden = which !== "loading";
}
function hideAuthCard(){ authLayer.hidden = true; }

async function bootSession(){
  showAuthCard("loading");
  try{
    const session = await callJson("sessionInfo");
    if(PREVIEW || session.authenticated){
      const health = await callJson("health").catch(() => null);
      store.health.set(health);
      store.session.set({ state:"ready" });
    }else if(session.setupRequired){
      store.session.set({ state:"setup", setupCodeRequired:Boolean(session.setupCodeRequired) });
    }else{
      store.session.set({ state:"login" });
    }
  }catch(error){
    toast(error.message, "err");
    store.session.set({ state:"login" });
  }
}

store.session.sub(s => {
  if(s.state === "ready"){
    hideAuthCard();
    $id("btn-logout").hidden = PREVIEW;
  }else{
    $id("btn-logout").hidden = true;
    if(s.state === "setup"){
      showAuthCard("setup");
      $id("setup-code-field").hidden = !s.setupCodeRequired;
    }else if(s.state === "login"){
      showAuthCard("login");
    }
  }
});

$id("form-setup").addEventListener("submit", async event => {
  event.preventDefault();
  const errEl = $id("setup-error"); errEl.textContent = "";
  const password = $id("setup-password").value;
  if(password !== $id("setup-password2").value){ errEl.textContent = "两次输入的密码不一致"; return; }
  const body = { password };
  const code = $id("setup-code").value.trim();
  if(code) body.code = code;
  try{
    await callJson("setup", { body });
    toast("设置完成，请登录", "ok");
    store.session.set({ state:"login" });
  }catch(error){ errEl.textContent = error.message; }
});

$id("form-login").addEventListener("submit", async event => {
  event.preventDefault();
  const errEl = $id("login-error"); errEl.textContent = "";
  try{
    await callJson("login", { body:{ password:$id("login-password").value, remember:$id("login-remember").checked } });
    if(PREVIEW){ store.session.set({ state:"ready" }); return; }
    await bootSession();
  }catch(error){ errEl.textContent = error.message; }
});

$id("btn-logout").addEventListener("click", async () => {
  try{ await callJson("logout"); }catch{}
  store.session.set({ state:"login" });
  $id("login-password").value = "";
});

/* ---------------- 顶栏动作 ---------------- */
$id("btn-refresh").addEventListener("click", requestRefresh);
$id("btn-theme").addEventListener("click", () => {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const effectiveDark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark" : dark;
  document.documentElement.dataset.theme = effectiveDark ? "light" : "dark";
});

/* 快捷键：R 刷新当前页（非输入焦点时） */
window.addEventListener("keydown", event => {
  if(event.ctrlKey || event.metaKey || event.altKey) return;
  const t = event.target;
  if(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if($id("modal-host").classList.contains("open")) return;
  if(event.key === "r" || event.key === "R") requestRefresh();
});

/* ---------------- 路由挂载 ---------------- */
startRouter({
  home: home, chat: chat, files: files, system: system, settings: settings,
}, $id("page-root"));

renderNav();
bootSession();
/* 引导完成标记：诊断脚本据此区分"还在加载"与"模块没有执行"。 */
document.documentElement.setAttribute("data-ui2-boot", "ok");
