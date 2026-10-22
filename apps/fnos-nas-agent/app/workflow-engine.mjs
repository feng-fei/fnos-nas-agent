/**
 * Phase 168 — 工作流引擎
 *
 * Marvis 清单 W02–W08、W10 目前只有"健康检查计划"一个种子，没有依赖图、
 * 没有锁、没有通知目标。本模块补上工作流的骨架：依赖图、并发锁、审批门、
 * 通知目标与事件流。
 *
 * 设计原则（与仓库既有模块一致）：
 *   - 纯逻辑、可注入依赖、无第三方依赖、ESM；
 *   - 引擎自身不执行任何 shell，也不执行任何工具；
 *   - 引擎自身绝不自行批准审批请求——批准只能来自调用方注入的 requestApproval；
 *   - 通知回调只拿到 step id、状态与耗时，绝不携带参数原文或密钥。
 */

/** 每个工作流保留的最大事件条数（事件流是有界元数据通道）。 */
const MAX_EVENTS = 200;
/** 单条事件文本的最大长度。 */
const MAX_EVENT_MESSAGE_LENGTH = 300;
/** 单次运行中每个 step 的标识最大长度。 */
const MAX_ID_LENGTH = 128;

/**
 * @typedef {Object} WorkflowStep
 * @property {string} id 步骤标识（工作流内唯一）
 * @property {string} [tool] 步骤要调用的白名单工具名
 * @property {string[]} [dependsOn] 前置步骤标识
 * @property {boolean} [approval] 是否需要人工审批
 * @property {boolean} [notify] 是否触发通知
 * @property {object} [args] 传给工具的参数（只传给 invokeTool，不进通知）
 */

/**
 * @typedef {Object} WorkflowDefinition
 * @property {string} id
 * @property {string} name
 * @property {WorkflowStep[]} steps
 */

function normalizeText(value, max = MAX_ID_LENGTH) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function defaultIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `wf-${Date.now().toString(36)}-${counter.toString(36)}`;
  };
}

function defaultNow() {
  return Date.now();
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  return Date.now();
}

function toIso(value) {
  const millis = toMillis(value);
  if (!Number.isFinite(millis)) return new Date().toISOString();
  return new Date(millis).toISOString();
}

/**
 * 判断一次审批结果是否代表"已批准"。
 * 兼容布尔值与 {approved:boolean} 两种返回形态；其余一律视为未批准。
 */
function isApproved(result) {
  if (result === true) return true;
  if (result && typeof result === "object" && result.approved === true) return true;
  return false;
}

/**
 * 校验并规范化一个工作流定义。
 * @param {{id: string, name?: string, steps: WorkflowStep[]}} input
 * @returns {WorkflowDefinition}
 */
export function normalizeWorkflowDefinition(input) {
  if (!input || typeof input !== "object") {
    throw new Error("workflow definition must be an object");
  }
  const id = normalizeText(input.id);
  if (!id) {
    throw new Error("workflow id is required");
  }
  const name = normalizeText(input.name) || id;
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error(`workflow ${id} must declare at least one step`);
  }

  const steps = input.steps.map((step, index) => {
    if (!step || typeof step !== "object") {
      throw new Error(`workflow ${id} step #${index} must be an object`);
    }
    const stepId = normalizeText(step.id);
    if (!stepId) {
      throw new Error(`workflow ${id} step #${index} requires an id`);
    }
    let dependsOn = [];
    if (step.dependsOn !== undefined && step.dependsOn !== null) {
      if (!Array.isArray(step.dependsOn)) {
        throw new Error(`workflow ${id} step ${stepId} dependsOn must be an array`);
      }
      dependsOn = step.dependsOn.map((dependency) => {
        const value = normalizeText(dependency);
        if (!value) {
          throw new Error(`workflow ${id} step ${stepId} has an empty dependency`);
        }
        return value;
      });
    }
    return {
      id: stepId,
      name: normalizeText(step.name) || stepId,
      tool: typeof step.tool === "string" && step.tool.trim() ? step.tool.trim() : null,
      dependsOn,
      approval: step.approval === true,
      notify: step.notify === true,
      args: step.args && typeof step.args === "object" ? step.args : null,
      order: index
    };
  });

  const seen = new Set();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(`workflow ${id} has a duplicate step id: ${step.id}`);
    }
    seen.add(step.id);
  }

  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!seen.has(dependency)) {
        throw new Error(`workflow ${id} step ${step.id} depends on an unknown step: ${dependency}`);
      }
      if (dependency === step.id) {
        throw new Error(`workflow ${id} step ${step.id} depends on itself`);
      }
    }
  }

  assertAcyclic(id, steps);

  return {
    id,
    name,
    steps: steps.map(({ order, ...step }) => step)
  };
}

/**
 * 依赖成环检测（DFS 三色标记）。
 * @param {string} workflowId
 * @param {{id: string, dependsOn: string[]}[]} steps
 */
function assertAcyclic(workflowId, steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map();

  const visit = (stepId, trail) => {
    const color = state.get(stepId) ?? 0;
    if (color === 1) {
      throw new Error(`workflow ${workflowId} has a dependency cycle: ${[...trail, stepId].join(" -> ")}`);
    }
    if (color === 2) return;
    state.set(stepId, 1);
    const step = byId.get(stepId);
    if (step) {
      for (const dependency of step.dependsOn) {
        visit(dependency, [...trail, stepId]);
      }
    }
    state.set(stepId, 2);
  };

  for (const step of steps) {
    visit(step.id, []);
  }
}

/**
 * 拓扑排序。同一层内保持注册顺序，保证执行顺序稳定可复现。
 * @param {{id: string, dependsOn: string[], order: number}[]} steps
 * @returns {string[]}
 */
export function topologicalOrder(steps) {
  const position = new Map(steps.map((step, index) => [step.id, index]));
  const indegree = new Map();
  const dependents = new Map();
  for (const step of steps) {
    indegree.set(step.id, step.dependsOn.length);
    for (const dependency of step.dependsOn) {
      if (!dependents.has(dependency)) dependents.set(dependency, []);
      dependents.get(dependency).push(step.id);
    }
  }

  const ready = steps
    .filter((step) => (indegree.get(step.id) ?? 0) === 0)
    .map((step) => step.id)
    .sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));

  const order = [];
  while (ready.length > 0) {
    const stepId = ready.shift();
    order.push(stepId);
    const next = dependents.get(stepId) ?? [];
    for (const dependent of next) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
      }
    }
  }

  if (order.length !== steps.length) {
    const missing = steps.filter((step) => !order.includes(step.id)).map((step) => step.id);
    throw new Error(`workflow has a dependency cycle: ${missing.join(" -> ")}`);
  }
  return order;
}

/**
 * 创建工作流引擎。
 * @param {{now?: () => number|string|Date, id?: () => string, allowedTools?: string[]}} [options]
 */
export function createWorkflowEngine({ now = defaultNow, id = defaultIdFactory, allowedTools = null } = {}) {
  if (typeof now !== "function") {
    throw new Error("now must be a function");
  }
  if (typeof id !== "function") {
    throw new Error("id must be a function");
  }
  const toolAllowList = Array.isArray(allowedTools)
    ? new Set(allowedTools.map((tool) => normalizeText(tool)))
    : null;

  /** @type {Map<string, WorkflowDefinition>} */
  const workflows = new Map();
  /** @type {Map<string, object[]>} */
  const events = new Map();
  /** @type {Set<string>} 正在运行的 workflowId（并发锁） */
  const running = new Set();

  const recordEvent = (workflowId, event) => {
    const list = events.get(workflowId) ?? [];
    list.push({
      at: toIso(now()),
      workflowId,
      type: event.type,
      stepId: event.stepId ?? null,
      status: event.status ?? null,
      durationMs: typeof event.durationMs === "number" ? event.durationMs : null,
      message: normalizeText(event.message ?? "", MAX_EVENT_MESSAGE_LENGTH)
    });
    while (list.length > MAX_EVENTS) list.shift();
    events.set(workflowId, list);
  };

  /**
   * 注册工作流。依赖不存在、step id 重复或依赖成环都会直接抛错。
   * @param {{id: string, name?: string, steps: WorkflowStep[]}} definition
   * @returns {WorkflowDefinition}
   */
  function registerWorkflow(definition) {
    const normalized = normalizeWorkflowDefinition(definition);
    if (workflows.has(normalized.id)) {
      throw new Error(`workflow ${normalized.id} is already registered`);
    }
    workflows.set(normalized.id, normalized);
    recordEvent(normalized.id, {
      type: "workflow.registered",
      status: "registered",
      message: `已注册工作流 ${normalized.name}（${normalized.steps.length} 个步骤）`
    });
    return getWorkflow(normalized.id);
  }

  /**
   * 列出已注册工作流。
   * @returns {Array<{id: string, name: string, stepCount: number}>}
   */
  function listWorkflows() {
    return [...workflows.values()].map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      stepCount: workflow.steps.length
    }));
  }

  /**
   * 读取一个工作流定义。
   * @param {string} workflowId
   * @returns {WorkflowDefinition|null}
   */
  function getWorkflow(workflowId) {
    const workflow = workflows.get(normalizeText(workflowId));
    if (!workflow) return null;
    return {
      id: workflow.id,
      name: workflow.name,
      steps: workflow.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }))
    };
  }

  /**
   * 读取工作流事件流（有界，最多 200 条）。
   * @param {string} workflowId
   * @returns {object[]}
   */
  function workflowEvents(workflowId) {
    const list = events.get(normalizeText(workflowId));
    if (!list) return [];
    return list.map((event) => ({ ...event }));
  }

  /**
   * 按依赖顺序执行一个工作流。
   *
   * @param {string} workflowId
   * @param {{
   *   invokeTool?: (request: {tool: string, stepId: string, workflowId: string, sessionId?: string, args: object|null}) => unknown,
   *   requestApproval?: (request: {stepId: string, workflowId: string, sessionId?: string}) => unknown,
   *   sessionId?: string,
   *   notify?: (notification: {stepId: string, status: string, durationMs: number}) => void
   * }} [options]
   * @returns {object}
   */
  async function runWorkflow(workflowId, options = {}) {
    const key = normalizeText(workflowId);
    const workflow = workflows.get(key);
    if (!workflow) {
      return { started: false, reason: "unknown-workflow", workflowId: key };
    }
    if (running.has(key)) {
      return { started: false, reason: "locked", workflowId: key };
    }

    running.add(key);
    try {
      return await execute(workflow, options);
    } finally {
      // 锁必须无条件释放：即使执行过程中抛出异常，也不能留下永久锁。
      running.delete(key);
    }
  }

  async function execute(workflow, options) {
    const { invokeTool, requestApproval, sessionId, notify } = options ?? {};
    const runId = normalizeText(id(), MAX_ID_LENGTH);
    const steps = workflow.steps.map((step) => ({ ...step }));
    const byId = new Map(steps.map((step) => [step.id, step]));
    const order = topologicalOrder(steps);
    const results = new Map();

    recordEvent(workflow.id, {
      type: "workflow.started",
      status: "running",
      message: `开始执行工作流 ${workflow.name}`
    });

    for (const stepId of order) {
      const step = byId.get(stepId);
      const dependencies = step.dependsOn;
      const blocked = dependencies.find((dependency) => {
        const state = results.get(dependency);
        return state && state.status !== "completed";
      });
      if (blocked) {
        const dependencyState = results.get(blocked);
        const reason = dependencyState?.status === "failed" ? "dependency-failed" : "dependency-skipped";
        const entry = {
          id: step.id,
          status: "skipped",
          reason,
          blockedBy: blocked,
          durationMs: 0
        };
        results.set(step.id, entry);
        recordEvent(workflow.id, {
          type: "step.skipped",
          stepId: step.id,
          status: "skipped",
          durationMs: 0,
          message: `步骤 ${step.id} 因前置步骤 ${blocked} 未完成而跳过`
        });
        continue;
      }

      const startedAt = toMillis(now());
      let status = "completed";
      let reason = null;
      let error = null;

      if (step.approval === true) {
        let approval = null;
        if (typeof requestApproval === "function") {
          try {
            approval = await requestApproval({
              stepId: step.id,
              workflowId: workflow.id,
              sessionId
            });
          } catch (approvalError) {
            approval = null;
            error = normalizeText(approvalError?.message ?? approvalError, MAX_EVENT_MESSAGE_LENGTH);
          }
        }
        if (!isApproved(approval)) {
          status = "skipped";
          reason = error ? "approval-failed" : "approval-denied";
          if (error) {
            recordEvent(workflow.id, {
              type: "step.approval-error",
              stepId: step.id,
              status: "skipped",
              durationMs: Math.max(0, toMillis(now()) - startedAt),
              message: `步骤 ${step.id} 的审批请求失败：${error}`
            });
          } else {
            recordEvent(workflow.id, {
              type: "step.approval-denied",
              stepId: step.id,
              status: "skipped",
              durationMs: Math.max(0, toMillis(now()) - startedAt),
              message: `步骤 ${step.id} 未获批准，已跳过`
            });
          }
          const entry = { id: step.id, status, reason, durationMs: Math.max(0, toMillis(now()) - startedAt) };
          results.set(step.id, entry);
          if (typeof notify === "function" && step.notify === true) {
            sendNotification(notify, { stepId: step.id, status, durationMs: entry.durationMs });
          }
          continue;
        }
        recordEvent(workflow.id, {
          type: "step.approved",
          stepId: step.id,
          status: "approved",
          message: `步骤 ${step.id} 已获批准`
        });
      }

      if (step.tool) {
        if (toolAllowList && !toolAllowList.has(step.tool)) {
          status = "skipped";
          reason = "tool-not-allowed";
          const entry = { id: step.id, status, reason, durationMs: Math.max(0, toMillis(now()) - startedAt) };
          results.set(step.id, entry);
          recordEvent(workflow.id, {
            type: "step.skipped",
            stepId: step.id,
            status: "skipped",
            durationMs: entry.durationMs,
            message: `步骤 ${step.id} 的工具不在白名单内，已跳过`
          });
          if (typeof notify === "function" && step.notify === true) {
            sendNotification(notify, { stepId: step.id, status, durationMs: entry.durationMs });
          }
          continue;
        }
        if (typeof invokeTool !== "function") {
          status = "skipped";
          reason = "invoke-tool-unavailable";
          const entry = { id: step.id, status, reason, durationMs: Math.max(0, toMillis(now()) - startedAt) };
          results.set(step.id, entry);
          recordEvent(workflow.id, {
            type: "step.skipped",
            stepId: step.id,
            status: "skipped",
            durationMs: entry.durationMs,
            message: `步骤 ${step.id} 缺少工具调用器，已跳过`
          });
          if (typeof notify === "function" && step.notify === true) {
            sendNotification(notify, { stepId: step.id, status, durationMs: entry.durationMs });
          }
          continue;
        }
        try {
          await invokeTool({
            tool: step.tool,
            stepId: step.id,
            workflowId: workflow.id,
            sessionId,
            args: step.args
          });
        } catch (toolError) {
          status = "failed";
          reason = normalizeText(toolError?.message ?? toolError, MAX_EVENT_MESSAGE_LENGTH) || "tool-failed";
          error = reason;
        }
      }

      const durationMs = Math.max(0, toMillis(now()) - startedAt);
      const entry = { id: step.id, status, reason, durationMs };
      results.set(step.id, entry);

      if (status === "completed") {
        recordEvent(workflow.id, {
          type: "step.completed",
          stepId: step.id,
          status: "completed",
          durationMs,
          message: `步骤 ${step.id} 执行完成`
        });
      } else {
        recordEvent(workflow.id, {
          type: "step.failed",
          stepId: step.id,
          status: "failed",
          durationMs,
          message: `步骤 ${step.id} 执行失败：${reason}`
        });
      }

      if (typeof notify === "function" && step.notify === true) {
        sendNotification(notify, { stepId: step.id, status, durationMs });
      }
    }

    const stepResults = order.map((stepId) => results.get(stepId)).filter(Boolean);
    const failed = stepResults.filter((entry) => entry.status === "failed");
    const skipped = stepResults.filter((entry) => entry.status === "skipped");
    const workflowStatus = failed.length > 0
      ? "failed"
      : skipped.length > 0
        ? "partial"
        : "completed";

    recordEvent(workflow.id, {
      type: "workflow.finished",
      status: workflowStatus,
      message: `工作流 ${workflow.name} 结束：${workflowStatus}`
    });

    return {
      started: true,
      workflowId: workflow.id,
      runId,
      status: workflowStatus,
      steps: stepResults,
      events: workflowEvents(workflow.id)
    };
  }

  return {
    registerWorkflow,
    listWorkflows,
    getWorkflow,
    workflowEvents,
    runWorkflow
  };
}

/**
 * 通知回调只允许携带 step id、状态与耗时。
 * 参数原文、工具入参与密钥一律不得进入通知。
 */
function sendNotification(notify, notification) {
  try {
    notify({
      stepId: notification.stepId,
      status: notification.status,
      durationMs: notification.durationMs
    });
  } catch {
    // 通知失败不得影响工作流本身的执行结果。
  }
}
