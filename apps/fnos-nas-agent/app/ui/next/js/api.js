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
  filePreview:       ["POST", "/api/files/preview"],
  fileOperation:     ["POST", "/api/files/operation"],
  fileBatch:         ["POST", "/api/files/operations/batch"],
  fileUpload:        ["POST", "/api/files/upload"],
  fileDownload:      ["GET",  "/api/files/download"],
  fileChecksum:      ["POST", "/api/files/checksum"],
  fileDuplicates:    ["POST", "/api/files/duplicates"],
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
 * ------------------------------------------------------------------ */
function mockFor(name, { params, query } = {}){
  switch(name){
    case "health": return { ok:true, app:"fnos-nas-agent", version:"0.2.2 (preview)", executionEnabled:false, authenticationConfigured:true };
    case "sessionInfo": return { authenticated:true, setupRequired:false };
    case "overview": return {
      health:{ ok:true, version:"0.2.2 (preview)", executionMode:"normal", executionModeSource:"default" },
      storage:[{ label:"vol1", totalBytes:4e12, freeBytes:1.52e12, usedBytes:2.48e12, available:true },
               { label:"vol2", totalBytes:8e12, freeBytes:6.88e12, usedBytes:1.12e12, available:true }],
      tasks:{ queued:0, running:1, completed:42, failed:2 },
      models:{ providerCount:2, activeProviderName:"DeepSeek" },
      skills:{ enabled:1, pendingReview:0 },
    };
    case "diagnostics": return {
      system:{ platform:"linux", release:"fnOS 0.9.20", arch:"x86_64", nodeVersion:"v26.1.0", uptimeSeconds:86400*6+7242 },
      cpu:{ model:"Intel N100", logicalCores:4, loadAverage:[0.42,0.38,0.35] },
      memory:{ totalBytes:16e9, usedBytes:9.2e9, freeBytes:6.8e9 },
      network:[{ name:"eth0", addresses:[{address:"192.168.1.20",family:"IPv4",cidr:"192.168.1.20/24"}] }],
      storage:[{ label:"root", available:true, totalBytes:64e9, usedBytes:28e9, freeBytes:36e9 },
               { label:"vol1", available:true, totalBytes:4e12, usedBytes:2.48e12, freeBytes:1.52e9 }],
    };
    case "chatStatus": return { enabled:true, mode:"direct-or-task" };
    case "modelsList": return { activeProviderId:"p1", providers:[
      { id:"p1", name:"DeepSeek", endpoint:"https://api.deepseek.com/v1/chat/completions", model:"deepseek-chat",
        enabled:true, hasApiKey:true, isDefault:true, createdAt:"", updatedAt:"", lastTest:{ ok:true, at:new Date().toISOString(), message:"连接成功" } },
      { id:"p2", name:"本地 Qwen", endpoint:"https://nas.lan:8000/v1/chat/completions", model:"qwen2.5-7b",
        enabled:false, hasApiKey:false, isDefault:false, createdAt:"", updatedAt:"", lastTest:null }] };
    case "auditList": return { events:[0,1,2,3,4].map(i => ({
      at:new Date(Date.now()-i*9e5).toISOString(),
      route:["login","files.list","models.list","agent.message","tasks.list"][i],
      statusCode:[200,200,200,202,200][i] })) };
    case "filesList": {
      const tree = filesTree(query?.path || params?.path || "/vol1");
      return tree;
    }
    case "systemSnapshot": return { collectedAt:new Date().toISOString(),
      os:{ name:"fnOS", version:"0.9.20", kernel:"6.9.0" }, uptimeSeconds:86400*6+7242,
      cpu:{ model:"Intel N100", cores:4, usagePercent:12.5 },
      memory:{ totalBytes:16e9, usedPercent:57.5 },
      volumes:[{ mount:"/vol1", totalBytes:4e12, usedPercent:62 },{ mount:"/vol2", totalBytes:8e12, usedPercent:14 }] };
    default: return undefined;
  }
}
const MOCK_DIR = {
  "/vol1":[
    { name:"照片", type:"dir", size:0, mtime:Date.now()-2*864e5, children:24 },
    { name:"影视库", type:"dir", size:0, mtime:Date.now()-5*864e5, children:6 },
    { name:"音乐", type:"dir", size:0, mtime:Date.now()-8*864e5, children:2 },
    { name:"文档", type:"dir", size:0, mtime:Date.now()-4*864e5, children:4 },
    { name:"下载", type:"dir", size:0, mtime:Date.now()-36e5, children:3 },
    { name:"照片索引.xlsx", type:"file", size:122233, mtime:Date.now()-3*864e5, kind:"doc" },
  ],
  "/vol2":[
    { name:"备份", type:"dir", size:0, mtime:Date.now()-6*864e5, children:1 },
    { name:"监控录像", type:"dir", size:0, mtime:Date.now()-6*864e5, children:1 },
    { name:"README.txt", type:"file", size:433, mtime:Date.now()-200*864e5, kind:"doc" },
  ],
};
function filesTree(path){
  const entries = MOCK_DIR[path] || [];
  return { path, entries:entries.slice(0, 31), hasMore:false, total:entries.length };
}
