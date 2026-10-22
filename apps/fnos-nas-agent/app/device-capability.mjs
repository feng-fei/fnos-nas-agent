/**
 * 设备能力体检：把「这台机器能不能承载某个负载」拆成逐维度判定。
 *
 * 这个语义来自运行中的 Marvis（`MarvisAgent.GetDeviceCondition`）：它不返回一个
 * 模糊的分数，而是给出每一个维度的 required 与 passed，前端据此解释「为什么不行」。
 * 我们保留这个形状，但门槛值改成自己需要的两档，且所有判定都是纯函数。
 */

export const DEVICE_PROFILES = Object.freeze({
  "agent-host": Object.freeze({
    id: "agent-host",
    title: "NAS Agent 自身",
    description: "跑本仓库的常驻服务与只读工具所需的最低条件。",
    requirements: Object.freeze({
      platform: "linux",
      archBits: 64,
      cpuCores: 2,
      memoryBytes: 2 * 1024 ** 3,
      storageType: "any"
    })
  }),
  "local-llm": Object.freeze({
    id: "local-llm",
    title: "本地大模型",
    description: "在 NAS 上直接跑本地模型推理所需的参考门槛（Marvis 实测口径）。",
    requirements: Object.freeze({
      platform: "linux",
      archBits: 64,
      cpuCores: 8,
      memoryBytes: 16 * 1024 ** 3,
      storageType: "ssd"
    })
  })
});

export const DEVICE_DIMENSION_ORDER = Object.freeze([
  "platform",
  "architecture",
  "cpu_cores",
  "memory",
  "storage_type"
]);

const DIMENSION_LABELS = Object.freeze({
  platform: "操作系统",
  architecture: "架构",
  cpu_cores: "CPU 核心数",
  memory: "内存",
  storage_type: "系统盘类型"
});

/** 判定为「不通过」即整体不可用的维度（其余维度只影响体验，不影响能否启动）。 */
const CRITICAL_DIMENSIONS = Object.freeze(["platform", "architecture"]);

function toNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatGiB(bytes) {
  if (bytes === null) return "未知";
  const gib = bytes / 1024 ** 3;
  return `${gib >= 10 ? Math.round(gib) : Math.round(gib * 10) / 10} GB`;
}

function bitness(arch) {
  const value = String(arch || "").toLowerCase();
  if (["x64", "amd64", "arm64", "aarch64"].includes(value)) return 64;
  if (["ia32", "arm", "x86"].includes(value)) return 32;
  return null;
}

/**
 * @param {object} env
 * @param {string} [env.platform] process.platform
 * @param {string} [env.arch] process.arch
 * @param {number} [env.cpuCores] os.cpus().length
 * @param {number} [env.totalMemoryBytes] os.totalmem()
 * @param {string} [env.storageType] "ssd" | "hdd" | "unknown"（拿不到就留空）
 * @param {object} [options]
 * @param {"agent-host"|"local-llm"} [options.profile="agent-host"]
 */
export function evaluateDeviceCapabilities(env = {}, { profile = "agent-host" } = {}) {
  const selected = DEVICE_PROFILES[profile] || DEVICE_PROFILES["agent-host"];
  const { requirements } = selected;

  const actualPlatform = typeof env.platform === "string" ? env.platform.toLowerCase() : "";
  const actualBits = bitness(env.arch);
  const actualCores = toNumber(env.cpuCores);
  const actualMemory = toNumber(env.totalMemoryBytes);
  const actualStorage = typeof env.storageType === "string" ? env.storageType.toLowerCase() : "";

  const dimensions = [];

  dimensions.push({
    id: "platform",
    label: DIMENSION_LABELS.platform,
    required: requirements.platform,
    actual: actualPlatform || "unknown",
    passed: actualPlatform === "" ? null : actualPlatform === requirements.platform
  });

  dimensions.push({
    id: "architecture",
    label: DIMENSION_LABELS.architecture,
    required: `${requirements.archBits} 位`,
    actual: actualBits === null ? "unknown" : `${actualBits} 位`,
    passed: actualBits === null ? null : actualBits === requirements.archBits
  });

  dimensions.push({
    id: "cpu_cores",
    label: DIMENSION_LABELS.cpu_cores,
    required: `≥ ${requirements.cpuCores} 核`,
    actual: actualCores === null ? "未知" : `${actualCores} 核`,
    passed: actualCores === null ? null : actualCores >= requirements.cpuCores
  });

  dimensions.push({
    id: "memory",
    label: DIMENSION_LABELS.memory,
    required: `≥ ${formatGiB(requirements.memoryBytes)}`,
    actual: formatGiB(actualMemory),
    passed: actualMemory === null ? null : actualMemory >= requirements.memoryBytes
  });

  const storageRequired = requirements.storageType === "any" ? "不限" : requirements.storageType === "ssd" ? "固态硬盘" : requirements.storageType;
  const storageKnown = ["ssd", "hdd", "nvme", "emmc"].includes(actualStorage);
  dimensions.push({
    id: "storage_type",
    label: DIMENSION_LABELS.storage_type,
    required: storageRequired,
    actual: storageKnown ? actualStorage : "未知",
    passed: requirements.storageType === "any"
      ? true
      : storageKnown
        ? (requirements.storageType === "ssd" ? ["ssd", "nvme"].includes(actualStorage) : true)
        : null
  });

  const failedCritical = dimensions.filter((item) => CRITICAL_DIMENSIONS.includes(item.id) && item.passed === false);
  const failedSoft = dimensions.filter((item) => !CRITICAL_DIMENSIONS.includes(item.id) && item.passed === false);
  const unknown = dimensions.filter((item) => item.passed === null);

  const verdict = failedCritical.length > 0
    ? "not-ready"
    : failedSoft.length > 0 || unknown.length > 0
      ? "partial"
      : "ready";

  const passed = dimensions.filter((item) => item.passed === true).length;
  const recommendation = verdict === "ready"
    ? (selected.id === "local-llm"
      ? "这台机器达到本地模型参考门槛；是否真的开启仍建议先用小模型试跑。"
      : "这台机器满足 NAS Agent 的运行条件。")
    : failedCritical.length > 0
      ? `不满足硬性条件（${failedCritical.map((item) => item.label).join("、")}），该负载无法运行。`
      : `可以运行，但 ${[...failedSoft.map((item) => item.label), ...unknown.map((item) => `${item.label}（未知）`)].join("、")} 未达标或未知，性能与体验可能受限。`;

  return {
    profile: selected.id,
    title: selected.title,
    verdict,
    passed,
    total: dimensions.length,
    dimensions: DEVICE_DIMENSION_ORDER
      .map((id) => dimensions.find((item) => item.id === id))
      .filter(Boolean),
    recommendation
  };
}

/** 从 `os` 模块的几个取值组装体检输入，避免调用方各处重复。 */
export function deviceEnvironment({ platform, arch, cpuCores, totalMemoryBytes, storageType } = {}) {
  return {
    platform: typeof platform === "string" ? platform : "",
    arch: typeof arch === "string" ? arch : "",
    cpuCores: toNumber(cpuCores),
    totalMemoryBytes: toNumber(totalMemoryBytes),
    storageType: typeof storageType === "string" ? storageType : ""
  };
}
