// ==UserScript==
// @name         OverlayLex
// @namespace    https://overlaylex.local
// @version      0.1.0
// @description  Owlbear Rodeo 文本覆盖翻译（增量、可配置、可热更新）
// @author       OverlayLex
// @match        https://www.owlbear.rodeo/*
// @match        https://owlbear.rodeo/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

/**
 * OverlayLex 主脚本（教学向注释版）
 *
 * 这个文件是“主脚本”，负责：
 * 1) 启动时读取本地缓存，尽快恢复可用翻译能力。
 * 2) 后台异步请求 manifest，检查包版本是否有更新（非阻塞）。
 * 3) 根据用户勾选的包，按需加载 JSON 翻译包，合并为内存字典。
 * 4) 对页面进行首次翻译 + 增量翻译（MutationObserver）。
 * 5) 注入悬浮球设置面板，支持手动检查更新、包开关、重注入。
 *
 * 设计目标：
 * - 不改页面结构和布局，只替换“可见文本”与输入框 placeholder/title。
 * - 不翻译 aria-* 等无障碍字段。
 * - 尽量减少性能开销，避免整页反复重刷。
 */
(function overlayLexBootstrap() {
  "use strict";

  // ------------------------------
  // 常量区：统一管理脚本配置与存储键
  // ------------------------------
  const SCRIPT_VERSION = "0.1.0";
  const STORAGE_KEYS = {
    MANIFEST_CACHE: "overlaylex:manifest-cache:v1",
    PACKAGE_CACHE: "overlaylex:package-cache:v1",
    USER_SWITCHES: "overlaylex:user-switches:v1",
    UI_STATE: "overlaylex:ui-state:v1",
  };
  const CONFIG = {
    // 这里建议替换成你自己的 Worker 地址
    apiBaseUrl: "https://overlaylex-demo.example.workers.dev",
    manifestPath: "/manifest",
    packagePathPrefix: "/packages/",
    observerDebounceMs: 80,
  };

  // ------------------------------
  // 日志与错误处理：与主流程解耦
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
  // 状态容器：集中管理运行态数据
  // ------------------------------
  const state = {
    manifest: null,
    packageCache: safeLocalStorageGet(STORAGE_KEYS.PACKAGE_CACHE, {}),
    userSwitches: safeLocalStorageGet(STORAGE_KEYS.USER_SWITCHES, {}),
    translationMap: new Map(),
    observer: null,
    isApplyingTranslation: false,
    ui: {
      floatingBall: null,
      panel: null,
      packageListRoot: null,
      statusText: null,
    },
  };

  // ------------------------------
  // 网络层：manifest 与 package 请求
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
    return fetchJsonWithTimeout(url, 5000);
  }

  async function fetchPackageByUrl(url) {
    return fetchJsonWithTimeout(url, 6000);
  }

  function buildPackageUrl(packageId) {
    return `${CONFIG.apiBaseUrl}${CONFIG.packagePathPrefix}${encodeURIComponent(packageId)}.json`;
  }

  // ------------------------------
  // 包版本策略：缓存、比对、按需更新
  // ------------------------------
  function getCachedManifest() {
    return safeLocalStorageGet(STORAGE_KEYS.MANIFEST_CACHE, null);
  }

  function setCachedManifest(manifest) {
    safeLocalStorageSet(STORAGE_KEYS.MANIFEST_CACHE, manifest);
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
    // 如果用户关掉了这个包，直接跳过加载，避免无意义内存占用。
    if (!getPackageEnabled(pkgMeta)) {
      return null;
    }

    const shouldUpdate = needsPackageUpdate(pkgMeta);
    const cached = state.packageCache[pkgMeta.id];

    // 缓存可用且版本一致时，直接命中本地缓存。
    if (!shouldUpdate && cached && cached.data) {
      return cached.data;
    }

    const packageUrl = pkgMeta.url || buildPackageUrl(pkgMeta.id);
    const packageData = await fetchPackageByUrl(packageUrl);

    // 更新内存缓存，并落盘到 localStorage。
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
      try {
        const packageData = await ensurePackageReady(pkgMeta);
        if (!packageData || typeof packageData !== "object") {
          continue;
        }
        const translations = packageData.translations || {};
        for (const [englishText, chineseText] of Object.entries(translations)) {
          if (typeof englishText !== "string" || typeof chineseText !== "string") {
            continue;
          }
          // 后加载的包会覆盖同键值，可实现“高优先级包覆盖低优先级包”。
          nextMap.set(englishText, chineseText);
        }
      } catch (error) {
        Logger.warn(`加载翻译包失败: ${pkgMeta.id}`, error);
      }
    }
    state.translationMap = nextMap;
  }

  // ------------------------------
  // 翻译层：文本节点与可见属性翻译
  // ------------------------------
  const IGNORED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"]);

  function normalizeText(text) {
    // 统一压缩多空白，有利于提升字典命中率。
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

    // 保留原始文本的首尾空白，避免 UI 间距被破坏。
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
    // 无需处理纯空白文本。
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

    let changedCount = 0;

    // 先处理 root 自己（如果是文本节点或元素节点）。
    if (rootNode.nodeType === Node.TEXT_NODE) {
      if (applyTranslationToTextNode(rootNode)) {
        changedCount += 1;
      }
      return changedCount;
    }
    if (rootNode.nodeType === Node.ELEMENT_NODE) {
      if (applyTranslationToElementAttributes(rootNode)) {
        changedCount += 1;
      }
    }

    // 再用 TreeWalker 遍历子树文本节点，做增量替换。
    const walker = document.createTreeWalker(
      rootNode,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null
    );

    let current = walker.currentNode;
    while (current) {
      if (current.nodeType === Node.TEXT_NODE) {
        if (applyTranslationToTextNode(current)) {
          changedCount += 1;
        }
      } else if (current.nodeType === Node.ELEMENT_NODE) {
        if (applyTranslationToElementAttributes(current)) {
          changedCount += 1;
        }
      }
      current = walker.nextNode();
    }
    return changedCount;
  }

  function scheduleFullReapply() {
    if (state.isApplyingTranslation) {
      return;
    }
    state.isApplyingTranslation = true;
    queueMicrotask(() => {
      try {
        const changedCount = translateSubtree(document.body);
        setStatus(`重注入完成，替换 ${changedCount} 处文本。`);
      } finally {
        state.isApplyingTranslation = false;
      }
    });
  }

  // ------------------------------
  // 监听层：只处理变更片段，避免整页重刷
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
  // UI 层：悬浮球与设置面板
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

  function setStatus(text) {
    if (state.ui.statusText) {
      state.ui.statusText.textContent = text;
    }
    Logger.info(text);
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
        width: 360px;
        max-height: 70vh;
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
      const isHidden = panel.hidden;
      panel.hidden = !isHidden;
      setUiState({ panelOpen: isHidden });
    });

    // 轻量拖拽逻辑：支持拖到页面任意边缘位置。
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
      const finalTop = parseFloat(ball.style.top || "120");
      const finalRight = parseFloat(ball.style.right || "16");
      setUiState({ ballTop: finalTop, ballRight: finalRight });
      drag = null;
    });
  }

  // ------------------------------
  // 启动流程：先可用，再后台更新
  // ------------------------------
  async function bootManifestFromCacheFirst() {
    const cachedManifest = getCachedManifest();
    if (cachedManifest) {
      state.manifest = cachedManifest;
      Logger.info("已加载本地缓存 manifest。");
      return;
    }

    // 首次没有缓存时，使用内置回退 manifest，保证 demo 可运行。
    state.manifest = {
      scriptVersion: SCRIPT_VERSION,
      generatedAt: new Date().toISOString(),
      packages: [
        {
          id: "obr-room-core",
          name: "OBR 房间核心包",
          version: "0.1.0",
          url: "https://overlaylex-demo.example.workers.dev/packages/obr-room-core.json",
          enabledByDefault: true,
        },
      ],
    };
  }

  async function backgroundRefreshManifest() {
    try {
      const latestManifest = await fetchManifest();
      const oldManifest = state.manifest;
      state.manifest = latestManifest;
      setCachedManifest(latestManifest);

      const oldVersion = oldManifest?.scriptVersion || "unknown";
      const nextVersion = latestManifest?.scriptVersion || "unknown";
      if (oldVersion !== nextVersion) {
        Logger.info(`检测到脚本版本变化: ${oldVersion} -> ${nextVersion}`);
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
    // 如果页面没有 body，则延后到下一帧再尝试，避免初始化过早。
    if (!document.body) {
      requestAnimationFrame(startOverlayLex);
      return;
    }

    await bootManifestFromCacheFirst();
    await reloadEnabledPackages();
    createFloatingUi();
    setupMutationObserver();
    scheduleFullReapply();
    setStatus("OverlayLex 已启动。");

    // 非阻塞后台刷新：不影响首屏可用性。
    backgroundRefreshManifest();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      startOverlayLex().catch((error) => Logger.error("启动失败", error));
    });
  } else {
    startOverlayLex().catch((error) => Logger.error("启动失败", error));
  }
})();
