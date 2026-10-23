/**
 * 备份前检查（Phase 217）。
 *
 * 这个模块只做判定，不采集、不写盘、不发网络请求：把「现在能不能安心开一次备份」
 * 拆成一条条可解释的检查项，输入是别处已经采好的只读数据（系统快照、容量趋势、
 * 服务状态、SMART、诊断结论）。所有阈值都可以由调用方覆盖，默认值取偏保守的方案。
 *
 * 设计口径：
 * - 每项检查都有确定的状态：ok / warn / blocked / unknown。unknown 不等于 ok，
 *   它表示「没有证据」，在报告里必须被看见。
 * - 只有明确的危险才 blocked（只读挂载、可用空间见底、SMART 已失效）；
 * - 其余降级成 warn，附上可执行的建议，不阻止用户备份。
 * - 不猜字段：输入里的形状都做窄范围归一化，缺字段就是 unknown。
 */

export const BACKUP_CHECK_IDS = Object.freeze([
  "storage-visibility",
  "free-space",
  "read-only-volumes",
  "capacity-trend",
  "failed-units",
  "smart-health",
  "diagnostics"
]);

export const BACKUP_PRECHECK_DEFAULTS = Object.freeze({
  /** 低于该可用比例算「空间偏紧」（warn）。 */
  warnFreeRatio: 0.15,
  /** 低于该可用比例算「空间见底」（blocked）。 */
  blockFreeRatio: 0.05,
  /** 预计还能写多少天以内开始告警。 */
  warnDaysToFull: 30,
  /** 预计还能写多少天以内直接判不可备份。 */
  blockDaysToFull: 7
});

const CHECK_TITLES = Object.freeze({
  "storage-visibility": "存储可见性",
  "free-space": "可用空间",
  "read-only-volumes": "只读挂载",
  "capacity-trend": "容量趋势",
  "failed-units": "系统服务",
  "smart-health": "磁盘健康",
  diagnostics: "近期诊断"
});

const CORE_UNITS = Object.freeze(["filestor_service", "network_service", "trim_file_monitor"]);

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}

function percent(value) {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.min(100, Math.max(0, parsed));
}

/**
 * 把快照里的 storage 段归一化成「卷/盘」列表。两种来源都认：
 * - `values.disks`（monitor.disk 采集到的盘）
 * - `values.volumes`（卷视角）
 */
export function readStorageEntries(snapshot) {
  const sections = toArray(toPlainObject(snapshot).sections);
  const storage = sections.find(section => text(toPlainObject(section).id) === "storage");
  const values = toPlainObject(toPlainObject(storage).values);
  const entries = [];
  for (const item of toArray(values.disks)) {
    const record = toPlainObject(item);
    const name = text(record.name) || text(record.mount) || text(record.device) || "磁盘";
    entries.push({
      name,
      totalBytes: numberOrNull(record.totalBytes ?? record.total ?? record.sizeBytes),
      usedBytes: numberOrNull(record.usedBytes ?? record.used),
      freeRatio: percent(record.freePercent ?? record.freeRatio),
      readOnly: booleanOrNull(record.readOnly ?? record.ro),
      source: "disk"
    });
  }
  for (const item of toArray(values.volumes)) {
    const record = toPlainObject(item);
    const name = text(record.mount) || text(record.name) || "卷";
    entries.push({
      name,
      totalBytes: numberOrNull(record.totalBytes ?? record.total),
      usedBytes: numberOrNull(record.usedBytes ?? record.used),
      freeRatio: percent(record.freePercent ?? record.freeRatio),
      readOnly: booleanOrNull(record.readOnly ?? record.ro),
      source: "volume"
    });
  }
  return entries;
}

function freeRatioOf(entry) {
  if (Number.isFinite(entry.freeRatio)) return entry.freeRatio / 100;
  if (Number.isFinite(entry.totalBytes) && entry.totalBytes > 0 && Number.isFinite(entry.usedBytes)) {
    return Math.max(0, (entry.totalBytes - entry.usedBytes) / entry.totalBytes);
  }
  return null;
}

function check(id, status, detail, extra = {}) {
  return { id, title: CHECK_TITLES[id] || id, status, detail, ...extra };
}

function storageVisibilityCheck(entries) {
  if (!entries.length) {
    return check(
      "storage-visibility",
      "unknown",
      "系统快照里没有存储数据，无法判断可用空间——请先刷新系统快照再体检。",
      { evidence: { source: "system.snapshot.storage" } }
    );
  }
  return check("storage-visibility", "ok", `已读取 ${entries.length} 个存储目标。`, {
    evidence: { targets: entries.map(entry => entry.name).slice(0, 12) }
  });
}

function freeSpaceCheck(entries, thresholds) {
  const measured = entries.filter(entry => Number.isFinite(freeRatioOf(entry)));
  if (!measured.length) {
    return check("free-space", "unknown", "没有可用的空间百分比数据，无法评估剩余容量。");
  }
  const blocked = measured.filter(entry => freeRatioOf(entry) < thresholds.blockFreeRatio);
  const warned = measured.filter(entry => {
    const ratio = freeRatioOf(entry);
    return ratio >= thresholds.blockFreeRatio && ratio < thresholds.warnFreeRatio;
  });
  const describe = list => list.map(entry => `${entry.name} ${Math.round(freeRatioOf(entry) * 100)}%`).join("、");
  if (blocked.length) {
    return check("free-space", "blocked", `可用空间见底：${describe(blocked)}。请先清理后再备份。`, {
      evidence: { blocked: blocked.map(entry => entry.name), warn: warned.map(entry => entry.name) }
    });
  }
  if (warned.length) {
    return check("free-space", "warn", `可用空间偏紧：${describe(warned)}。备份可能写满目标卷。`, {
      evidence: { warn: warned.map(entry => entry.name) }
    });
  }
  return check("free-space", "ok", "各存储目标可用空间均在阈值以上。", {
    evidence: { measured: measured.length }
  });
}

function readOnlyCheck(entries) {
  if (!entries.length) {
    return check("read-only-volumes", "unknown", "没有存储数据，无法确认挂载读写状态。");
  }
  const readOnly = entries.filter(entry => entry.readOnly === true);
  const unknown = entries.filter(entry => entry.readOnly === null);
  if (readOnly.length) {
    return check("read-only-volumes", "blocked", `存在只读挂载：${readOnly.map(entry => entry.name).join("、")}。只读卷上的备份目标不可写入。`, {
      evidence: { readOnly: readOnly.map(entry => entry.name) }
    });
  }
  if (unknown.length && unknown.length === entries.length) {
    return check("read-only-volumes", "unknown", "存储数据里没有只读标志，无法确认挂载状态。");
  }
  return check("read-only-volumes", "ok", "没有发现只读挂载。", {
    evidence: { unknown: unknown.map(entry => entry.name).slice(0, 12) }
  });
}

function capacityTrendCheck(capacity, thresholds) {
  const trends = toArray(toPlainObject(capacity).trends);
  if (!trends.length) {
    return check("capacity-trend", "unknown", "没有容量趋势样本（需要先积累历史采点），无法预测写满时间。");
  }
  const forecast = trends
    .map(item => {
      const record = toPlainObject(item);
      return {
        name: text(record.name) || text(record.mount) || "卷",
        daysToFull: numberOrNull(record.daysToFull ?? record.daysRemaining)
      };
    })
    .filter(item => Number.isFinite(item.daysToFull));
  if (!forecast.length) {
    return check("capacity-trend", "unknown", "趋势样本不足，无法给出写满时间。", { evidence: { samples: trends.length } });
  }
  const soonest = forecast.reduce((left, right) => (left.daysToFull <= right.daysToFull ? left : right));
  if (soonest.daysToFull <= thresholds.blockDaysToFull) {
    return check("capacity-trend", "blocked", `按当前增长速度，${soonest.name} 约 ${Math.max(0, Math.round(soonest.daysToFull))} 天后写满，不适合立刻开始备份。`, {
      evidence: { name: soonest.name, daysToFull: soonest.daysToFull }
    });
  }
  if (soonest.daysToFull <= thresholds.warnDaysToFull) {
    return check("capacity-trend", "warn", `按当前增长速度，${soonest.name} 约 ${Math.round(soonest.daysToFull)} 天后写满，建议先规划空间。`, {
      evidence: { name: soonest.name, daysToFull: soonest.daysToFull }
    });
  }
  return check("capacity-trend", "ok", `最早写满的是 ${soonest.name}，约 ${Math.round(soonest.daysToFull)} 天后。`, {
    evidence: { name: soonest.name, daysToFull: soonest.daysToFull }
  });
}

function failedUnitsCheck(services) {
  const units = toArray(toPlainObject(services).units).map(item => toPlainObject(item));
  if (!units.length) {
    return check("failed-units", "unknown", "没有服务状态数据，无法确认关键服务是否健康。");
  }
  const failed = units.filter(unit => {
    const state = text(unit.activeState || unit.active || unit.state).toLowerCase();
    return state === "failed" || unit.failed === true;
  });
  const failedCore = failed.filter(unit => CORE_UNITS.includes(text(unit.name) || text(unit.unit)));
  if (failedCore.length) {
    return check("failed-units", "warn", `关键服务处于失败状态：${failedCore.map(unit => text(unit.name) || text(unit.unit)).join("、")}。备份可能中途失败。`, {
      evidence: { failedCore: failedCore.map(unit => text(unit.name) || text(unit.unit)) }
    });
  }
  if (failed.length) {
    return check("failed-units", "warn", `${failed.length} 个服务处于失败状态：${failed.map(unit => text(unit.name) || text(unit.unit)).slice(0, 6).join("、")}。`, {
      evidence: { failed: failed.map(unit => text(unit.name) || text(unit.unit)).slice(0, 12) }
    });
  }
  return check("failed-units", "ok", "关键服务均在正常运行。", { evidence: { units: units.length } });
}

function smartCheck(smart) {
  const devices = toArray(toPlainObject(smart).devices).map(item => toPlainObject(item));
  if (!devices.length) {
    return check("smart-health", "unknown", "没有 SMART 数据（可能需要把磁盘采集打开），无法确认磁盘健康。");
  }
  const failing = devices.filter(device => {
    const health = text(device.health || device.healthStatus || device.status).toLowerCase();
    return health === "failing" || health === "failed" || health === "critical" || device.failing === true;
  });
  const warned = devices.filter(device => {
    const health = text(device.health || device.healthStatus || device.status).toLowerCase();
    return health === "warning" || health === "warn" || device.warning === true;
  });
  if (failing.length) {
    return check("smart-health", "blocked", `有磁盘 SMART 报失效：${failing.map(device => text(device.device) || text(device.name) || "磁盘").join("、")}。先备份到别处再动盘。`, {
      evidence: { failing: failing.map(device => text(device.device) || text(device.name) || "磁盘") }
    });
  }
  if (warned.length) {
    return check("smart-health", "warn", `有磁盘 SMART 报预警：${warned.map(device => text(device.device) || text(device.name) || "磁盘").join("、")}。`, {
      evidence: { warned: warned.map(device => text(device.device) || text(device.name) || "磁盘") }
    });
  }
  return check("smart-health", "ok", `${devices.length} 块磁盘的 SMART 结论正常。`, { evidence: { devices: devices.length } });
}

function diagnosticsCheck(diagnostics) {
  const report = toPlainObject(diagnostics);
  const findings = toArray(report.findings).map(item => toPlainObject(item));
  const escalation = toPlainObject(report.escalation);
  if (!findings.length && !Object.keys(escalation).length) {
    return check("diagnostics", "unknown", "还没有近期的诊断报告，缺少故障线索。");
  }
  if (escalation.required === true) {
    const reasons = toArray(escalation.reasons).map(item => text(toPlainObject(item).detail) || text(item)).filter(Boolean);
    return check("diagnostics", "warn", `近期诊断要求人工确认：${reasons.slice(0, 3).join("；") || "存在需要升级处理的结论"}。`, {
      evidence: { reasons: reasons.slice(0, 5) }
    });
  }
  const critical = findings.filter(item => text(item.severity).toLowerCase() === "critical");
  if (critical.length) {
    return check("diagnostics", "warn", `近期诊断有 ${critical.length} 条严重结论，建议先处理再备份。`, {
      evidence: { critical: critical.length }
    });
  }
  return check("diagnostics", "ok", `近期诊断 ${findings.length} 条，均不需要升级处理。`, { evidence: { findings: findings.length } });
}

function normalizeOptions(options) {
  const source = toPlainObject(options);
  const pick = (key, fallback) => {
    const value = numberOrNull(source[key]);
    return value === null ? fallback : value;
  };
  return {
    warnFreeRatio: Math.min(0.9, Math.max(0.01, pick("warnFreeRatio", BACKUP_PRECHECK_DEFAULTS.warnFreeRatio))),
    blockFreeRatio: Math.min(0.9, Math.max(0.01, pick("blockFreeRatio", BACKUP_PRECHECK_DEFAULTS.blockFreeRatio))),
    warnDaysToFull: Math.max(1, pick("warnDaysToFull", BACKUP_PRECHECK_DEFAULTS.warnDaysToFull)),
    blockDaysToFull: Math.max(0.5, pick("blockDaysToFull", BACKUP_PRECHECK_DEFAULTS.blockDaysToFull))
  };
}

/**
 * 生成备份前检查报告。
 *
 * @param {{snapshot?: object, capacity?: object, services?: object, smart?: object, diagnostics?: object}} [input]
 * @param {object} [options] 阈值覆盖（warnFreeRatio / blockFreeRatio / warnDaysToFull / blockDaysToFull）
 * @returns {{verdict: string, checks: object[], summary: object, actions: string[]}}
 */
export function buildBackupPrecheck(input = {}, options = {}) {
  const source = toPlainObject(input);
  const thresholds = normalizeOptions(options);
  const entries = readStorageEntries(source.snapshot);

  const checks = [
    storageVisibilityCheck(entries),
    freeSpaceCheck(entries, thresholds),
    readOnlyCheck(entries),
    capacityTrendCheck(source.capacity, thresholds),
    failedUnitsCheck(source.services),
    smartCheck(source.smart),
    diagnosticsCheck(source.diagnostics)
  ];

  const summary = { ok: 0, warn: 0, blocked: 0, unknown: 0 };
  for (const item of checks) summary[item.status] += 1;

  const verdict = summary.blocked > 0 ? "blocked" : summary.warn > 0 ? "warn" : summary.unknown === checks.length ? "unknown" : "ready";

  const actions = [];
  for (const item of checks) {
    if (item.status === "blocked") actions.push(`处理「${item.title}」：${item.detail}`);
    else if (item.status === "warn") actions.push(`留意「${item.title}」：${item.detail}`);
    else if (item.status === "unknown") actions.push(`补采「${item.title}」数据后复查。`);
  }

  return {
    verdict,
    thresholds,
    checks,
    summary,
    actions: actions.slice(0, 8)
  };
}
