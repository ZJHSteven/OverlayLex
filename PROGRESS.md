# 项目状态快照

## 当前结论（必须最新）
- 现状：OverlayLex 已完成第一阶段“单源码、多产物”改造：同一个 `src/userscript/overlaylex.user.js` 可通过 `vite-plugin-monkey` 生成 UserScript，并通过 WXT（Vite）生成 Chrome / Edge / Firefox Manifest V3 扩展。WebExtension 已补齐扩展级 `browser.storage.local` 存储桥，主站与跨域 iframe 不再依赖按域隔离的页面 localStorage。远端 GitHub Actions 已实际完成四类构建与三端 ZIP 打包。
- 已完成：新增根目录 `package.json`、`vite.userscript.config.js`、`wxt.config.ts`、`entrypoints/overlay.content.ts` 与 `src/userscript/overlaylex.entry.js`；WXT 商店版 host 权限由 `src/packages/overlaylex-domain-allowlist.json` 自动生成，不申请 `<all_urls>`；Firefox 构建设置稳定 extension id `overlaylex@zjhstudio.com` 并按 AMO 当前规则声明 `browsingActivity`；新增 `build-validate` CI，检查四类产物、iframe 注入、host 权限和 Firefox 数据声明；补充 `docs/browser-builds.md` 与 `docs/store-submission.md`；修复原 `release-publish.yml` 中 `steps:` 错误嵌入 `env:` 导致 workflow 无法解析的问题。
- 验证结果：远端 CI 使用 Node.js 22 + Vite 8.2.2 + WXT 0.21.4 + vite-plugin-monkey 8.1.0 完整构建成功；UserScript 约 65.6 kB；Chrome/Edge 扩展 ZIP 约 14.5 kB，Firefox ZIP 约 14.6 kB，并生成 Firefox reviewer sources ZIP。权限收紧后的 manifest 验证同样通过。
- 正在做：浏览器商店上线准备与真实浏览器安装级回归；Firefox AMO reviewer sources 已改为严格源码 allowlist，避免本地未跟踪资料被 WXT 默认打包；Firefox AMO 与 Microsoft Edge Partner Center 账户已由用户完成注册，本轮将继续尝试直接送审。
- 下一步：① 在本机空白浏览器 profile 对 Chrome/Edge/Firefox 成品做真实运行回归；② 将 UserScript 的 `@updateURL/@downloadURL` 从 GitHub Raw 迁至自有域/CDN；③ 准备/核对商店图标、截图和公开隐私政策 URL；④ 提交 Firefox AMO / Edge Add-ons 审核。

## 关键决策与理由（防止“吃书”）
- 决策A：保留“全站触发 + 门禁快速退出”总体架构（原因：兼顾兼容性与性能，不干扰非目标站点）。
- 决策B：把 seeds 内置到用户脚本，仅作为首层快速放行（原因：首次不依赖网络即可判定是否继续，提升冷启动稳定性）。
- 决策C：远端 allowlist 继续作为准入真值源（原因：后端可动态维护域名规则，避免每次改域名都强制用户更新脚本）。
- 决策D：为“后端不可达”增加可视化提示（原因：降低用户误判成本，便于远程协助定位网络可达性问题）。
- 决策E：默认 API 改用自定义域（原因：部分地区/网络对 `workers.dev` 可达性较差，自有域通常更稳定且可控）。
- 决策F：本地 seeds 必须覆盖“已知插件域名集合”（原因：seeds 位于启动最前置门禁，过窄会直接导致 iframe 页面无法进入翻译链路）。
- 决策F：撤销“扩 seeds 覆盖插件域名”的方案，改为“allowlist 缓存判准 + seed 最小兜底”（原因：seeds 语义是首装冷启动入口，不应替代 allowlist）。
- 决策G：allowlist 缓存采用 GM 共享存储作为主存（原因：localStorage 按域隔离，不满足跨域 iframe 场景的缓存复用需求）。
- 决策H：`main -> release` 取消 `cherry-pick`，改为“按文件从 main 提交快照覆盖同步”（原因：release 仅用于触发发包 CI，应只接收本次发包目标文件，避免无关文件冲突与历史噪音）。
- 决策I：发包自动版本递增改为“以 max(本地版本, 线上版本) 为基线再 +1”（原因：当 main 版本落后线上时，固定 +1 可能仍不满足 `local > remote`，导致 prepare 阶段失败）。
- 决策J：采集上传链路不做 R2 临时存储，改为 Worker 直接触发 GitHub `repository_dispatch`（原因：采集数据是短期中转数据，直接进 CI 生成 PR 更简单，运维成本更低）。
- 决策K：一键上传默认范围从“仅顶层当前域名增量”改为“当前页面相关域名增量（包含 iframe 插件域名 bucket）”（原因：OBR 插件常以 iframe 注入，真实可翻译词条多数归属插件域名，不应在默认路径中漏传）。
- 决策L：`repository_dispatch.client_payload` 顶层字段数控制在 10 个以内（原因：GitHub REST API 对 `client_payload` 顶层属性数量有限制，超限会返回 422）。
- 决策M：采集脚本一键上传增加“按字节自动分批上传”（原因：Worker 请求体与 GitHub `repository_dispatch` 均存在大小上限，单次上传易在多域名/长文本场景触发超限；分批可在不引入 R2 临时存储的前提下完成大批量采集提交）。
- 决策N：一键上传不再使用本地 `exportedTexts` 游标判定与成功后标记（原因：本地“提交成功”无法证明远端最终链路成功；上传幂等性应交给云端 `merge-collected` 去重，避免本地误判后再也传不上去）。
- 决策O：上传请求增加 `GM_xmlhttpRequest` 优先通道、`fetch` 回退（原因：部分插件 iframe 页面可能受宿主 CSP/connect-src 影响出现 `Failed to fetch`，GM 请求在用户脚本环境下更稳定）。
- 决策P：废弃采集器本地 `exportedTexts` 增量游标与采集仓持久化，改为“每次打开页面重新采集、上传不依赖本地已导出状态”（原因：本地状态无法证明远端 CI/PR 链路最终成功；重复文本由翻译脚本过滤 + 云端 `merge-collected` 去重兜底，整体更稳且更省心）。
- 决策Q：新增“上传前域名筛选 + 忽略域名名单（本地设置）”，优先按域名级别降噪，不做逐条编辑器（原因：误采噪音通常以整域名出现；域名级筛选更简单直观、学习成本低、实现成本低、对协作者更友好）。
- 决策R：对于 OverlayLex 自身 UI 文本污染，采用“本地采集阶段排除 + CI 过滤器高置信兜底”双层防线（原因：本地排除可减少上传体积和噪音；CI 兜底可处理旧版脚本或极少数漏网情况）。
- 决策S：ParaTranz 术语增量导入脚本默认使用 `term_key_mode=lower`（原因：实测服务端术语去重行为近似大小写不敏感；若本地按精确大小写做差集会显著高估可导入数量，造成重复上传与统计误差）。
- 决策T：`release-publish` 部署 Worker 前先同步 `main` 的 Worker 运行时代码，并在发布成功后把 `main` 的非包文件回写到 `release`（保留 `src/packages/**` 与 `src/worker/src/data.js`）（原因：`release` 分支长期滞后会导致 CI 用旧 Worker 逻辑覆盖线上接口；但发布产物与包目录元数据仍应以 release 本次结果为准）。
- 决策U：浏览器扩展与 UserScript 不维护两份翻译核心，第一阶段都直接复用现有 `overlaylex.user.js`；待多端构建稳定后再抽 `core + adapter`（原因：先消除发布门槛而不同时引入大规模运行时重写风险）。
- 决策V：WebExtension 商店版权限由现有 domain allowlist 自动生成，不使用 `<all_urls>`（原因：最小权限更符合 Chrome/Edge/Firefox 商店审核，也避免普通用户看到“读取所有网站”这一高风险提示）。
- 决策W：Firefox 当前如实声明 `browsingActivity`（原因：远端翻译包请求能够间接暴露正在使用的受支持插件/域名；在这种架构下声明 `none` 不准确，可能导致 AMO 审核问题）。
- 决策X：WebExtension 第一阶段不重写 legacy runtime 为全异步存储，而是在 WXT content-script 启动时预读 `browser.storage.local` 并建立同步内存桥（原因：以最小改动获得跨域共享扩展存储，同时避免为了发布重写已经长期验证的翻译核心）。
- 决策Y：Firefox reviewer sources 使用 `zip.includeSources` 严格 allowlist，而不是 WXT 默认全工作区来源集合（原因：真实开发目录存在未跟踪术语表、采集临时文件等，与扩展重建无关且不应送交 AMO）。
- 决策Z：Firefox 最低版本统一提高到 `142.0`（原因：当前 manifest 使用的数据收集声明从 142 起进入桌面/Android 一致支持范围；宁可收紧最低版本，也不保留 AMO linter 明确指出的兼容性矛盾）。

## 常见坑 / 复现方法
- 坑1：油猴脚本显示“启用/亮起”不等于翻译流程已生效；脚本可能在域名门禁阶段提前退出。
- 坑2：首次访问目标站点时若后端不可达且本地无缓存，会出现“无悬浮球、无翻译”的静默失败体验。
- 坑3：若页面仅命中全站 `@match` 但未命中本地 seeds，脚本会快速退出；这是预期行为，不是注入异常。
- 坑4：仅用命令行临时加域名而不写入 `wrangler.toml`，后续部署可能出现“配置漂移”；需把域名路由固化到配置文件。
- 坑5：本地 seeds 与 `overlaylex-domain-allowlist` 不一致时，可能出现“远端已放行但本地提前拦截”的假阴性问题。
- 坑5：若无 allowlist 缓存且用户从非 seed 域名直接进入插件页，脚本会按设计快速退出；需先在主站 seed 域名完成首轮冷启动更新。
- 坑6：若用户脚本管理器未授予 `GM_getValue/GM_setValue`，共享缓存会失效并回退为按域 localStorage；需确认脚本头 `@grant` 已生效。
- 坑7：ParaTranz 术语接口批量导入可能对“大小写变体”执行服务端去重/过滤；若本地差集按精确大小写判重，会出现“批次导入成功但远端总量增量明显小于候选数量”的现象。
- 坑8：外部 CSV 可能包含异常拼接行（本次 `5etool.csv` 剩余 1 条长串异常项即此类情况）；即使接口返回成功，服务端也可能静默过滤，需通过回读总量与残留差集再次校验。
- 坑9：`release-publish` 会自动执行 `wrangler deploy` 部署 Worker；若 `release` 分支中的 `src/worker/src/index.js` 落后于 `main`，可能把线上采集上传接口回滚成旧版（例如重新变成 GET-only）。
- 坑10：WXT/`vite-plugin-monkey` 的 Vite peer dependency 必须取交集；本次 `vite-plugin-monkey@8.1.0` 要求 Vite 8，而 WXT 0.21.4 同时兼容 Vite 8，因此使用 Vite 8.2.2。不要用 `--force` 绕过 peer dependency。
- 坑11：GitHub Actions 的 `actions/upload-artifact` 默认会跳过点目录；WXT 产物在 `.output/`，上传步骤必须设置 `include-hidden-files: true`，否则 CI 显示成功但实际 artifact 里可能只有 UserScript。
