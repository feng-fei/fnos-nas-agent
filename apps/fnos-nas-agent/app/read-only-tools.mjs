import { DELETE_CAPABILITY, hasDeleteCapability } from "./execution-capability.mjs";

const TRIM_CLI_TOOLS = [
  ["fnos.system.info", "system.info", "读取 fnOS 系统信息。", {}],
  ["fnos.system.trim-version", "system.trim-version", "读取 fnOS 系统版本。", {}],
  ["fnos.system.kernel-version", "system.kernel-version", "读取 Linux 内核版本。", {}],
  ["fnos.system.hostname", "system.host-name", "读取 NAS 主机名。", {}],
  ["fnos.system.uptime", "system.uptime", "读取 NAS 系统运行时间。", {}],
  ["fnos.system.all-volumes", "system.all-vols", "读取所有存储卷的详细信息。", {}],
  ["fnos.system.volumes", "system.vols", "列出存储卷。", {}],
  ["fnos.file.ls", "file.ls", "列出 fnOS 文件条目（只读）。", { path: { type: "string", minLength: 1, maxLength: 2048 } }, ["path"]],
  ["fnos.file.ls-dir", "file.ls-dir", "列出 fnOS 目录分段（只读）。", { path: { type: "string", minLength: 1, maxLength: 2048 } }, ["path"]],
  ["fnos.file.usage", "file.usage", "读取 fnOS 卷容量统计（只读）。", { volumeId: { type: "integer", minimum: 1, maximum: 10000 } }, ["volumeId"]],
  ["fnos.app.list", "app.list", "列出已安装应用。", {}],
  ["fnos.docker.image-list", "docker.image.ls", "列出 Docker 镜像，不执行容器操作。", {}],
  ["fnos.docker.stats", "docker.stats", "读取 Docker 总体资源统计；不会修改容器。", {}],
  ["fnos.docker.container-list", "docker.container.ls", "列出运行中的 Docker 容器。", {}],
  ["fnos.docker.container-list-all", "docker.container.ls-all", "列出所有 Docker 容器，包括已停止的容器。", {}],
  ["fnos.docker.compose-list", "docker.compose.ls", "列出 Docker Compose 项目。", {}],
  ["fnos.download.list", "download.ls", "列出下载任务。", {}],
  ["fnos.monitor.cpu", "monitor.cpu", "读取 fnOS CPU 监控数据。", {}],
  ["fnos.monitor.memory", "monitor.memory", "读取内存使用时间序列。", {}],
  ["fnos.monitor.network", "monitor.net", "读取网络运行态指标。", {}],
  ["fnos.monitor.disk", "monitor.disk", "读取磁盘运行态指标。", {}],
  ["fnos.storage.pools", "storage.pools", "读取存储池列表，不修改存储。", {}],
  ["fnos.user.info", "user.info", "读取当前用户信息。", {}],
  ["fnos.monitor.beep-supported", "monitor.beep-supported", "检查 fnOS 是否支持蜂鸣器监控能力（仅查询支持情况，不触发蜂鸣）。", {}],
  ["fnos.photos.folders", "photos.folders", "读取相册文件夹列表。", {}],
  ["fnos.photos.search", "photos.search", "按关键词搜索相册内容；最多返回 50 条。", { keyword: { type: "string", minLength: 1, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["keyword"]]
].map(([id, command, description, properties, required = []]) => ({
  id, title: id, description, risk: "read-only", trimCliCommand: command,
  inputSchema: { type: "object", properties, required, additionalProperties: false }
}));

const definitions = [
  ...TRIM_CLI_TOOLS,
  {
    id: "system.status",
    title: "系统状态",
    description: "读取操作系统、Node.js 运行时、CPU 负载与内存概况。",
    risk: "read-only"
  },
  {
    id: "storage.summary",
    title: "存储概况",
    description: "读取根目录和应用数据目录所在文件系统的容量信息。",
    risk: "read-only"
  },
  {
    id: "system.process-summary",
    title: "进程概况",
    description: "仅读取系统进程数量，不读取进程名称、命令行或环境变量。",
    risk: "read-only"
  },
  {
    id: "network.interfaces",
    title: "网络接口",
    description: "读取非内部网络接口及其 IP/CIDR 信息。",
    risk: "read-only"
  },
  {
    id: "files.list", title: "浏览文件目录", description: "列出允许存储卷中的目录和文件元数据，不读取文件内容。", risk: "read-only",
    inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 2048 }, limit: { type: "integer", minimum: 1, maximum: 200 } }, additionalProperties: false }
  },
  {
    id: "files.preview", title: "预览文本文件", description: "读取允许存储卷中不超过 1 MiB 的 UTF-8 文本文件。", risk: "read-only",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["path"], additionalProperties: false }
  },
  {
    id: "files.search", title: "搜索文件名", description: "在允许存储卷内按名称关键词搜索；最多扫描 5000 个条目、返回 100 条，跳过符号链接。", risk: "read-only",
    inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 2048 }, query: { type: "string", minLength: 1, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["query"], additionalProperties: false }
  },
  {
    id: "files.search-content", title: "搜索文件内容", description: "在允许存储卷内搜索 UTF-8 文本内容；限制目录深度、扫描条目、单文件和总读取量，跳过符号链接及常见敏感凭据文件，并对结果片段打码。", risk: "read-only",
    inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 2048 }, query: { type: "string", minLength: 1, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["query"], additionalProperties: false }
  },
  {
    id: "files.inspect", title: "文件卫生巡检", description: "只读检查授权目录中的大文件、久未修改的大文件、临时/备份文件名及疑似敏感文件名；只读取文件系统元数据，不读取正文，不修改文件。", risk: "read-only",
    inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 2048 }, days: { type: "integer", minimum: 1, maximum: 3650 }, minBytes: { type: "integer", minimum: 0, maximum: 1000000000 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false }
  },
  {
    id: "media.photos.search", title: "搜索本地照片图库", description: "在已授权存储卷中按文件名、相机信息、拍摄日期、图片类别及是否带 GPS 元数据搜索；仅读取有限图片头和 EXIF 元数据，不返回 GPS 坐标、不上传图片。", risk: "read-only",
    inputSchema: { type: "object", properties: { path: { type: "string", maxLength: 2048 }, query: { type: "string", maxLength: 160 }, dateFrom: { type: "string", maxLength: 10 }, dateTo: { type: "string", maxLength: 10 }, category: { type: "string", enum: ["photo", "screenshot", "scan", "other"] }, hasGps: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false }
  },
  { id: "documents.index-status", title: "本地文档库状态", description: "读取存放于应用私有数据目录的本地文档索引统计，不返回文档正文。", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { id: "documents.search", title: "搜索本地文档库", description: "在本地索引中按关键词检索文档，返回文件路径与经过打码的短摘要，不进行网络请求。", risk: "read-only", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 160 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"], additionalProperties: false } },
  { id: "documents.index-refresh", title: "更新本地文档索引", description: "扫描授权存储卷中的受支持文本文件并更新应用私有文档索引；受条目、时间、单文件与总读取量限制。仅修改应用私有索引，不修改 NAS 原文件。", risk: "write", inputSchema: { type: "object", properties: { force: { type: "boolean" }, maxFiles: { type: "integer", minimum: 1, maximum: 500 } }, additionalProperties: false } },
  { id: "health-checks.list", title: "定时巡检计划", description: "列出已保存的定时健康检查及有限执行历史。", risk: "read-only", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { id: "health-checks.create", title: "创建定时健康检查", description: "创建系统、存储、网络、Docker 或本地文档库定时巡检计划。仅计划持久化；执行时调用注册的只读工具。", risk: "write", inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 80 }, type: { type: "string", minLength: 1, maxLength: 20, enum: ["system", "storage", "network", "docker", "documents"] }, intervalMinutes: { type: "integer", minimum: 5, maximum: 10080 }, enabled: { type: "boolean" } }, required: ["name","type","intervalMinutes"], additionalProperties: false } },
  { id: "health-checks.run", title: "立即运行健康检查", description: "手动运行指定巡检计划，并保存经过摘要化的结果。不会执行 NAS 写操作。", risk: "write", inputSchema: { type: "object", properties: { checkId: { type: "string", minLength: 1, maxLength: 36 } }, required: ["checkId"], additionalProperties: false } },
  { id: "health-checks.update", title: "更新定时健康检查", description: "暂停、恢复或调整已有巡检计划。", risk: "write", inputSchema: { type: "object", properties: { checkId: { type: "string", minLength: 1, maxLength: 36 }, name: { type: "string", minLength: 1, maxLength: 80 }, enabled: { type: "boolean" }, intervalMinutes: { type: "integer", minimum: 5, maximum: 10080 } }, required: ["checkId"], additionalProperties: false } },
  { id: "health-checks.delete", title: "删除定时健康检查计划", description: "删除指定计划和该计划的有限巡检历史；不删除或修改 NAS 文件。", risk: "write", inputSchema: { type: "object", properties: { checkId: { type: "string", minLength: 1, maxLength: 36 } }, required: ["checkId"], additionalProperties: false } },
  {
    id: "files.create-folder", title: "创建文件夹", description: "在允许的存储卷内创建一个新文件夹；不覆盖已有内容。", risk: "write",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 }, name: { type: "string", minLength: 1, maxLength: 255 } }, required: ["path", "name"], additionalProperties: false }
  },
  {
    id: "files.rename", title: "重命名文件或文件夹", description: "在同一目录中重命名文件或文件夹；不覆盖已有目标。", risk: "write",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 }, name: { type: "string", minLength: 1, maxLength: 255 } }, required: ["path", "name"], additionalProperties: false }
  },
  {
    id: "files.move", title: "移动文件或文件夹", description: "将文件或文件夹移动到允许的存储卷内目标目录；不覆盖已有目标。", risk: "write",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 }, destination: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["path", "destination"], additionalProperties: false }
  },
  {
    id: "files.upload", title: "上传文件", description: "将 Base64 编码文件写入允许的存储卷；最大 1 MiB，不覆盖已有文件。", risk: "write",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 }, name: { type: "string", minLength: 1, maxLength: 255 }, contentBase64: { type: "string", maxLength: 1398104 } }, required: ["path", "name", "contentBase64"], additionalProperties: false }
  },
  {
    id: "files.create-text", title: "创建文本文件", description: "在允许的存储卷内创建 UTF-8 文本文件；最大 1 MiB，不覆盖已有文件。", risk: "write",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 }, name: { type: "string", minLength: 1, maxLength: 255 }, content: { type: "string", maxLength: 1048576 } }, required: ["path", "name", "content"], additionalProperties: false }
  },
  {
    id: "files.delete", title: "删除文件或空文件夹", description: "删除一个文件或空文件夹；不可通过此工具删除存储卷根目录。需要用户对具体目标二次确认。", risk: "destructive",
    inputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["path"], additionalProperties: false }
  }
];

function validArgs(args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const properties = schema.properties || {};
  if (schema.additionalProperties === false && Object.keys(args).some(key => !Object.hasOwn(properties, key))) return false;
  for (const key of schema.required || []) if (!Object.hasOwn(args, key)) return false;
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key]; if (!rule) return false;
    if (rule.type === "string" && (typeof value !== "string" || (rule.minLength && value.length < rule.minLength) || (rule.maxLength && value.length > rule.maxLength))) return false;
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) return false;
    if (rule.type === "integer" && (!Number.isInteger(value) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))) return false;
    if (rule.type === "boolean" && typeof value !== "boolean") return false;
  }
  return true;
}

export function createReadOnlyToolRegistry({ getDiagnostics, fileBrowser = null, fileManager = null, documentIndex = null, getScheduledHealthChecks = null, trimCli = null, executionPolicy = null }) {
  if (typeof getDiagnostics !== "function") throw new TypeError("getDiagnostics must be a function");

  function list() {
    return definitions.map(({ id, title, description, risk, inputSchema }) => ({
      id, title, description, risk,
      inputSchema: inputSchema || { type: "object", properties: {}, additionalProperties: false }
    }));
  }

  async function invoke(id, args = {}, options = {}) {
    const tool = definitions.find(item => item.id === id);
    if (!tool) throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
    if (!validArgs(args, tool.inputSchema || { type: "object", properties: {}, additionalProperties: false })) throw Object.assign(new Error("Invalid tool arguments"), { statusCode: 400 });
    const capability = options && typeof options === "object" ? options.capability : undefined;
    const approved = hasDeleteCapability(capability);
    // Global execution policy (read-only mode / kill switch). Every mutating tool
    // passes through here, no matter which entry point called invoke().
    if (executionPolicy && typeof executionPolicy.evaluate === "function") {
      const verdict = executionPolicy.evaluate({ risk: tool.risk, approved });
      if (verdict && !verdict.allowed) {
        if (verdict.reason === "approval-required")
          throw Object.assign(new Error("破坏性工具调用缺少服务端授权凭据（delete-capability），已拒绝执行。"), { statusCode: 403, reason: verdict.reason });
        throw Object.assign(new Error(`工具调用被执行策略拒绝（${verdict.reason}），已拒绝执行。`), { statusCode: verdict.statusCode || 403, reason: verdict.reason });
      }
    }
    if (tool.risk === "destructive" && !approved)
      throw Object.assign(new Error("破坏性工具调用缺少服务端授权凭据（delete-capability），已拒绝执行。"), { statusCode: 403, reason: "missing-capability" });
    if (tool.trimCliCommand) {
      if (!trimCli) throw Object.assign(new Error("Official fnOS CLI is unavailable"), { statusCode: 503 });
      return trimCli.runReadOnly(tool.trimCliCommand, args);
    }
    if (id === "files.list") {
      if (!fileBrowser) throw Object.assign(new Error("File browser is unavailable"), { statusCode: 503 });
      return fileBrowser.list(args.path || "", args.limit ?? 100);
    }
    if (id === "files.preview") {
      if (!fileManager) throw Object.assign(new Error("File preview is unavailable"), { statusCode: 503 });
      return fileManager.preview(args.path);
    }
    if (id === "files.search") {
      if (!fileBrowser || typeof fileBrowser.search !== "function") throw Object.assign(new Error("File search is unavailable"), { statusCode: 503 });
      return fileBrowser.search(args.path || "", args.query, args.limit ?? 50);
    }
    if (id === "files.search-content") {
      if (!fileBrowser || typeof fileBrowser.searchContent !== "function") throw Object.assign(new Error("File content search is unavailable"), { statusCode: 503 });
      return fileBrowser.searchContent(args.path || "", args.query, args.limit ?? 30);
    }
    if (id === "files.inspect") {
      if (!fileBrowser || typeof fileBrowser.inspect !== "function") throw Object.assign(new Error("File inspection is unavailable"), { statusCode: 503 });
      return fileBrowser.inspect(args.path || "", args.days ?? 90, args.minBytes ?? 1024 * 1024, args.limit ?? 10);
    }
    if (id === "media.photos.search") {
      if (!fileBrowser || typeof fileBrowser.searchPhotos !== "function") throw Object.assign(new Error("Local photo search is unavailable"), { statusCode: 503 });
      return fileBrowser.searchPhotos(args);
    }
    if (id === "documents.index-status") {
      if (!documentIndex) throw Object.assign(new Error("Local document index requires a configured app data directory"), { statusCode: 503 });
      return documentIndex.status();
    }
    if (id === "documents.search") {
      if (!documentIndex) throw Object.assign(new Error("Local document index requires a configured app data directory"), { statusCode: 503 });
      return documentIndex.search(args.query, args.limit ?? 10);
    }
    if (id === "documents.index-refresh") {
      if (!documentIndex) throw Object.assign(new Error("Local document index requires a configured app data directory"), { statusCode: 503 });
      return documentIndex.refresh({ force: args.force ?? false, maxFiles: args.maxFiles ?? 500 });
    }
    if (id.startsWith("health-checks.")) {
      const scheduler = typeof getScheduledHealthChecks === "function" ? getScheduledHealthChecks() : null;
      if (!scheduler) throw Object.assign(new Error("Scheduled health checks require a configured app data directory"), { statusCode: 503 });
      if (id === "health-checks.list") return scheduler.list();
      if (id === "health-checks.create") return scheduler.create(args);
      if (id === "health-checks.run") return scheduler.runNow(args.checkId);
      if (id === "health-checks.update") {
        const { checkId, ...update } = args;
        return scheduler.update(checkId, update);
      }
      if (id === "health-checks.delete") return scheduler.remove(args.checkId);
    }
    if (id === "files.create-folder") {
      if (!fileManager) throw Object.assign(new Error("File manager is unavailable"), { statusCode: 503 });
      return fileManager.operate({ action: "mkdir", path: args.path, name: args.name });
    }
    if (id === "files.rename") {
      if (!fileManager) throw Object.assign(new Error("File manager is unavailable"), { statusCode: 503 });
      return fileManager.operate({ action: "rename", path: args.path, name: args.name });
    }
    if (id === "files.move") {
      if (!fileManager) throw Object.assign(new Error("File manager is unavailable"), { statusCode: 503 });
      return fileManager.operate({ action: "move", path: args.path, destination: args.destination });
    }
    if (id === "files.upload") {
      if (!fileManager) throw Object.assign(new Error("File manager is unavailable"), { statusCode: 503 });
      const encoded = args.contentBase64;
      if (typeof encoded !== "string" || encoded.length > 1398104 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Object.assign(new Error("Invalid Base64 upload content"), { statusCode: 400 });
      const buffer = Buffer.from(encoded, "base64");
      if (buffer.length > 1024 * 1024 || buffer.toString("base64") !== encoded) throw Object.assign(new Error("Agent uploads are limited to 1 MiB"), { statusCode: 413 });
      return fileManager.upload(args.path, args.name, buffer);
    }
    if (id === "files.create-text") {
      if (!fileManager) throw Object.assign(new Error("File manager is unavailable"), { statusCode: 503 });
      return fileManager.createText(args.path, args.name, args.content);
    }
    if (id === "files.delete") {
      if (!fileManager) throw Object.assign(new Error("File manager is unavailable"), { statusCode: 503 });
      return fileManager.operate({ action: "delete", path: args.path, capability: DELETE_CAPABILITY });
    }
    const snapshot = await getDiagnostics();
    switch (id) {
      case "system.status":
        return { collectedAt: snapshot.collectedAt, system: snapshot.system, cpu: snapshot.cpu, memory: snapshot.memory };
      case "storage.summary":
        return { collectedAt: snapshot.collectedAt, storage: snapshot.storage };
      case "network.interfaces":
        return { collectedAt: snapshot.collectedAt, network: snapshot.network };
      case "system.process-summary":
        return { collectedAt: snapshot.collectedAt, processes: snapshot.processes || { available: false } };
      default:
        throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
    }
  }

  return Object.freeze({ list, invoke });
}
