import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const docsDir = fileURLToPath(new URL("docs/", root));

function collectRelativeLinks(markdown) {
  const links = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match = pattern.exec(markdown);
  while (match) {
    const target = match[1];
    if (!/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) {
      links.push(target.split("#")[0]);
    }
    match = pattern.exec(markdown);
  }
  return links;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

test("README.md relative links point at existing files", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  const links = collectRelativeLinks(readme);
  assert.ok(links.length > 0, "README.md must contain relative links");

  const missing = [];
  for (const link of links) {
    const target = new URL(link, root);
    if (!(await exists(target))) missing.push(link);
  }
  assert.deepEqual(missing, [], `README.md links must resolve: ${missing.join(", ")}`);
});

test("docs/README.md relative links point at existing files", async () => {
  const index = await readFile(join(docsDir, "README.md"), "utf8");
  const links = collectRelativeLinks(index);
  assert.ok(links.length > 0, "docs/README.md must contain relative links");

  const missing = [];
  for (const link of links) {
    const target = join(docsDir, link);
    if (!(await exists(target))) missing.push(link);
  }
  assert.deepEqual(missing, [], `docs/README.md links must resolve: ${missing.join(", ")}`);
});

test("docs/README.md lists every document in docs/", async () => {
  const index = await readFile(join(docsDir, "README.md"), "utf8");
  const files = (await readdir(docsDir)).filter((name) => name.endsWith(".md")).sort();

  const missing = files.filter((name) => !index.includes(`](${name})`));
  assert.deepEqual(
    missing,
    [],
    `every document must be listed in docs/README.md: ${missing.join(", ")}`
  );
});

test("documentation index does not point at documents that no longer exist", async () => {
  const index = await readFile(join(docsDir, "README.md"), "utf8");
  const files = new Set((await readdir(docsDir)).filter((name) => name.endsWith(".md")));

  const stale = collectRelativeLinks(index).filter((link) => !files.has(link));
  assert.deepEqual(stale, [], `docs/README.md must not list removed documents: ${stale.join(", ")}`);
});
