# OverlayLex Demo

OverlayLex 是一个面向 Owlbear Rodeo 的用户脚本翻译 demo。  
当前采用“双脚本模式”：
- 主翻译脚本：只负责翻译注入与更新策略。
- 独立采集脚本：只负责实时抽词采集与导出，不参与翻译流程。

## 线上 API（已部署）

- Worker 地址：`https://overlaylex-api.zjhstudio.com`
- R2 桶：`overlaylex-packages-bfdcb419`

## 目录结构

- `src/userscript/overlaylex.user.js`  
  主翻译脚本（生产脚本）：负责缓存、加载、翻译、监听、UI 控制台。

- `src/userscript/overlaylex.collector.user.js`  
  采集脚本（测试脚本）：全站实时采集、按域名去重、增量复制、记录 iframe 域名。

- `src/worker/`  
  Cloudflare Worker demo 后端，提供 `manifest` 与 `package` API。

- `src/packages/obr-www-owlbear-rodeo.json`  
  OBR 主站与房间共用中文包（`owlbear.rodeo` + `www.owlbear.rodeo`）。

- `src/packages/obr-clash-battle-system-com.json`  
  Clash 插件（`clash.battle-system.com`）中文包。

- `src/packages/obr-smoke-battle-system-com.json`  
  Smoke 插件（`smoke.battle-system.com`）中文包。

- `src/packages/obr-outliner-owlbear-rodeo.json`  
  Outliner 插件（`outliner.owlbear.rodeo`）中文包。

- `src/packages/obr-owlbear-hp-tracker-pages-dev.json`  
  HP Tracker 插件（`owlbear-hp-tracker.pages.dev`）中文包。

- `src/packages/overlaylex-domain-seeds.json`  
  本地种子域名规则（用于脚本冷启动前的毫秒级门禁判断）。

## 最小可运行示例（本地流程）

1. 启动 API（Cloudflare Worker 本地开发）

```bash
cd src/worker
npm install
npm run dev
```

2. 修改用户脚本 API 地址  
在 `src/userscript/overlaylex.user.js` 中，把：

```js
apiBaseUrl: "https://overlaylex-demo.example.workers.dev"
```

改成你本地 `wrangler dev` 提供的地址（通常是 `http://127.0.0.1:8787`）。

3. 安装主翻译脚本  
- 打开 Tampermonkey（或 Violentmonkey）新建脚本。  
- 复制 `src/userscript/overlaylex.user.js` 全文并保存。  
- 打开 OBR 页面后，右侧会出现蓝色“译”悬浮球。

4. （可选）安装采集脚本  
- 再新建一个脚本。  
- 复制 `src/userscript/overlaylex.collector.user.js` 全文并保存。  
- 任意页面右侧会出现绿色“采”悬浮球（仅顶层窗口显示一个）。

5. 验证主翻译功能  
- 点击悬浮球，打开控制台。  
- 点击“检查更新”，确认状态提示成功。  
- 点击“重新注入翻译”，观察文本替换。  
- 在“翻译包开关”里勾选/取消，观察是否即时生效。
- 同时验证“仅当前域名包生效”：切换到不同插件域名时，词条按域名包自动切换。

## API 说明

- `GET /health`：健康检查。  
- `GET /manifest`：返回所有翻译包版本与 URL。  
- `GET /packages`：返回包目录元信息。  
- `GET /packages/{id}.json`：返回指定翻译包正文。
- `GET /domain-package.json`：返回域名准入包（调试用）。

## 当前运行策略

1. 主翻译脚本 `overlaylex.user.js` 只负责翻译流程。  
2. 通过域名包做放行判断，未命中时主脚本立即退出。  
3. 通过 manifest 只加载翻译包，域名包独立处理。  
4. 翻译正文从 R2 读取；R2 异常时 Worker 才回退到内置最小包。  
5. 顶层页面注入“译”悬浮球；iframe 页面不重复注入主控制台，但仍可执行翻译。
6. 采集逻辑全部放在 `overlaylex.collector.user.js`，与主翻译脚本彻底分离。

## 运行期采集工作流（协作者推荐：一键上传）

### 协作者流程（无需本地 Node / Git）

1. 启用 `overlaylex.collector.user.js` 后，在目标页面正常操作（点击菜单、悬浮提示、打开插件 iframe）。  
2. 点击绿色“采”悬浮球，首次使用先在“上传设置”中填写：
   - 邀请码（必填）
   - 协作者昵称（可选）
3. 点击主按钮 `一键上传（本页相关）`。  
   - 默认上传范围是“当前页面相关域名已采集英文词条”（顶层 host + 当前页面观察到的 iframe host）
   - 上传前可在“上传前域名筛选”中取消勾选误采域名（例如误采到 GitHub/其他站点）
   - 可将“未勾选域名”写入忽略名单（本地保存），后续默认不勾选；忽略名单只影响一键上传默认勾选，不删除采集数据
   - 支持快捷切换“仅勾选 iframe 域名”，便于插件场景快速排除顶层站点噪音
   - 采集器会在本地尽量排除 OverlayLex 自身 UI（主翻译脚本控制台 / 采集器面板）文本；CI 侧过滤器也会对少量漏网的 OverlayLex 包版本元信息做兜底过滤
   - 若请求体过大，脚本会自动按字节分批上传（避免命中 Worker / GitHub dispatch 上限）
   - 一键上传不依赖本地“已导出游标”；是否重复入库由云端 `merge-collected` 合并去重处理
   - 若该域名尚无本地包，CI 会复用 `merge-collected` 逻辑自动创建新包（与本地手工流程一致）
4. Worker 会校验邀请码并触发 GitHub Actions，自动执行：
   - 基础垃圾词条过滤（页码/容量/hash/url 等高置信噪音）
   - `merge-collected` 合并到 `src/packages/*.json`
   - 自动创建/更新一个采集 PR（提交到 `main` 的候选分支）
5. 维护者审核该 PR（清理漏网无用词条、确认目标包正确）并合并到 `main`。  
6. 合并后现有 `main-paratranz-sync` 会自动把新增英文词条推送到 ParaTranz；后续走正常翻译/回拉/发版流程。

### 本地手工流程（高级 / 离线备选）

1. 启用 `overlaylex.collector.user.js` 后，在目标页面正常操作（点击菜单、悬浮提示、打开插件 iframe）。  
2. 打开绿色“采”悬浮球，在“高级操作”里使用：
   - `复制本域（当前会话）`：仅复制当前域名在当前页面会话里采集到的英文词条（不再依赖本地“已导出”游标）。
   - `复制本域全量`：复制当前域名下所有已采集词条。
   - `复制 iframe 域名`：复制当前页面观察到的 iframe 域名列表。
3. 复制结果粘贴到临时文件 `tmp/collector.selected.json`，并手动删除你不想入库的域名或词条。  
4. 执行本地合并命令，把临时采集 JSON 合并进正式包。  
5. 通过 ParaTranz 协作翻译并回拉。  
6. 合并到 `release` 后自动发包，页面点击“检查更新”即可获取新版本。

说明（采集器本地状态）：
- 采集数据仓默认仅保存在当前页面会话内存中（刷新/重开页面后重新开始采集）。
- 上传设置（邀请码、协作者昵称、UI 位置）仍会本地保存，避免重复配置。

### 采集上传链路（维护者配置）

- Worker 接口：`POST /collector/submissions`
- 触发工作流：`.github/workflows/collector-submission-pr.yml`
- Worker 必需 secrets：
  - `COLLECTOR_INVITE_CODE`
  - `GITHUB_DISPATCH_TOKEN`
  - `GITHUB_REPO_OWNER`
  - `GITHUB_REPO_NAME`
- GitHub Token 最小权限建议（用于 Worker 调用 `repository_dispatch`）：
  - Fine-grained PAT（仓库级）
  - `Actions: Read and write`
  - 仓库访问仅授权当前仓库

## i18n 流程脚本（OverlayLex <-> ParaTranz）

统一入口：`src/tools/overlaylex-i18n-flow.mjs`

```bash
# 1) 把采集 JSON 合并到本地包（新增词条译文默认空字符串）
node src/tools/overlaylex-i18n-flow.mjs merge-collected --input tmp/collector.selected.json

# 2) 先把“要上传到 ParaTranz 的包”放入暂存区（你自己决定上传范围）
git add src/packages/obr-theatre-battle-system-com.json src/packages/obr-smoke-battle-system-com.json

# 2.1) 按暂存区一键：自动 commit + 推送到 ParaTranz（推荐）
# 说明：不再依赖 --changed-only/--base-ref；只处理你暂存的翻译包。
# 先决条件：先设置 PARATRANZ_TOKEN（例如 PowerShell：$env:PARATRANZ_TOKEN="你的Token"）
# 自动 commit message 示例：chore(i18n): submit en theatre,smoke
node src/tools/overlaylex-i18n-flow.mjs push-paratranz --staged-only --commit-staged --project-id 17950

# 3) 一步拉取 ParaTranz 并回写到本地包（推荐，直接可复制）
node src/tools/overlaylex-i18n-flow.mjs from-paratranz --project-id 17950

# 3.0) 可选参数说明
# --out-dir 可不填；默认目录是 .tmp/paratranz
# 如需改目录可写：--out-dir .tmp/paratranz-custom

# 3.1) 等价拆分写法（仅在你需要中间产物调试时使用）
node src/tools/overlaylex-i18n-flow.mjs pull-paratranz --project-id 17950 --out-dir .tmp/paratranz
node src/tools/overlaylex-i18n-flow.mjs from-paratranz --input-dir .tmp/paratranz

# 4) 可选：仅导出 ParaTranz 数组文件到本地目录（用于人工检查中间产物，不上传）
node src/tools/overlaylex-i18n-flow.mjs to-paratranz --out-dir .tmp/paratranz

# 5) 校验 main 分支本地译文改动策略（CI 同款）
node src/tools/overlaylex-i18n-flow.mjs check-local-translation-policy --base-ref origin/main
```

进阶说明（仅 CI/自动化常用）：
- `push-paratranz --changed-only --base-ref <ref>`：按提交历史计算变更包；适合流水线，不适合“本地未提交就想精准上传”的交互场景。

### 采集临时文件格式

`tmp/collector.selected.json` 采用“按域名分组对象 JSON”：

```json
{
  "www.owlbear.rodeo": [
    "Search",
    "Players"
  ],
  "smoke.battle-system.com": [
    "Opacity"
  ]
}
```

### ParaTranz 目标格式

脚本导出的单文件内容为数组，字段固定为：

```json
[
  {
    "key": "host::sha1(original)",
    "original": "source text",
    "translation": "translation text",
    "context": "packageId=...; hosts=...; pathPrefix=/"
  }
]
```

规则：
- 包文件名与 `id` 保持不变。
- `key` 规则：`host::sha1(original)`。
- 回写时默认“空译文不覆盖本地已有译文”。
- `merge-collected` 默认只做新增，不删旧词条（`--prune` 才删除）。

### 译文真源与本地改动规则

- 译文真源是 ParaTranz，不是本地 `src/packages`。
- `main` 允许：
  - 新增 `original`（`translation` 可空或非空，用于 AI 预翻译）。
  - 包结构与元数据改动。
- `main` 禁止：
  - 修改“已存在 original”的 `translation`（会被 CI 阻断）。

## 分支与自动发布（GitHub Actions）

### `main` 分支
- 触发工作流：`.github/workflows/main-paratranz-sync.yml`
- 行为：根据本次 push 的 `base_ref` 计算改动包，自动执行：
  - `check-local-translation-policy --base-ref <ref>`
  - `push-paratranz --changed-only --base-ref <ref>`
- 目的：把英文增量自动同步到 ParaTranz，避免手工逐包上传。

### 每日译文同步 PR（Paratranz -> main）
- 触发工作流：`.github/workflows/paratranz-sync-pr.yml`
- 触发方式：
  - 每天定时自动执行一次（UTC）。
  - 支持 Actions 页面手动触发（`workflow_dispatch`）。
- 行为：
  - `pull-paratranz` -> `from-paratranz`
  - 仅当 `src/packages` 有变化时创建/更新 PR（分支 `bot/paratranz-sync`）
  - 无变化时自动跳过，不会提交空 commit。

### `release` 分支
- 触发工作流：`.github/workflows/release-publish.yml`
- 固定顺序：
  1. 先计算本次 push 相对 `base_ref` 的变更包列表（`src/packages/*.json`）。
  2. 若无变更包：工作流直接跳过发布链路（不发包、不部署）。
  3. 若有变更包：仅对“本次变更包”执行 `pull-paratranz` + `from-paratranz` 漂移检查（有漂移则阻断）。
  4. `verify-release`：校验域名准入包覆盖、Worker `PACKAGE_CATALOG` 版本一致性、且“本次改动包版本号 > 线上版本”。
  5. 仅同步“相对本次 `base_ref` 有改动”的包文件到 R2（整文件覆盖）。
  6. 部署 Worker（`npm run deploy`）。
  7. 冒烟校验线上 `/manifest`。

## 本地一键发布（按暂存区驱动）

新增脚本：`src/tools/release-from-staged.mjs`

```bash
# 在 main 分支执行
# 先在 Git UI 或命令行把“要发布的包文件”加入暂存区
node src/tools/release-from-staged.mjs prepare-from-staged
```

脚本会自动执行：
1. 打印暂存区文件并两次确认（输入 `yes` 才继续）。
2. 仅对“暂存区中的翻译包”做 patch 版本号 +1。
3. 自动维护 `overlaylex-domain-allowlist.json`（补齐所有翻译包 host 覆盖；有变化则自动 bump 版本）。
4. 自动同步 `src/worker/src/data.js` 里的 `PACKAGE_CATALOG` 版本与包目录。
5. 校验“本次待发布包版本号必须高于线上版本”。
6. 自动执行：`main commit -> push main -> cherry-pick 到 release -> push release`。
7. 若 `cherry-pick` 仅在 `src/packages/*.json` 发生冲突：自动采用 `main` 提交版本（`--theirs`）并 `cherry-pick --continue`；若出现非包文件冲突则停止并提示人工处理。

说明：
- 该流程不再依赖“云端自动 bump 版本”；版本统一在本地发布脚本阶段完成，避免 `main/release` 版本漂移。
- 发布上传是“整文件覆盖”，但文件集合只取本次 Git 改动包，不会全量重传全部包。
- 发布包选择权在你手里：脚本只会把“你暂存的翻译包”加入发布目录（`PACKAGE_CATALOG`），不会按译文内容自动替你筛选。
- 工作区可以不干净：脚本不会强制你清空其他改动；提交时只会包含“你原始暂存的包 + 自动维护的 `overlaylex-domain-allowlist.json` + `src/worker/src/data.js`”。
- 默认自动 `stash`：在 `main push` 后、切换到 `release` 前，脚本会自动暂存当前未暂存/未跟踪改动，并在发布流程结束后自动恢复，减少“切分支失败（本地有开发中改动）”中断；如需关闭可传 `--no-auto-stash`。
- 若脚本提示“检测到 cherry-pick 仍在进行”，说明遇到了非包文件冲突并保留了现场；请按提示手动解决后执行 `git cherry-pick --continue`（或 `--abort`）。

## CI Secrets 配置

在 GitHub 仓库 Secrets 中配置：
- `PARATRANZ_TOKEN`
- `PARATRANZ_PROJECT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `R2_BUCKET_NAME`

本地命令也可复用同名环境变量（尤其是 `PARATRANZ_TOKEN`）。

`PARATRANZ_TOKEN` 读取规则：
- 默认读取环境变量名 `PARATRANZ_TOKEN`。
- 若你在 `config/overlaylex-i18n.config.json` 里把 `paratranz.tokenEnv` 改成别的名字，脚本会读取你配置的新名字。

## 当前实现的取舍

- 优先稳定与简单：采用“精确字符串命中”翻译，不做复杂 NLP。  
- 优先性能：MutationObserver 仅处理变更节点，不整页重复刷。  
- 可扩展点：
  - 增加 `iframe` 专用策略（跨域 iframe 受同源策略限制）。
  - 增加“正则词条”或“变量模板词条”（如 `HP: {n}`）。
  - 增加多语言包（`zh-CN` / `ja-JP`）与优先级机制。
