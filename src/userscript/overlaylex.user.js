// ==UserScript==
// @name         OverlayLex
// @namespace    https://overlaylex.local
// @version      0.2.2
// @description  OverlayLex 文本覆盖翻译（包化加载、域名门禁、增量翻译、iframe 支持）
// @author       OverlayLex
// @match        *://*/*
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
  const SCRIPT_VERSION = "0.2.2";
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

  async function ensurePackageReady(pkgMeta) {
    if (!getPackageEnabled(pkgMeta)) {
      return null;
    }

    const shouldUpdate = needsPackageUpdate(pkgMeta);
    const cached = state.packageCache[pkgMeta.id];
    if (!shouldUpdate && cached && cached.data) {
      return cached.data;
    }

    const packageUrl = pkgMeta.url || buildPackageUrl(pkgMeta.id);
    const packageData = await fetchPackageByUrl(packageUrl);

    state.packageCache[pkgMeta.id] = {
      version: pkgMeta.version,
      fetchedAt: new Date().toISOString(),
      data: packageData,
    };
    safeLocalStorageSet(STORAGE_KEYS.PACKAGE_CACHE, state.packageCache);
    return packageData;
  }

  async function reloadEnabledPackages() {
    if (!state.manifest || !Array.isArray(state.manifest.packages)) {
      return;
    }

    const nextMap = new Map();
    for (const pkgMeta of state.manifest.packages) {
      // 只读取 translation 包，域名包由专门流程处理。
      if (pkgMeta.kind && pkgMeta.kind !== "translation") {
        continue;
      }
      try {
        const packageData = await ensurePackageReady(pkgMeta);
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

  async function ensureCurrentHostAllowed() {
    const hostname = window.location.hostname.toLowerCase();

    // 先用缓存快速判断，减少每次页面打开都阻塞网络。
    if (state.domainPackage && isHostAllowedByDomainPackage(hostname, state.domainPackage)) {
      return true;
    }

    // 缓存命不中，再请求最新域名包。
    try {
      const remoteDomainPackage = await fetchDomainPackageByBestUrl();
      setCachedDomainPackage(remoteDomainPackage);
      return isHostAllowedByDomainPackage(hostname, remoteDomainPackage);
    } catch (error) {
      Logger.warn("域名包拉取失败，回退到缓存判断。", error);
      // 网络失败时，如果缓存存在就按缓存兜底，否则 fail-close。
      if (state.domainPackage) {
        return isHostAllowedByDomainPackage(hostname, state.domainPackage);
      }
      return false;
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
          attributeFilter: ["placeholder", "title"],
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
      attributeFilter: ["placeholder", "title"],
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

  function injectUiStyles() {
    const style = document.createElement("style");
    style.textContent = `
      /* OverlayLex UI 样式：只影响带 overlaylex-* 前缀的节点，不污染宿主页面。 */
      .overlaylex-ball {
        position: fixed;
        z-index: 2147483000;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 1px solid transparent;
        background: #137fec;
        color: #ffffff;
        font-weight: 700;
        cursor: move;
        font: 700 14px/1 "Inter", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif;
        box-shadow: 0 10px 24px rgba(0,0,0,.24);
      }
      .overlaylex-ball[data-theme="dark"] {
        background: #0f1114;
        color: #0088ff;
        border-color: rgba(0, 136, 255, 0.46);
        box-shadow: 0 0 14px rgba(0, 136, 255, 0.18), 0 12px 28px rgba(0,0,0,.66);
      }
      .overlaylex-ball:active {
        transform: scale(0.97);
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
        width: 24px;
        height: 24px;
        border-radius: 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: rgba(19, 127, 236, 0.15);
        color: #137fec;
        font-size: 13px;
        font-weight: 800;
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
      }
      .overlaylex-switch-input:checked + .overlaylex-switch-dot {
        transform: translateX(16px);
      }
      .overlaylex-switch-input:checked ~ .overlaylex-switch-bg {
        opacity: 1;
      }
      .overlaylex-switch-bg {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        background: #137fec;
        opacity: 0;
        transition: opacity .16s ease;
      }
      .overlaylex-panel[data-theme="dark"] .overlaylex-switch-bg {
        background: #0088ff;
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

      // 用 data-enabled 驱动视觉状态，避免把“是否启用”写死在 class 字符串里。
      const syncEnabledUi = (enabled) => {
        row.dataset.enabled = enabled ? "true" : "false";
      };

      const switchLabel = document.createElement("label");
      switchLabel.className = "overlaylex-switch";
      switchLabel.title = `启用或禁用翻译包：${pkg.id}`;

      const checkbox = document.createElement("input");
      checkbox.className = "overlaylex-switch-input";
      checkbox.type = "checkbox";
      checkbox.checked = getPackageEnabled(pkg);

      const switchDot = document.createElement("span");
      switchDot.className = "overlaylex-switch-dot";

      const switchBackground = document.createElement("span");
      switchBackground.className = "overlaylex-switch-bg";

      switchLabel.appendChild(checkbox);
      switchLabel.appendChild(switchDot);
      switchLabel.appendChild(switchBackground);

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
      }

      await reloadEnabledPackages();
      renderPackageList();
      scheduleFullReapply();
      setStatus("更新检查完成，已应用最新 manifest。");
    } catch (error) {
      Logger.error("手动检查更新失败", error);
      setStatus("检查更新失败，已保留本地缓存。");
    }
  }

  function createFloatingUi() {
    // 只在顶层页面渲染控制台，避免 iframe 内重复弹多个球。
    if (!isTopWindow) {
      return;
    }

    injectUiStyles();
    const uiState = getUiState();

    const ball = document.createElement("button");
    ball.className = "overlaylex-ball";
    ball.textContent = "译";
    ball.style.top = `${uiState.ballTop}px`;
    ball.style.right = `${uiState.ballRight}px`;
    ball.title = "OverlayLex 设置";

    const panel = document.createElement("div");
    panel.className = "overlaylex-panel";
    panel.hidden = !uiState.panelOpen;
    panel.dataset.theme = resolveEffectiveTheme(uiState.themeMode);
    panel.innerHTML = `
      <div class="overlaylex-panel-drag-handle"></div>
      <div class="overlaylex-panel-header">
        <div class="overlaylex-panel-header-top">
          <div class="overlaylex-title-group">
            <span class="overlaylex-title-icon">译</span>
            <h3 class="overlaylex-panel-title">OverlayLex 控制台</h3>
          </div>
          <button class="overlaylex-icon-btn" id="overlaylex-settings-btn" type="button" title="显示或隐藏设置">⚙</button>
        </div>
        <div class="overlaylex-theme-settings" id="overlaylex-settings-panel" hidden>
          <label for="overlaylex-theme-select">主题模式</label>
          <select class="overlaylex-theme-select" id="overlaylex-theme-select">
            <option value="system">跟随系统</option>
            <option value="light">明亮模式</option>
            <option value="dark">暗夜模式</option>
          </select>
        </div>
        <button class="overlaylex-primary-btn" id="overlaylex-reapply-btn" type="button">重新注入翻译</button>
      </div>
      <div class="overlaylex-packages">
        <p class="overlaylex-packages-title">翻译包列表</p>
        <div class="overlaylex-package-list" id="overlaylex-package-list"></div>
      </div>
      <div class="overlaylex-status" id="overlaylex-status">初始化中...</div>
      <div class="overlaylex-footer">
        <button class="overlaylex-footer-btn overlaylex-update" id="overlaylex-update-btn" type="button">更新云端词典</button>
        <button class="overlaylex-footer-btn overlaylex-close" id="overlaylex-close-btn" type="button">关闭面板</button>
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

    panel.querySelector("#overlaylex-reapply-btn")?.addEventListener("click", () => {
      scheduleFullReapply();
    });
    panel.querySelector("#overlaylex-update-btn")?.addEventListener("click", async () => {
      await handleManualUpdateCheck();
    });
    panel.querySelector("#overlaylex-close-btn")?.addEventListener("click", () => {
      panel.hidden = true;
      setUiState({ panelOpen: false });
    });
    panel.querySelector("#overlaylex-settings-btn")?.addEventListener("click", () => {
      if (!state.ui.settingsPanel) {
        return;
      }
      state.ui.settingsPanel.hidden = !state.ui.settingsPanel.hidden;
    });
    state.ui.themeSelect?.addEventListener("change", () => {
      const selectedMode = normalizeUiThemeMode(state.ui.themeSelect?.value);
      setUiState({ themeMode: selectedMode });
      applyUiTheme(selectedMode);
      setStatus(`主题模式已切换为：${getThemeModeLabel(selectedMode)}。`);
    });
    let drag = null;
    let suppressClick = false;
    ball.addEventListener("pointerdown", (event) => {
      drag = {
        startX: event.clientX,
        startY: event.clientY,
        startTop: parseFloat(ball.style.top || "120"),
        startRight: parseFloat(ball.style.right || "16"),
        moved: false,
      };
      ball.setPointerCapture(event.pointerId);
    });
    ball.addEventListener("pointermove", (event) => {
      if (!drag) {
        return;
      }
      const dy = event.clientY - drag.startY;
      const dx = event.clientX - drag.startX;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        drag.moved = true;
      }
      const nextTop = Math.max(4, drag.startTop + dy);
      const nextRight = Math.max(4, drag.startRight - dx);
      ball.style.top = `${nextTop}px`;
      ball.style.right = `${nextRight}px`;
    });
    ball.addEventListener("pointerup", (event) => {
      if (!drag) {
        return;
      }
      ball.releasePointerCapture(event.pointerId);
      setUiState({
        ballTop: parseFloat(ball.style.top || "120"),
        ballRight: parseFloat(ball.style.right || "16"),
      });
      suppressClick = drag.moved;
      queueMicrotask(() => {
        suppressClick = false;
      });
      drag = null;
    });
    ball.addEventListener("click", (event) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      setUiState({ panelOpen: willOpen });
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
      }

      await reloadEnabledPackages();
      renderPackageList();
      scheduleFullReapply();
      setStatus("后台更新完成，已应用最新词典。");
    } catch (error) {
      Logger.warn("后台更新 manifest 失败，继续使用本地缓存。", error);
      setStatus("后台更新失败，继续使用本地缓存。");
    }
  }

  async function startOverlayLex() {
    if (!document.body) {
      requestAnimationFrame(startOverlayLex);
      return;
    }

    // 第一步：先拿到 manifest（缓存优先），用于定位域名包 URL。
    await bootManifestFromCacheFirst();

    // 第二步：域名门禁。未命中白名单则立刻结束，避免全站额外开销。
    const allowed = await ensureCurrentHostAllowed();
    if (!allowed) {
      Logger.info(`当前域名不在 OverlayLex 域名包白名单内，已退出。hostname=${location.hostname}`);
      return;
    }

    // 第三步：进入正常翻译链路。
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
