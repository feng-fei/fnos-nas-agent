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
  }
];

function emptyArgs(args) {
  return args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0;
}

export function createReadOnlyToolRegistry({ getDiagnostics }) {
  if (typeof getDiagnostics !== "function") throw new TypeError("getDiagnostics must be a function");

  function list() {
    return definitions.map(({ id, title, description, risk }) => ({
      id,
      title,
      description,
      risk,
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    }));
  }

  async function invoke(id, args = {}) {
    const tool = definitions.find(item => item.id === id);
    if (!tool) throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
    if (!emptyArgs(args)) throw Object.assign(new Error("This read-only tool accepts no arguments"), { statusCode: 400 });

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
