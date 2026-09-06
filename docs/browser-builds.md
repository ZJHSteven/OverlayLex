# OverlayLex 多端构建

OverlayLex 现在使用一套运行时源码同时生成 UserScript 与 WebExtension 产物。

## 构建技术栈

- `vite-plugin-monkey`：生成 Tampermonkey / ScriptCat / Violentmonkey / Greasemonkey 可安装 UserScript。
- `WXT`：基于 Vite 生成 Chrome、Microsoft Edge、Firefox 的 Manifest V3 WebExtension。
- `src/userscript/overlaylex.user.js`：迁移第一阶段仍作为唯一运行时实现，WXT 与 UserScript 构建都复用它，避免出现两份翻译核心。

## 目录

```text
OverlayLex/
├─ entrypoints/
│  └─ overlay.content.ts       # WXT content-script 入口
├─ src/userscript/
│  ├─ overlaylex.user.js       # 当前共享运行时
│  └─ overlaylex.entry.js      # UserScript 构建入口
├─ vite.userscript.config.js   # vite-plugin-monkey
├─ wxt.config.ts               # Chrome / Edge / Firefox
├─ package.json
└─ .github/workflows/build-validate.yml
```

## 常用命令

```bash
npm install
npm run build:userscript
npm run build:chrome
npm run build:edge
npm run build:firefox
npm run build:all
```

商店 ZIP：

```bash
npm run zip:chrome
npm run zip:edge
npm run zip:firefox
```

WXT 产物位于 `.output/`；UserScript 位于 `dist/userscript/`。

## 权限策略

WebExtension 不申请 `<all_urls>`。`wxt.config.ts` 会读取 `src/packages/overlaylex-domain-allowlist.json`，在构建 manifest 时自动把当前已支持的 Owlbear Rodeo 与扩展域名写进 `content_scripts.matches`。

因此：

- 翻译包内容变化不需要扩大浏览器权限；
- 新增第三方插件域名时，只维护现有 OverlayLex allowlist；
- `all_frames: true` 保留，因为 Owlbear 第三方扩展通常在 iframe 中运行；
- 运行时仍有 OverlayLex 自己的域名门禁，manifest 权限与运行时门禁形成双层限制。

## Firefox 数据声明

Firefox 构建当前声明 `browsingActivity` 为 required data collection。原因是 OverlayLex 会向自己的 API 请求与当前支持域名/插件对应的翻译包；即使页面文本本身不上传，这个请求也可能让服务端推知正在使用的受支持 Owlbear/插件域名，因此不应错误声明为 `none`。

Firefox 最低版本设为 `142.0`。这是因为当前使用的 `browser_specific_settings.gecko.data_collection_permissions` 在 Firefox / Firefox for Android 142 起才进入 AMO lint 的完整支持范围；提高最低版本可以避免“声明了新 manifest 能力、却声称支持更旧版本”的不一致。

后续如果把翻译包完全随扩展离线打包，或把远端请求设计成无法识别当前插件的统一匿名资源，再重新评估是否可降为 `none`。

## WebExtension 存储适配

Chrome / Edge / Firefox 构建现在显式申请最小的 `storage` 权限，并使用 `browser.storage.local` 保存 OverlayLex 设置与缓存。

为继续复用现有同步 UserScript runtime，WXT content-script 入口会先异步读取扩展存储，再建立一个同步内存桥，最后才加载 `overlaylex.user.js`。运行时因此可以保持原有同步初始化结构，同时不同来源的 Owlbear 插件 iframe 会共享同一份扩展级缓存，不再退化为各域独立的页面 `localStorage`。

UserScript 构建不受影响：Tampermonkey / Violentmonkey 等环境仍优先使用 `GM_getValue` / `GM_setValue`，没有 GM API 时才使用页面 `localStorage` 作为最后兜底。

## 下一阶段源码拆分

当前阶段优先保证多端产物来自同一个已验证运行时。后续再把单体脚本拆成：

```text
src/core/              # 翻译、MutationObserver、UI、网络包逻辑
src/adapters/userscript/
src/adapters/webext/
```

其中第一阶段的 WebExtension storage 适配已经通过 WXT 入口同步桥完成；后续再抽 `core + adapter` 时，可以把这层桥正式收敛为独立 adapter，而无需改变现有数据语义。
