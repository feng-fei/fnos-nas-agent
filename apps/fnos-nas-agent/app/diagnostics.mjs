/**
 * Phase 162 — 故障诊断与根因候选（模块 03「AI 故障诊断与自动修复」）
 *
 * 纯函数模块：不调用模型、不做任何 I/O、不依赖第三方包。
 * 输入是"已经采集好的证据"，输出是分类、根因候选、置信度与只读诊断报告。
 *
 * 覆盖用户功能清单编号：
 *   D01 故障问诊   —— classifyEvidence / buildDiagnosticReport(symptom)
 *   D03 故障分类   —— classifyEvidence
 *   D04 根因候选   —— rankCauses
 *   D05 置信度说明 —— confidence 字段 + 报告中的置信度说明段
 *   D07 只读诊断   —— readOnlyChecks / checks
 *   D12 故障报告   —— buildDiagnosticReport().report
 *
 * 红线：
 *   - 不把"重启所有服务"当通用修复策略；
 *   - 磁盘故障 / 阵列降级场景不得给出扩大损失的操作建议；
 *   - 任何破坏性动作只能以"需人工审批后执行"表述。
 */

/** 故障分类（枚举，顺序即优先级/默认顺序）。 */
export const DIAGNOSTIC_CATEGORIES = Object.freeze([
  "storage",
  "network",
  "resource",
  "permission",
  "application"
]);

/** 置信度等级，顺序由强到弱。 */
export const DIAGNOSTIC_CONFIDENCE_LEVELS = Object.freeze([
  "confirmed",
  "likely",
  "suspected"
]);

const CONFIDENCE_RANK = Object.freeze({ confirmed: 3, likely: 2, suspected: 1 });

/** 证据明细最大保留长度（避免报告里塞进整段日志）。 */
const MAX_DETAIL_LENGTH = 200;

/* ------------------------------------------------------------------ *
 * 分类信号
 * ------------------------------------------------------------------ */

const CATEGORY_SIGNALS = Object.freeze([
  {
    category: "storage",
    strong: [
      /\bSMART\b/i,
      /mdadm/i,
      /\bRAID\b/i,
      /\bI\/O error\b/i,
      /\bEIO\b/,
      /ENOSPC/i,
      /no space left on device/i,
      /read-only file system/i,
      /degraded/i,
      /bad sector/i
    ],
    moderate: [/\bdisk\b/i, /\bfilesystem\b/i, /\bmount\b/i, /\bvolume\b/i, /\bstorage\b/i, /\bext4\b/i, /\bxfs\b/i, /\bbtrfs\b/i, /\bzfs\b/i, /磁盘|阵列|存储|文件系统/i]
  },
  {
    category: "network",
    strong: [
      /NXDOMAIN/i,
      /Could not resolve host/i,
      /Temporary failure in name resolution/i,
      /Network is unreachable/i,
      /No route to host/i,
      /Connection refused/i,
      /Connection timed out/i,
      /packet loss/i
    ],
    moderate: [/\bDNS\b/i, /\bgateway\b/i, /\binterface\b/i, /\blink\b/i, /\bethernet\b/i, /域名|网关|链路|网络/i]
  },
  {
    category: "resource",
    strong: [/\bOOM\b/i, /Out of memory/i, /oom-kill/i, /Killed process/i, /load average/i, /\bCPU\b/i],
    moderate: [/\bmemory\b/i, /\bswap\b/i, /\bload\b/i, /\bCPU\b/i, /内存|负载|交换分区/i]
  },
  {
    category: "permission",
    strong: [/Permission denied/i, /\bEACCES\b/, /\bEPERM\b/, /Operation not permitted/i, /\b401\b/, /\b403\b/, /Unauthorized/i, /Forbidden/i],
    moderate: [/\bpermission\b/i, /\baccess denied\b/i, /权限|鉴权/i]
  },
  {
    category: "application",
    strong: [/CrashLoopBackOff/i, /no such image/i, /manifest unknown/i, /segmentation fault/i, /core dumped/i, /\bpanic:/i, /exit code \d+/i],
    moderate: [/\bcontainer\b/i, /\bdocker\b/i, /\bimage\b/i, /\bservice\b/i, /\bcrash\b/i, /容器|镜像|服务/i]
  }
]);

/* ------------------------------------------------------------------ *
 * 根因候选规则
 * ------------------------------------------------------------------ */

const CAUSE_RULES = Object.freeze([
  {
    id: "storage-disk-failure",
    title: "磁盘介质或控制器失效（SMART 报错 / IO 错误）",
    category: "storage",
    escalation: true,
    signals: [
      { strength: "strong", pattern: /SMART[^\n]{0,80}(fail|failed|failure|attribute[^\n]{0,40}fail)/i },
      { strength: "strong", pattern: /reallocated[^\n]{0,40}sector/i },
      { strength: "strong", pattern: /uncorrectable/i },
      { strength: "strong", pattern: /\bI\/O error\b/i },
      { strength: "strong", pattern: /\bEIO\b/ },
      { strength: "strong", pattern: /bad sector/i },
      { strength: "moderate", pattern: /\bSMART\b/i },
      { strength: "moderate", pattern: /\bdisks?\b/i }
    ],
    checks: [
      "采集 SMART 全量属性（smartctl -a /dev/<disk>）",
      "读取内核日志中的 ATA/SCSI 错误计数（dmesg）",
      "查看 /proc/diskstats 与 iostat 采样"
    ]
  },
  {
    id: "storage-array-degraded",
    title: "RAID 阵列降级 / 成员失效",
    category: "storage",
    escalation: true,
    signals: [
      { strength: "strong", pattern: /degraded/i },
      { strength: "strong", pattern: /md\d+[^\n]{0,60}(inactive|failed|removed)/i },
      { strength: "strong", pattern: /rebuild[^\n]{0,60}(fail|abort)/i },
      { strength: "moderate", pattern: /mdadm/i },
      { strength: "moderate", pattern: /\bRAID\b/i },
      { strength: "moderate", pattern: /阵列/i }
    ],
    checks: [
      "查看阵列状态与成员角色（cat /proc/mdstat）",
      "读取阵列事件计数与成员设备状态（/sys/block/<md>/md/）",
      "查看最近一次重建进度与速率"
    ]
  },
  {
    id: "storage-capacity-exhausted",
    title: "容量或 inode / 配额耗尽",
    category: "storage",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /no space left on device/i },
      { strength: "strong", pattern: /\bENOSPC\b/ },
      { strength: "strong", pattern: /quota exceeded/i },
      { strength: "strong", pattern: /disk (is )?full/i },
      { strength: "moderate", pattern: /\binode\b/i },
      { strength: "moderate", pattern: /capacity|空间/i }
    ],
    checks: [
      "查看挂载点容量与 inode 使用率（df -h / df -i）",
      "读取配额使用情况（quota / report）",
      "统计增长最快的目录（du -x -d 1）"
    ]
  },
  {
    id: "storage-mount-failure",
    title: "文件系统挂载异常 / 只读重挂",
    category: "storage",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /remount[^\n]{0,40}read-only/i },
      { strength: "strong", pattern: /\bEXT4-fs error\b/i },
      { strength: "strong", pattern: /\bXFS\b[^\n]{0,40}(error|corrupt)/i },
      { strength: "strong", pattern: /mount[^\n]{0,40}failed/i },
      { strength: "moderate", pattern: /\bmount\b/i },
      { strength: "moderate", pattern: /filesystem/i }
    ],
    checks: [
      "查看挂载状态与最近挂载错误（findmnt / mount）",
      "读取只读重挂原因（dmesg | grep -i remount）",
      "核对文件系统错误日志（dmesg | grep -i 'ext4\\|xfs'）"
    ]
  },
  {
    id: "network-dns-resolution",
    title: "DNS 解析失败",
    category: "network",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /Could not resolve host/i },
      { strength: "strong", pattern: /Temporary failure in name resolution/i },
      { strength: "strong", pattern: /\bNXDOMAIN\b/i },
      { strength: "strong", pattern: /name resolution[^\n]{0,40}fail/i },
      { strength: "moderate", pattern: /\bDNS\b/i },
      { strength: "moderate", pattern: /resolve/i }
    ],
    checks: [
      "读取 DNS 配置（resolv.conf）",
      "在目标主机上做解析测试（getent hosts / dig，只读）",
      "查看解析器近期错误日志"
    ]
  },
  {
    id: "network-connectivity",
    title: "网络不可达 / 路由缺失",
    category: "network",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /Network is unreachable/i },
      { strength: "strong", pattern: /No route to host/i },
      { strength: "strong", pattern: /Destination Host Unreachable/i },
      { strength: "strong", pattern: /connect[^\n]{0,40}timed out/i },
      { strength: "moderate", pattern: /gateway|route/i },
      { strength: "moderate", pattern: /网络不可达|路由/i }
    ],
    checks: [
      "采集路由表与接口状态（ip route / ip -s link）",
      "对目标做连通性探测（ping -c，不改状态）",
      "查看网卡协商速率与错误计数（ethtool）"
    ]
  },
  {
    id: "network-port-unavailable",
    title: "目标端口未监听 / 连接被拒",
    category: "network",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /Connection refused/i },
      { strength: "strong", pattern: /\bECONNREFUSED\b/ },
      { strength: "moderate", pattern: /\bport\b/i },
      { strength: "moderate", pattern: /端口/i }
    ],
    checks: [
      "读取监听端口列表（ss -lnt）",
      "确认目标端口是否有进程在监听（ss -lntp）",
      "查看防火墙规则状态（iptables -S / nft list ruleset）"
    ]
  },
  {
    id: "network-link-quality",
    title: "链路质量劣化（丢包 / 协商速率下降）",
    category: "network",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /packet loss/i },
      { strength: "strong", pattern: /link (is )?down/i },
      { strength: "strong", pattern: /carrier lost/i },
      { strength: "moderate", pattern: /\binterface\b/i },
      { strength: "moderate", pattern: /\bethernet\b/i },
      { strength: "moderate", pattern: /链路|丢包/i }
    ],
    checks: [
      "采集网卡错误与丢包计数（ip -s link / ethtool -S）",
      "读取链路协商信息（ethtool）",
      "查看链路 up/down 事件日志"
    ]
  },
  {
    id: "resource-memory-pressure",
    title: "内存压力 / OOM 触发进程被杀",
    category: "resource",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /Out of memory/i },
      { strength: "strong", pattern: /\bOOM\b/i },
      { strength: "strong", pattern: /oom-kill/i },
      { strength: "strong", pattern: /Killed process/i },
      { strength: "moderate", pattern: /\bmemory\b/i },
      { strength: "moderate", pattern: /内存/i }
    ],
    checks: [
      "读取内存与 swap 使用率（free -m / /proc/meminfo）",
      "查看 OOM 记录（dmesg | grep -i oom）",
      "统计进程内存占用（ps aux --sort=-%mem）"
    ]
  },
  {
    id: "resource-cpu-saturation",
    title: "CPU 饱和 / 负载尖峰",
    category: "resource",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /load average[^\n]{0,40}\b(1[5-9]|[2-9]\d)\.\d+/i },
      { strength: "strong", pattern: /CPU[^\n]{0,40}100%/i },
      { strength: "moderate", pattern: /load average/i },
      { strength: "moderate", pattern: /\bCPU\b/i },
      { strength: "moderate", pattern: /负载/i }
    ],
    checks: [
      "采集负载与 CPU 使用率（uptime / top -bn1）",
      "统计进程 CPU 占用（ps aux --sort=-%cpu）",
      "查看容器 CPU 限额与实际使用（docker stats --no-stream）"
    ]
  },
  {
    id: "resource-swap-thrashing",
    title: "交换分区抖动",
    category: "resource",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /swap[^\n]{0,40}(thrash|exhaust)/i },
      { strength: "moderate", pattern: /\bswap\b/i },
      { strength: "moderate", pattern: /交换分区/i }
    ],
    checks: [
      "读取换页统计（vmstat 1 5）",
      "查看 swap 使用量（free -m / cat /proc/swaps）",
      "统计换入换出速率（sar -W）"
    ]
  },
  {
    id: "permission-access-denied",
    title: "文件系统访问被拒绝",
    category: "permission",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /Permission denied/i },
      { strength: "strong", pattern: /\bEACCES\b/ },
      { strength: "strong", pattern: /Operation not permitted/i },
      { strength: "strong", pattern: /\bEPERM\b/ },
      { strength: "moderate", pattern: /权限/i }
    ],
    checks: [
      "确认进程身份与属主（id / ls -l）",
      "查看目标路径权限位与 ACL（namei -l / getfacl）",
      "核对挂载点是否只读（findmnt -o OPTIONS）"
    ]
  },
  {
    id: "permission-authentication-failed",
    title: "鉴权失败 / 凭据无效",
    category: "permission",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /Unauthorized/i },
      { strength: "strong", pattern: /Forbidden/i },
      { strength: "strong", pattern: /\b401\b/ },
      { strength: "strong", pattern: /\b403\b/ },
      { strength: "strong", pattern: /authentication (failed|required)/i },
      { strength: "moderate", pattern: /\bauth\b/i },
      { strength: "moderate", pattern: /鉴权|凭据/i }
    ],
    checks: [
      "查看认证失败日志（journalctl / 业务日志）",
      "确认凭据来源与有效期（只读，不回显密钥）",
      "读取服务账户与角色配置（只读）"
    ]
  },
  {
    id: "application-container-crash",
    title: "容器反复崩溃 / 启动失败",
    category: "application",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /CrashLoopBackOff/i },
      { strength: "strong", pattern: /container[^\n]{0,60}(exited|dead)/i },
      { strength: "strong", pattern: /CannotStartContainerError/i },
      { strength: "moderate", pattern: /\bcontainer\b/i },
      { strength: "moderate", pattern: /容器/i }
    ],
    checks: [
      "查看容器状态与退出原因（docker inspect / docker ps -a）",
      "读取容器最近日志（docker logs --tail 200）",
      "回看容器事件与健康检查历史（docker events）"
    ]
  },
  {
    id: "application-image-missing",
    title: "镜像缺失 / 标签不存在",
    category: "application",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /no such image/i },
      { strength: "strong", pattern: /manifest unknown/i },
      { strength: "strong", pattern: /pull access denied/i },
      { strength: "moderate", pattern: /\bimage\b/i },
      { strength: "moderate", pattern: /镜像/i }
    ],
    checks: [
      "列出本地镜像与标签（docker images）",
      "读取镜像拉取事件记录（只读事件流）",
      "核对部署清单中引用的镜像名与标签"
    ]
  },
  {
    id: "application-service-crash",
    title: "服务进程崩溃 / 异常退出",
    category: "application",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /segmentation fault/i },
      { strength: "strong", pattern: /core dumped/i },
      { strength: "strong", pattern: /\bpanic:/i },
      { strength: "strong", pattern: /exit code [1-9]\d*/i },
      { strength: "strong", pattern: /service[^\n]{0,40}failed/i },
      { strength: "moderate", pattern: /崩溃|异常退出/i }
    ],
    checks: [
      "查看服务状态与最近失败原因（systemctl status <svc>）",
      "读取服务日志（journalctl -u <svc> --tail 200）",
      "采集崩溃转储清单（coredumpctl list，只读）"
    ]
  },
  {
    id: "application-config-invalid",
    title: "配置解析失败 / 配置漂移",
    category: "application",
    escalation: false,
    signals: [
      { strength: "strong", pattern: /config(uration)?[^\n]{0,40}(invalid|error|parse)/i },
      { strength: "strong", pattern: /YAML[^\n]{0,40}error/i },
      { strength: "strong", pattern: /syntax error/i },
      { strength: "moderate", pattern: /配置/i }
    ],
    checks: [
      "读取配置解析错误日志（服务日志）",
      "用工具的 --check / --dry-run 模式校验语法",
      "查看最近一次配置变更记录（审计日志）"
    ]
  }
]);

/** 分类级别的通用只读检查项。 */
const CATEGORY_CHECKS = Object.freeze({
  storage: [
    "采集磁盘与阵列的只读状态快照（smartctl -a / cat /proc/mdstat）",
    "读取内核日志中的磁盘与文件系统错误条目（dmesg，只读）"
  ],
  network: [
    "采集接口、路由与解析配置的只读快照（ip addr / ip route / resolv.conf）",
    "读取网络服务近期错误日志（只读）"
  ],
  resource: [
    "采集 CPU / 内存 / 负载的只读指标（uptime / free -m / vmstat）",
    "读取资源相关内核日志（只读）"
  ],
  permission: [
    "采集当前身份与目标路径权限的只读快照（id / namei -l）",
    "读取鉴权失败相关日志（只读）"
  ],
  application: [
    "读取应用/容器状态与近期日志（只读）",
    "回看最近的变更记录（审计日志，只读）"
  ]
});

/** 分类级别的安全下一步（全部为只读或仅收集信息）。 */
const CATEGORY_NEXT_STEPS = Object.freeze({
  storage: [
    "先完成 SMART 与阵列状态的只读采集，判定是否存在介质级失效",
    "对受影响的卷先做只读挂载或备份可用性确认，再讨论任何处置"
  ],
  network: [
    "先做只读连通性与解析验证，区分解析问题与链路问题",
    "对同一时间窗内的客户端与服务端日志做时间对齐比对"
  ],
  resource: [
    "先采集资源指标快照，确认瓶颈位置后再评估限流或扩容",
    "对照故障时间窗的监控曲线，区分瞬时尖峰与持续饱和"
  ],
  permission: [
    "先确认拒绝发生的真实主体与目标路径，再核对授权配置",
    "权限调整类动作必须走审批流程，本阶段不代为执行"
  ],
  application: [
    "先读取容器/服务日志与退出码，定位失败阶段",
    "核对镜像与依赖版本是否与最近一次变更一致"
  ]
});

/* ------------------------------------------------------------------ *
 * 破坏性动作识别
 * ------------------------------------------------------------------ */

const DESTRUCTIVE_ACTION_PATTERNS = Object.freeze([
  /\brm\s+-[a-z]*r[a-z]*\b/i,
  /\brm\s+-rf\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+(if|of)=/i,
  /\bdd\s+.*of=\/dev\//i,
  /\bmdadm\b[^\n]*(?:--stop|--zero-superblock)/i,
  /\bmdadm\b[^\n]*(?:--create|--add|--grow|--rebuild)/i,
  /重建\s*(阵列|RAID|raid)/,
  /停止\s*(存储|storage|阵列|raid)\s*服务/i,
  /\b(systemctl|service)\b[^\n]*\bstop\b[^\n]*(storage|md|raid|volume)/i,
  /\b(wipefs|fdisk|sgdisk|mkdos)\b/i,
  /\bformat\s+[^\n]*\/(dev|mnt|vol)/i,
  /\bshred\b/i,
  /\btruncate\b[^\n]*-s\s*0/i,
  /重启所有服务/,
  /restart\s+all(\s+services)?/i,
  /\bsystemctl\s+restart\s+all/i,
  /\bfork\s*bomb/i,
  /:\(\)\s*\{.*\}\s*;\s*:/,
  /\bkill\s+-9\s+-1\b/i
]);

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

function truncateDetail(value) {
  const text = String(value ?? "");
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
}

/**
 * 规范化证据输入。
 * 允许的形态：
 *   - 字符串
 *   - { source, detail } / { source, message } / { source, text } / { source, content } / { source, value }
 *   - { detail }（无 source 时用 "evidence"）
 */
function normalizeEvidence(evidence) {
  if (!evidence) return [];
  const list = Array.isArray(evidence) ? evidence : [evidence];
  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    if (typeof item === "string") {
      const detail = item.trim();
      if (!detail) continue;
      out.push({ source: "evidence", detail: truncateDetail(detail) });
      continue;
    }
    if (typeof item !== "object") continue;
    const source = typeof item.source === "string" && item.source.trim()
      ? item.source.trim()
      : typeof item.kind === "string" && item.kind.trim()
        ? item.kind.trim()
        : "evidence";
    const raw = [item.detail, item.message, item.text, item.content, item.value, item.reason]
      .find((value) => typeof value === "string" && value.trim());
    if (!raw) continue;
    out.push({ source, detail: truncateDetail(raw.trim()) });
  }
  return out;
}

function evidenceText(entry) {
  return `${entry.source} ${entry.detail}`;
}

function matchStrength(signals, text) {
  for (const signal of signals) {
    if (signal.pattern.test(text)) return signal.strength;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 公开 API
 * ------------------------------------------------------------------ */

/**
 * 故障分类（D03）。
 * @param {Array|object|string} evidence 已采集的证据
 * @returns {"storage"|"network"|"resource"|"permission"|"application"}
 */
export function classifyEvidence(evidence) {
  return classifyEvidenceDetail(evidence).category;
}

/**
 * 故障分类 + 可解释原因（D03 / D01）。
 * @param {Array|object|string} evidence
 * @returns {{category: string, reason: string, signals: Array<{category: string, strength: string, source: string, detail: string}>}}
 */
export function classifyEvidenceDetail(evidence) {
  const entries = normalizeEvidence(evidence);
  if (entries.length === 0) {
    return {
      category: "application",
      reason: "证据为空，无法判定具体类别，按 application 处理（需补充采集结果后再分类）。",
      signals: []
    };
  }

  const scores = new Map(DIAGNOSTIC_CATEGORIES.map((category) => [category, 0]));
  const signals = [];
  for (const entry of entries) {
    const text = evidenceText(entry);
    for (const signal of CATEGORY_SIGNALS) {
      let strength = null;
      if (signal.strong.some((pattern) => pattern.test(text))) strength = "strong";
      else if (signal.moderate.some((pattern) => pattern.test(text))) strength = "moderate";
      if (!strength) continue;
      const weight = strength === "strong" ? 3 : 1;
      scores.set(signal.category, scores.get(signal.category) + weight);
      signals.push({ category: signal.category, strength, source: entry.source, detail: entry.detail });
    }
  }

  let bestCategory = null;
  let bestScore = 0;
  for (const category of DIAGNOSTIC_CATEGORIES) {
    const score = scores.get(category) ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  if (!bestCategory) {
    return {
      category: "application",
      reason: "证据中未匹配到任何分类特征，无法判定具体类别，按 application 处理（需补充采集结果后再分类）。",
      signals
    };
  }

  const matched = signals.filter((signal) => signal.category === bestCategory);
  const strongCount = matched.filter((signal) => signal.strength === "strong").length;
  const reason = strongCount > 0
    ? `命中 ${strongCount} 条明确错误特征（${bestCategory}），判定为 ${bestCategory}。`
    : `仅命中弱特征（${bestCategory}），按 ${bestCategory} 归类，建议补充证据后再确认。`;
  return { category: bestCategory, reason, signals };
}

/**
 * 根因候选排序（D04 / D05）。
 * @param {Array|object|string} evidence
 * @param {{limit?: number}} [options]
 * @returns {Array<{id: string, title: string, category: string, confidence: "confirmed"|"likely"|"suspected", evidence: Array<{source: string, detail: string}>, checks: string[]}>}
 */
export function rankCauses(evidence, { limit = 5 } = {}) {
  const entries = normalizeEvidence(evidence);
  if (entries.length === 0) return [];

  const ranked = [];
  for (const rule of CAUSE_RULES) {
    const matched = [];
    let strongHits = 0;
    for (const entry of entries) {
      const strength = matchStrength(rule.signals, evidenceText(entry));
      if (!strength) continue;
      if (strength === "strong") strongHits += 1;
      matched.push({ source: entry.source, detail: entry.detail });
    }
    if (matched.length === 0) continue;

    let confidence = "suspected";
    if (strongHits > 0) confidence = "confirmed";
    else if (matched.length >= 2) confidence = "likely";

    ranked.push({
      id: rule.id,
      title: rule.title,
      category: rule.category,
      confidence,
      evidence: matched,
      checks: [...rule.checks],
      escalation: Boolean(rule.escalation)
    });
  }

  ranked.sort((a, b) => {
    const byConfidence = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (byConfidence !== 0) return byConfidence;
    const byCount = b.evidence.length - a.evidence.length;
    if (byCount !== 0) return byCount;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
  return ranked.slice(0, max).map((cause) => ({
    id: cause.id,
    title: cause.title,
    category: cause.category,
    confidence: cause.confidence,
    evidence: cause.evidence,
    checks: cause.checks
  }));
}

/**
 * 判断一条建议是否安全（不含扩大损失的动作）。
 * @param {string} action
 * @returns {boolean}
 */
export function isSafeSuggestion(action) {
  if (typeof action !== "string") return false;
  const text = action.trim();
  if (!text) return false;
  return !DESTRUCTIVE_ACTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 该根因候选是否必须走人工审批。
 * 允许调用方传入自定义 cause 对象，因此除了对象上的 escalation 标记，
 * 还要回查内置规则表。
 */
function requiresEscalation(cause) {
  if (!cause || typeof cause !== "object") return false;
  if (cause.escalation === true) return true;
  const rule = CAUSE_RULES.find((item) => item.id === cause.id);
  return Boolean(rule && rule.escalation);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function formatNow(now) {
  if (now === null || now === undefined) return null;
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "number") return new Date(now).toISOString();
  if (typeof now === "string" && now.trim()) return now.trim();
  return null;
}

/**
 * 生成故障报告（D12），含分类、根因候选、置信度说明与只读诊断建议。
 * @param {{symptom?: string, evidence?: Array, causes?: Array, now?: Date|string|number}} [input]
 */
export function buildDiagnosticReport({ symptom = "", evidence = [], causes = [], now = null } = {}) {
  const entries = normalizeEvidence(evidence);
  const classification = classifyEvidenceDetail(entries);

  const providedCauses = Array.isArray(causes) ? causes.filter((cause) => cause && typeof cause === "object") : [];
  const effectiveCauses = providedCauses.length > 0 ? providedCauses : rankCauses(entries);

  const category = entries.length > 0
    ? classification.category
    : effectiveCauses.length > 0 && DIAGNOSTIC_CATEGORIES.includes(effectiveCauses[0].category)
      ? effectiveCauses[0].category
      : "application";

  const readOnlyChecks = dedupe([
    ...(CATEGORY_CHECKS[category] ?? []),
    ...effectiveCauses.flatMap((cause) => (Array.isArray(cause.checks) ? cause.checks : []))
  ]);

  const highestConfidence = effectiveCauses.reduce((best, cause) => {
    const rank = CONFIDENCE_RANK[cause.confidence] ?? 0;
    return rank > (CONFIDENCE_RANK[best] ?? 0) ? cause.confidence : best;
  }, null);

  const nextSteps = [];
  nextSteps.push(
    highestConfidence === "confirmed"
      ? "先按下列只读检查项补齐证据，确认根因后再决定是否需要人工介入的修复动作"
      : "证据尚不足以确认根因，请先执行下列只读诊断项补充采集结果"
  );
  for (const step of CATEGORY_NEXT_STEPS[category] ?? []) nextSteps.push(step);
  if (effectiveCauses.length > 0 && highestConfidence !== "confirmed") {
    nextSteps.push("补充证据后重新排序根因候选，再输出建议");
  }
  nextSteps.push("任何可能扩大损失的操作均不在本阶段自动执行，需提交人工审批后由人工执行");
  const safeNextSteps = nextSteps.filter((step) => isSafeSuggestion(step));

  const escalationReasons = [];
  const escalatingCauses = effectiveCauses.filter((cause) => requiresEscalation(cause));
  if (escalatingCauses.length > 0) {
    escalationReasons.push(`存在需人工确认的存储类根因候选（${escalatingCauses.map((cause) => cause.id).join("、")}）`);
  }
  if (entries.length === 0) {
    escalationReasons.push("缺少证据，无法形成可信根因候选");
  } else if (effectiveCauses.length === 0) {
    escalationReasons.push("证据未匹配任何已知根因模式");
  }
  if (highestConfidence === "confirmed" && escalatingCauses.length === 0) {
    escalationReasons.push("已确认明确根因，建议由人工复核后再执行处置");
  }
  const escalationRequired = escalationReasons.length > 0;

  const symptomText = typeof symptom === "string" ? symptom.trim() : "";
  const summary = entries.length === 0
    ? `未提供诊断证据，按 ${category} 归类处理，当前无法给出可信的根因候选。`
    : `基于 ${entries.length} 条证据判定为 ${category} 类问题，列出 ${effectiveCauses.length} 个根因候选${
      highestConfidence ? `，最高置信度 ${highestConfidence}` : ""
    }。`;

  const timestamp = formatNow(now);
  const lines = [];
  lines.push("# 故障诊断报告");
  if (timestamp) lines.push(`- 生成时间：${timestamp}`);
  lines.push(`- 症状：${symptomText || "（未提供）"}`);
  lines.push(`- 故障分类：${category}`);
  lines.push("");
  lines.push("## 1. 症状");
  lines.push(symptomText || "（未提供症状描述）");
  lines.push("");
  lines.push("## 2. 证据");
  if (entries.length === 0) {
    lines.push("- （无证据）");
  } else {
    for (const entry of entries) lines.push(`- [${entry.source}] ${entry.detail}`);
  }
  lines.push("");
  lines.push("## 3. 根因候选");
  if (effectiveCauses.length === 0) {
    lines.push("- （未产生根因候选）");
  } else {
    effectiveCauses.forEach((cause, index) => {
      lines.push(`${index + 1}. ${cause.title}（置信度：${cause.confidence ?? "suspected"}，分类：${cause.category ?? "application"}）`);
      for (const item of Array.isArray(cause.evidence) ? cause.evidence : []) {
        lines.push(`   - 证据：[${item.source}] ${item.detail}`);
      }
      for (const check of Array.isArray(cause.checks) ? cause.checks : []) {
        lines.push(`   - 只读检查：${check}`);
      }
    });
  }
  lines.push("");
  lines.push("## 4. 置信度说明");
  lines.push("- confirmed：证据中命中明确错误特征，根因可视为已确认；");
  lines.push("- likely：同类证据至少两条相互印证，根因可能性高但未确认；");
  lines.push("- suspected：仅有弱信号，仅作为排查方向，需补充证据。");
  lines.push("");
  lines.push("## 5. 只读诊断建议");
  for (const check of readOnlyChecks) lines.push(`- ${check}`);
  lines.push("");
  lines.push("## 6. 下一步");
  for (const step of safeNextSteps) lines.push(`- ${step}`);
  lines.push("");
  lines.push("## 7. 人工升级");
  lines.push(escalationRequired
    ? `- 需要人工介入：${escalationReasons.join("；")}。`
    : "- 暂不需要人工介入：当前证据下的建议均为只读诊断或需审批后的动作。");

  return {
    symptom: symptomText,
    category,
    summary,
    causes: effectiveCauses,
    readOnlyChecks,
    nextSteps: safeNextSteps,
    escalation: {
      required: escalationRequired,
      reason: escalationReasons.length > 0 ? escalationReasons.join("；") : "当前证据下无需升级人工处理"
    },
    report: lines.join("\n")
  };
}
