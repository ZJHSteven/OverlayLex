// ==UserScript==
// @name         OverlayLex
// @namespace    https://overlaylex.local
// @version      0.2.0
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
  const SCRIPT_VERSION = "0.2.0";
  const STORAGE_KEYS = {
    MANIFEST_CACHE: "overlaylex:manifest-cache:v2",
    PACKAGE_CACHE: "overlaylex:package-cache:v2",
    USER_SWITCHES: "overlaylex:user-switches:v2",
    UI_STATE: "overlaylex:ui-state:v2",
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
  function getUiState() {
    return safeLocalStorageGet(STORAGE_KEYS.UI_STATE, {
      ballTop: 120,
      ballRight: 16,
      panelOpen: false,
    });
  }

  function setUiState(patch) {
    const next = { ...getUiState(), ...patch };
    safeLocalStorageSet(STORAGE_KEYS.UI_STATE, next);
    return next;
  }

  function injectUiStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .overlaylex-ball {
        position: fixed;
        z-index: 2147483000;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: none;
        background: #155dfc;
        color: #fff;
        font-weight: 700;
        cursor: move;
        box-shadow: 0 6px 18px rgba(0,0,0,.22);
      }
      .overlaylex-panel {
        position: fixed;
        z-index: 2147483001;
        top: 72px;
        right: 16px;
        width: 380px;
        max-height: 72vh;
        overflow: auto;
        border-radius: 12px;
        border: 1px solid #d0d7de;
        background: #ffffff;
        color: #1f2328;
        font: 14px/1.45 "Microsoft YaHei UI", "PingFang SC", sans-serif;
        box-shadow: 0 12px 32px rgba(0,0,0,.25);
        padding: 12px;
      }
      .overlaylex-panel h3 {
        margin: 0 0 10px;
        font-size: 16px;
      }
      .overlaylex-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }
      .overlaylex-row button {
        border: 1px solid #d0d7de;
        background: #f6f8fa;
        padding: 6px 10px;
        border-radius: 8px;
        cursor: pointer;
      }
      .overlaylex-primary {
        width: 100%;
        margin-bottom: 8px;
        border: none !important;
        background: #2563eb !important;
        color: white;
        font-weight: 600;
      }
      .overlaylex-packages {
        border-top: 1px dashed #d0d7de;
        margin-top: 8px;
        padding-top: 8px;
      }
      .overlaylex-package-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }
      .overlaylex-status {
        margin-top: 8px;
        color: #57606a;
        font-size: 12px;
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
    for (const pkg of packages) {
      const row = document.createElement("div");
      row.className = "overlaylex-package-item";

      const label = document.createElement("label");
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.gap = "6px";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = getPackageEnabled(pkg);
      checkbox.addEventListener("change", async () => {
        state.userSwitches[pkg.id] = checkbox.checked;
        safeLocalStorageSet(STORAGE_KEYS.USER_SWITCHES, state.userSwitches);
        await reloadEnabledPackages();
        scheduleFullReapply();
        setStatus(`已${checkbox.checked ? "启用" : "禁用"}包: ${pkg.id}`);
      });

      const name = document.createElement("span");
      name.textContent = pkg.name || pkg.id;
      label.appendChild(checkbox);
      label.appendChild(name);

      const version = document.createElement("code");
      version.textContent = `v${pkg.version}`;

      row.appendChild(label);
      row.appendChild(version);
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
    panel.innerHTML = `
      <h3>OverlayLex 控制台</h3>
      <button class="overlaylex-row overlaylex-primary" id="overlaylex-reapply-btn">重新注入翻译</button>
      <div class="overlaylex-row">
        <button id="overlaylex-update-btn">检查更新</button>
        <button id="overlaylex-close-btn">关闭面板</button>
      </div>
      <div class="overlaylex-packages">
        <div style="margin-bottom:6px;font-weight:600;">翻译包开关</div>
        <div id="overlaylex-package-list"></div>
      </div>
      <div class="overlaylex-status" id="overlaylex-status">初始化中...</div>
    `;

    document.body.appendChild(ball);
    document.body.appendChild(panel);

    state.ui.floatingBall = ball;
    state.ui.panel = panel;
    state.ui.packageListRoot = panel.querySelector("#overlaylex-package-list");
    state.ui.statusText = panel.querySelector("#overlaylex-status");
    renderPackageList();

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
    ball.addEventListener("click", () => {
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      setUiState({ panelOpen: willOpen });
    });

    let drag = null;
    ball.addEventListener("pointerdown", (event) => {
      drag = {
        startX: event.clientX,
        startY: event.clientY,
        startTop: parseFloat(ball.style.top || "120"),
        startRight: parseFloat(ball.style.right || "16"),
      };
      ball.setPointerCapture(event.pointerId);
    });
    ball.addEventListener("pointermove", (event) => {
      if (!drag) {
        return;
      }
      const dy = event.clientY - drag.startY;
      const dx = event.clientX - drag.startX;
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
      drag = null;
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
          id: "obr-room-core",
          name: "OBR 房间核心中文包",
          kind: "translation",
          version: "0.1.0",
          url: `${CONFIG.apiBaseUrl}/packages/obr-room-core.json`,
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
