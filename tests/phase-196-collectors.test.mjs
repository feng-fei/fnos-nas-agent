import assert from "node:assert/strict";
import { test } from "node:test";

import { createLogTailCollector, DEFAULT_LOG_PATHS, MAX_LOG_BYTES } from "../apps/fnos-nas-agent/app/log-tail-collector.mjs";
import { createThermalCollector, MAX_THERMAL_ZONES, THERMAL_ROOT } from "../apps/fnos-nas-agent/app/thermal-collector.mjs";

function fakeThermalFs(relativeFiles, names) {
  const files = Object.fromEntries(Object.entries(relativeFiles).map(([key, value]) => [`${THERMAL_ROOT}/${key}`, value]));
  return {
    readDir: (path) => {
      assert.equal(path, THERMAL_ROOT);
      return names ?? [...new Set(Object.keys(relativeFiles).map((key) => key.split("/")[0]))];
    },
    readFile: (path) => {
      if (!(path in files)) {
        const error = new Error(`ENOENT: ${path}`);
        error.code = "ENOENT";
        throw error;
      }
      return files[path];
    },
  };
}

test("thermal-collector: 只认 thermal_zoneN，按编号数字序排列", () => {
  const files = {
    "thermal_zone10/temp": "45000\n",
    "thermal_zone2/temp": "30000\n",
    "thermal_zone2/type": "x86_pkg_temp\n",
    "cooling_device0/temp": "1",
  };
  const collect = createThermalCollector(fakeThermalFs(files, ["cooling_device0", "thermal_zone10", "thermal_zone2"]));
  const { readings, notes } = collect();
  assert.deepEqual(readings.map((item) => item.source), ["thermal_zone2", "thermal_zone10"]);
  assert.equal(readings[0].label, "x86_pkg_temp");
  assert.equal(readings[0].raw, "30000");
  assert.equal(readings[0].unit, "milliCelsius");
  assert.deepEqual(notes, []);
});

test("thermal-collector: temp 读不到时跳过并留痕，不补 0℃", () => {
  const collect = createThermalCollector(fakeThermalFs({ "thermal_zone0/type": "acpitz" }, ["thermal_zone0"]));
  const { readings, notes } = collect();
  assert.deepEqual(readings, []);
  assert.deepEqual(notes, ["temp-unreadable:thermal_zone0", "no-thermal-zone"]);
});

test("thermal-collector: temp 为空时同样跳过", () => {
  const collect = createThermalCollector(fakeThermalFs({ "thermal_zone0/temp": "   \n" }, ["thermal_zone0"]));
  const { readings, notes } = collect();
  assert.deepEqual(readings, []);
  assert.deepEqual(notes, ["temp-empty:thermal_zone0", "no-thermal-zone"]);
});

test("thermal-collector: 缺 type 时用 zone 名当标签", () => {
  const collect = createThermalCollector(fakeThermalFs({ "thermal_zone1/temp": "41000" }, ["thermal_zone1"]));
  const { readings } = collect();
  assert.equal(readings.length, 1);
  assert.equal(readings[0].label, "thermal_zone1");
  assert.equal(readings[0].raw, "41000");
});

test("thermal-collector: 标签截断到 60 字符", () => {
  const label = "t".repeat(120);
  const collect = createThermalCollector(fakeThermalFs({ "thermal_zone0/temp": "40000", "thermal_zone0/type": label }, ["thermal_zone0"]));
  const { readings } = collect();
  assert.equal(readings[0].label.length, 60);
});

test("thermal-collector: zone 数超过 32 时截断并留痕", () => {
  const names = Array.from({ length: 40 }, (_, index) => `thermal_zone${index}`);
  const files = Object.fromEntries(names.map((name) => [`${name}/temp`, "39000"]));
  const collect = createThermalCollector(fakeThermalFs(files, names));
  const { readings, notes } = collect();
  assert.equal(readings.length, MAX_THERMAL_ZONES);
  assert.deepEqual(notes, [`zones-capped:${MAX_THERMAL_ZONES}`]);
});

test("thermal-collector: 没有任何 zone 时留痕 no-thermal-zone", () => {
  const collect = createThermalCollector(fakeThermalFs({}, []));
  const { readings, notes } = collect();
  assert.deepEqual(readings, []);
  assert.deepEqual(notes, ["no-thermal-zone"]);
});

test("thermal-collector: 根目录不可读时向上抛错，由路由报 unknown", () => {
  const collect = createThermalCollector({
    readDir: () => {
      throw new Error("EACCES");
    },
    readFile: () => "",
  });
  assert.throws(() => collect(), /EACCES/u);
});

test("thermal-collector: 注入点必须是函数", () => {
  assert.throws(() => createThermalCollector({ readDir: null }), TypeError);
  assert.throws(() => createThermalCollector({ readFile: 1 }), TypeError);
});

function fakeLogFs({ files = {}, bytes = {}, onClose = () => {} } = {}) {
  const reads = [];
  return {
    reads,
    fs: {
      statSync: (path) => {
        if (!(path in files)) {
          const error = new Error(`ENOENT: ${path}`);
          error.code = "ENOENT";
          throw error;
        }
        return { size: files[path], isFile: () => true };
      },
      openSync: (path) => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`);
        return path;
      },
      readSync: (fd, buffer, offset, length, position) => {
        reads.push({ fd, length, position });
        const payload = bytes[fd] ?? "";
        const encoded = Buffer.from(payload, "utf8").subarray(0, length);
        encoded.copy(buffer, offset);
        return encoded.length;
      },
      closeSync: (fd) => onClose(fd),
    },
  };
}

test("log-tail-collector: 只读尾部 maxBytes 字节并带上偏移", () => {
  const { fs, reads } = fakeLogFs({ files: { "/var/log/syslog": 100 }, bytes: { "/var/log/syslog": "x".repeat(10) } });
  const collect = createLogTailCollector({ paths: ["/var/log/syslog"], maxBytes: 10, fs });
  const result = collect();
  assert.equal(result.text.length, 10);
  assert.deepEqual(result.sources, ["/var/log/syslog"]);
  assert.deepEqual(reads, [{ fd: "/var/log/syslog", length: 10, position: 90 }]);
  assert.deepEqual(result.notes, []);
});

test("log-tail-collector: 多文件按顺序拼接", () => {
  const { fs } = fakeLogFs({
    files: { "/var/log/syslog": 3, "/var/log/messages": 3 },
    bytes: { "/var/log/syslog": "aaa", "/var/log/messages": "bbb" },
  });
  const collect = createLogTailCollector({ paths: ["/var/log/syslog", "/var/log/messages"], fs });
  const result = collect();
  assert.equal(result.text, "aaa\nbbb");
  assert.deepEqual(result.sources, ["/var/log/syslog", "/var/log/messages"]);
});

test("log-tail-collector: 非绝对路径在建构造器时即被过滤", () => {
  const { fs, reads } = fakeLogFs({ files: { "/var/log/syslog": 3 }, bytes: { "/var/log/syslog": "abc" } });
  const collect = createLogTailCollector({ paths: ["relative.log", "/var/log/syslog"], fs });
  assert.equal(collect().text, "abc");
  assert.equal(reads.length, 1);
});

test("log-tail-collector: 默认白名单覆盖 syslog/messages/kern.log", () => {
  assert.deepEqual([...DEFAULT_LOG_PATHS], ["/var/log/syslog", "/var/log/messages", "/var/log/kern.log"]);
  const collect = createLogTailCollector({ fs: fakeLogFs().fs });
  assert.deepEqual(collect(), { text: "", notes: [...DEFAULT_LOG_PATHS.map((path) => `unreadable:${path}`)], sources: [] });
});

test("log-tail-collector: 空文件与非普通文件不进结果", () => {
  const fs = {
    ...fakeLogFs({ files: {} }).fs,
    statSync: (path) => (path === "/var/log/syslog" ? { size: 0, isFile: () => true } : { size: 10, isFile: () => false }),
  };
  const collect = createLogTailCollector({ paths: ["/var/log/syslog", "/var/log/messages"], fs });
  const result = collect();
  assert.equal(result.text, "");
  assert.deepEqual(result.notes, ["empty:/var/log/syslog", "not-a-file:/var/log/messages"]);
});

test("log-tail-collector: read 返回 0 时记 short-read 且仍关闭 fd", () => {
  const closed = [];
  const fs = {
    statSync: () => ({ size: 10, isFile: () => true }),
    openSync: () => 7,
    readSync: () => 0,
    closeSync: (fd) => closed.push(fd),
  };
  const collect = createLogTailCollector({ paths: ["/var/log/syslog"], fs });
  const result = collect();
  assert.deepEqual(result.notes, ["short-read:/var/log/syslog"]);
  assert.deepEqual(closed, [7]);
});

test("log-tail-collector: read 抛错时也要关闭 fd", () => {
  const closed = [];
  const fs = {
    statSync: () => ({ size: 10, isFile: () => true }),
    openSync: () => 9,
    readSync: () => {
      throw new Error("EIO");
    },
    closeSync: (fd) => closed.push(fd),
  };
  const collect = createLogTailCollector({ paths: ["/var/log/syslog"], fs });
  assert.deepEqual(collect().notes, ["unreadable:/var/log/syslog"]);
  assert.deepEqual(closed, [9]);
});

test("log-tail-collector: maxBytes 非法时回落到 64KiB 上限", () => {
  const { fs, reads } = fakeLogFs({ files: { "/var/log/syslog": 20 }, bytes: { "/var/log/syslog": "y".repeat(20) } });
  const collect = createLogTailCollector({ paths: ["/var/log/syslog"], maxBytes: -1, fs });
  collect();
  assert.equal(reads[0].length, 20);
  assert.equal(MAX_LOG_BYTES, 64 * 1024);
});
