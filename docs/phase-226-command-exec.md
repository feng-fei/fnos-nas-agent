# Phase 226 — 确认式命令执行（system.command）

> 操作者决策：智能助手应能"运行命令"，对风险命令过滤 + 确认后执行（方案 C）。
> 本阶段在既有安全基础设施上落地该能力，不引入任何新的执行语义。

## 工具

- `system.command`（**destructive**）：在 NAS 上执行一条 shell 命令。
  执行链 = 静态安全扫描（Phase 145 扫描器）→ 一次性人工确认（202 审批流）→
  `/bin/bash -c <command>`（参数数组，无 shell:true）。
- `system.command-check`（read-only）：对命令做静态扫描预检，返回分级结论，不执行。

## 安全不变量

1. **能力门**：invoke 必须携带审批服务确认时注入的服务端能力令牌
   （`DELETE_CAPABILITY`），否则 403——与 files.delete 完全同构；
2. **扫描硬门**：`scanCommand` verdict "block"（rm -rf、dd、mkfs、提权、
   下载管道执行、密钥外泄等 Phase 145 规则）直接 403 拒绝并列出规则摘要，永不执行；
3. **提案预扫**：agent 路径的审批请求先过扫描（`requestApprovalWithCommandScan`），
   block 命令在创建确认请求之前就失败，对话直接给出可读拒绝原因；
4. 固定可执行文件 + 参数数组 + 最小环境变量（PATH/HOME/LANG/LC_ALL）+ cwd=/；
5. 串行执行（同一时刻至多一条）、超时 20s、maxBuffer 1MB、stdout 32KB/stderr 8KB 截断；
6. 非零退出与超时是结构化结果（ok/exitCode/timedOut），不是异常泄漏；
7. 全局执行策略（只读模式/紧急停机）由 tool-registry 既有门覆盖；
8. 输出不落盘、不进审计参数；审计仍只记路由与状态。

## 接线

- `command-exec.mjs`：工具源（builtin kind），注册进 tool-registry；
- 规则直连意图：`运行命令：<command>` 直接产生单个破坏性提案（免模型）；
- agent-core：规则路径的审批/执行拒绝现在也被捕获并结构化返回
  （COMMAND_BLOCKED 的可读原因透传到对话）；
- 模型提示词更新：明确 system.command 的"扫描 + 人工确认"语义，指导模型
  优先使用专用工具、不要提议会被规则拒绝的命令；
- UI：对话欢迎语/助手状态/安全边界声明同步更新。

## 测试（`tests/phase-226-command-exec.test.mjs`，10 例全过）

无能力拒绝、block 拒绝不执行、bash -c 参数数组与最小环境、非零退出结构化、
超时结构化、输出截断、预检不执行、agent-core 提案→审批（不执行）、
扫描拒绝信息透传。另回归 phase-8/ui2-console。
