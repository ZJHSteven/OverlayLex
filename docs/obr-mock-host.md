# OBR Mock Host / Extension E2E Harness

## 它解决什么问题

Owlbear Rodeo Extension 本质上是由 Owlbear 通过 iframe 加载的网页应用。传统测试通常需要：登录 Owlbear、进入房间、安装开发扩展、手工制造 Scene/Token/权限状态，再逐个点 UI。

本项目的 OBR Mock Host 用一个本地父页面模拟 Owlbear 宿主，通过与 Extension SDK 相同的 `postMessage` 通道发送 `OBR_READY` 并响应常见 SDK 请求。Playwright 因而可以直接启动扩展生产页面，完成自动化 E2E、SDK UI 注册截获和可翻译文案采样。

这套基础设施不要求扩展源码属于 OverlayLex；只要扩展使用标准 Owlbear Extension SDK 通信方式，就可以拿来做兼容性实验。

## 当前能力

- 构造合法的 `obrref` 并发送 `OBR_READY`。
- 模拟常用 Scene / Scene Items / Scene Local / Player / Party / Room / Theme / Grid / Fog / Viewport getter。
- 对常见写操作返回 ACK，并把真正未知的带 nonce 请求收集到 `unhandledRequestIds`。
- 记录 Context Menu、Tool、Tool Mode、Tool Action、Popover、Modal、Notification、Action 等 SDK UI 注册 payload。
- 递归采样普通 DOM 文本、ARIA/placeholder/title/alt 与 open Shadow DOM 文本。
- 保存完整 SDK 消息、运行时文案、SDK 文案、页面错误、截图和 JSON 报告。
- 允许通过 fixture 覆盖玩家角色、Scene Ready、metadata、items、fog、grid 和任意 SDK response。
- 允许扩展专用 runner 通过 `explore` 回调实现导航、点击和状态展开。

## 最快的本地用法

实验分支为了避免给 OverlayLex 的普通构建增加 Playwright 依赖，没有把 Playwright 固定加入根 `devDependencies`。第一次本机运行时安装实验依赖和浏览器：

```powershell
npm install --no-save --ignore-scripts --package-lock=false playwright@1.55.0
npx playwright install chromium
```

然后直接给出扩展页面：

```powershell
node src/tools/obr-mock-run.mjs https://example.com/action/ `
  --out .harvest/example `
  --expect-clean
```

如果想看真实窗口：

```powershell
node src/tools/obr-mock-run.mjs https://example.com/action/ `
  --out .harvest/example-headed `
  --headed
```

## 用 fixture 构造测试状态

例如 `tests/fixtures/player-with-token.json`：

```json
{
  "sceneReady": true,
  "player": {
    "id": "player-1",
    "role": "PLAYER",
    "name": "Mock Player",
    "selection": ["token-1"]
  },
  "sceneMetadata": {
    "example/feature-enabled": true
  },
  "sceneItems": [
    {
      "id": "token-1",
      "type": "IMAGE",
      "name": "Test Token",
      "metadata": {}
    }
  ]
}
```

运行：

```powershell
node src/tools/obr-mock-run.mjs https://example.com/action/ `
  --fixture tests/fixtures/player-with-token.json `
  --out .harvest/example-player `
  --expect-clean
```

如果某个扩展调用了当前 Mock 尚未覆盖的 getter，报告会把 ID 放进 `unhandledRequestIds`。推荐根据真实调用按需补 fixture/默认 response，而不是为了“看起来完整”提前实现整个 Owlbear SDK。

## 需要自动点 UI 时

通用 CLI 只采初始状态。复杂扩展应该参考 `src/tools/obr-mock-smoke.mjs` 写一层很薄的 runner：

```js
import { runObrMockHost } from './obr-mock-host.mjs';

async function exploreMyExtension({ frame, snapshot, initialSnapshot }) {
  const snapshots = [initialSnapshot];

  await frame.getByRole('button', { name: 'Settings' }).click();
  await frame.waitForTimeout(500);
  snapshots.push(await snapshot(frame, 'settings'));

  return {
    snapshots,
    navigationErrors: []
  };
}

await runObrMockHost({
  targetPage: 'https://example.com/action/',
  outDir: '.harvest/my-extension',
  explore: exploreMyExtension
});
```

宿主协议、浏览器生命周期、SDK 消息记录、ARIA/Shadow 采样都留在 core；runner 只描述“这个扩展应该怎么探索”。

## Smoke & Spectre 5.0.2 本机验证基线

2026-09-10 在 Windows 本机实际运行结果：

- manifest：Smoke & Spectre `5.0.2`。
- 静态资源图：73 个资源节点，其中 62 个文本资源。
- 原始静态候选：4362 条。
- Mock Host：82 条 SDK 消息，37 种消息类型。
- SDK UI 注册：30 次。
- SDK 高置信 UI 文案：42 条。
- Mock DOM/ARIA/Shadow 文案：72 条。
- `unhandledRequestIds=[]`。
- `pageErrors=[]`，`navigationErrors=[]`。
- i18n catalog 250 + SDK 42 + Mock DOM 72，去重后得到 292 条主语料；其中 264 条是旧 Smoke 包未覆盖的新词。

这说明 Mock Host 已覆盖 Smoke 当前实际用到的 SDK 请求集合，但**不能据此宣称覆盖整个 Owlbear Extension SDK**。更准确的工程策略是：让真实扩展驱动 Mock 的能力增长，并持续把未知 getter 作为测试失败或待补 fixture 显式暴露。

## 输出文件

每次运行会在 `--out` 目录生成：

```text
mock-report.json       # 总报告
messages.json          # 所有扩展 -> 宿主 SDK 消息
sdk-ui-strings.json    # 从 SDK 注册 payload 抽出的高置信 UI 文案
runtime-text.json      # DOM / ARIA / Shadow DOM 文案
mock-host.png          # 整体页面截图
screenshots/           # explore 产生的逐状态截图
```

`.harvest/` 已加入 `.gitignore`，本地测试结果不会污染仓库。
