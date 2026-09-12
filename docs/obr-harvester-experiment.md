# OBR Harvester / Mock Host 实验计划

日期：2026-09-10
分支：`feat/obr-harvester`

## 目标

把现有“全站注入 UserScript + 人工逐个点击 UI”的 Collector 降级为运行时补漏工具，实验一条可自动化的采集与 E2E 路线：

1. `manifest.json` 作为扩展资源图根节点。
2. 自动抓取 action/background 等入口页面，并递归发现 HTML、JS module/chunk、CSS、source map。
3. 从生产 JS/CSS/HTML 中提取潜在用户可见英文字符串，按上下文打置信度分数。
4. 与 OverlayLex 现有翻译包做差集，输出“已有 / 新增 / 低置信度”报告。
5. 第二阶段实现最小 OBR Mock Host，模拟 `obrref`、`OBR_READY` 和常用 SDK request/response，截获 `tool/contextMenu/modal/popover/notification` 等动态注册数据，并把运行时发现的新 URL 继续送回资源队列。
6. 最终把同一 Mock Host 作为 Owlbear Extension 的 Playwright E2E 测试宿主，解决扩展开发长期缺乏自动化运行环境的问题。

## 第一阶段验收标准

- 不依赖 Owlbear 登录态、不需要人工点击 Smoke & Spectre UI。
- 对 `https://smoke.battle-system.com/manifest.json` 能递归生成资源图。
- 能从真实生产 bundle 中提取候选英文文案，并记录来源文件、上下文与分数。
- 能加载 `src/packages/obr-smoke-battle-system-com.json` 做差集。
- GitHub Actions 自动运行真实 Smoke 5.0 实验并上传报告 artifact。
- 报告必须给出覆盖统计，不能预设“99%”。

## 第二阶段验收标准

- Mock Host 能让最小 SDK 测试扩展完成 `OBR.onReady()`。
- 能记录 SDK 注册/调用 payload，并返回可配置的 GM / scene / party / theme 等假数据。
- Playwright 可直接加载扩展页面，在 mock host 中断言 DOM、toolbar/context-menu 注册和动态弹窗 URL。
- 同一基础设施可复用于 OverlayLex 自有 Owlbear Extension 的 E2E。

## 风险与边界

- 静态 bundle 中的字符串不等于全部 UI 文案：服务端返回、模板拼接、运行时国际化和条件分支仍可能缺失。
- 压缩后的生产 bundle 会包含大量内部字符串，必须依赖上下文评分和运行时证据清洗，不能简单抓所有英文引号。
- sourcemap 若未公开则只能分析发布 bundle；工具不得尝试绕过访问控制获取源码。
- Mock Host 只模拟公开 Owlbear Extension SDK 行为，不伪造用户凭据，不访问私有房间数据。

## 当前状态

- [x] 建立实验分支。
- [x] 核对 Owlbear Extension SDK 的 manifest / iframe / postMessage 架构。
- [ ] 第一阶段：资源图 Harvester。
- [ ] 第一阶段：静态字符串评分与旧包 diff。
- [ ] 第一阶段：GitHub Actions 对 Smoke 5.0 实跑。
- [ ] 第二阶段：OBR Mock Host。
- [ ] 第二阶段：Playwright E2E 示例。
