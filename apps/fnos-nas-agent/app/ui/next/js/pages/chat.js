/* pages/chat.js —— 对话（产品核心，UI-2 主战场）。
 * UI-1 先落交互骨架：双模式切换、消息流容器、输入区；SSE 流与工具卡在 UI-2 接通。 */

import { h } from "../h.js";
import { callJson } from "../api.js";

export function render(root, ctx){
  let mode = "task";

  const thread = h("div", { id:"chat-thread", style:"flex:1;overflow:auto;padding:6px 2px;display:flex;flex-direction:column;gap:12px" },
    h("div", { class:"empty", style:"padding:36px 16px" },
      h("div", { class:"big" }, "💬"),
      h("p", null, "试试：“查看系统状态”、“打开照片文件夹”、“把下载里的照片移到归档”"),
      h("p", { class:"muted", style:"font-size:12px" }, "破坏性操作会先展示具体目标，经确认后才会执行。")));

  const statusEl = h("span", { class:"muted", style:"font-size:12px" }, "就绪");

  function bubble(role, content){
    const isUser = role === "user";
    return h("div", { style:"display:flex;justify-content:" + (isUser ? "flex-end" : "flex-start") },
      h("div", { style:"max-width:86%;background:" + (isUser ? "var(--accent-soft)" : "var(--surface)") +
        ";border:1px solid var(--border);border-radius:14px;padding:10px 14px;font-size:14px;line-height:1.65;" +
        "border-" + (isUser ? "top-right" : "top-left") + "-radius:4px" }, content));
  }
  thread.append(
    bubble("agent", h("div", null,
      h("div", null, "你好！我可以查看状态、浏览文件、执行经确认的整理任务。"),
      h("p", { class:"muted", style:"font-size:12px;margin:6px 0 0" }, "本页为 UI-1 骨架；任务流 / SSE / 工具卡片在 UI-2 接入。"))));

  const modeSeg = h("div", { class:"seg", role:"group", "aria-label":"对话模式" },
    h("button", { class:"on", dataset:{ mode:"task" }, onclick:switchMode }, "任务模式"),
    h("button", { dataset:{ mode:"direct" }, onclick:switchMode }, "直连模式"));
  const modeHint = h("p", { class:"muted", style:"font-size:12px;margin:8px 2px 0" },
    "任务模式：生成可审查的工具任务，可停止、可追责。");
  function switchMode(event){
    mode = event.target.dataset.mode;
    modeSeg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
    modeHint.textContent = mode === "task"
      ? "任务模式：生成可审查的工具任务，可停止、可追责。"
      : "直连模式：模型直接回答，不调用工具，适合咨询与解释。";
  }

  const input = h("textarea", { class:"textarea", id:"chat-input", rows:"1", maxlength:"2000",
    placeholder:"给助手下达指令…（Enter 发送，Shift+Enter 换行）", style:"min-height:46px" });
  const form = h("form", { class:"row", style:"gap:8px;margin-top:10px;align-items:flex-end",
      onsubmit:event => {
        event.preventDefault();
        const text = input.value.trim();
        if(!text) return;
        thread.append(bubble("user", text));
        input.value = "";
        thread.scrollTop = thread.scrollHeight;
        statusEl.textContent = "已提交（UI-2 接入任务流）";
      } },
    input,
    h("button", { class:"btn btn--primary", type:"submit" }, "发送"));

  callJson("chatStatus").then(status => {
    statusEl.textContent = status && status.enabled ? "模型已就绪" : "模型未配置——可在「设置 · 模型服务」中添加";
  }).catch(() => {});

  root.append(
    h("div", { class:"card", style:"display:flex;flex-direction:column;min-height:60vh" },
      h("div", { class:"card__head", style:"align-items:center" },
        modeSeg, h("span", { style:"flex:1" }), statusEl),
      h("div", { class:"card__body", style:"flex:1;display:flex;flex-direction:column;padding-top:0" },
        modeHint, thread, form)));
}
