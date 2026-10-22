import { readFileSync, writeFileSync } from "node:fs";

const server = readFileSync("apps/fnos-nas-agent/app/server.mjs", "utf8");
const start = server.indexOf("function auditRoute");
const end = server.indexOf("\n}\n", start);
const src = server.slice(start, end);
// 三元表达式里的名字（`return method === "GET" ? "x" : "y"`）也要算进来，
// 否则白名单永远同步不全。
const names = new Set([...src.matchAll(/"([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)"/g)].map((m) => m[1]));

const auditPath = "apps/fnos-nas-agent/app/audit-log.mjs";
const audit = readFileSync(auditPath, "utf8");
const k = audit.indexOf("const ROUTES = new Set([");
const e = audit.indexOf("]);", k);
const set = new Set([...audit.slice(k, e).matchAll(/"([a-z][a-z0-9.-]*)"/g)].map((m) => m[1]));

const missing = [...names].filter((n) => !set.has(n)).sort();
console.log("route names", names.size, "whitelist", set.size);
console.log("MISSING:", missing.join(", "));

if (process.argv.includes("--write") && missing.length) {
  const merged = [...set, ...missing].sort();
  const block = merged.map((n) => `  "${n}",`).join("\n");
  const next = audit.slice(0, k) + "const ROUTES = new Set([\n" + block.replace(/,\n$/, "\n") + "]);" + audit.slice(e + 3);
  writeFileSync(auditPath, next);
  console.log("whitelist now", merged.length);
}
