/* ==================================================================
 * core.js —— fnOS NAS Agent 前端核心层
 *
 * 职责：
 *   1) 输出格式化工具（formatBytes / formatDurationSeconds / formatDurationMs /
 *      formatDateTime / formatDisplayValue / formatOutputJson）；
 *   2) API 客户端（api）与概览诊断刷新（refresh）；
 *   3) 会话、登录、设置与登出；
 *   4) 页面路由（hash -> .page）、导航高亮、底部“更多”抽屉；
 *   5) 轻量反馈层：showToast(message, kind) 与 confirmAction(message)。
 *
 * 加载顺序：index.html 以传统 <script> 依次加载 core.js → pages.js，
 *          core.js 必须先执行（pages.js 的 bootstrap 依赖本文件的能力）。
 *
 * 约定：core.js 与 pages.js 都是传统 script（不是 ES module），共享同一个
 *      全局词法作用域，顶层 const / let / function 在两个文件之间互相可见；
 *      请勿使用 import / export，也不要重复声明对方的顶层标识符。
 * ================================================================== */

/* Output formatting helpers: readable units for measurements returned by the API. */
const DISPLAY_BYTE_UNITS=["B","KB","MB","GB","TB","PB"];
function formatBytes(value){
 if(value===null||value===undefined||value===""||!Number.isFinite(Number(value)))return "—";
 const bytes=Number(value);if(bytes===0)return "0 B";
 let amount=Math.abs(bytes),unitIndex=0;
 while(amount>=1024&&unitIndex<DISPLAY_BYTE_UNITS.length-1){amount/=1024;unitIndex++;}
 amount=bytes/(1024**unitIndex);
 const digits=unitIndex===0?0:amount>=100?0:amount>=10?1:2;
 return new Intl.NumberFormat("zh-CN",{maximumFractionDigits:digits}).format(amount)+" "+DISPLAY_BYTE_UNITS[unitIndex];
}
function formatDurationSeconds(value){
 if(value===null||value===undefined||!Number.isFinite(Number(value)))return "—";
 const seconds=Math.max(0,Math.floor(Number(value)));
 if(seconds<60)return seconds+" 秒";
 const days=Math.floor(seconds/86400),minutes=Math.floor(seconds%3600/60),remaining=seconds%60;
 if(days){const hours=Math.floor(seconds%86400/3600);return days+" 天"+(hours?" "+hours+" 小时":"");}
 if(seconds>=3600)return Math.floor(seconds/3600)+" 小时"+(minutes?" "+minutes+" 分":"");
 return Math.floor(seconds/60)+" 分"+(remaining?" "+remaining+" 秒":"");
}
function formatDurationMs(value){
 if(value===null||value===undefined||!Number.isFinite(Number(value)))return "—";
 const milliseconds=Math.max(0,Number(value));
 if(milliseconds<1000)return Math.round(milliseconds)+" ms";
 if(milliseconds<60000)return new Intl.NumberFormat("zh-CN",{maximumFractionDigits:2}).format(milliseconds/1000)+" 秒";
 return formatDurationSeconds(milliseconds/1000);
}
function formatDateTime(value){
 if(value===null||value===undefined||value==="")return "—";
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return String(value);
 return new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(date);
}
function formatDisplayValue(value,key=""){
 if(Array.isArray(value))return value.map(item=>formatDisplayValue(item,key));
 if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([childKey,childValue])=>[childKey,formatDisplayValue(childValue,childKey)]));
 if(typeof value==="number"){
  if(/(?:bytes?|BytesScanned)$/i.test(key))return formatBytes(value);
  if(/(?:duration|elapsed|latency|responseTime|requestTime)Ms$/i.test(key))return formatDurationMs(value);
  if(/(?:uptime|duration|elapsed|runtime)Seconds$/i.test(key))return formatDurationSeconds(value);
  if(/(?:percent|percentage|progress)$/i.test(key))return new Intl.NumberFormat("zh-CN",{maximumFractionDigits:1}).format(value)+"%";
  if(/bytesPerSecond|bytesPerSec$/i.test(key))return formatBytes(value)+"/s";
 }
 if(typeof value==="string"){
  if(/(?:At|Date|Timestamp)$/i.test(key)&&/^\d{4}-\d{2}-\d{2}(?:T|\s)/.test(value))return formatDateTime(value);
  if(/^(?:stdout|stderr|output|rawOutput|responseText)$/i.test(key)&&/^\s*[\[{]/.test(value)){try{return formatDisplayValue(JSON.parse(value),key);}catch{}}
 }
 return value;
}
function formatOutputJson(value){
 let parsed=value;
 if(typeof value==="string"){
  const trimmed=value.trim();
  if(trimmed.startsWith("{")||trimmed.startsWith("[")){try{parsed=JSON.parse(value);}catch{return value;}}
  else return value;
 }
 return JSON.stringify(formatDisplayValue(parsed),null,2);
}

const setupCard=document.querySelector("#setup-card"),loginCard=document.querySelector("#login-card"),statusCard=document.querySelector("#status-card"),errorEl=document.querySelector("#login-error"),tokenEl=document.querySelector("#token"),newTokenEl=document.querySelector("#new-token");

/* 外壳 DOM 引用（静态应用外壳已提供这些节点，无需运行时创建） */
const pagePanelEl=document.querySelector("#page-panel");
const pageHeadingEl=document.querySelector("#page-heading");
const navRailEl=document.querySelector("#nav-rail");
const tabbarEl=document.querySelector("#tabbar");
const moreDrawerEl=document.querySelector("#more-drawer");
const moreDrawerCloseEl=document.querySelector("#more-drawer-close");
const tabbarMoreEl=document.querySelector("#tabbar-more");
const toastHostEl=document.querySelector("#toast-host");
const modalHostEl=document.querySelector("#modal-host");
const refreshButtonEl=document.querySelector("#refresh");
const logoutButtonEl=document.querySelector("#logout");

async function api(path,options={}){return fetch(path,{cache:"no-store",credentials:"same-origin",...options});}

async function refresh(){const s=document.querySelector("#status"),d=document.querySelector("#detail"),out=document.querySelector("#diagnostics");try{const r=await api("/api/health");if(!r.ok)throw Error();const h=await r.json();s.textContent=h.ok?"运行正常":"状态异常";d.textContent="版本 "+h.version+"；任意系统命令执行："+(h.executionEnabled?"已启用":"关闭")+"；已登记的常规文件工具可用。";const modeEl=document.querySelector("#execution-mode"),modeStatus=document.querySelector("#execution-mode-status");if(modeEl&&h.executionMode){modeEl.value=h.executionMode;if(modeStatus)modeStatus.textContent="当前执行模式："+({normal:"正常","read-only":"只读",halted:"停机"}[h.executionMode]||h.executionMode)+"（来源："+(h.executionModeSource||"default")+"）。";}const dr=await api("/api/diagnostics");if(!dr.ok)throw Error("诊断读取失败（HTTP "+dr.status+"）");const x=await dr.json();const gib=formatBytes;out.textContent=["系统："+x.system.platform+" "+x.system.release+" / "+x.system.arch,"Node.js："+x.system.nodeVersion+"；运行时间："+formatDurationSeconds(x.system.uptimeSeconds),"CPU："+x.cpu.model+"（逻辑核心 "+x.cpu.logicalCores+"）；负载 "+x.cpu.loadAverage.map(n=>n.toFixed(2)).join(" / "),"内存：已用 "+gib(x.memory.usedBytes)+" / "+gib(x.memory.totalBytes)+"（可用 "+gib(x.memory.freeBytes)+"）","网络："+(x.network.flatMap(n=>n.addresses.map(a=>n.name+" "+a.address)).join("；")||"未发现非回环地址"),"存储："+x.storage.map(v=>v.available?v.label+" 已用 "+gib(v.usedBytes)+" / "+gib(v.totalBytes)+"（可用 "+gib(v.freeBytes)+"）":v.label+" 无法读取").join("；")].join("\n");}catch(e){out.textContent=e.message||"诊断信息暂不可用";if(!s.textContent)s.textContent="无法连接服务";}}

/* ------------------------------------------------------------------ *
 * 粘性头部高度：移动端头部会折行成两行，固定值会算错锚点余量，
 * 这里按实际高度写回 --header-h，页面滚动定位就不会被头部盖住。
 * ------------------------------------------------------------------ */
function syncHeaderHeight(){
  const header=document.getElementById("app-header");
  if(!header)return;
  const height=header.offsetHeight;
  if(height>0)document.documentElement.style.setProperty("--header-h",height+"px");
}
if(typeof ResizeObserver==="function"){
  const observer=new ResizeObserver(()=>{syncHeaderHeight();});
  observer.observe(document.body);
}
window.addEventListener("resize",syncHeaderHeight);
window.addEventListener("orientationchange",syncHeaderHeight);
syncHeaderHeight();

async function init(){try{syncHeaderHeight();const r=await api("/api/session");const x=await r.json();if(x.authenticated){showWorkspace();await refresh();await refreshOverviewStats();await refreshSkills();await refreshModelPresets();await refreshModels();await refreshTools();await refreshFiles();await refreshAgentStatus();await refreshRecentTasks();await refreshPendingActions();}else if(x.setupRequired){showSetupCard();if(x.setupCodeRequired){const codeEl=document.querySelector("#setup-code");if(codeEl){codeEl.required=true;codeEl.focus();}}}else{showAuth();}}catch{showAuth();}}

document.querySelector("#setup-form").addEventListener("submit",async e=>{e.preventDefault();document.querySelector("#setup-error").textContent="";try{const token=newTokenEl.value;const codeEl=document.querySelector("#setup-code");const body={password:token};if(codeEl&&codeEl.value.trim())body.code=codeEl.value.trim();const r=await api("/api/setup",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const x=await r.json();if(!r.ok)throw Error(x.error||"设置失败");tokenEl.value=token;showLoginCard();document.querySelector("#login-help").textContent="密码已设置，请登录。";newTokenEl.value="";if(codeEl)codeEl.value="";tokenEl.focus();}catch(e){document.querySelector("#setup-error").textContent=e.message||"设置失败";}});
document.querySelector("#login-form").addEventListener("submit",async e=>{e.preventDefault();errorEl.textContent="";try{const r=await api("/api/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:tokenEl.value,remember:document.querySelector("#remember").checked})});const x=await r.json();if(!r.ok)throw Error(x.error||"登录失败");tokenEl.value="";showWorkspace("status-card");await refresh();await refreshOverviewStats();await refreshSkills();await refreshModels();await refreshTools();await refreshFiles();await refreshAgentStatus();await refreshRecentTasks();}catch(e){errorEl.textContent=e.message||"登录失败";}});

/* ------------------------------------------------------------------ *
 * 认证卡片显隐：新外壳用 hidden 属性 + .hidden 双重隐藏浮层。
 * ------------------------------------------------------------------ */
function setAuthCardVisible(card,visible){
  if(!card)return;
  card.classList.toggle("hidden",!visible);
  card.hidden=!visible;
}
function hideWorkspacePages(){
  for(const [pageId] of workspacePages){
    const el=document.getElementById(pageId);
    if(el){el.classList.add("hidden");el.hidden=true;}
  }
}
function showSetupCard(){
  hideWorkspacePages();
  setAuthCardVisible(setupCard,true);
  setAuthCardVisible(loginCard,false);
}
function showLoginCard(){
  hideWorkspacePages();
  setAuthCardVisible(loginCard,true);
  setAuthCardVisible(setupCard,false);
}


/* ------------------------------------------------------------------ *
 * 页面路由：hash -> .page。旧的 buildWorkspaceLayout() 已删除，
 * 顶栏 / 导航 / 底部标签栏 / 各 section 均由静态外壳提供。
 * ------------------------------------------------------------------ */
const workspacePages=[["status-card","运行概览"],["files-card","文件管理"],["agent-card","智能助手"],["tools-card","NAS 工具"],["models-card","模型服务"],["skills-card","Skill 管理"],["audit-card","操作审计"],["security-note","安全说明"]];
function pageTitleFor(pageId,label){
  const el=document.getElementById(pageId);
  const title=el&&el.getAttribute("data-title");
  if(title)return title;
  const heading=el&&el.querySelector("h2.page__title");
  if(heading&&heading.textContent.trim())return heading.textContent.trim();
  return label;
}
function currentRouteId(){
  let id="status-card";
  try{id=decodeURIComponent(location.hash.slice(1))||"status-card";}catch{id="status-card";}
  return workspacePages.some(([pageId])=>pageId===id)?id:"status-card";
}
function applyRoute(requestedId,updateHistory=true){
  const id=workspacePages.some(([pageId])=>pageId===requestedId)?requestedId:"status-card";
  for(const [pageId,label] of workspacePages){
    const el=document.getElementById(pageId);
    if(el){el.classList.toggle("hidden",pageId!==id);el.hidden=pageId!==id;el.classList.toggle("active-page",pageId===id);}
    const links=document.querySelectorAll('.nav-rail__link[data-page="'+pageId+'"],.tabbar__link[data-page="'+pageId+'"]');
    for(const link of links){if(pageId===id)link.classList.add("is-active");else link.classList.remove("is-active");}
    if(pageId===id&&pageHeadingEl)pageHeadingEl.textContent=pageTitleFor(pageId,label);
  }
  if(updateHistory&&location.hash!=="#"+id)history.pushState(null,"","#"+id);
}
function showWorkspace(requestedId){
  document.body.classList.add("authenticated");document.body.classList.remove("auth-screen");
  const login=document.querySelector("#login-card"),setup=document.querySelector("#setup-card");
  if(login)setAuthCardVisible(login,false);if(setup)setAuthCardVisible(setup,false);
  // 保留旧的外壳揭示契约：认证后的功能卡片先全部显示，再由路由统一隐藏非当前页。
  document.querySelector("#status-card").classList.remove("hidden");
  document.querySelector("#models-card").classList.remove("hidden");
  document.querySelector("#files-card").classList.remove("hidden");
  document.querySelector("#tools-card").classList.remove("hidden");
  document.querySelector("#agent-card").classList.remove("hidden");
  document.querySelector("#skills-card").classList.remove("hidden");
  let target=requestedId;if(!target){try{target=decodeURIComponent(location.hash.slice(1));}catch{target="status-card";}}
  applyRoute(target||"status-card",false);
}
function showAuth(){
  document.body.classList.remove("authenticated");document.body.classList.add("auth-screen");
  showLoginCard();
  history.replaceState(null,"",location.pathname+location.search);
}
window.addEventListener("hashchange",()=>{
  if(!document.body.classList.contains("authenticated"))return;
  applyRoute(currentRouteId(),false);
  refreshCurrentPage();
});
window.addEventListener("popstate",()=>{
  if(!document.body.classList.contains("authenticated"))return;
  applyRoute(currentRouteId(),false);
  refreshCurrentPage();
});


/* ------------------------------------------------------------------ *
 * 底部标签栏的“更多”抽屉。
 * ------------------------------------------------------------------ */
function openMoreDrawer(){
  const drawer=moreDrawerEl;if(!drawer)return;
  drawer.hidden=false;drawer.classList.remove("hidden");drawer.classList.add("is-open");
  if(tabbarMoreEl)tabbarMoreEl.setAttribute("aria-expanded","true");
  document.body.style.overflow="hidden";
}
function closeMoreDrawer(){
  const drawer=moreDrawerEl;if(!drawer)return;
  drawer.hidden=true;drawer.classList.add("hidden");drawer.classList.remove("is-open");
  if(tabbarMoreEl)tabbarMoreEl.setAttribute("aria-expanded","false");
  document.body.style.overflow="";
}
if(tabbarMoreEl)tabbarMoreEl.addEventListener("click",()=>{
  if(moreDrawerEl&&moreDrawerEl.classList.contains("is-open"))closeMoreDrawer();else openMoreDrawer();
});
if(moreDrawerCloseEl)moreDrawerCloseEl.addEventListener("click",closeMoreDrawer);
if(moreDrawerEl)moreDrawerEl.addEventListener("click",event=>{if(event.target===moreDrawerEl)closeMoreDrawer();});
document.querySelectorAll("#more-drawer [data-page]").forEach(link=>link.addEventListener("click",()=>{closeMoreDrawer();}));


/* ------------------------------------------------------------------ *
 * 轻量反馈层：toast 提示 + 本地确认弹窗。
 * 注意：服务端审批流（202 + 待确认的危险操作）不受这里影响。
 * ------------------------------------------------------------------ */
function showToast(message,kind){
  const host=toastHostEl;if(!host)return;
  const toast=document.createElement("div");
  toast.className="toast toast--"+(kind||"info");
  toast.setAttribute("role","status");
  toast.textContent=message===null||message===undefined?"":String(message);
  host.appendChild(toast);
  setTimeout(()=>{if(toast.parentNode)toast.parentNode.removeChild(toast);},3500);
}
/**
 * 服务端返回的错误文案是英文，界面是中文。
 * 这里把已知的服务端错误映射成中文，并保留原始英文作为细节。
 */
const SERVER_ERROR_MESSAGES=[
  ["Unauthorized","未登录或会话已过期，请重新登录。"],
  ["Forbidden origin","请求来源校验失败，请从本机控制台地址打开页面。"],
  ["Setup already completed","已经完成初始化设置。"],
  ["Setup code is invalid","安装码不正确，请查看 NAS 日志中的 first-run setup code。"],
  ["App data directory is not configured","尚未配置 Agent 私有数据目录（AGENT_DATA_DIR），请检查服务环境变量。"],
  ["File changed while opening; retry the operation","文件在读取过程中发生变化，请重试。"],
  ["Path is outside configured storage roots","路径不在允许的存储卷范围内。"],
  ["Symbolic links are not supported","不支持符号链接。"],
  ["Cannot delete a storage root","不能删除存储卷根目录。"],
  ["Explicit confirmation is required","需要显式确认才能执行该操作。"],
  ["The agent is halted by the kill switch; no operation is accepted.","Agent 已被紧急停机开关停止，不接受任何操作。"],
  ["The agent is in global read-only mode; this operation is not allowed.","Agent 处于全局只读模式，不允许该操作。"],
  ["A quarantined Skill archive is required to register a Skill","登记 Skill 前必须先把 ZIP 归档上传到隔离区。"],
  ["Skill name already registered","同名 Skill 已存在。"],
  ["A server-side static review is required before approving this Skill","该 Skill 缺少服务端静态审核结论，无法批准。"],
  ["The Skill was not reviewed by the server; re-import the archive before installing its CLI","该 Skill 未经过服务端审核，请重新导入归档后再安装官方 CLI。"],
  ["Official fnOS CLI binary entry is missing from the archive","归档中缺少官方 CLI 二进制条目。"],
  ["Unknown execution mode; expected one of normal, read-only, halted","未知的执行模式，仅支持 normal / read-only / halted。"],
  ["Too many tool runs","工具调用过于频繁，请稍后再试。"],
  ["Too many agent messages","消息发送过于频繁，请稍后再试。"],
  ["Too many overview requests","概览刷新过于频繁，请稍后再试。"],
  ["Too many requests","请求过于频繁，请稍后再试。"],
  ["Invalid audit route","审计事件类型不受支持。"],
  ["Invalid audit method","审计请求方法不受支持。"],
  ["Invalid audit status code","审计状态码不合法。"],
  ["Skill inventory could not be loaded safely","Skill 清单无法安全加载，已隔离损坏文件并以空清单启动。"],
  ["Unable to save Skill metadata securely","Skill 元数据无法安全保存。"],
  ["Secure Skill quarantine storage requires Linux directory descriptors","隔离区存储依赖 Linux 目录描述符，当前平台不可用。"],
  ["Secure file operations require Linux directory descriptors","文件操作依赖 Linux 目录描述符，当前平台不可用。"],
  ["Secure directory browsing requires Linux descriptor paths","目录浏览依赖 Linux 目录描述符，当前平台不可用。"],
  ["No model provider is configured","尚未配置模型服务商。"],
  ["Model settings could not be loaded safely","模型配置无法安全加载。"],
];
function localizeServerMessage(message){
  if(!message)return "";
  const text=String(message);
  for(const [needle,zh] of SERVER_ERROR_MESSAGES){
    if(text===needle)return zh;
    if(text.startsWith(needle+":")||text.startsWith(needle+" "))return zh+" "+text.slice(needle.length).trim();
  }
  return "";
}
function errorText(error,fallback){
  const head=fallback||"操作失败";
  const detail=error&&error.message?String(error.message):"";
  if(!detail||detail===head)return head;
  const zh=localizeServerMessage(detail);
  if(zh)return zh;
  if(/^[\x20-\x7e]+$/.test(detail))return head+"："+detail;
  return head;
}
function confirmAction(message){
  return new Promise(resolve=>{
    const host=modalHostEl;if(!host){resolve(false);return;}
    while(host.firstChild)host.removeChild(host.firstChild);
    const modal=document.createElement("div");modal.className="modal";
    const panel=document.createElement("div");panel.className="modal__panel";
    const head=document.createElement("div");head.className="modal__head";
    const title=document.createElement("h3");title.className="modal__title";title.textContent="请确认";
    head.appendChild(title);
    const body=document.createElement("div");body.className="modal__body";
    body.textContent=message===null||message===undefined?"":String(message);
    const foot=document.createElement("div");foot.className="modal__foot";
    const cancel=document.createElement("button");cancel.type="button";cancel.className="btn btn--ghost";cancel.textContent="取消";
    const confirm=document.createElement("button");confirm.type="button";confirm.className="btn btn--primary";confirm.textContent="确定";
    foot.appendChild(cancel);foot.appendChild(confirm);
    panel.appendChild(head);panel.appendChild(body);panel.appendChild(foot);
    modal.appendChild(panel);host.appendChild(modal);
    host.hidden=false;host.classList.remove("hidden");
    let settled=false;
    const onKey=event=>{if(event.key==="Escape"){event.preventDefault();finish(false);}};
    function finish(ok){
      if(settled)return;settled=true;
      document.removeEventListener("keydown",onKey,true);
      if(modal.parentNode)modal.parentNode.removeChild(modal);
      if(!host.children.length){host.hidden=true;host.classList.add("hidden");}
      resolve(ok);
    }
    cancel.addEventListener("click",()=>finish(false));
    confirm.addEventListener("click",()=>finish(true));
    modal.addEventListener("click",event=>{if(event.target===modal)finish(false);});
    document.addEventListener("keydown",onKey,true);
    confirm.focus();
  });
}
/**
 * 本地输入弹窗：替代浏览器原生 prompt()。
 * 取消 / Esc / 点击遮罩返回 null；确定返回输入框当前文本。
 */
function promptAction(message,defaultValue){
  return new Promise(resolve=>{
    const host=modalHostEl;if(!host){resolve(null);return;}
    while(host.firstChild)host.removeChild(host.firstChild);
    const modal=document.createElement("div");modal.className="modal";
    const panel=document.createElement("div");panel.className="modal__panel";
    const head=document.createElement("div");head.className="modal__head";
    const title=document.createElement("h3");title.className="modal__title";title.textContent="请输入";
    head.appendChild(title);
    const body=document.createElement("div");body.className="modal__body";
    const hint=document.createElement("p");hint.className="muted";hint.textContent=message===null||message===undefined?"":String(message);
    const input=document.createElement("input");input.type="text";input.className="input";input.maxLength=2048;
    input.value=defaultValue===null||defaultValue===undefined?"":String(defaultValue);
    body.appendChild(hint);body.appendChild(input);
    const foot=document.createElement("div");foot.className="modal__foot";
    const cancel=document.createElement("button");cancel.type="button";cancel.className="btn btn--ghost";cancel.textContent="取消";
    const ok=document.createElement("button");ok.type="button";ok.className="btn btn--primary";ok.textContent="确定";
    foot.appendChild(cancel);foot.appendChild(ok);
    panel.appendChild(head);panel.appendChild(body);panel.appendChild(foot);
    modal.appendChild(panel);host.appendChild(modal);
    host.hidden=false;host.classList.remove("hidden");
    let settled=false;
    const onKey=event=>{
      if(event.key==="Escape"){event.preventDefault();finish(null);}
      else if(event.key==="Enter"){event.preventDefault();finish(input.value);}
    };
    function finish(value){
      if(settled)return;settled=true;
      document.removeEventListener("keydown",onKey,true);
      if(modal.parentNode)modal.parentNode.removeChild(modal);
      if(!host.children.length){host.hidden=true;host.classList.add("hidden");}
      resolve(value);
    }
    cancel.addEventListener("click",()=>finish(null));
    ok.addEventListener("click",()=>finish(input.value));
    modal.addEventListener("click",event=>{if(event.target===modal)finish(null);});
    document.addEventListener("keydown",onKey,true);
    input.focus();
    if(typeof input.select==="function")input.select();
  });
}


/* ------------------------------------------------------------------ *
 * 顶栏与页面内动作按钮。
 * ------------------------------------------------------------------ */
async function logoutSession(){
  try{await api("/api/logout",{method:"POST"});}catch{}
  showAuth();
  if(tokenEl)tokenEl.focus();
}
if(refreshButtonEl)refreshButtonEl.addEventListener("click",()=>{refreshCurrentPage();});
document.querySelectorAll('[data-action="refresh"]').forEach(el=>el.addEventListener("click",()=>{refreshCurrentPage();}));
if(logoutButtonEl)logoutButtonEl.addEventListener("click",logoutSession);
document.querySelectorAll('[data-action="logout"]').forEach(el=>el.addEventListener("click",logoutSession));

/* 通用小工具 */
const renderTokens=new WeakMap();
function beginRender(node){const token=(renderTokens.get(node)||0)+1;renderTokens.set(node,token);return token;}
function renderIsCurrent(node,token){return renderTokens.get(node)===token;}
function debounce(fn,wait){
  let timer=null;
  return function(...args){
    if(timer)clearTimeout(timer);
    timer=setTimeout(()=>{timer=null;fn.apply(this,args);},wait);
  };
}
function setText(selector,value){
  const el=document.querySelector(selector);
  if(el)el.textContent=value===null||value===undefined?"":String(value);
  return el;
}
