// ==UserScript==
// @name         OverlayLex Translator
// @namespace    https://github.com/ZJHSteven/OverlayLex
// @version      0.2.13
// @description  OverlayLex 主翻译脚本：按域名加载翻译包并执行页面文本覆盖翻译。
// @author       OverlayLex
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/ZJHSteven/OverlayLex/main/src/userscript/overlaylex.user.js
// @downloadURL  https://raw.githubusercontent.com/ZJHSteven/OverlayLex/main/src/userscript/overlaylex.user.js
// @run-at       document-end
// @grant        none
// ==/UserScript==

/**
 * OverlayLex 主脚本（教学向）
 *
 * 本版核心策略：
 * 1) 全站触发：用最宽松的 @match 覆盖主页面与 iframe 页面。
 * 2) 域名门禁：启动后第一时间读取“域名准入包”，不在白名单则立即退出。
 * 3) 包化翻译：manifest 只负责目录与版本，正文按包 URL 拉取并缓存。
 * 4) 增量刷新：用 MutationObserver 监听增量节点，避免每次全量刷。
 * 5) iframe 支持：
 *    - 脚本会在 iframe 页面独立运行（由全站 @match 保证）。
 *    - 对同源 iframe，父页面还会尝试直接增量翻译（双保险）。
 */
(function overlayLexBootstrap() {
  "use strict";

  // ------------------------------
  // 常量区
  // ------------------------------
  const SCRIPT_VERSION = "0.2.13";
  const STORAGE_KEYS = {
    MANIFEST_CACHE: "overlaylex:manifest-cache:v2",
    PACKAGE_CACHE: "overlaylex:package-cache:v2",
    USER_SWITCHES: "overlaylex:user-switches:v2",
    UI_STATE: "overlaylex:ui-state:v3",
    DOMAIN_PACKAGE_CACHE: "overlaylex:domain-package-cache:v1",
  };
  const CONFIG = {
    /**
     * 这里会在部署后替换成真实 worker URL。
     * 你可以先手动改成你自己的 workers.dev 地址。
     */
    apiBaseUrl: "https://overlaylex-demo-api.zhangjiahe0830.workers.dev",
    manifestPath: "/manifest",
    packagePathPrefix: "/packages/",
    domainPackagePath: "/domain-package.json",
    observerDebounceMs: 80,
  };
  /**
   * 本地内置域名 seeds（首层毫秒级门禁）。
   *
   * 设计目的：
   * 1) 保证“首次访问”不依赖网络也能做快速放行/退出判断。
   * 2) 只让疑似 OBR 生态页面进入后续网络流程，减少无关站点开销。
   * 3) 该 seeds 仅用于“快速放行”，真正准入仍由云端 domain-allowlist 决定。
   *
   * 维护说明：
   * - 这里与 `src/packages/overlaylex-domain-seeds.json` 保持同源规则。
   * - 若后续新增 OBR 生态顶级域名，请同步两处。
   */
  const LOCAL_DOMAIN_SEEDS = {
    id: "overlaylex-domain-seeds",
    kind: "domain-seeds",
    version: "0.1.0",
    rules: [
      {
        type: "exact",
        value: "owlbear.rodeo",
      },
      {
        type: "exact",
        value: "www.owlbear.rodeo",
      },
      {
        type: "suffix",
        value: ".owlbear.rodeo",
      },
      {
        type: "suffix",
        value: ".owlbear.app",
      },
    ],
  };
  /**
   * 运行期提示层常量（用于网络失败可视化提醒）。
   * 说明：
   * - 仅在顶层窗口渲染，不在 iframe 内重复弹提示。
   * - 样式与容器按需注入，避免无意义 DOM 常驻。
   */
  const RUNTIME_NOTICE_STYLE_ID = "overlaylex-runtime-notice-style";
  const RUNTIME_NOTICE_CONTAINER_ID = "overlaylex-runtime-notice-container";
  /**
   * UI 可调参数（教学向）
   *
   * 你后续若要继续“手动微调悬浮球大小”，只需要改这里，不要到样式里零散改数字。
   * 推荐调节顺序：
   * 1) 先改 sizePx（球整体直径）
   * 2) 再改 iconPx（中间图标大小）
   * 3) 最后微调 dotSizePx/ringInsetPx（小状态点与呼吸圈）
   */
  const UI_TUNING = {
    floatingBall: {
      sizePx: 30,
      iconPx: 16,
      ringInsetPx: -4,
      ringBlurPx: 5,
      dotSizePx: 7,
      dotOffsetPx: 1,
    },
  };

  // 当前上下文是否顶层窗口（用于控制悬浮球是否注入）。
  const isTopWindow = window.top === window.self;

  // ------------------------------
  // 日志与通用错误处理
  // ------------------------------
  const Logger = {
    info(...args) {
      console.info("[OverlayLex]", ...args);
    },
    warn(...args) {
      console.warn("[OverlayLex]", ...args);
    },
    error(...args) {
      console.error("[OverlayLex]", ...args);
    },
  };

  /**
   * 按需注入“运行期提示”样式。
   * 输入：
   * - 无
   * 输出：
   * - 无
   * 核心逻辑：
   * - 样式只注入一次，避免重复 DOM 污染。
   * - 不依赖主面板是否已创建，可用于启动早期错误提示。
   */
  function ensureRuntimeNoticeStyle() {
    if (!isTopWindow || !document.head) {
      return;
    }
    if (document.getElementById(RUNTIME_NOTICE_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = RUNTIME_NOTICE_STYLE_ID;
    style.textContent = `
      #${RUNTIME_NOTICE_CONTAINER_ID} {
        position: fixed;
        top: 14px;
        right: 14px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
      }
      .overlaylex-runtime-notice {
        min-width: 260px;
        max-width: 380px;
        padding: 10px 12px;
        border-radius: 10px;
        color: #f8fafc;
        font-size: 12px;
        line-height: 1.45;
        box-shadow: 0 10px 28px rgba(15, 23, 42, 0.35);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.25);
        animation: overlaylexRuntimeNoticeIn 180ms ease-out;
      }
      .overlaylex-runtime-notice[data-level="warn"] {
        background: linear-gradient(135deg, rgba(180, 83, 9, 0.9), rgba(146, 64, 14, 0.92));
      }
      .overlaylex-runtime-notice[data-level="error"] {
        background: linear-gradient(135deg, rgba(153, 27, 27, 0.9), rgba(127, 29, 29, 0.92));
      }
      .overlaylex-runtime-notice-title {
        font-weight: 700;
        margin-bottom: 4px;
      }
      .overlaylex-runtime-notice-text {
        opacity: 0.98;
      }
      @keyframes overlaylexRuntimeNoticeIn {
        from {
          transform: translateY(-6px);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * 获取或创建运行期提示容器。
   * 输入：
   * - 无
   * 输出：
   * - HTMLDivElement | null
   */
  function ensureRuntimeNoticeContainer() {
    if (!isTopWindow || !document.body) {
      return null;
    }
    let container = document.getElementById(RUNTIME_NOTICE_CONTAINER_ID);
    if (container instanceof HTMLDivElement) {
      return container;
    }
    container = document.createElement("div");
    container.id = RUNTIME_NOTICE_CONTAINER_ID;
    document.body.appendChild(container);
    return container;
  }

  /**
   * 显示运行期提示（小气泡）。
   * 输入：
   * - message: 提示正文
   * - options.level: "warn" | "error"
   * - options.durationMs: 自动消失时间（毫秒）
   * 输出：
   * - 无
   * 说明：
   * - 若 DOM 注入失败，回退到 `alert`，保证至少有一种可见错误反馈。
   */
  function showRuntimeNotice(message, options = {}) {
    if (!isTopWindow || !message) {
      return;
    }
    const level = options.level === "error" ? "error" : "warn";
    const durationMsRaw = Number(options.durationMs);
    const durationMs = Number.isFinite(durationMsRaw) && durationMsRaw > 0 ? durationMsRaw : 5200;
    try {
      ensureRuntimeNoticeStyle();
      const container = ensureRuntimeNoticeContainer();
      if (!container) {
        window.alert(`[OverlayLex] ${message}`);
        return;
      }
      const item = document.createElement("div");
      item.className = "overlaylex-runtime-notice";
      item.dataset.level = level;
      const title = document.createElement("div");
      title.className = "overlaylex-runtime-notice-title";
      title.textContent = level === "error" ? "OverlayLex 连接异常" : "OverlayLex 提示";
      const text = document.createElement("div");
      text.className = "overlaylex-runtime-notice-text";
      text.textContent = message;
      item.appendChild(title);
      item.appendChild(text);
      container.appendChild(item);
      window.setTimeout(() => {
        item.remove();
      }, durationMs);
    } catch (error) {
      Logger.warn("显示运行期提示失败，回退 alert。", error);
      try {
        window.alert(`[OverlayLex] ${message}`);
      } catch (alertError) {
        Logger.warn("alert 提示也失败。", alertError);
      }
    }
  }

  function safeJsonParse(raw, fallbackValue) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      Logger.warn("JSON 解析失败，使用回退值。", error);
      return fallbackValue;
    }
  }

  function safeLocalStorageGet(key, fallbackValue) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return fallbackValue;
      }
      return safeJsonParse(raw, fallbackValue);
    } catch (error) {
      Logger.warn(`读取 localStorage 失败: ${key}`, error);
      return fallbackValue;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      Logger.warn(`写入 localStorage 失败: ${key}`, error);
    }
  }

  // ------------------------------
  // 运行时状态
  // ------------------------------
  const state = {
    manifest: null,
    domainPackage: safeLocalStorageGet(STORAGE_KEYS.DOMAIN_PACKAGE_CACHE, null),
    packageCache: safeLocalStorageGet(STORAGE_KEYS.PACKAGE_CACHE, {}),
    userSwitches: safeLocalStorageGet(STORAGE_KEYS.USER_SWITCHES, {}),
    translationMap: new Map(),
    observer: null,
    isApplyingTranslation: false,
    iframeObserverMap: new WeakMap(),
    ui: {
      floatingBall: null,
      panel: null,
      packageListRoot: null,
      statusText: null,
      settingsPanel: null,
      themeSelect: null,
      themeMediaQuery: null,
      themeChangeHandler: null,
      packageUpdatingMap: {},
    },
  };

  // ------------------------------
  // 网络层
  // ------------------------------
  async function fetchJsonWithTimeout(url, timeoutMs = 5000) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timerId);
    }
  }

  async function fetchManifest() {
    const url = `${CONFIG.apiBaseUrl}${CONFIG.manifestPath}`;
    return fetchJsonWithTimeout(url, 6000);
  }

  async function fetchPackageByUrl(url) {
    return fetchJsonWithTimeout(url, 7000);
  }

  function buildPackageUrl(packageId) {
    return `${CONFIG.apiBaseUrl}${CONFIG.packagePathPrefix}${encodeURIComponent(packageId)}.json`;
  }

  async function fetchDomainPackageByBestUrl() {
    // 优先用 manifest 给出的精确 URL，避免未来路径调整导致客户端失效。
    const manifestDomainUrl = state.manifest?.domainPackage?.url;
    if (typeof manifestDomainUrl === "string" && manifestDomainUrl) {
      return fetchPackageByUrl(manifestDomainUrl);
    }

    // 如果 manifest 不可用，走约定路径回退。
    const fallbackUrl = `${CONFIG.apiBaseUrl}${CONFIG.domainPackagePath}`;
    return fetchPackageByUrl(fallbackUrl);
  }

  // ------------------------------
  // manifest / package 缓存策略
  // ------------------------------
  function getCachedManifest() {
    return safeLocalStorageGet(STORAGE_KEYS.MANIFEST_CACHE, null);
  }

  function setCachedManifest(manifest) {
    safeLocalStorageSet(STORAGE_KEYS.MANIFEST_CACHE, manifest);
  }

  function setCachedDomainPackage(domainPackage) {
    state.domainPackage = domainPackage;
    safeLocalStorageSet(STORAGE_KEYS.DOMAIN_PACKAGE_CACHE, domainPackage);
  }

  function needsPackageUpdate(pkgMeta) {
    const cacheEntry = state.packageCache[pkgMeta.id];
    if (!cacheEntry) {
      return true;
    }
    return cacheEntry.version !== pkgMeta.version;
  }

  function getPackageEnabled(pkgMeta) {
    const userSwitch = state.userSwitches[pkgMeta.id];
    if (typeof userSwitch === "boolean") {
      return userSwitch;
    }
    return Boolean(pkgMeta.enabledByDefault);
  }

  /**
   * 判断某个包当前是否处于“下载更新中”状态。
   */
  function isPackageUpdating(packageId) {
    return Boolean(state.ui.packageUpdatingMap?.[packageId]);
  }

  /**
   * 写入“包下载中”状态，并刷新列表右侧云下载图标。
   * 说明：
   * - 只有手动更新流程会打开该状态。
   * - 常态下（未更新）不显示右侧图标。
   */
  function setPackageUpdating(packageId, updating) {
    if (!packageId) {
      return;
    }
    if (!state.ui.packageUpdatingMap || typeof state.ui.packageUpdatingMap !== "object") {
      state.ui.packageUpdatingMap = {};
    }
    if (updating) {
      state.ui.packageUpdatingMap[packageId] = true;
    } else {
      delete state.ui.packageUpdatingMap[packageId];
    }
    renderPackageList();
  }

  async function ensurePackageReady(pkgMeta, options = {}) {
    const showUpdatingIndicator = Boolean(options.showUpdatingIndicator);
    if (!getPackageEnabled(pkgMeta)) {
      return null;
    }

    const shouldUpdate = needsPackageUpdate(pkgMeta);
    const cached = state.packageCache[pkgMeta.id];
    if (!shouldUpdate && cached && cached.data) {
      return cached.data;
    }

    const packageUrl = pkgMeta.url || buildPackageUrl(pkgMeta.id);
    if (showUpdatingIndicator) {
      setPackageUpdating(pkgMeta.id, true);
    }
    let packageData = null;
    try {
      packageData = await fetchPackageByUrl(packageUrl);
    } finally {
      if (showUpdatingIndicator) {
        setPackageUpdating(pkgMeta.id, false);
      }
    }

    state.packageCache[pkgMeta.id] = {
      version: pkgMeta.version,
      fetchedAt: new Date().toISOString(),
      data: packageData,
    };
    safeLocalStorageSet(STORAGE_KEYS.PACKAGE_CACHE, state.packageCache);
    return packageData;
  }

  async function reloadEnabledPackages(options = {}) {
    if (!state.manifest || !Array.isArray(state.manifest.packages)) {
      return;
    }

    const showUpdatingIndicator = Boolean(options.showUpdatingIndicator);
    const nextMap = new Map();
    for (const pkgMeta of state.manifest.packages) {
      // 只读取 translation 包，域名包由专门流程处理。
      if (pkgMeta.kind && pkgMeta.kind !== "translation") {
        continue;
      }
      try {
        const packageData = await ensurePackageReady(pkgMeta, { showUpdatingIndicator });
        if (!packageData || typeof packageData !== "object") {
          continue;
        }
        if (!isPackageTargetMatched(packageData)) {
          continue;
        }
        const translations = packageData.translations || {};
        for (const [sourceText, targetText] of Object.entries(translations)) {
          if (typeof sourceText !== "string" || typeof targetText !== "string") {
            continue;
          }
          nextMap.set(sourceText, targetText);
        }
      } catch (error) {
        Logger.warn(`加载翻译包失败: ${pkgMeta.id}`, error);
      }
    }

    state.translationMap = nextMap;
  }

  function isPackageTargetMatched(packageData) {
    const target = packageData?.target;
    if (!target || typeof target !== "object") {
      return true;
    }

    const currentHost = window.location.hostname.toLowerCase();
    const currentPath = window.location.pathname || "/";
    // 兼容两种写法：
    // 1) 旧写法: target.host（单个域名）
    // 2) 新写法: target.hosts（多个域名数组）
    const targetHost = String(target.host || "").toLowerCase().trim();
    const targetHosts = Array.isArray(target.hosts)
      ? target.hosts
          .map((item) => String(item || "").toLowerCase().trim())
          .filter((item) => Boolean(item))
      : [];
    const targetPathPrefix = String(target.pathPrefix || "").trim();

    if (targetHosts.length > 0) {
      if (!targetHosts.includes(currentHost)) {
        return false;
      }
    } else if (targetHost && currentHost !== targetHost) {
      return false;
    }
    if (targetPathPrefix && !currentPath.startsWith(targetPathPrefix)) {
      return false;
    }
    return true;
  }

  // ------------------------------
  // 域名门禁（全站 @match 的快速放行判断）
  // ------------------------------
  function isHostMatchedByRule(hostname, rule) {
    if (!rule || typeof rule !== "object") {
      return false;
    }

    const ruleType = String(rule.type || "").toLowerCase();
    const ruleValue = String(rule.value || "").toLowerCase();
    if (!ruleType || !ruleValue) {
      return false;
    }

    if (ruleType === "exact") {
      return hostname === ruleValue;
    }
    if (ruleType === "suffix") {
      return hostname.endsWith(ruleValue);
    }
    if (ruleType === "contains") {
      return hostname.includes(ruleValue);
    }
    if (ruleType === "regex") {
      try {
        const regex = new RegExp(rule.value, "i");
        return regex.test(hostname);
      } catch (error) {
        Logger.warn("域名规则 regex 非法，已跳过。", rule, error);
        return false;
      }
    }
    return false;
  }

  function isHostAllowedByDomainPackage(hostname, domainPackage) {
    const rules = Array.isArray(domainPackage?.rules) ? domainPackage.rules : [];
    if (rules.length === 0) {
      return false;
    }
    return rules.some((rule) => isHostMatchedByRule(hostname, rule));
  }

  /**
   * 基于“本地 seeds”做首层快速门禁。
   * 输入：
   * - hostname: 当前页面域名（小写）
   * 输出：
   * - true：可能属于 OBR 生态，允许进入下一步
   * - false：直接退出，避免无意义网络请求与 DOM 注入
   */
  function isHostAllowedByLocalSeeds(hostname) {
    return isHostAllowedByDomainPackage(hostname, LOCAL_DOMAIN_SEEDS);
  }

  async function ensureCurrentHostAllowed() {
    const hostname = window.location.hostname.toLowerCase();

    // 先用缓存快速判断，减少每次页面打开都阻塞网络。
    if (state.domainPackage && isHostAllowedByDomainPackage(hostname, state.domainPackage)) {
      return {
        allowed: true,
        from: "cache",
        remoteFailed: false,
        hasCache: true,
      };
    }

    // 缓存命不中，再请求最新域名包。
    try {
      const remoteDomainPackage = await fetchDomainPackageByBestUrl();
      setCachedDomainPackage(remoteDomainPackage);
      return {
        allowed: isHostAllowedByDomainPackage(hostname, remoteDomainPackage),
        from: "remote",
        remoteFailed: false,
        hasCache: Boolean(state.domainPackage),
      };
    } catch (error) {
      Logger.warn("域名包拉取失败，回退到缓存判断。", error);
      // 网络失败时，如果缓存存在就按缓存兜底，否则 fail-close。
      if (state.domainPackage) {
        return {
          allowed: isHostAllowedByDomainPackage(hostname, state.domainPackage),
          from: "cache-fallback",
          remoteFailed: true,
          hasCache: true,
        };
      }
      return {
        allowed: false,
        from: "none",
        remoteFailed: true,
        hasCache: false,
      };
    }
  }

  // ------------------------------
  // 翻译层
  // ------------------------------
  const IGNORED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"]);

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  function translateByMap(rawText) {
    const directHit = state.translationMap.get(rawText);
    if (typeof directHit === "string") {
      return directHit;
    }

    const normalized = normalizeText(rawText);
    const normalizedHit = state.translationMap.get(normalized);
    if (typeof normalizedHit !== "string") {
      return null;
    }

    const leadingSpaces = rawText.match(/^\s*/)?.[0] ?? "";
    const trailingSpaces = rawText.match(/\s*$/)?.[0] ?? "";
    return `${leadingSpaces}${normalizedHit}${trailingSpaces}`;
  }

  function canProcessTextNode(textNode) {
    const parent = textNode.parentElement;
    if (!parent) {
      return false;
    }
    if (IGNORED_TAGS.has(parent.tagName)) {
      return false;
    }
    if (!textNode.nodeValue || !textNode.nodeValue.trim()) {
      return false;
    }
    return true;
  }

  function applyTranslationToTextNode(textNode) {
    if (!canProcessTextNode(textNode)) {
      return false;
    }
    const original = textNode.nodeValue;
    const translated = translateByMap(original);
    if (!translated || translated === original) {
      return false;
    }
    textNode.nodeValue = translated;
    return true;
  }

  /**
   * 判断元素是否为“可翻译 value”的按钮类 input。
   * 说明：
   * - 仅允许 button/submit/reset 三类；
   * - 明确排除 text/password 等输入框，避免把用户输入误当成固定 UI 文案覆盖。
   */
  function isTranslatableInputValueElement(element) {
    if (!element || element.tagName !== "INPUT") {
      return false;
    }
    const typeRaw = String(element.getAttribute?.("type") || element.type || "text").toLowerCase();
    return typeRaw === "button" || typeRaw === "submit" || typeRaw === "reset";
  }

  function applyTranslationToElementAttributes(element) {
    let changed = false;
    const attributesToTranslate = ["placeholder", "title"];
    for (const attrName of attributesToTranslate) {
      const original = element.getAttribute(attrName);
      if (!original) {
        continue;
      }
      const translated = translateByMap(original);
      if (!translated || translated === original) {
        continue;
      }
      element.setAttribute(attrName, translated);
      changed = true;
    }

    // 额外处理按钮类 input 的 value 文案（例如 input[type=button] 的按钮文字）。
    if (isTranslatableInputValueElement(element)) {
      const originalValue = String(element.getAttribute?.("value") || element.value || "");
      if (originalValue) {
        const translatedValue = translateByMap(originalValue);
        if (translatedValue && translatedValue !== originalValue) {
          // 若原始 DOM 存在 value 属性，同步回属性，保证后续序列化/框架读取一致。
          if (element.getAttribute("value") !== null) {
            element.setAttribute("value", translatedValue);
          }
          // 同步回属性值属性（property），保证页面上即时显示为译文。
          element.value = translatedValue;
          changed = true;
        }
      }
    }
    return changed;
  }

  function translateSubtree(rootNode) {
    if (!rootNode || state.translationMap.size === 0) {
      return 0;
    }

    // 不同文档（iframe）要使用对应 document 的 TreeWalker 与 NodeFilter。
    const ownerDocument = rootNode.ownerDocument || document;
    const ownerWindow = ownerDocument.defaultView || window;
    const nodeConst = ownerWindow.Node;
    const nodeFilterConst = ownerWindow.NodeFilter;

    let changedCount = 0;

    if (rootNode.nodeType === nodeConst.TEXT_NODE) {
      if (applyTranslationToTextNode(rootNode)) {
        changedCount += 1;
      }
      return changedCount;
    }

    if (rootNode.nodeType === nodeConst.ELEMENT_NODE) {
      if (applyTranslationToElementAttributes(rootNode)) {
        changedCount += 1;
      }
    }

    const walker = ownerDocument.createTreeWalker(
      rootNode,
      nodeFilterConst.SHOW_TEXT | nodeFilterConst.SHOW_ELEMENT,
      null
    );

    let current = walker.currentNode;
    while (current) {
      if (current.nodeType === nodeConst.TEXT_NODE) {
        if (applyTranslationToTextNode(current)) {
          changedCount += 1;
        }
      } else if (current.nodeType === nodeConst.ELEMENT_NODE) {
        if (applyTranslationToElementAttributes(current)) {
          changedCount += 1;
        }
      }
      current = walker.nextNode();
    }
    return changedCount;
  }

  function setStatus(text) {
    if (state.ui.statusText) {
      state.ui.statusText.textContent = text;
    }
    Logger.info(text);
  }

  function scheduleFullReapply() {
    if (state.isApplyingTranslation) {
      return;
    }
    state.isApplyingTranslation = true;
    queueMicrotask(() => {
      try {
        let changedCount = 0;
        changedCount += translateSubtree(document.body);
        changedCount += translateSameOriginIframes();
        setStatus(`重注入完成，替换 ${changedCount} 处文本。`);
      } finally {
        state.isApplyingTranslation = false;
      }
    });
  }

  // ------------------------------
  // iframe 支持（父页面对同源 iframe 的补充翻译）
  // ------------------------------
  function observeSingleIframe(iframeElement) {
    if (!(iframeElement instanceof HTMLIFrameElement)) {
      return;
    }

    function applyOnCurrentFrameDocument() {
      try {
        const frameDoc = iframeElement.contentDocument;
        if (!frameDoc || !frameDoc.body) {
          return;
        }

        translateSubtree(frameDoc.body);

        const oldObserver = state.iframeObserverMap.get(iframeElement);
        if (oldObserver) {
          oldObserver.disconnect();
        }

        const frameObserver = new MutationObserver((mutations) => {
          let frameChangedCount = 0;
          for (const mutation of mutations) {
            if (mutation.type === "characterData" && mutation.target) {
              frameChangedCount += translateSubtree(mutation.target);
            }
            if (mutation.type === "childList") {
              for (const node of mutation.addedNodes) {
                frameChangedCount += translateSubtree(node);
              }
            }
            if (mutation.type === "attributes" && mutation.target) {
              frameChangedCount += translateSubtree(mutation.target);
            }
          }
          if (frameChangedCount > 0) {
            setStatus(`iframe 增量翻译完成，替换 ${frameChangedCount} 处文本。`);
          }
        });

        frameObserver.observe(frameDoc.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["placeholder", "title", "value"],
        });
        state.iframeObserverMap.set(iframeElement, frameObserver);
      } catch (error) {
        // 跨域 iframe 无法访问 DOM，这是浏览器同源策略的正常限制。
      }
    }

    iframeElement.addEventListener("load", applyOnCurrentFrameDocument);
    applyOnCurrentFrameDocument();
  }

  function translateSameOriginIframes() {
    let changedCount = 0;
    const iframes = document.querySelectorAll("iframe");
    for (const iframeElement of iframes) {
      try {
        const frameDoc = iframeElement.contentDocument;
        if (!frameDoc || !frameDoc.body) {
          continue;
        }
        changedCount += translateSubtree(frameDoc.body);
        observeSingleIframe(iframeElement);
      } catch (error) {
        // 跨域 iframe 无法直接处理，忽略即可。
      }
    }
    return changedCount;
  }

  // ------------------------------
  // 主文档监听层
  // ------------------------------
  function setupMutationObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    let timerId = null;
    const pendingNodes = new Set();

    function flushPending() {
      timerId = null;
      let totalChanged = 0;

      for (const node of pendingNodes) {
        totalChanged += translateSubtree(node);
        if (node instanceof HTMLIFrameElement) {
          observeSingleIframe(node);
        } else if (node?.nodeType === Node.ELEMENT_NODE) {
          const nestedIframes = node.querySelectorAll?.("iframe") || [];
          nestedIframes.forEach((frame) => observeSingleIframe(frame));
        }
      }
      pendingNodes.clear();

      if (totalChanged > 0) {
        setStatus(`增量翻译完成，替换 ${totalChanged} 处文本。`);
      }
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData" && mutation.target) {
          pendingNodes.add(mutation.target);
        }
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            pendingNodes.add(node);
          }
        }
        if (mutation.type === "attributes" && mutation.target) {
          pendingNodes.add(mutation.target);
        }
      }
      if (timerId !== null) {
        return;
      }
      timerId = window.setTimeout(flushPending, CONFIG.observerDebounceMs);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["placeholder", "title", "value"],
    });
    state.observer = observer;
  }

  // ------------------------------
  // UI 层（仅顶层窗口注入）
  // ------------------------------
  /**
   * 统一规范主题模式枚举值。
   * 输入：
   * - rawMode: 本地缓存或 UI 控件传入的原始值
   * 输出：
   * - "light" | "dark" | "system"
   * 核心逻辑：
   * - 若值非法，自动回退到 "system"，避免旧缓存/异常值导致 UI 失效。
   */
  function normalizeUiThemeMode(rawMode) {
    if (rawMode === "light" || rawMode === "dark" || rawMode === "system") {
      return rawMode;
    }
    return "system";
  }

  function getUiState() {
    return safeLocalStorageGet(STORAGE_KEYS.UI_STATE, {
      ballTop: 120,
      ballRight: 16,
      panelTop: 120,
      panelRight: 16,
      panelOpen: false,
      themeMode: "system",
    });
  }

  function setUiState(patch) {
    const next = { ...getUiState(), ...patch };
    next.themeMode = normalizeUiThemeMode(next.themeMode);
    safeLocalStorageSet(STORAGE_KEYS.UI_STATE, next);
    return next;
  }

  /**
   * 读取系统主题偏好。
   * 输出：
   * - "light" | "dark"
   * 说明：
   * - 浏览器不支持 matchMedia 时，默认按亮色处理，保证旧环境可用。
   */
  function getSystemThemeMode() {
    if (typeof window.matchMedia !== "function") {
      return "light";
    }
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (error) {
      Logger.warn("读取系统主题偏好失败，回退到亮色模式。", error);
      return "light";
    }
  }

  /**
   * 将“主题选择模式”解析成真正要渲染的样式主题。
   * 输入：
   * - themeMode: "light" | "dark" | "system"
   * 输出：
   * - "light" | "dark"
   */
  function resolveEffectiveTheme(themeMode) {
    const normalizedMode = normalizeUiThemeMode(themeMode);
    if (normalizedMode === "system") {
      return getSystemThemeMode();
    }
    return normalizedMode;
  }

  /**
   * 应用浮窗与悬浮球主题（仅作用于 OverlayLex 自身 DOM）。
   * 输入：
   * - themeMode: "light" | "dark" | "system"
   * 输出：
   * - 无
   */
  function applyUiTheme(themeMode) {
    const effectiveTheme = resolveEffectiveTheme(themeMode);
    if (state.ui.panel) {
      state.ui.panel.dataset.theme = effectiveTheme;
    }
    if (state.ui.floatingBall) {
      state.ui.floatingBall.dataset.theme = effectiveTheme;
    }
  }

  /**
   * 解绑系统主题监听，避免重复绑定导致同一事件触发多次。
   */
  function unbindSystemThemeWatcher() {
    const mediaQuery = state.ui.themeMediaQuery;
    const handler = state.ui.themeChangeHandler;
    if (!mediaQuery || !handler) {
      return;
    }
    if (typeof mediaQuery.removeEventListener === "function") {
      mediaQuery.removeEventListener("change", handler);
    } else if (typeof mediaQuery.removeListener === "function") {
      mediaQuery.removeListener(handler);
    }
    state.ui.themeMediaQuery = null;
    state.ui.themeChangeHandler = null;
  }

  /**
   * 监听系统主题变化（仅在“跟随系统”模式下自动切换）。
   * 兼容性：
   * - 新浏览器：MediaQueryList.addEventListener("change")
   * - 旧浏览器：MediaQueryList.addListener
   */
  function bindSystemThemeWatcher() {
    unbindSystemThemeWatcher();
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const uiState = getUiState();
      if (normalizeUiThemeMode(uiState.themeMode) !== "system") {
        return;
      }
      applyUiTheme("system");
    };
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handler);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(handler);
    }
    state.ui.themeMediaQuery = mediaQuery;
    state.ui.themeChangeHandler = handler;
  }

  /**
   * 把主题模式值映射为用于提示的中文文案。
   */
  function getThemeModeLabel(themeMode) {
    const normalizedMode = normalizeUiThemeMode(themeMode);
    if (normalizedMode === "light") {
      return "明亮模式";
    }
    if (normalizedMode === "dark") {
      return "暗夜模式";
    }
    return "跟随系统";
  }

  /**
   * 内置 SVG 图标字典（优先使用你提供的官方 Material Symbols SVG 路径）。
   * 说明：
   * - 仅替换图形路径，颜色统一改为 currentColor，便于复用现有亮/暗主题配色。
   * - 这样可以避免外链字体在部分站点被 CSP 拦截后出现“图标文字化”问题。
   */
  const ICON_SVG_MAP = {
    translate: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor"><path d="m476-80 182-480h84L924-80h-84l-43-122H603L560-80h-84ZM160-200l-56-56 202-202q-35-35-63.5-80T190-640h84q20 39 40 68t48 58q33-33 68.5-92.5T484-720H40v-80h280v-80h80v80h280v80H564q-21 72-63 148t-83 116l96 98-30 82-122-125-202 201Zm468-72h144l-72-204-72 204Z"/></svg>`,
    language: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor"><path d="M325-111.5q-73-31.5-127.5-86t-86-127.5Q80-398 80-480.5t31.5-155q31.5-72.5 86-127t127.5-86Q398-880 480.5-880t155 31.5q72.5 31.5 127 86t86 127Q880-563 880-480.5T848.5-325q-31.5 73-86 127.5t-127 86Q563-80 480.5-80T325-111.5ZM480-162q26-36 45-75t31-83H404q12 44 31 83t45 75Zm-104-16q-18-33-31.5-68.5T322-320H204q29 50 72.5 87t99.5 55Zm208 0q56-18 99.5-55t72.5-87H638q-9 38-22.5 73.5T584-178ZM170-400h136q-3-20-4.5-39.5T300-480q0-21 1.5-40.5T306-560H170q-5 20-7.5 39.5T160-480q0 21 2.5 40.5T170-400Zm216 0h188q3-20 4.5-39.5T580-480q0-21-1.5-40.5T574-560H386q-3 20-4.5 39.5T380-480q0 21 1.5 40.5T386-400Zm268 0h136q5-20 7.5-39.5T800-480q0-21-2.5-40.5T790-560H654q3 20 4.5 39.5T660-480q0 21-1.5 40.5T654-400Zm-16-240h118q-29-50-72.5-87T584-782q18 33 31.5 68.5T638-640Zm-234 0h152q-12-44-31-83t-45-75q-26 36-45 75t-31 83Zm-200 0h118q9-38 22.5-73.5T376-782q-56 18-99.5 55T204-640Z"/></svg>`,
    settings: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor"><path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z"/></svg>`,
    cloudSync: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor"><path d="M160-160v-80h109q-51-44-80-106t-29-134q0-112 68-197.5T400-790v84q-70 25-115 86.5T240-480q0 54 21.5 99.5T320-302v-98h80v240H160Zm440 0q-50 0-85-35t-35-85q0-48 33-82.5t81-36.5q17-36 50.5-58.5T720-480q53 0 91.5 34.5T858-360q42 0 72 29t30 70q0 42-29 71.5T860-160H600Zm116-360q-7-41-27-76t-49-62v98h-80v-240h240v80H691q43 38 70.5 89T797-520h-81ZM600-240h260q8 0 14-6t6-14q0-8-6-14t-14-6h-70v-50q0-29-20.5-49.5T720-400q-29 0-49.5 20.5T650-330v10h-50q-17 0-28.5 11.5T560-280q0 17 11.5 28.5T600-240Zm120-80Z"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6 6 12 12"/><path d="m18 6-12 12"/></svg>`,
    cloudDownload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.2 18H6a4 4 0 0 1-.3-8 5.7 5.7 0 0 1 10.9-1.5A4.1 4.1 0 1 1 18 18h-1.2"/><path d="M12 11v6"/><path d="m9.5 14.5 2.5 2.5 2.5-2.5"/></svg>`,
    done: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.2 4.2L19 6.5"/></svg>`,
  };

  /**
   * 生成图标 HTML，extraClass 用于按场景控制尺寸。
   */
  function getIconSvg(iconName, extraClass = "") {
    const iconSvg = ICON_SVG_MAP[iconName] || "";
    const safeClass = extraClass ? ` ${extraClass}` : "";
    return `<span class="overlaylex-icon${safeClass}" aria-hidden="true">${iconSvg}</span>`;
  }

  function injectUiStyles() {
    const ballUi = UI_TUNING.floatingBall;
    const style = document.createElement("style");
    style.textContent = `
      /* OverlayLex UI 样式：只影响带 overlaylex-* 前缀的节点，不污染宿主页面。 */
      .overlaylex-hidden {
        display: none !important;
      }
      .overlaylex-icon {
        display: inline-flex;
        width: 1em;
        height: 1em;
        line-height: 1;
        flex: 0 0 auto;
      }
      .overlaylex-icon > svg {
        width: 100%;
        height: 100%;
      }
      .overlaylex-ball {
        position: fixed;
        z-index: 2147483000;
        width: ${ballUi.sizePx}px;
        height: ${ballUi.sizePx}px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.38);
        background: rgba(255, 255, 255, 0.7);
        color: #137fec;
        cursor: move;
        font: 700 14px/1 "Inter", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
        box-shadow: 0 12px 26px rgba(15, 23, 42, 0.26);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        overflow: visible;
        user-select: none;
        touch-action: none;
        will-change: top, right, transform;
      }
      .overlaylex-ball-core {
        position: relative;
        z-index: 2;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .overlaylex-ball-icon {
        font-size: ${ballUi.iconPx}px;
      }
      .overlaylex-ball-ring {
        position: absolute;
        inset: ${ballUi.ringInsetPx}px;
        border-radius: 999px;
        background: rgba(19, 127, 236, 0.24);
        filter: blur(${ballUi.ringBlurPx}px);
        opacity: .45;
        animation: overlaylex-breathe 2.8s ease-in-out infinite;
        pointer-events: none;
      }
      .overlaylex-ball-dot {
        position: absolute;
        top: ${ballUi.dotOffsetPx}px;
        right: ${ballUi.dotOffsetPx}px;
        width: ${ballUi.dotSizePx}px;
        height: ${ballUi.dotSizePx}px;
        border-radius: 999px;
        background: #137fec;
        border: 2px solid rgba(255, 255, 255, 0.95);
        z-index: 3;
      }
      @keyframes overlaylex-breathe {
        0% { transform: scale(0.94); opacity: .28; }
        50% { transform: scale(1.02); opacity: .52; }
        100% { transform: scale(0.94); opacity: .28; }
      }
      .overlaylex-ball[data-theme="dark"] {
        background: rgba(16, 25, 34, 0.82);
        color: #2f9cff;
        border-color: rgba(255, 255, 255, 0.12);
        box-shadow: 0 0 12px rgba(0, 136, 255, 0.2), 0 14px 28px rgba(0,0,0,.62);
      }
      .overlaylex-ball[data-theme="dark"] .overlaylex-ball-ring {
        background: rgba(0, 136, 255, 0.28);
      }
      .overlaylex-ball[data-theme="dark"] .overlaylex-ball-dot {
        border-color: rgba(16, 25, 34, 0.95);
      }
      .overlaylex-ball:active {
        transform: scale(0.97);
      }
      .overlaylex-ball.overlaylex-ball-dragging {
        /* 拖拽中临时降级特效，减少重绘压力，提高跟手性。 */
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        box-shadow: 0 8px 16px rgba(15, 23, 42, 0.28);
      }
      .overlaylex-ball.overlaylex-ball-dragging .overlaylex-ball-ring {
        animation: none;
        filter: none;
        opacity: .22;
      }
      .overlaylex-panel {
        position: fixed;
        z-index: 2147483001;
        top: 72px;
        right: 16px;
        width: 340px;
        max-height: 72vh;
        overflow: hidden;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.82);
        color: #1f2937;
        font: 14px/1.45 "Inter", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
        box-shadow: 0 20px 46px rgba(15, 23, 42, 0.26);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        display: flex;
        flex-direction: column;
      }
      .overlaylex-panel[data-theme="dark"] {
        border-color: rgba(255, 255, 255, 0.14);
        background: rgba(10, 10, 12, 0.92);
        color: #f8fafc;
        box-shadow: 0 30px 60px rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
      }
      .overlaylex-panel-drag-handle {
        height: 6px;
        width: 48px;
        border-radius: 999px;
        margin: 10px auto 4px;
        background: rgba(100, 116, 139, 0.36);
        cursor: grab;
      }
      .overlaylex-panel-drag-handle:active {
        cursor: grabbing;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-panel-drag-handle {
        background: rgba(255, 255, 255, 0.2);
      }
      .overlaylex-panel-header {
        padding: 10px 18px 14px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.22);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-panel-header {
        border-bottom-color: rgba(255, 255, 255, 0.1);
      }
      .overlaylex-panel-header-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      .overlaylex-title-group {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .overlaylex-title-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 8px;
        background: rgba(19, 127, 236, 0.14);
        color: #137fec;
        font-size: 18px;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-title-icon {
        background: rgba(0, 136, 255, 0.2);
        color: #36a0ff;
      }
      .overlaylex-panel-title {
        margin: 0;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: .16em;
      }
      .overlaylex-icon-btn {
        border: none;
        background: transparent;
        color: #64748b;
        width: 30px;
        height: 30px;
        border-radius: 8px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
      }
      .overlaylex-icon-btn .overlaylex-icon {
        font-size: 20px;
      }
      .overlaylex-icon-btn:hover {
        background: rgba(148, 163, 184, 0.2);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-icon-btn {
        color: #94a3b8;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-icon-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #f8fafc;
      }
      .overlaylex-theme-settings {
        margin-bottom: 10px;
        padding: 10px;
        border-radius: 10px;
        background: rgba(248, 250, 252, 0.86);
        border: 1px solid rgba(203, 213, 225, 0.7);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-theme-settings {
        background: rgba(2, 6, 23, 0.5);
        border-color: rgba(148, 163, 184, 0.24);
      }
      .overlaylex-theme-settings label {
        display: block;
        margin-bottom: 6px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .06em;
        text-transform: uppercase;
        color: #64748b;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-theme-settings label {
        color: #94a3b8;
      }
      .overlaylex-theme-select {
        width: 100%;
        border-radius: 8px;
        border: 1px solid rgba(148, 163, 184, 0.56);
        background: #ffffff;
        color: #1f2937;
        padding: 6px 8px;
        font-size: 13px;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-theme-select {
        border-color: rgba(0, 136, 255, 0.45);
        background: #111111;
        color: #e2e8f0;
      }
      .overlaylex-primary-btn {
        width: 100%;
        border: none;
        border-radius: 10px;
        background: #137fec;
        color: #ffffff;
        font-weight: 700;
        padding: 11px 12px;
        cursor: pointer;
        transition: transform .08s ease, filter .18s ease;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
      }
      .overlaylex-primary-btn .overlaylex-icon {
        font-size: 18px;
      }
      .overlaylex-primary-btn:hover {
        filter: brightness(0.95);
      }
      .overlaylex-primary-btn:active {
        transform: scale(0.98);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-primary-btn {
        background: #111111;
        border: 1px solid rgba(0, 136, 255, 0.4);
        color: #f8fafc;
        box-shadow: 0 0 10px rgba(0, 136, 255, 0.1);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-primary-btn:hover {
        border-color: rgba(0, 136, 255, 0.9);
        box-shadow: 0 0 15px rgba(0, 136, 255, 0.25);
      }
      .overlaylex-packages {
        display: flex;
        flex-direction: column;
        min-height: 120px;
        max-height: 360px;
        overflow: hidden;
        border-top: 1px solid rgba(148, 163, 184, 0.22);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-packages {
        border-top-color: rgba(255, 255, 255, 0.1);
        background: rgba(0, 0, 0, 0.2);
      }
      .overlaylex-packages-title {
        margin: 0;
        padding: 10px 18px 8px;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: .16em;
        text-transform: uppercase;
        color: #64748b;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-packages-title {
        color: rgba(226, 232, 240, 0.6);
      }
      .overlaylex-package-list {
        overflow-y: auto;
        padding: 0 18px 8px;
      }
      .overlaylex-package-list::-webkit-scrollbar {
        width: 4px;
      }
      .overlaylex-package-list::-webkit-scrollbar-track {
        background: transparent;
      }
      .overlaylex-package-list::-webkit-scrollbar-thumb {
        background: rgba(100, 116, 139, 0.35);
        border-radius: 999px;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-package-list::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.2);
      }
      .overlaylex-package-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 0;
        border-bottom: 1px solid rgba(148, 163, 184, 0.16);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-package-item {
        border-bottom-color: rgba(255, 255, 255, 0.06);
      }
      .overlaylex-package-item:last-child {
        border-bottom: none;
      }
      .overlaylex-package-item[data-enabled="false"] .overlaylex-package-name {
        opacity: .64;
      }
      .overlaylex-package-item[data-enabled="false"] .overlaylex-package-meta {
        opacity: .62;
      }
      .overlaylex-switch {
        position: relative;
        width: 38px;
        height: 22px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.42);
        cursor: pointer;
        flex: 0 0 auto;
        overflow: hidden;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-switch {
        background: rgba(255, 255, 255, 0.1);
      }
      .overlaylex-switch-input {
        position: absolute;
        opacity: 0;
        width: 1px;
        height: 1px;
        pointer-events: none;
      }
      .overlaylex-switch-bg {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        background: #137fec;
        opacity: 0;
        transition: opacity .16s ease;
        z-index: 0;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-switch-bg {
        background: #0088ff;
      }
      .overlaylex-switch-dot {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        background: #ffffff;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.28);
        transition: transform .16s ease;
        z-index: 1;
      }
      .overlaylex-switch-input:checked + .overlaylex-switch-bg {
        opacity: 1;
      }
      .overlaylex-switch-input:checked + .overlaylex-switch-bg + .overlaylex-switch-dot {
        transform: translateX(16px);
      }
      .overlaylex-package-text {
        flex: 1;
        min-width: 0;
      }
      .overlaylex-package-name {
        margin: 0;
        font-size: 13px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .overlaylex-package-meta {
        margin: 2px 0 0;
        font-size: 11px;
        color: #64748b;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-package-meta {
        color: #94a3b8;
      }
      .overlaylex-package-action {
        color: #137fec;
        opacity: .85;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .overlaylex-package-action .overlaylex-icon {
        font-size: 18px;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-package-action {
        color: #36a0ff;
      }
      .overlaylex-empty-hint {
        padding: 6px 2px;
        font-size: 12px;
        color: #64748b;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-empty-hint {
        color: #94a3b8;
      }
      .overlaylex-status {
        padding: 8px 18px 10px;
        font-size: 11px;
        color: #64748b;
        border-top: 1px solid rgba(148, 163, 184, 0.16);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-status {
        color: #94a3b8;
        border-top-color: rgba(255, 255, 255, 0.06);
      }
      .overlaylex-footer {
        padding: 10px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        background: rgba(248, 250, 252, 0.66);
        border-top: 1px solid rgba(148, 163, 184, 0.2);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-footer {
        background: rgba(0, 0, 0, 0.36);
        border-top-color: rgba(255, 255, 255, 0.1);
      }
      .overlaylex-footer-btn {
        border: none;
        background: transparent;
        cursor: pointer;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .04em;
        text-transform: uppercase;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      .overlaylex-footer-btn .overlaylex-icon {
        font-size: 16px;
      }
      .overlaylex-footer-btn.overlaylex-update {
        color: #137fec;
      }
      .overlaylex-footer-btn.overlaylex-update:hover {
        background: rgba(19, 127, 236, 0.12);
      }
      .overlaylex-footer-btn.overlaylex-close {
        color: #64748b;
      }
      .overlaylex-footer-btn.overlaylex-close:hover {
        background: rgba(148, 163, 184, 0.18);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-footer-btn.overlaylex-update {
        color: #0088ff;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-footer-btn.overlaylex-update:hover {
        background: rgba(0, 136, 255, 0.12);
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-footer-btn.overlaylex-close {
        color: #94a3b8;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-footer-btn.overlaylex-close:hover {
        background: rgba(255, 255, 255, 0.1);
      }
    `;
    document.head.appendChild(style);
  }

  function renderPackageList() {
    if (!state.ui.packageListRoot || !state.manifest) {
      return;
    }
    state.ui.packageListRoot.innerHTML = "";

    const packages = Array.isArray(state.manifest.packages) ? state.manifest.packages : [];
    if (packages.length === 0) {
      const emptyHint = document.createElement("div");
      emptyHint.className = "overlaylex-empty-hint";
      emptyHint.textContent = "当前没有可用翻译包。";
      state.ui.packageListRoot.appendChild(emptyHint);
      return;
    }

    for (const pkg of packages) {
      const row = document.createElement("div");
      row.className = "overlaylex-package-item";

      const packageActionIcon = document.createElement("span");
      packageActionIcon.className = "overlaylex-package-action";

      // 用 data-enabled 驱动视觉状态，避免把“是否启用”写死在 class 字符串里。
      const syncEnabledUi = (enabled) => {
        row.dataset.enabled = enabled ? "true" : "false";
        const packageId = String(pkg?.id || "");
        const updating = isPackageUpdating(packageId);
        if (updating) {
          packageActionIcon.innerHTML = getIconSvg("cloudDownload");
          packageActionIcon.title = "正在从云端更新该翻译包...";
          packageActionIcon.style.display = "inline-flex";
        } else {
          packageActionIcon.innerHTML = "";
          packageActionIcon.title = "";
          packageActionIcon.style.display = "none";
        }
      };

      const switchLabel = document.createElement("label");
      switchLabel.className = "overlaylex-switch";
      switchLabel.title = `启用或禁用翻译包：${pkg.id}`;

      const checkbox = document.createElement("input");
      checkbox.className = "overlaylex-switch-input";
      checkbox.type = "checkbox";
      checkbox.checked = getPackageEnabled(pkg);

      const switchBackground = document.createElement("span");
      switchBackground.className = "overlaylex-switch-bg";

      const switchDot = document.createElement("span");
      switchDot.className = "overlaylex-switch-dot";

      switchLabel.appendChild(checkbox);
      switchLabel.appendChild(switchBackground);
      switchLabel.appendChild(switchDot);

      const textWrap = document.createElement("div");
      textWrap.className = "overlaylex-package-text";

      const name = document.createElement("p");
      name.className = "overlaylex-package-name";
      name.textContent = pkg.name || pkg.id;

      const meta = document.createElement("p");
      meta.className = "overlaylex-package-meta";
      meta.textContent = `v${pkg.version} · ${pkg.id}`;

      textWrap.appendChild(name);
      textWrap.appendChild(meta);

      row.appendChild(switchLabel);
      row.appendChild(textWrap);
      row.appendChild(packageActionIcon);
      syncEnabledUi(checkbox.checked);

      checkbox.addEventListener("change", async () => {
        state.userSwitches[pkg.id] = checkbox.checked;
        safeLocalStorageSet(STORAGE_KEYS.USER_SWITCHES, state.userSwitches);
        syncEnabledUi(checkbox.checked);
        await reloadEnabledPackages();
        scheduleFullReapply();
        setStatus(`已${checkbox.checked ? "启用" : "禁用"}包: ${pkg.id}`);
      });

      state.ui.packageListRoot.appendChild(row);
    }
  }

  async function handleManualUpdateCheck() {
    setStatus("正在检查更新...");
    try {
      const latestManifest = await fetchManifest();
      state.manifest = latestManifest;
      setCachedManifest(latestManifest);

      try {
        const latestDomainPackage = await fetchDomainPackageByBestUrl();
        setCachedDomainPackage(latestDomainPackage);
      } catch (error) {
        Logger.warn("检查更新时拉取域名包失败，保留本地缓存。", error);
        showRuntimeNotice("手动更新时域名白名单拉取失败，已继续使用本地缓存。", {
          level: "warn",
          durationMs: 5800,
        });
      }

      await reloadEnabledPackages({ showUpdatingIndicator: true });
      renderPackageList();
      scheduleFullReapply();
      setStatus("更新检查完成，已应用最新 manifest。");
    } catch (error) {
      Logger.error("手动检查更新失败", error);
      setStatus("检查更新失败，已保留本地缓存。");
      showRuntimeNotice("手动更新失败：无法连接翻译后端，请检查网络或代理设置。", {
        level: "error",
        durationMs: 6800,
      });
    }
  }

  function createFloatingUi() {
    if (!isTopWindow) {
      return;
    }

    injectUiStyles();
    const uiState = getUiState();
    const EDGE_PADDING = 8;
    const BALL_SIZE = UI_TUNING.floatingBall.sizePx;
    const FALLBACK_PANEL_WIDTH = 340;
    const FALLBACK_PANEL_HEIGHT = 460;
    const DRAG_THRESHOLD = 3;
    const LONG_PRESS_MS = 650;

    // 球与面板使用两套独立锚点：
    // - 球锚点：只由球拖拽与球边界修正更新，保证“展开/收起后球不漂移”。
    // - 面板锚点：只由面板拖拽与面板边界修正更新，允许面板独立避让视口边界。
    let ballAnchorTop = Number(uiState.ballTop);
    let ballAnchorRight = Number(uiState.ballRight);
    let panelAnchorTop = Number(uiState.panelTop);
    let panelAnchorRight = Number(uiState.panelRight);
    let isPanelOpen = false;
    let suppressOpenUntil = 0;
    let longPressTimerId = null;
    let longPressFired = false;

    if (!Number.isFinite(ballAnchorTop)) {
      ballAnchorTop = 120;
    }
    if (!Number.isFinite(ballAnchorRight)) {
      ballAnchorRight = 16;
    }
    if (!Number.isFinite(panelAnchorTop)) {
      panelAnchorTop = ballAnchorTop;
    }
    if (!Number.isFinite(panelAnchorRight)) {
      panelAnchorRight = ballAnchorRight;
    }

    const ball = document.createElement("button");
    ball.className = "overlaylex-ball";
    ball.type = "button";
    ball.innerHTML = `
      <span class="overlaylex-ball-ring"></span>
      <span class="overlaylex-ball-core">${getIconSvg("translate", "overlaylex-ball-icon")}</span>
      <span class="overlaylex-ball-dot"></span>
    `;
    ball.title = "点击展开面板；长按重注入翻译";

    const panel = document.createElement("div");
    panel.className = "overlaylex-panel overlaylex-hidden";
    panel.dataset.theme = resolveEffectiveTheme(uiState.themeMode);
    panel.innerHTML = `
      <div class="overlaylex-panel-drag-handle" id="overlaylex-panel-drag-handle"></div>
      <div class="overlaylex-panel-header">
        <div class="overlaylex-panel-header-top">
          <div class="overlaylex-title-group">
            <span class="overlaylex-title-icon">${getIconSvg("translate")}</span>
            <h3 class="overlaylex-panel-title">OverlayLex 控制台</h3>
          </div>
          <button class="overlaylex-icon-btn" id="overlaylex-settings-btn" type="button" title="显示或隐藏设置">
            ${getIconSvg("settings")}
          </button>
        </div>
        <div class="overlaylex-theme-settings overlaylex-hidden" id="overlaylex-settings-panel">
          <label for="overlaylex-theme-select">主题模式</label>
          <select class="overlaylex-theme-select" id="overlaylex-theme-select">
            <option value="system">跟随系统</option>
            <option value="light">明亮模式</option>
            <option value="dark">暗夜模式</option>
          </select>
        </div>
        <button class="overlaylex-primary-btn" id="overlaylex-reapply-btn" type="button">
          ${getIconSvg("language")}
          <span>重新注入翻译</span>
        </button>
      </div>
      <div class="overlaylex-packages">
        <p class="overlaylex-packages-title">翻译包列表</p>
        <div class="overlaylex-package-list" id="overlaylex-package-list"></div>
      </div>
      <div class="overlaylex-status" id="overlaylex-status">初始化中...</div>
      <div class="overlaylex-footer">
        <button class="overlaylex-footer-btn overlaylex-update" id="overlaylex-update-btn" type="button">
          ${getIconSvg("cloudSync")}
          <span>更新云端词典</span>
        </button>
        <button class="overlaylex-footer-btn overlaylex-close" id="overlaylex-close-btn" type="button">
          ${getIconSvg("close")}
          <span>关闭面板</span>
        </button>
      </div>
    `;

    document.body.appendChild(ball);
    document.body.appendChild(panel);

    state.ui.floatingBall = ball;
    state.ui.panel = panel;
    state.ui.packageListRoot = panel.querySelector("#overlaylex-package-list");
    state.ui.statusText = panel.querySelector("#overlaylex-status");
    state.ui.settingsPanel = panel.querySelector("#overlaylex-settings-panel");
    state.ui.themeSelect = panel.querySelector("#overlaylex-theme-select");
    renderPackageList();
    applyUiTheme(uiState.themeMode);
    bindSystemThemeWatcher();

    if (state.ui.themeSelect) {
      state.ui.themeSelect.value = normalizeUiThemeMode(uiState.themeMode);
    }

    function setElementVisible(element, visible) {
      if (!element) {
        return;
      }
      element.classList.toggle("overlaylex-hidden", !visible);
    }

    function isElementVisible(element) {
      return Boolean(element) && !element.classList.contains("overlaylex-hidden");
    }

    function closeSettingsPanel() {
      if (state.ui.settingsPanel) {
        state.ui.settingsPanel.classList.add("overlaylex-hidden");
      }
    }

    function toggleSettingsPanel() {
      if (!state.ui.settingsPanel) {
        return;
      }
      state.ui.settingsPanel.classList.toggle("overlaylex-hidden");
    }

    function clampValue(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function getViewportSize() {
      return {
        width: Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0),
        height: Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0),
      };
    }

    function clampBallAnchor(top, right) {
      const viewport = getViewportSize();
      const maxTop = Math.max(EDGE_PADDING, viewport.height - BALL_SIZE - EDGE_PADDING);
      const maxRight = Math.max(EDGE_PADDING, viewport.width - BALL_SIZE - EDGE_PADDING);
      return {
        top: clampValue(top, EDGE_PADDING, maxTop),
        right: clampValue(right, EDGE_PADDING, maxRight),
      };
    }

    function clampPanelAnchor(top, right) {
      const viewport = getViewportSize();
      const panelRect = panel.getBoundingClientRect();
      const panelWidth = panelRect.width > 0 ? panelRect.width : FALLBACK_PANEL_WIDTH;
      const panelHeight =
        panelRect.height > 0
          ? panelRect.height
          : Math.min(Math.max(320, viewport.height * 0.72), FALLBACK_PANEL_HEIGHT);
      const maxTop = Math.max(EDGE_PADDING, viewport.height - panelHeight - EDGE_PADDING);
      const maxRight = Math.max(EDGE_PADDING, viewport.width - panelWidth - EDGE_PADDING);
      return {
        top: clampValue(top, EDGE_PADDING, maxTop),
        right: clampValue(right, EDGE_PADDING, maxRight),
      };
    }

    function applyBallPosition() {
      const next = clampBallAnchor(ballAnchorTop, ballAnchorRight);
      ballAnchorTop = next.top;
      ballAnchorRight = next.right;
      ball.style.top = `${ballAnchorTop}px`;
      ball.style.right = `${ballAnchorRight}px`;
    }

    function applyPanelPosition() {
      const next = clampPanelAnchor(panelAnchorTop, panelAnchorRight);
      panelAnchorTop = next.top;
      panelAnchorRight = next.right;
      panel.style.top = `${panelAnchorTop}px`;
      panel.style.right = `${panelAnchorRight}px`;
    }

    /**
     * 使用“球当前锚点”作为面板展开起点。
     * 说明：
     * - 面板展开时可以因越界被 clamp，但不会反向修改球锚点。
     * - 这样可保证“收起后球回到原位”。
     */
    function syncPanelAnchorFromBallAnchor() {
      panelAnchorTop = ballAnchorTop;
      panelAnchorRight = ballAnchorRight;
    }

    function persistUiAnchor(panelOpen) {
      setUiState({
        ballTop: Math.round(ballAnchorTop),
        ballRight: Math.round(ballAnchorRight),
        panelTop: Math.round(panelAnchorTop),
        panelRight: Math.round(panelAnchorRight),
        panelOpen: Boolean(panelOpen),
      });
    }

    function openPanelFromBall() {
      syncPanelAnchorFromBallAnchor();
      isPanelOpen = true;
      closeSettingsPanel();
      setElementVisible(panel, true);
      applyPanelPosition();
      setElementVisible(ball, false);
      persistUiAnchor(true);
    }

    function closePanelToBall() {
      isPanelOpen = false;
      closeSettingsPanel();
      setElementVisible(panel, false);
      setElementVisible(ball, true);
      applyBallPosition();
      persistUiAnchor(false);
    }

    /**
     * 点击面板外区域时，自动收起面板。
     * 说明：
     * - 使用捕获阶段监听，避免被宿主页面 stopPropagation 干扰。
     * - 只在面板已展开时生效。
     */
    function isEventInsidePanel(event) {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (Array.isArray(path) && path.includes(panel)) {
        return true;
      }
      return panel.contains(event.target);
    }

    function handleOutsidePointerDown(event) {
      if (!isPanelOpen) {
        return;
      }
      if (isEventInsidePanel(event)) {
        return;
      }
      closePanelToBall();
    }

    function getEventPoint(event) {
      if (event.touches && event.touches.length > 0) {
        return { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }
      if (event.changedTouches && event.changedTouches.length > 0) {
        return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
      }
      if (typeof event.clientX === "number" && typeof event.clientY === "number") {
        return { x: event.clientX, y: event.clientY };
      }
      return null;
    }

    function clearLongPressTimer() {
      if (longPressTimerId !== null) {
        clearTimeout(longPressTimerId);
        longPressTimerId = null;
      }
    }

    function startBallDrag(startEvent) {
      if (startEvent.type === "mousedown" && startEvent.button !== 0) {
        return;
      }
      if (!isElementVisible(ball)) {
        return;
      }
      const startPoint = getEventPoint(startEvent);
      if (!startPoint) {
        return;
      }

      if (startEvent.cancelable) {
        startEvent.preventDefault();
      }

      const dragState = {
        startX: startPoint.x,
        startY: startPoint.y,
        startTop: ballAnchorTop,
        startRight: ballAnchorRight,
        moved: false,
        frameId: null,
        pendingTop: ballAnchorTop,
        pendingRight: ballAnchorRight,
      };
      longPressFired = false;

      clearLongPressTimer();
      longPressTimerId = window.setTimeout(() => {
        if (dragState.moved || !isElementVisible(ball)) {
          return;
        }
        longPressFired = true;
        suppressOpenUntil = Date.now() + 500;
        scheduleFullReapply();
        setStatus("已长按触发重注入翻译。");
      }, LONG_PRESS_MS);

      function scheduleBallPositionFrame(nextTop, nextRight) {
        dragState.pendingTop = nextTop;
        dragState.pendingRight = nextRight;
        if (dragState.frameId !== null) {
          return;
        }
        dragState.frameId = window.requestAnimationFrame(() => {
          dragState.frameId = null;
          ballAnchorTop = dragState.pendingTop;
          ballAnchorRight = dragState.pendingRight;
          applyBallPosition();
        });
      }

      function onMove(moveEvent) {
        const movePoint = getEventPoint(moveEvent);
        if (!movePoint) {
          return;
        }
        const dx = movePoint.x - dragState.startX;
        const dy = movePoint.y - dragState.startY;
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
          if (!dragState.moved) {
            dragState.moved = true;
            ball.classList.add("overlaylex-ball-dragging");
          }
          clearLongPressTimer();
        }
        const nextTop = dragState.startTop + dy;
        const nextRight = dragState.startRight - dx;
        scheduleBallPositionFrame(nextTop, nextRight);
        if (moveEvent.cancelable && moveEvent.type.startsWith("touch")) {
          moveEvent.preventDefault();
        }
      }

      function onEnd() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onEnd);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onEnd);
        window.removeEventListener("touchcancel", onEnd);

        if (dragState.frameId !== null) {
          window.cancelAnimationFrame(dragState.frameId);
          dragState.frameId = null;
          ballAnchorTop = dragState.pendingTop;
          ballAnchorRight = dragState.pendingRight;
          applyBallPosition();
        }
        ball.classList.remove("overlaylex-ball-dragging");
        clearLongPressTimer();
        persistUiAnchor(false);
        if (dragState.moved || longPressFired) {
          suppressOpenUntil = Date.now() + 320;
        }
      }

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onEnd);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onEnd);
      window.addEventListener("touchcancel", onEnd);
    }

    function startPanelDrag(startEvent) {
      if (startEvent.type === "mousedown" && startEvent.button !== 0) {
        return;
      }
      if (!isPanelOpen) {
        return;
      }
      const startPoint = getEventPoint(startEvent);
      if (!startPoint) {
        return;
      }

      if (startEvent.cancelable) {
        startEvent.preventDefault();
      }

      const dragState = {
        startX: startPoint.x,
        startY: startPoint.y,
        startTop: panelAnchorTop,
        startRight: panelAnchorRight,
      };

      function onMove(moveEvent) {
        const movePoint = getEventPoint(moveEvent);
        if (!movePoint) {
          return;
        }
        const dx = movePoint.x - dragState.startX;
        const dy = movePoint.y - dragState.startY;
        panelAnchorTop = dragState.startTop + dy;
        panelAnchorRight = dragState.startRight - dx;
        applyPanelPosition();
        if (moveEvent.cancelable && moveEvent.type.startsWith("touch")) {
          moveEvent.preventDefault();
        }
      }

      function onEnd() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onEnd);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onEnd);
        window.removeEventListener("touchcancel", onEnd);
        persistUiAnchor(true);
      }

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onEnd);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onEnd);
      window.addEventListener("touchcancel", onEnd);
    }

    if (uiState.panelOpen) {
      openPanelFromBall();
    } else {
      closePanelToBall();
    }

    panel.querySelector("#overlaylex-reapply-btn")?.addEventListener("click", () => {
      scheduleFullReapply();
    });
    panel.querySelector("#overlaylex-update-btn")?.addEventListener("click", async () => {
      await handleManualUpdateCheck();
    });
    panel.querySelector("#overlaylex-close-btn")?.addEventListener("click", () => {
      closePanelToBall();
    });
    panel.querySelector("#overlaylex-settings-btn")?.addEventListener("click", () => {
      toggleSettingsPanel();
    });
    state.ui.themeSelect?.addEventListener("change", () => {
      const selectedMode = normalizeUiThemeMode(state.ui.themeSelect?.value);
      setUiState({ themeMode: selectedMode });
      applyUiTheme(selectedMode);
      setStatus(`主题模式已切换为：${getThemeModeLabel(selectedMode)}。`);
    });

    ball.addEventListener("click", (event) => {
      if (Date.now() < suppressOpenUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      openPanelFromBall();
    });
    ball.addEventListener("mousedown", startBallDrag);
    ball.addEventListener("touchstart", startBallDrag, { passive: false });

    const panelDragHandle = panel.querySelector("#overlaylex-panel-drag-handle");
    panelDragHandle?.addEventListener("mousedown", startPanelDrag);
    panelDragHandle?.addEventListener("touchstart", startPanelDrag, { passive: false });
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);

    window.addEventListener("resize", () => {
      if (!isPanelOpen) {
        applyBallPosition();
        persistUiAnchor(false);
        return;
      }
      applyPanelPosition();
      persistUiAnchor(true);
    });
  }

  // ------------------------------
  // 启动流程
  // ------------------------------
  async function bootManifestFromCacheFirst() {
    const cachedManifest = getCachedManifest();
    if (cachedManifest) {
      state.manifest = cachedManifest;
      Logger.info("已加载本地缓存 manifest。");
      return;
    }

    // 首次无缓存时，提供最小回退 manifest（保证脚本可启动并可拉到包）。
    state.manifest = {
      scriptVersion: SCRIPT_VERSION,
      generatedAt: new Date().toISOString(),
      domainPackage: {
        id: "overlaylex-domain-allowlist",
        version: "0.1.0",
        kind: "domain-allowlist",
        url: `${CONFIG.apiBaseUrl}/packages/overlaylex-domain-allowlist.json`,
      },
      packages: [
        {
          id: "obr-www-owlbear-rodeo",
          name: "OBR 主站与房间中文包（owlbear.rodeo）",
          kind: "translation",
          version: "0.2.0",
          url: `${CONFIG.apiBaseUrl}/packages/obr-www-owlbear-rodeo.json`,
          enabledByDefault: true,
        },
      ],
    };
  }

  async function backgroundRefreshManifestAndDomain() {
    try {
      const latestManifest = await fetchManifest();
      state.manifest = latestManifest;
      setCachedManifest(latestManifest);

      try {
        const latestDomainPackage = await fetchDomainPackageByBestUrl();
        setCachedDomainPackage(latestDomainPackage);
      } catch (error) {
        Logger.warn("后台刷新域名包失败，继续使用缓存。", error);
        showRuntimeNotice("自动更新时域名白名单拉取失败，已继续使用本地缓存。", {
          level: "warn",
          durationMs: 5200,
        });
      }

      await reloadEnabledPackages();
      renderPackageList();
      scheduleFullReapply();
      setStatus("后台更新完成，已应用最新词典。");
    } catch (error) {
      Logger.warn("后台更新 manifest 失败，继续使用本地缓存。", error);
      setStatus("后台更新失败，继续使用本地缓存。");
      showRuntimeNotice("自动更新失败：暂时无法连接翻译后端，已保留本地缓存。", {
        level: "warn",
        durationMs: 5600,
      });
    }
  }

  async function startOverlayLex() {
    if (!document.body) {
      requestAnimationFrame(startOverlayLex);
      return;
    }

    // 第一步：本地 seeds 快速门禁（毫秒级）。
    // 不在本地 OBR 生态 seeds 内的页面直接退出，避免全站无谓开销。
    const currentHostname = window.location.hostname.toLowerCase();
    if (!isHostAllowedByLocalSeeds(currentHostname)) {
      return;
    }

    // 第二步：先拿到 manifest（缓存优先），用于定位域名包 URL。
    await bootManifestFromCacheFirst();

    // 第三步：云端域名门禁。未命中白名单则立刻结束，避免无关页面继续执行。
    const gateResult = await ensureCurrentHostAllowed();
    if (!gateResult.allowed) {
      // 特别处理：仅在“首轮拉取失败且无本地缓存”时弹可视化错误，
      // 防止用户遇到“脚本亮起但页面毫无变化”却不知原因。
      if (gateResult.remoteFailed && !gateResult.hasCache) {
        showRuntimeNotice("首次启动失败：后端域名包无法访问，且本地无缓存。请先检查后端可达性。", {
          level: "error",
          durationMs: 7600,
        });
      }
      Logger.info(`当前域名不在 OverlayLex 域名包白名单内，已退出。hostname=${location.hostname}`);
      return;
    }

    // 第四步：进入正常翻译链路。
    await reloadEnabledPackages();
    createFloatingUi();
    setupMutationObserver();
    scheduleFullReapply();
    setStatus("OverlayLex 已启动。");

    // 后台异步更新，不阻塞首屏。
    backgroundRefreshManifestAndDomain();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      startOverlayLex().catch((error) => Logger.error("启动失败", error));
    });
  } else {
    startOverlayLex().catch((error) => Logger.error("启动失败", error));
  }
})();
