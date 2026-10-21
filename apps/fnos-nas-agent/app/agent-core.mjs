import { randomUUID } from "node:crypto";
import { normalizeConversationHistory } from "./conversation-context.mjs";

const MAX_USER_TEXT = 2000;
const DIRECT_INTENTS = [
  { pattern: /^(?:查看|查询|显示|检查|看看)?\s*(?:系统状态|系统情况|nas状态|服务器状态)\s*[。！!？?]?$/i, tool: "system.status", message: "正在读取 NAS 系统状态。" },
  { pattern: /^(?:查看|查询|显示|检查|看看)?\s*(?:存储|磁盘|硬盘|磁盘空间|存储空间)(?:情况|状态|使用情况|容量)?\s*[。！!？?]?$/i, tool: "storage.summary", message: "正在读取存储容量信息。" },
  { pattern: /^(?:查看|查询|显示|检查|看看)?\s*(?:网络|网卡|网络接口|ip地址)(?:情况|状态|信息)?\s*[。！!？?]?$/i, tool: "network.interfaces", message: "正在读取网络接口信息。" },
  { pattern: /^(?:查看|查询|统计)?\s*(?:系统)?进程(?:数量|数目|概况)?\s*[。！!？?]?$/i, tool: "system.process-summary", message: "正在读取进程数量（不读取进程详情）。" },
  { pattern: /^(?:查看|查询|显示|检查|看看)?\s*(?:已安装应用|应用列表|已安装软件)\s*[。！!？?]?$/i, tool: "fnos.app.list", message: "正在读取已安装应用列表。" },
  { pattern: /^(?:查看|查询|显示|列出)?\s*(?:Docker镜像|docker镜像|镜像列表)\s*[。！!？?]?$/i, tool: "fnos.docker.image-list", message: "正在读取 Docker 镜像列表，不会启动或停止容器。" },
  { pattern: /^(?:查看|查询|显示|列出)?\s*(?:下载任务|下载列表)\s*[。！!？?]?$/i, tool: "fnos.download.list", message: "正在读取下载任务列表。" },
  { pattern: /^(?:查看|查询|显示|检查)?\s*(?:CPU监控|CPU使用情况|处理器状态)\s*[。！!？?]?$/i, tool: "fnos.monitor.cpu", message: "正在读取 CPU 监控数据。" },
  { pattern: /^(?:查看|查询|显示|列出)?\s*(?:存储池|存储池列表)\s*[。！!？?]?$/i, tool: "fnos.storage.pools", message: "正在读取存储池列表，不会修改存储配置。" },
  { pattern: /^(?:查看|查询|显示)?\s*(?:当前用户|NAS用户信息|用户信息)\s*[。！!？?]?$/i, tool: "fnos.user.info", message: "正在读取当前用户信息。" },
  { pattern: /^(?:查看|查询|显示|检查|看看|列出|浏览)?\s*(?:文件|文件夹|目录)(?:列表)?(?:\s+(.{1,2048}))?\s*[。！!？?]?$/i, tool: "files.list", args: match => match[1] ? ({ path: match[1].trim() }) : ({}), message: "正在读取允许存储卷中的文件目录。" },
  { pattern: /^搜索文件\s+(.{1,200}?)(?:\s+于\s+(.{1,2048}))?$/i, tool: "files.search", args: match => ({ query: match[1].trim(), ...(match[2] ? { path: match[2].trim() } : {}), limit: 50 }), message: "正在按文件名搜索允许存储卷；搜索范围和结果数量有上限。" },
  { pattern: /^(?:预览|读取|查看)文本文件\s+(.{1,2048})$/i, tool: "files.preview", args: match => ({ path: match[1].trim() }), message: "正在预览 UTF-8 文本文件。" },
  { pattern: /^(?:查看|列出|浏览)(?:一下)?fnOS文件(?:列表)?\s+(.{1,2048})$/i, tool: "fnos.file.ls", args: match => ({ path: match[1].trim() }), message: "正在读取 fnOS 文件列表。" },
  { pattern: /^(?:查看|列出|浏览)(?:一下)?(?:相册文件夹|照片文件夹)\s*[。！!？?]?$/i, tool: "fnos.photos.folders", message: "正在读取相册文件夹。" },
  { pattern: /^(?:搜索|查找|搜一下)(?:相册|照片|图片)(?:中|里)?[：:\s]*(.{1,200})$/i, tool: "fnos.photos.search", args: match => ({ keyword: match[1].trim(), limit: 20 }), message: "正在搜索相册内容。" },
  { pattern: /^创建文件夹\s+(.{1,255}?)\s+于\s+(.{1,2048})$/i, tool: "files.create-folder", args: match => ({ name: match[1].trim(), path: match[2].trim() }), message: "正在创建文件夹。" },
  { pattern: /^创建文本文件\s+(.{1,255}?)\s+于\s+(.{1,2048}?)\s+内容[：:]\s*([\s\S]{1,10000})$/i, tool: "files.create-text", args: match => ({ name: match[1].trim(), path: match[2].trim(), content: match[3] }), message: "正在创建文本文件。" },
  { pattern: /^重命名\s+(.{1,2048}?)\s+为\s+(.{1,255})$/i, tool: "files.rename", args: match => ({ path: match[1].trim(), name: match[2].trim() }), message: "正在重命名文件或文件夹。" },
  { pattern: /^移动\s+(.{1,2048}?)\s+到\s+(.{1,2048})$/i, tool: "files.move", args: match => ({ path: match[1].trim(), destination: match[2].trim() }), message: "正在移动文件或文件夹。" },
  { pattern: /^删除\s+(.{1,2048})$/i, tool: "files.delete", args: match => ({ path: match[1].trim() }), message: "删除操作需要二次确认。" }
];

function argsMatchSchema(args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const properties = schema?.properties || {};
  if (schema?.additionalProperties === false && Object.keys(args).some(key => !Object.hasOwn(properties, key))) return false;
  for (const key of schema?.required || []) if (!Object.hasOwn(args, key)) return false;
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key]; if (!rule) return false;
    if (rule.type === "string" && (typeof value !== "string" || (rule.minLength && value.length < rule.minLength) || (rule.maxLength && value.length > rule.maxLength))) return false;
    if (rule.type === "integer" && (!Number.isInteger(value) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))) return false;
  }
  return true;
}

function safeMessage(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 2000) : fallback;
}

export function createAgentCore({ tools, model, requestApproval = null, now = () => new Date().toISOString(), id = randomUUID }) {
  if (!tools || typeof tools.list !== "function" || typeof tools.invoke !== "function") throw new TypeError("A tool registry is required");
  if (!model || typeof model.plan !== "function" || typeof model.status !== "function") throw new TypeError("A model adapter is required");

  async function executePlan(plan, approvalTaskId = id(), reportProgress = () => {}, shouldCancel = () => false) {
    if (shouldCancel()) throw Object.assign(new Error("Task cancellation requested"), { code: "TASK_CANCELLED" });
    reportProgress(25, "校验工具计划");
    const catalogue = new Map(tools.list().map(tool => [tool.id, tool]));
    // Validate the complete plan before the first tool invocation.
    for (const call of plan.toolCalls) {
      if (!catalogue.has(call.id)) throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
      if (!["read-only", "write", "destructive"].includes(catalogue.get(call.id).risk))
        throw Object.assign(new Error("Unknown tool risk; execution denied"), { statusCode: 403 });
      if (!argsMatchSchema(call.args, catalogue.get(call.id).inputSchema))
        throw Object.assign(new Error("Invalid tool arguments"), { statusCode: 400 });
    }
    if (shouldCancel()) throw Object.assign(new Error("Task cancellation requested"), { code: "TASK_CANCELLED" });
    const destructive = plan.toolCalls.filter(call => catalogue.get(call.id).risk === "destructive");
    if (destructive.length) {
      if (plan.toolCalls.length !== 1) throw Object.assign(new Error("Destructive actions must be requested alone so no earlier tool can partially execute"), { statusCode: 400 });
      if (typeof requestApproval !== "function") throw Object.assign(new Error("Confirmation service is unavailable"), { statusCode: 503 });
      return { pendingApproval: await requestApproval({ toolId: destructive[0].id, args: destructive[0].args, taskId: approvalTaskId }) };
    }
    const results = [];
    reportProgress(55, "执行工具");
    let completed = 0;
    for (const call of plan.toolCalls) {
      if (shouldCancel()) throw Object.assign(new Error("Task cancellation requested"), { code: "TASK_CANCELLED" });
      const result = await tools.invoke(call.id, call.args);
      results.push({ tool: call.id, result });
      completed++;
      reportProgress(55 + Math.floor(completed / plan.toolCalls.length * 40), "已完成工具 " + completed + "/" + plan.toolCalls.length);
    }
    return results;
  }

  return Object.freeze({
    status() {
      return { rulesFirst: true, model: model.status(), availableTools: tools.list().length, arbitraryExecutionEnabled: false };
    },
    async run(input, context = {}) {
      const reportProgress = typeof context?.reportProgress === "function" ? context.reportProgress : () => {};
      const shouldCancel = typeof context?.shouldCancel === "function" ? context.shouldCancel : () => false;
      reportProgress(5, "解析请求");
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.text !== "string")
        throw Object.assign(new Error("A text field is required"), { statusCode: 400 });
      const text = input.text.trim();
      if (!text || text.length > MAX_USER_TEXT) throw Object.assign(new Error("Message must contain 1 to 2000 characters"), { statusCode: 400 });
      const history = normalizeConversationHistory(input.history);
      const taskId = id();
      const createdAt = now();
      const direct = DIRECT_INTENTS.map(item => ({ item, match: item.pattern.exec(text) })).find(entry => entry.match);
      if (direct) {
        reportProgress(15, "已识别请求");
        const results = await executePlan({ toolCalls: [{ id: direct.item.tool, args: direct.item.args ? direct.item.args(direct.match) : {} }] }, taskId, reportProgress, shouldCancel);
        if (!Array.isArray(results)) return { taskId, createdAt, completedAt: now(), status: "awaiting-approval", mode: "rules", message: "该操作有破坏性影响，请先确认具体目标；确认前不会执行。", pendingApproval: results.pendingApproval, results: [] };
        return { taskId, createdAt, completedAt: now(), status: "completed", mode: "rules", message: direct.item.message, results };
      }

      if (!model.status().enabled) {
        return {
          taskId, createdAt, completedAt: now(), status: "completed", mode: "rules",
          message: "我暂时无法可靠地判断这个请求。可以直接问“系统状态”“存储空间”“网络接口”或“进程数量”。如需自然语言分析，请先在服务端安全配置模型 API；当前未调用模型，也未执行其他操作。",
          results: []
        };
      }

      let plan;
      reportProgress(15, "准备模型计划");
      try { plan = await model.plan(text, tools.list(), history); }
      catch {
        if (shouldCancel()) throw Object.assign(new Error("Task cancellation requested"), { code: "TASK_CANCELLED" });
        return { taskId, createdAt, completedAt: now(), status: "failed", mode: "model", message: "模型请求失败或返回格式不符合要求。为安全起见，没有执行任何工具；请检查服务端模型配置与网络连通性。", results: [] };
      }
      if (!plan) return { taskId, createdAt, completedAt: now(), status: "failed", mode: "model", message: "模型未生成有效计划，未执行工具。", results: [] };
      reportProgress(45, "模型计划已生成");
      try {
        const results = await executePlan(plan, taskId, reportProgress, shouldCancel);
        if (!Array.isArray(results)) return { taskId, createdAt, completedAt: now(), status: "awaiting-approval", mode: "model", message: "该操作有破坏性影响，请先确认具体目标；确认前不会执行。", pendingApproval: results.pendingApproval, results: [] };
        return { taskId, createdAt, completedAt: now(), status: "completed", mode: "model", message: safeMessage(plan.message, "已完成请求。"), results };
      } catch (error) {
        if (error?.code === "TASK_CANCELLED") throw error;
        return {
          taskId, createdAt, completedAt: now(), status: "failed", mode: "model",
          message: error?.statusCode === 404 ? "模型请求了不在白名单中的工具，已拒绝该请求。" : "工具请求未通过校验或执行失败；未执行任意系统命令。",
          results: []
        };
      }
    }
  });
}
