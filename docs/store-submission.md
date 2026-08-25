# OverlayLex 浏览器商店提交材料

## 产品名称

**OverlayLex 枭熊汉化**

## 单一用途（Single Purpose）

为 Owlbear Rodeo 及 OverlayLex 已适配的第三方扩展提供运行时中文界面翻译。

## 简短描述

为 Owlbear Rodeo 与常用扩展提供中文覆盖翻译，无需安装 UserScript 管理器。

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
- 设置、缓存和翻译包保存在本地浏览器存储中；当前迁移第一阶段的 WebExtension 运行时在 GM API 不存在时会回退到页面 localStorage，后续将迁移为 WebExtension storage adapter。
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

## Edge reviewer notes

构建命令：

```bash
npm install
npm run zip:edge
```

扩展为 Manifest V3，所有 JavaScript 逻辑均随 ZIP 打包。远端服务器只返回翻译 JSON/manifest 数据，不下发可执行 JavaScript。

## 发布前仍需补齐

- 商店图标与截图；
- 对外可访问的隐私政策 URL（可以使用 zjhstudio.com 或仓库文档页面）；
- Mozilla Add-ons 开发者账户；
- Microsoft Edge Partner Center 开发者账户；
- 若审核需要登录 Owlbear 才能复现完整功能，准备 reviewer test instructions / 测试账户方案。
