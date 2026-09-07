# OverlayLex Privacy Policy / OverlayLex 隐私政策

**Effective date / 生效日期：2026-09-07**

This policy applies to the OverlayLex browser extension distributed through Firefox Add-ons and Microsoft Edge Add-ons. It does not cover the separate developer/collaborator-only OverlayLex Collector UserScript.

本政策适用于通过 Firefox Add-ons 与 Microsoft Edge Add-ons 分发的 OverlayLex 浏览器扩展，不适用于单独供开发/协作者使用的 OverlayLex Collector UserScript。

## 1. What OverlayLex does / OverlayLex 做什么

OverlayLex provides Chinese interface translation for Owlbear Rodeo and supported third-party Owlbear Rodeo extensions. Visible interface text is scanned, matched against translation dictionaries, and replaced locally in the user's browser.

OverlayLex 为 Owlbear Rodeo 及已适配的第三方扩展提供中文界面覆盖翻译。页面可见文本的扫描、词条匹配和 DOM 替换均在用户浏览器本地完成。

## 2. Data transmitted / 会传输的数据

OverlayLex makes HTTPS requests to `https://overlaylex-api.zjhstudio.com` and associated translation-package storage to obtain the package manifest, supported-domain allowlist, and translation dictionary JSON files. The page text being scanned or translated is not uploaded.

Different supported sites/extensions can request different translation packages, so a requested package identifier can indirectly reveal which supported Owlbear Rodeo site or extension is in use. Standard network metadata such as IP address, request time, request path, and user agent may also be processed by the hosting/CDN infrastructure as part of normal HTTPS delivery and security operations. For this reason, the Firefox build declares `browsingActivity` in its built-in data collection disclosure.

OverlayLex 会通过 HTTPS 向 `https://overlaylex-api.zjhstudio.com` 及其关联翻译包存储请求 manifest、受支持域名白名单和翻译 JSON。**被扫描或翻译的网页正文不会上传。**

由于不同站点/插件可能请求不同的翻译包，服务器可从所请求的包标识中间接推断用户正在使用哪个已支持的 Owlbear Rodeo 站点或插件。正常 HTTPS/CDN 服务还可能处理 IP 地址、请求时间、请求路径和 User-Agent 等标准网络元数据。因此 Firefox 版本在内置数据披露中如实声明 `browsingActivity`。

## 3. Data OverlayLex does not intentionally collect / OverlayLex 不主动收集的内容

The extension does not intentionally transmit visible page text or DOM contents; Owlbear Rodeo maps, tokens, notes, messages, or room content; passwords, authentication cookies, or form contents; names, email addresses, or other account identifiers; advertising identifiers; or analytics/telemetry events.

扩展不会主动上传网页可见文本或 DOM 内容、地图/Token/笔记/消息/房间内容、密码、认证 Cookie、表单内容、姓名/邮箱等账号身份信息、广告标识符，也不包含产品分析或遥测上报。

## 4. Local storage / 本地存储

OverlayLex uses browser extension local storage for translation package caches, the supported-domain allowlist cache, user package switches, and theme/UI preferences. This data remains on the user's device and can be removed by clearing extension data or uninstalling the extension.

OverlayLex 使用浏览器扩展本地存储保存翻译包缓存、域名白名单缓存、翻译包开关以及主题/UI 设置。上述数据保留在用户设备本地，可通过清除扩展数据或卸载扩展删除。

## 5. Remote code / 远程代码

OverlayLex does not download or execute remote JavaScript or other executable code. Remote responses used by the extension are data files (JSON manifests and translation dictionaries). All executable extension code is packaged with the extension submitted to the browser store.

OverlayLex 不下载或执行远程 JavaScript 或其他可执行代码。远端只提供 JSON manifest 与翻译词典数据；所有可执行扩展代码均随商店提交的扩展包一起分发。

## 6. Advertising, sale, and sharing / 广告、出售与共享

OverlayLex contains no advertising SDK and does not sell user data or use browsing information for advertising or user profiling. Hosting/CDN providers process requests only as infrastructure necessary to deliver OverlayLex translation data and protect the service.

OverlayLex 不含广告 SDK，不出售用户数据，也不将浏览信息用于广告投放或用户画像。托管/CDN 服务商仅作为提供翻译数据与保障服务安全所必需的基础设施处理请求。

## 7. User control / 用户控制

Users may disable or uninstall OverlayLex at any time. Doing so stops OverlayLex application requests. Local extension data can be removed through the browser's extension/data controls.

用户可以随时停用或卸载 OverlayLex；停用或卸载后 OverlayLex 应用层请求即停止。本地扩展数据可通过浏览器的扩展/数据管理功能清除。

## 8. Changes / 政策变更

If OverlayLex adds new data practices, this policy and the browser-store disclosures will be updated before the relevant feature is released.

如果 OverlayLex 的数据处理方式发生变化，我们会在相关功能发布前同步更新本政策与浏览器商店中的数据披露。

## 9. Contact / 联系方式

- Project repository / 项目仓库：`https://github.com/ZJHSteven/OverlayLex`
- Support and issues / 支持与问题反馈：`https://github.com/ZJHSteven/OverlayLex/issues`
