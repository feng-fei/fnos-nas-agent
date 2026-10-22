# Phase 139 — 反向代理与部署文档

本阶段把部署相关的真实行为写进文档，并提供一份一致性测试，防止文档再次与源码漂移。

- `.env.example` 按 `apps/fnos-nas-agent/app/server.mjs` 的真实行为重写：真实的变量名、真实的默认值、逐项注释。
- `docs/security.md` 新增「反向代理与 TLS 终止」一节，说明同源校验、转发头信任与 Cookie `Secure` 的关系。
- 本文给出 fnOS 场景下的 nginx 反代、fnOS 门户反代、直连部署三种示例，以及一份排查清单。
- `tests/phase-139-environment-and-proxy-docs.test.mjs` 只读仓库文件，断言上述文档与真实变量一致。

## 真实行为速查

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听所有网卡。改成 `127.0.0.1` 可只监听本机。 |
| `PORT` | `18787` | 解析顺序：`PORT` → `TRIM_SERVICE_PORT` → `18787`。 |
| `AGENT_DATA_DIR` | 未设置 | 持久化目录。未设置就没有持久化目录，审计日志不可用，首启 setup 无法完成。 |
| `AGENT_EXECUTION_MODE` | `normal` | `normal` / `read-only` / `halted`。优先级低于 `<AGENT_DATA_DIR>/execution-mode.json`。 |
| `AGENT_TASK_TIMEOUT_MS` | `300000` | 单任务预算，上限 `3600000`，`0` 表示不超时；非法值回落默认并打日志。 |
| `AGENT_TRUST_PROXY` | `0` | 为 `1` 时才信任 `X-Forwarded-Proto` / `X-Forwarded-Host`。 |
| `TRIM_CLI_PATH` | 未设置 | 官方 `trim-cli` 路径；未设置时 CLI 工具不可用。 |
| `TRIM_CLI_PROFILE` | `home` | 官方 CLI 使用的 profile 名。 |

服务只读取 `process.env`，**不会**自动加载 `.env` 文件。用 `node --env-file=.env` 启动，
或在服务管理器里导出变量。fnOS 的打包启动脚本 `apps/fnos-nas-agent/cmd/main` 会显式设置
`AGENT_DATA_DIR=$TRIM_PKGVAR`、`HOST=0.0.0.0`、`PORT=$APP_PORT`，其余变量从它自己的进程环境继承。

首启 setup code 不在任何环境变量里。服务在还没有配置密码时会把一次性 setup code 打到终端或服务日志：

```
fnos-nas-agent first-run setup code: <code>
```

在 fnOS 上这个日志是 `$TRIM_PKGVAR/agent.log`。读到这个码之后在浏览器里完成首次设置，
密码写入后该文件会被删除。

## 场景一：直连部署（不使用反向代理）

局域网内部使用，控制台跑在明文 HTTP 上。这种部署**不要**设置 `AGENT_TRUST_PROXY`。

```bash
# 1. 准备持久化目录（必须，否则首启 setup 不可用）
export AGENT_DATA_DIR=/var/lib/fnos-nas-agent
mkdir -p "$AGENT_DATA_DIR"

# 2. 只监听本机时用 HOST=127.0.0.1；
#    需要手机同网段直接访问时保持默认的 0.0.0.0。
export HOST=0.0.0.0
export PORT=18787

# 3. 启动
node apps/fnos-nas-agent/app/server.mjs
```

systemd 单元示例：

```ini
[Unit]
Description=fnos-nas-agent
After=network.target

[Service]
Type=simple
Environment=HOST=0.0.0.0
Environment=PORT=18787
Environment=AGENT_DATA_DIR=/var/lib/fnos-nas-agent
Environment=AGENT_EXECUTION_MODE=normal
Environment=AGENT_TASK_TIMEOUT_MS=300000
Environment=AGENT_TRUST_PROXY=0
Environment=TRIM_CLI_PROFILE=home
ExecStart=/usr/bin/node /opt/fnos-nas-agent/apps/fnos-nas-agent/app/server.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

浏览器打开 `http://<NAS-IP>:18787`，从服务日志里取 setup code 完成首次设置。

> 明文 HTTP 的风险：登录密码、setup code 与会话 Cookie 都会在网络中明文传输。
> 详见 [Security Model — 反向代理与 TLS 终止](security.md#反向代理与-tls-终止-reverse-proxy-and-tls-termination)。

## 场景二：nginx 反向代理（fnOS 主机自建 nginx）

前提：Agent 只监听本机或只对反代可见（`HOST=127.0.0.1`），并设置 `AGENT_TRUST_PROXY=1`。

nginx 站点配置：

```nginx
server {
    listen 443 ssl;
    server_name nas.example.com;

    ssl_certificate     /etc/nginx/ssl/nas.example.com.crt;
    ssl_certificate_key /etc/nginx/ssl/nas.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:18787;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # Agent 的控制台不使用 WebSocket，只有普通的 HTTP 请求/响应，
        # 因此不需要 Upgrade / Connection 头，也不需要 WebSocket 升级配置。
    }

}

server {
    listen 80;
    server_name nas.example.com;

    location / {
        return 301 https://$host$request_uri;
    }
}
```

要点：

- `proxy_set_header X-Forwarded-Proto $scheme;` 必须有。反代终止 TLS 后 Agent 只能看到明文 http，
  没有这个头，服务端会认为外部来源是 `http://nas.example.com`，浏览器发来的
  `Origin: https://nas.example.com` 就会不匹配，所有写操作返回 403。
- `proxy_set_header X-Forwarded-Host $host;` 必须有，且要与浏览器地址栏里的主机名一致。
- `proxy_set_header Host $host;` 用于让 Agent 拿到正确的主机名。
- 不需要 `proxy_set_header Upgrade` / `Connection`，Agent 没有 WebSocket 通道。
- 不要把 `X-Forwarded-Proto` 交给客户端决定，用 `$scheme` 这类由反代自己算出的值。

Agent 侧的环境变量：

```bash
export HOST=127.0.0.1
export PORT=18787
export AGENT_DATA_DIR=/var/lib/fnos-nas-agent
export AGENT_TRUST_PROXY=1
node apps/fnos-nas-agent/app/server.mjs
```

在 fnOS 上，打包启动脚本 `cmd/main` 会把自己的进程环境原样传给服务进程，
所以只要在启动它之前导出 `AGENT_TRUST_PROXY=1` 即可：

```bash
# /etc/profile.d/fnos-nas-agent.sh
export AGENT_TRUST_PROXY=1
```

或在一个自定义的启动包装脚本里：

```bash
#!/bin/bash
export AGENT_TRUST_PROXY=1
exec /var/apps/fnos-nas-agent/cmd/main start
```

注意 `AGENT_TRUST_PROXY=1` 的安全前提：**Agent 端口不能被绕过反代直连**。
一旦有不受信任的客户端能直接连到 18787，它就能伪造 `X-Forwarded-Host`，
把同源校验的基准换成自己控制的来源。把 `HOST` 设为 `127.0.0.1` 是最直接的做法。

## 场景三：fnOS 门户反向代理

fnOS 门户自带反向代理能力（应用管理 / 反向代理），把外部的 https 入口指向 NAS 上的
`http://127.0.0.1:18787`。配置要点与 nginx 场景一致：

| 门户字段 | 取值 |
| --- | --- |
| 外部协议 | `https` |
| 外部域名/端口 | `nas.example.com`（或 `https://<NAS-IP>:8443`） |
| 后端协议 | `http` |
| 后端地址 | `127.0.0.1:18787` |
| 转发头 | 透传 `X-Forwarded-Proto`（值 `https`）与 `X-Forwarded-Host`（值等于外部域名） |

同时要在 Agent 侧设置 `AGENT_TRUST_PROXY=1`，并确保门户反代直连的是本机回环地址。

如果门户只支持“路径前缀”式的反代（例如 `https://nas.example.com/agent/`），请注意：
Agent 的页面与接口都挂在根路径上（`/`、`/api/...`、`/ui/...`），**不支持**带基础路径前缀运行。
这种场景请改用一个独立子域名（整站根路径反代），或者在门户前面再加一层能重写路径的 nginx。

## 排查清单

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 写操作全部 `403 Forbidden origin` | `Origin` 与服务端算出的外部来源不一致：缺 `X-Forwarded-Proto` / `X-Forwarded-Host`，或 `AGENT_TRUST_PROXY` 没开，或外部域名与 `X-Forwarded-Host` 不一致 | 补齐两个 `proxy_set_header`，设 `AGENT_TRUST_PROXY=1`，核对主机名 |
| 登录后 Cookie 没有 `Secure` | 服务端认为这不是 https：`AGENT_TRUST_PROXY=0`，或 `X-Forwarded-Proto` 缺失/不是 `https` | 同上；反代下必须用 https + `Secure` Cookie |
| 登录后立刻掉线 / Cookie 反复失效 | 反代与浏览器主机名不一致，Cookie 的域或 `SameSite=Strict` 判定失败 | 让 `Host`、`X-Forwarded-Host` 与外部地址完全一致 |
| 首次打开提示需要 setup code 但输入后失败 | setup code 只在服务日志里，且只认当下这一个值；密码设置成功后该文件已被删除 | 从 `$TRIM_PKGVAR/agent.log` 重新取码；确认没有第二个实例在跑 |
| 首次设置返回 `App data directory is not configured` | `AGENT_DATA_DIR` 没设置 | 设置它并重启服务 |
| 页面能打开但接口 404 | 用了路径前缀反代（`/agent/` 之类） | 改用独立子域名的根路径反代 |
| 反代后一直 `502 Bad Gateway` | 后端端口不对或 `HOST=127.0.0.1` 时反代也在别的网络命名空间 | 确认 `proxy_pass` 的地址与端口，并确认 Agent 在监听 |

## 相关文档

- [Security Model](security.md) — 反向代理与 TLS 终止、同源校验、Cookie 策略
- [Phase 131 — Server hardening](phase-131-server-hardening.md) — 认证、限流、状态文件加固
- [Phase 126 — Execution Policy](phase-126-execution-policy.md) — `AGENT_EXECUTION_MODE` 与状态文件优先级
- [Private remote access](private-remote-access.md) — 远程访问的背景
