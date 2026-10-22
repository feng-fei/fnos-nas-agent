const FAILURE_RULES = [
  {
    kind: "scope_missing", statusCode: 403, connectionStatus: "scope_missing", authenticated: null,
    message: "当前 OAuth profile 缺少此只读模块所需的授权范围。",
    nextAction: "通过官方 CLI 交互式登录重新授权所需模块 scope；仅刷新 token 无法增加 scope。"
  },
  {
    kind: "login_required", statusCode: 401, connectionStatus: "auth_required", authenticated: false,
    message: "官方 CLI 尚未完成 OAuth 登录。",
    nextAction: "先按「授权引导」页生成的命令在终端执行官方 CLI 的 login，完成浏览器授权后再运行连接检测。"
  },
  {
    kind: "auth_required", statusCode: 401, connectionStatus: "auth_required", authenticated: false,
    message: "官方 CLI 授权已失效或需要重新登录。",
    nextAction: "先在授权引导中尝试官方 CLI 的交互式 refresh；若仍失败，重新执行 login 并完成浏览器授权。"
  },
  {
    kind: "tls_error", statusCode: 502, connectionStatus: "tls_error", authenticated: null,
    message: "与 NAS 建立 HTTPS 连接时证书校验失败。",
    nextAction: "检查 NAS 主机名、证书有效期和信任链；仅在确认设备可信时，才选择自签名证书选项后重新授权。"
  },
  {
    kind: "timeout", statusCode: 504, connectionStatus: "timeout", authenticated: null,
    message: "官方 CLI 请求超时。",
    nextAction: "检查 NAS 地址、端口和网络连通性，再重试只读连接检测。"
  },
  {
    kind: "network_error", statusCode: 502, connectionStatus: "network_error", authenticated: null,
    message: "无法连接到 NAS API。",
    nextAction: "检查 NAS 是否在线、地址和端口是否正确，以及 Agent 所在设备到 NAS 的网络路由。"
  },
  {
    kind: "rate_limited", statusCode: 429, connectionStatus: "rate_limited", authenticated: null,
    message: "NAS API 暂时限制了请求频率。",
    nextAction: "稍后再重试；不要连续重复提交请求。"
  },
  {
    kind: "profile_unavailable", statusCode: 503, connectionStatus: "profile_unavailable", authenticated: null,
    message: "官方 CLI 无法读取或更新当前 OAuth profile。",
    nextAction: "检查 Agent 私有数据目录的所有者和权限；请确保登录命令与 Agent 使用同一运行账户。"
  },
  {
    kind: "executable_missing", statusCode: 503, connectionStatus: "not_ready", authenticated: null,
    message: "官方 CLI 执行文件已不可用。",
    nextAction: "重新审核并安装当前平台的官方 fnOS CLI，然后启用对应 Skill。"
  },
  {
    kind: "permission_denied", statusCode: 503, connectionStatus: "profile_unavailable", authenticated: null,
    message: "系统拒绝执行官方 CLI 或访问其配置目录。",
    nextAction: "检查 CLI 文件权限和 Agent 私有数据目录所有权；不要通过放宽到全局可写来解决。"
  },
  {
    kind: "output_too_large", statusCode: 502, connectionStatus: "failed", authenticated: null,
    message: "官方 CLI 返回的结果超过了 Agent 的安全输出上限。",
    nextAction: "缩小查询范围或减少返回条数，再重试。"
  }
];

const BY_KIND = new Map(FAILURE_RULES.map(item => [item.kind, item]));

export function trimCliFailureKinds() {
  return FAILURE_RULES.map(({ kind, statusCode, connectionStatus, message, nextAction }) => ({
    kind, statusCode, connectionStatus, message, nextAction
  }));
}

export function classifyTrimCliFailure(error) {
  const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  // Inspect only to classify. Never return, persist, or log these potentially secret-bearing strings.
  const diagnostic = [error?.message, error?.stderr, error?.stdout]
    .filter(value => typeof value === "string")
    .join("\n")
    .slice(0, 16_384)
    .toLowerCase();

  let kind;
  if (["ETIMEDOUT", "ETIME", "ESOCKETTIMEDOUT"].includes(code) || error?.killed) kind = "timeout";
  else if (["ENOENT", "TRIM_CLI_UNAVAILABLE"].includes(code)) kind = "executable_missing";
  else if (["EACCES", "EPERM"].includes(code)) kind = "permission_denied";
  else if (["ENOBUFS"].includes(code) || /maxbuffer|output.{0,24}too large|buffer length exceeded/.test(diagnostic)) kind = "output_too_large";
  else if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code) ||
    /self.signed certificate|certificate has expired|unable to verify.*certificate|certificate verify failed|tls handshake|certificate.*hostname/.test(diagnostic)) kind = "tls_error";
  else if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EPIPE"].includes(code) ||
    /network is unreachable|no route to host|could not resolve host|name or service not known|connection refused|connection reset by peer|failed to fetch|network error/.test(diagnostic)) kind = "network_error";
  else if (/\b(?:insufficient|missing|required|not granted|not authorized)\s+(?:oauth\s+)?scope\b|\bscope\b.{0,60}\b(?:insufficient|missing|required|not granted|not granted to this client)\b/.test(diagnostic)) kind = "scope_missing";
  else if (/\b(?:401|unauthorized|authentication required|not authenticated|login required|token expired|expired access token|refresh token.{0,30}(?:expired|invalid|failed)|authorization.{0,30}expired|please login)\b|登录已过期|需要重新登录/.test(diagnostic)) kind = "auth_required";
  else if (/\b(?:run login first|login first|not logged in|no saved (?:proxy )?session|saved (?:proxy )?session is required|session is required|must (?:be )?logged in)\b|尚未登录|请先登录/.test(diagnostic)) kind = "login_required";
  else if (["429"].includes(code) || /\b429\b|rate limit exceeded|too many requests|请求频率过高/.test(diagnostic)) kind = "rate_limited";
  else if (/profile.{0,60}(?:not found|corrupt|invalid)|session store.{0,40}(?:unwritable|not writable|permission denied)|config(?:uration)? file.{0,40}permission denied/.test(diagnostic)) kind = "profile_unavailable";
  else kind = "unexpected";

  if (kind === "unexpected") {
    return Object.freeze({
      kind, statusCode: 502, connectionStatus: "failed", authenticated: null,
      message: "官方 CLI 请求失败，详细输出已隐藏。",
      nextAction: "先检查连接配置和 profile 状态，再重新运行只读连接检测。"
    });
  }
  return Object.freeze({ ...BY_KIND.get(kind) });
}

export function createTrimCliConnectionHealth({ now = () => Date.now(), ttlMs = 5 * 60_000 } = {}) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60 * 60_000) throw new TypeError("invalid ttlMs");
  let state = {
    connectionStatus: "not_tested",
    authenticated: null,
    checkedAt: null,
    checkedAtMs: 0,
    command: null,
    errorCategory: null,
    message: "尚未检测官方 CLI 连接。",
    nextAction: "完成交互式 OAuth 登录后，运行只读连接检测。"
  };

  return Object.freeze({
    success(command) {
      const checkedAtMs = now();
      state = {
        connectionStatus: "connected",
        authenticated: true,
        checkedAt: new Date(checkedAtMs).toISOString(),
        checkedAtMs,
        command,
        errorCategory: null,
        message: "最近一次只读请求成功，CLI 授权与 API 连通性已验证。",
        nextAction: "如要确认当前连接仍然有效，可重新运行连接检测。"
      };
      return this.snapshot();
    },
    failure(failure) {
      const checkedAtMs = now();
      state = {
        connectionStatus: failure.connectionStatus,
        authenticated: failure.authenticated,
        checkedAt: new Date(checkedAtMs).toISOString(),
        checkedAtMs,
        command: state.command,
        errorCategory: failure.kind,
        message: failure.message,
        nextAction: failure.nextAction
      };
      return this.snapshot();
    },
    snapshot(available = true) {
      const age = state.checkedAtMs ? now() - state.checkedAtMs : Infinity;
      if (!available) {
        return {
          connectionStatus: "not_ready", authenticated: null, checkedAt: state.checkedAt,
          command: null, errorCategory: null,
          message: "官方 CLI 尚未安装或不可执行。",
          nextAction: "安装并启用官方 fnOS Skill 中与当前平台匹配的 CLI。"
        };
      }
      if (age > ttlMs) {
        return {
          connectionStatus: state.checkedAt ? "stale" : "not_tested",
          authenticated: null,
          checkedAt: state.checkedAt,
          command: state.command,
          errorCategory: null,
          message: state.checkedAt ? "上次连接检测已过期，当前状态未知。" : state.message,
          nextAction: "重新运行只读连接检测以更新状态。"
        };
      }
      const { checkedAtMs, ...publicState } = state;
      return { ...publicState };
    }
  });
}
