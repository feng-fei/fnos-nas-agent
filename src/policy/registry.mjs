const tools = new Map();

export function registerTool(tool) {
  if (!tool || typeof tool.name !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(tool.name)) throw new TypeError("Tool name must be a lowercase identifier");
  if (typeof tool.description !== "string" || typeof tool.risk !== "string") throw new TypeError("Tool requires description and risk");
  if (tool.risk !== "read-only") throw new Error("Only read-only tools may be registered in the initial skeleton");
  if (typeof tool.run !== "function") throw new TypeError("Tool requires a run function");
  if (tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
  tools.set(tool.name, Object.freeze({ ...tool }));
}
export function listTools() {
  return [...tools.values()].map(({ name, description, risk }) => ({ name, description, risk }));
}
export async function runTool(name, input = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error("Unknown tool");
  return tool.run(input);
}
