/* pages/chat.js —— 对话（UI-2）。
 * 任务模式：POST /api/agent/message → 202 {task} → EventSource /api/tasks/:id/events
 *   （progress / tool / approval / done / error），轮询兜底；结果渲染工具卡。
 * 直连模式：POST /api/chat/message {messages} → SSE（delta/done/error），可中止。
 * 审批：服务端一次性能力，confirm/deny 前先本地二次确认；审批卡内联到对应回合。
 * 会话上下文只留页面内存（≤8 条，服务端再裁剪），不入任务历史。 */

import { h, clear } from "../h.js";
import { callJson, routeUrl } from "../api.js";
import { toast, confirmModal, openModal } from "../ui.js";
import { formatDateTime, formatDisplayValue } from "../format.js";

const PREVIEW = window.__UI_PREVIEW__ === true;
const MODE_KEY = "ui2.chat.mode";
const STREAM_TYPES = ["progress", "tool", "approval", "done", "error"];

export function render(root){
  let mode = "task";
  try{ const stored = localStorage.getItem(MODE_KEY); if(stored === "direct" || stored === "task") mode = stored; }catch{}

  const thread = h("div", { style:"flex:1;overflow:auto;padding:8px 2px;display:flex;flex-direction:column;gap:14px" });
  const statusEl = h("span", { class:"muted", style:"font-size:12px", role:"status" }, "就绪");
  const stopBtn = h("button", { class:"btn btn--secondary btn--sm", hidden:true, onclick:() => stopActive() }, "停止");
  const input = h("textarea", { class:"textarea", rows:"1", maxlength:"2000", style:"min-height:46px",
    placeholder:"例如：查看系统状态 / 然后打开刚才的目录" });
  const pendingHost = h("div", { class:"stack" });

  /* ---------------- 气泡与工具卡 ---------------- */
  function bubble(role, taskId){
    const tools = h("div", { class:"stack", style:"gap:6px" });
    const approval = h("div", { class:"stack", style:"gap:8px" });
    const content = h("div", null, role === "agent" ? "" : "");
    const meta = h("div", { class:"muted", style:"font-size:11px;margin-top:6px" });
    const progress = h("div", { class:"banner banner--info", style:"margin:6px 0 0", hidden:true });
    const b = h("div", { dataset:{ taskId: taskId || "" },
        style:"display:flex;justify-content:" + (role === "user" ? "flex-end" : "flex-start") },
      h("div", { style:"max-width:88%;background:" + (role === "user" ? "var(--accent-soft)" : "var(--surface)") +
        ";border:1px solid var(--border);border-radius:14px;padding:10px 14px;font-size:14px;line-height:1.65;overflow-wrap:anywhere" },
        content, tools, approval, progress, meta));
    b._parts = { content, tools, approval, progress, meta };
    thread.append(b);
    thread.scrollTop = thread.scrollHeight;
    return b;
  }
  function setProgress(b, data){
    const p = b._parts.progress;
    p.hidden = false;
    const pct = Math.max(0, Math.min(100, Number(data && data.progress) || 0));
    p.textContent = (data && (data.stage || data.message) || "处理中…") + " · " + pct + "%";
  }
  function toolCard(name, result){
    let body = "";
    try{ body = JSON.stringify(formatDisplayValue(result), null, 2); }catch{ body = String(result); }
    if(body.length > 2000) body = body.slice(0, 2000) + "\n…（已截断）";
    return h("details", { class:"card", style:"margin:0" },
      h("summary", { style:"padding:8px 12px;cursor:pointer;font-size:13px" }, "🛠 " + name),
      h("pre", { class:"code", style:"margin:0;border:0;border-top:1px solid var(--border);border-radius:0" }, body));
  }
  function finalizeTask(b, task){
    b._parts.progress.hidden = true;
    const p = b._parts;
    if(!task){ p.content.textContent = "任务状态未知。"; return; }
    if(task.status === "completed" && task.result){
      p.content.textContent = task.result.message || "（无返回内容）";
      for(const r of (task.result.results || []).slice(0, 10)) p.tools.append(toolCard(r.tool, r.result));
      p.meta.textContent = "任务 " + (task.taskId || "").slice(0, 8) + " · 模式 " + (task.result.mode || "—") + " · " + (task.result.status || task.status);
    }else if(task.status === "failed"){
      p.content.textContent = "任务失败：" + (task.error || "未知错误");
    }else if(task.status === "cancelled"){
      p.content.textContent = "任务已取消。";
    }else{
      p.content.textContent = "任务仍在执行（" + (task.status || "running") + "），稍后在下方任务列表查看。";
    }
    thread.scrollTop = thread.scrollHeight;
  }

  /* ---------------- 任务模式 ---------------- */
  let activeTaskId = null, directController = null;
  function listenTask(taskId, b, state){
    try{
      const source = new EventSource(routeUrl("taskEvents", { params:{ id:taskId } }));
      const handle = event => {
        let payload = {}; try{ payload = JSON.parse(event.data || "{}"); }catch{}
        const type = payload.type || event.type;
        const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
        if(type === "progress") setProgress(b, data);
        else if(type === "tool") b._parts.tools.append(toolCard(data.tool || "工具", data.result));
        else if(type === "approval") loadPending();
        else if(type === "done"){ state.finalTask = data.task || data; source.close(); }
        else if(type === "error"){ state.streamError = String(data.message || "任务失败"); statusEl.textContent = state.streamError; source.close(); }
      };
      source.addEventListener("message", handle);
      for(const t of STREAM_TYPES) source.addEventListener(t, handle);
      source.addEventListener("error", () => { try{ source.close(); }catch{} });
    }catch{ /* 轮询兜底 */ }
  }
  async function awaitTask(taskId, b){
    const state = { finalTask:null };
    listenTask(taskId, b, state);
    let task = null;
    for(let i = 0; i < 160; i++){
      if(state.finalTask){ task = state.finalTask; break; }
      await new Promise(r => setTimeout(r, 800));
      try{
        const body = await callJson("taskGet", { params:{ id:taskId } });
        task = body.task;
        if(task.status === "awaiting-approval") loadPending();
        if(!["queued","running","awaiting-approval"].includes(task.status)) break;
        setProgress(b, task);
      }catch{ break; }
    }
    finalizeTask(b, task);
    if(task && task.status === "completed" && task.result?.message)
      history.push({ role:"assistant", content:task.result.message.slice(0, 2000) });
    if(activeTaskId === taskId) activeTaskId = null;
    stopBtn.hidden = true;
    loadPending(); loadQueue();
  }
  async function stopActive(){
    if(directController){ try{ directController.abort(); }catch{} return; }
    const taskId = activeTaskId;
    if(!taskId) return;
    stopBtn.disabled = true;
    try{
      const r = await callJson("taskCancel", { params:{ id:taskId } });
      statusEl.textContent = r.cancelRequested ? "已请求停止，等待当前工具结束" : "任务已取消";
      toast(r.cancelRequested ? "已请求停止；当前工具会先完成" : "任务已取消", "ok");
    }catch(error){ toast(error.message, "err"); stopBtn.disabled = false; }
  }

  /* ---------------- 直连模式 ---------------- */
  async function sendDirect(text, b){
    const messages = [...history, { role:"user", content:text }].slice(-10);
    directController = new AbortController();
    let acc = "";
    try{
      const response = await fetch(routeUrl("chatMessage"), {
        method:"POST", credentials:"same-origin", signal:directController.signal,
        headers:{ "content-type":"application/json" }, body:JSON.stringify({ messages }) });
      if(!response.ok || !response.body){ const e = await response.json().catch(() => ({})); throw new Error(e.error || "直聊通道不可用"); }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while(true){
        const { done, value } = await reader.read();
        if(done) break;
        buffer += decoder.decode(value, { stream:true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for(const frame of frames){
          let type = "message", data = "";
          for(const line of frame.split(/\r?\n/)){
            if(line.startsWith("event:")) type = line.slice(6).trim();
            else if(line.startsWith("data:")) data += line.slice(5).trim();
          }
          if(!data) continue;
          let payload = {}; try{ payload = JSON.parse(data); }catch{ continue; }
          if(type === "delta"){ acc += payload.text || ""; b._parts.content.textContent = acc; thread.scrollTop = thread.scrollHeight; }
          else if(type === "done"){ acc = payload.text || acc; b._parts.content.textContent = acc; }
          else if(type === "error"){ throw new Error(payload.message || "模型直聊失败"); }
        }
      }
      if(!acc) b._parts.content.textContent = "（模型没有返回内容）";
      history.push({ role:"assistant", content:acc.slice(0, 2000) });
    }catch(error){
      if(error.name === "AbortError"){ b._parts.content.textContent = acc + "\n（已停止）"; }
      else{ b._parts.content.textContent = "直聊失败：" + error.message; statusEl.textContent = "直聊失败"; }
    }finally{ directController = null; stopBtn.hidden = true; }
  }

  /* ---------------- 发送入口 ---------------- */
  const history = []; // {role, content}，≤8 条由服务端裁剪
  let doSubmit = () => {};
  async function send(text){
    const userB = bubble("user"); userB._parts.content.textContent = text;
    const agentB = bubble("agent");
    statusEl.textContent = mode === "task" ? "已提交任务…" : "正在生成…";
    stopBtn.hidden = false; stopBtn.disabled = false;
    if(PREVIEW){ simulate(agentB, text); return; }
    if(mode === "task"){
      try{
        const body = await callJson("agentMessage", { body:{ text, history:history.slice(-8) } });
        const task = body.task;
        activeTaskId = task.taskId;
        agentB.dataset.taskId = task.taskId;
        history.push({ role:"user", content:text });
        await awaitTask(task.taskId, agentB);
      }catch(error){
        finalizeTask(agentB, null);
        agentB._parts.content.textContent = "提交失败：" + error.message;
        stopBtn.hidden = true;
      }
    }else{
      await sendDirect(text, agentB);
      stopBtn.hidden = true;
    }
  }
  doSubmit = () => {
    const text = input.value.trim();
    if(!text) return;
    input.value = "";
    send(text);
  };
  input.addEventListener("keydown", event => {
    if(event.key === "Enter" && !event.shiftKey){ event.preventDefault(); doSubmit(); }
  });

  /* 预览模式：本地模拟一次任务执行，让演示可走通流程 */
  function simulate(b, text){
    activeTaskId = "preview-" + Date.now();
    setProgress(b, { progress:30, stage:"规则路由匹配" });
    setTimeout(() => {
      b._parts.tools.append(toolCard("system.status", { ok:true, platform:"linux", uptimeSeconds:591042 }));
      setProgress(b, { progress:80, stage:"汇总结果" });
    }, 700);
    setTimeout(() => {
      finalizeTask(b, { taskId:activeTaskId, status:"completed", result:{ mode:"rules", status:"completed",
        message:"这是演示模式的模拟回复；接入真实服务后，这里会展示规则路由或模型规划的真实执行结果。",
        results:[] } });
      statusEl.textContent = "就绪"; stopBtn.hidden = true;
    }, 1400);
  }

  /* ---------------- 模式切换 ---------------- */
  const modeSeg = h("div", { class:"seg", role:"group" },
    h("button", { class:mode === "task" ? "on" : "", dataset:{ mode:"task" },
        onclick:() => switchMode("task") }, "任务模式"),
    h("button", { class:mode === "direct" ? "on" : "", dataset:{ mode:"direct" },
        onclick:() => switchMode("direct") }, "直连模式"));
  const modeHint = h("p", { class:"muted", style:"font-size:12px;margin:0 2px 8px" });
  function switchMode(next){
    mode = next;
    try{ localStorage.setItem(MODE_KEY, next); }catch{}
    modeSeg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.mode === next));
    modeHint.textContent = next === "task"
      ? "任务模式：生成可审查的工具任务，可停止、可追责。"
      : "直连模式：模型直接回答，不执行任何 NAS 工具。";
    input.placeholder = next === "direct" ? "直接和模型对话，例如：解释一下 NAS 的存储池设计" : "例如：查看系统状态 / 然后打开刚才的目录";
  }
  switchMode(mode);

  /* ---------------- 审批 ---------------- */
  async function loadPending(){
    let actions = [];
    try{
      const data = await callJson("actionsPending");
      actions = data.actions || [];
    }catch{ return; }
    pendingHost.replaceChildren();
    for(const action of actions){
      const argsText = (() => { try{ return JSON.stringify(formatDisplayValue(action.args), null, 2); }catch{ return ""; } })();
      const card = h("div", { class:"card", style:"border-color:var(--warn)" },
        h("div", { class:"card__head" }, h("h3", { class:"card__title" }, "⚠️ " + action.title + " · 需要确认"),
          h("p", { class:"card__sub" }, (action.description || "") + " · 截止 " + formatDateTime(action.expiresAt))),
        h("div", { class:"card__body" },
          h("p", { style:"font-size:13px;margin:0 0 6px" }, "目标：", h("b", null, action.target || "—")),
          argsText ? h("pre", { class:"code", style:"max-height:140px" }, argsText) : null,
          h("div", { class:"row", style:"gap:8px;margin-top:8px" },
            h("button", { class:"btn btn--danger btn--sm", onclick:async event => {
              confirmModal("确认危险操作", "将执行「" + action.title + "」，目标：" + (action.target || "") +
                "\n此操作可能造成数据丢失，且确认仅一次有效。", "确认执行", async () => {
                try{
                  await callJson("actionConfirm", { params:{ id:action.id }, body:{} });
                  toast("已执行确认操作", "ok");
                }catch(error){ toast(error.message, "err"); }
                loadPending();
              });
            } }, "确认执行"),
            h("button", { class:"btn btn--sm", onclick:async () => {
              try{ await callJson("actionDeny", { params:{ id:action.id }, body:{} }); }catch(error){ toast(error.message, "err"); }
              loadPending();
            } }, "拒绝"))));
      const bubbleEl = thread.querySelector('[data-task-id="' + CSS.escape(action.taskId || "") + '"]');
      if(bubbleEl) bubbleEl._parts.approval.replaceChildren(card);
      else pendingHost.append(card);
    }
    if(!actions.length && pendingHost.childElementCount === 0) pendingHost.append(h("p", { class:"muted", style:"font-size:12px;margin:0" }, "没有待确认操作。"));
  }

  /* ---------------- 任务队列 ---------------- */
  const queueList = h("div", { class:"list" });
  const queueMeta = h("p", { class:"muted", style:"font-size:12px;margin:0 0 8px" });
  let queueOffset = 0;
  async function loadQueue(){
    try{
      const st = await callJson("tasksStatus");
      queueMeta.textContent = "运行中 " + (st.running ?? "—") + " · 排队 " + (st.queued ?? "—") + " · 并发上限 " + (st.concurrency ?? "—");
    }catch{ queueMeta.textContent = "队列状态暂不可用"; }
    try{
      const data = await callJson("tasksList", { query:{ limit:6, offset:queueOffset } });
      clear(queueList);
      for(const task of (data.tasks || [])){
        const active = task.status === "queued" || task.status === "running";
        queueList.append(h("div", { class:"list__row" },
          h("span", { class:"badge " + (task.status === "completed" ? "badge--ok" : task.status === "failed" ? "badge--danger" : "badge--info") }, task.status),
          h("div", { class:"list__main" },
            h("div", { class:"list__title" }, (task.stage || task.status) + (task.result?.message ? " · " + task.result.message : "")),
            h("div", { class:"list__meta" }, (task.taskId || "").slice(0, 8) + " · " + formatDateTime(task.createdAt))),
          active ? h("button", { class:"btn btn--ghost btn--sm", onclick:async event => {
            try{ await callJson("taskCancel", { params:{ id:task.taskId } }); loadQueue(); }catch(error){ toast(error.message, "err"); }
          } }, task.cancelRequested ? "停止中…" : "取消") : null));
      }
      if(!(data.tasks || []).length) queueList.append(h("p", { class:"muted", style:"font-size:12px" }, "暂无任务记录。"));
      const prev = queueNav.firstChild, next = queueNav.lastChild;
      prev.disabled = (data.offset || 0) <= 0;
      next.disabled = (data.offset || 0) + (data.tasks || []).length >= (data.totalEntries || data.total || 0);
    }catch{ clear(queueList).append(h("p", { class:"muted", style:"font-size:12px" }, "任务列表暂不可用。")); }
  }
  const queueNav = h("div", { class:"row", style:"gap:8px;margin-top:8px" },
    h("button", { class:"btn btn--ghost btn--sm", onclick:() => { queueOffset = Math.max(0, queueOffset - 6); loadQueue(); } }, "上一页"),
    h("button", { class:"btn btn--ghost btn--sm", onclick:() => { queueOffset += 6; loadQueue(); } }, "下一页"));

  /* ---------------- 组装 ---------------- */
  const form = h("form", { class:"row", style:"gap:8px;align-items:flex-end;margin-top:10px",
      onsubmit:event => { event.preventDefault(); doSubmit(); } },
    input, h("button", { class:"btn btn--primary", type:"submit" }, "发送"));

  thread.append(h("div", { style:"display:flex;justify-content:flex-start" },
    h("div", { style:"max-width:88%;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:10px 14px;font-size:14px" },
      "你好！我可以查看状态、浏览文件、执行经确认的整理任务。破坏性操作会先展示具体目标，确认后才会执行。")));

  const statusCard = h("div", { class:"card" },
    h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "助手状态"),
      h("p", { class:"card__sub", id:"chat-agent-status" }, "读取中…")),
    h("div", { class:"card__body" },
      h("div", { class:"row row--wrap", style:"gap:8px" },
        h("button", { class:"btn btn--sm", onclick:() => testCli() }, "检测官方 CLI 连接"),
        h("button", { class:"btn btn--ghost btn--sm", onclick:() => { history.length = 0; toast("已清空对话上下文", "ok"); } }, "清空上下文")),
      h("p", { class:"muted", style:"font-size:12px;margin:8px 0 0" },
        "对话上下文只保存在当前页面内存中，不写入任务历史。")));

  callJson("agentStatus").then(s => {
    const el = document.getElementById("chat-agent-status");
    if(!el) return;
    const cli = s.trimCli || {};
    el.textContent = "模型：" + (s.model?.enabled ? (s.model.providerName || s.model.model) : "未配置") +
      " · 可用工具 " + s.availableTools + " · 任意命令执行：关闭" +
      (cli.connectionStatus ? " · CLI：" + cli.connectionStatus : "");
  }).catch(() => {});

  function testCli(){
    callJson("trimCliTest", { body:{} }).then(r => {
      openModal("CLI 连接检测", h("pre", { class:"code" }, JSON.stringify(formatDisplayValue(r), null, 2).slice(0, 3000)),
        [{ label:"关闭", onClick:close => close() }]);
    }).catch(error => toast(error.message, "err"));
  }

  root.append(
    h("div", { class:"card", style:"display:flex;flex-direction:column;min-height:56vh" },
      h("div", { class:"card__head", style:"align-items:center" }, modeSeg, h("span", { style:"flex:1" }), statusEl, stopBtn),
      h("div", { class:"card__body", style:"flex:1;display:flex;flex-direction:column;padding-top:0" },
        modeHint, thread, form)),
    h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "待确认的危险操作"),
        h("p", { class:"card__sub" }, "与对话目标一一对应，60 秒内有效且只能执行一次")),
      h("div", { class:"card__body" }, pendingHost)),
    h("div", { class:"card" },
      h("div", { class:"card__head" }, h("h2", { class:"card__title" }, "任务队列"),
        h("p", { class:"card__sub" }, ""), h("span", { style:"flex:1" }), queueMeta),
      h("div", { class:"card__body" }, queueList, queueNav)),
    statusCard);

  loadPending(); loadQueue();
}
