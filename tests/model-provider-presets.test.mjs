import test from "node:test";
import assert from "node:assert/strict";
import { listModelProviderPresets } from "../apps/fnos-nas-agent/app/model-provider-presets.mjs";

test("model provider presets contain verified OpenAI-compatible HTTPS Chat Completions endpoints", () => {
  const presets = listModelProviderPresets();
  const byId = Object.fromEntries(presets.map(item => [item.id, item]));
  assert.equal(presets.length >= 5, true);
  assert.equal(byId.openai.endpoint, "https://api.openai.com/v1/chat/completions");
  assert.equal(byId.deepseek.endpoint, "https://api.deepseek.com/chat/completions");
  assert.equal(byId.siliconflow.endpoint, "https://api.siliconflow.cn/v1/chat/completions");
  assert.equal(byId["dashscope-beijing"].endpoint, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  for (const preset of presets.filter(item => item.endpoint)) {
    const endpoint = new URL(preset.endpoint);
    if (preset.id === "ollama-local") {
      assert.equal(endpoint.protocol, "http:");
      assert.equal(endpoint.hostname, "127.0.0.1");
    } else assert.equal(endpoint.protocol, "https:");
    assert.equal(endpoint.username, "");
    assert.equal(endpoint.password, "");
    assert.equal(endpoint.pathname.endsWith("/chat/completions"), true);
    assert.equal(Object.hasOwn(preset, "apiKey"), false);
    assert.equal(Object.hasOwn(preset, "model"), false);
  }
  assert.equal(byId.moonshot.endpoint, "https://api.moonshot.cn/v1/chat/completions");
  assert.equal(byId.zhipu.endpoint, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(byId.openrouter.endpoint, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(byId.gemini.endpoint, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(byId.groq.endpoint, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(byId["ollama-local"].endpoint, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(byId.custom.endpoint, "");
  assert.ok(byId.openai.docsUrl.startsWith("https://"));
});

test("preset list returns independent objects and contains no user credentials", () => {
  const first = listModelProviderPresets();
  first[0].endpoint = "https://attacker.invalid/chat/completions";
  first[0].name = "modified";
  const next = listModelProviderPresets();
  assert.equal(next[0].endpoint, "https://api.openai.com/v1/chat/completions");
  assert.equal(next[0].name, "OpenAI");
  assert.equal(JSON.stringify(next).includes("apiKey"), false);
});
