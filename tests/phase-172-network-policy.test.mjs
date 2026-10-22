/**
 * Phase 172 — 网络出口策略与 SSRF 防护 / 受控 Web 取证证据
 *
 * node:test + node:assert/strict，零第三方依赖。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createNetworkPolicy, normalizeUrl, classifyAddress, POLICY_REASONS } from "../apps/fnos-nas-agent/app/network-policy.mjs";
import { buildWebEvidence, htmlToText } from "../apps/fnos-nas-agent/app/web-evidence.mjs";

test("默认关闭：允许列表为空时任何 URL 都被拒绝", async () => {
  const policy = createNetworkPolicy();
  const decision = await policy.isUrlAllowed("https://example.com/");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, POLICY_REASONS.EMPTY_ALLOW_LIST);
  assert.equal(decision.detail.length > 0, true);
});

test("显式放行的 http/https 通过判定", async () => {
  const policy = createNetworkPolicy({ allowList: ["example.com", "docs.example.org"] });
  const https = await policy.isUrlAllowed("https://example.com/page");
  assert.equal(https.allowed, true);
  assert.equal(https.reason, POLICY_REASONS.ALLOWED);
  assert.equal(https.protocol, "https:");

  const http = await policy.isUrlAllowed("http://docs.example.org/");
  assert.equal(http.allowed, true);
  assert.equal(http.port, 80);
});

test("非 http/https 协议一律拒绝", async () => {
  const policy = createNetworkPolicy({ allowList: ["*"] });
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"]) {
    const decision = await policy.isUrlAllowed(url);
    assert.equal(decision.allowed, false, url);
    assert.equal(decision.reason, POLICY_REASONS.PROTOCOL_NOT_ALLOWED, url);
  }
});

test("带凭据的 URL 被拒绝", async () => {
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const decision = await policy.isUrlAllowed("https://user:pass@example.com/");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, POLICY_REASONS.CREDENTIALS_IN_URL);
});

test("回环 / 私有 / 链路本地 / 组播地址被拒绝", async () => {
  const policy = createNetworkPolicy({
    allowList: ["127.0.0.1", "10.0.0.5", "192.168.1.10", "172.16.5.4", "169.254.169.254", "224.0.0.1", "0.0.0.0", "255.255.255.255"]
  });
  const cases = [
    ["http://127.0.0.1/", "loopback"],
    ["http://10.0.0.5/", "private"],
    ["http://192.168.1.10/", "private"],
    ["http://172.16.5.4/", "private"],
    ["http://169.254.169.254/latest/meta-data/", "link-local"],
    ["http://224.0.0.1/", "multicast"],
    ["http://0.0.0.0/", "reserved"],
    ["http://255.255.255.255/", "reserved"]
  ];
  for (const [url, category] of cases) {
    const decision = await policy.isUrlAllowed(url);
    assert.equal(decision.allowed, false, url);
    assert.equal(decision.reason, POLICY_REASONS.BLOCKED_ADDRESS, url);
    assert.equal(decision.detail.includes(category), true, `${url} → ${decision.detail}`);
  }
});

test("IPv4-mapped IPv6 私网地址被拒绝", async () => {
  const policy = createNetworkPolicy({ allowList: ["::ffff:10.0.0.1", "::ffff:127.0.0.1"] });
  const decision = await policy.isUrlAllowed("http://[::ffff:10.0.0.1]/secret");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, POLICY_REASONS.BLOCKED_ADDRESS);
  assert.equal(classifyAddress("::ffff:10.0.0.1").category, "private");
  assert.equal(classifyAddress("::1").category, "loopback");
  assert.equal(classifyAddress("fe80::1").category, "link-local");
  assert.equal(classifyAddress("fd00::1").category, "private");
  assert.equal(classifyAddress("ff02::1").category, "multicast");
});

test("解析到私网地址的主机名被拒绝（注入 resolver，无真实 DNS 副作用）", async () => {
  const policy = createNetworkPolicy({
    allowList: ["internal.example.com", "public.example.com", "nowhere.example.com"],
    resolver: async hostname => {
      if (hostname === "internal.example.com") return ["10.1.2.3"];
      if (hostname === "public.example.com") return ["93.184.216.34"];
      return [];
    }
  });
  const internal = await policy.isUrlAllowed("https://internal.example.com/");
  assert.equal(internal.allowed, false);
  assert.equal(internal.reason, POLICY_REASONS.BLOCKED_ADDRESS);
  assert.equal(internal.dnsVerified, true);

  const publicHost = await policy.isUrlAllowed("https://public.example.com/");
  assert.equal(publicHost.allowed, true);
  assert.equal(publicHost.dnsVerified, true);

  const missing = await policy.isUrlAllowed("https://nowhere.example.com/");
  assert.equal(missing.allowed, false);
  assert.equal(missing.reason, POLICY_REASONS.UNRESOLVED_HOST);
});

test("端口白名单之外的端口被拒绝", async () => {
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const denied = await policy.isUrlAllowed("http://example.com:8080/");
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, POLICY_REASONS.PORT_NOT_ALLOWED);

  const opened = createNetworkPolicy({ allowList: ["example.com"], allowedPorts: [80, 443, 8080] });
  const allowed = await opened.isUrlAllowed("http://example.com:8080/");
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.port, 8080);
});

test("拒绝规则优先于允许规则", async () => {
  const policy = createNetworkPolicy({
    allowList: ["*.example.com", "example.com"],
    denyList: ["blocked.example.com"]
  });
  const decision = await policy.isUrlAllowed("https://blocked.example.com/");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, POLICY_REASONS.DENY_LISTED);

  const other = await policy.isUrlAllowed("https://other.example.com/");
  assert.equal(other.allowed, true);
});

test("未注入 resolver 时按结构判定本地命名空间；可要求强制 DNS 校验", async () => {
  const policy = createNetworkPolicy({ allowList: ["localhost", "internal.local", "example.com"] });
  const local = await policy.isUrlAllowed("http://localhost:8080/");
  assert.equal(local.allowed, false);
  assert.equal(local.reason, POLICY_REASONS.BLOCKED_ADDRESS);

  const localSuffix = await policy.isUrlAllowed("http://metadata.internal/");
  assert.equal(localSuffix.allowed, false);

  const plain = await policy.isUrlAllowed("https://example.com/");
  assert.equal(plain.allowed, true);
  assert.equal(plain.dnsVerified, false);

  const strict = createNetworkPolicy({ allowList: ["example.com"], requireDnsVerification: true });
  const strictDecision = await strict.isUrlAllowed("https://example.com/");
  assert.equal(strictDecision.allowed, false);
  assert.equal(strictDecision.reason, POLICY_REASONS.DNS_UNVERIFIED);
});

test("allowPrivateRanges 打开后私网地址可放行", async () => {
  const strict = createNetworkPolicy({ allowList: ["10.0.0.5"] });
  assert.equal((await strict.isUrlAllowed("http://10.0.0.5/")).allowed, false);

  const relaxed = createNetworkPolicy({ allowList: ["10.0.0.5"], allowPrivateRanges: true });
  const decision = await relaxed.isUrlAllowed("http://10.0.0.5/");
  assert.equal(decision.allowed, true);
});

test("assertUrlAllowed 拒绝时抛错并带 statusCode 与 reason", async () => {
  const policy = createNetworkPolicy();
  await assert.rejects(
    () => policy.assertUrlAllowed("https://example.com/"),
    error => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.reason, POLICY_REASONS.EMPTY_ALLOW_LIST);
      assert.equal(error.code, "NETWORK_URL_NOT_ALLOWED");
      return true;
    }
  );
  await assert.rejects(
    () => policy.assertUrlAllowed("不是 URL"),
    error => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.reason, POLICY_REASONS.INVALID_URL);
      return true;
    }
  );
  const allowed = createNetworkPolicy({ allowList: ["example.com"] });
  const decision = await allowed.assertUrlAllowed("https://example.com/x");
  assert.equal(decision.allowed, true);
});

test("normalizeUrl 去 fragment、统一主机、去掉默认端口、剥掉跟踪参数", () => {
  assert.equal(
    normalizeUrl("HTTPS://Example.COM:443/path?utm_source=news&b=2&a=1#section"),
    "https://example.com/path?a=1&b=2"
  );
  assert.equal(normalizeUrl("http://example.com:80/x"), "http://example.com/x");
  assert.equal(normalizeUrl("https://example.com/x?gclid=1&fbclid=2&keep=3"), "https://example.com/x?keep=3");
  assert.equal(normalizeUrl("not a url"), "");
});

test("settings 暴露字节上限与超时", () => {
  const policy = createNetworkPolicy({ allowList: ["example.com"], maxBytes: 1024, timeoutMs: 2500 });
  const settings = policy.settings();
  assert.equal(settings.maxBytes, 1024);
  assert.equal(settings.timeoutMs, 2500);
  assert.equal(settings.allowPrivateRanges, false);
  assert.deepEqual([...settings.allowedPorts], [80, 443]);
});

test("buildWebEvidence 截断正文、剥离脚本、只保留纯文本摘要", () => {
  const body = [
    "<html><head><title>公告 标题</title></head><body>",
    "<script>var secret = 'sk-abcdef1234567890';</script>",
    "<style>body { color: red; }</style>",
    "<p>这是第一段正文，用来验证纯文本摘要。</p>",
    "<p>这是第二段正文，同样应该被保留成纯文本。</p>",
    "</body></html>"
  ].join("");
  const evidence = buildWebEvidence({
    url: "https://example.com/notice",
    status: 200,
    contentType: "text/html; charset=utf-8",
    body,
    fetchedAt: "2026-10-22T12:00:00.000Z",
    policyDecision: { allowed: true, reason: "allowed" },
    maxLength: 30
  });
  assert.equal(evidence.allowed, true);
  assert.equal(evidence.title, "公告 标题");
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.length <= 31, true);
  assert.equal(evidence.excerpt.includes("sk-abcdef1234567890"), false);
  assert.equal(evidence.excerpt.includes("var secret"), false);
  assert.equal(evidence.excerpt.includes("color: red"), false);
  assert.equal(evidence.bytes > 0, true);
  assert.equal(evidence.policy.reason, "allowed");
});

test("buildWebEvidence 对密钥与令牌脱敏，并只记录被过滤的字段名", () => {
  const body = [
    "<html><body>",
    "<p>apiKey=sk-abcdef1234567890</p>",
    "<p>password: hunter2secret</p>",
    "<p>ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345</p>",
    "</body></html>"
  ].join("");
  const evidence = buildWebEvidence({
    url: "https://example.com/config",
    status: 200,
    contentType: "text/html",
    body
  });
  assert.equal(evidence.excerpt.includes("sk-abcdef1234567890"), false);
  assert.equal(evidence.excerpt.includes("hunter2secret"), false);
  assert.equal(evidence.excerpt.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), false);
  assert.equal(evidence.excerpt.includes("[已隐藏]"), true);
  assert.equal(evidence.redactedFields.includes("apikey"), true);
  assert.equal(evidence.redactedFields.includes("password"), true);
  assert.equal(evidence.redactedFields.includes("token"), true);
  assert.equal(evidence.redactedFields.some(field => field.includes("sk-abcdef1234567890")), false);
});

test("策略拒绝时不产出任何正文（不静默降级）", () => {
  const evidence = buildWebEvidence({
    url: "http://10.0.0.5/secret",
    status: 0,
    contentType: "text/html",
    body: "<html><body>不该出现的正文</body></html>",
    policyDecision: { allowed: false, reason: "blocked-address" }
  });
  assert.equal(evidence.allowed, false);
  assert.equal(evidence.excerpt, "");
  assert.equal(evidence.bytes, 0);
  assert.equal(evidence.policy.reason, "blocked-address");
});

test("htmlToText 提取标题并去掉标签", () => {
  const { title, text } = htmlToText("<html><head><title>T</title></head><body><p>a &amp; b</p></body></html>");
  assert.equal(title, "T");
  assert.equal(text, "a & b");
});
