// Phase 225 — UI2 控制台不变量。
// 这组测试是旧 UI 源码断言（phase-154/157/179/211/213/214/216 等）在重建前端上的等价物，
// 也是旧 UI 退役的前置条件：本文件通过后，旧 UI 与其测试才能同批退役。

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const appDir = join(process.cwd(), "apps/fnos-nas-agent/app");
const ui2Dir = join(appDir, "ui", "next");

async function walk(dir, base = dir){
  const out = [];
  for(const entry of await readdir(dir, { withFileTypes: true })){
    const full = join(dir, entry.name);
    const rel = full.slice(base.length + 1).replaceAll("\\", "/");
    if(entry.isDirectory()) out.push(...await walk(full, base));
    else if(/\.(js|html|css)$/.test(entry.name)) out.push({ rel, src: await readFile(full, "utf8") });
  }
  return out;
}

const files = await walk(ui2Dir);
const jsFiles = files.filter(f => f.rel.endsWith(".js"));
const serverSrc = await readFile(join(appDir, "server.mjs"), "utf8");
const apiSrc = await readFile(join(ui2Dir, "js", "api.js"), "utf8");

function parseRoutes(){
  const block = apiSrc.slice(apiSrc.indexOf("const ROUTES = {"), apiSrc.indexOf("export function routeUrl"));
  const routes = [];
  for(const m of block.matchAll(/^\s{2}([A-Za-z0-9]+):\s*\["(\w+)",\s*"([^"]+)"\]/gm))
    routes.push({ name: m[1], method: m[2], template: m[3] });
  return routes;
}

test("UI2 rendering never builds markup from strings", () => {
  for(const f of files){
    for(const bad of ["innerHTML", "insertAdjacentHTML", "outerHTML", "document.write"])
      assert.ok(!f.src.includes(bad), `${f.rel} must not use ${bad}`);
  }
});

test("pages talk to the server only through the named API client", () => {
  for(const f of jsFiles){
    if(f.rel.endsWith("api.js")) continue;
    assert.doesNotMatch(f.src, /["']\/api\//, `${f.rel} hand-writes an /api path; use call()/routeUrl()`);
  }
  assert.match(apiSrc, /const ROUTES = \{/);
  assert.match(apiSrc, /export async function call\(/);
  assert.match(apiSrc, /export function routeUrl\(/);
});

test("every UI2 route template has a server counterpart", () => {
  const routes = parseRoutes();
  assert.ok(routes.length >= 90, "the named route table should stay comprehensive");
  for(const route of routes){
    const segments = route.template.split("/");
    const firstParam = segments.findIndex(s => s.startsWith(":"));
    const prefix = (firstParam === -1 ? segments : segments.slice(0, firstParam)).join("/") || "/";
    const tail = segments[segments.length - 1];
    const prefixOk = serverSrc.includes(prefix);
    const tailOk = firstParam !== -1 && serverSrc.includes(tail);
    assert.ok(prefixOk && (firstParam === -1 || tailOk),
      `route ${route.name} (${route.template}) has no server counterpart`);
  }
});

test("every server static route has a UI2 counterpart", () => {
  const routes = parseRoutes();
  const templates = routes.map(r => r.template);
  const serverStatic = new Set();
  for(const m of serverSrc.matchAll(/(?:url\.pathname|pathname) === "((?:\/api\/[a-z0-9._/-]+))"/g))
    serverStatic.add(m[1]);
  assert.ok(serverStatic.size >= 60, "expected the full server route surface");
  for(const path of serverStatic){
    const covered = templates.some(tpl => {
      const t = tpl.split("/");
      const c = path.split("/");
      if(t.length !== c.length) return false;
      return t.every((seg, i) => seg.startsWith(":") || seg === c[i]);
    });
    assert.ok(covered, `server route ${path} has no UI2 route template`);
  }
});

test("plaintext apiKey stays inside the settings form and the request payload", () => {
  for(const f of jsFiles){
    if(!f.src.includes("apiKey")) continue;
    assert.ok(/pages\/settings\.js$/.test(f.rel) || f.rel.endsWith("api.js"),
      `apiKey must not appear in ${f.rel}`);
  }
  const settings = jsFiles.find(f => f.rel.endsWith("pages/settings.js"));
  // 明文 key 只允许：读取输入框 value、写入 payload、clearApiKey 标记、占位提示。
  const occurrences = settings.src.match(/apiKey/g).length;
  assert.ok(occurrences <= 8, `settings.js mentions apiKey ${occurrences} times; keep it to form/payload only`);
});

test("the shell wires the session state machine and the five-zone router", () => {
  const main = jsFiles.find(f => f.rel.endsWith("main.js")).src;
  assert.match(main, /bootSession/);
  assert.match(main, /store\.session\.sub/);
  assert.match(main, /form-setup/);
  assert.match(main, /form-login/);
  assert.match(main, /api\/logout|"logout"/);
  const router = jsFiles.find(f => f.rel.endsWith("router.js")).src;
  for(const zone of ["home", "chat", "files", "system", "settings"])
    assert.match(router, new RegExp(`id:"${zone}"`), `missing zone ${zone}`);
});

test("chat consumes the task event stream and keeps a polling fallback", () => {
  const chat = jsFiles.find(f => f.rel.endsWith("pages/chat.js")).src;
  assert.match(chat, /EventSource/);
  assert.match(chat, /taskEvents/);
  assert.match(chat, /taskGet/);
  assert.match(chat, /taskCancel/);
  assert.match(chat, /agentMessage/);
  assert.match(chat, /actionConfirm/);
  assert.match(chat, /actionDeny/);
});

test("files destructive actions always go through the server approval flow", () => {
  const files = jsFiles.find(f => f.rel.endsWith("pages/files.js")).src;
  assert.match(files, /approvalRequired/);
  assert.match(files, /approvalModal|actionConfirm/);
  assert.match(files, /fileBatch/);
  assert.doesNotMatch(files, /action:\s*"delete"[^}]*confirm:\s*true/);
});

test("the settings zone keeps the dangerous-mode switch behind a confirmation", () => {
  const settings = jsFiles.find(f => f.rel.endsWith("pages/settings.js")).src;
  assert.match(settings, /executionMode/);
  assert.match(settings, /halted/);
  assert.match(settings, /confirmModal\(\s*"切换执行模式"/);
  assert.match(settings, /knowledgePreview/);
  assert.match(settings, /previewId/);
});
