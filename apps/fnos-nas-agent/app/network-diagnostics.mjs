/**
 * Read-only network diagnostics.
 *
 * Every function is a pure function over probe data that was collected
 * elsewhere. The module never opens a socket, never runs a command and never
 * changes a firewall rule. It answers the questions the operator asks when a
 * service stops answering:
 *
 *   - did the name resolve (N02),
 *   - is the default gateway reachable (N03),
 *   - is the port refused or silently dropped (N05),
 *   - is the throughput steady (N06),
 *   - which layer failed (N07),
 *   - is the certificate still valid (N08),
 *   - is a reverse proxy in front of the service (N09),
 *   - and does one patrol run hold together (N12).
 *
 * A probe that was not taken stays `unknown`. A conclusion that is not backed
 * by a measurement is marked `likely` or `suspected`, never `confirmed`.
 * Every suggestion in this module is a read-only check.
 */

export const NETWORK_DIAGNOSTIC_CHECKS = Object.freeze([
  "dns",
  "gateway",
  "service",
  "throughput",
  "connectivity",
  "certificate",
  "reverse-proxy",
  "patrol",
  "upgrade"
]);

export const CONFIDENCE_LEVELS = Object.freeze(["confirmed", "likely", "suspected"]);

export const CERT_EXPIRY_WARNING_DAYS = 21;
export const DEFAULT_PATROL_TIMEOUT_MS = 5000;
export const MAX_TARGETS = 100;
export const MAX_SAMPLES = 2000;
export const MAX_THROUGHPUT_DRIFT = 0.35;

/**
 * The read-only checks the agent may suggest.
 *
 * Each entry names a command whose only effect is to observe. Nothing in this
 * list restarts, reloads or reconfigures anything, and nothing in this list
 * changes a firewall rule.
 */
export const READ_ONLY_SUGGESTIONS = Object.freeze({
  dns: Object.freeze([
    "dig +short <name> @<resolver>",
    "cat /etc/resolv.conf"
  ]),
  gateway: Object.freeze([
    "ip route show",
    "ip -s link show <interface>"
  ]),
  service: Object.freeze([
    "ss -ltn",
    "ss -lun"
  ]),
  throughput: Object.freeze([
    "cat /proc/net/dev",
    "ip -s link show <interface>"
  ]),
  connectivity: Object.freeze([
    "ss -tan state established",
    "ip route get <address>"
  ]),
  certificate: Object.freeze([
    "openssl s_client -connect <host>:<port> -servername <host> </dev/null",
    "openssl x509 -noout -dates -subject -issuer -in <certificate-file>"
  ]),
  "reverse-proxy": Object.freeze([
    "curl -sSI <url>",
    "ss -ltnp"
  ]),
  patrol: Object.freeze([
    "ss -ltn",
    "ip route show"
  ]),
  upgrade: Object.freeze([
    "cat /etc/os-release",
    "uname -r"
  ])
});

const SERVICE_RESULTS = Object.freeze(["reachable", "refused", "timeout", "unlistened", "unknown"]);
const FAILURE_STAGES = Object.freeze(["resolve", "route", "tcp", "tls", "application", "unknown"]);
const DNS_FAILURES = Object.freeze(["servfail", "timeout", "nxdomain", "refused", "unreachable"]);

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function cause(code, message, confidence) {
  return { code, message, confidence: CONFIDENCE_LEVELS.includes(confidence) ? confidence : "suspected" };
}

function emptyResult(fields) {
  return { status: "unknown", ...fields, causes: [], summary: { measured: 0 } };
}

function suggestionsFor(checkId) {
  const list = READ_ONLY_SUGGESTIONS[checkId] || [];
  return list.slice();
}

/**
 * N02 — classify a DNS failure.
 *
 * @param {object} input
 * @param {string} [input.name] the name that was resolved
 * @param {Array<object>} [input.results] `{status, resolver, answers}` records
 * @param {Array<string>} [input.resolvers] the configured resolvers
 * @returns {object}
 */
export function diagnoseDns(input = {}) {
  const results = asList(input.results);
  const resolvers = asList(input.resolvers).map(asText).filter(Boolean);
  if (!results.length) {
    return emptyResult({ stage: "unknown", name: asText(input.name), resolvers });
  }
  const measured = results.filter(result => typeof result?.status === "string");
  if (!measured.length) {
    return emptyResult({ stage: "unknown", name: asText(input.name), resolvers });
  }
  const failures = measured.filter(result => DNS_FAILURES.includes(result.status.toLowerCase()));
  const causes = [];
  const failure = failures[0];
  if (failure) {
    const code = failure.status.toLowerCase();
    const map = {
      servfail: ["dns-server-failure", "解析服务器返回 SERVFAIL，通常是上游解析不可用或区域配置损坏", "confirmed"],
      timeout: ["dns-timeout", "解析请求超时，解析服务器可能不可达或链路丢包", "likely"],
      nxdomain: ["dns-name-not-found", "域名不存在，可能是拼写错误或记录未发布", "confirmed"],
      refused: ["dns-refused", "解析服务器拒绝查询，通常是访问控制限制", "confirmed"],
      unreachable: ["dns-unreachable", "解析服务器不可达，先检查网关与路由", "likely"]
    };
    const [failureCode, message, confidence] = map[code];
    causes.push(cause(failureCode, message, confidence));
    if (code === "timeout" || code === "unreachable") {
      causes.push(cause("dns-egress-blocked", "超时同时来自多个解析器时，优先怀疑出口被阻断而不是解析器故障", "suspected"));
    }
  }
  const resolverCount = new Set(measured.map(result => asText(result.resolver)).filter(Boolean)).size || resolvers.length;
  return {
    status: "ok",
    stage: failures.length ? "resolve" : "ok",
    name: asText(input.name),
    resolvers,
    causes,
    suggestions: failures.length ? suggestionsFor("dns") : [],
    summary: {
      measured: measured.length,
      failures: failures.length,
      resolverCount,
      allFailed: failures.length === measured.length
    }
  };
}

/**
 * N03 — decide whether the default gateway answers.
 *
 * @param {object} input
 * @param {Array<object>} [input.routes] `{destination, gateway, iface, metric}`
 * @param {Array<object>} [input.probes] `{target, reachable, rttMs}`
 * @returns {object}
 */
export function detectGateway(input = {}) {
  const routes = asList(input.routes);
  const probes = asList(input.probes);
  const defaults = routes.filter(route => {
    const destination = asText(route?.destination);
    return destination === "default" || destination === "0.0.0.0/0" || destination === "::/0";
  });
  if (!defaults.length) {
    return emptyResult({
      gateway: null,
      reachable: null,
      candidates: []
    });
  }
  const candidates = defaults.map(route => ({
    gateway: asText(route.gateway) || null,
    iface: asText(route.iface) || null,
    metric: asNumber(route.metric)
  }));
  const primary = candidates.slice().sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0))[0] || null;
  const gateway = primary?.gateway || null;
  const probe = probes.find(item => asText(item?.target) === gateway);
  const reachable = probe ? probe.reachable === true : null;
  const causes = [];
  if (reachable === false) {
    causes.push(cause("gateway-unreachable", "默认网关不响应，所有跨网段访问都会失败", "confirmed"));
  } else if (reachable === null && probes.length) {
    causes.push(cause("gateway-not-probed", "这次采集没有探测默认网关，无法判断是否可达", "suspected"));
  }
  if (candidates.length > 1) {
    causes.push(cause("gateway-multiple-defaults", "存在多条默认路由，流量走向取决于 metric，可能造成不一致", "likely"));
  }
  if (gateway && /^169\.254\./.test(gateway)) {
    causes.push(cause("gateway-link-local", "默认网关是链路本地地址，说明没有拿到 DHCP 地址", "confirmed"));
  }
  return {
    status: "ok",
    gateway,
    reachable,
    candidates,
    causes,
    suggestions: causes.length ? suggestionsFor("gateway") : [],
    summary: {
      measured: probes.length,
      routes: defaults.length,
      candidates: candidates.length
    }
  };
}

/**
 * N05 — classify the reachability of each service target.
 *
 * @param {object} input
 * @param {Array<object>} [input.targets] `{host, port, result, layer, listening}`
 * @returns {object}
 */
export function checkServiceConnectivity(input = {}) {
  const targets = asList(input.targets).slice(0, MAX_TARGETS);
  if (!targets.length) {
    return emptyResult({ targets: [], summary: { measured: 0, reachable: 0, refused: 0, timeout: 0, unlistened: 0, unknown: 0 } });
  }
  const counts = { reachable: 0, refused: 0, timeout: 0, unlistened: 0, unknown: 0 };
  const items = targets.map(target => {
    const host = asText(target?.host);
    const port = target?.port;
    const declared = asText(target?.result).toLowerCase();
    let result = SERVICE_RESULTS.includes(declared) ? declared : "unknown";
    // A connection that is refused while nothing listens locally means the
    // service is down, not that a firewall dropped the packet.
    if (result === "refused" && target?.listening === false) result = "unlistened";
    counts[result] += 1;
    return {
      host,
      port,
      result,
      layer: result === "reachable" ? "application" : result === "unknown" ? "unknown" : "tcp",
      note: asText(target?.note)
    };
  });
  const causes = [];
  Object.entries(counts).forEach(([result, count]) => {
    if (!count) return;
    if (result === "refused") causes.push(cause("service-refused", `${count} 个目标端口主动拒绝连接，说明有主机在线但服务未监听`, "confirmed"));
    if (result === "unlistened") causes.push(cause("service-unlistened", `${count} 个目标本机未监听端口，服务本身没有启动`, "confirmed"));
    if (result === "timeout") causes.push(cause("service-timeout", `${count} 个目标无响应，通常是中间设备丢弃或目标已关机`, "likely"));
  });
  return {
    status: "ok",
    targets: items,
    causes,
    suggestions: causes.length ? suggestionsFor("service") : [],
    summary: {
      measured: items.length,
      ...counts
    }
  };
}

/**
 * N06 — describe a rate series.
 *
 * @param {object} input
 * @param {Array<number|object>} [input.samples] numbers or `{at, bytesPerSecond}`
 * @returns {object}
 */
export function analyzeThroughput(input = {}) {
  const raw = asList(input.samples).slice(0, MAX_SAMPLES);
  const values = raw
    .map(sample => (typeof sample === "number" ? sample : asNumber(sample?.bytesPerSecond ?? sample?.value)))
    .filter(value => value !== null && value >= 0);
  if (!values.length) {
    return emptyResult({ average: null, peak: null, jitter: null, idle: null });
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = total / values.length;
  const peak = Math.max(...values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  const deviation = Math.sqrt(variance);
  const jitter = average > 0 ? round(deviation / average, 3) : null;
  const idleCount = values.filter(value => value === 0).length;
  const causes = [];
  if (idleCount === values.length) {
    causes.push(cause("throughput-idle", "整段时间内速率为零，链路或服务可能已停止", "confirmed"));
  } else if (jitter !== null && jitter >= MAX_THROUGHPUT_DRIFT) {
    causes.push(cause("throughput-unstable", "速率抖动超过阈值，可能是链路质量或对端限速抖动", "likely"));
  }
  return {
    status: "ok",
    average: round(average),
    peak: round(peak),
    jitter,
    idle: idleCount === values.length,
    causes,
    suggestions: causes.length ? suggestionsFor("throughput") : [],
    summary: {
      measured: values.length,
      zeros: idleCount,
      driftThreshold: MAX_THROUGHPUT_DRIFT
    }
  };
}

/**
 * N07 — locate the layer where a connection failed.
 *
 * @param {object} input
 * @param {object} [input.stages] `{resolve:{ok}, route:{ok}, tcp:{ok}, tls:{ok}, application:{ok}}`
 * @returns {object}
 */
export function locateConnectionFailure(input = {}) {
  const stages = input.stages && typeof input.stages === "object" ? input.stages : null;
  if (!stages) {
    return emptyResult({ stage: "unknown" });
  }
  const order = ["resolve", "route", "tcp", "tls", "application"];
  let failedStage = "unknown";
  for (const name of order) {
    const stage = stages[name];
    if (!stage || typeof stage !== "object") continue;
    if (stage.ok === false) {
      failedStage = name;
      break;
    }
  }
  const causes = [];
  if (failedStage === "resolve") causes.push(cause("failure-resolve", "名字解析就失败了，后面的建连还没有开始", "confirmed"));
  if (failedStage === "route") causes.push(cause("failure-route", "没有到目标的路由，流量出不去", "confirmed"));
  if (failedStage === "tcp") {
    const detail = asText(stages.tcp?.result).toLowerCase();
    const confidence = detail ? "confirmed" : "likely";
    causes.push(cause("failure-tcp", detail === "refused" ? "TCP 建连被拒绝，服务未监听或访问控制拒绝" : "TCP 建连失败，目标不可达或丢包", confidence));
  }
  if (failedStage === "tls") causes.push(cause("failure-tls", "TCP 已建立但 TLS 握手失败，通常是证书或协议版本问题", "confirmed"));
  if (failedStage === "application") causes.push(cause("failure-application", "握手已完成但应用没有给出有效响应", "likely"));
  if (failedStage === "unknown") causes.push(cause("failure-unknown", "采集结果里没有可判定的失败阶段", "suspected"));
  return {
    status: "ok",
    stage: FAILURE_STAGES.includes(failedStage) ? failedStage : "unknown",
    causes,
    suggestions: suggestionsFor("connectivity"),
    summary: {
      measured: order.filter(name => stages[name] && typeof stages[name] === "object").length,
      checked: order.filter(name => stages[name]?.ok === true).length
    }
  };
}

/**
 * N08 — check a certificate against the calendar and the hostname.
 *
 * @param {object} input
 * @param {string} [input.host] the host the certificate is presented for
 * @param {object} [input.certificate] `{subjectCN, sanList, issuer, notAfter, notBefore, selfSigned}`
 * @param {string} [input.now] the clock of the check
 * @returns {object}
 */
export function checkCertificate(input = {}) {
  const certificate = input.certificate && typeof input.certificate === "object" ? input.certificate : null;
  if (!certificate) return emptyResult({ expiresInDays: null, expiringSoon: null, hostnameMatches: null, selfSigned: null });
  const rawNotAfter = certificate.notAfter;
  const notAfter = rawNotAfter instanceof Date ? rawNotAfter : asText(rawNotAfter) ? new Date(rawNotAfter) : null;
  if (!notAfter || Number.isNaN(notAfter.getTime())) {
    return emptyResult({ expiresInDays: null, expiringSoon: null, hostnameMatches: null, selfSigned: certificate.selfSigned === true });
  }
  const now = asText(input.now) ? new Date(input.now) : new Date();
  const expiresInDays = Math.floor((notAfter.getTime() - now.getTime()) / 86400000);
  const expiringSoon = expiresInDays <= CERT_EXPIRY_WARNING_DAYS;
  const host = asText(input.host).toLowerCase();
  const names = [asText(certificate.subjectCN), ...asList(certificate.sanList).map(asText)]
    .map(name => name.toLowerCase().replace(/^\*\./, ""))
    .filter(Boolean);
  let hostnameMatches = null;
  if (host) {
    hostnameMatches = names.some(name => host === name || host.endsWith(`.${name}`));
  }
  const selfSigned = certificate.selfSigned === true || asText(certificate.issuer) === asText(certificate.subjectCN);
  const causes = [];
  if (expiresInDays < 0) causes.push(cause("certificate-expired", "证书已过期，浏览器与客户端会直接拒绝连接", "confirmed"));
  else if (expiringSoon) causes.push(cause("certificate-expiring", `证书只剩 ${expiresInDays} 天，需要尽快续期`, "confirmed"));
  if (hostnameMatches === false) causes.push(cause("certificate-hostname-mismatch", "证书里的名字与访问的主机名不一致", "confirmed"));
  if (selfSigned) causes.push(cause("certificate-self-signed", "证书是自签的，未受信任的客户端会告警", "confirmed"));
  return {
    status: "ok",
    expiresInDays,
    expiringSoon,
    hostnameMatches,
    selfSigned,
    causes,
    suggestions: causes.length ? suggestionsFor("certificate") : [],
    summary: {
      measured: 1,
      warningDays: CERT_EXPIRY_WARNING_DAYS,
      names: names.length
    }
  };
}

/**
 * N09 — decide whether a reverse proxy sits in front of the service.
 *
 * @param {object} input
 * @param {object} [input.headers] the response headers of the service
 * @returns {object}
 */
export function inspectReverseProxy(input = {}) {
  const headers = input.headers && typeof input.headers === "object" ? input.headers : null;
  if (!headers) return emptyResult({ detected: null, headers: [], missing: [] });
  const lower = new Map();
  for (const [key, value] of Object.entries(headers)) {
    lower.set(String(key).toLowerCase(), String(value));
  }
  const markers = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "via", "server"]
    .filter(name => lower.has(name));
  const detected = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "via"].some(name => lower.has(name));
  const missing = [];
  if (detected) {
    if (!lower.has("x-forwarded-proto")) missing.push("x-forwarded-proto");
    if (!lower.has("x-forwarded-for")) missing.push("x-forwarded-for");
    if (!lower.has("x-forwarded-host")) missing.push("x-forwarded-host");
  }
  const causes = [];
  if (detected && missing.length) {
    causes.push(cause("proxy-headers-incomplete", "反向代理只转发了部分头部，应用可能生成错误的跳转地址", "confirmed"));
  } else if (!detected) {
    causes.push(cause("proxy-not-detected", "响应里没有反代标记，可能直接暴露了应用端口", "suspected"));
  }
  return {
    status: "ok",
    detected,
    headers: markers,
    missing,
    causes,
    suggestions: suggestionsFor("reverse-proxy"),
    summary: { measured: 1, markers: markers.length, missing: missing.length }
  };
}

/**
 * O10 — compare the running version with an available one.
 *
 * @param {object} input
 * @param {string} [input.currentVersion] the running version
 * @param {string} [input.availableVersion] the version offered by the source
 * @param {string} [input.minimumVersion] the oldest compatible version
 * @returns {object}
 */
export function checkUpgrade(input = {}) {
  const current = asText(input.currentVersion);
  const available = asText(input.availableVersion);
  if (!current || !available) {
    return emptyResult({ current: current || null, available: available || null, updateAvailable: null, compatible: null, skips: [] });
  }
  const parse = value => value.replace(/^v/i, "").split(/[.+-]/).map(part => Number.parseInt(part, 10)).filter(part => Number.isFinite(part));
  const currentParts = parse(current);
  const availableParts = parse(available);
  if (!currentParts.length || !availableParts.length) {
    return { status: "ok", current, available, updateAvailable: null, compatible: null, skips: ["version-not-comparable"], causes: [], summary: { measured: 0 } };
  }
  const majorDiff = availableParts[0] !== currentParts[0];
  const updateAvailable = availableParts.join(".") !== currentParts.join(".") &&
    availableParts.some((part, index) => {
      const other = currentParts[index] ?? 0;
      if (part === other) return false;
      const higher = availableParts.slice(0, index).every((value, i) => value === (currentParts[i] ?? 0));
      return higher && part > other;
    });
  const compatible = !majorDiff;
  const skips = [];
  if (majorDiff) skips.push("major-version-differs");
  if (!updateAvailable) skips.push("already-current");
  const causes = [];
  if (updateAvailable && !compatible) causes.push(cause("upgrade-incompatible", "可用版本跨越大版本，升级前需要人工确认兼容性", "likely"));
  return {
    status: "ok",
    current,
    available,
    updateAvailable,
    compatible,
    skips,
    causes,
    suggestions: suggestionsFor("upgrade"),
    summary: { measured: 2, majorDiffs: majorDiff ? 1 : 0 }
  };
}

/**
 * N12 — run the patrol over the checks that were measured.
 *
 * A check that was not measured is reported as `unknown`, never as healthy.
 *
 * @param {object} input the same inputs as the single checks
 * @returns {object}
 */
export function runConnectivityPatrol(input = {}) {
  const results = {
    dns: diagnoseDns(input.dns || {}),
    gateway: detectGateway(input.gateway || {}),
    service: checkServiceConnectivity(input.service || {}),
    throughput: analyzeThroughput(input.throughput || {}),
    connectivity: locateConnectionFailure(input.connectivity || {}),
    certificate: checkCertificate(input.certificate || {}),
    "reverse-proxy": inspectReverseProxy(input.reverseProxy || {}),
    upgrade: checkUpgrade(input.upgrade || {})
  };
  const checks = Object.entries(results).map(([id, result]) => ({
    id,
    title: PATROL_TITLES[id] || id,
    status: result.status,
    summary: result.summary || {},
    findings: Array.isArray(result.causes) ? result.causes.length : 0
  }));
  const measured = checks.filter(check => check.status !== "unknown").length;
  const status = measured === 0 ? "unknown" : measured === checks.length ? "ok" : "partial";
  const unknown = checks.filter(check => check.status === "unknown").map(check => check.id);
  return {
    status,
    checks,
    causes: [],
    suggestions: status === "ok" ? [] : suggestionsFor("patrol"),
    summary: {
      checks: checks.length,
      measured,
      unknown: unknown.length,
      unknownChecks: unknown,
      timeoutMs: DEFAULT_PATROL_TIMEOUT_MS,
      findings: checks.reduce((sum, check) => sum + check.findings, 0)
    }
  };
}

const PATROL_TITLES = Object.freeze({
  dns: "域名解析",
  gateway: "默认网关",
  service: "服务连通性",
  throughput: "吞吐量与抖动",
  connectivity: "连接失败定位",
  certificate: "证书有效期",
  "reverse-proxy": "反向代理",
  upgrade: "版本升级检查"
});
