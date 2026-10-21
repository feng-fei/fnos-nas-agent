const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadConfig(env = process.env) {
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 8787);
  const accessToken = env.AGENT_ACCESS_TOKEN || "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
  if (!LOOPBACK_HOSTS.has(host) && accessToken.length < 32) throw new Error("AGENT_ACCESS_TOKEN must be at least 32 characters when binding beyond loopback");
  return Object.freeze({ host, port, accessToken });
}
