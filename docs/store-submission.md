# OverlayLex 浏览器商店提交材料

## 产品名称

**OverlayLex 枭熊汉化**

## 单一用途（Single Purpose）

为 Owlbear Rodeo 及 OverlayLex 已适配的第三方扩展提供运行时中文界面翻译。

## 简短描述

为 Owlbear Rodeo 与常用扩展提供中文覆盖翻译，无需安装 UserScript 管理器。

## Edge 商店长描述

OverlayLex 是面向 Owlbear Rodeo 及其第三方扩展的中文界面翻译扩展。安装后，它只会在已明确适配的 Owlbear Rodeo 与扩展域名中运行，在浏览器本地扫描当前界面的可见文本，并使用人工维护的中文翻译词典替换显示内容。它支持动态加载界面和第三方扩展 iframe，无需另外安装 Tampermonkey 等 UserScript 管理器。

翻译匹配与 DOM 替换都在本地完成；网页正文、地图、Token、笔记、聊天内容、表单和账号凭据不会被上传。扩展会通过 HTTPS 从 OverlayLex 自有服务获取域名白名单、manifest 与翻译 JSON，以便在不重新发布扩展程序的情况下更新人工翻译。远端只提供数据，不提供或执行远程 JavaScript。

OverlayLex 不包含广告、遥测或用户画像功能。扩展仅申请实现翻译所必需的已支持站点访问权限，以及用于跨域 iframe 共享翻译缓存和用户设置的本地 `storage` 权限。

## 功能说明

OverlayLex 在受支持的 Owlbear Rodeo 页面和第三方扩展 iframe 中读取当前页面可见文本，在浏览器本地匹配翻译词条并替换显示内容。翻译引擎随扩展发布；翻译数据通过 OverlayLex API 获取并缓存，以便无需重新发布扩展即可更新人工翻译。

## 权限理由

### 网站访问权限

扩展只声明 `src/packages/overlaylex-domain-allowlist.json` 中已经支持的 Owlbear Rodeo / 第三方扩展域名，不申请 `<all_urls>`。

这些 host 权限用于：

1. 在 Owlbear Rodeo 主页面执行翻译；
2. 在第三方扩展 iframe 中执行翻译；
3. 让 MutationObserver 能处理动态加载的界面文本。

`all_frames: true` 是核心功能所必需，因为 Owlbear Rodeo 的第三方扩展通常通过 iframe 加载。

## 隐私与数据处理说明

- 页面可见文本的扫描、词条匹配与 DOM 替换在用户浏览器本地完成；OverlayLex 不把扫描到的页面正文上传到翻译 API。
- 扩展会访问 `overlaylex-api.zjhstudio.com` 获取 manifest、域名准入信息和翻译包。
- 翻译包请求可能间接表明用户正在使用哪个 OverlayLex 已支持的 Owlbear/第三方扩展域名，因此 Firefox 构建按当前 AMO 数据分类规则声明 `browsingActivity`，而不是错误声明 `none`。
- OverlayLex 不包含广告 SDK，不出售用户数据，不进行跨站广告追踪，也不要求 OverlayLex 用户账户。
- 设置、缓存和翻译包保存在本地浏览器存储中；WebExtension 版使用 `browser.storage.local` 在 Owlbear 主站和不同来源的第三方插件 iframe 之间共享缓存，UserScript 版使用脚本管理器提供的 GM storage。
- 托管/CDN/安全基础设施可能生成正常的网络访问日志；项目本身不以建立用户画像为目的使用这些日志。

## Firefox reviewer notes

构建命令：

```bash
npm install
npm run zip:firefox
```

WXT 会同时生成 Firefox 扩展 ZIP 与 sources ZIP。构建使用 Node.js 22、WXT、Vite 和 vite-plugin-monkey；依赖均由 npm 获取。

验证方法：

1. 安装生成的 Firefox 扩展；
2. 打开 Owlbear Rodeo；
3. 页面应出现 OverlayLex 的蓝色“译”悬浮球；
4. Owlbear 主页面已适配文本应显示中文；
5. 打开已适配的第三方扩展后，其 iframe 内文本也应被翻译。

Firefox extension id：`overlaylex@zjhstudio.com`。

补充说明：AMO linter 当前仅报告 3 条 `innerHTML` warning。这些位置只用于 OverlayLex 自己固定的控制台 HTML 与内置 SVG 图标模板，不拼接网页正文、远端翻译数据或用户输入；扩展没有远程可执行代码。

## Edge reviewer notes

构建命令：

```bash
npm install
npm run zip:edge
```

扩展为 Manifest V3，所有 JavaScript 逻辑均随 ZIP 打包。远端服务器只返回翻译 JSON/manifest 数据，不下发可执行 JavaScript。

建议 certification notes：

1. OverlayLex 的单一用途是为 Owlbear Rodeo 与已适配第三方扩展提供中文 UI 翻译；
2. 打开 `https://www.owlbear.rodeo/` 后应出现 OverlayLex 蓝色“译”悬浮球；
3. 页面正文扫描、匹配与替换全部在本地执行，远端只获取 JSON manifest/allowlist/翻译包；
4. 第三方 Owlbear 扩展通常以 iframe 加载，因此 `all_frames: true` 是核心功能所需；
5. 扩展不含广告、分析遥测或远程 JavaScript。

## 首发资源

- 隐私政策：仓库根目录 `PRIVACY.md`；推送后公开 URL 为 `https://github.com/ZJHSteven/OverlayLex/blob/main/PRIVACY.md`。
- 商店 Logo 源文件：`assets/store/overlaylex-store-icon.svg`；Edge 上传使用同图形导出的 300×300 PNG。
- Firefox reviewer source 构建说明：`SOURCE_CODE_REVIEW.md`。
- Firefox extension id：`overlaylex@zjhstudio.com`。
- 许可证：仓库当前未声明开源许可证，因此商店首发选择 `All Rights Reserved` / `all-rights-reserved`，不额外授予未声明的代码许可。

## 2026-09-07 发布前实机回归

- Chrome for Testing 153：Owlbear 主站注入、跨域共享设置、Smoke 顶层词条与 Clash iframe 翻译通过。
- Microsoft Edge 152：Owlbear 主站注入、跨域共享设置、Smoke 顶层词条与 Clash iframe 翻译通过。
- Firefox 155：通过 `web-ext` 安装成品后，Owlbear 主站显示 `重注入完成，替换 8 处文本。`；确定性跨域夹具中 `Alignment -> 适配地图`，Clash iframe 中 `Loading... / Settings -> 加载中… / 设置`，确认 Firefox `all_frames` 翻译链通过。
- Firefox `web-ext lint`：0 errors；剩余 3 条均为内部固定 UI `innerHTML` 模板 warning。
- Firefox reviewer source ZIP：已在独立干净目录执行 `npm ci` + `npm run build:firefox`，重建产物与正式构建关键文件 SHA-256 一致。
- UserScript：0.2.17 相对 0.2.16 只增加 WebExtension storage bridge 与版本号；UserScript 环境不存在该 bridge，因此仍沿用原有 GM storage 路径。重新构建产物通过 `node --check`。
- 线上运行时 `/manifest` 与所有 package URL 均指向 `https://overlaylex-api.zjhstudio.com/packages/...`，不依赖 GitHub Raw 拉取汉化包。

## 送审状态

- Mozilla Add-ons 开发者账户：已注册。
- Microsoft Edge Partner Center 开发者账户：已注册。
- 商店图标：已准备；Edge 截图为可选项，首发不作为阻塞条件。
- 隐私政策：已落仓，待本次提交推送后获得稳定公开 URL。
- 下一步：推送本次首发准备提交，等待 GitHub Actions 构建通过，然后上传 Firefox AMO 与 Edge Partner Center 并提交审核。
