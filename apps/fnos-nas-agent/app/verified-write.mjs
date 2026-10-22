/**
 * Phase 171 — 可验证写路径框架（verified write pipeline）
 *
 * 对照表 D08–D11（一次性修复、修复前检查、修复后验证、失败回滚）与
 * C07–C10（服务 / 容器 / 配置 / 资源写路径）长期是 Open：仓库刻意不提供
 * 未经复核的写路径。本模块补的不是某条真实的服务控制接口，而是"写路径
 * 必须长什么样"的框架与契约，让后续每条写路径都复用同一套语义。
 *
 * 设计原则（与仓库既有模块一致）：
 *   - 纯逻辑、可注入依赖、无第三方依赖、ESM；
 *   - 本模块自身不执行任何 I/O：preview / apply / verify / rollback 全部由
 *     调用方注入，本模块也不 import node:child_process / node:http / node:fs；
 *   - 固定四阶段：preview → approval → apply → verify；
 *   - 本模块绝不自行批准审批请求——批准只能来自调用方注入的 requestApproval，
 *     且不接受任何"已批准"布尔值绕过；
 *   - 事件是有界元数据通道：只带阶段名、耗时、成功与否与错误类别，
 *     绝不携带 args 原文或密钥。
 */

/** 事件流最多保留的事件条数（超出时丢弃最旧的一条）。 */
const MAX_EVENTS = 200;
/** 单条错误信息的最大长度。 */
const MAX_ERROR_MESSAGE_LENGTH = 300;
/** 允许的写路径风险等级。 */
const ALLOWED_RISKS = new Set(["write", "destructive"]);
/** 固定四阶段的阶段名。 */
export const VERIFIED_WRITE_STAGES = Object.freeze(["preview", "approval", "apply", "verify"]);

function defaultNow() {
  return Date.now();
}

function defaultIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `vwp-${Date.now().toString(36)}-${counter.toString(36)}`;
  };
}

function normalizeText(value, max = 128) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  return Date.now();
}

/**
 * 一次审批结果是否代表"已批准"。
 * 只接受 true 或 { approved: true }；其余一律视为未批准。
 */
function isApproved(result) {
  if (result === true) return true;
  if (result && typeof result === "object" && result.approved === true) return true;
  return false;
}

/**
 * 读回校验的返回值是否代表"校验通过"。
 * 支持布尔值、{ verified: boolean } 与 { ok: boolean }。
 */
function isVerified(result) {
  if (result && typeof result === "object") {
    if (typeof result.verified === "boolean") return result.verified;
    if (typeof result.ok === "boolean") return result.ok;
  }
  return Boolean(result);
}

function errorText(error) {
  if (!error) return "unknown error";
  const message = typeof error === "string" ? error : error.message;
  const text = typeof message === "string" && message ? message : String(error);
  return text.length > MAX_ERROR_MESSAGE_LENGTH ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : text;
}

/**
 * 创建一条可验证写路径流水线。
 *
 * @param {object} [options]
 * @param {() => number|string|Date} [options.now] 时钟注入（用于计算阶段耗时）
 * @param {() => string} [options.id] 运行标识注入
 */
export function createVerifiedWritePipeline({ now = defaultNow, id = defaultIdFactory } = {}) {
  const clock = typeof now === "function" ? now : defaultNow;
  const idFactory = typeof id === "function" ? id : defaultIdFactory;
  /** @type {Map<string, object>} */
  const actions = new Map();
  /** 有界的全局事件流（跨运行）。 */
  const eventLog = [];

  /**
   * 记录一条阶段事件。
   * 事件只包含阶段名、状态、耗时与错误类别——没有 args，没有预览内容，没有密钥。
   */
  function recordEvent(events, stage, status, durationMs, errorCategory = null) {
    const event = {
      stage,
      status,
      durationMs: Math.max(0, Math.round(durationMs) || 0),
      errorCategory: errorCategory || null
    };
    events.push(event);
    eventLog.push(event);
    while (eventLog.length > MAX_EVENTS) eventLog.shift();
    return event;
  }

  /**
   * 注册一条写路径。
   *
   * @param {object} input
   * @param {string} input.id 动作标识
   * @param {string} [input.title] 人类可读标题
   * @param {"write"|"destructive"} input.risk 风险等级
   * @param {(args: object, context: object) => any} input.preview 预演：返回将要改动的对象与影响面
   * @param {(args: object, context: {capability: string}) => any} input.apply 执行
   * @param {(args: object, context: {before: any, preview: any}) => any} input.verify 读回校验
   * @param {(args: object, context: {before: any, error: Error}) => any} [input.rollback] 失败回滚
   */
  function defineAction(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("verified write action must be an object");
    }
    const actionId = normalizeText(input.id);
    if (!actionId) {
      throw new TypeError("verified write action requires an id");
    }
    const risk = normalizeText(input.risk, 32);
    if (!ALLOWED_RISKS.has(risk)) {
      throw new TypeError(`verified write action ${actionId} must declare risk as "write" or "destructive"`);
    }
    for (const stage of ["preview", "apply", "verify"]) {
      if (typeof input[stage] !== "function") {
        throw new TypeError(`verified write action ${actionId} requires a ${stage} function`);
      }
    }
    if (input.rollback !== undefined && input.rollback !== null && typeof input.rollback !== "function") {
      throw new TypeError(`verified write action ${actionId} rollback must be a function when provided`);
    }
    const action = {
      id: actionId,
      title: normalizeText(input.title, 200) || actionId,
      risk,
      preview: input.preview,
      apply: input.apply,
      verify: input.verify,
      rollback: typeof input.rollback === "function" ? input.rollback : null
    };
    actions.set(actionId, action);
    return { ...action };
  }

  /**
   * 失败回滚。回滚失败如实上报，不吞掉错误。
   */
  async function performRollback(action, args, before, error, events) {
    if (!action.rollback) {
      return { rolledBack: false, rollbackFailed: false, skipped: true, error: null };
    }
    const startedAt = toMillis(clock());
    try {
      await action.rollback(args, { before, error });
      recordEvent(events, "rollback", "ok", toMillis(clock()) - startedAt);
      return { rolledBack: true, rollbackFailed: false, skipped: false, error: null };
    } catch (rollbackError) {
      recordEvent(events, "rollback", "failed", toMillis(clock()) - startedAt, "rollback-failed");
      return { rolledBack: false, rollbackFailed: true, skipped: false, error: rollbackError };
    }
  }

  /**
   * 运行一条写路径：preview → approval → apply → verify。
   *
   * @param {string} actionId
   * @param {object} [options]
   * @param {(request: object) => any} [options.requestApproval] 审批通道（必须由调用方注入）
   * @param {string} [options.sessionId] 会话标识
   * @param {string} [options.taskId] 任务标识
   * @param {string} [options.capability] 服务端下发的能力标识（缺失即失败）
   * @param {object} [options.args] 动作参数（只传给注入的函数，不进事件）
   */
  async function runAction(actionId, options = {}) {
    const requestedId = normalizeText(actionId);
    const action = actions.get(requestedId);
    const runId = normalizeText(idFactory(), 128);
    const events = [];
    const sessionId = normalizeText(options.sessionId, 128) || null;
    const taskId = normalizeText(options.taskId, 128) || null;
    const args = options.args && typeof options.args === "object" ? options.args : {};
    const result = {
      runId,
      actionId: action ? action.id : requestedId,
      title: action ? action.title : requestedId,
      risk: action ? action.risk : null,
      status: "failed",
      reason: null,
      applied: false,
      verified: false,
      rolledBack: false,
      rollbackFailed: false,
      preview: null,
      capability: null,
      sessionId,
      taskId,
      error: null,
      rollbackError: null,
      events
    };

    if (!action) {
      result.reason = "unknown-action";
      result.error = { category: "unknown-action", message: `action ${requestedId} is not defined` };
      recordEvent(events, "preview", "failed", 0, "unknown-action");
      return result;
    }

    // capability 必须由调用方从服务端传入；缺失即失败。
    // 提前失败可以避免为一条注定无法执行的写路径去申请审批。
    const capability = normalizeText(options.capability, 128);
    if (!capability) {
      result.reason = "capability-missing";
      result.error = { category: "capability-missing", message: "capability must be provided by the caller" };
      recordEvent(events, "apply", "failed", 0, "capability-missing");
      return result;
    }
    result.capability = capability;

    // ---- 阶段 1：preview（预演） ----
    const previewStartedAt = toMillis(clock());
    let previewResult;
    try {
      previewResult = await action.preview(args, { capability, sessionId, taskId });
    } catch (error) {
      recordEvent(events, "preview", "failed", toMillis(clock()) - previewStartedAt, "preview-failed");
      result.reason = "preview-failed";
      result.error = { category: "preview-failed", message: errorText(error) };
      return result;
    }
    recordEvent(events, "preview", "ok", toMillis(clock()) - previewStartedAt);
    result.preview = previewResult === undefined ? null : previewResult;

    const before =
      previewResult && typeof previewResult === "object" && "before" in previewResult
        ? previewResult.before
        : previewResult;

    // ---- 阶段 2：approval（审批） ----
    // 本模块绝不自行批准：唯一来源是注入的 requestApproval 的返回值。
    // options 里的任何"已批准"标记（approved / preApproved / approval）一律被忽略。
    const approvalStartedAt = toMillis(clock());
    let approved = false;
    if (typeof options.requestApproval === "function") {
      try {
        const decision = await options.requestApproval({
          actionId: action.id,
          title: action.title,
          risk: action.risk,
          preview: result.preview,
          sessionId,
          taskId
        });
        approved = isApproved(decision);
      } catch (error) {
        recordEvent(events, "approval", "failed", toMillis(clock()) - approvalStartedAt, "approval-failed");
        result.reason = "approval-denied";
        result.error = { category: "approval-failed", message: errorText(error) };
        return result;
      }
    }
    if (!approved) {
      recordEvent(events, "approval", "denied", toMillis(clock()) - approvalStartedAt, "approval-denied");
      result.reason = "approval-denied";
      result.error = { category: "approval-denied", message: "the action was not explicitly approved" };
      return result;
    }
    recordEvent(events, "approval", "ok", toMillis(clock()) - approvalStartedAt);

    // ---- 阶段 3：apply（执行） ----
    const applyStartedAt = toMillis(clock());
    let appliedValue;
    try {
      appliedValue = await action.apply(args, { capability });
    } catch (error) {
      recordEvent(events, "apply", "failed", toMillis(clock()) - applyStartedAt, "apply-failed");
      result.reason = "apply-failed";
      result.error = { category: "apply-failed", message: errorText(error) };
      const rollback = await performRollback(action, args, before, error, events);
      result.rolledBack = rollback.rolledBack;
      result.rollbackFailed = rollback.rollbackFailed;
      if (rollback.error) result.rollbackError = { category: "rollback-failed", message: errorText(rollback.error) };
      return result;
    }
    recordEvent(events, "apply", "ok", toMillis(clock()) - applyStartedAt);
    result.applied = true;
    result.appliedValue = appliedValue === undefined ? null : appliedValue;

    // ---- 阶段 4：verify（读回校验） ----
    const verifyStartedAt = toMillis(clock());
    let verified = false;
    let verifyError = null;
    try {
      verified = isVerified(await action.verify(args, { before, preview: result.preview }));
    } catch (error) {
      verifyError = error;
      verified = false;
    }
    if (!verified) {
      recordEvent(events, "verify", "failed", toMillis(clock()) - verifyStartedAt, "verify-failed");
      result.verified = false;
      result.reason = "verify-failed";
      result.error = {
        category: "verify-failed",
        message: errorText(verifyError || "read back verification failed")
      };
      const rollback = await performRollback(action, args, before, verifyError || new Error("read back verification failed"), events);
      result.rolledBack = rollback.rolledBack;
      result.rollbackFailed = rollback.rollbackFailed;
      if (rollback.error) result.rollbackError = { category: "rollback-failed", message: errorText(rollback.error) };
      return result;
    }
    recordEvent(events, "verify", "ok", toMillis(clock()) - verifyStartedAt);
    result.verified = true;
    result.status = "completed";
    result.reason = null;
    return result;
  }

  /** 返回有界的全局事件流副本。 */
  function getEvents() {
    return eventLog.map(event => ({ ...event }));
  }

  /** 返回已注册的写路径标识。 */
  function listActions() {
    return Array.from(actions.keys());
  }

  return { defineAction, runAction, getEvents, listActions };
}
