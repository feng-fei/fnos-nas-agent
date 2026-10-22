import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";

/**
 * Phase 157 - UI integration check for the model settings helpers.
 *
 * The Phase 154 helpers live in `app/ui/model-settings.js`. The file is an ES
 * module, the rest of the UI is a classic script, so the two files are loaded
 * with different semantics:
 *
 *   - `app/ui/core.js` and `app/ui/pages.js`  -> classic <script>
 *   - `app/ui/model-settings.js`              -> <script type="module">
 *
 * The module publishes its pure functions on `window.ModelSettings` so the
 * classic script can call them. These tests check the wiring, not the pure
 * helper behaviour (that is covered by `phase-154-model-settings-ui.test.mjs`).
 *
 * The tests never modify a production file.
 */

const uiDir = new URL("../apps/fnos-nas-agent/app/ui/", import.meta.url);

const pagesSource = await readFile(new URL("pages.js", uiDir), "utf8");
const modelSettingsSource = await readFile(new URL("model-settings.js", uiDir), "utf8");
const modelSettingsCss = await readFile(new URL("model-settings.css", uiDir), "utf8");
const sharedStyles = await readFile(new URL("styles.css", uiDir), "utf8");
const indexHtml = await readFile(new URL("index.html", uiDir), "utf8");

/**
 * Load `model-settings.js` as a real ES module.
 *
 * A fresh module instance is required: the module only assigns
 * `window.ModelSettings` while it is evaluated, and an already evaluated
 * module would be served from the loader cache without running its body
 * again. The cache busting query on the file URL gives every test its own
 * evaluation of the module body.
 *
 * @returns {Promise<{module: object, exported: string[], windowApi: object}>}
 */
async function loadModelSettingsModule() {
  const fakeWindow = { dispatchEvent() {} };
  const previousWindow = globalThis.window;
  globalThis.window = fakeWindow;
  try {
    const url = new URL("model-settings.js", uiDir);
    url.searchParams.set("phase157", String(Date.now()) + Math.random());
    const module = await import(url.href);
    return {
      module,
      exported: Object.keys(module).sort(),
      windowApi: fakeWindow.ModelSettings || {}
    };
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

/**
 * Return the source of the model provider submit handler.
 *
 * @returns {string}
 */
function submitHandlerSource() {
  const start = pagesSource.indexOf('addEventListener("submit"');
  assert.notEqual(start, -1, "the model provider form must register a submit handler");
  const end = pagesSource.indexOf("let modelBatchTestOffset", start);
  assert.notEqual(end, -1, "the model provider submit handler must be a bounded block");
  return pagesSource.slice(start, end);
}

/* ---------------------------------------------------------------- *
 * 1) Syntax
 * ---------------------------------------------------------------- */

test("pages.js compiles as a classic script", () => {
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new
    new Script(pagesSource, { filename: "pages.js" });
  });
});

test("model-settings.js parses and evaluates as an ES module", async () => {
  const { module, exported } = await loadModelSettingsModule();
  assert.equal(typeof module.validateProviderForm, "function");
  assert.equal(typeof module.buildProviderWizardSteps, "function");
  assert.equal(typeof module.renderProviderCard, "function");
  assert.equal(typeof module.describeCredentialState, "function");
  assert.ok(exported.includes("validateProviderForm"));
  assert.ok(exported.includes("buildProviderWizardSteps"));
});

test("model-settings.js uses ES module syntax and not CommonJS", () => {
  assert.match(modelSettingsSource, /^export function /m);
  assert.doesNotMatch(modelSettingsSource, /\bmodule\.exports\b/);
  assert.doesNotMatch(modelSettingsSource, /\bexports\.\w+\s*=/);
});

/* ---------------------------------------------------------------- *
 * 2) index.html wiring
 * ---------------------------------------------------------------- */

test("index.html loads the model settings module and its stylesheet", () => {
  assert.match(indexHtml, /<script\s+type="module"\s+src="\/ui\/model-settings\.js"><\/script>/);
  assert.match(indexHtml, /<link\s+rel="stylesheet"\s+href="\/ui\/model-settings\.css">/);
});

test("index.html contains the model provider wizard container", () => {
  assert.match(indexHtml, /<div[^>]*id="model-provider-wizard"/);
});

test("index.html loads the classic UI scripts next to the module", () => {
  assert.match(indexHtml, /<script src="\/ui\/core\.js"><\/script>/);
  assert.match(indexHtml, /<script src="\/ui\/pages\.js"><\/script>/);
});

test("index.html keeps every model provider field the page script queries", () => {
  for (const id of [
    "model-provider-form",
    "model-provider-id",
    "model-provider-name",
    "model-provider-endpoint",
    "model-provider-key",
    "model-provider-model",
    "model-provider-preset",
    "model-provider-enabled",
    "model-provider-fallback",
    "model-provider-clear-key",
    "model-provider-error",
    "model-provider-save",
    "model-provider-wizard"
  ]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`), `index.html must provide #${id}`);
  }
});

/* ---------------------------------------------------------------- *
 * 3) pages.js calls the module through window.ModelSettings
 * ---------------------------------------------------------------- */

test("pages.js reads the helpers from window.ModelSettings", () => {
  assert.match(pagesSource, /window\.ModelSettings/);
  assert.match(pagesSource, /helpers\.validateProviderForm\(/);
  assert.match(pagesSource, /helpers\.buildProviderWizardSteps\(/);
});

test("pages.js calls validateProviderForm and buildProviderWizardSteps with the form values", () => {
  const validate = pagesSource.slice(
    pagesSource.indexOf("helpers.validateProviderForm("),
    pagesSource.indexOf("helpers.validateProviderForm(") + 400
  );
  assert.match(validate, /name:/);
  assert.match(validate, /baseUrl:/);
  assert.match(validate, /apiKey/);
  assert.match(validate, /modelId:/);

  const steps = pagesSource.slice(
    pagesSource.indexOf("helpers.buildProviderWizardSteps("),
    pagesSource.indexOf("helpers.buildProviderWizardSteps(") + 300
  );
  assert.match(steps, /requireApiKey/);
  assert.match(steps, /hasStoredKey/);
});

test("pages.js shows the field level errors before it sends the request", () => {
  const handler = submitHandlerSource();
  const validateIndex = handler.indexOf("helpers.validateProviderForm(");
  const errorIndex = handler.indexOf("showModelProviderFieldErrors(check.errors)");
  const requestIndex = handler.indexOf("await api(");
  assert.notEqual(validateIndex, -1, "the submit handler must run the field level validation");
  assert.notEqual(errorIndex, -1, "the submit handler must render the field level errors");
  assert.notEqual(requestIndex, -1, "the submit handler must send the request");
  assert.ok(validateIndex < errorIndex, "the errors are rendered after the validation");
  assert.ok(errorIndex < requestIndex, "the request is only sent after the field level check");
});

test("pages.js aborts the submit when the field level validation fails", () => {
  const handler = submitHandlerSource();
  assert.match(handler, /if\(!check\.valid\)\{/);
  assert.match(handler, /statusCode:400/);
});

test("pages.js refreshes the wizard and clears the errors on input", () => {
  assert.match(
    pagesSource,
    /addEventListener\("input",\(\)=>\{showModelProviderFieldErrors\(\{\}\);renderModelProviderWizard\(\);\}\)/,
    "an input event must clear the previous errors and repaint the wizard"
  );
});

/* ---------------------------------------------------------------- *
 * 4) window.ModelSettings contract
 * ---------------------------------------------------------------- */

test("model-settings.js publishes the helpers on window.ModelSettings", async () => {
  const { windowApi } = await loadModelSettingsModule();
  assert.equal(typeof windowApi, "object");
  for (const name of ["validateProviderForm", "renderProviderCard", "describeCredentialState"]) {
    assert.equal(typeof windowApi[name], "function", `window.ModelSettings.${name} must be a function`);
  }
});

test("window.ModelSettings is frozen and exposes no credential", async () => {
  const { windowApi } = await loadModelSettingsModule();
  assert.ok(Object.isFrozen(windowApi), "the published API must not be mutable by a page script");
  const serialized = JSON.stringify(Object.keys(windowApi).sort());
  assert.doesNotMatch(serialized, /apiKey$/, "the published API must not expose a key");
  assert.doesNotMatch(modelSettingsSource, /window\.ModelSettings\s*=\s*\{[^}]*apiKey\s*:/);
});

/* ---------------------------------------------------------------- *
 * 5) No plaintext API key in the rendered page
 * ---------------------------------------------------------------- */

test("pages.js never writes markup through innerHTML", () => {
  assert.doesNotMatch(pagesSource, /\.innerHTML\s*=/);
  assert.doesNotMatch(pagesSource, /\.outerHTML\s*=/);
  assert.doesNotMatch(pagesSource, /insertAdjacentHTML/);
  assert.doesNotMatch(pagesSource, /\bdocument\.write\b/);
});

test("pages.js never puts the API key into a markup or text sink", () => {
  // `hasApiKey` is a boolean flag and `apiKey` is the plaintext value. Only the
  // plaintext identifier is relevant here, so the check is case sensitive on
  // purpose: `hasApiKey` never carries a secret.
  const plaintext = /\bapiKey\b/;
  const markupSinks = /innerHTML|outerHTML|insertAdjacentHTML|textContent|setAttribute|\bsrc\s*=|\.value\s*=/;
  const lines = pagesSource.split("\n");
  const offenders = [];
  for (const [index, line] of lines.entries()) {
    if (!plaintext.test(line)) continue;
    if (markupSinks.test(line)) offenders.push(`${index + 1}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], "the API key must not reach a markup or text sink");
});

test("the plaintext key is only read from the input, validated and sent to the API", () => {
  const lines = pagesSource.split("\n");
  const allowed = [
    // the field id map of the page
    /apiKey:"#model-provider-key"/,
    // the wizard and the validator receive the current value
    /apiKey:document\.querySelector\("#model-provider-key"\)\.value/,
    /const apiKey=document\.querySelector\("#model-provider-key"\)\.value;/,
    /\bapiKey,/,
    // the request body carries the key only when the operator typed one
    /if\(apiKey\)body\.apiKey=apiKey;/
  ];
  const offenders = [];
  for (const [index, line] of lines.entries()) {
    if (!/\bapiKey\b/.test(line)) continue;
    if (allowed.some(pattern => pattern.test(line))) continue;
    offenders.push(`${index + 1}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], "every use of the plaintext key must be one of the reviewed ones");
  assert.match(pagesSource, /if\(apiKey\)body\.apiKey=apiKey;/, "an empty key must not be sent");
});

test("the model provider card renders the credential state, not the key", async () => {
  const { module } = await loadModelSettingsModule();
  const html = module.renderProviderCard(
    {
      id: "provider-1",
      name: "OpenAI",
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4.1-mini",
      enabled: true,
      hasApiKey: true,
      apiKey: "sk-plaintext-must-not-appear"
    },
    { keyFingerprint: "sha256:0123abcd" }
  );
  assert.doesNotMatch(html, /sk-plaintext-must-not-appear/);
  assert.doesNotMatch(html, /apiKey/i);
});

test("describeCredentialState ignores a plaintext key in the record", async () => {
  const { module } = await loadModelSettingsModule();
  const state = module.describeCredentialState({ hasKey: true, apiKey: "sk-plaintext-must-not-appear" });
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /sk-plaintext-must-not-appear/);
  assert.equal(state.key, "configured");
  assert.equal(state.keyLabel, "已配置密钥");
});

/* ---------------------------------------------------------------- *
 * 6) The integration gaps that were reported and are now fixed
 * ---------------------------------------------------------------- */

/**
 * Extract the body of the `if(modelProviderForm){ ... }` block of pages.js.
 *
 * The block is matched with a brace counter so the assertion does not depend
 * on the indentation of the source.
 *
 * @returns {string}
 */
function guardedFormBlock() {
  const start = pagesSource.indexOf("if(modelProviderForm){");
  assert.notEqual(start, -1, "pages.js must guard the form listeners");
  const open = pagesSource.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < pagesSource.length; index += 1) {
    const character = pagesSource[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return pagesSource.slice(open + 1, index);
    }
  }
  assert.fail("the guarded form block of pages.js is not closed");
  return "";
}

test("the wizard step state class matches the stylesheet modifier", () => {
  assert.match(
    pagesSource,
    /model-settings__wizard-step"\+\(step\.valid\?" model-settings__wizard-step--done":" model-settings__wizard-step--current"\)/,
    "the wizard step must use the BEM modifiers of the stylesheet"
  );
  assert.doesNotMatch(pagesSource, /" is-done"|" is-current"/);
  assert.match(modelSettingsCss, /\.model-settings__wizard-step--current\s*\{/);
  assert.match(modelSettingsCss, /\.model-settings__wizard-step--done\s*\{/);
});

test("the wizard is rendered on load and on model-settings-ready", () => {
  assert.match(
    pagesSource,
    /window\.addEventListener\("model-settings-ready",\(\)=>renderModelProviderWizard\(\)\)/,
    "the page must repaint the wizard when the module publishes itself"
  );
  assert.match(
    pagesSource,
    /^renderModelProviderWizard\(\);$/m,
    "the wizard must be rendered once when the page starts"
  );
  assert.match(modelSettingsSource, /dispatchEvent\(new Event\("model-settings-ready"\)\)/);
});

test("the provider card uses the model settings classes and the credential helper", () => {
  assert.match(pagesSource, /helpers\.describeCredentialState\(/);
  assert.match(pagesSource, /className="card model-settings__card"/);
  assert.match(pagesSource, /model-settings__card-title/);
  assert.match(pagesSource, /model-settings__card-meta/);
  assert.match(pagesSource, /model-settings__card-credential/);
  assert.match(pagesSource, /model-settings__card-test/);
  // The page keeps its own action buttons, so the card helper of the module
  // is not used by the page. It stays exported for other callers.
  assert.doesNotMatch(pagesSource, /renderProviderCard/);
  for (const className of [
    "model-settings__card",
    "model-settings__card-title",
    "model-settings__card-meta",
    "model-settings__card-credential",
    "model-settings__card-test"
  ]) {
    assert.match(modelSettingsCss, new RegExp(`\\.${className}[\\s,{]`));
  }
});

test("the invalid state class is placed where the stylesheet expects it", () => {
  assert.match(pagesSource, /closest\("\.field"\)/);
  assert.match(pagesSource, /container\.classList\.toggle\("field--invalid"/);
  assert.match(pagesSource, /element\.classList\.toggle\("field--invalid"/);
  assert.match(pagesSource, /container\.querySelector\("\.field__error"\)/);
  assert.match(pagesSource, /container\.append\(hint\)/);
  // The shared stylesheet marks the wrapper and the control below it.
  assert.match(
    sharedStyles,
    /\.field--invalid \.input/,
    "the shared stylesheet must still own the field error state"
  );
});

test("the submit handler guards the form lookup like the input handler", () => {
  const block = guardedFormBlock();
  assert.match(block, /addEventListener\("input"/);
  assert.match(block, /addEventListener\("submit"/);
  assert.doesNotMatch(
    pagesSource,
    /document\.querySelector\("#model-provider-form"\)\.addEventListener\("submit"/,
    "the submit listener must not dereference the form without a guard"
  );
});

/* ---------------------------------------------------------------- *
 * 7) The server serves the two new assets
 * ---------------------------------------------------------------- */

test("the server serves the module and the stylesheet as UI assets", async () => {
  const server = await readFile(
    new URL("../apps/fnos-nas-agent/app/server.mjs", import.meta.url),
    "utf8"
  );
  assert.match(server, /\["\.js",\s*"text\/javascript; charset=utf-8"\]/);
  assert.match(server, /\["\.css",\s*"text\/css; charset=utf-8"\]/);
});
