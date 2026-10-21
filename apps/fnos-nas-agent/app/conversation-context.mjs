const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_HISTORY_TOTAL_CHARS = 2400;

export function normalizeConversationHistory(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32)
    throw Object.assign(new Error("Conversation history must be a bounded array"), { statusCode: 400 });
  const messages = value.slice(-MAX_HISTORY_MESSAGES);
  const normalized = messages.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string" ||
        !item.content.trim() ||
        item.content.length > 8000) {
      throw Object.assign(new Error("Conversation history contains an invalid message"), { statusCode: 400 });
    }
    return {
      role: item.role,
      content: item.content.trim().slice(-MAX_HISTORY_MESSAGE_CHARS)
    };
  });

  let remaining = MAX_HISTORY_TOTAL_CHARS;
  const bounded = [];
  for (let index = normalized.length - 1; index >= 0 && remaining > 0; index--) {
    const message = normalized[index];
    const content = message.content.slice(-remaining);
    if (content) bounded.push({ role: message.role, content });
    remaining -= content.length;
  }
  return bounded.reverse();
}

export const conversationContextLimits = Object.freeze({
  maxMessages: MAX_HISTORY_MESSAGES,
  maxMessageChars: MAX_HISTORY_MESSAGE_CHARS,
  maxTotalChars: MAX_HISTORY_TOTAL_CHARS
});
