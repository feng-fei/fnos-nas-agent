# Phase 157 — UI 集成校验

Phase 154 交付了模型设置模块（`app/ui/model-settings.js` + `model-settings.css`），
Phase 149/151 交付了对话窗口的前端，Phase 156 写下了整套迁移对照表。但这些
前端能力在真实页面里是否**真的生效**，此前没有任何一条测试回答过。

本阶段补上这一层：用 `tests/phase-157-ui-integration.test.mjs` 对页面的真实
源码与真实模块求值结果做交叉校验。它只新增一个测试文件，不改生产代码。

## 1. 为什么需要这一层

前端模块的典型失败方式不是「函数写错」，而是「写对了但页面没接上」：

| 失败方式 | 表现 | 本阶段的断言 |
| --- | --- | --- |
| 类名与样式表脱节 | 向导步骤有状态，但页面上看不出 | 页面用的修饰符必须在 `model-settings.css` 中存在 |
| 模块就绪晚于页面脚本 | 首屏向导容器为空 | 页面必须监听 `model-settings-ready` 并在启动时先渲染一次 |
| 导出的渲染函数没人调用 | `.model-settings__card*` 样式全部落空 | 页面必须真正调用 `describeCredentialState` 并使用这些类名 |
| 状态类挂错节点 | 错误提示不可见 | 状态类必须挂在 `.field` 容器与控件两处 |
| 空值保护不一致 | 表单缺失时 `submit` 直接解引用抛错 | 两个监听器必须在同一个 `if(modelProviderForm)` 保护块内 |

## 2. 校验方法

测试不依赖浏览器，也不依赖 jsdom。它用 Node 自带能力做三件事：

1. `vm.Script` 编译 `app/ui/pages.js`，确认它仍是**经典脚本**（不是 ES module），
   页面主脚本的加载方式没有被前端改造破坏。
2. `import()` 真实求值 `app/ui/model-settings.js`，并用「缓存击穿」保证模块体
   每次都真正执行一次，避免 `import` 缓存让断言只测到空壳。
3. 对 `pages.js`、`index.html`、`styles.css`、`model-settings.css` 与
   `server.mjs` 做源码级断言：模块与样式表被页面加载、向导容器存在、
   14 个模型字段 id 齐全、页面对 `window.ModelSettings` 的调用点存在、
   提交路径满足「校验 → 渲染字段级错误 → 发请求」的顺序。

同时断言两条**安全**不变量，防止前端改造把安全基线削弱：

* 页面不使用 `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write`；
* 明文 `apiKey` 只出现在 5 处白名单位置（读取输入框、传给校验器、进入请求体、
  清除标记、提交前判定），不出现在渲染路径上。

## 3. 发现的真实缺陷与修复

首轮运行把 5 个缺陷记录为 `test.todo`，逐一修复后全部改写为**真实断言**
（`todo` 会掩盖缺陷，因此不允许保留）。

| # | 缺陷 | 修复 |
| --- | --- | --- |
| 1 | `pages.js` 用 `is-done` / `is-current`，而 `model-settings.css` 定义的是 `--done` / `--current` / `--invalid`，向导状态样式全部落空 | 页面改用 `model-settings__wizard-step--done` / `--current` |
| 2 | `model-settings.js` 派发 `model-settings-ready`，但页面没有监听；向导只在 `input` 时重绘，首屏为空 | 页面监听 `model-settings-ready` 并在启动时先渲染一次 |
| 3 | 卡片仍由页面手工 `createElement`，`.model-settings__card*` 样式在真实页面不生效 | 卡片挂上模型设置类名，凭据行改用 `describeCredentialState()` |
| 4 | `field--invalid` 挂在控件上，而共享样式期望挂在 `.field` 容器上 | 容器与控件两处都设置状态类，错误提示挂在容器上 |
| 5 | `input` 监听有空值保护，`submit` 监听却直接解引用表单 | 两个监听统一放进 `if(modelProviderForm)` 保护块 |

## 4. 结果

```
node --test tests/phase-157-ui-integration.test.mjs
25 tests / 25 pass / 0 fail / 0 todo
```

与 Phase 151 / 154 / 156 的用例合跑为 56 tests / 56 pass / 0 fail。

## 5. 边界

* 本阶段只新增 `tests/phase-157-ui-integration.test.mjs` 与本文档；
* 生产的修改发生在 Phase 154 的集成步骤中，本阶段只负责**证明**集成结果；
* 测试只做源码与模块求值层面的校验，不模拟浏览器渲染，视觉回归不在范围内。
