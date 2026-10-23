# Phase 213：知识库的两步写入（预览 → 提交）

## 背景

`knowledge-base` 一直有 `preview(operation, input)` 与 `commit(previewId)` 两步写入：预览只计算「会存什么、哪些字段被脱敏」，返回一个 `previewId`；提交只认这个 id，不认正文。这样单次调用永远写不进去。

但界面上没有入口——`POST /api/knowledge/preview` 与 `/commit` 一直悬着（Phase 211 把它列为「有意 API-only，因为要先定谁能写」）。这一阶段定口径并补界面：**只能由已登录的控制台用户手写一条知识，且必须看清预览再提交。**

## 为什么不在 pages.js 里写

`pages.js` 的知识库区块有一条既有守卫：只读面板不得出现写请求（测试扫描该区块后断言不出现 `method:"POST"`）。把写入塞进同一区块，要么破守卫，要么把守卫改松。

因此写入独立成模块 `app/ui/knowledge-write.js`：读在 `pages.js`，写在模块里，边界写在文件结构上。模块写入成功后派发 `knowledge-saved` 事件，`pages.js` 只负责刷新列表与统计。

## 交互

1. 填标题、摘要、正文、来源、核验状态、标签。
2. 点「预览」→ `POST /api/knowledge/preview { operation:"write", input }`。
3. 页面显示服务端返回的条目快照：标题、条目 ID、来源、核验状态、采集时间、摘要、标签，以及**被脱敏的字段**、提醒（如「将覆盖已有条目」）。
4. 点「确认写入」→ `POST /api/knowledge/commit { previewId }`。
5. 成功后清空标题/摘要/正文/标签，刷新列表与统计；失败则显示服务端原因并作废预览。

## 关键约束

- **改表单即作废预览**：任一字段变更后提交按钮禁用，必须重新预览。实现是比对表单指纹（`JSON.stringify(readForm()) !== formSignature`），避免「预览 A、提交 B」。
- **提交只发 previewId**：正文不再回传，落库内容以服务端预览时的快照为准。
- **来源与核验状态是枚举**：来源只能是 `official-doc` / `field-observation` / `manual-confirmation`，核验只能是 `verified` / `unverified` / `stale` / `conflicted`——与服务端常量一致，界面不发明新值。
- **脱敏与拒绝都由服务端做**：正文里的密钥、令牌、绝对路径由 `inspectKnowledgeBody` 判定，前端不重复实现，也不在预览里显示被脱敏的原值。
- **渲染只用 textContent**：知识内容是外部输入。

## 顺手修掉的一个真 bug

知识库检索的来源下拉框原来写的是 `official` / `vendor` / `operations` / `community` / `memory`——服务端的来源枚举根本不是这几个值，选了也筛不出东西。已改为 `official-doc` / `field-observation` / `manual-confirmation`，并在测试里锁死「筛选值必须是服务端认识的值」。

## 测试

新增 `tests/phase-213-knowledge-write.test.mjs`，10 例全通过：

1–2. `buildKnowledgePayload` 只保留服务端接受的字段、去空白、标签按逗号/空白切分且上限 20、核验默认 `unverified`、`body` 缺省为空串。
3. `normalizePreview` 拒绝缺 `previewId` 的响应（宁可不写，也不猜）。
4. `describePreview` 覆盖标题、来源、核验、采集时间、脱敏字段、提醒、覆盖旧条目。
5. 空条目预览显示「未采集」，不伪装成已采集。
6. 模块只访问 `preview` 与 `commit` 两个接口。
7. 表单改动后必须作废预览并禁用提交。
8. HTML 装载模块、控件齐全、提交按钮初始禁用；`pages.js` 监听 `knowledge-saved`。
9. 来源筛选值必须是服务端认识的三个值。
10. 模块不出现 `innerHTML` / `insertAdjacentHTML` / `outerHTML` / `document.write`。

## 遗留

- 知识条目的「核验 / 归档」两个操作（`preview("verify")`、`preview("archive")`）还没有界面入口；它们同样是两步，可以复用同一套预览-提交组件。
- 目前只允许手写单条；批量导入（例如从运维记录里抽）需要先定去重与覆盖策略。
