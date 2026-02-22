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
