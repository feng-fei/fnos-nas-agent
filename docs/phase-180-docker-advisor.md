# Phase 180 — Docker 容器运维建议（只读）

## 背景

容器是 fnOS 上最常用的部署方式，也是最容易积累「看不见的债」的地方：资源限额没设、日志无限增长、compose 依赖写错、端口撞车、孤儿卷残留、配置漂移。清单里的 APP02 / APP03 / APP04 / APP08 / APP13 / APP14 都指向同一件事——**先看清楚，再决定动不动手**。本阶段交付一律只读的建议引擎。

## 新增代码

| 文件 | 说明 |
| --- | --- |
| `apps/fnos-nas-agent/app/docker-advisor.mjs` | 7 个分析函数 + 报告聚合 + 只读检查清单 |
| `tests/phase-180-docker-advisor.test.mjs` | 17 个用例 |
| `apps/fnos-nas-agent/app/server.mjs` | `GET /api/docker/advice`（审计路由名 `docker.advice`） |

## 导出 API

```js
analyzeContainerResources({ containers })   // → { items[], summary{unlimited,overLimit,missing}, findings[] }
analyzeContainerLogs({ containers, logs })   // → { items[], summary{unbounded,large,suspicious}, findings[] }
analyzeComposeDependencies({ services })     // → { services[], missing[], cycles[], findings[] }
findOrphanResources({ containers, volumes, networks, images })
                                             // → { orphans[], summary{volumes,networks,images}, findings[] }
diagnosePortConflicts({ containers })        // → { conflicts[], summary{duplicates} }
diffConfiguration({ desired, actual })       // → { changed[], added[], removed[], summary }
buildDockerReport(input)                     // → { generatedAt, sections[], summary, findings[], readOnly: true }
```

常量：`DOCKER_ADVISOR_SECTIONS`、`MAX_LOG_LINES`（2000）、`MAX_DIFF_LINES`（500）、`DEFAULT_MEMORY_LIMIT_MB`（4096）、`ORPHAN_REASON`、`DOCKER_READ_ONLY_CHECKS`。

## 语义

- **只建议、不执行**。模块没有任何 docker 客户端、socket 或子进程调用；`buildDockerReport` 的返回固定带 `readOnly: true`，每条建议都附一条对应的人工只读核对命令（`docker ps`、`docker stats --no-stream`、`docker volume ls`、`docker logs --tail`）。
- **未采集保持 unknown**。某个分区没有数据时该分区 `status: "unknown"`、`collected: false`，绝不被渲染成「正常」。
- **资源判定以限额是否缺失优先**。没有 `memoryLimitMb` 的容器先算「未设限额」，再谈是否超限；`DEFAULT_MEMORY_LIMIT_MB` 只作为建议值出现，不会被当成实际值。
- **日志按行数与体积双阈值**。`MAX_LOG_LINES` 截断分析窗口（防大文件把服务拖死），越界只统计不抛错。
- **孤儿资源给理由**。`ORPHAN_REASON` 枚举「无容器引用」「镜像无标签」「网络无连接」等，判定依据写在返回里，便于人工复核。
- **配置漂移只报告差异**。`diffConfiguration` 输出 `changed` / `added` / `removed` 三段，不做「自动对齐」。

## HTTP 接口

```
GET /api/docker/advice   → buildDockerReport(readDockerInventory())
```

`readDockerInventory()` 复用既有的 trim-cli 只读能力（`docker.container.ls-all` 等），采集失败时对应分区为 `unknown`。

## 验证

```
node --test tests/phase-180-docker-advisor.test.mjs   # 17 tests / 17 pass
node scripts/check-release-gates.mjs                  # exit 0
```

## 遗留

- 日志分析接受已采集的行数组，没有内置 `docker logs` 调用。
- 配置漂移需要调用方同时提供期望配置与实际配置，暂不解析 compose YAML。
- 清单对应项：APP02 / APP03 / APP04 / APP08 / APP13 / APP14。
