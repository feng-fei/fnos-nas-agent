/**
 * 网络采样的「解析 / 增量 / 打包」层（Phase 205）。
 *
 * 这一层只做三件事：
 *   1. 把调用方已经拿到的原始文本（/proc/net/dev、`ip route` 输出）解析成结构化记录；
 *   2. 把两次计数器快照差分成功率（B/s、包/s）与增量，回绕时明确标记 reset；
 *   3. 把解析结果打包成 network-diagnostics.mjs 里 N03 / N06 / N09 判定函数的入参。
 *
 * 判定本身不在这里，采样也不在这里。真正读 /proc/net/dev、执行 `ip route`、
 * 发 ping 的调度器由 server 侧实现，本模块只接收字符串或结构化对象。
 *
 * 安全红线（tests/phase-205-network-collectors.test.mjs 逐条锁死）：
 *   1. 不采：模块不读 /proc、不读任何文件、不建 socket；parseProcNetDev 只解析传入的字符串。
 *   2. 不执行：不调用 ip / ping / nginx，不导入 child_process，不启动任何子进程。
 *   3. 不做 DNS：不解析主机名，不查询解析器。
 *   4. 不补零：任何非法数字返回 null，绝不写成 0；缺字段就是 null。
 *   5. 不猜：没有基线不造增量，没有探测不造可达性，没有头部证据不造反向代理；
 *      多路径路由、nginx 配置原文、server_name 里的空格都不在这里展开。
 *
 * 所有导出函数都是纯函数、无副作用、不读系统时钟。
 */

/** 单次解析最多接受的接口数；多出的记录计入 skipped。 */
export const MAX_INTERFACES = 64;

/** buildThroughputInput 能接受的最短窗口；短于 1 秒的速率视为不可判定。 */
export const MIN_THROUGHPUT_WINDOW_MS = 1000;

const PROC_NET_DEV_COLUMNS = 16;

const DEFAULT_ROUTE_DESTINATIONS = new Set(["default", "0.0.0.0/0", "::/0"]);

/** `ip route` 行首可能出现的路由类型词；它们不是目的地址。 */
const ROUTE_TYPE_WORDS = new Set([
  "unicast",
  "local",
  "broadcast",
  "multicast",
  "throw",
  "unreachable",
  "prohibit",
  "blackhole",
  "nat",
  "anycast"
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asTextOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asUnsignedToken(token) {
  if (typeof token !== "string" || !/^\d+$/.test(token)) return null;
  return asCount(Number(token));
}

function asRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeInterfaceList(value) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value) && Array.isArray(value.interfaces)) return value.interfaces;
  return [];
}

/**
 * 解析 /proc/net/dev 的文本快照。
 *
 * 只读取下面 8 个计数器（其余 fifo/frame/compressed 列忽略）：
 *   rx: bytes packets errors dropped    tx: bytes packets errors dropped
 *
 * 表头、空行与 lo 直接跳过且不计入 skipped；有冒号但解析不了的行（列数不足、
 * 非法数字、空接口名、重名、超出 MAX_INTERFACES）整行跳过并计入 skipped，
 * 不会退化成 0 或半条记录。
 *
 * @param {string} text
 * @returns {{interfaces: Array<{name: string, rxBytes: number, txBytes: number, rxPackets: number, txPackets: number, rxErrors: number, txErrors: number, rxDropped: number, txDropped: number}>, skipped: number}}
 */
export function parseProcNetDev(text) {
  const interfaces = [];
  let skipped = 0;
  if (typeof text !== "string" || !text) return { interfaces, skipped };

  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    // /proc/net/dev 的两行表头没有冒号；没有冒号的内容不是接口记录。
    if (colon < 0) continue;

    const name = line.slice(0, colon).trim();
    if (name === "lo") continue;
    if (!name || /\s/.test(name)) {
      skipped += 1;
      continue;
    }

    const columns = line.slice(colon + 1).trim().split(/\s+/);
    if (columns.length < PROC_NET_DEV_COLUMNS) {
      skipped += 1;
      continue;
    }

    const rxBytes = asUnsignedToken(columns[0]);
    const rxPackets = asUnsignedToken(columns[1]);
    const rxErrors = asUnsignedToken(columns[2]);
    const rxDropped = asUnsignedToken(columns[3]);
    const txBytes = asUnsignedToken(columns[8]);
    const txPackets = asUnsignedToken(columns[9]);
    const txErrors = asUnsignedToken(columns[10]);
    const txDropped = asUnsignedToken(columns[11]);
    if ([rxBytes, rxPackets, rxErrors, rxDropped, txBytes, txPackets, txErrors, txDropped].some((value) => value === null)) {
      skipped += 1;
      continue;
    }

    if (seen.has(name)) {
      skipped += 1;
      continue;
    }
    if (interfaces.length >= MAX_INTERFACES) {
      skipped += 1;
      continue;
    }

    seen.add(name);
    interfaces.push({
      name,
      rxBytes,
      txBytes,
      rxPackets,
      txPackets,
      rxErrors,
      txErrors,
      rxDropped,
      txDropped
    });
  }

  return { interfaces, skipped };
}

/**
 * 差分两次接口计数器快照。
 *
 * 只对「上一份里也有同名接口」的当前接口生成记录：没有基线就跳过，
 * 不把新接口伪装成 reset。只读取 rxBytes/txBytes/rxPackets/txPackets 四个
 * 主计数器；其中任何一个非法都跳过该接口。
 *
 * - 任一计数器变小（回绕、设备重建、重启）→ reset: true，速率与增量全部 null；
 * - elapsedMs 缺失、非数字或 ≤ 0 → 四项速率一律 null，但 dropped/error 增量仍可计算；
 * - droppedDelta / errorDelta 是 rx+tx 的合计增量；对应计数器缺失时为 null。
 *
 * @param {Array<object>|{interfaces: Array<object>}} previous
 * @param {Array<object>|{interfaces: Array<object>}} current
 * @param {{elapsedMs?: number}} [options]
 * @returns {Array<{name: string, rxBytesPerSecond: number|null, txBytesPerSecond: number|null, rxPacketsPerSecond: number|null, txPacketsPerSecond: number|null, droppedDelta: number|null, errorDelta: number|null, reset: boolean}>}
 */
export function diffInterfaceCounters(previous, current, { elapsedMs } = {}) {
  const previousList = normalizeInterfaceList(previous);
  const currentList = normalizeInterfaceList(current).slice(0, MAX_INTERFACES);
  const elapsed = typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : null;

  const previousByName = new Map();
  for (const item of previousList) {
    const name = asTextOrNull(item?.name);
    if (name && !previousByName.has(name)) previousByName.set(name, item);
  }

  const diffs = [];
  for (const item of currentList) {
    const name = asTextOrNull(item?.name);
    if (!name) continue;
    const before = previousByName.get(name);
    if (!before) continue;

    const past = {
      rxBytes: asCount(before.rxBytes),
      txBytes: asCount(before.txBytes),
      rxPackets: asCount(before.rxPackets),
      txPackets: asCount(before.txPackets),
      rxErrors: asCount(before.rxErrors),
      txErrors: asCount(before.txErrors),
      rxDropped: asCount(before.rxDropped),
      txDropped: asCount(before.txDropped)
    };
    const now = {
      rxBytes: asCount(item.rxBytes),
      txBytes: asCount(item.txBytes),
      rxPackets: asCount(item.rxPackets),
      txPackets: asCount(item.txPackets),
      rxErrors: asCount(item.rxErrors),
      txErrors: asCount(item.txErrors),
      rxDropped: asCount(item.rxDropped),
      txDropped: asCount(item.txDropped)
    };

    const primary = ["rxBytes", "txBytes", "rxPackets", "txPackets"];
    if (primary.some((key) => past[key] === null || now[key] === null)) continue;

    const deltas = {};
    let reset = false;
    for (const key of ["rxBytes", "txBytes", "rxPackets", "txPackets", "rxErrors", "txErrors", "rxDropped", "txDropped"]) {
      if (past[key] === null || now[key] === null) {
        deltas[key] = null;
        continue;
      }
      const delta = now[key] - past[key];
      if (delta < 0) reset = true;
      deltas[key] = delta;
    }

    if (reset) {
      diffs.push({
        name,
        rxBytesPerSecond: null,
        txBytesPerSecond: null,
        rxPacketsPerSecond: null,
        txPacketsPerSecond: null,
        droppedDelta: null,
        errorDelta: null,
        reset: true
      });
      continue;
    }

    const perSecond = (delta) => (elapsed === null || delta === null ? null : (delta * 1000) / elapsed);
    const droppedDelta = deltas.rxDropped === null || deltas.txDropped === null ? null : deltas.rxDropped + deltas.txDropped;
    const errorDelta = deltas.rxErrors === null || deltas.txErrors === null ? null : deltas.rxErrors + deltas.txErrors;

    diffs.push({
      name,
      rxBytesPerSecond: perSecond(deltas.rxBytes),
      txBytesPerSecond: perSecond(deltas.txBytes),
      rxPacketsPerSecond: perSecond(deltas.rxPackets),
      txPacketsPerSecond: perSecond(deltas.txPackets),
      droppedDelta,
      errorDelta,
      reset: false
    });
  }

  return diffs;
}

function emptyRouteSummary() {
  return { defaultGateway: null, defaultInterface: null, defaultMetric: null, routes: [] };
}

/** 目的地址至少要像 `default`、IPv4 或 IPv6，避免把任意一行文本当成路由。 */
function looksLikeDestination(value) {
  return value === "default" || value.includes(".") || value.includes(":");
}

function summarizeRoutes(routes) {
  let primary = null;
  for (const route of routes) {
    if (!DEFAULT_ROUTE_DESTINATIONS.has(route.destination)) continue;
    if (primary === null) {
      primary = route;
      continue;
    }
    // 缺失 metric 按 0 参与排序，与 detectGateway 的排序规则保持一致。
    if ((route.metric ?? 0) < (primary.metric ?? 0)) primary = route;
  }
  return {
    defaultGateway: primary?.gateway ?? null,
    defaultInterface: primary?.interface ?? null,
    defaultMetric: primary?.metric ?? null,
    routes
  };
}

function routeFromTokens(tokens) {
  let index = 0;
  if (ROUTE_TYPE_WORDS.has(tokens[0])) index = 1;
  const destination = tokens[index];
  if (!destination || !looksLikeDestination(destination)) return null;

  let gateway = null;
  let iface = null;
  let metric = null;
  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "via" && i + 1 < tokens.length) {
      gateway = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "dev" && i + 1 < tokens.length) {
      iface = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token === "metric" && i + 1 < tokens.length) {
      metric = asUnsignedToken(tokens[i + 1]);
      i += 1;
    }
  }

  return {
    destination,
    gateway: asTextOrNull(gateway),
    metric,
    interface: asTextOrNull(iface)
  };
}

function routeFromJson(entry) {
  if (!isPlainObject(entry)) return null;
  const destination = asTextOrNull(entry.dst);
  if (!destination || !looksLikeDestination(destination)) return null;
  return {
    destination,
    gateway: asTextOrNull(entry.gateway),
    metric: asCount(entry.metric),
    interface: asTextOrNull(entry.dev)
  };
}

/**
 * 解析 `ip route` 的文本输出或 `ip -j route` 的 JSON 数组。
 *
 * 文本模式逐行取 destination / via / dev / metric；JSON 模式读取
 * dst / gateway / dev / metric。两种模式都只做字段搬运，不解析策略路由表名、
 * 不展开 multipath（`nexthop` 续行会被忽略），也不补默认网关。
 * 目的地址必须像 `default`、IPv4 或 IPv6，不像路由的行整行丢弃。
 *
 * 有多条默认路由时选 metric 最小的一条作为 defaultGateway / defaultInterface /
 * defaultMetric（缺失 metric 按 0 处理，与 detectGateway 一致）。
 *
 * @param {string|Array<object>} text
 * @returns {{defaultGateway: string|null, defaultInterface: string|null, defaultMetric: number|null, routes: Array<{destination: string, gateway: string|null, metric: number|null, interface: string|null}>}}
 */
export function parseRouteOutput(text) {
  if (Array.isArray(text)) {
    return summarizeRoutes(text.map(routeFromJson).filter(Boolean));
  }
  if (typeof text !== "string") return emptyRouteSummary();

  const trimmed = text.trim();
  if (!trimmed) return emptyRouteSummary();

  if (trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return emptyRouteSummary();
    }
    if (!Array.isArray(parsed)) return emptyRouteSummary();
    return summarizeRoutes(parsed.map(routeFromJson).filter(Boolean));
  }

  const routes = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    if (tokens[0] === "nexthop") continue;
    const route = routeFromTokens(tokens);
    if (route) routes.push(route);
  }
  return summarizeRoutes(routes);
}

/**
 * 打包 detectGateway 的入参。
 *
 * 把 parseRouteOutput 的 `interface` 字段映射成 detectGateway 读取的 `iface`；
 * probes 只在 ping 给出布尔可达性时才生成（target 固定为默认网关）。
 * ping 为 null、缺少布尔 reachable、或没有默认网关时，probes 为空且
 * 返回对象的 reachable 为 null —— detectGateway 会据此保留 null，
 * 而不是把它读成 false。
 *
 * @param {{route?: object, ping?: null|boolean|{reachable?: boolean, rttMs?: number}}} [input]
 * @returns {{routes: Array<object>, probes: Array<object>, gateway: string|null, reachable: boolean|null}}
 */
export function buildGatewayInput({ route, ping = null } = {}) {
  const sourceRoutes = Array.isArray(route?.routes) ? route.routes : [];
  const routes = sourceRoutes
    .map((item) => ({
      destination: asTextOrNull(item?.destination) ?? "",
      gateway: asTextOrNull(item?.gateway),
      iface: asTextOrNull(item?.interface) ?? asTextOrNull(item?.iface),
      metric: asCount(item?.metric)
    }))
    .filter((item) => item.destination);

  const gateway = asTextOrNull(route?.defaultGateway);

  let reachable = null;
  let probe = null;
  if (gateway && typeof ping === "boolean") {
    reachable = ping;
    probe = { target: gateway, reachable, rttMs: null };
  } else if (gateway && isPlainObject(ping) && typeof ping.reachable === "boolean") {
    reachable = ping.reachable;
    const rttMs = typeof ping.rttMs === "number" && Number.isFinite(ping.rttMs) && ping.rttMs >= 0 ? ping.rttMs : null;
    probe = { target: gateway, reachable, rttMs };
  }

  return {
    routes,
    probes: probe ? [probe] : [],
    gateway,
    reachable
  };
}

/**
 * 打包 analyzeThroughput 的入参。
 *
 * 每个有效 diff 的 rx+tx 速率合成一个样本（B/s）；reset 的、速率为 null 的
 * 记录被丢弃，而不是按 0 计入。有效样本少于 2 个，或窗口短于
 * MIN_THROUGHPUT_WINDOW_MS（含缺失/非法），都返回
 * `{ samples: [], insufficient: true }`，由调用方把 N06 保持为 unknown。
 *
 * @param {{diffs?: Array<object>, windowMs?: number}} [input]
 * @returns {{samples: number[], insufficient: boolean, windowMs?: number}}
 */
export function buildThroughputInput({ diffs, windowMs } = {}) {
  const list = Array.isArray(diffs) ? diffs : [];
  const samples = [];
  for (const diff of list) {
    if (!isPlainObject(diff) || diff.reset === true) continue;
    const rx = asRate(diff.rxBytesPerSecond);
    const tx = asRate(diff.txBytesPerSecond);
    if (rx === null || tx === null) continue;
    samples.push(rx + tx);
  }

  if (samples.length < 2) return { samples: [], insufficient: true };

  const window = typeof windowMs === "number" && Number.isFinite(windowMs) && windowMs >= MIN_THROUGHPUT_WINDOW_MS ? windowMs : null;
  if (window === null) return { samples: [], insufficient: true };

  return { samples, insufficient: false, windowMs: window };
}

const UPSTREAM_KEYS = ["upstreams", "upstream"];
const SERVER_KEYS = ["servers", "server"];
const LOCATION_KEYS = ["locations", "location"];
const HEADER_LIST_KEYS = ["proxySetHeaders", "proxy_set_header"];

function pickArray(config, keys) {
  for (const key of keys) {
    if (Array.isArray(config[key])) return config[key];
  }
  return [];
}

function headerValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function assignHeader(headers, rawName, rawValue) {
  const name = asTextOrNull(rawName);
  if (!name) return;
  const lower = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lower) delete headers[existing];
  }
  headers[name] = headerValue(rawValue);
}

function collectHeaderSources(config, headers) {
  let understood = false;
  if (isPlainObject(config.headers)) {
    understood = true;
    for (const [name, value] of Object.entries(config.headers)) assignHeader(headers, name, value);
  }
  for (const key of HEADER_LIST_KEYS) {
    const source = config[key];
    if (isPlainObject(source)) {
      understood = true;
      for (const [name, value] of Object.entries(source)) assignHeader(headers, name, value);
      continue;
    }
    if (!Array.isArray(source)) continue;
    if (!source.length) {
      understood = true;
      continue;
    }
    for (const entry of source) {
      // 只接受结构化的 {name|key, value}；nginx 原文（如 "proxy_set_header X ..."）不会被解析。
      if (!isPlainObject(entry)) continue;
      const name = entry.name !== undefined ? entry.name : entry.key;
      if (!asTextOrNull(name)) continue;
      understood = true;
      assignHeader(headers, name, entry.value ?? null);
    }
  }
  return understood;
}

function normalizeUpstreamServer(entry) {
  if (typeof entry === "string") return { address: asTextOrNull(entry), weight: null, backup: null };
  if (!isPlainObject(entry)) return null;
  return {
    address: asTextOrNull(entry.address),
    weight: asCount(entry.weight),
    backup: typeof entry.backup === "boolean" ? entry.backup : null
  };
}

function normalizeUpstream(entry) {
  if (!isPlainObject(entry)) return null;
  const servers = Array.isArray(entry.servers) ? entry.servers : Array.isArray(entry.server) ? entry.server : [];
  return {
    name: asTextOrNull(entry.name),
    servers: servers.map(normalizeUpstreamServer).filter(Boolean)
  };
}

function normalizeLocation(entry) {
  if (!isPlainObject(entry)) return null;
  return {
    path: asTextOrNull(entry.path),
    proxyPass: asTextOrNull(entry.proxyPass)
  };
}

function asListenOrNull(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return asTextOrNull(value);
}

function asServerNameOrNull(value) {
  if (typeof value === "string") return asTextOrNull(value);
  if (Array.isArray(value)) {
    const names = value.map(asTextOrNull).filter(Boolean);
    return names.length ? names : null;
  }
  return null;
}

function normalizeServer(entry) {
  if (!isPlainObject(entry)) return null;
  const locations = Array.isArray(entry.locations) ? entry.locations : Array.isArray(entry.location) ? entry.location : [];
  return {
    listen: asListenOrNull(entry.listen),
    serverName: asServerNameOrNull(entry.serverName),
    ssl: typeof entry.ssl === "boolean" ? entry.ssl : null,
    locations: locations.map(normalizeLocation).filter(Boolean)
  };
}

/**
 * 打包 inspectReverseProxy 的入参。
 *
 * 接受调用方已经结构化好的 nginx 风格配置（不解析 nginx 配置文本）：
 *
 *   {
 *     headers?: { [name]: string },
 *     proxySetHeaders?: Array<{ name?: string, key?: string, value?: string }>,
 *     upstreams?: Array<{ name?, servers?: Array<string|{ address?, weight?, backup? }> }>,
 *     servers?: Array<{ listen?, serverName?, ssl?, locations?: Array<{ path?, proxyPass? }> }>,
 *     locations?: Array<{ path?, proxyPass? }>
 *   }
 *
 * 输出固定为 `{ headers, upstreams, servers, locations }`：
 *   - headers 只从顶层 headers / proxySetHeaders 搬运；一处结构化来源都没有时
 *     为 null（inspectReverseProxy 会保持 unknown），而不是 {};
 *   - upstream / server / location 的缺省字段一律 null，不做语法推断；
 *   - location 内部的头部不向上合并（多 location 合并会丢失归属）。
 *
 * @param {{config?: object|null}} [input]
 * @returns {{headers: object|null, upstreams: Array<object>, servers: Array<object>, locations: Array<object>}}
 */
export function buildProxyInput({ config } = {}) {
  if (!isPlainObject(config)) {
    return { headers: null, upstreams: [], servers: [], locations: [] };
  }

  const headers = {};
  const hasHeaders = collectHeaderSources(config, headers);

  return {
    headers: hasHeaders ? headers : null,
    upstreams: pickArray(config, UPSTREAM_KEYS).map(normalizeUpstream).filter(Boolean),
    servers: pickArray(config, SERVER_KEYS).map(normalizeServer).filter(Boolean),
    locations: pickArray(config, LOCATION_KEYS).map(normalizeLocation).filter(Boolean)
  };
}
