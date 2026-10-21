const definitions = [
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
    if (rule.type === "integer" && (!Number.isInteger(value) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))) return false;
  }
  return true;
}

export function createReadOnlyToolRegistry({ getDiagnostics, fileBrowser = null, fileManager = null }) {
  if (typeof getDiagnostics !== "function") throw new TypeError("getDiagnostics must be a function");

  function list() {
    return definitions.map(({ id, title, description, risk, inputSchema }) => ({
      id, title, description, risk,
      inputSchema: inputSchema || { type: "object", properties: {}, additionalProperties: false }
    }));
  }

  async function invoke(id, args = {}) {
    const tool = definitions.find(item => item.id === id);
    if (!tool) throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
    if (!validArgs(args, tool.inputSchema || { type: "object", properties: {}, additionalProperties: false })) throw Object.assign(new Error("Invalid tool arguments"), { statusCode: 400 });
    if (id === "files.list") {
      if (!fileBrowser) throw Object.assign(new Error("File browser is unavailable"), { statusCode: 503 });
      return fileBrowser.list(args.path || "", args.limit ?? 100);
    }
    if (id === "files.preview") {
      if (!fileManager) throw Object.assign(new Error("File preview is unavailable"), { statusCode: 503 });
      return fileManager.preview(args.path);
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
