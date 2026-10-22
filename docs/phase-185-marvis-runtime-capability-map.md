# Phase 185 · 运行中的 Marvis 能力面（逆向实测）

## 为什么现在做

NAS 上的商店版 Marvis 打上「不装知识库」补丁后已经跑起来了（agent 6161、gateway 10123、app.sock 网关）。**运行中的实例比离线包更好用**：JSBridge 有自描述接口 `window.GetApiList`，可以直接问它「你会哪些能力」，不用猜、不用从压缩后的前端 bundle 里挖。

本文件是实测记录 + 移植取舍，不是抄代码：Marvis 的进程模型（三个守护子进程、本地知识库、自动更新）和我们的定位（零依赖、只读优先、机主手动触发）差得很远，照抄会把它 96MB 的前端和本地推理一起搬进 NAS。

## 探测方式

```bash
S=/vol1/@appcenter/marvis-app/app.sock
# 服务快照
curl -s --unix-socket $S http://localhost/api/services
# 能力自描述
curl -s --unix-socket $S -H 'content-type: application/json' \
  -d '{"namespace":"window","method":"GetApiList"}' http://localhost/api/jsbridge/invoke
# 单能力调用
curl -s --unix-socket $S -H 'content-type: application/json' \
  -d '{"namespace":"MarvisAgent","method":"GetDeviceCondition"}' http://localhost/api/jsbridge/invoke
```

协议：`POST /api/jsbridge/invoke`，入参 `{ namespace, method, params }`，统一返回 `{ code, message, data }`；`code=0` 表示成功，`data` 是**字符串化的 JSON**（二次 `JSON.parse`）。错误码 `-10023` 方法不存在、`-10024` handler 抛异常、`-10025` 请求体非法。

## 服务快照（实测）

`GET /api/services` 返回三个子进程，字段：`name / displayName / status / pid / exitCode / signal / restartCount / executable / args / portFile / lockFile / logFile / port / lastError / startedAt / updatedAt`。

| 服务 | 状态 | 进程 | 关键参数 |
| --- | --- | --- | --- |
| knowledgebase | idle（被补丁摘掉） | — | `--port_file=state/kb_port.ini` |
| agent | running | `MarvisAgent` pid 1039558 | `--work_mode=cloud --port=6161 --workspace_root=@appshare/.../workspace` |
| gateway | running | `MarvisHost` pid 1039545 | `start --port 10123 --env 1 --guid …` |

可借鉴点：`restartCount`、`startedAt/updatedAt`、`portFile`、`lastError` 这组字段比我们现有的「agent 状态」信息量更大，但价值有限（我们的服务是单进程 + 健康检查），暂不搬。

## JSBridge 能力面（55 个方法，13 个命名空间）

| 命名空间 | 方法 | 说明 |
| --- | --- | --- |
| account | login, logout, getLoginState, startLogin, claimLogin, checkLogin, refreshToken | 云端账号（marvis 账号体系） |
| application | GetGuid, GenerateDiagnosisZip | 设备 GUID、诊断包导出 |
| basicInfo | GetRequestEnvInfo | OS/CPU/内存/架构/区域（实测 `debian 12`、`Intel Celeron J4125`、16GB） |
| KVStorage | Read, Write | 按 key 的本地配置存储 |
| MarvisSettings | GetValues, UpdateValues, SetValues, UpdateValue, Restore | 分组设置 + 恢复默认 |
| window | GetApiList, OnForegroundChanged | 能力自描述、前后台事件 |
| AiStarterSettings | HideFileInfo(…), UpdateHideFileInfo, UnHideFileInfo, GetHideFileInfo(s) | 「AI 启动器」的文件隐藏规则 |
| MarvisAgent | GetWorkMode, SetWorkMode, GetDeviceCondition | 工作模式（cloud/local）、**设备能力体检** |
| LocalLLMManager | GetDeviceInfo, RefreshDeviceInfo, GetLlmStatus, HasLocalModelServiceLaunched, StartDownload, StartLocalModelService | 本地模型下载/启停 |
| file | Exists, GetFileInfo, RenameItem, DeleteItem, Delete, ListDirectory | 桌面端文件操作（含 `OpenFolder`） |
| AiStarter | OpenFile, OpenFolder, GetMarvisHomeDir, GetGatewayToken, GetInstalledComponentList | 宿主程序拉起 |
| MarvisUpdateManager | CheckUpdate, StartUpdate, GetCurrentVersion, PauseUpdate, ResumeUpdate, CancelUpdate | 自更新（带暂停/恢复） |
| systemFeedback | GetCommonReportParam, UploadDiagnosis | 反馈与诊断上传 |

## 两个值得学的实现样本

**1) 设备能力体检（`MarvisAgent.GetDeviceCondition`）** —— 不是「给一个分数」，而是**逐维度给出 required 与 passed**：

```json
{"device_condition":2,"check_result":[
 {"dimension":"system_version","passed":true,"required_val":"Linux"},
 {"dimension":"architecture","passed":true,"required_val":"64位"},
 {"dimension":"cpu_core","passed":false,"required_val":"8核"},
 {"dimension":"memory","passed":false,"required_val":"16GB"},
 {"dimension":"disk_type","passed":true,"required_val":"固态硬盘"}]}
```

这个形状对我们直接可用：`system-snapshot` 已经能拿到核数/内存/存储类型，缺的只是「按门槛逐维判定 + required 文案」。移植成本低、对机主有明确意义（能不能在 NAS 上跑本地模型、要不要改用云端）。

**2) 能力自描述（`window.GetApiList`）** —— 前端先问「这个环境下有哪些 API」再决定按钮显隐。我们已经有 `/api/tools`（工具清单），但没有「人话能力表」；这属于可选增强，不是缺口。

## 移植决定

| Marvis 能力 | 我们的对应 | 决定 |
| --- | --- | --- |
| 设备能力体检 | `system-snapshot` + 新增逐维判定 | **移植**（Phase 186） |
| 服务快照字段（restartCount 等） | `GET /api/agent/status` | 不移植：单进程服务没有重启计数语义 |
| KVStorage | `runbook-store` / `knowledge-base` | 已具备，不重复造 |
| file 命名空间 | `file-browser` + `file-manager` | 已具备，且更严格（根隔离、符号链接拒绝） |
| MarvisSettings | `model-provider-store` + 设置表单 | 已具备 |
| LocalLLMManager（下载/启停本地模型） | 无 | **不移植**：违背零依赖与轻量定位，NAS 上也没有可用算力 |
| MarvisUpdateManager（自更新） | 无 | 不移植：FPK 由应用中心更新，自更新等于绕开机主的更新通道 |
| AiStarter / window / OnForegroundChanged | 无 | 不移植：桌面端语义（窗口前后台、拉起 .exe） |
| systemFeedback（诊断上传） | `/api/diagnostics/report` | 不移植上传，只保留本地导出 |
| 知识库（KB 子进程） | `document-index`（轻量索引） | 不移植：KB 在 4 核 J4125 上直接 SIGILL（见 Phase 186 之前的排障记录） |

## 结论

运行中的 Marvis 是一次性「活体样本」：**确认了它没有隐藏的本地 API 大礼包**（除云端账号与本地模型运行时外，其余都是我们已具备或明确不做的能力），唯一值得立即移植的是**逐维度设备体检**。这也解释了为什么此前两轮评估的结论稳定：它强在桌面执行 + 腾讯云模型，不强在 NAS 侧的机主工具链。
