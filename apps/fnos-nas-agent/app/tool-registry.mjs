// Phase 147: a registrable tool registry.
//
// The built-in fnOS tools used to be a hard coded list inside one module. This
// registry keeps that list as the default source, but it also allows other
// sources (a Skill, an external MCP server) to publish their own tools into
// the same catalogue. Every source is tagged, so the UI and the audit log can
// always tell where a tool came from.
//
// The safety rules of the built-in tools are not weakened by this module:
//   - The built-in source keeps its own execution policy gate, so its error
//     messages and status codes stay exactly as they were.
//   - A foreign source never bypasses the global execution policy. The
//     registry evaluates the policy before the call, which means the read-only
//     mode and the kill switch also cover external tools.
//   - A foreign tool can never be destructive unless the caller presents the
//     same server issued capability that the built-in destructive tool needs.

import { hasDeleteCapability } from "./execution-capability.mjs";

export const TOOL_SOURCE_KINDS = Object.freeze(["builtin", "skill", "mcp"]);

// The underscore is part of the accepted set because the MCP bridge uses it
// for its namespace separator (`mcp__server__tool`).
const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9._:_-]{0,127}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_SOURCES = 16;
const MAX_TOOLS_PER_SOURCE = 200;

/**
 * Normalizes a tool identifier.
 *
 * Built-in identifiers look like `files.list`. External tools use a namespaced
 * identifier such as `mcp:nas-tools:volume.list`, so the colon is part of the
 * accepted character set. The identifier is never allowed to start with a
 * separator, to contain a path separator or to exceed the length limit.
 *
 * @returns {string|null} the normalized identifier or null when it is invalid
 */
export function normalizeToolId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!TOOL_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validates a tool argument object against a JSON schema subset.
 *
 * The subset is the same one the agent core uses: object type, declared
 * properties, required properties, string length, integer range, boolean type
 * and enum values. A foreign tool therefore cannot smuggle undeclared
 * arguments past the gate.
 *
 * @returns {boolean}
 */
export function validateToolArgs(args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const properties = schema?.properties || {};
  if (schema?.additionalProperties === false && Object.keys(args).some(key => !Object.hasOwn(properties, key))) return false;
  for (const key of schema?.required || []) if (!Object.hasOwn(args, key)) return false;
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (!rule) return false;
    if (rule.type === "string" && (typeof value !== "string" || (rule.minLength && value.length < rule.minLength) || (rule.maxLength && value.length > rule.maxLength))) return false;
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) return false;
    if (rule.type === "integer" && (!Number.isInteger(value) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))) return false;
    if (rule.type === "boolean" && typeof value !== "boolean") return false;
  }
  return true;
}

function normalizeTool(tool, source) {
  const id = normalizeToolId(tool?.id);
  if (!id) return null;
  const risk = ["read-only", "write", "destructive"].includes(tool?.risk) ? tool.risk : "read-only";
  const inputSchema = tool?.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
    ? tool.inputSchema
    : { type: "object", properties: {}, additionalProperties: false };
  return {
    id,
    title: typeof tool?.title === "string" && tool.title.trim() ? tool.title.trim().slice(0, MAX_TITLE_LENGTH) : id,
    description: typeof tool?.description === "string" ? tool.description.slice(0, MAX_DESCRIPTION_LENGTH) : "",
    risk,
    inputSchema,
    source: { id: source.id, kind: source.kind, label: source.label }
  };
}

/**
 * Creates a registry that merges the tools of several sources.
 *
 * @param {object} options
 * @param {Array} options.sources          initial sources
 * @param {object} options.executionPolicy  the global execution policy
 * @param {object} options.tracer           optional tool tracer (see tool-trace.mjs)
 */
export function createToolRegistry({ sources = [], executionPolicy = null, tracer = null, observer = null } = {}) {
  const registered = new Map();
  const conflicts = [];

  function register(source) {
    if (!source || typeof source !== "object") throw new TypeError("A tool source must be an object");
    const id = typeof source.id === "string" ? source.id.trim() : "";
    if (!id) throw new TypeError("A tool source must have an id");
    if (!TOOL_SOURCE_KINDS.includes(source.kind)) throw new TypeError(`Unknown tool source kind; expected one of ${TOOL_SOURCE_KINDS.join(", ")}`);
    if (typeof source.list !== "function" || typeof source.invoke !== "function") throw new TypeError("A tool source must provide list() and invoke()");
    if (!registered.has(id) && registered.size >= MAX_SOURCES) throw new Error("Too many tool sources are registered");
    registered.set(id, {
      id,
      kind: source.kind,
      label: typeof source.label === "string" && source.label.trim() ? source.label.trim().slice(0, MAX_TITLE_LENGTH) : id,
      list: source.list,
      invoke: source.invoke
    });
    return { id, kind: source.kind };
  }

  function remove(sourceId) {
    return registered.delete(sourceId);
  }

  function sources_() {
    return [...registered.values()].map(source => ({ id: source.id, kind: source.kind, label: source.label }));
  }

  /**
   * Lists every tool of every source.
   *
   * The first source that publishes an identifier owns it. A later source that
   * publishes the same identifier is skipped and the clash is recorded, so a
   * foreign server can never shadow a built-in tool.
   */
  function list() {
    const seen = new Map();
    const result = [];
    conflicts.length = 0;
    for (const source of registered.values()) {
      let tools = [];
      try {
        tools = source.list();
      } catch {
        tools = [];
      }
      if (!Array.isArray(tools)) tools = [];
      for (const raw of tools.slice(0, MAX_TOOLS_PER_SOURCE)) {
        const tool = normalizeTool(raw, source);
        if (!tool) continue;
        if (seen.has(tool.id)) {
          conflicts.push({ id: tool.id, owner: seen.get(tool.id).source.id, blocked: source.id });
          continue;
        }
        seen.set(tool.id, tool);
        result.push(tool);
      }
    }
    return result;
  }

  function get(id) {
    const normalized = normalizeToolId(id);
    if (!normalized) return null;
    return list().find(tool => tool.id === normalized) || null;
  }

  /**
   * Invokes a tool.
   *
   * The global execution policy is evaluated here for every tool that does not
   * come from the built-in source. The built-in source keeps its own gate, so
   * its behaviour and error messages are untouched.
   *
   * The observer wraps the whole call, the policy gate included, so a call that
   * was denied by the policy still ends with exactly one record.
   */
  async function invoke(id, args = {}, options = {}) {
    if (observer && typeof observer.observe === "function") {
      const tool = get(id);
      return observer.observe({
        toolId: normalizeToolId(id) || String(id || ""),
        source: tool?.source?.kind || "unknown",
        risk: tool?.risk || "unknown",
        sessionId: options?.sessionId,
        taskId: options?.taskId,
        requestId: options?.requestId,
        args
      }, () => invokeTool(id, args, options));
    }
    return invokeTool(id, args, options);
  }

  async function invokeTool(id, args = {}, options = {}) {
    const tool = get(id);
    if (!tool) throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
    const source = registered.get(tool.source.id);
    if (!source) throw Object.assign(new Error("Unknown tool"), { statusCode: 404 });
    const capability = options && typeof options === "object" ? options.capability : undefined;
    // The approval capability is minted inside the server. It is the same
    // token that the built-in destructive tool needs, so a foreign tool can
    // never buy its own approval from the client.
    const approved = hasDeleteCapability(capability)
      || capability === true
      || (capability && typeof capability === "object" && Object.keys(capability).length > 0);
    if (source.kind !== "builtin") {
      // A foreign destructive tool needs the same server issued capability that a
      // built-in destructive tool needs. Without it the call never runs, even
      // when no execution policy is configured.
      if (tool.risk === "destructive" && !approved)
        throw Object.assign(new Error("破坏性工具调用缺少服务端授权凭据（delete-capability），已拒绝执行。"), { statusCode: 403, reason: "missing-capability" });
      if (executionPolicy && typeof executionPolicy.evaluate === "function") {
        const verdict = executionPolicy.evaluate({ risk: tool.risk, approved });
        if (verdict && !verdict.allowed) {
          if (verdict.reason === "approval-required")
            throw Object.assign(new Error("破坏性工具调用缺少服务端授权凭据（delete-capability），已拒绝执行。"), { statusCode: 403, reason: verdict.reason });
          throw Object.assign(new Error(`工具调用被执行策略拒绝（${verdict.reason}），已拒绝执行。`), { statusCode: verdict.statusCode || 403, reason: verdict.reason });
        }
      }
    }
    if (source.kind !== "builtin" && !validateToolArgs(args, tool.inputSchema))
      throw Object.assign(new Error("Invalid tool arguments"), { statusCode: 400 });
    // The source receives the normalized approval flag, so a source that keeps
    // its own gate (the MCP bridge) sees the same approval the registry saw.
    const runOptions = { ...(options && typeof options === "object" ? options : {}), approved: approved === true };
    const run = () => source.invoke(tool.id, args, runOptions);
    // The observer drives the tracer itself, so the tracer is only used here
    // when no observer is present. A call is never traced twice.
    if (!observer && tracer && typeof tracer.trace === "function") {
      const traced = tracer.trace({ toolId: tool.id, risk: tool.risk, sessionId: options?.sessionId, taskId: options?.taskId, requestId: options?.requestId });
      if (traced && typeof traced.run === "function") return traced.run(args, run);
    }
    return run();
  }

  for (const source of sources) register(source);

  return Object.freeze({
    register,
    remove,
    list,
    get,
    invoke,
    sources: sources_,
    conflicts: () => conflicts.map(item => ({ ...item }))
  });
}
