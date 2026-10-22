import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeSamples,
  summarizeTrend,
  forecastCapacity,
  buildTrendVerdict
} from "../apps/fnos-nas-agent/app/capacity-forecast.mjs";

const GiB = 1024 ** 3;

/** 以 2026-01-01T00:00:00.000Z 为第 0 天构造一个整日时间戳。 */
const at = day => new Date(Date.UTC(2026, 0, 1 + day, 0, 0, 0)).toISOString();

/** 构造一条采样；单位是 GiB，方便手算期望值。 */
const sample = (day, usedGiB, totalGiB) => ({
  at: at(day),
  diskUsedBytes: usedGiB * GiB,
  diskTotalBytes: totalGiB * GiB
});

test("容量归一化：不可解析的时间被丢弃并计数，非数组输入退化为空结果", () => {
  const result = normalizeSamples([
    { at: "not-a-date", diskUsedBytes: 1, diskTotalBytes: 10 },
    null,
    { at: at(0), diskUsedBytes: 1, diskTotalBytes: 10 }
  ]);
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].at, at(0));
  assert.equal(result.dropped, 2);
  assert.deepEqual(result.droppedReasons, {
    badTimestamp: 2,
    badValue: 0,
    usedExceedsTotal: 0,
    duplicate: 0
  });

  const nonArray = normalizeSamples("nope");
  assert.deepEqual(nonArray.samples, []);
  assert.equal(nonArray.dropped, 0);
});

test("容量归一化：非有限值、负数、数字字符串与 used>total 分别计入不同原因", () => {
  const result = normalizeSamples([
    { at: at(0), diskUsedBytes: -1, diskTotalBytes: 10 },
    { at: at(1), diskUsedBytes: Number.NaN, diskTotalBytes: 10 },
    { at: at(2), diskUsedBytes: 1, diskTotalBytes: Number.POSITIVE_INFINITY },
    { at: at(3), diskUsedBytes: "1", diskTotalBytes: 10 },
    { at: at(4), diskUsedBytes: 11, diskTotalBytes: 10 }
  ]);
  assert.deepEqual(result.samples, []);
  assert.equal(result.droppedReasons.badValue, 4);
  assert.equal(result.droppedReasons.usedExceedsTotal, 1);
  assert.equal(result.dropped, 5);
});

test("容量归一化：按 at 升序、同一时间点只留最后一条", () => {
  const result = normalizeSamples([
    { at: at(1), diskUsedBytes: 20 * GiB, diskTotalBytes: 100 * GiB },
    { at: at(0), diskUsedBytes: 10 * GiB, diskTotalBytes: 100 * GiB },
    // 与 at(0) 是同一时间点的另一种写法：去重应基于解析后的时间，而不是字符串。
    { at: "2026-01-01T00:00:00Z", diskUsedBytes: 12 * GiB, diskTotalBytes: 100 * GiB },
    { at: at(1), diskUsedBytes: 30 * GiB, diskTotalBytes: 100 * GiB }
  ]);
  assert.equal(result.samples.length, 2);
  // 留「最后一条」是指输入顺序上的最后一条，它的原始 at 字符串也一并保留。
  assert.equal(result.samples[0].at, "2026-01-01T00:00:00Z");
  assert.equal(result.samples[0].diskUsedBytes, 12 * GiB);
  assert.equal(result.samples[1].diskUsedBytes, 30 * GiB);
  assert.equal(result.droppedReasons.duplicate, 2);
});

test("容量归一化：limit 截断只保留最新的采样，且截断不计入 dropped", () => {
  const window = Array.from({ length: 5 }, (_, day) => sample(day, 10 + day, 100));
  const limited = normalizeSamples(window, { limit: 3 });
  assert.equal(limited.samples.length, 3);
  assert.equal(limited.samples[0].at, at(2));
  assert.equal(limited.samples[2].at, at(4));
  assert.equal(limited.dropped, 0);
  assert.deepEqual(limited.droppedReasons, {
    badTimestamp: 0,
    badValue: 0,
    usedExceedsTotal: 0,
    duplicate: 0
  });
  assert.equal(normalizeSamples(window).samples.length, 5, "默认窗口应能容纳 5 条采样");
  assert.equal(normalizeSamples(window, { limit: 0 }).samples.length, 0);
});

test("容量趋势：稳态为高置信度、增长率为 0、不预测写满", () => {
  const steady = Array.from({ length: 10 }, (_, day) => sample(day, 40, 100));
  const trend = summarizeTrend(steady);
  assert.equal(trend.count, 10);
  assert.equal(trend.samplesUsed, 10);
  assert.equal(trend.windowDays, 9);
  assert.equal(trend.diskGrowthBytesPerDay, 0);
  assert.equal(trend.confidence, "high");
  assert.deepEqual(trend.notes, []);

  const forecast = forecastCapacity(steady);
  assert.equal(forecast.usedPercent, 40);
  assert.equal(forecast.daysUntilFull, null);
  assert.equal(forecast.reason, "no-growth");
  assert.equal(forecast.projectedUsedBytes, 40 * GiB);
  assert.equal(forecast.projectedUsedPercent, 40);
  assert.ok(forecast.assumptions.length >= 1);
});

test("容量预测：线性增长时写满天数按向下取整给出", () => {
  const growing = Array.from({ length: 11 }, (_, day) => sample(day, 20 + day * 3, 100));
  const trend = summarizeTrend(growing);
  assert.equal(trend.windowDays, 10);
  assert.equal(trend.diskGrowthBytesPerDay, 3 * GiB);
  assert.equal(trend.confidence, "high");

  const forecast = forecastCapacity(growing);
  assert.equal(forecast.currentUsedBytes, 50 * GiB);
  assert.equal(forecast.currentTotalBytes, 100 * GiB);
  assert.equal(forecast.usedPercent, 50);
  // (100 - 50) / 3 = 16.66…，向下取整是 16 天。
  assert.equal(forecast.daysUntilFull, 16);
  assert.equal(forecast.reason, null);
  assert.equal(forecast.projectedUsedBytes, 140 * GiB);
  assert.equal(forecast.projectedUsedPercent, 140);
});

test("容量趋势：单点离群被中位数抵抗，不把斜率带偏", () => {
  const used = [10, 11, 12, 100, 13];
  const samples = used.map((value, day) => sample(day, value, 1000));
  const trend = summarizeTrend(samples);
  // 增量（GiB/天）为 1、1、88、-87：中位数是 1，最小二乘会被拉到别处。
  assert.equal(trend.diskGrowthBytesPerDay, GiB);
  assert.equal(trend.confidence, "high");
  assert.equal(trend.samplesUsed, 5);

  const forecast = forecastCapacity(samples);
  assert.equal(forecast.daysUntilFull, 987); // (1000 - 13) / 1
});

test("容量趋势：总量中途变化时只在最后一段计算并记录 re-baseline", () => {
  const samples = [
    sample(0, 10, 100),
    sample(1, 12, 100),
    sample(2, 14, 100),
    sample(3, 100, 200),
    sample(4, 102, 200),
    sample(5, 104, 200)
  ];
  const trend = summarizeTrend(samples);
  assert.equal(trend.count, 6);
  assert.equal(trend.samplesUsed, 3);
  assert.equal(trend.windowDays, 2);
  assert.equal(trend.confidence, "medium");
  assert.deepEqual(trend.notes, ["total-changed-rebaselined"]);
  assert.equal(trend.diskGrowthBytesPerDay, 2 * GiB);

  const forecast = forecastCapacity(samples);
  assert.equal(forecast.currentTotalBytes, 200 * GiB);
  assert.equal(forecast.daysUntilFull, 48); // (200 - 104) / 2
  assert.ok(forecast.assumptions.some(text => text.includes("磁盘总量中途变化")));
});

test("容量预测：样本不足时不给天数、不给 low 以上置信度", () => {
  const sparse = [sample(0, 10, 100), sample(5, 20, 100)];
  const trend = summarizeTrend(sparse);
  assert.equal(trend.confidence, "low");
  assert.equal(trend.samplesUsed, 2);
  assert.equal(trend.diskGrowthBytesPerDay, 2 * GiB);

  const forecast = forecastCapacity(sparse);
  assert.equal(forecast.confidence, "low");
  assert.equal(forecast.daysUntilFull, null);
  assert.equal(forecast.reason, "insufficient-samples");
  assert.equal(forecast.usedPercent, 20);
  assert.ok(forecast.assumptions.some(text => text.includes("只给出当前快照")));

  const empty = forecastCapacity([]);
  assert.equal(empty.reason, "insufficient-samples");
  assert.equal(empty.currentUsedBytes, 0);
  assert.equal(empty.currentTotalBytes, 0);
  assert.equal(empty.usedPercent, 0);
  assert.equal(empty.daysUntilFull, null);
});

test("容量预测：horizonDays 为 0、负数、非数字或非有限值时抛 TypeError", () => {
  const valid = [sample(0, 10, 100)];
  for (const horizonDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "30", null]) {
    assert.throws(
      () => forecastCapacity(valid, { horizonDays }),
      TypeError,
      `horizonDays=${String(horizonDays)} 应被拒绝`
    );
  }
  assert.throws(() => buildTrendVerdict(valid, { horizonDays: 0 }), TypeError);
  assert.equal(forecastCapacity(valid, { horizonDays: 7 }).currentUsedBytes, 10 * GiB);
});

test("容量预测：总量为 0 时给 unknown-total，而不是编一个百分比", () => {
  const samples = [sample(0, 0, 0), sample(2, 0, 0), sample(4, 0, 0)];
  const forecast = forecastCapacity(samples);
  assert.equal(forecast.confidence, "high"); // 3 条采样、4 天跨度
  assert.equal(forecast.currentTotalBytes, 0);
  assert.equal(forecast.usedPercent, 0);
  assert.equal(forecast.projectedUsedPercent, 0);
  assert.equal(forecast.daysUntilFull, null);
  assert.equal(forecast.reason, "unknown-total");
  assert.ok(forecast.assumptions.some(text => text.includes("不猜总量")));
});

test("容量预测：负增长给 no-growth，预测值封顶在当前值并写中文假设", () => {
  const samples = [sample(0, 50, 100), sample(1, 49, 100), sample(2, 48, 100)];
  const trend = summarizeTrend(samples);
  assert.equal(trend.diskGrowthBytesPerDay, -1 * GiB);
  assert.equal(trend.confidence, "medium");

  const forecast = forecastCapacity(samples);
  assert.equal(forecast.reason, "no-growth");
  assert.equal(forecast.daysUntilFull, null);
  assert.equal(forecast.projectedUsedBytes, 48 * GiB);
  assert.equal(forecast.projectedUsedPercent, 48);
  assert.ok(forecast.assumptions.some(text => text.includes("负增长")));
});

test("容量结论：ok 态给出一句话、结构化条目与可算的写满天数", () => {
  const growing = Array.from({ length: 11 }, (_, day) => sample(day, 20 + day * 3, 100));
  const verdict = buildTrendVerdict(growing);
  assert.equal(verdict.status, "ok");
  assert.match(verdict.headline, /16 天/);
  assert.match(verdict.headline, /写满/);
  assert.equal(verdict.items.length, 3);

  const fill = verdict.items.find(item => item.label === "预计写满");
  assert.equal(fill.value, 16);
  assert.equal(fill.unit, "天");
  const usage = verdict.items.find(item => item.label === "使用率");
  assert.equal(usage.value, 50);
  assert.ok(verdict.notes.every(note => typeof note === "string"));
  assert.ok(verdict.notes.some(note => note.includes("置信度 高")));
});

test("容量结论：insufficient 态明说「样本不足，暂不预测」且不编数字", () => {
  const onePoint = buildTrendVerdict([sample(0, 10, 100)]);
  assert.equal(onePoint.status, "insufficient");
  assert.ok(onePoint.headline.includes("样本不足，暂不预测"));
  assert.doesNotMatch(onePoint.headline, /\d/);
  assert.doesNotMatch(onePoint.headline, /天后写满/);
  assert.equal(onePoint.items.find(item => item.label === "预计写满"), undefined);

  const twoPoints = buildTrendVerdict([sample(0, 10, 100), sample(5, 20, 100)]);
  assert.equal(twoPoints.status, "insufficient");
  assert.ok(twoPoints.notes.some(note => note.includes("不给预测数字")));
});

test("容量结论：unknown 态只报当前已用，不猜总量与剩余空间", () => {
  const verdict = buildTrendVerdict([sample(0, 0, 0), sample(2, 0, 0), sample(4, 0, 0)]);
  assert.equal(verdict.status, "unknown");
  assert.ok(verdict.headline.includes("总量未知"));
  assert.doesNotMatch(verdict.headline, /\d/);
  const total = verdict.items.find(item => item.label === "磁盘总量");
  assert.equal(total.value, null);
  assert.equal(total.unit, "GiB");
  assert.ok(verdict.notes.some(note => note.includes("不推算使用率")));
});

test("容量模块：零依赖、零 I/O（源码没有 import，也不碰 fs/子进程/http）", async () => {
  const source = await readFile(
    new URL("../apps/fnos-nas-agent/app/capacity-forecast.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /node:(?:fs|child_process|http)\b/);
  assert.doesNotMatch(source, /\bprocess\.(?:env|argv|exit)\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});
