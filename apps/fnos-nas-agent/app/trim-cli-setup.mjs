import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";

function invalid(message) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function normalizeHost(value) {
  if (typeof value !== "string") invalid("host must be a hostname or IP address");
  let host = value.trim();
  if (!host || host.length > 253 || /[\s\/\\?#@'\x00-\x1f\x7f]/.test(host) || host.startsWith("-")) {
    invalid("host must be a valid hostname or IP address without a protocol, port, or path");
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (isIP(host)) return host;
  if (host.includes(":")) invalid("IPv6 addresses must be valid IP literals; do not include a port");
  if (host.length > 253 || !host.split(".").every(label =>
    label.length >= 1 && label.length <= 63 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
  )) invalid("host must be a valid DNS hostname or IP address");
  return host;
}

function quoteShellArg(value) {
  const text = String(value);
  if (text.includes("\0") || /[\r\n]/.test(text)) invalid("command argument contains a control character");
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

export function createTrimCliLoginCommand({
  host, port, scheme, allowSelfSigned = false, flow = "login",
  binaryPath, dataDir, profile = "home", serviceUser
} = {}) {
  const normalizedHost = normalizeHost(host);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) invalid("port must be an integer from 1 to 65535");
  if (scheme !== "https" && scheme !== "http") invalid("scheme must be https or http");
  if (scheme === "http" && allowSelfSigned) invalid("self-signed TLS is only valid with HTTPS");
  if (typeof allowSelfSigned !== "boolean") invalid("allowSelfSigned must be a boolean");
  if (flow !== "login" && flow !== "refresh") invalid("flow must be login or refresh");
  if (typeof profile !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) invalid("invalid CLI profile");
  if (typeof serviceUser !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(serviceUser)) invalid("service user is unavailable");
  if (typeof binaryPath !== "string" || !isAbsolute(binaryPath) || binaryPath.includes("\0")) invalid("official CLI binary path is unavailable");
  if (typeof dataDir !== "string" || !isAbsolute(dataDir) || dataDir.includes("\0")) invalid("private Agent data directory is not configured");

  const args = [
    "sudo", "-u", serviceUser, "--", "env",
    "HOME=" + dataDir,
    "XDG_CONFIG_HOME=" + join(dataDir, ".config"),
    binaryPath,
    "--profile", profile,
    "--host", normalizedHost,
    "--port", String(port),
    "--scheme", scheme
  ];
  if (scheme === "http") args.push("--allow-insecure-http");
  if (scheme === "https" && allowSelfSigned) args.push("--tls-insecure");
  args.push("login");
  if (flow === "refresh") args.push("--refresh");
  args.push("--no-open");
  return args.map(quoteShellArg).join(" ");
}

export function validateTrimCliLoginInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("request body must be an object");
  const allowed = new Set(["host", "port", "scheme", "allowSelfSigned", "flow"]);
  if (Object.keys(input).some(key => !allowed.has(key))) invalid("unknown login command option");
  // Reuse the same validation as the command builder without trusting caller-supplied paths.
  normalizeHost(input.host);
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) invalid("port must be an integer from 1 to 65535");
  if (input.scheme !== "https" && input.scheme !== "http") invalid("scheme must be https or http");
  if (input.allowSelfSigned !== undefined && typeof input.allowSelfSigned !== "boolean") invalid("allowSelfSigned must be a boolean");
  if (input.scheme === "http" && input.allowSelfSigned === true) invalid("self-signed TLS is only valid with HTTPS");
  if (input.flow !== undefined && input.flow !== "login" && input.flow !== "refresh") invalid("flow must be login or refresh");
  return Object.freeze({
    host: input.host,
    port: input.port,
    scheme: input.scheme,
    allowSelfSigned: input.allowSelfSigned === true,
    flow: input.flow || "login"
  });
}
