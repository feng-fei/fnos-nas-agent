import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelProviderStore } from "../apps/fnos-nas-agent/app/model-provider-store.mjs";

async function fixture(t, fetchImpl) {
  const dataDir = await mkdtemp(join(tmpdir(), "fnos-model-catalog-"));
  const store = createModelProviderStore({ dataDir, fetchImpl });
  await store.load();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const provider = await store.add({
    name: "Catalog provider",
    endpoint: "https://provider.example/v1/chat/completions",
    model: "model-current",
    apiKey: "CATALOG_SECRET_NEVER_RETURN",
    enabled: true
  });
  return { store, provider };
}

test("model catalog discovery calls the compatible /models endpoint and returns bounded safe IDs", async t => {
  let request;
  const { store, provider } = await fixture(t, async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ data: [
      { id: "model-alpha", owned_by: "provider" },
      { id: "model-alpha", owned_by: "duplicate" },
      { id: "model-beta" },
      { id: "bad\nmodel" },
      { id: "x".repeat(161) },
      null
    ] }), { status: 200 });
  });
  const result = await store.discoverModels(provider.id);
  assert.equal(request.url, "https://provider.example/v1/models");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.authorization, "Bearer CATALOG_SECRET_NEVER_RETURN");
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map(item => item.id), ["model-alpha", "model-beta"]);
  assert.equal(JSON.stringify(result).includes("CATALOG_SECRET_NEVER_RETURN"), false);
  assert.equal(JSON.stringify(store.list()).includes("CATALOG_SECRET_NEVER_RETURN"), false);
});

test("model catalog discovery rejects missing providers and missing API keys", async t => {
  const { store, provider } = await fixture(t, async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  await assert.rejects(store.discoverModels("bad-id"), { statusCode: 400 });
  await assert.rejects(store.discoverModels("000000000000000000000000"), { statusCode: 404 });
  await store.update(provider.id, { name: provider.name, endpoint: provider.endpoint, model: provider.model, clearApiKey: true, enabled: false });
  await assert.rejects(store.discoverModels(provider.id), { statusCode: 409 });
});

test("model catalog discovery handles unsupported response formats and provider failures safely", async t => {
  const { store, provider } = await fixture(t, async () => new Response("private body with secret", { status: 401 }));
  const result = await store.discoverModels(provider.id);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.models, []);
  assert.doesNotMatch(JSON.stringify(result), /private body|CATALOG_SECRET_NEVER_RETURN/);
});
