# Firefox AMO 源码审查说明

OverlayLex 的 Firefox 扩展由 WXT 构建，发布包不包含远程可执行 JavaScript。运行时会从 OverlayLex API 获取 JSON 翻译数据，但扩展逻辑本身全部来自本源码包。

## 构建环境

- Node.js 22 或更新版本。
- npm（随 Node.js 提供）。
- 其余构建依赖由 `package-lock.json` 固定并通过 npm 安装。

## 重建 Firefox 扩展

在源码包根目录执行：

```bash
npm ci
npm run build:firefox
```

构建后的 Firefox Manifest V3 扩展位于：

```text
.output/firefox-mv3/
```

如需重新生成送审 ZIP：

```bash
npm run zip:firefox
```

## 关键源码

- `entrypoints/overlay.content.ts`：WXT content-script 入口；初始化扩展级 `browser.storage.local` 桥后加载共享翻译运行时。
- `src/userscript/overlaylex.user.js`：Chrome / Edge / Firefox / UserScript 共用的唯一翻译运行时。
- `src/packages/overlaylex-domain-allowlist.json`：构建时生成最小 host 访问范围的域名规则。
- `wxt.config.ts`：浏览器 manifest、Firefox 数据声明、打包范围配置。

## AMO linter 说明

当前 `web-ext lint` 对构建产物应为 `0 errors`。运行时仍会出现针对动态 `innerHTML` 的安全提示；对应代码只用于 OverlayLex 自己的固定控制台模板和固定内置 SVG 图标，不会把网页文本、翻译包内容或用户输入拼接到这些 HTML 模板中。网页/翻译文本的替换走 DOM 文本节点和属性写入路径，不通过该 `innerHTML` 模板。

源码包刻意不包含翻译数据全集、采集器、ParaTranz 工具、Cloudflare Worker、临时采集文件或开发者个人数据，因为它们不参与 Firefox 扩展 JavaScript 的构建。
