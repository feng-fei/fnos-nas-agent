/**
 * Phase 175 — 受控网页抓取实现
 *
 * node:test + node:assert/strict，零第三方依赖。
 * 全部用注入的假 fetchImpl，**不访问外网**。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createNetworkPolicy } from "../apps/fnos-nas-agent/app/network-policy.mjs";
import { createWebFetcher, REQUEST_HEADERS } from "../apps/fnos-nas-agent/app/web-fetch.mjs";

/**
 * 构造一个 fetch 风格的假响应。
 *
 * @param {{status?: number, headers?: object, body?: string}} options
 * @returns {object}
 */
function makeResponse({ status = 200, headers = {}, body = "" } = {}) {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const encoder = new TextEncoder();
  return {
    status,
    headers: { get: name => lower.get(String(name).toLowerCase()) ?? null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      }
    })
  };
}

/**
 * 记录调用次数的假 fetch。
 *
 * @param {Array<object>} responses 依次返回的响应
 * @returns {{fetchImpl: Function, calls: Array}}
 */
function recordingFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof next === "function") return next(url, options);
    return next;
  };
  return { fetchImpl, calls };
}

/**
 * 给策略套一层记录器，确认判定发生在请求之前、且每跳都判定。
 *
 * @param {object} policy
 * @returns {{policy: object, seen: string[]}}
 */
function recordingPolicy(policy) {
  const seen = [];
  return {
    seen,
    policy: {
      ...policy,
      isUrlAllowed: async url => {
        seen.push(url);
        return policy.isUrlAllowed(url);
      }
    }
  };
}

test("策略拒绝时不发起任何网络请求", async () => {
  const { fetchImpl, calls } = recordingFetch([makeResponse({ body: "<p>x</p>" })]);
  const policy = createNetworkPolicy({ allowList: ["127.0.0.1"] });
  const fetcher = createWebFetcher({ policy, fetchImpl });

  const result = await fetcher.fetchEvidence("http://127.0.0.1/secret");
  assert.equal(result.ok, false);
  assert.equal(result.evidence, null);
  assert.equal(result.error.code, "network-url-not-allowed");
  assert.equal(result.error.reason, "blocked-address");
  assert.equal(result.error.message.includes("blocked-address"), true);
  assert.equal(result.policy.allowed, false);
  assert.equal(result.policy.decision.reason, "blocked-address");
  assert.equal(calls.length, 0);
});

test("允许的 URL 抓取成功，请求头只有 Accept", async () => {
  const { fetchImpl, calls } = recordingFetch([
    makeResponse({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "sid=secret-cookie" },
      body: "<html><head><title>公告</title></head><body><p>正文内容</p></body></html>"
    })
  ]);
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const fetcher = createWebFetcher({ policy, fetchImpl });

  const result = await fetcher.fetchEvidence("https://example.com/notice", { fetchedAt: "2026-10-22T12:00:00.000Z" });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.evidence.title, "公告");
  assert.equal(result.evidence.excerpt.includes("正文内容"), true);
  assert.equal(result.evidence.fetchedAt, "2026-10-22T12:00:00.000Z");

  assert.equal(calls.length, 1);
  const headers = calls[0].options.headers;
  assert.deepEqual(Object.keys(headers), ["Accept"]);
  assert.equal(headers.Accept, REQUEST_HEADERS.Accept);
  assert.equal(Object.keys(headers).some(key => /cookie|authorization|token/i.test(key)), false);
  assert.equal(calls[0].options.redirect, "manual");
});

test("每一跳重定向都重新判定策略", async () => {
  const { fetchImpl, calls } = recordingFetch([
    makeResponse({ status: 302, headers: { location: "https://example.com/second" } }),
    makeResponse({ status: 200, headers: { "content-type": "text/plain" }, body: "第二页内容" })
  ]);
  const base = createNetworkPolicy({ allowList: ["example.com"] });
  const { policy, seen } = recordingPolicy(base);
  const fetcher = createWebFetcher({ policy, fetchImpl });

  const result = await fetcher.fetchEvidence("https://example.com/first");
  assert.equal(result.ok, true);
  assert.equal(result.evidence.excerpt.includes("第二页内容"), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(seen, ["https://example.com/first", "https://example.com/second"]);
});

test("重定向到私网地址被拒，且不会向私网发起请求", async () => {
  const { fetchImpl, calls } = recordingFetch([
    makeResponse({ status: 302, headers: { location: "http://10.0.0.5/secret" } })
  ]);
  const policy = createNetworkPolicy({ allowList: ["example.com", "10.0.0.5"] });
  const fetcher = createWebFetcher({ policy, fetchImpl });

  const result = await fetcher.fetchEvidence("https://example.com/redirect");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "network-url-not-allowed");
  assert.equal(result.error.reason, "blocked-address");
  assert.equal(calls.length, 1);
});

test("重定向到非 http/https 协议被拒", async () => {
  const { fetchImpl, calls } = recordingFetch([
    makeResponse({ status: 302, headers: { location: "file:///etc/passwd" } })
  ]);
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const fetcher = createWebFetcher({ policy, fetchImpl });

  const result = await fetcher.fetchEvidence("https://example.com/redirect");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "network-url-not-allowed");
  assert.equal(calls.length, 1);
});

test("重定向跳数超过上限被拒", async () => {
  const { fetchImpl, calls } = recordingFetch([
    makeResponse({ status: 302, headers: { location: "https://example.com/loop" } })
  ]);
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const fetcher = createWebFetcher({ policy, fetchImpl, maxRedirects: 2 });

  const result = await fetcher.fetchEvidence("https://example.com/start");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "too-many-redirects");
  assert.equal(calls.length, 3);
});

test("响应体超过字节上限被截断并标记", async () => {
  const filler = "A".repeat(5000);
  const { fetchImpl } = recordingFetch([
    makeResponse({ status: 200, headers: { "content-type": "text/plain" }, body: filler })
  ]);
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const fetcher = createWebFetcher({ policy, fetchImpl, maxBytes: 100 });

  const result = await fetcher.fetchEvidence("https://example.com/big");
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.evidence.bodyTruncated, true);
  assert.equal(result.evidence.truncated, true);
  assert.equal(result.evidence.excerpt.length <= 100, true);
});

test("整体超时真的中断请求", async () => {
  const hangingFetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const fetcher = createWebFetcher({ policy, fetchImpl: hangingFetch, timeoutMs: 30 });

  const result = await fetcher.fetchEvidence("https://example.com/slow");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "fetch-timeout");
  assert.equal(result.evidence, null);
});

test("非文本 content-type 一律拒绝并说明原因", async () => {
  const { fetchImpl } = recordingFetch([
    makeResponse({ status: 200, headers: { "content-type": "application/octet-stream" }, body: "binary" })
  ]);
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const fetcher = createWebFetcher({ policy, fetchImpl });

  const result = await fetcher.fetchEvidence("https://example.com/file");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsupported-content-type");
  assert.equal(result.error.message.includes("application/octet-stream"), true);
});

test("缺少 Content-Type 时拒绝解析", async () => {
  const { fetchImpl } = recordingFetch([makeResponse({ status: 200, body: "text" })]);
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const fetcher = createWebFetcher({ policy, fetchImpl });

  const result = await fetcher.fetchEvidence("https://example.com/nocontenttype");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "missing-content-type");
});

test("证据里不含原始 HTML 全文、set-cookie 与请求头", async () => {
  const rawHtml = "<html><head><title>T</title></head><body><p>唯一标记词</p></body></html>";
  const { fetchImpl } = recordingFetch([
    makeResponse({
      status: 200,
      headers: { "content-type": "text/html", "set-cookie": "sid=super-secret", "x-secret-header": "nope" },
      body: rawHtml
    })
  ]);
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const fetcher = createWebFetcher({ policy, fetchImpl });

  const result = await fetcher.fetchEvidence("https://example.com/page");
  const serialized = JSON.stringify(result);
  assert.equal(result.ok, true);
  assert.equal(serialized.includes("<html>"), false);
  assert.equal(serialized.includes("set-cookie"), false);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("x-secret-header"), false);
  assert.equal(result.evidence.excerpt.includes("唯一标记词"), true);
  assert.equal(result.evidence.excerpt.includes("<p>"), false);
});

test("错误信息里不含 URL 中的凭据", async () => {
  const { fetchImpl, calls } = recordingFetch([makeResponse({ body: "x" })]);
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const fetcher = createWebFetcher({ policy, fetchImpl });

  const result = await fetcher.fetchEvidence("https://user:pass@example.com/");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "network-url-not-allowed");
  assert.equal(JSON.stringify(result).includes("pass"), false);
  assert.equal(calls.length, 0);
});

test("settings 暴露上限与最小请求头", () => {
  const policy = createNetworkPolicy({ allowList: ["example.com"] });
  const fetcher = createWebFetcher({ policy, maxBytes: 1024, timeoutMs: 1000, maxRedirects: 1 });
  const settings = fetcher.settings();
  assert.equal(settings.maxBytes, 1024);
  assert.equal(settings.timeoutMs, 1000);
  assert.equal(settings.maxRedirects, 1);
  assert.deepEqual(Object.keys(settings.requestHeaders), ["Accept"]);
  assert.equal(settings.injectedFetch, false);
});

test("缺少 policy 时构造直接失败", () => {
  assert.throws(() => createWebFetcher({}), TypeError);
});
