// ==UserScript==
// @name         OverlayLex Collector
// @namespace    https://github.com/ZJHSteven/OverlayLex
// @version      0.1.3
// @description  OverlayLex 采集脚本：实时收集页面英文词条并导出为翻译原文素材。
// @author       OverlayLex
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/ZJHSteven/OverlayLex/main/src/userscript/overlaylex.collector.user.js
// @downloadURL  https://raw.githubusercontent.com/ZJHSteven/OverlayLex/main/src/userscript/overlaylex.collector.user.js
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// ==/UserScript==

/**
 * OverlayLex 实时采集器（独立脚本）
 *
 * 设计目标：
 * 1) 与主翻译脚本完全解耦，采集器可以单独启用/禁用。
 * 2) 全站运行，不做域名门禁，用于测试阶段“尽量不漏词”。
 * 3) 采集结果按域名分层，自动去重，支持增量导出。
 * 4) 顶层页面只显示一个悬浮球，避免 iframe 里出现多个面板。
 * 5) 记录 iframe 域名，帮助定位插件来源站点。
 */
(function overlayLexCollectorBootstrap() {
  "use strict";

  // ------------------------------
  // 常量区
  // ------------------------------
  const STORAGE_KEY = "overlaylex:collector:global:v1";
  const MESSAGE_TYPE = "overlaylex:collector-message:v1";
  const IS_TOP_WINDOW = window.top === window.self;
  const UI_ID_PREFIX = "overlaylex-collector";
  const OBSERVER_DEBOUNCE_MS = 80;
  const ACTIVITY_CAPTURE_DELAY_MS = 90;
  const CJK_REGEX = /[\u3400-\u9fff]/;
  const IGNORED_TEXT_PARENT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE"]);

  // ------------------------------
  // 日志工具
  // ------------------------------
  const Logger = {
    info(...args) {
      console.info("[OverlayLex Collector]", ...args);
    },
    warn(...args) {
      console.warn("[OverlayLex Collector]", ...args);
    },
    error(...args) {
      console.error("[OverlayLex Collector]", ...args);
    },
  };

  // ------------------------------
  // 数据存储层（优先 GM 存储，回退 localStorage）
  // ------------------------------
  function createEmptyStore() {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      hosts: {},
    };
  }

  function normalizeStoreShape(raw) {
    if (!raw || typeof raw !== "object") {
      return createEmptyStore();
    }
    if (raw.version !== 1 || typeof raw.hosts !== "object") {
      return createEmptyStore();
    }
    return raw;
  }

  function readStore() {
    try {
      if (typeof GM_getValue === "function") {
        return normalizeStoreShape(GM_getValue(STORAGE_KEY, createEmptyStore()));
      }
    } catch (error) {
      Logger.warn("读取 GM 存储失败，将回退 localStorage。", error);
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return createEmptyStore();
      }
      return normalizeStoreShape(JSON.parse(raw));
    } catch (error) {
      Logger.warn("读取 localStorage 失败，使用空采集仓。", error);
      return createEmptyStore();
    }
  }

  function writeStore(store) {
    store.updatedAt = new Date().toISOString();
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(STORAGE_KEY, store);
        return;
      }
    } catch (error) {
      Logger.warn("写入 GM 存储失败，将回退 localStorage。", error);
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (error) {
      Logger.warn("写入 localStorage 失败。", error);
    }
  }

  const state = {
    store: readStore(),
    persistTimerId: null,
    ui: {
      ball: null,
      panel: null,
      status: null,
      hostSelect: null,
    },
  };

  function ensureHostBucket(hostname) {
    if (!state.store.hosts[hostname]) {
      state.store.hosts[hostname] = {
        texts: {},
        exportedTexts: {},
        iframeHosts: {},
        lastUpdatedAt: new Date().toISOString(),
      };
    }
    return state.store.hosts[hostname];
  }

  function schedulePersistStore() {
    if (state.persistTimerId !== null) {
      return;
    }
    state.persistTimerId = window.setTimeout(() => {
      state.persistTimerId = null;
      writeStore(state.store);
      refreshStatusText();
    }, 120);
  }

  // ------------------------------
  // 文本标准化与去重判定
  // ------------------------------
  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function shouldCollectText(text) {
    const normalized = normalizeText(text);
    if (!normalized || normalized.length < 2) {
      return false;
    }
    // 必须包含英文字母，否则不采集。
    if (!/[A-Za-z]/.test(normalized)) {
      return false;
    }
    // 含中文的混合字符串直接过滤，只保留“纯英文向”词条。
    if (CJK_REGEX.test(normalized)) {
      return false;
    }
    if (/^https?:\/\//i.test(normalized)) {
      return false;
    }
    // 过滤明显的脚本/CSS 片段，避免把运行时代码误当成翻译词条。
    if (
      /[{};]/.test(normalized) &&
      /(function\s*\(|=>|var\s+|let\s+|const\s+|document\.|window\.|createElement|appendChild|scrollbar-width|@media)/i.test(
        normalized
      )
    ) {
      return false;
    }
    return true;
  }

  function canCollectFromTextNode(textNode) {
    const parent = textNode?.parentElement;
    if (!parent) {
      return false;
    }
    if (IGNORED_TEXT_PARENT_TAGS.has(parent.tagName)) {
      return false;
    }
    return true;
  }

  /**
   * 判断一个元素是否属于“可采集 value 文本”的按钮类 input。
   * 输入：
   * - element: 任意 DOM 元素
   * 输出：
   * - true: 属于 input[type=button|submit|reset]，其 value 通常是静态 UI 文案，适合采集
   * - false: 其他元素或输入型控件（text/password 等），避免把用户输入误采集进词条
   */
  function isCollectableInputValueElement(element) {
    if (!element || element.tagName !== "INPUT") {
      return false;
    }
    const typeRaw = String(element.getAttribute?.("type") || element.type || "text").toLowerCase();
    return typeRaw === "button" || typeRaw === "submit" || typeRaw === "reset";
  }

  /**
   * 采集单个元素上“非文本节点”的可翻译属性。
   * 说明：
   * - placeholder/title 是原有覆盖范围；
   * - input[value] 仅限按钮类，避免把用户输入内容作为词条污染词库。
   */
  function collectFromElementAttributes(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const placeholder = element.getAttribute?.("placeholder");
    if (placeholder) {
      collectTextCandidate(placeholder, "placeholder");
    }
    const title = element.getAttribute?.("title");
    if (title) {
      collectTextCandidate(title, "title");
    }
    if (isCollectableInputValueElement(element)) {
      const valueText = String(element.getAttribute?.("value") || element.value || "");
      if (valueText) {
        collectTextCandidate(valueText, "input-value");
      }
    }
  }

  // ------------------------------
  // 跨 frame 汇聚（frame -> top）
  // ------------------------------
  function sendMessageToTop(payload) {
    if (IS_TOP_WINDOW) {
      return;
    }
    try {
      window.top.postMessage(
        {
          __overlaylex: MESSAGE_TYPE,
          ...payload,
        },
        "*"
      );
    } catch (error) {
      // 某些受限上下文无法访问 top，忽略即可。
    }
  }

  function setupTopMessageBridge() {
    if (!IS_TOP_WINDOW) {
      return;
    }
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") {
        return;
      }
      if (data.__overlaylex !== MESSAGE_TYPE) {
        return;
      }

      if (data.event === "candidate") {
        collectTextCandidate(data.text, data.sourceType || "text", data.host);
      }
      if (data.event === "iframe-host") {
        collectIframeHost(data.host, data.ownerHost || window.location.hostname.toLowerCase());
      }
    });
  }

  // ------------------------------
  // 采集核心逻辑
  // ------------------------------
  function collectTextCandidate(rawText, sourceType = "text", hostOverride = null) {
    if (!shouldCollectText(rawText)) {
      return false;
    }
    const normalized = normalizeText(rawText);
    const host = normalizeText(hostOverride || window.location.hostname).toLowerCase();
    if (!host) {
      return false;
    }

    const bucket = ensureHostBucket(host);
    const existing = bucket.texts[normalized];
    const now = new Date().toISOString();
    const isNew = !existing;

    if (!existing) {
      bucket.texts[normalized] = {
        firstSeenAt: now,
        lastSeenAt: now,
        count: 1,
        sources: { [sourceType]: true },
      };
    } else {
      existing.lastSeenAt = now;
      existing.count += 1;
      existing.sources[sourceType] = true;
    }
    bucket.lastUpdatedAt = now;
    schedulePersistStore();

    // frame 中的新词条上报给顶层，便于统一面板查看。
    if (isNew && !IS_TOP_WINDOW) {
      sendMessageToTop({
        event: "candidate",
        host,
        text: normalized,
        sourceType,
      });
    }
    return isNew;
  }

  function collectIframeHost(iframeHost, ownerHost) {
    const host = normalizeText(iframeHost).toLowerCase();
    const owner = normalizeText(ownerHost || window.location.hostname).toLowerCase();
    if (!host || !owner) {
      return;
    }
    const bucket = ensureHostBucket(owner);
    const now = new Date().toISOString();
    const existing = bucket.iframeHosts[host];
    if (!existing) {
      bucket.iframeHosts[host] = {
        firstSeenAt: now,
        lastSeenAt: now,
        count: 1,
      };
    } else {
      existing.lastSeenAt = now;
      existing.count += 1;
    }
    bucket.lastUpdatedAt = now;
    schedulePersistStore();
  }

  function collectIframeHostFromElement(iframeElement) {
    if (!(iframeElement instanceof HTMLIFrameElement)) {
      return;
    }
    const ownerHost = window.location.hostname.toLowerCase();
    const src = iframeElement.getAttribute("src") || "";
    if (src) {
      try {
        const parsed = new URL(src, window.location.href);
        if (parsed.hostname) {
          collectIframeHost(parsed.hostname, ownerHost);
        }
      } catch (error) {
        // src 解析失败时忽略。
      }
    }
    try {
      const frameHost = iframeElement.contentDocument?.location?.hostname;
      if (frameHost) {
        collectIframeHost(frameHost, ownerHost);
      }
    } catch (error) {
      // 跨域 iframe 正常会抛异常，忽略即可。
    }
  }

  function collectFromNode(rootNode) {
    if (!rootNode) {
      return;
    }
    if (isNodeInsideCollectorUI(rootNode)) {
      return;
    }

    const ownerDocument = rootNode.ownerDocument || document;
    const ownerWindow = ownerDocument.defaultView || window;
    const NodeConst = ownerWindow.Node;
    const NodeFilterConst = ownerWindow.NodeFilter;

    if (rootNode.nodeType === NodeConst.TEXT_NODE) {
      if (isNodeInsideCollectorUI(rootNode)) {
        return;
      }
      if (!canCollectFromTextNode(rootNode)) {
        return;
      }
      collectTextCandidate(rootNode.nodeValue || "", "text");
      return;
    }

    if (rootNode.nodeType === NodeConst.ELEMENT_NODE) {
      const element = rootNode;
      collectFromElementAttributes(element);
      if (element.tagName === "IFRAME") {
        collectIframeHostFromElement(element);
      }
    }

    const walker = ownerDocument.createTreeWalker(
      rootNode,
      NodeFilterConst.SHOW_TEXT | NodeFilterConst.SHOW_ELEMENT,
      null
    );

    let current = walker.currentNode;
    while (current) {
      if (current.nodeType === NodeConst.TEXT_NODE) {
        if (isNodeInsideCollectorUI(current)) {
          current = walker.nextNode();
          continue;
        }
        if (!canCollectFromTextNode(current)) {
          current = walker.nextNode();
          continue;
        }
        collectTextCandidate(current.nodeValue || "", "text");
      } else if (current.nodeType === NodeConst.ELEMENT_NODE) {
        if (isNodeInsideCollectorUI(current)) {
          current = walker.nextNode();
          continue;
        }
        collectFromElementAttributes(current);
        if (current.tagName === "IFRAME") {
          collectIframeHostFromElement(current);
        }
      }
      current = walker.nextNode();
    }
  }

  function setupMutationCollector() {
    const root = document.body;
    if (!root) {
      return;
    }

    let timerId = null;
    const pendingNodes = new Set();

    function flush() {
      timerId = null;
      for (const node of pendingNodes) {
        if (isNodeInsideCollectorUI(node)) {
          continue;
        }
        collectFromNode(node);
      }
      pendingNodes.clear();
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
      timerId = window.setTimeout(flush, OBSERVER_DEBOUNCE_MS);
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["placeholder", "title", "value", "src"],
    });
  }

  function setupActivityCollector() {
    const eventNames = ["click", "mouseenter", "focusin"];
    let timerId = null;
    let pendingTarget = null;

    function flush() {
      timerId = null;
      if (pendingTarget) {
        collectFromNode(pendingTarget);
      }
      collectFromNode(document.body);
      pendingTarget = null;
    }

    function schedule(target) {
      if (isNodeInsideCollectorUI(target)) {
        return;
      }
      pendingTarget = target || pendingTarget;
      if (timerId !== null) {
        return;
      }
      timerId = window.setTimeout(flush, ACTIVITY_CAPTURE_DELAY_MS);
    }

    for (const eventName of eventNames) {
      document.addEventListener(
        eventName,
        (event) => {
          const target =
            event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : document.body;
          schedule(target);
        },
        true
      );
    }
  }

  // ------------------------------
  // 导出与复制
  // ------------------------------
  function copyToClipboard(text) {
    try {
      if (typeof GM_setClipboard === "function") {
        GM_setClipboard(text, "text");
        return true;
      }
    } catch (error) {
      Logger.warn("GM_setClipboard 失败，将回退浏览器剪贴板。", error);
    }

    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      Logger.warn("navigator.clipboard 失败。", error);
    }
    return false;
  }

  function isNodeInsideCollectorUI(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) {
      return false;
    }
    if (typeof element.id === "string" && element.id.startsWith(UI_ID_PREFIX)) {
      return true;
    }
    return Boolean(element.closest?.(`[id^="${UI_ID_PREFIX}"]`));
  }

  function collectHostTexts(host, incremental) {
    const bucket = ensureHostBucket(host);
    const allTexts = Object.keys(bucket.texts);
    const picked = incremental ? allTexts.filter((text) => !bucket.exportedTexts[text]) : allTexts;
    picked.sort((a, b) => a.localeCompare(b, "en"));
    return picked;
  }

  /**
   * buildHostScopedExport:
   * 导出“按域名分组 JSON”格式，便于后续直接粘贴到临时文件并人工筛选。
   * 输出示例：
   * {
   *   "smoke.battle-system.com": ["Text A", "Text B"],
   *   "www.owlbear.rodeo": ["Text C"]
   * }
   */
  function buildHostScopedExport(hosts, incremental) {
    const sortedHosts = [...hosts].sort((a, b) => a.localeCompare(b, "en"));
    const payload = {};
    const selectedByHost = {};
    for (const host of sortedHosts) {
      const texts = collectHostTexts(host, incremental);
      selectedByHost[host] = texts;
      payload[host] = texts;
    }
    return {
      serialized: JSON.stringify(payload, null, 2),
      selectedByHost,
    };
  }

  function getSortedHostList() {
    return Object.keys(state.store.hosts).sort((a, b) => a.localeCompare(b, "en"));
  }

  function markExportedByHost(selectedByHost) {
    for (const [host, texts] of Object.entries(selectedByHost)) {
      const bucket = ensureHostBucket(host);
      for (const text of texts) {
        bucket.exportedTexts[text] = true;
      }
    }
    schedulePersistStore();
  }

  function clearCurrentHostData() {
    const host = window.location.hostname.toLowerCase();
    if (!state.store.hosts[host]) {
      return false;
    }
    delete state.store.hosts[host];
    schedulePersistStore();
    return true;
  }

  function clearAllCollectorData() {
    state.store = createEmptyStore();
    schedulePersistStore();
  }

  function setStatusText(text) {
    if (state.ui.status) {
      state.ui.status.textContent = text;
    }
  }

  function refreshStatusText() {
    if (!IS_TOP_WINDOW) {
      return;
    }
    const host = window.location.hostname.toLowerCase();
    const bucket = ensureHostBucket(host);
    const total = Object.keys(bucket.texts).length;
    const pending = Object.keys(bucket.texts).filter((text) => !bucket.exportedTexts[text]).length;
    const iframeHosts = Object.keys(bucket.iframeHosts).length;
    setStatusText(`当前域名：总计 ${total}，未导出 ${pending}，iframe 域名 ${iframeHosts}。`);
    refreshHostSelectorOptions();
  }

  function refreshHostSelectorOptions(preferredHost = null) {
    const selector = state.ui.hostSelect;
    if (!selector) {
      return;
    }

    const currentValue = preferredHost || selector.value || window.location.hostname.toLowerCase();
    const hosts = getSortedHostList();
    selector.innerHTML = "";

    if (hosts.length === 0) {
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = "（暂无域名数据）";
      selector.appendChild(emptyOption);
      selector.value = "";
      return;
    }

    for (const host of hosts) {
      const option = document.createElement("option");
      option.value = host;
      option.textContent = host;
      selector.appendChild(option);
    }

    if (hosts.includes(currentValue)) {
      selector.value = currentValue;
      return;
    }
    selector.value = hosts[0];
  }

  // ------------------------------
  // UI（仅顶层窗口）
  // ------------------------------
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #${UI_ID_PREFIX}-ball {
        position: fixed;
        z-index: 2147483100;
        top: 170px;
        right: 16px;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: none;
        background: #0e9f6e;
        color: #fff;
        font-weight: 700;
        cursor: move;
        box-shadow: 0 6px 18px rgba(0,0,0,.22);
      }
      #${UI_ID_PREFIX}-panel {
        position: fixed;
        z-index: 2147483101;
        top: 130px;
        right: 16px;
        width: 390px;
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
      .${UI_ID_PREFIX}-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }
      .${UI_ID_PREFIX}-row button {
        border: 1px solid #d0d7de;
        background: #f6f8fa;
        padding: 6px 10px;
        border-radius: 8px;
        cursor: pointer;
      }
      #${UI_ID_PREFIX}-status {
        margin-top: 8px;
        color: #57606a;
        font-size: 12px;
      }
    `;
    document.head.appendChild(style);
  }

  function createTopUI() {
    if (!IS_TOP_WINDOW) {
      return;
    }
    injectStyles();

    const ball = document.createElement("button");
    ball.id = `${UI_ID_PREFIX}-ball`;
    ball.textContent = "采";
    ball.title = "OverlayLex 采集器";

    const panel = document.createElement("div");
    panel.id = `${UI_ID_PREFIX}-panel`;
    panel.hidden = true;
    panel.innerHTML = `
      <h3 style="margin:0 0 10px;">OverlayLex 采集器</h3>
      <div class="${UI_ID_PREFIX}-row">
        <button id="${UI_ID_PREFIX}-copy-increment">复制本域增量</button>
        <button id="${UI_ID_PREFIX}-copy-full">复制本域全量</button>
      </div>
      <div class="${UI_ID_PREFIX}-row">
        <button id="${UI_ID_PREFIX}-copy-all-merged">一键复制全部域名</button>
      </div>
      <div class="${UI_ID_PREFIX}-row">
        <select id="${UI_ID_PREFIX}-host-select" style="flex:1;border:1px solid #d0d7de;border-radius:8px;padding:6px;"></select>
        <button id="${UI_ID_PREFIX}-copy-selected-host">复制选定域名</button>
      </div>
      <div class="${UI_ID_PREFIX}-row">
        <button id="${UI_ID_PREFIX}-copy-iframe-hosts">复制本域 iframe 域名</button>
        <button id="${UI_ID_PREFIX}-reset-exported">重置本域增量游标</button>
      </div>
      <div class="${UI_ID_PREFIX}-row">
        <button id="${UI_ID_PREFIX}-clear-current-host">清空当前域数据</button>
        <button id="${UI_ID_PREFIX}-clear-all-hosts">清空全部采集数据</button>
      </div>
      <div class="${UI_ID_PREFIX}-row">
        <button id="${UI_ID_PREFIX}-close">关闭</button>
      </div>
      <div id="${UI_ID_PREFIX}-status">初始化中...</div>
    `;

    document.body.appendChild(ball);
    document.body.appendChild(panel);
    state.ui.ball = ball;
    state.ui.panel = panel;
    state.ui.status = panel.querySelector(`#${UI_ID_PREFIX}-status`);
    state.ui.hostSelect = panel.querySelector(`#${UI_ID_PREFIX}-host-select`);
    refreshHostSelectorOptions(window.location.hostname.toLowerCase());

    let lastPointerWasDrag = false;
    ball.addEventListener("click", () => {
      // 拖拽释放后会触发 click，这里要跳过一次，避免“拖一下就误打开面板”。
      if (lastPointerWasDrag) {
        lastPointerWasDrag = false;
        return;
      }
      panel.hidden = !panel.hidden;
      refreshStatusText();
    });

    // 悬浮球拖拽：支持拖到任意边缘，方便不遮挡页面内容。
    let drag = null;
    ball.addEventListener("pointerdown", (event) => {
      const style = window.getComputedStyle(ball);
      drag = {
        startX: event.clientX,
        startY: event.clientY,
        startTop: parseFloat(style.top || "170"),
        startRight: parseFloat(style.right || "16"),
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
      const nextTop = Math.max(4, Math.min(window.innerHeight - 48, drag.startTop + dy));
      const nextRight = Math.max(4, Math.min(window.innerWidth - 48, drag.startRight - dx));
      ball.style.top = `${nextTop}px`;
      ball.style.right = `${nextRight}px`;
    });
    ball.addEventListener("pointerup", (event) => {
      if (!drag) {
        return;
      }
      lastPointerWasDrag = drag.moved;
      ball.releasePointerCapture(event.pointerId);
      drag = null;
    });

    panel.querySelector(`#${UI_ID_PREFIX}-close`)?.addEventListener("click", () => {
      panel.hidden = true;
    });

    panel.querySelector(`#${UI_ID_PREFIX}-copy-increment`)?.addEventListener("click", () => {
      const host = window.location.hostname.toLowerCase();
      const { serialized, selectedByHost } = buildHostScopedExport([host], true);
      const copied = copyToClipboard(serialized);
      if (!copied) {
        setStatusText("复制失败：请检查剪贴板权限。");
        return;
      }
      markExportedByHost(selectedByHost);
      setStatusText(`复制本域增量 JSON 成功：${selectedByHost[host]?.length || 0} 条。`);
    });

    panel.querySelector(`#${UI_ID_PREFIX}-copy-full`)?.addEventListener("click", () => {
      const host = window.location.hostname.toLowerCase();
      const { serialized, selectedByHost } = buildHostScopedExport([host], false);
      const copied = copyToClipboard(serialized);
      if (!copied) {
        setStatusText("复制失败：请检查剪贴板权限。");
        return;
      }
      setStatusText(`复制本域全量 JSON 成功：${selectedByHost[host]?.length || 0} 条。`);
    });

    panel.querySelector(`#${UI_ID_PREFIX}-copy-all-merged`)?.addEventListener("click", () => {
      const allHosts = getSortedHostList();
      const { serialized } = buildHostScopedExport(allHosts, false);
      const copied = copyToClipboard(serialized);
      if (!copied) {
        setStatusText("复制失败：请检查剪贴板权限。");
        return;
      }
      setStatusText(`一键复制全部域名 JSON 成功：跨 ${allHosts.length} 个域名。`);
    });

    panel.querySelector(`#${UI_ID_PREFIX}-copy-selected-host`)?.addEventListener("click", () => {
      const selectedHost = state.ui.hostSelect?.value || "";
      if (!selectedHost) {
        setStatusText("没有可复制的域名数据。");
        return;
      }
      const { serialized, selectedByHost } = buildHostScopedExport([selectedHost], false);
      const copied = copyToClipboard(serialized);
      if (!copied) {
        setStatusText("复制失败：请检查剪贴板权限。");
        return;
      }
      setStatusText(`复制选定域名 JSON 成功：${selectedByHost[selectedHost]?.length || 0} 条。`);
    });

    panel.querySelector(`#${UI_ID_PREFIX}-copy-iframe-hosts`)?.addEventListener("click", () => {
      const host = window.location.hostname.toLowerCase();
      const bucket = ensureHostBucket(host);
      const payload = {
        host,
        exportedAt: new Date().toISOString(),
        iframeHosts: Object.keys(bucket.iframeHosts).sort(),
      };
      const copied = copyToClipboard(JSON.stringify(payload, null, 2));
      if (!copied) {
        setStatusText("复制 iframe 域名失败：请检查剪贴板权限。");
        return;
      }
      setStatusText(`复制 iframe 域名成功：${payload.iframeHosts.length} 个。`);
    });

    panel.querySelector(`#${UI_ID_PREFIX}-reset-exported`)?.addEventListener("click", () => {
      const host = window.location.hostname.toLowerCase();
      const bucket = ensureHostBucket(host);
      bucket.exportedTexts = {};
      schedulePersistStore();
      setStatusText("已重置本域增量游标。");
    });

    panel.querySelector(`#${UI_ID_PREFIX}-clear-current-host`)?.addEventListener("click", () => {
      const host = window.location.hostname.toLowerCase();
      const confirmed = window.confirm(`确认清空当前域名（${host}）的全部采集数据吗？`);
      if (!confirmed) {
        return;
      }
      const removed = clearCurrentHostData();
      refreshStatusText();
      if (!removed) {
        setStatusText(`当前域名（${host}）没有可清空的数据。`);
        return;
      }
      setStatusText(`已清空当前域名（${host}）的采集数据。`);
    });

    panel.querySelector(`#${UI_ID_PREFIX}-clear-all-hosts`)?.addEventListener("click", () => {
      const hostCount = Object.keys(state.store.hosts).length;
      const confirmed = window.confirm(`确认清空全部采集数据吗？当前包含 ${hostCount} 个域名。`);
      if (!confirmed) {
        return;
      }
      clearAllCollectorData();
      refreshStatusText();
      setStatusText("已清空全部采集数据。");
    });

    refreshStatusText();
  }

  // ------------------------------
  // 启动流程
  // ------------------------------
  function bootCollector() {
    if (!document.body) {
      requestAnimationFrame(bootCollector);
      return;
    }

    setupTopMessageBridge();
    createTopUI();
    setupMutationCollector();
    setupActivityCollector();
    collectFromNode(document.body);

    // frame 页面上报自身域名，帮助顶层标记插件来源。
    if (!IS_TOP_WINDOW) {
      sendMessageToTop({
        event: "iframe-host",
        host: window.location.hostname.toLowerCase(),
        ownerHost: document.referrer ? new URL(document.referrer).hostname.toLowerCase() : "",
      });
    }

    Logger.info("采集器已启动。", {
      top: IS_TOP_WINDOW,
      host: window.location.hostname,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootCollector);
  } else {
    bootCollector();
  }
})();
