# OverlayLex 协作记录

## 目的
- 记录本仓库中由代理执行的关键改动，方便初学者回溯与学习。

## 约定
- 每次完成一批可运行的改动后立即提交。
- 提交信息推荐采用 Conventional Commits 风格。

## 变更日志
- 2026-02-06
  - 新增 `src/userscript/overlaylex.user.js`：实现 OverlayLex 用户脚本首版（缓存、包加载、增量翻译、悬浮面板、手动更新）。
  - 新增 `src/worker/src/data.js`：实现 Worker 侧翻译包注册表与 manifest 生成函数。
  - 新增 `src/worker/src/index.js`：实现 Worker API 路由与 CORS 响应封装。
  - 新增 `src/worker/package.json` 与 `src/worker/wrangler.toml`：补齐 Worker 本地开发与部署配置。
  - 新增 `src/packages/obr-room-core.json`：提供房间页第一版示例翻译包。
  - 新增 `src/tools/extract-visible-texts.js`：提供 HTML 候选文本抽取工具，用于快速建词典。
