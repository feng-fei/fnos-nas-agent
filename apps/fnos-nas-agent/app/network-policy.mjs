/**
 * Phase 172 — 网络出口策略与 SSRF 防护（模块 06「受控 Web 取证」的策略层）
 *
 * Marvis 对照表 B01–B10（网页信息获取）全部 Open，根因是仓库里**没有一条
 * 明确的网络出口策略**：谁可以出网、出到哪些地址、怎么拒绝，都散落在
 * 各个调用点里，或者干脆没有。本模块把这件事收敛成一份可测试的策略对象。
 *
 * 纯策略模块：不做任何 I/O、不发起任何网络请求、不做 DNS 解析。
 *
 * 红线：
 *   - **默认关闭**：allowList 为空时任何 URL 都被拒绝，必须显式放行；
 *   - **拒绝优先于允许**：denyList 永远先判；
 *   - **SSRF 防护**：回环、私有网段、链路本地、组播、保留地址一律拒绝，
 *     包含 IPv4-mapped IPv6（::ffff:10.0.0.1）这类"看起来像公网"的目标；
 *   - **默认零 DNS 副作用**：主机名的地址归属靠注入的 resolver 判定，模块
 *     自身不调用 dns.lookup；
 *   - 每一个判定都带 `reason`，便于写进证据与日志，而不是只给一个布尔值。
 */

/** 允许的协议。 */
export const ALLOWED_PROTOCOLS = Object.freeze(["http:", "https:"]);

/** 默认端口白名单。 */
export const DEFAULT_ALLOWED_PORTS = Object.freeze([80, 443]);

/** 默认响应体上限：2 MiB。 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 默认超时：10 秒。 */
export const DEFAULT_TIMEOUT_MS = 10000;

/** 判定理由（稳定标识，便于测试与日志聚合）。 */
export const POLICY_REASONS = Object.freeze({
  ALLOWED: "allowed",
  INVALID_URL: "invalid-url",
  PROTOCOL_NOT_ALLOWED: "protocol-not-allowed",
  CREDENTIALS_IN_URL: "credentials-in-url",
  MISSING_HOST: "missing-host",
  EMPTY_ALLOW_LIST: "empty-allow-list",
  NOT_ALLOW_LISTED: "not-allow-listed",
  DENY_LISTED: "deny-listed",
  PORT_NOT_ALLOWED: "port-not-allowed",
  BLOCKED_ADDRESS: "blocked-address",
  RESOLUTION_FAILED: "resolution-failed",
  UNRESOLVED_HOST: "unresolved-host",
  DNS_UNVERIFIED: "dns-unverified"
});

/** 需要从 URL 里剥掉的跟踪参数（小写比较）。 */
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "utm_name", "utm_reader", "utm_social", "utm_brand",
  "gclid", "dclid", "fbclid", "msclkid", "yclid", "twclid", "igshid", "mc_cid", "mc_eid",
  "spm", "scm", "share_source", "share_medium", "from_source", "ref_src", "_hsenc", "_hsmi"
]);

/** 结构性上就是"本地"的域名，直接拒绝，不依赖 DNS 判定。 */
const LOCAL_HOSTNAMES = new Set([
  "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
  "metadata", "metadata.google.internal", "instance-data", "host.docker.internal"
]);

/** 结构性上就是"本地"的域名后缀。 */
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 判断主机名是否结构性地位于本地网络命名空间。
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isLocalHostname(hostname) {
  const host = text(hostname).toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (LOCAL_HOSTNAMES.has(host)) return true;
  return LOCAL_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

/**
 * 解析 IPv4 字面量。
 *
 * @param {string} value
 * @returns {number[]|null}
 */
function parseIPv4(value) {
  const raw = text(value);
  if (!IPV4_PATTERN.test(raw)) return null;
  const octets = raw.split(".").map(part => Number.parseInt(part, 10));
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

/**
 * 解析 IPv6 字面量为 16 字节数组。��持 "::" 缩写与末尾内嵌 IPv4。
 *
 * @param {string} value
 * @returns {Uint8Array|null}
 */
function parseIPv6(value) {
  let raw = text(value);
  if (!raw) return null;
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  if (!raw.includes(":")) return null;

  const doubleColon = raw.indexOf("::");
  let headText = doubleColon === -1 ? raw : raw.slice(0, doubleColon);
  let tailText = doubleColon === -1 ? "" : raw.slice(doubleColon + 2);
  if (doubleColon !== -1 && raw.indexOf("::", doubleColon + 1) !== -1) return null;

  const splitGroups = part => part.split(":").filter(part => part.length > 0);

  let head = splitGroups(headText);
  let tail = splitGroups(tailText);
  if (doubleColon === -1 && head.length !== 8) return null;

  const expand = groups => {
    const bytes = [];
    for (const group of groups) {
      if (group.includes(".")) {
        const octets = parseIPv4(group);
        if (!octets) return null;
        bytes.push(octets[0], octets[1], octets[2], octets[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const num = Number.parseInt(group, 16);
      bytes.push((num >> 8) & 0xff, num & 0xff);
    }
    return bytes;
  };

  const headBytes = expand(head);
  const tailBytes = expand(tail);
  if (!headBytes || !tailBytes) return null;

  const missing = 16 - headBytes.length - tailBytes.length;
  if (missing < 0) return null;
  if (doubleColon === -1 && missing !== 0) return null;

  const bytes = new Uint8Array(16);
  bytes.set(headBytes, 0);
  bytes.set(tailBytes, 16 - tailBytes.length);
  return bytes;
}

/**
 * 判断 IPv6 前缀匹配。
 *
 * @param {Uint8Array} bytes
 * @param {number[]} prefix
 * @param {number} bits
 * @returns {boolean}
 */
function hasPrefix(bytes, prefix, bits) {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const restBits = bits % 8;
  if (restBits === 0) return true;
  const mask = (0xff << (8 - restBits)) & 0xff;
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

/**
 * 判断 IPv4 落在哪个保留/私有网段。
 *
 * @param {number[]} octets
 * @returns {string|null} 类别标识，null 表示公网地址
 */
function classifyIPv4(octets) {
  const [a, b] = octets;
  if (a === 0) return "reserved";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "reserved";
  if (a === 192 && b === 0) return "reserved";
  if (a === 192 && b === 2) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51) return "reserved";
  if (a === 203 && b === 0) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return null;
}

/**
 * 判断 IPv6 落在哪个保留/私有网段；若内嵌 IPv4，返回内嵌地址的类别。
 *
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
function classifyIPv6(bytes) {
  const allZero = bytes.every(byte => byte === 0);
  if (allZero) return "reserved";
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128)) return "loopback";

  // IPv4-mapped (::ffff:0:0/96)：前 10 字节为零，第 11、12 字节为 ff。
  const firstTenZero = bytes.slice(0, 10).every(byte => byte === 0);
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    const embedded = [bytes[12], bytes[13], bytes[14], bytes[15]];
    return classifyIPv4(embedded) || "public";
  }
  // IPv4-compatible (::/96)：前 12 字节为零，内嵌地址按 IPv4 规则判定。
  const firstTwelveZero = bytes.slice(0, 12).every(byte => byte === 0);
  if (firstTwelveZero) {
    const embedded = [bytes[12], bytes[13], bytes[14], bytes[15]];
    if (embedded.every(byte => byte === 0)) return "reserved";
    return classifyIPv4(embedded) || "public";
  }
  // NAT64 (64:ff9b::/96)
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) {
    const embedded = [bytes[12], bytes[13], bytes[14], bytes[15]];
    return classifyIPv4(embedded) || "public";
  }
  // 6to4 (2002::/16)：内嵌 IPv4 在第 3–6 字节。
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const embedded = [bytes[2], bytes[3], bytes[4], bytes[5]];
    return classifyIPv4(embedded) || "public";
  }
  if (hasPrefix(bytes, [0xfc, 0], 7)) return "private";
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "link-local";
  if (bytes[0] === 0xff) return "multicast";
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return "reserved";
  if (hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 24)) return "reserved";
  return null;
}

/**
 * 判定一个地址字面量的类别。
 *
 * @param {string} address
 * @returns {{family: "ipv4"|"ipv6"|null, category: string|null}}
 */
export function classifyAddress(address) {
  const raw = text(address);
  if (!raw) return { family: null, category: null };
  const v4 = parseIPv4(raw);
  if (v4) return { family: "ipv4", category: classifyIPv4(v4) };
  const v6 = parseIPv6(raw);
  if (v6) return { family: "ipv6", category: classifyIPv6(v6) };
  return { family: null, category: null };
}

/**
 * 把地址字面量拆成可比对的字节（IPv4 为 4 字节，IPv6 为 16 字节）。
 *
 * @param {string} value
 * @returns {{family: "ipv4"|"ipv6"|null, bytes: number[]|null}}
 */
function addressBytes(value) {
  const raw = text(value);
  if (!raw) return { family: null, bytes: null };
  const v4 = parseIPv4(raw);
  if (v4) return { family: "ipv4", bytes: v4 };
  const v6 = parseIPv6(raw);
  if (v6) return { family: "ipv6", bytes: [...v6] };
  return { family: null, bytes: null };
}

/**
 * 两个地址是否指向同一个地址（按字节比较，因此
 * `::ffff:10.0.0.1` 与 `::ffff:a0a0:a01` 视为同一个）。
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function sameAddress(left, right) {
  const a = addressBytes(left);
  const b = addressBytes(right);
  if (!a.family || !b.family) return false;
  if (a.family !== b.family) return false;
  return a.bytes.every((byte, index) => byte === b.bytes[index]);
}

/**
 * 解析 allowList / denyList 条目。条目可以是完整 URL，也可以是主机名模式。
 *
 * @param {string} entry
 * @returns {{host: string, port: number|null}|null}
 */
function parseEntry(entry) {
  const raw = text(entry);
  if (!raw) return null;
  let host = raw;
  let port = null;
  if (raw.includes("://")) {
    try {
      const url = new URL(raw);
      host = url.hostname.toLowerCase();
      port = url.port ? Number.parseInt(url.port, 10) : defaultPortFor(url.protocol);
    } catch {
      return null;
    }
  } else if (raw.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
    if (!match) return null;
    host = match[1].toLowerCase();
    port = match[2] ? Number.parseInt(match[2], 10) : null;
  } else if (raw.includes(":") && addressBytes(raw).family === "ipv6") {
    // 裸 IPv6 字面量：不能按 host:port 解析，整段都是地址。
    host = raw.toLowerCase();
  } else {
    const match = /^([^:/?#]+)(?::(\d+))?$/.exec(raw);
    if (!match) return null;
    host = match[1].toLowerCase();
    port = match[2] ? Number.parseInt(match[2], 10) : null;
  }
  host = host.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (!host) return null;
  return { host, port };
}

/**
 * @param {string} protocol
 * @returns {number}
 */
function defaultPortFor(protocol) {
  return protocol === "https:" ? 443 : 80;
}

/**
 * 主机名模式匹配：`example.com` 精确匹配；`*.example.com` 匹配 example.com
 * 及其任意子域；条目带端口时端口也必须一致。
 *
 * @param {string} hostname
 * @param {number|null} port
 * @param {{host: string, port: number|null}} pattern
 * @returns {boolean}
 */
function matchesPattern(hostname, port, pattern) {
  const host = text(hostname).toLowerCase().replace(/\.$/, "");
  if (!host || !pattern) return false;
  if (pattern.port !== null && pattern.port !== port) return false;
  // 地址字面量按字节比较，避免 `::ffff:10.0.0.1` 与 `::ffff:a0a0:a01` 判不相等。
  if (addressBytes(host).family && addressBytes(pattern.host).family) {
    return sameAddress(host, pattern.host);
  }
  if (pattern.host.startsWith("*.")) {
    const base = pattern.host.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === pattern.host;
}

/**
 * 去掉 fragment、统一主机大小写、去掉默认端口、剥掉跟踪参数。
 * 用于审计与去重：同一个页面的不同分享链接应当折叠成同一个键。
 *
 * @param {string} url
 * @returns {string} 规范化后的 URL；无法解析时返回空字符串
 */
export function normalizeUrl(url) {
  const raw = text(url);
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  const protocol = parsed.protocol;
  if ((protocol === "http:" && parsed.port === "80") || (protocol === "https:" && parsed.port === "443")) {
    parsed.port = "";
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  let out = parsed.toString();
  if (out.endsWith("?")) out = out.slice(0, -1);
  return out;
}

/**
 * 创建网络出口策略。
 *
 * @param {object} [options]
 * @param {string[]} [options.allowList] 允许的主机或主机模式；为空表示全部拒绝
 * @param {string[]} [options.denyList] 拒绝的主机或主机模式；优先于 allowList
 * @param {boolean} [options.allowPrivateRanges] 是否放行私有/回环等保留地址
 * @param {number} [options.maxBytes] 响应体上限，供调用方执行
 * @param {number} [options.timeoutMs] 超时上限，供调用方执行
 * @param {number[]} [options.allowedPorts] 允许的端口
 * @param {(hostname: string) => Promise<string[]>|string[]} [options.resolver] 主机名解析器（注入，避免真实 DNS 副作用）
 * @param {boolean} [options.requireDnsVerification] 为 true 时，未注入 resolver 或解析失败一律拒绝
 * @returns {object} 策略对象
 */
export function createNetworkPolicy({
  allowList = [],
  denyList = [],
  allowPrivateRanges = false,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowedPorts = DEFAULT_ALLOWED_PORTS,
  resolver = null,
  requireDnsVerification = false
} = {}) {
  const allowEntries = (Array.isArray(allowList) ? allowList : [])
    .map(parseEntry)
    .filter(Boolean);
  const denyEntries = (Array.isArray(denyList) ? denyList : [])
    .map(parseEntry)
    .filter(Boolean);
  const portAllowList = new Set(
    (Array.isArray(allowedPorts) ? allowedPorts : DEFAULT_ALLOWED_PORTS)
      .map(port => Number.parseInt(port, 10))
      .filter(port => Number.isInteger(port) && port > 0 && port <= 65535)
  );

  /**
   * 构造一个拒绝判定。
   *
   * @param {string} reason
   * @param {object} [extra]
   * @returns {object}
   */
  function deny(reason, extra = {}) {
    return Object.freeze({
      allowed: false,
      reason,
      url: extra.url ?? "",
      normalizedUrl: extra.normalizedUrl ?? "",
      host: extra.host ?? "",
      protocol: extra.protocol ?? "",
      port: extra.port ?? null,
      addresses: Object.freeze([...(extra.addresses ?? [])]),
      dnsVerified: extra.dnsVerified ?? false,
      detail: extra.detail ?? ""
    });
  }

  /**
   * 构造一个放行判定。
   *
   * @param {object} extra
   * @returns {object}
   */
  function allow(extra = {}) {
    return Object.freeze({
      allowed: true,
      reason: POLICY_REASONS.ALLOWED,
      url: extra.url ?? "",
      normalizedUrl: extra.normalizedUrl ?? "",
      host: extra.host ?? "",
      protocol: extra.protocol ?? "",
      port: extra.port ?? null,
      addresses: Object.freeze([...(extra.addresses ?? [])]),
      dnsVerified: extra.dnsVerified ?? false,
      detail: extra.detail ?? ""
    });
  }

  /**
   * 判定一个地址字面量是否被范围规则拒绝。
   *
   * @param {string} address
   * @returns {{blocked: boolean, category: string|null}}
   */
  function checkAddress(address) {
    if (allowPrivateRanges) return { blocked: false, category: null };
    const { family, category } = classifyAddress(address);
    if (!family || !category || category === "public") return { blocked: false, category: category ?? null };
    return { blocked: true, category };
  }

  /**
   * 判定 URL 是否被策略允许。**同步**部分先跑，DNS 解析是异步的。
   *
   * @param {string} url
   * @returns {Promise<object>} 判定结果，永远 resolve，不会 reject
   */
  async function isUrlAllowed(url) {
    const raw = text(url);
    if (!raw) return deny(POLICY_REASONS.INVALID_URL, { url: raw, detail: "URL 为空" });

    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return deny(POLICY_REASONS.INVALID_URL, { url: raw, detail: "URL 无法解析" });
    }

    const protocol = parsed.protocol;
    // IPv6 主机名在 URL 里带方括号，比较与地址判定都按去掉方括号的形式。
    const host = parsed.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPortFor(protocol);
    const normalizedUrl = normalizeUrl(raw);
    const base = { url: raw, normalizedUrl, host, protocol, port };

    if (!ALLOWED_PROTOCOLS.includes(protocol)) {
      return deny(POLICY_REASONS.PROTOCOL_NOT_ALLOWED, { ...base, detail: `协议 ${protocol} 不在允许列表` });
    }
    if (parsed.username || parsed.password) {
      return deny(POLICY_REASONS.CREDENTIALS_IN_URL, { ...base, detail: "URL 中携带凭据" });
    }
    if (!host) {
      return deny(POLICY_REASONS.MISSING_HOST, { ...base, detail: "URL 缺少主机名" });
    }

    // 拒绝规则优先于允许规则。
    const denied = denyEntries.find(pattern => matchesPattern(host, port, pattern));
    if (denied) {
      return deny(POLICY_REASONS.DENY_LISTED, { ...base, detail: `命中拒绝列表：${denied.host}` });
    }

    if (allowEntries.length === 0) {
      return deny(POLICY_REASONS.EMPTY_ALLOW_LIST, { ...base, detail: "允许列表为空，策略默认关闭" });
    }
    const allowed = allowEntries.find(pattern => matchesPattern(host, port, pattern));
    if (!allowed) {
      return deny(POLICY_REASONS.NOT_ALLOW_LISTED, { ...base, detail: "主机不在允许列表中" });
    }

    if (isLocalHostname(host)) {
      return deny(POLICY_REASONS.BLOCKED_ADDRESS, { ...base, detail: "主机名指向本地命名空间" });
    }

    if (!portAllowList.has(port)) {
      return deny(POLICY_REASONS.PORT_NOT_ALLOWED, { ...base, detail: `端口 ${port} 不在端口白名单中` });
    }

    // 主机名 vs IP 字面量。
    const literal = classifyAddress(host);
    if (literal.family) {
      const verdict = checkAddress(host);
      if (verdict.blocked) {
        return deny(POLICY_REASONS.BLOCKED_ADDRESS, {
          ...base,
          detail: `目标地址属于 ${verdict.category} 段`,
          addresses: [host]
        });
      }
      return allow({ ...base, addresses: [host], dnsVerified: true });
    }

    // 主机名：只有在注入了 resolver 时才做地址判定，避免真实 DNS 副作用。
    if (typeof resolver !== "function") {
      if (requireDnsVerification) {
        return deny(POLICY_REASONS.DNS_UNVERIFIED, { ...base, detail: "未注入 resolver，无法验证主机名地址" });
      }
      return allow({ ...base, addresses: [], dnsVerified: false, detail: "未注入 resolver，未做 DNS 地址判定" });
    }

    let resolved = [];
    try {
      const result = await resolver(host);
      resolved = (Array.isArray(result) ? result : []).map(item => text(item)).filter(Boolean);
    } catch (error) {
      return deny(POLICY_REASONS.RESOLUTION_FAILED, { ...base, detail: `解析失败：${error?.message || "unknown error"}` });
    }
    if (resolved.length === 0) {
      return deny(POLICY_REASONS.UNRESOLVED_HOST, { ...base, detail: "主机名没有解析到任何地址" });
    }
    for (const address of resolved) {
      const verdict = checkAddress(address);
      if (verdict.blocked) {
        return deny(POLICY_REASONS.BLOCKED_ADDRESS, {
          ...base,
          detail: `主机名解析到 ${verdict.category} 段地址`,
          addresses: resolved,
          dnsVerified: true
        });
      }
    }
    return allow({ ...base, addresses: resolved, dnsVerified: true });
  }

  /**
   * 断言 URL 被允许；不允许时抛错，错误带 `statusCode` 与 `reason`。
   *
   * @param {string} url
   * @returns {Promise<object>} 放行判定
   */
  async function assertUrlAllowed(url) {
    const decision = await isUrlAllowed(url);
    if (decision.allowed) return decision;
    const error = new Error(`网络出口被拒绝（${decision.reason}）：${decision.detail || decision.host || url}`);
    error.code = "NETWORK_URL_NOT_ALLOWED";
    error.statusCode = decision.reason === POLICY_REASONS.INVALID_URL ? 400 : 403;
    error.reason = decision.reason;
    error.decision = decision;
    throw error;
  }

  /**
   * 策略的当前配置快照（供调用方执行字节上限/超时）。
   *
   * @returns {object}
   */
  function settings() {
    return Object.freeze({
      allowList: Object.freeze([...allowEntries].map(entry => entry.host)),
      denyList: Object.freeze([...denyEntries].map(entry => entry.host)),
      allowPrivateRanges,
      maxBytes,
      timeoutMs,
      allowedPorts: Object.freeze([...portAllowList].sort((a, b) => a - b)),
      dnsVerification: typeof resolver === "function" ? "injected" : (requireDnsVerification ? "required" : "disabled")
    });
  }

  return Object.freeze({
    isUrlAllowed,
    assertUrlAllowed,
    normalizeUrl,
    settings
  });
}
