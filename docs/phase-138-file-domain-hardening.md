# Phase 138 — File Domain Hardening

本阶段收尾文件域（浏览 / 搜索 / 上传 / 写入 / 官方 CLI 读）剩余的实现逻辑缺陷。改动范围限定在
`apps/fnos-nas-agent/app/file-browser.mjs`、`file-manager.mjs`、`read-only-tools.mjs`、`trim-cli-adapter.mjs`，
配套 `tests/phase-138-file-domain-hardening.test.mjs`。不引入任何运行时依赖，只使用 Node 内置模块。

本阶段在 lead 已打的补丁之上继续修改，未回退以下已有加固：

- `file-manager.mjs`：`ERRNO_STATUS` / `ERRNO_MESSAGE` / `failNative(error)` 映射，`mkdir` / `rename` / `delete`
  的原生错误码转换为可执行的 HTTP 状态码，`operateBatch` 失败项带 `statusCode`。
- `file-browser.mjs`：排序增加 `compareNames` 确定性 tiebreaker（Unicode 归一化不同的同名条目不再依赖 readdir 原始顺序）。
- `server.mjs`：文件操作 catch 白名单扩到 `[400,403,404,409,413,415,503,507]`（本阶段未改动该文件）。

本文件描述第一轮（8 项，已合入）与第二轮（16 项，本阶段）全部缺陷的修复。

---

## 1. 背景与问题量化表

| 编号 | 严重度 | 位置（修复前） | 问题 | 量化 | 状态 |
| --- | --- | --- | --- | --- | --- |
| High 1 | 高 | `file-manager.mjs` `operate()` rename/move 分支 | `ensureAbsent` + `fs.rename` 非原子，POSIX rename 静默覆盖已存在目标 | 竞态窗口内目标内容被销毁，且工具描述承诺的"不覆盖已有目标"不成立 | 已修 |
| High 2 | 高 | `file-manager.mjs` `createText` / `upload` 的 catch | 原生 fs 错误未经 `failNative` 映射 | ENOSPC/EDQUOT/EACCES/EPERM 一律变 500，客户端无法区分"磁盘满"与"服务端故障" | 已修 |
| High 3 | 高 | `read-only-tools.mjs` `files.list` schema / invoke | 工具不暴露 `offset` / `sort` / `query` / `type` | 目录 > 200 项时 agent 拿得到 `totalEntries` 却取不到第 2 页，也没法排序/过滤 | 已修 |
| Medium 4 | 中 | `file-browser.mjs` `search()` | 单目录截断即 `break` 整个 BFS | 一个超大目录就让其它目录的匹配项全部丢失 | 已修 |
| Medium 5 | 中 | `read-only-tools.mjs` Base64 判定 | 非规范 Base64 被误判为容量错误 | `Buffer.from("QR==","base64")` 忽略尾部非规范位，回环比较不一致即被判 413 | 已修（第一轮已拆分，本阶段补测试固化） |
| Medium 6 | 中 | `trim-cli-adapter.mjs` `runReadOnly` | 空输出分支提前 `return`，跳过 `health.success(id)` | 退出码 0 但无输出时连接健康永远停在 `not_tested` | 已修（第一轮已补 `health.success`，本阶段统一返回结构） |
| Medium 7 | 中 | `file-manager.mjs` 临时文件 / `file-browser.mjs` 列表 | 临时文件建在目标目录内，崩溃后残留并出现在目录列表 | 目录里出现 `.fnos-text-*` / `.fnos-upload-*` 之类的内部文件 | 已修 |
| Medium 8 | 中 | `file-manager.mjs` 回滚 `fs.rename(...).catch(() => {})` | 回滚失败被静默吞掉 | 文件已在新位置，而调用方收到"失败"，不知文件在哪 | 已修 |
| Medium 9 | 中 | `file-browser.mjs` 列表 / `file-manager.mjs` `resolveExisting` | 卷内符号链接既不出现在列表里，也无法被任何接口删除 | 用户无法看到、也无法清理卷内链接 | 部分修（见 §2.9） |
| Medium 10 | 中 | `server.mjs` `/api/files/upload` | 上传接口没有累计上限或频率限制 | 单会话可连续上传直到磁盘写满；对比 `/api/files/checksum` 有 `fileChecksumLimiter` | 未做（需 server 层，见 §4） |
| Low 11 | 低 | `file-browser.mjs` `list()` 的 `slice(offset, offset+limit)` | 偏移分页在目录内容变化后跳过条目（无快照/游标） | 翻页期间新增/删除条目会导致漏项或重复 | 部分修（漂移可检测，见 §2.11） |
| Low 12 | 低 | `file-browser.mjs` 两处 `toLocaleLowerCase()` | 大小写折叠依赖运行时 locale | 土耳其语环境下 `"I".toLocaleLowerCase()` 折叠成 `ı`，命中集合随机器 locale 变化 | 已修 |
| Low 13 | 低 | `file-manager.mjs` `operateBatch` | 四种 403 折叠成同一句"操作路径不在允许范围内" | 越界 / 符号链接 / 根目录保护 / 缺少删除凭据，调用方无法区分 | 已修 |
| Low 14 | 低 | `trim-cli-adapter.mjs` `catch { data = stdout.slice(0, 64_000) }` | 非 JSON 输出被静默截断且无标记 | 截断后的文本与完整文本无法区分 | 已修 |
| Low 15 | 低 | `trim-cli-adapter.mjs` `photos.search` | keyword 未拦截以 `-` 开头的值 | `--all` 会被 CLI 当成选项而不是搜索词 | 已修 |
| Low 16 | 低 | `file-manager.mjs` `preview()` | 用 NUL 字节判定二进制，UTF-16 文本被误判；返回值不含 path | UTF-16 文档预览恒为 415；调用方拿不到文件路径 | 已修 |
| Low 17 | 低 | `read-only-tools.mjs` `files.move` | risk 标注为 `write`，实际具备删除语义 | 只读模式下允许 `files.move` 移走源文件 | 未做（既有测试锁定，见 §4） |

第一轮已合入、本阶段未回退的 8 项：偏移分页透传、trim-cli 空输出记成功、搜索单目录截断、符号链接 403 文案、
`publishStagedFile` 硬链接回退、Base64 错误码口径、目录计数口径统一、`getRoots` 两处排序统一。

---

## 2. 逐条修复说明

### 2.1 High 1 — rename / move 不再覆盖已存在的目标

| 段落 | 内容 |
| --- | --- |
| 位置 | `file-manager.mjs` `operate()` 的 `rename` / `move` 分支；工具描述见 `read-only-tools.mjs` 的 `files.rename` / `files.move`（"不覆盖已有目标"） |
| 触发条件 | 目标名在 `ensureAbsent()` 检查之后、真正落地之前被占用（并发写、另一个进程、符号链接竞态） |
| 当前行为（修复前） | `ensureAbsent(targetPath)` 只在检查那一刻成立；随后的 `fs.rename(sourcePath, targetPath)` 在 POSIX 上**静默替换**已存在的目标，目标内容被销毁，源条目消失 |
| 期望行为 | 目标已存在 → 409，源与目标的内容都不变；失败必须可区分"目标已存在"与"其它错误" |
| 修复方式 | 新增导出 `moveEntryWithoutOverwrite({ fs, sourcePath, targetPath, sourceIsDirectory })`。<br>• 普通文件：`fs.link(source, target)` + `fs.unlink(source)`。`link(2)` 在目标名被占用时以 `EEXIST` 失败，因此目标**永远不会被销毁**；成功后 unlink 源，净效果等价于 rename。<br>• 硬链接不可用（`EPERM`/`ENOTSUP`/`EXDEV`/`EINVAL`…）或源是目录：先用独占占位抢占目标名（目录用 `mkdir`，文件用 `open(target,"wx")`），占位在目标名被占用时同样以 `EEXIST` 失败；再用 `fs.rename(source, target)` 覆盖**自己刚创建的占位**。<br>• 两条路径的 `EEXIST` 都映射为 409「A file or directory with that name already exists」。<br>`operate()` 里保留 `ensureAbsent` 作为快速失败，原子占位作为最终保证。 |
| 兼容性 | 成功返回值不变（`{ action, path, name }`）；"目标已存在"仍是 409；跨卷移动仍由 `EXDEV` 映射为 400 |
| 验证 | 「a move never replaces an existing target and leaves the source in place」「the file manager renames a file without leaving a copy behind and refuses an occupied target」 |

### 2.2 High 2 — upload / createText 的原生错误映射

| 段落 | 内容 |
| --- | --- |
| 位置 | `file-manager.mjs` `createText()` / `upload()` 的 `catch` 分支 |
| 触发条件 | 磁盘满、inode 耗尽、配额超限、权限不足、只读挂载、目标消失 |
| 当前行为（修复前） | `throw error` 原样抛出，`statusCode` 缺失，server 层只能回答 500 |
| 期望行为 | ENOSPC/EDQUOT → 507，EACCES/EPERM/EROFS → 403，ENOENT → 404，EFBIG → 413，EISDIR/ENOTDIR/EXDEV → 400，EMFILE/ENFILE → 503；未映射的错误码继续原样上抛（保持 500 与原始 `code`） |
| 修复方式 | 两处 catch 改为 `failNative(error)`（复用 lead 的 `ERRNO_STATUS` / `ERRNO_MESSAGE` 映射表）。同时导出 `nativeErrorStatus(error)`，把同一份映射暴露成不抛异常的纯函数，便于调用方与测试直接查询 |
| 兼容性 | 未映射错误的行为不变；新状态码在 server 的白名单内（`507` 由 lead 补丁加入） |
| 验证 | 「an upload that runs out of space answers 507 instead of 500」 |

### 2.3 High 3 — `files.list` 暴露 offset / sort / query / type

| 段落 | 内容 |
| --- | --- |
| 位置 | `read-only-tools.mjs` `files.list` 的 `inputSchema` 与 `invoke()` 的 `files.list` 分支；底层 `file-browser.mjs` `list(path, limit, offset, sort, query, type)` |
| 触发条件 | agent 需要在 > 200 项的目录上翻页、排序或按名称/类型过滤 |
| 当前行为（修复前） | schema 只有 `path` / `limit`（`offset` 为上一轮补入），`validArgs` fail-closed 拒绝未知字段，因此 `sort` / `query` / `type` 全部 400 |
| 期望行为 | 工具能翻页、能排序、能按名称子串过滤、能按类型过滤；新增字段全部 optional 且有上限；未知字段仍然 400 |
| 修复方式 | schema 增补：`sort`（enum：`directories-first` / `name-asc` / `name-desc` / `size-desc` / `modified-desc`）、`query`（string，maxLength 160）、`type`（enum：`all` / `directory` / `file`）。`invoke` 按 file-browser 的**参数顺序**透传六个实参：`list(path, limit, offset, sort, query, type)`。`validArgs` 增加 `enum` 校验，未知枚举值在调用前即被拒（400）。默认值 `sort="directories-first"`、`query=""`、`type="all"` 与浏览器默认值一致 |
| 兼容性 | 旧的 `{path, limit, offset}` 调用行为完全不变；`additionalProperties:false` 保持，`cursor` 之类的未知字段仍然 400 |
| 验证 | 「the files.list tool forwards the offset, the sort mode, the name query and the type filter」 |

### 2.4 Medium 4 — 搜索的两种"截断"被拆开

| 段落 | 内容 |
| --- | --- |
| 位置 | `file-browser.mjs` `search()` 的 BFS 循环与收尾判断 |
| 触发条件 | 某个目录的条目数超过 `MAX_SCAN_ENTRIES`(2000)，或全局扫描预算 `MAX_SEARCH_VISITS`(5000) 耗尽，或结果数达到 `limit` |
| 当前行为（修复前） | 单目录截断即 `break` 整个 BFS，其它目录的匹配项全部丢失；返回值也说不清是"结果被截断"还是"搜索提前停止" |
| 期望行为 | 单目录超限只影响该目录；只有预算耗尽或结果达上限才终止遍历；返回值能区分三种情况 |
| 修复方式 | 循环条件改为 `queue.length && scanned < MAX_SEARCH_VISITS && entries.length < limit`；单目录截断只累加 `partialDirectories`，不再终止遍历。返回值语义固定为：<br>• `truncated`：结果列表被 `limit` 截断；<br>• `stopped`：遍历提前结束（预算耗尽）；<br>• `partialDirectories`：只被部分扫描的目录数；<br>• `incomplete`：`stopped \|\| partialDirectories > 0`，即"答案可能不完整"；<br>• `skippedSymbolicLinks`：跳过的符号链接数 |
| 兼容性 | `truncated` 仍是"答案不完整"的既有信号，既有断言（`limited.truncated === true`）继续成立 |
| 验证 | 「a single oversized directory does not stop the search in the other directories」 |

### 2.5 Medium 5 — Base64 的"规范性"与"容量"分开判定

| 段落 | 内容 |
| --- | --- |
| 位置 | `read-only-tools.mjs` `decodeUploadPayload(encoded)` |
| 触发条件 | 载荷长度非 4 的倍数、正则不匹配、或"能解码但回环不一致"（尾部非规范位） |
| 当前行为（修复前） | 规范性与长度两个判定写在同一个条件里，`Buffer.from(x,"base64")` 忽略尾部非规范位，命中非规范载荷即被判 413 |
| 期望行为 | 非规范编码 → 400（畸形请求）；体积超限 → 413（容量问题） |
| 修复方式 | 拆分判定：字符数超限 → 413；长度非 4 倍数 / 正则不匹配 → 400；解码后字节数超限 → 413；**回环编码与原文不一致 → 400**。本阶段补充了针对非规范载荷（`"QR=="`）的固化用例 |
| 兼容性 | 合法载荷的解码结果不变；schema 的 `maxLength` 仍与运行时上限同源（`4*ceil(1MiB/3)=1398104`） |
| 验证 | 「a malformed Base64 payload is a bad request and an oversized one is too large」 |

### 2.6 Medium 6 — trim-cli 空输出也记成功，且返回结构统一

| 段落 | 内容 |
| --- | --- |
| 位置 | `trim-cli-adapter.mjs` `runReadOnly()` 的空输出分支 |
| 触发条件 | CLI 退出码 0 但 stdout 为空（例如没有匹配项的查询） |
| 当前行为（修复前） | 空输出分支提前 `return`，跳过 `health.success(id)`，连接健康停在 `not_tested`；返回结构 `{command, data, output}` 与其它命令的 `{command, data}` 不一致 |
| 期望行为 | 任何退出码 0 的执行都记为成功；返回结构统一为 `{command, data}` |
| 修复方式 | 空输出分支调用 `health.success(id)` 并返回 `{ command: id, data: null }`；解析出 JSON 时同样先 `health.success(id)` 再返回 `{command, data}` |
| 兼容性 | 正常命令的返回结构不变（仍是 `{command, data}`，既有 deepEqual 断言继续成立）；空输出的返回少了 `output: ""` 字段——该字段没有其它消费者，`trim-cli` 工具结果统一为两字段 |
| 验证 | 「an empty answer of the official CLI counts as a successful connection and has the same shape」 |

### 2.7 Medium 7 — 临时文件统一前缀、不可见、可回收

| 段落 | 内容 |
| --- | --- |
| 位置 | `file-manager.mjs` `createText()` / `upload()` 的暂存文件名；`file-browser.mjs` `defaultScanDirectory()` 与 `search()` 的条目过滤 |
| 触发条件 | 进程在写入中途崩溃（暂存文件留在目标目录）；或用户浏览该目录看到内部文件 |
| 当前行为（修复前） | 暂存文件名为 `.fnos-text-<uuid>.tmp` / `.fnos-upload-<uuid>.tmp`，列表只过滤符号链接、不过滤暂存文件 |
| 期望行为 | 暂存文件有统一前缀；列表与搜索都看不到它；下一次写入会清掉同目录里超龄的暂存文件 |
| 修复方式 | 统一前缀 `TEMP_FILE_PREFIX = ".fnos-tmp-"`（`file-manager.mjs` 与 `file-browser.mjs` 各自导出同一个常量）；`file-browser.mjs` 在扫描与搜索两处跳过该前缀的条目（因此它们也不计入 `totalDirectoryEntries`）；`file-manager.mjs` 在写入前调用 `cleanupStaleTempFiles(dir)`，删除同目录中以该前缀开头且 mtime 超过 24 小时（`TEMP_FILE_MAX_AGE_MS`）的暂存文件——正在被并发写入使用的暂存文件因为 mtime 很新而不会被删 |
| 兼容性 | 目录列表的 `totalDirectoryEntries` 口径随之收紧（内部文件不再是"条目"）；既有"目录里不得残留 `.fnos-text-`/`.tmp` 文件"的断言继续成立 |
| 验证 | 「a write leaves no staged file behind and removes the stale staged files of the directory」「the listing hides the staged write files and reports the symbolic links it skipped」 |

### 2.8 Medium 8 — 回滚失败不再被吞掉

| 段落 | 内容 |
| --- | --- |
| 位置 | `file-manager.mjs` `operate()` rename/move 的回滚分支（修复前 `await fs.rename(targetPath, sourcePath).catch(() => {})`） |
| 触发条件 | 移动完成后目录一致性校验失败（父目录被换掉），需要回滚，而回滚本身也失败 |
| 当前行为（修复前） | 回滚异常被 `.catch(() => {})` 吞掉，调用方只看到"操作失败"，不知道文件其实已经落在新位置 |
| 期望行为 | 回滚失败必须随原始错误一起上报 |
| 修复方式 | 新增导出 `restoreMovedEntry({ fs, fromPath, toPath, isDirectory, strategy })`：`link-unlink` 策略用硬链接恢复（**绝不覆盖**已经被人占用的旧名字，名字被占即失败）；`placeholder-rename` 策略用 rename 恢复。回滚抛出的异常被挂到原始错误上：`error.rollbackError = rollbackError`，随后原样抛出原始错误 |
| 兼容性 | 原始错误的 `statusCode` 不变（仍是 409），只是多了一个 `rollbackError` 字段供调用方判断 |
| 验证 | 「a rollback that fails is reported with the original error instead of being swallowed」 |

### 2.9 Medium 9 — 卷内符号链接：可见计数 + 可删除链接本身

| 段落 | 内容 |
| --- | --- |
| 位置 | `file-browser.mjs` `defaultScanDirectory()` / `search()`；`file-manager.mjs` `resolveExisting()` 与 `operate()` 的 delete 分支 |
| 触发条件 | 卷内存在符号链接（NAS 上很常见） |
| 当前行为（修复前） | 链接既不出现在列表里（被静默丢弃），也无法被任何接口删除（`resolveExisting` 一律 403） |
| 期望行为 | 用户至少能看到"这里有 N 个符号链接被跳过"；能删除链接本身，且删除链接**绝不**波及链接目标 |
| 修复方式 | ① 列表与搜索新增 `skippedSymbolicLinks` 计数（链接仍然不出现在 `entries` 里：既有测试锁定"含符号链接的目录 entries 为空数组"，且条目模型里没有链接类型）。② `file-manager.mjs` 新增 `resolveLinkEntry(value)`：`lstat` 判定为符号链接时，校验父目录（真实路径 + 根归属），返回链接**自身**的路径与父目录信息；delete 分支命中链接时只 `fs.unlink(链接条目)`，返回 `{ action, path, deleted: true, symbolicLink: true }`。链接的目标既不被跟随也不被删除 |
| 兼容性 | 非链接路径的删除流程完全不变；`resolveExisting` 对符号链接仍然 403（读取/改名/移动链接仍被拒绝），只有"删除链接本身"被允许 |
| 验证 | 「a symbolic link is deleted as a link and its target survives」「the listing hides the staged write files and reports the symbolic links it skipped」 |

### 2.10 Medium 10 — 上传限流与累计配额（未做，需 server 层）

见 §4「已知限制与后续」。

### 2.11 Low 11 — 偏移分页的漂移可检测

| 段落 | 内容 |
| --- | --- |
| 位置 | `file-browser.mjs` `list()` 的分页切片与返回值 |
| 触发条件 | 翻页期间目录内容发生变化（新增/删除/改名） |
| 当前行为（修复前） | 每次请求都重新扫描 + 排序，`slice(offset, offset+limit)` 在目录变化后会跳过或重复条目，客户端无从察觉 |
| 期望行为 | 至少让客户端能检测到漂移 |
| 修复方式 | 新增 `directoryVersion(entries)`：对目录条目的 name/type/sizeBytes/modifiedAt 计算 SHA-256 取前 16 位；`list()` 返回 `directoryVersion` 与 `driftHint`（常量 `OFFSET_DRIFT_HINT`，说明这是"每次请求重新扫描、不是快照"，并要求客户端比较 `directoryVersion`）。keyset 游标未实现，见 §4 |
| 兼容性 | 新增返回字段，不改变既有字段含义；`truncated` / `totalEntries` 语义不变 |
| 验证 | 「the listing reports a directory version that changes with the content」 |

### 2.12 Low 12 — 大小写折叠与运行时 locale 无关

| 段落 | 内容 |
| --- | --- |
| 位置 | `file-browser.mjs` 列表过滤（`query`）与搜索匹配（两处 `toLocaleLowerCase()`） |
| 触发条件 | 机器 locale 为土耳其语等特殊区域设置 |
| 当前行为（修复前） | 折叠结果随 locale 变化：土耳其语下 `"I"` 折叠成 `ı`，同一份目录在不同机器上命中集合不同 |
| 期望行为 | 折叠结果只取决于输入本身 |
| 修复方式 | 抽出 `foldName(value) = String(value ?? "").normalize("NFKC").toLowerCase()`，列表过滤与搜索匹配统一使用它（`toLowerCase()` 是 locale 无关的） |
| 兼容性 | 命中集合在非土耳其语环境下与之前一致；搜索仍是"子串匹配且大小写不敏感" |
| 验证 | 「the search and the listing fold the case without the machine locale」 |

### 2.13 Low 13 — 403 的四种成因不再折叠

| 段落 | 内容 |
| --- | --- |
| 位置 | `file-manager.mjs` `operateBatch()` 的失败项构造 |
| 触发条件 | 批量操作中某一项被拒 |
| 当前行为（修复前） | 所有 403 都写成同一句"操作路径不在允许范围内。"，调用方无法区分四种成因 |
| 期望行为 | 至少能把 `error.message` 透传给调用方 |
| 修复方式 | 新增 `FORBIDDEN_REASONS` 映射（越界 / 符号链接 / 不能重命名根目录 / 不能删除根目录 / 缺少删除凭据 → 各自的中文提示）；失败项的 `error` 使用细分文案，并额外带上 `reason` 字段（原始英文 `message`），便于日志与上层做稳定判断。`reason` 只在 403 时附加，不影响其它字段的形状 |
| 兼容性 | 失败项仍保留 `index` / `ok` / `statusCode`，顺序与部分成功语义不变；既有测试没有锁定 403 的中文文案 |
| 验证 | 「the batch result tells the different 403 reasons apart」 |

### 2.14 Low 14 — trim-cli 的文本截断带标记

| 段落 | 内容 |
| --- | --- |
| 位置 | `trim-cli-adapter.mjs` `runReadOnly()` 的 JSON 解析回退分支 |
| 触发条件 | CLI 返回非 JSON 且长度超过 64000 字符 |
| 当前行为（修复前） | `data = stdout.slice(0, 64_000)`：静默截断，调用方无法区分"完整文本"与"被切过的文本" |
| 期望行为 | 截断必须显式可见 |
| 修复方式 | 文本超过 `MAX_TEXT_OUTPUT_CHARS`(64000) 时返回 `{ command, data: 前 64000 字符, truncated: true }`；未截断时不带 `truncated` 字段（保持 `{command, data}` 形状）。选择"带标记返回"而不是抛 `output_too_large`：CLI 本身执行成功，抛错会把连接健康误标为失败 |
| 兼容性 | 正常命令的返回结构不变（既有 deepEqual 断言仍然成立）；只有被截断的文本答案会多一个 `truncated` 字段 |
| 验证 | 「a cut off text answer of the official CLI says that it was cut off」 |

### 2.15 Low 15 — photos.search 的 keyword 不得以 `-` 开头

| 段落 | 内容 |
| --- | --- |
| 位置 | `trim-cli-adapter.mjs` `validateInput()` 的 `photos.search` 分支 |
| 触发条件 | keyword 以 `-` 开头（如 `--all`） |
| 当前行为（修复前） | 校验只看类型与长度，`--all` 会被原样拼进 argv，被 CLI 当成选项而不是搜索词 |
| 期望行为 | 这类 keyword 在调用前被拒 |
| 修复方式 | `validateInput` 增加一条：`input.keyword.trim().startsWith("-")` → 400「photos.search keyword must not start with '-'」。**不**采用插入 `--` 分隔符的方案：既有的 argv 断言（`["photos","search","family album","--limit","20"]`）不允许多出分隔符 |
| 兼容性 | 正常 keyword 的 argv 完全不变；异常 keyword 从"行为不确定"变成"明确 400" |
| 验证 | 「the official CLI refuses a photo keyword that starts with a dash」 |

### 2.16 Low 16 — preview 的 BOM 嗅探与 path 返回

| 段落 | 内容 |
| --- | --- |
| 位置 | `file-manager.mjs` `preview()` |
| 触发条件 | 预览 UTF-16（带 BOM）的文本文件；或调用方需要知道预览的是哪个文件 |
| 当前行为（修复前） | `b.includes(0)` 判定二进制 —— UTF-16 文本里每个 ASCII 字符都带一个 NUL 字节，因此 UTF-16 文档恒被拒为 415；返回值 `{name, sizeBytes, content}` 不含 path |
| 期望行为 | 先按 BOM 判定编码，再判定二进制；返回值带 path |
| 修复方式 | 抽出 `decodePreviewBuffer(buffer)`：先嗅探 BOM（`FF FE` → utf-16le，`FE FF` → utf-16be，按对应编码解码）；无 BOM 时才用 NUL 判定二进制（415），UTF-8 用 `fatal:true` 解码（失败 415）。`preview()` 的返回值补上 `path: item.path` |
| 兼容性 | UTF-8 文本的预览结果不变（只多一个 `path` 字段）；真二进制文件仍然是 415 |
| 验证 | 「the preview decodes a UTF-16 document, refuses a binary file and reports the path」 |

### 2.17 Low 17 — `files.move` 的 risk 标注（未改，文档说明）

见 §4「已知限制与后续」。

---

## 3. 兼容性说明

### 3.1 返回值新增字段（均为向后兼容的追加）

| 接口 | 新增字段 | 含义 |
| --- | --- | --- |
| `fileBrowser.list` | `skippedSymbolicLinks` | 本次扫描跳过的符号链接数 |
| `fileBrowser.list` | `directoryVersion` | 目录内容指纹（16 位十六进制），用于检测翻页漂移 |
| `fileBrowser.list` | `driftHint` | 偏移分页不是快照的提示文案 |
| `fileBrowser.search` | `stopped` | 遍历提前结束（预算耗尽） |
| `fileBrowser.search` | `incomplete` | 答案可能不完整（提前停止或有目录只被部分扫描） |
| `fileBrowser.search` | `partialDirectories` | 只被部分扫描的目录数 |
| `fileBrowser.search` | `skippedSymbolicLinks` | 跳过的符号链接数 |
| `fileManager.preview` | `path` | 被预览文件的真实路径 |
| `fileManager.operate`（delete 链接） | `symbolicLink` | 标记本次删除的是链接本身 |
| `fileManager.operateBatch` 失败项 | `reason` | 403 的原始英文原因（仅 403 时出现） |
| `trimCli.runReadOnly` | `truncated` | 文本答案被截断（仅非 JSON 且超长时出现） |

### 3.2 行为变化

- 移动（rename/move）现在**绝不**覆盖已存在的目标：目标被占用一律 409，源与目标内容都不变。
- `upload` / `createText` 的原生错误（磁盘满、权限不足等）从 500 变为 507 / 403 / 404 / 413。
- `files.list` 接受 `sort` / `query` / `type`；未知枚举值与未知字段一样是 400。
- 搜索遇到超大目录不再终止整趟遍历；`truncated` 的含义收窄为"结果列表被 limit 截断"，新增 `stopped` / `incomplete` / `partialDirectories`。
- 目录列表与搜索不再显示内部暂存文件，计数口径同步收紧。
- 删除符号链接本身被允许（只删链接，不动目标）；读取/改名/移动符号链接仍然是 403。
- `files.list` 的 `query` / `type` / `sort` 与 `file-browser` 的参数顺序一致（`path, limit, offset, sort, query, type`）。

### 3.3 未放宽的既有加固

路径边界的 realpath + `within` 校验、符号链接最终分量不误删目标、`O_NOFOLLOW` + dev/ino 二次校验、
排序 tiebreaker、搜索为子串且大小写不敏感、预览/校验和读取前的体积检查、上传/建文本的原子发布
（`EEXIST` → 409）、`operateBatch` 的部分成功语义（`results[i].index` 与操作顺序一致、`statusCode` 保留）、
`read-only-tools` 的 `validArgs` fail-closed（`additionalProperties:false` + `hasOwn` 双重拒绝、必填校验、
类型与 min/max 校验）、风险标注在 `invoke` 入口交给执行策略评估、26 条 trim-cli 白名单与工具一一对应、
`execFile` 无 shell、错误分类 504(timeout) / 502(output_too_large) 全部保持不变。

### 3.4 为测试引入的接缝（生产默认不变）

| 接缝 | 位置 | 说明 |
| --- | --- | --- |
| `scanDirectory` | `createFileBrowser` | 遍历规则的注入点（第一轮引入），生产默认仍是描述符固定的扫描器 |
| `descriptorPathFor` | `createFileBrowser` / `createFileManager` | 目录描述符路径的解析注入点。生产不传该参数，因此非 Linux 平台仍然 fail-closed（`503 Secure file operations require Linux directory descriptors` / `503 Secure directory browsing requires Linux descriptor paths`） |

---

## 4. 已知限制与后续

1. **上传限流与按会话累计字节配额需要 server 层实现**（Medium 10）。`/api/files/upload` 目前既没有频率限制，
   也没有按会话累计的字节配额：对比 `/api/files/checksum` 使用了 `fileChecksumLimiter`（每分钟 5 次）。
   单个会话可以持续上传直到卷写满。本阶段受文件权限限制不能改 `server.mjs`，因此该项**未做**，
   需要在 server 层补一个与 `fileChecksumLimiter` 同构的上传限流器，以及一个按会话累计的字节配额。
2. **偏移分页仍然不是快照**（Low 11）。本阶段只提供了漂移检测（`directoryVersion` + `driftHint`），
   没有实现 keyset 游标或目录快照。要彻底解决需要引入条目游标（按 `(type, name)` 排序键续扫），
   属于 file-browser 的结构性改动。
3. **符号链接的可见性只到计数级别**（Medium 9）。链接仍然不出现在 `entries` 里（条目模型没有链接类型），
   UI 只能看到"跳过了 N 个符号链接"；链接的创建、替换、指向检查也仍然不支持。
4. **`files.move` 的 risk 仍然是 `write`**（Low 17）。`files.move` 实际会移除源位置，具备删除语义，
   但 `tests/phase-3-auth.test.mjs` 与 `tests/phase-7-readonly-tools.test.mjs` 锁定了 `files.move` 的
   `risk === "write"`；改标注会改变只读模式下的可执行集合并破坏既有测试，因此**未改**，
   在这里显式记录该不对称：只读模式下 `files.move` 仍可移动（=移走）文件。
5. **非 Linux 平台的写路径仍然 fail-closed**：`file-manager` 的写入类操作在非 Linux 平台返回 503
   （`Secure file operations require Linux directory descriptors`）。这是刻意的：目录描述符隔离是
   Phase 118/120/122 的加固项，本阶段不放松。
6. **trim-cli 文本答案的 64000 字符上限**是既有阈值，本阶段只增加了 `truncated` 标记，未改变阈值。

---

## 5. 测试策略

`tests/phase-138-file-domain-hardening.test.mjs` 共 21 个用例，全部通过。测试只依赖 `node:test` +
`node:assert/strict` + `node:fs/promises`，**不依赖 POSIX 权限位**（不写 `0o600` 之类断言），
**不依赖 Linux 专有的 dirfd 行为**：需要目录描述符的路径通过 `descriptorPathFor` / `scanDirectory`
接缝在 Windows 本机上以真实临时目录跑通。

> Windows 平台注记：NTFS 的**目录** file index（ino）在两次句柄之间可能变化（目录内容变化后索引会惰性更新），
> 因此 file-browser / file-manager 的 dev/ino 二次校验在 Windows 上会出现偶发的
> `409 Directory changed while opening`。这是平台特性，Linux 上目录 inode 稳定。
> 测试接缝在 `lstat` 与 `open` 之间保持身份稳定（`testFs` 的 `stableOpen`），
> 生产的加固逻辑一行未改；该加固本身由 Linux 专用的 Phase 118/120/122 用例覆盖。

| 覆盖的缺陷 | 用例 |
| --- | --- |
| High 1 | a move never replaces an existing target and leaves the source in place；the file manager renames a file without leaving a copy behind and refuses an occupied target |
| High 2 | an upload that runs out of space answers 507 instead of 500 |
| High 3 | the files.list tool forwards the offset, the sort mode, the name query and the type filter |
| Medium 4 | a single oversized directory does not stop the search in the other directories |
| Medium 5 | a malformed Base64 payload is a bad request and an oversized one is too large |
| Medium 6 | an empty answer of the official CLI counts as a successful connection and has the same shape |
| Medium 7 | a write leaves no staged file behind and removes the stale staged files of the directory；the listing hides the staged write files and reports the symbolic links it skipped |
| Medium 8 | a rollback that fails is reported with the original error instead of being swallowed |
| Medium 9 | a symbolic link is deleted as a link and its target survives |
| Medium 10 | 未做（server 层），仅文档记录 |
| Low 11 | the listing reports a directory version that changes with the content |
| Low 12 | the search and the listing fold the case without the machine locale |
| Low 13 | the batch result tells the different 403 reasons apart |
| Low 14 | a cut off text answer of the official CLI says that it was cut off |
| Low 15 | the official CLI refuses a photo keyword that starts with a dash |
| Low 16 | the preview decodes a UTF-16 document, refuses a binary file and reports the path |
| Low 17 | 未改（既有测试锁定），仅文档记录 |
| 第一轮 8 项 | the files.list tool forwards the offset…；the directory counters share one counting basis…；the browser tells a symbolic link apart from a path outside the storage roots；the file manager answers a symbolic link with its own reason；a staged file is published with a rename…；a staged file that already exists is refused with 409…；the browser and the file manager order the storage roots in the same way |

运行：

```sh
node --test tests/phase-138-file-domain-hardening.test.mjs
npm test
```

本阶段用例覆盖的是逻辑契约，不替代真实 fnOS 文件系统与设备验收。

> Windows 平台注记（既有问题，与本阶段无关）：`tests/phase-108-file-sha256-checksum.test.mjs` 的
> 「checksum returns the expected SHA-256 using the bounded streaming file API」在本机会失败，
> 因为断言比较的是 `mkdtemp` 返回的 8.3 短路径（`C:\Users\ADMINI~1\...`）与 `fs.realpath` 返回的
> 长路径（`C:\Users\Administrator\...`）。该用例在 Linux 上两者相同；生产代码的 realpath 归一化
> 属于路径边界加固的一部分，不应为迁就 Windows 断言而回退。

> 索引提示：新增文档需要在 `docs/README.md` 里补一条 `](phase-138-file-domain-hardening.md)` 链接，
> 否则 `tests/docs-links.test.mjs` 的「docs/README.md lists every document in docs/」会失败。该索引由 lead 统一维护。
