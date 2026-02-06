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
  - 新增 `README.md`：补充最小可运行步骤、API 说明与抽词翻译工作流。
  - 新增 `src/packages/overlaylex-domain-allowlist.json`：补充域名准入包，用于全站触发后的快速放行判断。
  - 更新 `src/worker/src/data.js`：升级 manifest 为“翻译包 + 域名包”，并添加 R2 失败时内置回退包。
  - 更新 `src/worker/src/index.js`：新增 `/packages`、`/domain-package.json`，并改为优先从 R2 读取包正文。
  - 更新 `src/worker/wrangler.toml`：绑定 R2 桶 `PACKAGES_BUCKET`。
  - 重写 `src/userscript/overlaylex.user.js`：实现全站 match、域名包门禁、iframe 补充翻译、顶层独立控制台与新版 manifest 适配。
  - 更新 `src/userscript/overlaylex.user.js`：回填已部署 Worker 地址 `overlaylex-demo-api.zhangjiahe0830.workers.dev`。
  - 更新 `README.md`：补充线上 API 地址、R2 桶信息、新增接口与运行策略说明。
  - 更新 `src/packages/obr-room-core.json`：纳入用户手动翻译修订（`Owlbear Rodeo -> 枭熊VTT`）。
  - 更新 `.gitignore`：忽略 `src/worker/node_modules/` 与 `src/worker/.wrangler/`。
  - 云端部署：Worker `overlaylex-demo-api` 已发布到 `https://overlaylex-demo-api.zhangjiahe0830.workers.dev`，R2 桶 `overlaylex-packages-bfdcb419` 已绑定并上传两个包对象。
  - 远程验证：`/health`、`/manifest`、`/packages`、`/packages/obr-room-core.json`、`/packages/overlaylex-domain-allowlist.json`、`/domain-package.json` 均可返回有效数据。
  - 更新 `src/userscript/overlaylex.user.js`：新增本地种子域名冷启动门禁、缓存优先拒绝策略、运行期自动采集器（按域名分层、跨会话去重、增量复制、iframe 域名记录）。
  - 新增 `src/packages/overlaylex-domain-seeds.json`：仓库内维护种子域名规则说明。
  - 删除 `src/tools/extract-visible-texts.js`：废弃静态 HTML 抽词流程，改为用户脚本实时采集。
  - 更新 `README.md`：抽词流程改为“运行期自动采集器”使用说明。
  - 回退 `src/userscript/overlaylex.user.js`：移除采集逻辑，恢复主脚本“仅负责翻译注入”的单一职责。
  - 新增 `src/userscript/overlaylex.collector.user.js`：独立实时采集脚本（全站运行、按域名去重、增量复制、iframe 域名记录）。
  - 更新 `README.md`：改为双脚本说明，明确“主翻译脚本”与“独立采集脚本”分离安装与使用流程。
  - 更新 `src/userscript/overlaylex.collector.user.js`：采集脚本悬浮球支持拖动，并避免拖拽后误触发点击开关面板。
  - 更新 `src/userscript/overlaylex.collector.user.js`：采集仅保留“纯英文向”词条（过滤中文/无字母噪声），并排除采集器自身 UI 文案，修复计数自循环增长问题。
  - 更新 `src/userscript/overlaylex.collector.user.js`：复制导出改为简洁行格式 `"英文",""`，新增“一键复制全部合并”按钮（跨域名去重合并导出）。
  - 更新 `src/userscript/overlaylex.collector.user.js`：新增“清空当前域数据 / 清空全部采集数据”按钮，并加入二次确认，便于快速清理历史缓存。
  - 更新 `src/userscript/overlaylex.collector.user.js`：修复误采集脚本/CSS 代码文本（过滤 script/style 等节点及代码特征），并将复制格式改为“按域名分组 + 词条逗号串”（`"A","B","C"`）；新增域名下拉与“复制选定域名”按钮。
  - 新增 `src/packages/obr-www-owlbear-rodeo.json`、`src/packages/obr-clash-battle-system-com.json`、`src/packages/obr-smoke-battle-system-com.json`、`src/packages/obr-outliner-owlbear-rodeo.json`、`src/packages/obr-owlbear-hp-tracker-pages-dev.json`：将 `采集数据.csv` 的 5 个域名词条按域名拆包并批量翻译为中英映射。
  - 更新 `src/userscript/overlaylex.user.js`：新增按包 `target.host/pathPrefix` 的命中判断，只加载当前页面命中的域名包，避免跨域包混载污染翻译结果。
  - 更新 `src/packages/overlaylex-domain-allowlist.json`：扩充插件域名白名单（Battle-System、DDDice、AoE、HP Tracker、GitLab 插件域名），版本升至 `0.2.0`。
  - 更新 `src/worker/src/data.js`：补充 5 个域名翻译包目录元信息，并同步域名准入包版本与回退规则为 `0.2.0`。
