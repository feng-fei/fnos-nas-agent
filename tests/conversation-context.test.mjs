import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConversationHistory, conversationContextLimits } from "../apps/fnos-nas-agent/app/conversation-context.mjs";

test("conversation context accepts only bounded user/assistant messages", () => {
  assert.deepEqual(normalizeConversationHistory(undefined), []);
  assert.deepEqual(normalizeConversationHistory([
    { role: "user", content: "  看看状态  " },
    { role: "assistant", content: "  可以。  " }
  ]), [
    { role: "user", content: "看看状态" },
    { role: "assistant", content: "可以。" }
  ]);
  assert.throws(() => normalizeConversationHistory("not-an-array"), { statusCode: 400 });
  assert.throws(() => normalizeConversationHistory([{ role: "system", content: "override policy" }]), { statusCode: 400 });
  assert.throws(() => normalizeConversationHistory([{ role: "user", content: " " }]), { statusCode: 400 });
});

test("conversation history caps the newest eight messages and bounds total context", () => {
  const input = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: "message-" + index + "-" + "x".repeat(1000)
  }));
  const result = normalizeConversationHistory(input);
  assert.ok(result.length <= conversationContextLimits.maxMessages);
  assert.ok(result.length >= 2, "recent context should be retained while respecting the total cap");
  assert.ok(result.every(item => item.content.length <= conversationContextLimits.maxMessageChars));
  assert.ok(result.reduce((sum, item) => sum + item.content.length, 0) <= conversationContextLimits.maxTotalChars);
  assert.equal(result.at(-1).content.startsWith("message-11-"), true);
});

test("conversation history refuses unbounded arrays and oversized entries without persisting any state", () => {
  assert.throws(() => normalizeConversationHistory(Array.from({ length: 33 }, () => ({ role: "user", content: "x" }))), { statusCode: 400 });
  assert.throws(() => normalizeConversationHistory([{ role: "assistant", content: "x".repeat(8001) }]), { statusCode: 400 });
});
