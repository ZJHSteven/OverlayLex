# OverlayLex Demo

OverlayLex 是一个面向 Owlbear Rodeo 的用户脚本翻译 demo。  
当前采用“双脚本模式”：
- 主翻译脚本：只负责翻译注入与更新策略。
- 独立采集脚本：只负责实时抽词采集与导出，不参与翻译流程。

## 线上 API（已部署）

- Worker 地址：`https://overlaylex-demo-api.zhangjiahe0830.workers.dev`
- R2 桶：`overlaylex-packages-bfdcb419`

## 目录结构

- `src/userscript/overlaylex.user.js`  
  主翻译脚本（生产脚本）：负责缓存、加载、翻译、监听、UI 控制台。

- `src/userscript/overlaylex.collector.user.js`  
  采集脚本（测试脚本）：全站实时采集、按域名去重、增量复制、记录 iframe 域名。

- `src/worker/`  
  Cloudflare Worker demo 后端，提供 `manifest` 与 `package` API。

- `src/packages/obr-room-core.json`  
  第一版房间页示例翻译包。

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

## 运行期采集工作流（推荐）

1. 启用 `overlaylex.collector.user.js` 后，在目标页面正常操作（点击菜单、悬浮提示、打开插件 iframe）。  
2. 打开绿色“采”悬浮球，在采集面板里使用：
   - `复制本域增量`：仅复制当前域名下“未导出过”的新词条。
   - `复制本域全量`：复制当前域名下所有已采集词条。
   - `复制 iframe 域名`：复制当前页面观察到的 iframe 域名列表。
3. 复制结果直接粘贴给我翻译。  
4. 翻译后并入正式包（如 `src/packages/obr-room-core.json`）。  
5. 更新后端包版本号，再在页面里点击“检查更新”完成热更新。

## 当前实现的取舍

- 优先稳定与简单：采用“精确字符串命中”翻译，不做复杂 NLP。  
- 优先性能：MutationObserver 仅处理变更节点，不整页重复刷。  
- 可扩展点：
  - 增加 `iframe` 专用策略（跨域 iframe 受同源策略限制）。
  - 增加“正则词条”或“变量模板词条”（如 `HP: {n}`）。
  - 增加多语言包（`zh-CN` / `ja-JP`）与优先级机制。
