import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  MAX_INTERFACES,
  MIN_THROUGHPUT_WINDOW_MS,
  parseProcNetDev,
  diffInterfaceCounters,
  parseRouteOutput,
  buildGatewayInput,
  buildThroughputInput,
  buildProxyInput
} from "../apps/fnos-nas-agent/app/network-collectors.mjs";
import { analyzeThroughput, detectGateway, inspectReverseProxy } from "../apps/fnos-nas-agent/app/network-diagnostics.mjs";

const EMPTY_ROUTE = { defaultGateway: null, defaultInterface: null, defaultMetric: null, routes: [] };
const EMPTY_PROXY = { headers: null, upstreams: [], servers: [], locations: [] };

const PROC_NET_DEV = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 111 2 0 0 0 0 0 0 111 2 0 0 0 0 0 0",
  "  eth0: 1000 10 1 2 0 0 0 0 2000 20 3 4 0 0 0 0",
  "  eth1: 3000 30 5 6 0 0 0 0 4000 40 7 8 0 0 0 0"
].join("\n");

const ROUTE_TEXT = [
  "default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.100 metric 100",
  "192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.100 metric 100",
  "10.0.0.0/8 via 192.168.1.254 dev eth0 metric 200"
].join("\n");

const PREVIOUS = {
  name: "eth0",
  rxBytes: 1000,
  txBytes: 2000,
  rxPackets: 100,
  txPackets: 200,
  rxErrors: 1,
  txErrors: 2,
  rxDropped: 3,
  txDropped: 4
};

const CURRENT = {
  name: "eth0",
  rxBytes: 4000,
  txBytes: 6000,
  rxPackets: 250,
  txPackets: 300,
  rxErrors: 3,
  txErrors: 6,
  rxDropped: 8,
  txDropped: 10
};

function interfaceLine(name, values = "1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0") {
  return `  ${name}: ${values}`;
}

function routeFixture() {
  return parseRouteOutput(ROUTE_TEXT);
}

test("parseProcNetDev: 正常快照解析 8 个计数器，跳过表头与 lo", () => {
  const result = parseProcNetDev(PROC_NET_DEV);
  assert.deepEqual(result, {
    interfaces: [
      { name: "eth0", rxBytes: 1000, txBytes: 2000, rxPackets: 10, txPackets: 20, rxErrors: 1, txErrors: 3, rxDropped: 2, txDropped: 4 },
      { name: "eth1", rxBytes: 3000, txBytes: 4000, rxPackets: 30, txPackets: 40, rxErrors: 5, txErrors: 7, rxDropped: 6, txDropped: 8 }
    ],
    skipped: 0
  });
  assert.equal(result.interfaces.some((item) => item.name === "lo"), false);
});

test("parseProcNetDev: 残缺行、非法数字、非法接口名整行跳过且不补 0", () => {
  const text = [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    interfaceLine("eth0"),
    "  eth1: 1000 10 1 2",
    "  eth2: 1000 10 bad 2 0 0 0 0 2000 20 3 4 0 0 0 0",
    "  eth 3: 1000 10 1 2 0 0 0 0 2000 20 3 4 0 0 0 0",
    "  not-an-interface-record"
  ].join("\n");
  const result = parseProcNetDev(text);
  assert.deepEqual(result.interfaces.map((item) => item.name), ["eth0"]);
  assert.equal(result.skipped, 3);
  assert.equal(result.interfaces[0].rxBytes, 1000);
});

test("parseProcNetDev: 重名接口只保留第一条并计入 skipped", () => {
  const text = [
    interfaceLine("eth0", "1000 10 1 2 0 0 0 0 2000 20 3 4 0 0 0 0"),
    interfaceLine("eth0", "9999 99 9 9 0 0 0 0 9999 99 9 9 0 0 0 0")
  ].join("\n");
  const result = parseProcNetDev(text);
  assert.equal(result.interfaces.length, 1);
  assert.equal(result.interfaces[0].rxBytes, 1000);
  assert.equal(result.skipped, 1);
});

test("parseProcNetDev: 空输入、纯表头与非字符串不抛异常", () => {
  assert.deepEqual(parseProcNetDev(""), { interfaces: [], skipped: 0 });
  assert.deepEqual(parseProcNetDev("   \n  "), { interfaces: [], skipped: 0 });
  assert.deepEqual(parseProcNetDev(undefined), { interfaces: [], skipped: 0 });
  assert.deepEqual(parseProcNetDev(null), { interfaces: [], skipped: 0 });
  const headerOnly = parseProcNetDev(PROC_NET_DEV.split("\n").slice(0, 2).join("\n"));
  assert.deepEqual(headerOnly, { interfaces: [], skipped: 0 });
});

test("parseProcNetDev: MAX_INTERFACES 截断到 64，多出的记录计入 skipped", () => {
  const text = Array.from({ length: MAX_INTERFACES + 1 }, (_, index) => interfaceLine(`eth${index}`)).join("\n");
  const result = parseProcNetDev(text);
  assert.equal(result.interfaces.length, MAX_INTERFACES);
  assert.equal(result.interfaces[0].name, "eth0");
  assert.equal(result.interfaces[MAX_INTERFACES - 1].name, `eth${MAX_INTERFACES - 1}`);
  assert.equal(result.skipped, 1);
});

test("diffInterfaceCounters: 按 elapsedMs 差分速率与 dropped/error 增量", () => {
  const diffs = diffInterfaceCounters([PREVIOUS], [CURRENT], { elapsedMs: 1000 });
  assert.deepEqual(diffs, [
    {
      name: "eth0",
      rxBytesPerSecond: 3000,
      txBytesPerSecond: 4000,
      rxPacketsPerSecond: 150,
      txPacketsPerSecond: 100,
      droppedDelta: 11,
      errorDelta: 6,
      reset: false
    }
  ]);
});

test("diffInterfaceCounters: 计数器回绕或变小 → reset: true 且速率/增量全为 null", () => {
  const rewound = { ...PREVIOUS, rxBytes: 1000, txBytes: 6000, rxPackets: 250, txPackets: 300 };
  const previous = { ...PREVIOUS, rxBytes: 5000 };
  const diffs = diffInterfaceCounters([previous], [rewound], { elapsedMs: 1000 });
  assert.deepEqual(diffs, [
    {
      name: "eth0",
      rxBytesPerSecond: null,
      txBytesPerSecond: null,
      rxPacketsPerSecond: null,
      txPacketsPerSecond: null,
      droppedDelta: null,
      errorDelta: null,
      reset: true
    }
  ]);
});

test("diffInterfaceCounters: elapsedMs 缺失/0/负数/NaN/字符串时速率一律 null", () => {
  const invalidElapsed = [undefined, 0, -1, NaN, "1000"];
  for (const elapsedMs of invalidElapsed) {
    const diffs = elapsedMs === undefined
      ? diffInterfaceCounters([PREVIOUS], [CURRENT])
      : diffInterfaceCounters([PREVIOUS], [CURRENT], { elapsedMs });
    assert.equal(diffs.length, 1, `elapsedMs=${String(elapsedMs)}`);
    assert.equal(diffs[0].reset, false);
    assert.equal(diffs[0].rxBytesPerSecond, null);
    assert.equal(diffs[0].txBytesPerSecond, null);
    assert.equal(diffs[0].rxPacketsPerSecond, null);
    assert.equal(diffs[0].txPacketsPerSecond, null);
    assert.equal(diffs[0].droppedDelta, 11);
    assert.equal(diffs[0].errorDelta, 6);
  }
});

test("diffInterfaceCounters: 没有基线的接口与非法主计数器不生成样本", () => {
  assert.deepEqual(diffInterfaceCounters([PREVIOUS], [{ ...CURRENT, name: "eth9" }], { elapsedMs: 1000 }), []);
  assert.deepEqual(diffInterfaceCounters([PREVIOUS], [{ name: "eth0", rxBytes: 4000 }], { elapsedMs: 1000 }), []);
  assert.deepEqual(diffInterfaceCounters([], []), []);
  assert.deepEqual(diffInterfaceCounters(undefined, undefined), []);
});

test("diffInterfaceCounters: 接受 parseProcNetDev 的 {interfaces} 包装", () => {
  const before = parseProcNetDev(PROC_NET_DEV);
  const after = parseProcNetDev(PROC_NET_DEV.replace("1000 10 1 2", "5000 60 2 3"));
  const diffs = diffInterfaceCounters(before, after, { elapsedMs: 2000 });
  assert.deepEqual(diffs.map((item) => item.name), ["eth0", "eth1"]);
  assert.equal(diffs[0].rxBytesPerSecond, 2000);
  assert.equal(diffs[0].rxPacketsPerSecond, 25);
  assert.equal(diffs[0].droppedDelta, 1);
  assert.equal(diffs[0].errorDelta, 1);
  assert.equal(diffs[1].rxBytesPerSecond, 0);
});

test("parseRouteOutput: 解析 ip route 文本，取默认路由与静态路由", () => {
  const route = parseRouteOutput(ROUTE_TEXT);
  assert.equal(route.defaultGateway, "192.168.1.1");
  assert.equal(route.defaultInterface, "eth0");
  assert.equal(route.defaultMetric, 100);
  assert.deepEqual(route.routes, [
    { destination: "default", gateway: "192.168.1.1", metric: 100, interface: "eth0" },
    { destination: "192.168.1.0/24", gateway: null, metric: 100, interface: "eth0" },
    { destination: "10.0.0.0/8", gateway: "192.168.1.254", metric: 200, interface: "eth0" }
  ]);
});

test("parseRouteOutput: 多条默认路由选 metric 最小的一条", () => {
  const route = parseRouteOutput([
    "default via 10.0.0.1 dev eth0 metric 200",
    "default via 192.168.1.1 dev eth1 metric 100"
  ].join("\n"));
  assert.equal(route.defaultGateway, "192.168.1.1");
  assert.equal(route.defaultInterface, "eth1");
  assert.equal(route.defaultMetric, 100);
  assert.equal(route.routes.length, 2);
});

test("parseRouteOutput: 兼容 ip -j route 的 JSON 数组", () => {
  const json = JSON.stringify([
    { dst: "default", gateway: "192.168.1.1", dev: "eth0", protocol: "dhcp", metric: 100 },
    { dst: "192.168.1.0/24", dev: "eth0", metric: 100 },
    { dst: "10.0.0.0/8", gateway: "192.168.1.254", dev: "eth1" }
  ]);
  const fromText = parseRouteOutput(json);
  assert.equal(fromText.defaultGateway, "192.168.1.1");
  assert.equal(fromText.defaultInterface, "eth0");
  assert.equal(fromText.defaultMetric, 100);
  assert.deepEqual(fromText.routes[2], { destination: "10.0.0.0/8", gateway: "192.168.1.254", metric: null, interface: "eth1" });

  const fromArray = parseRouteOutput([
    { dst: "default", gateway: "192.168.1.1", dev: "eth0", metric: 100 },
    { dst: "192.168.1.0/24", dev: "eth0", metric: 100 },
    { dst: "10.0.0.0/8", gateway: "192.168.1.254", dev: "eth1" }
  ]);
  assert.deepEqual(fromArray, fromText);
});

test("parseRouteOutput: 没有默认路由时 default* 全为 null，路由本身保留", () => {
  const route = parseRouteOutput("192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.100 metric 100");
  assert.equal(route.defaultGateway, null);
  assert.equal(route.defaultInterface, null);
  assert.equal(route.defaultMetric, null);
  assert.equal(route.routes.length, 1);
  assert.equal(route.routes[0].destination, "192.168.1.0/24");
});

test("parseRouteOutput: 空文本、空 JSON、坏 JSON、无关文本与非法入参不抛异常", () => {
  for (const input of ["", "   \n", "[]", "[{]", "not a route", 42, null, undefined]) {
    assert.deepEqual(parseRouteOutput(input), EMPTY_ROUTE, `input=${String(input)}`);
  }
});

test("buildGatewayInput: ping=null 时不伪造探测，detectGateway 保持 reachable=null", () => {
  const input = buildGatewayInput({ route: routeFixture(), ping: null });
  assert.deepEqual(input.probes, []);
  assert.equal(input.reachable, null);
  assert.equal(input.gateway, "192.168.1.1");
  assert.deepEqual(input.routes[0], { destination: "default", gateway: "192.168.1.1", iface: "eth0", metric: 100 });
  assert.deepEqual(input.routes[1], { destination: "192.168.1.0/24", gateway: null, iface: "eth0", metric: 100 });

  const verdict = detectGateway(input);
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.gateway, "192.168.1.1");
  assert.equal(verdict.reachable, null);
});

test("buildGatewayInput: interface→iface 映射正确，布尔 ping 决定 reachable", () => {
  const up = buildGatewayInput({ route: routeFixture(), ping: true });
  assert.equal(up.reachable, true);
  assert.deepEqual(up.probes, [{ target: "192.168.1.1", reachable: true, rttMs: null }]);
  assert.equal(detectGateway(up).reachable, true);

  const down = buildGatewayInput({ route: routeFixture(), ping: { reachable: false, rttMs: 12.5 } });
  assert.equal(down.reachable, false);
  assert.deepEqual(down.probes, [{ target: "192.168.1.1", reachable: false, rttMs: 12.5 }]);
  const verdict = detectGateway(down);
  assert.equal(verdict.reachable, false);
  assert.ok(verdict.causes.some((cause) => cause.code === "gateway-unreachable"));
});

test("buildGatewayInput: ping 对象缺少布尔 reachable 时不生成 probe", () => {
  const input = buildGatewayInput({ route: routeFixture(), ping: { rttMs: 3 } });
  assert.deepEqual(input.probes, []);
  assert.equal(input.reachable, null);
  assert.equal(detectGateway(input).reachable, null);
});

test("buildThroughputInput: 有效样本按 rx+tx 汇总，reset 记录被丢弃", () => {
  const diffs = [
    { name: "eth0", rxBytesPerSecond: 100, txBytesPerSecond: 50, reset: false },
    { name: "eth0", rxBytesPerSecond: null, txBytesPerSecond: null, reset: true },
    { name: "eth0", rxBytesPerSecond: 200, txBytesPerSecond: 100, reset: false }
  ];
  const input = buildThroughputInput({ diffs, windowMs: 5000 });
  assert.deepEqual(input.samples, [150, 300]);
  assert.equal(input.insufficient, false);
  assert.equal(input.windowMs, 5000);

  const verdict = analyzeThroughput(input);
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.summary.measured, 2);
  assert.equal(verdict.average, 225);
  assert.equal(verdict.peak, 300);
});

test("buildThroughputInput: 有效样本不足 2 个时返回 samples=[] 与 insufficient", () => {
  assert.deepEqual(buildThroughputInput({ diffs: [] }), { samples: [], insufficient: true });
  assert.deepEqual(buildThroughputInput({ diffs: [{ name: "eth0", rxBytesPerSecond: 100, txBytesPerSecond: 50, reset: false }], windowMs: 5000 }), { samples: [], insufficient: true });
  assert.deepEqual(buildThroughputInput({
    diffs: [
      { name: "eth0", rxBytesPerSecond: null, txBytesPerSecond: null, reset: true },
      { name: "eth0", rxBytesPerSecond: null, txBytesPerSecond: null, reset: true }
    ],
    windowMs: 5000
  }), { samples: [], insufficient: true });
});

test("buildThroughputInput: 窗口短于 MIN_THROUGHPUT_WINDOW_MS 或缺失/非法时同样判样本不足", () => {
  const diffs = [
    { name: "eth0", rxBytesPerSecond: 100, txBytesPerSecond: 50, reset: false },
    { name: "eth0", rxBytesPerSecond: 200, txBytesPerSecond: 100, reset: false }
  ];
  for (const windowMs of [undefined, 999, 0, -1000, NaN, "5000"]) {
    assert.deepEqual(buildThroughputInput({ diffs, windowMs }), { samples: [], insufficient: true }, `windowMs=${String(windowMs)}`);
  }
  assert.equal(buildThroughputInput({ diffs, windowMs: MIN_THROUGHPUT_WINDOW_MS }).insufficient, false);
});

test("buildProxyInput: 搬运 upstream/server/location 字段，缺省一律 null", () => {
  const config = {
    headers: { "X-Forwarded-For": "203.0.113.7" },
    upstreams: [
      {
        name: "app",
        servers: ["127.0.0.1:3000", { address: "127.0.0.1:3001", weight: 3, backup: true }]
      },
      { servers: [] }
    ],
    servers: [
      {
        listen: 443,
        serverName: "nas.local",
        ssl: true,
        locations: [{ path: "/", proxyPass: "http://app" }]
      }
    ],
    locations: [{ path: "/api", proxyPass: "http://app/api" }]
  };

  assert.deepEqual(buildProxyInput({ config }), {
    headers: { "X-Forwarded-For": "203.0.113.7" },
    upstreams: [
      {
        name: "app",
        servers: [
          { address: "127.0.0.1:3000", weight: null, backup: null },
          { address: "127.0.0.1:3001", weight: 3, backup: true }
        ]
      },
      { name: null, servers: [] }
    ],
    servers: [
      {
        listen: 443,
        serverName: "nas.local",
        ssl: true,
        locations: [{ path: "/", proxyPass: "http://app" }]
      }
    ],
    locations: [{ path: "/api", proxyPass: "http://app/api" }]
  });

  const aliases = buildProxyInput({ config: { server: [{ listen: "80 ssl" }], location: [{ path: "/x" }] } });
  assert.equal(aliases.headers, null);
  assert.deepEqual(aliases.servers, [{ listen: "80 ssl", serverName: null, ssl: null, locations: [] }]);
  assert.deepEqual(aliases.locations, [{ path: "/x", proxyPass: null }]);
});

test("buildProxyInput: 结构化 proxySetHeaders 被搬运，inspectReverseProxy 能识别反代", () => {
  const input = buildProxyInput({
    config: {
      proxySetHeaders: [
        { name: "X-Forwarded-For", value: "$proxy_add_x_forwarded_for" },
        { key: "X-Forwarded-Proto", value: "https" },
        { key: "X-Forwarded-Host", value: "$host" }
      ]
    }
  });
  assert.deepEqual(Object.keys(input.headers).sort(), ["X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"]);
  const verdict = inspectReverseProxy(input);
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.detected, true);
  assert.deepEqual(verdict.missing, []);
});

test("buildProxyInput: 没有结构化头部证据时 headers 为 null，nginx 原文不解析", () => {
  const rawText = buildProxyInput({ config: { proxySetHeaders: ["proxy_set_header X-Real-IP $remote_addr;"] } });
  assert.equal(rawText.headers, null);
  assert.equal(inspectReverseProxy(rawText).status, "unknown");

  const noHeaders = buildProxyInput({ config: { upstreams: [{ name: "app" }] } });
  assert.equal(noHeaders.headers, null);
  assert.equal(inspectReverseProxy(noHeaders).status, "unknown");

  const explicitEmpty = buildProxyInput({ config: { headers: {} } });
  assert.deepEqual(explicitEmpty.headers, {});
  assert.equal(inspectReverseProxy(explicitEmpty).detected, false);
});

test("导出常量与函数齐全", () => {
  assert.equal(MAX_INTERFACES, 64);
  assert.equal(MIN_THROUGHPUT_WINDOW_MS, 1000);
  for (const fn of [parseProcNetDev, diffInterfaceCounters, parseRouteOutput, buildGatewayInput, buildThroughputInput, buildProxyInput]) {
    assert.equal(typeof fn, "function");
  }
});

test("全空输入不抛异常且给出空结果", () => {
  assert.deepEqual(diffInterfaceCounters([], []), []);
  assert.deepEqual(buildGatewayInput({}), { routes: [], probes: [], gateway: null, reachable: null });
  assert.deepEqual(buildGatewayInput(), { routes: [], probes: [], gateway: null, reachable: null });
  assert.deepEqual(buildThroughputInput({}), { samples: [], insufficient: true });
  assert.deepEqual(buildThroughputInput(), { samples: [], insufficient: true });
  assert.deepEqual(buildProxyInput({ config: null }), EMPTY_PROXY);
  assert.deepEqual(buildProxyInput({ config: 42 }), EMPTY_PROXY);
  assert.deepEqual(buildProxyInput(), EMPTY_PROXY);
});

test("安全红线：模块源码不导入 I/O/子进程/DNS 模块，也不读 /proc", async () => {
  const source = await readFile(new URL("../apps/fnos-nas-agent/app/network-collectors.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /\b(?:readFile|readFileSync|exec|execSync|execFile|execFileSync|spawn|spawnSync|lookup|createConnection)\s*\(/);
  assert.match(source, /不读 \/proc/);
  assert.match(source, /不执行/);
  assert.match(source, /不做 DNS/);
  assert.match(source, /不补零/);
});
