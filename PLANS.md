# ExecPlan

## 任务：优化 OverlayLex 首次可用性与失败可见性（2026-02-15）

1. 内置域名 seeds 到主脚本
- 目标：把“首层快速门禁”直接放在用户脚本内，避免首次依赖远端包。
- 预期：非目标站点毫秒级退出；目标站点才进入后续流程。

2. 保留并强化远端域名 allowlist
- 目标：seeds 仅用于快速放行；真正准入仍由远端 `domain-allowlist` 控制。
- 预期：不破坏现有包化策略与后端动态更新能力。

3. 增加后端失败提示（小气泡）
- 目标：在“自动更新 / 手动刷新 / 首次冷启动无缓存且拉取失败”时给出可视提示。
- 预期：用户能明确感知“后端不可达”，避免“脚本亮但无效果”的误判。

4. 更新文档与记录
- 目标：同步 `CHANGELOG.md` 与 `PROGRESS.md`，保证团队记忆完整。
- 预期：下次迭代能直接接续，不丢上下文。

## 当前执行状态
- [x] Step 1: 建立执行计划并落盘
- [x] Step 2: 修改 `src/userscript/overlaylex.user.js`
- [x] Step 3: 更新 `CHANGELOG.md` 与 `PROGRESS.md`
- [x] Step 4: 提交（不包含 `src/packages/obr-theatre-battle-system-com.json`）

---

## 任务：采集脚本 UI 重构 + 一键上传触发采集 CI 自动 PR（2026-02-22）

1. 采集脚本 UI 重构
- 目标：对齐正式脚本悬浮球/面板体验，支持面板拖动、外部点击关闭、状态分级提示。
- 预期：协作者只看到一个主上传按钮，高级复制/清理能力折叠收纳。

2. 采集上传 Worker 中转
- 目标：新增 `POST /collector/submissions`，邀请码校验后直接触发 GitHub `repository_dispatch`（不做 R2 临时存储）。
- 预期：前端无需 GitHub Token；Worker 只做鉴权与转发。

3. 采集 CI 自动 PR
- 目标：新增 GitHub Actions 工作流，执行“过滤 -> merge-collected -> 自动 PR”。
- 预期：每次上传对应独立 PR，PR 描述包含过滤统计与包变更摘要。

4. 文档、部署与验证
- 目标：同步 `README.md` / `PROGRESS.md` / `CHANGELOG.md`，并完成 Worker 部署与接口回归测试。
- 预期：协作者与维护者都能按文档完成配置与使用。

## 当前执行状态（2026-02-22）
- [x] Step 1: 重构 `src/userscript/overlaylex.collector.user.js` UI 与上传入口
- [x] Step 2: 新增 Worker 上传接口（邀请码校验 + `repository_dispatch`）
- [x] Step 3: 新增 `collector-sanitize` 与采集 PR 工作流
- [x] Step 4: 更新文档与项目状态记录
- [x] Step 5: Worker 部署与线上测试（当前缺少 secrets，上传接口返回 `SERVER_NOT_CONFIGURED` 属预期）

---

## 任务：将 `5etool.csv` 术语表增量导入 ParaTranz 项目（不覆盖已有术语）（2026-02-24）

1. 明确数据格式与导入边界
- 目标：确认 `5etool.csv` 编码、列映射、重复项与冲突项情况，避免导入中途因脏数据失败。
- 预期：得到稳定的字段映射规则与冲突处理策略（至少可生成人工复核清单）。

2. 实现增量导入脚本（本地差集优先）
- 目标：脚本自动读取 CSV、拉取远端术语列表、计算差集、生成导入 JSON，并支持 dry-run / real-run。
- 预期：只上传“远端不存在”的术语，避免覆盖现有术语。

3. 执行导入与回读校验
- 目标：先预演（dry-run），再真实导入，最后回读确认新增数量与失败项。
- 预期：导入完成且有清晰统计（总行数、冲突数、去重后数量、远端已存在数、新增导入数）。

4. 更新文档与记录
- 目标：更新 `PROGRESS.md` 记录本次导入结论、使用方式与常见坑。
- 预期：后续再导入同类术语表时可直接复用。

## 当前执行状态（2026-02-24）
- [x] Step 1: 确认 ParaTranz 术语相关接口（`getTerms` / `createTerm` / `importTerms`）与 CSV 基本结构
- [x] Step 2: 实现 CSV 术语增量导入脚本（`src/tools/paratranz_terms_incremental_import.py`）
- [x] Step 3: Dry-run 生成差集与冲突报告（确认项目 `17950` 可访问）
- [x] Step 4: 执行真实导入并回读校验（44 批全部成功）
- [x] Step 5: 更新 `PROGRESS.md` 并完成提交

## 执行结果摘要（2026-02-24）
- 导入对象：`5etool.csv`（`GB18030`，无表头，5 列）
- 实际项目：ParaTranz `projectId=17950`
- 首轮导入执行结果：44 批成功，提交 43222 条候选；回读发现 ParaTranz 实际按更严格（近似大小写不敏感）规则去重，远端总量从 42 增至 38249（净增 38207）
- 脚本修正：新增 `--term-key-mode`（默认 `lower`），使本地差集统计与 ParaTranz 实际行为更一致
- 复核结果：修正后 dry-run 仅剩 3 条候选（其中包含 1 条明显异常拼接行 + 2 条特殊字符术语）；再次尝试导入后服务端接受请求但远端总量未变化（推测被服务端去重/过滤）
- 冲突处理策略：本次使用 `--conflict-policy skip`，跳过 761 个冲突键（同术语不同内容），避免误覆盖或错误选译

---

## 任务：统一 UserScript + 多浏览器 WebExtension 构建链（2026-08-25）

1. 建立共享源码层
- 目标：把翻译核心、网络加载、DOM 观察、UI 与缓存逻辑从单体 UserScript 中逐步抽出，避免 UserScript 与浏览器扩展维护两份实现。
- 预期：共享核心只维护一份，运行时差异通过 adapter 解决。

2. 引入双构建器
- WebExtension：使用 WXT（底层 Vite）统一构建 Chrome / Edge / Firefox。
- UserScript：使用 `vite-plugin-monkey` 构建 Tampermonkey / ScriptCat / Violentmonkey / Greasemonkey 可安装脚本。
- 预期：根目录统一 package scripts，一次命令可生成所有发布产物。

3. 兼容当前 OverlayLex 行为
- 目标：保留快速域名门禁、iframe 支持、远端 manifest/package、R2/Worker 后端与故障提示。
- 预期：迁移后现有 UserScript 功能不回退。

4. 加入自动构建验证与发布准备
- 目标：CI 验证 UserScript、Chrome、Edge、Firefox 四类产物；为后续商店自动提交预留配置。
- 预期：每次核心改动都能提前发现多端构建错误。

5. 发布账户与商店准备
- 目标：检查 Mozilla Add-ons 与 Microsoft Edge Add-ons 开发者注册流程，尽可能完成到无需人工身份验证的最后一步。
- 预期：明确哪些步骤可自动完成、哪些必须由账户本人交互。

## 当前执行状态（2026-08-25）
- [x] Step 1: 建立 ExecPlan 并创建独立功能分支 `feat/unified-browser-builds`
- [ ] Step 2: 共享源码复用已完成；WebExtension `browser.storage` adapter 留作第二阶段（当前扩展版可构建运行，但 GM 共享存储会回退到按域 localStorage）
- [x] Step 3: 接入 WXT 与 `vite-plugin-monkey`
- [x] Step 4: 生成并远端验证 UserScript / Chrome / Edge / Firefox 多端构建与 ZIP 产物
- [ ] Step 5: CI / PROGRESS / 构建与商店文档已更新；CHANGELOG / README 收尾中
- [x] Step 6: 已核验 Firefox AMO 与 Edge Partner Center 当前注册/提交流程；可自动完成部分已完成，首次账户身份认证必须由账户本人交互

## 本轮验证记录（2026-08-25）
- 首轮 CI 发现 `vite-plugin-monkey@8.1.0` 与 Vite 7 peer dependency 冲突；改用同时满足 WXT 与 vite-plugin-monkey 的 Vite 8.2.2 后依赖安装通过。
- 第二轮 CI 完成 UserScript、Chrome MV3、Edge MV3、Firefox MV3 构建与三端 ZIP 打包。
- 商店版权限从测试期 `<all_urls>` 收紧为由 `overlaylex-domain-allowlist.json` 自动生成的 host 列表；CI 阻止权限意外回退到 `<all_urls>`。
- Firefox 构建设置稳定 extension id，并按远端翻译包请求的真实数据行为声明 `browsingActivity`。
- 手工检查真实 UserScript 产物发现 Vite 拼接产生 `"use strict"(function...)` 的运行时 TypeError；已加入显式 IIFE statement boundary 修复，并在 CI 增加回归检查。
- 原 `release-publish.yml` 的 `steps:` 被错误嵌套在 `env:` 下，导致 workflow 无法解析；已仅修正 YAML 层级，保留原 release 行为。

---

## 任务：多浏览器正式发布前收尾与送审（2026-09-06）

1. 同步真实工作区
- 目标：将 `D:\Workspace\DnD5e\OBR2\OverlayLex` 的 `main` 快进到 GitHub 最新 `origin/main`，保留本地未跟踪资料。
- 预期：本地工作区与已合并的 WXT / UserScript 多端构建迁移保持一致。

2. 修复 WebExtension 存储适配与过期发布文档
- 目标：让浏览器扩展环境优先使用 `browser.storage` / `chrome.storage` 的扩展级共享存储，同时保留 UserScript 的 GM 存储路径；清理 README 中已经失效的 `cherry-pick` 发布说明。
- 预期：Chrome / Edge / Firefox iframe 间的 OverlayLex 配置与 allowlist 缓存不再退化为按域隔离的页面 `localStorage`，文档与真实 release 按文件同步逻辑一致。

3. 完整构建与安装级回归
- 目标：运行 UserScript + Chrome + Edge + Firefox 全量构建、静态校验与 ZIP 打包；尽可能在真实/临时浏览器 profile 中安装成品并验证 Owlbear 主站、iframe、翻译 UI、更新与缓存路径。
- 预期：正式送审前确认多端行为无明显回归，而不是只验证 manifest 能生成。

4. 商店发布准备与实际送审
- 目标：核对 Firefox AMO 与 Microsoft Edge Add-ons 的当前官方首发/更新流程；优先使用已登录的开发者后台或官方 API，补齐能够自动生成的元数据、审查说明和构建材料，并在账户权限允许时直接提交审核。
- 预期：能自动完成的步骤本轮直接完成；若遇到必须本人完成的协议确认、二次验证或首发后台专属字段，则保留已填写草稿并准确记录阻塞点。

## 当前执行状态（2026-09-06）
- [x] Step 1: 本地 `main` 已 fast-forward 到 `origin/main`，本地 `5etool.csv` 保持未跟踪、未修改。
- [ ] Step 2: WebExtension storage adapter 与 README 旧发布说明收尾。
- [ ] Step 3: 多端构建、ZIP 与安装级回归。
- [ ] Step 4: Firefox AMO / Edge Add-ons 发布与送审。
