import { readFile, readdir } from "node:fs/promises";

const uiDir = new URL("../../apps/fnos-nas-agent/app/ui/", import.meta.url);

/**
 * Read the whole UI source as one searchable string.
 *
 * The UI is split into `index.html` (static shell) plus one or more `*.js`
 * files loaded as classic scripts in alphabetical order. Tests assert on the
 * *source text* of the UI, so they need a single string that contains the
 * markup and every script.
 *
 * The scripts are wrapped in a bare `<script>...</script>` block and placed
 * BEFORE the markup on purpose: `tests/ui-output-formatting.test.mjs` extracts
 * the script with `/<script>([\s\S]*?)<\/script>/` and evaluates it in a VM.
 * The regex is non-greedy, so the first bare `<script>` block wins - it has to
 * be the application script, not anything the shell may contain later.
 */
export async function readUiSource() {
  const html = await readFile(new URL("index.html", uiDir), "utf8");
  const names = (await readdir(uiDir)).filter((name) => name.endsWith(".js")).sort();
  const parts = [];
  for (const name of names) {
    parts.push(`\n/* ---- ${name} ---- */\n`, await readFile(new URL(name, uiDir), "utf8"));
  }
  return ["<script>", parts.join("\n"), "</script>", html].join("\n");
}
