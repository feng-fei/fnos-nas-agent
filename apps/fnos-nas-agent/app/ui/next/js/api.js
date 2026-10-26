/* api.js —— 唯一 API 出入口。
 * 1) ROUTES：服务端全部静态/动态路由的命名映射（对账对象，phase-211 方法论沿用）；
 * 2) call(name,{params,query,body})：统一 fetch，返回 {ok,status,data}；
 * 3) PREVIEW 模式：无服务端环境（如静态预览）时回退到 MOCK，界面可独立演示。
 * 约定：页面模块一律 call("routeName")，禁止手写 "/api/..." 字符串（测试锁死）。 */

const PREVIEW = typeof window !== "undefined" && window.__UI_PREVIEW__ === true;

/* method + path（:name 为路径参数）。与服务端 server.mjs 的路由表一一对应。 */
const ROUTES = {
  /* 健康与会话 */
  health:            ["GET",  "/api/health"],
  sessionInfo:       ["GET",  "/api/session"],
  setup:             ["POST", "/api/setup"],
  login:             ["POST", "/api/session"],
  logout:            ["POST", "/api/logout"],
  executionMode:     ["POST", "/api/execution-mode"],
  executionModeGet:  ["GET",  "/api/execution-mode"],
  /* 概览与诊断 */
  overview:          ["GET",  "/api/overview"],
  diagnostics:       ["GET",  "/api/diagnostics"],
  diagnosticsReport: ["POST", "/api/diagnostics/report"],
  diagnosticsEvidence:   ["POST", "/api/diagnostics/evidence"],
  diagnosticsLogEvidence:["POST", "/api/diagnostics/log-evidence"],
  diagnosesList:     ["GET",  "/api/diagnoses"],
  diagnosisGet:      ["GET",  "/api/diagnoses/:id"],
  diagnosesStats:    ["GET",  "/api/diagnoses/stats"],
  systemSnapshot:    ["GET",  "/api/system/snapshot"],
  systemCapabilities:["GET",  "/api/system/capabilities"],
  systemEvents:      ["GET",  "/api/system/events"],
  systemServices:    ["GET",  "/api/system/services"],
  systemSmart:       ["GET",  "/api/system/smart"],
  systemThermal:     ["GET",  "/api/system/thermal"],
  systemUpdateCheck: ["POST", "/api/system/update-check"],
  capacityForecast:  ["GET",  "/api/system/capacity-forecast"],
  deviceProfiles:    ["GET",  "/api/system/device-profiles"],
  deviceProfileGet:  ["GET",  "/api/system/device-profiles/:id"],
  /* 文件 */
  filesList:         ["GET",  "/api/files"],
  filePreview:       ["GET",  "/api/files/preview"],
  fileOperation:     ["POST", "/api/files/operation"],
  fileBatch:         ["POST", "/api/files/operations/batch"],
  fileUpload:        ["POST", "/api/files/upload"],
  fileDownload:      ["GET",  "/api/files/download"],
  fileChecksum:      ["GET",  "/api/files/checksum"],
  fileDuplicates:    ["GET",  "/api/files/duplicates"],
  fileRenamePlan:    ["POST", "/api/files/rename-plan"],
  fileRenameApply:   ["POST", "/api/files/rename-apply"],
  /* 对话 / 任务 / 审批 / 工具 */
  agentStatus:       ["GET",  "/api/agent/status"],
  agentMessage:      ["POST", "/api/agent/message"],
  agentTrace:        ["GET",  "/api/agent/trace"],
  trimCliTest:       ["POST", "/api/agent/trim-cli/test"],
  trimCliLoginCommand:["POST","/api/agent/trim-cli/login-command"],
  chatStatus:        ["GET",  "/api/chat/status"],
  chatMessage:       ["POST", "/api/chat/message"],
  tasksList:         ["GET",  "/api/tasks"],
  tasksStatus:       ["GET",  "/api/tasks/status"],
  taskGet:           ["GET",  "/api/tasks/:id"],
  taskCancel:        ["POST", "/api/tasks/:id/cancel"],
  taskEvents:        ["GET",  "/api/tasks/:id/events"],
  tasksClearHistory: ["POST", "/api/tasks/clear-history"],
  actionsPending:    ["GET",  "/api/actions/pending"],
  actionConfirm:     ["POST", "/api/actions/:id/confirm"],
  actionDeny:        ["POST", "/api/actions/:id/deny"],
  toolsList:         ["GET",  "/api/tools"],
  toolRun:           ["POST", "/api/tools/:id/run"],
  /* 模型 */
  modelsList:        ["GET",  "/api/models"],
  modelsPresets:     ["GET",  "/api/models/presets"],
  modelsUsage:       ["GET",  "/api/models/usage"],
  modelAdd:          ["POST", "/api/models"],
  modelUpdate:       ["PUT",  "/api/models/:id"],
  modelRemove:       ["DELETE","/api/models/:id"],
  modelSetDefault:   ["POST", "/api/models/:id/default"],
  modelTest:         ["POST", "/api/models/:id/test"],
  /* Skill */
  skillsList:        ["GET",  "/api/skills"],
  skillRegister:     ["POST", "/api/skills"],
  skillRemove:       ["DELETE","/api/skills/:id"],
  skillImport:       ["POST", "/api/skills/import"],
  skillImportRemote: ["POST", "/api/skills/import-remote"],
  skillImportRemoteBatch:["POST","/api/skills/import-remote-batch"],
  skillTransition:   ["POST", "/api/skills/:id/transition"],
  skillInstallCli:   ["POST", "/api/skills/:id/install-cli"],
  skillsTransitionBatch:["POST","/api/skills/transitions/batch"],
  /* 知识库 */
  knowledgeList:     ["GET",  "/api/knowledge"],
  knowledgeGet:      ["GET",  "/api/knowledge/:id"],
  knowledgeStats:    ["GET",  "/api/knowledge/stats"],
  knowledgeConflicts:["GET",  "/api/knowledge/conflicts"],
  knowledgePreview:  ["POST", "/api/knowledge/preview"],
  knowledgeCommit:   ["POST", "/api/knowledge/commit"],
  knowledgeCancel:   ["POST", "/api/knowledge/cancel"],
  /* 网络 / 容器 / 部署 / 安全 */
  networkInterfaces: ["GET",  "/api/network/interfaces"],
  networkCheck:      ["POST", "/api/network/check"],
  networkDiagnostics:["GET",  "/api/network/diagnostics"],
  networkPolicy:     ["GET",  "/api/network/policy"],
  certificateCheck:  ["POST", "/api/network/certificate-check"],
  dockerStats:       ["GET",  "/api/docker/stats"],
  dockerAdvice:      ["POST", "/api/docker/advice"],
  deployPrecheck:    ["POST", "/api/deploy/precheck"],
  compositionsPlan:  ["POST", "/api/compositions/plan"],
  compositionsValidate:["POST","/api/compositions/validate"],
  securityInspection:["POST", "/api/security/inspection"],
  writeActions:      ["GET",  "/api/write-actions"],
  backupPrecheck:    ["POST", "/api/backup/precheck"],
  /* 工作流 / 运行手册 / MCP / 通知 */
  workflowsList:     ["GET",  "/api/workflows"],
  workflowGet:       ["GET",  "/api/workflows/:id"],
  workflowTriggersEvaluate:["POST","/api/workflows/triggers/evaluate"],
  runbooksList:      ["GET",  "/api/runbooks"],
  runbookGet:        ["GET",  "/api/runbooks/:id"],
  runbooksStats:     ["GET",  "/api/runbooks/stats"],
  runbookCreate:     ["POST", "/api/runbooks"],
  mcpStatus:         ["GET",  "/api/mcp/status"],
  auditList:         ["GET",  "/api/audit"],
  webFetch:          ["POST", "/api/web/fetch"],
  healthChecks:      ["GET",  "/api/health-checks"],
};

export function routeUrl(name, params = {}, query){
  const def = ROUTES[name];
  if(!def) throw new Error("未注册的 API 路由：" + name);
  let path = def[1].replace(/:([A-Za-z]+)/g, (_, key) => {
    if(params[key] === undefined) throw new Error(`路由 ${name} 缺少参数 :${key}`);
    return encodeURIComponent(params[key]);
  });
  if(query){
    const qs = new URLSearchParams(Object.entries(query).filter(([,v]) => v !== undefined && v !== ""));
    if([...qs].length) path += "?" + qs.toString();
  }
  return path;
}

export async function call(name, { params, query, body } = {}){
  if(PREVIEW){
    const mock = mockFor(name, { params, query, body });
    if(mock !== undefined) await new Promise(r => setTimeout(r, 150));
    if(mock !== undefined) return { ok:true, status:200, data:mock };
  }
  const [method, template] = ROUTES[name];
  const options = { method, credentials:"same-origin", cache:"no-store", headers:{} };
  if(body !== undefined){
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try{
    response = await fetch(routeUrl(name, params, query), options);
  }catch(error){
    throw Object.assign(new Error("无法连接 Agent 服务"), { status:0, cause:error });
  }
  let data = null;
  const text = await response.text();
  if(text){ try{ data = JSON.parse(text); }catch{ data = text; } }
  if(!response.ok){
    const message = (data && typeof data === "object" ? data.error : null) || `请求失败（HTTP ${response.status}）`;
    throw Object.assign(new Error(message), { status:response.status, code:data?.code, data });
  }
  return { ok:true, status:response.status, data };
}

export async function callJson(name, opts){
  const r = await call(name, opts);
  return r.data;
}

/* ------------------------------------------------------------------ *
 * PREVIEW 演示数据：仅在静态预览环境生效，仓库构建产物不含这部分行为。 *
 * 文件树可被操作（mkdir/rename/move/delete/copy），让预览完整可交互。   *
 * ------------------------------------------------------------------ */
const NOW = Date.now();
const D = (name, children) => ({ name, type:"directory", sizeBytes:null, modifiedAt:new Date(NOW - 3 * 864e5).toISOString(), children });
const F = (name, sizeBytes, kind, content) => ({ name, type:"file", sizeBytes:sizeBytes, kind:kind,
  modifiedAt:new Date(NOW - 864e5).toISOString(), content:content });
const MOCK_TREE = D("ROOT", [
  D("vol1", [
    D("照片", [ D("2026-10 婚礼", [ F("IMG_2041.jpg", 4812233), F("IMG_2042.jpg", 5102884) ]), F("家庭合影.jpg", 3466233) ]),
    D("影视库", [ F("流浪地球3.2160p.mkv", 18662331000), F("奥本海默.1080p.mkv", 8662331000) ]),
    D("文档", [
      F("NAS 折腾笔记.md", 18233, "doc", "# NAS 折腾笔记\n\n## 2026-10-26\n- UI2 外壳落地\n- 文件管理打样完成"),
      F("路由器配置备份.conf", 12833, "code", "interface eth0\n  description WAN\n  ip address dhcp"),
      F("记账.xlsx", 44233),
    ]),
    F("照片索引.xlsx", 122233),
  ]),
  D("vol2", [ D("备份", [ F("snapshot-1026.tar.zst", 3266233100) ]), F("README.txt", 433, "doc", "vol2 为冷备份盘。") ]),
]);
function fsNode(path){
  if(!path || path === "/") return MOCK_TREE;
  let node = MOCK_TREE;
  for(const part of path.split("/").filter(Boolean)){
    if(!node || node.type !== "directory") return null;
    node = (node.children || []).find(c => c.name === part);
  }
  return node || null;
}
function fsParent(path){
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}
function fsEntryMeta(node, dirPath){
  return { name:node.name, path:(dirPath === "/" ? "" : dirPath) + "/" + node.name,
    type:node.type, sizeBytes:node.sizeBytes, modifiedAt:node.modifiedAt };
}
function mockFor(name, { params, query, body } = {}){
  switch(name){
    case "health": return { ok:true, app:"fnos-nas-agent", version:"0.2.2 (preview)", executionEnabled:false, executionMode:"normal", executionModeSource:"default", authenticationConfigured:true };
    case "sessionInfo": return { authenticated:true, setupRequired:false };
    case "agentStatus": return { model:{ enabled:true, providerName:"DeepSeek", model:"deepseek-chat" }, availableTools:18, arbitraryExecutionEnabled:false, trimCli:{ available:true, configured:true, connectionStatus:"not_tested", message:"演示模式：未做真实连接检测" } };
    case "chatStatus": return { enabled:true, model:"deepseek-chat" };
    case "actionsPending": return { actions:[] };
    case "tasksStatus": return { running:0, queued:0, retained:12, concurrency:2 };
    case "tasksList": return { tasks:[{ taskId:"b4c1a2d3-0000-0000-0000-000000000001", status:"completed", stage:"已完成", createdAt:new Date(NOW - 36e5).toISOString(),
      result:{ message:"演示任务：已读取系统状态" } }], offset:0, totalEntries:1 };
    case "agentStatusTrace": return { entries:[] };
    case "overview": return {
      health:{ ok:true, version:"0.2.2 (preview)", executionMode:"normal", executionModeSource:"default" },
      storage:[{ label:"vol1", totalBytes:4e12, freeBytes:1.52e12, usedBytes:2.48e12, available:true },
               { label:"vol2", totalBytes:8e12, freeBytes:6.88e12, usedBytes:1.12e12, available:true }],
      tasks:{ queued:0, running:0, completed:42, failed:2 },
      models:{ providerCount:2, activeProviderName:"DeepSeek" },
      skills:{ enabled:1, pendingReview:0 } };
    case "diagnostics": return { system:{ platform:"linux", release:"fnOS 0.9.20", arch:"x86_64", nodeVersion:"v26.1.0", uptimeSeconds:591042 },
      cpu:{ model:"Intel N100", logicalCores:4, loadAverage:[0.42,0.38,0.35] },
      memory:{ totalBytes:16e9, usedBytes:9.2e9, freeBytes:6.8e9 },
      network:[{ name:"eth0", addresses:[{ address:"192.168.1.20", family:"IPv4", cidr:"192.168.1.20/24" }] }],
      storage:[{ label:"root", available:true, totalBytes:64e9, usedBytes:28e9, freeBytes:36e9 },
               { label:"vol1", available:true, totalBytes:4e12, usedBytes:2.48e12, freeBytes:1.52e12 }] };
    case "systemSnapshot": return { collectedAt:new Date().toISOString(), os:{ name:"fnOS", version:"0.9.20", kernel:"6.9.0" },
      cpu:{ model:"Intel N100", cores:4, usagePercent:12.5 }, memory:{ totalBytes:16e9, usedPercent:57.5 },
      volumes:[{ mount:"/vol1", totalBytes:4e12, usedPercent:62 },{ mount:"/vol2", totalBytes:8e12, usedPercent:14 }] };
    case "modelsList": return { activeProviderId:"p1", providers:[
      { id:"p1", name:"DeepSeek", endpoint:"https://api.deepseek.com/v1/chat/completions", model:"deepseek-chat",
        enabled:true, hasApiKey:true, isDefault:true, createdAt:"", updatedAt:"", lastTest:{ ok:true, at:new Date().toISOString(), message:"连接成功" } },
      { id:"p2", name:"本地 Qwen", endpoint:"https://nas.lan:8000/v1/chat/completions", model:"qwen2.5-7b",
        enabled:false, hasApiKey:false, isDefault:false, createdAt:"", updatedAt:"", lastTest:null }] };
    case "auditList": return { events:[0,1,2,3,4].map(i => ({ at:new Date(NOW - i * 9e5).toISOString(),
      route:["login","files.list","models.list","agent.message","tasks.list"][i], statusCode:[200,200,200,202,200][i] })) };
    case "agentTrace": return { entries:[0,1,2].map(i => ({ at:new Date(NOW - i * 12e5).toISOString(),
      tool:["system.status","files.list","fnos.photos.search"][i], durationMs:[120,340,890][i], outcome:"ok" })) };
    case "modelsUsage": return { windowDays:7, requests:128, promptTokens:45210, completionTokens:9877, errors:2, byProvider:[
      { provider:"DeepSeek", requests:96, errors:0 }, { provider:"本地 Qwen", requests:32, errors:2 }] };
    case "modelsPresets": return { presets:[
      { name:"DeepSeek", endpoint:"https://api.deepseek.com", model:"deepseek-chat" },
      { name:"通义千问", endpoint:"https://dashscope.aliyuncs.com/compatible-mode/v1", model:"qwen-plus" },
      { name:"OpenAI", endpoint:"https://api.openai.com/v1", model:"gpt-4o-mini" }] };
    case "skillsList": return { skills:[
      { id:"a1b2c3d4e5f6a1b2c3d4e5f6", name:"fnos", state:"enabled", version:"1.0.0",
        manifestReview:{ status:"manifest_parsed", name:"fnos" }, archiveSha256:"" + "f".repeat(64), createdAt:new Date(NOW - 30 * 864e5).toISOString(), note:"官方 Skill" },
      { id:"b2c3d4e5f6a1b2c3d4e5f6a1", name:"media-tools", state:"pending_review", version:"0.3.1",
        manifestReview:{ status:"needs_review" }, archiveSha256:"" + "a".repeat(64), createdAt:new Date(NOW - 864e5).toISOString() }] };
    case "knowledgeStats": return { total:12, archived:3, bySource:{ "official-doc":5, "field-observation":4, "manual-confirmation":3 },
      byVerification:{ verified:7, unverified:3, stale:2 }, capacityUsedBytes:48211, capacityMaxBytes:1048576 };
    case "knowledgeConflicts": return { conflicts:[
      { topic:"Jellyfin 硬解方案", entries:[
        { title:"NVIDIA NVENC 可用", source:"official-doc", confidence:"high" },
        { title:"N100 核显更省电", source:"field-observation", confidence:"medium" } ] }] };
    case "knowledgeList": return { entries:[
      { title:"fnOS 目录结构约定", topic:"fnos", source:"official-doc", confidence:"high", createdAt:new Date(NOW - 20 * 864e5).toISOString() },
      { title:"UPS 断电关机时序", topic:"power", source:"field-observation", confidence:"medium", createdAt:new Date(NOW - 5 * 864e5).toISOString() }] };
    case "executionModeGet": return { mode:"normal", source:"default", modes:["normal","read-only","halted"] };
    case "systemCapabilities": return { profile:"agent-host", capabilities:{ files:{ read:true, write:true }, docker:{ read:true, write:false }, smart:{ read:true } } };
    case "deviceProfiles": return { profiles:[{ id:"dp1", name:"agent-host", note:"Agent 宿主机视角" }] };
    case "healthChecks": return { checks:[{ id:"disk-usage", name:"磁盘用量", schedule:"每小时", lastOutcome:"ok" }] };
    case "workflowsList": return { workflows:[{ id:"wf-nightly-snapshot", name:"夜间快照", enabled:true, steps:3 }] };
    case "mcpStatus": return { servers:[{ name:"filesystem", tools:11, ok:true }, { name:"fetch", tools:1, ok:false, reason:"未启用" }] };
    case "runbooksList": return { runbooks:[{ id:"rb-1", title:"硬盘异响处置", updatedAt:new Date(NOW - 7 * 864e5).toISOString() }] };
    case "runbooksStats": return { count:2, tagged:1, persisted:true };
    case "writeActions": return { actions:[] };
    case "diagnosesList": return { diagnoses:[{ id:"d-1026", createdAt:new Date(NOW - 864e5).toISOString(), outcome:"degraded", sections:6 }] };
    case "diagnosesStats": return { total:9, last7Days:2, degraded:1 };
    case "networkDiagnostics": return { gateway:{ ok:true, address:"192.168.1.1" }, dns:{ ok:true, servers:["223.5.5.5"] }, proxy:{ enabled:false } };
    case "networkPolicy": return { egress:"allowlist", webFetch:false, allowlist:["api.deepseek.com"] };
    case "networkInterfaces": return { interfaces:[{ name:"eth0", addresses:["192.168.1.20/24"] }] };
    case "systemServices": return { services:[{ unit:"smbd", active:"active" }, { unit:"docker", active:"active" }] };
    case "systemSmart": return { disks:[{ device:"/dev/sda", model:"WD80EFZZ", healthy:true }, { device:"/dev/sdb", model:"ST8000VN", healthy:true }] };
    case "systemThermal": return { readings:[{ sensor:"cpu", celsius:52 }, { sensor:"nvme0", celsius:41 }], summary:"正常" };
    case "systemEvents": return { events:[{ at:new Date(NOW - 36e5).toISOString(), level:"info", message:"snapshot completed" }] };
    case "capacityForecast": return { volumes:[{ mount:"/vol1", horizonDays:90, projectedFullDate:null, trendPercentPerDay:0.02 }] };
    case "dockerStats": return { containers:[{ name:"jellyfin", cpuPercent:3.2, memUsageBytes:812000000, status:"running" }] };
    case "filesList": {
      const path = query?.path || "/vol1";
      const node = fsNode(path);
      if(!node || node.type !== "directory") throw Object.assign(new Error("目录不存在"), { status:404 });
      let children = (node.children || []).map(c => fsEntryMeta(c, path === "/" ? "" : path));
      const q = (query?.q || "").toLowerCase();
      if(q) children = children.filter(c => c.name.toLowerCase().includes(q));
      if(query?.type === "directory") children = children.filter(c => c.type === "directory");
      if(query?.type === "file") children = children.filter(c => c.type === "file");
      const roots = [ { name:"vol1", path:"/vol1" }, { name:"vol2", path:"/vol2" } ];
      const offset = Number(query?.offset || 0), limit = Number(query?.limit || 60);
      return { roots, path, parentPath: path === "/vol1" || path === "/vol2" ? "/" : fsParent(path),
        entries: children.slice(offset, offset + limit), limit, offset,
        totalEntries: children.length, totalDirectoryEntries: (node.children || []).length };
    }
    case "filePreview": {
      const node = fsNode(query?.path || "");
      if(!node || node.type !== "file") throw Object.assign(new Error("文件不存在"), { status:404 });
      return { name:node.name, path:query.path, sizeBytes:node.sizeBytes,
        content: node.content !== undefined ? node.content : "" };
    }
    case "fileChecksum": return { path:query?.path, sha256:"demo:" + (query?.path || "").length.toString(16).padStart(8, "0") + "…（演示）" };
    case "fileOperation": {
      const action = body?.action;
      if(action === "mkdir"){
        const dir = fsNode(body.path); if(!dir) throw new Error("目录不存在");
        if((dir.children || []).some(c => c.name === body.name)) throw new Error("同名项目已存在");
        dir.children.push(D(body.name, [])); return { action, name:body.name };
      }
      if(action === "rename" || action === "move" || action === "copy"){
        const node = fsNode(body.path); if(!node) throw new Error("目标不存在");
        const parentPath = fsParent(body.path);
        const parent = fsNode(parentPath);
        if(action === "rename"){
          if((parent.children || []).some(c => c.name === body.name && c !== node)) throw new Error("同名项目已存在");
          node.name = body.name; node.modifiedAt = new Date().toISOString(); return { action };
        }
        const destDir = fsNode(action === "move" ? body.destination : body.path.slice(0, body.path.lastIndexOf("/")));
        if(action === "move"){
          if((destDir.children || []).some(c => c.name === node.name)) throw new Error("目标目录存在同名项目");
          parent.children = parent.children.filter(c => c !== node);
          destDir.children.push(node); return { action };
        }
        /* copy：深拷贝并加「副本」后缀 */
        let clone = JSON.parse(JSON.stringify(node));
        const base = node.name.replace(/(\.[^.]*)$/, "");
        const ext = (node.name.match(/\.[^.]*$/) || [""])[0];
        let newName = base + " 副本" + ext, n = 2;
        while((destDir.children || []).some(c => c.name === newName)) newName = base + " 副本 " + (n++) + ext;
        clone.name = newName; destDir.children.push(clone); return { action };
      }
      if(action === "delete"){
        const node = fsNode(body.path); if(!node) throw new Error("目标不存在");
        return { approvalRequired:false, deleted:true };
      }
      throw new Error("演示模式不支持的操作：" + action);
    }
    case "fileRenamePlan": case "fileRenameApply": {
      const entries = body?.entries || [], rule = body?.rule || {};
      const plan = entries.map((e, i) => {
        const dot = e.name.lastIndexOf(".");
        const stem = dot > 0 ? e.name.slice(0, dot) : e.name;
        const ext = dot > 0 ? e.name.slice(dot) : "";
        let to = e.name;
        if(rule.mode === "serial") to = (rule.keepExtension === false ? e.name : stem) + (rule.separator || "-") +
          String((rule.start || 1) + i * (rule.step || 1)).padStart(rule.width || 3, "0") + (rule.keepExtension === false ? "" : ext);
        else if(rule.mode === "add") to = (rule.prefix || "") + e.name + (rule.suffix || "");
        else if(rule.mode === "replace") to = e.name.split(rule.find || "").join(rule.replace || "");
        else if(rule.mode === "normalize") to = e.name.trim().toLowerCase().replace(/\s+/g, rule.spacesTo || "-");
        const from = e.path;
        const toPath = (fsParent(e.path) === "/" ? "" : fsParent(e.path)) + "/" + to;
        return { from, to:toPath, name:to };
      });
      if(name === "fileRenamePlan")
        return { ok:true, plan, conflicts:[], errors:[], skipped:[], summary:{ total:entries.length, planned:plan.length, skipped:0, conflicts:0 } };
      for(const it of plan){
        const node = fsNode(it.from); if(!node) continue;
        const parent = fsNode(fsParent(it.from));
        parent.children = parent.children.filter(c => c !== node);
        node.name = it.name; (fsNode(fsParent(it.to)) || parent).children.push(node);
      }
      return { ok:true, summary:{ planned:plan.length } };
    }
    default: {
      /* 通用兜底：预览环境没有服务端；GET 给演示对象，写操作给「已受理」 */
      const method = ROUTES[name] && ROUTES[name][0];
      if(method === "GET") return { _demo:true, route:name, note:"预览演示数据（真实部署返回业务数据）" };
      return { ok:true, _demo:true, note:"预览演示：请求已受理（模拟）" };
    }
  }
}
