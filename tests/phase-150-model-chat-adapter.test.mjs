import test from "node:test";
import assert from "node:assert/strict";
import { createModelChatAdapter } from "../apps/fnos-nas-agent/app/model-chat-adapter.mjs";

const encoder = new TextEncoder();

const providerConfig = overrides => ({
  enabled: true,
  endpoint: "https://model.example/v1/chat/completions",
  apiKey: "test-secret-key",
  model: "test-model",
  timeoutMs: 1000,
  providerId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  providerName: "Primary",
  ...overrides
});
const storeWith = config => ({ runtimeConfig: () => config });
const userMessage = content => ({ role: "user", content });

// A server-sent-events body, delivered as real stream chunks.
function sseResponse(chunks, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}
const deltaEvent = content => "data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\n";
const doneEvent = "data: [DONE]\n\n";

test("a streamed answer arrives in order and the complete text is returned", async () => {
  const calls = [];
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig()),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return sseResponse([deltaEvent("你好"), deltaEvent("，世界"), doneEvent]);
    }
  });
  const deltas = [];
  const text = await adapter.chat({ messages: [userMessage("hi")], onDelta: chunk => { deltas.push(chunk); } });
  assert.equal(text, "你好，世界");
  assert.deepEqual(deltas, ["你好", "，世界"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://model.example/v1/chat/completions");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-secret-key");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "test-model");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 1200);
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("the stream ends at [DONE] and the events behind it are ignored", async () => {
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig()),
    fetchImpl: async () => sseResponse([deltaEvent("done"), doneEvent, deltaEvent("ignored")])
  });
  const deltas = [];
  const text = await adapter.chat({ messages: [userMessage("hi")], onDelta: chunk => deltas.push(chunk) });
  assert.equal(text, "done");
  assert.deepEqual(deltas, ["done"]);
});

test("an asynchronous delta callback is awaited before the next chunk is read", async () => {
  const order = [];
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig()),
    fetchImpl: async () => sseResponse([deltaEvent("a"), deltaEvent("b"), doneEvent])
  });
  await adapter.chat({
    messages: [userMessage("hi")],
    onDelta: async chunk => { await new Promise(resolve => setTimeout(resolve, 1)); order.push(chunk); }
  });
  assert.deepEqual(order, ["a", "b"]);
});

test("an upstream error event ends the turn with MODEL_CHAT_UPSTREAM_ERROR", async () => {
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig()),
    fetchImpl: async () => sseResponse(["data: " + JSON.stringify({ error: { message: "upstream exploded" } }) + "\n\n"])
  });
  await assert.rejects(adapter.chat({ messages: [userMessage("hi")] }), error => {
    assert.equal(error.code, "MODEL_CHAT_UPSTREAM_ERROR");
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /upstream exploded/);
    return true;
  });
});

test("a provider that answers with an HTTP error is reported as an upstream error", async () => {
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig()),
    fetchImpl: async () => new Response("unauthorized", { status: 401 })
  });
  await assert.rejects(adapter.chat({ messages: [userMessage("hi")] }), error => {
    assert.equal(error.code, "MODEL_CHAT_UPSTREAM_ERROR");
    assert.equal(error.statusCode, 401);
    return true;
  });
});

test("an empty answer is refused instead of being shown as an empty bubble", async () => {
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig()),
    fetchImpl: async () => sseResponse([doneEvent])
  });
  await assert.rejects(adapter.chat({ messages: [userMessage("hi")] }), error => {
    assert.equal(error.code, "MODEL_CHAT_INVALID_RESPONSE");
    assert.equal(error.statusCode, 502);
    return true;
  });
});

test("a stream that is longer than the size limit is refused", async () => {
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig()),
    fetchImpl: async () => sseResponse([deltaEvent("x".repeat(70 * 1024)), doneEvent])
  });
  await assert.rejects(adapter.chat({ messages: [userMessage("hi")] }), error => {
    assert.equal(error.code, "MODEL_CHAT_RESPONSE_TOO_LARGE");
    return true;
  });
});

test("an endpoint outside the whitelist never leaves the process", async () => {
  let called = 0;
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig({ endpoint: "http://model.example/v1/chat/completions" })),
    fetchImpl: async () => { called++; return sseResponse([doneEvent]); }
  });
  await assert.rejects(adapter.chat({ messages: [userMessage("hi")] }), error => {
    assert.equal(error.code, "MODEL_CHAT_INVALID_ENDPOINT");
    assert.equal(error.statusCode, 400);
    return true;
  });
  assert.equal(called, 0);
});

test("an endpoint with a query string, userinfo or a foreign path is refused", async () => {
  const rejected = [
    "https://model.example/v1/chat/completions?token=1",
    "https://user:secret@model.example/v1/chat/completions",
    "https://model.example/v1/completions",
    "http://example.com/v1/chat/completions"
  ];
  for (const endpoint of rejected) {
    let called = 0;
    const adapter = createModelChatAdapter({
      providerStore: storeWith(providerConfig({ endpoint })),
      fetchImpl: async () => { called++; return sseResponse([doneEvent]); }
    });
    await assert.rejects(adapter.chat({ messages: [userMessage("hi")] }), error => {
      assert.equal(error.code, "MODEL_CHAT_INVALID_ENDPOINT", endpoint);
      assert.equal(error.statusCode, 400);
      return true;
    });
    assert.equal(called, 0, endpoint);
  }
});

test("a loopback provider on plain HTTP is allowed", async () => {
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig({ endpoint: "http://127.0.0.1:11434/v1/chat/completions" })),
    fetchImpl: async () => sseResponse([deltaEvent("本地模型"), doneEvent])
  });
  const text = await adapter.chat({ messages: [userMessage("hi")] });
  assert.equal(text, "本地模型");
});

test("without a usable provider the turn is refused with 502", async () => {
  const adapter = createModelChatAdapter({
    providerStore: storeWith(null),
    fetchImpl: async () => { throw new Error("the request must not be sent"); }
  });
  await assert.rejects(adapter.chat({ messages: [userMessage("hi")] }), error => {
    assert.equal(error.code, "MODEL_CHAT_NOT_CONFIGURED");
    assert.equal(error.statusCode, 502);
    return true;
  });
});

test("invalid messages are refused with 400 before anything is sent", async () => {
  let called = 0;
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig()),
    fetchImpl: async () => { called++; return sseResponse([doneEvent]); }
  });
  const invalid = [
    undefined,
    "hello",
    [],
    [{ role: "user" }],
    [{ role: "tool", content: "x" }],
    [{ role: "user", content: "   " }],
    [{ role: "user", content: "x".repeat(2001) }],
    Array.from({ length: 33 }, () => userMessage("hi"))
  ];
  for (const messages of invalid) {
    await assert.rejects(adapter.chat({ messages }), error => {
      assert.equal(error.code, "MODEL_CHAT_INVALID_REQUEST");
      assert.equal(error.statusCode, 400);
      return true;
    });
  }
  assert.equal(called, 0);
});

test("a cancelled turn reports MODEL_CHAT_ABORTED", async () => {
  const controller = new AbortController();
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig()),
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      const signal = options.signal;
      const abort = () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    })
  });
  const pending = adapter.chat({ messages: [userMessage("hi")], signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => {
    assert.equal(error.code, "MODEL_CHAT_ABORTED");
    return true;
  });
});

test("a turn that is cancelled before it starts is refused as well", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig()),
    fetchImpl: async () => { throw new Error("the request must not be sent"); }
  });
  await assert.rejects(adapter.chat({ messages: [userMessage("hi")], signal: controller.signal }), error => {
    assert.equal(error.code, "MODEL_CHAT_ABORTED");
    return true;
  });
});

test("the status report describes the provider that can serve a turn", async () => {
  const adapter = createModelChatAdapter({ providerStore: storeWith(providerConfig()) });
  assert.deepEqual(adapter.status(), {
    enabled: true,
    providerConfigured: true,
    model: "test-model",
    providerId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    providerName: "Primary"
  });
  const empty = createModelChatAdapter({ providerStore: storeWith(null) });
  assert.deepEqual(empty.status(), {
    enabled: false,
    providerConfigured: false,
    model: null,
    providerId: null,
    providerName: null
  });
});

test("a provider whose endpoint is off the whitelist is configured but not enabled", async () => {
  const adapter = createModelChatAdapter({
    providerStore: storeWith(providerConfig({ endpoint: "http://model.example/v1/chat/completions" }))
  });
  const status = adapter.status();
  assert.equal(status.providerConfigured, true);
  assert.equal(status.enabled, false);
});

test("a broken provider store does not take the adapter down", async () => {
  const adapter = createModelChatAdapter({
    providerStore: { runtimeConfig: () => { throw new Error("store is closed"); } },
    fetchImpl: async () => { throw new Error("the request must not be sent"); }
  });
  assert.equal(adapter.status().enabled, false);
  await assert.rejects(adapter.chat({ messages: [userMessage("hi")] }), error => error.code === "MODEL_CHAT_NOT_CONFIGURED");
});

test("the adapter refuses a dependency it cannot use", () => {
  assert.throws(() => createModelChatAdapter({ providerStore: {} }), TypeError);
  assert.throws(() => createModelChatAdapter({ providerStore: storeWith(providerConfig()), fetchImpl: "nope" }), TypeError);
});
