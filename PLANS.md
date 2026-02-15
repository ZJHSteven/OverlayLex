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
