import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Phase 174 - the overview panel for the workflow plans, the runbooks and the
// diagnostic evidence.
//
// The panel is a static page: the check reads the shipped files and proves
// that the elements exist, that the three read-only routes are called, that
// the rendering stays on textContent and that the panel is refreshed together
// with the overview page.

const uiDir = new URL("../apps/fnos-nas-agent/app/ui/", import.meta.url);
const pagesSource = await readFile(new URL("pages.js", uiDir), "utf8");
const indexHtml = await readFile(new URL("index.html", uiDir), "utf8");

function panelSource() {
  const start = pagesSource.indexOf("async function refreshPlaybooks(");
  assert.notEqual(start, -1, "pages.js must define refreshPlaybooks()");
  const end = pagesSource.indexOf("const playbooksRefreshBtn", start);
  assert.notEqual(end, -1, "pages.js must wire the refresh button");
  return pagesSource.slice(start, end);
}

test("the observation panel has its elements in the overview page", () => {
  for (const id of ["playbooks-refresh", "playbooks-status", "playbooks-workflows", "playbooks-runbooks", "playbooks-evidence"]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html must hold the element ${id}`);
  }
});

test("the panel reads the three read-only routes", () => {
  const source = panelSource();
  assert.ok(source.includes("/api/workflows"), "the panel must read the workflow plans");
  assert.ok(source.includes("/api/runbooks"), "the panel must read the runbooks");
  assert.ok(source.includes("/api/diagnostics/evidence"), "the panel must read the diagnostic evidence");
  assert.ok(source.includes("Promise.all"), "the three requests must run in parallel");
});

test("the panel renders on textContent only", () => {
  const source = panelSource();
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, "the panel must not build HTML");
  assert.ok(source.includes("textContent"), "the panel must write with textContent");
  // Every branch of a failed request writes its own message instead of
  // letting one broken route empty the whole panel.
  assert.ok((source.match(/读取失败：/g) || []).length >= 3, "each of the three blocks must report its own failure");
});

test("the panel is refreshed together with the overview page", () => {
  assert.ok(pagesSource.includes("await refreshPlaybooks()"), "the overview page must refresh the panel");
  assert.ok(pagesSource.includes('document.querySelector("#playbooks-refresh")'), "the refresh button must be wired");
});
