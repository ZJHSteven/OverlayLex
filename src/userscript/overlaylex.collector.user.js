// ==UserScript==
// @name         OverlayLex Collector
// @namespace    https://github.com/ZJHSteven/OverlayLex
// @version      0.2.0
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
  const SETTINGS_KEY = "overlaylex:collector:settings:v1";
  const MESSAGE_TYPE = "overlaylex:collector-message:v1";
  const IS_TOP_WINDOW = window.top === window.self;
  const UI_ID_PREFIX = "overlaylex-collector";
  const OBSERVER_DEBOUNCE_MS = 80;
  const ACTIVITY_CAPTURE_DELAY_MS = 90;
  const COLLECTOR_UPLOAD_API_BASE = "https://overlaylex-api.zjhstudio.com";
  const COLLECTOR_UPLOAD_SCOPE = "current-host-incremental";
  const COLLECTOR_UPLOAD_API_PATH = "/collector/submissions";
  const SCRIPT_VERSION = "0.2.0";
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

  /**
   * createDefaultSettings:
   * - 目标：保存采集器 UI 布局、邀请码、协作者昵称等“配置类状态”。
   * - 说明：与采集数据分离，避免清空采集数据时误删配置。
   */
  function createDefaultSettings() {
    return {
      version: 1,
      inviteCode: "",
      alias: "",
      lastSubmissionId: "",
      ui: {
        ballTop: 170,
        ballRight: 16,
        panelTop: 120,
        panelRight: 16,
        panelOpen: false,
        advancedOpen: false,
        settingsOpen: false,
      },
    };
  }

  function normalizeSettingsShape(raw) {
    const defaults = createDefaultSettings();
    if (!raw || typeof raw !== "object") {
      return defaults;
    }
    const normalized = {
      ...defaults,
      ...raw,
      ui: {
        ...defaults.ui,
        ...(raw.ui && typeof raw.ui === "object" ? raw.ui : {}),
      },
    };
    normalized.inviteCode = String(normalized.inviteCode || "");
    normalized.alias = String(normalized.alias || "");
    normalized.lastSubmissionId = String(normalized.lastSubmissionId || "");
    return normalized;
  }

  function readSettings() {
    try {
      if (typeof GM_getValue === "function") {
        return normalizeSettingsShape(GM_getValue(SETTINGS_KEY, createDefaultSettings()));
      }
    } catch (error) {
      Logger.warn("读取采集器设置（GM）失败，将回退 localStorage。", error);
    }
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) {
        return createDefaultSettings();
      }
      return normalizeSettingsShape(JSON.parse(raw));
    } catch (error) {
      Logger.warn("读取采集器设置（localStorage）失败，使用默认设置。", error);
      return createDefaultSettings();
    }
  }

  function writeSettings(settings) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(SETTINGS_KEY, settings);
        return;
      }
    } catch (error) {
      Logger.warn("写入采集器设置（GM）失败，将回退 localStorage。", error);
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
      Logger.warn("写入采集器设置（localStorage）失败。", error);
    }
  }

  const state = {
    store: readStore(),
    settings: readSettings(),
    persistTimerId: null,
    ui: {
      ball: null,
      panel: null,
      status: null,
      hostSelect: null,
      uploadButton: null,
      inviteInput: null,
      aliasInput: null,
      settingsDetails: null,
      advancedDetails: null,
      currentHostLabel: null,
      uploadHint: null,
      statusLevel: "info",
      statusLockUntil: 0,
      isUploading: false,
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
      payload,
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

  function setStatusText(text, level = "info", holdMs = 0) {
    if (state.ui.status) {
      state.ui.status.textContent = text;
      state.ui.status.dataset.level = level;
    }
    state.ui.statusLevel = level;
    if (holdMs > 0) {
      state.ui.statusLockUntil = Date.now() + holdMs;
    }
  }

  function refreshStatusText() {
    if (!IS_TOP_WINDOW) {
      return;
    }
    if (Date.now() < (state.ui.statusLockUntil || 0)) {
      return;
    }
    const host = window.location.hostname.toLowerCase();
    const bucket = ensureHostBucket(host);
    const total = Object.keys(bucket.texts).length;
    const pending = Object.keys(bucket.texts).filter((text) => !bucket.exportedTexts[text]).length;
    const iframeHosts = Object.keys(bucket.iframeHosts).length;
    if (state.ui.currentHostLabel) {
      state.ui.currentHostLabel.textContent = host;
    }
    if (state.ui.uploadHint) {
      const relatedHosts = getCurrentPageRelatedHosts();
      const relatedPending = getPendingCountByHosts(relatedHosts);
      state.ui.uploadHint.textContent = `当前页面相关域名未导出词条：${relatedPending} 条（${relatedHosts.length} 个域名，将作为一键上传默认范围）`;
    }
    setStatusText(`当前域名：总计 ${total}，未导出 ${pending}，iframe 域名 ${iframeHosts}。`, "info");
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

  function updateCollectorSettings(partial) {
    const patch = partial && typeof partial === "object" ? partial : {};
    const next = {
      ...state.settings,
      ...patch,
      ui: {
        ...state.settings.ui,
        ...(patch.ui && typeof patch.ui === "object" ? patch.ui : {}),
      },
    };
    state.settings = normalizeSettingsShape(next);
    writeSettings(state.settings);
  }

  function getCurrentHostPendingCount() {
    const host = window.location.hostname.toLowerCase();
    const bucket = ensureHostBucket(host);
    return Object.keys(bucket.texts).filter((text) => !bucket.exportedTexts[text]).length;
  }

  function getCurrentPageRelatedHosts() {
    const currentHost = window.location.hostname.toLowerCase();
    const currentBucket = ensureHostBucket(currentHost);
    const candidateHosts = new Set([currentHost]);
    for (const iframeHost of Object.keys(currentBucket.iframeHosts || {})) {
      const normalized = String(iframeHost || "").trim().toLowerCase();
      if (normalized) {
        candidateHosts.add(normalized);
      }
    }
    const hosts = [];
    for (const host of candidateHosts) {
      if (state.store.hosts[host]) {
        hosts.push(host);
      }
    }
    hosts.sort((a, b) => a.localeCompare(b, "en"));
    return hosts;
  }

  function getPendingCountByHosts(hosts) {
    let total = 0;
    for (const host of hosts) {
      const bucket = ensureHostBucket(host);
      total += Object.keys(bucket.texts).filter((text) => !bucket.exportedTexts[text]).length;
    }
    return total;
  }

  function setUploadButtonBusy(isBusy, label = "") {
    state.ui.isUploading = Boolean(isBusy);
    if (!state.ui.uploadButton) {
      return;
    }
    state.ui.uploadButton.disabled = Boolean(isBusy);
    const labelNode = state.ui.uploadButton.querySelector(`[data-role="upload-label"]`);
    if (!labelNode) {
      return;
    }
    labelNode.textContent = label || "一键上传（本页相关增量）";
  }

  function readResponseJsonSafe(response) {
    return response
      .json()
      .catch(() => ({ ok: false, error: "INVALID_JSON_RESPONSE", message: `服务端返回了非 JSON（HTTP ${response.status}）。` }));
  }

  async function submitCurrentHostIncremental() {
    if (state.ui.isUploading) {
      return;
    }
    const inviteCode = String(state.settings.inviteCode || "").trim();
    if (!inviteCode) {
      if (state.ui.settingsDetails) {
        state.ui.settingsDetails.open = true;
      }
      updateCollectorSettings({ ui: { settingsOpen: true } });
      setStatusText("请先在“上传设置”里填写邀请码，再执行一键上传。", "warn", 7000);
      return;
    }

    const currentHost = window.location.hostname.toLowerCase();
    const relatedHosts = getCurrentPageRelatedHosts();
    const { selectedByHost } = buildHostScopedExport(relatedHosts, true);
    const filteredPayload = {};
    for (const [hostKey, list] of Object.entries(selectedByHost)) {
      if (Array.isArray(list) && list.length > 0) {
        filteredPayload[hostKey] = list;
      }
    }
    const uploadHosts = Object.keys(filteredPayload).sort((a, b) => a.localeCompare(b, "en"));
    const totalSelectedCount = uploadHosts.reduce((sum, hostKey) => sum + filteredPayload[hostKey].length, 0);
    if (totalSelectedCount === 0) {
      setStatusText("当前页面相关域名没有未导出的增量词条，无需上传。", "warn", 5000);
      return;
    }
    const primaryHost = uploadHosts.includes(currentHost) ? currentHost : uploadHosts[0];

    const body = {
      version: 1,
      scope: COLLECTOR_UPLOAD_SCOPE,
      host: primaryHost,
      payload: filteredPayload,
      meta: {
        pageHost: currentHost,
        uploadHosts,
        pageUrl: String(window.location.href || ""),
        userAgent: String(navigator.userAgent || ""),
        collectorScriptVersion: SCRIPT_VERSION,
        alias: String(state.settings.alias || "").trim(),
      },
    };

    setUploadButtonBusy(true, "上传中...");
    setStatusText(`正在上传本页相关域名增量：共 ${totalSelectedCount} 条（${uploadHosts.length} 个域名）...`, "info", 4000);

    try {
      const response = await fetch(`${COLLECTOR_UPLOAD_API_BASE}${COLLECTOR_UPLOAD_API_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OverlayLex-Invite-Code": inviteCode,
        },
        body: JSON.stringify(body),
      });
      const responseJson = await readResponseJsonSafe(response);
      if (!response.ok || !responseJson?.ok) {
        setStatusText(`上传失败：${String(responseJson?.message || `HTTP ${response.status}`)}`, "error", 10000);
        return;
      }

      markExportedByHost(filteredPayload);
      updateCollectorSettings({ lastSubmissionId: String(responseJson.submissionId || "") });
      setStatusText(
        `上传成功：${totalSelectedCount} 条（${uploadHosts.length} 个域名）；提交编号 ${String(
          responseJson.submissionId || "unknown"
        )}；已进入 CI 审核队列。`,
        "success",
        10000
      );
      refreshStatusText();
    } catch (error) {
      Logger.error("一键上传失败。", error);
      setStatusText(`上传失败：${String(error?.message || error)}`, "error", 10000);
    } finally {
      setUploadButtonBusy(false);
    }
  }

  // ------------------------------
  // UI（仅顶层窗口）
  // ------------------------------
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .${UI_ID_PREFIX}-hidden { display: none !important; }
      #${UI_ID_PREFIX}-ball {
        position: fixed;
        z-index: 2147483100;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        border: none;
        padding: 0;
        color: #fff;
        cursor: grab;
        background: radial-gradient(circle at 30% 30%, #28d295 0%, #0d9d70 68%, #0a6e51 100%);
        box-shadow: 0 10px 22px rgba(12, 94, 68, 0.32);
      }
      #${UI_ID_PREFIX}-ball:active { cursor: grabbing; transform: scale(0.98); }
      .${UI_ID_PREFIX}-ball-ring {
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        border: 1px solid rgba(45, 212, 191, 0.35);
        box-shadow: 0 0 0 4px rgba(45, 212, 191, 0.12);
      }
      .${UI_ID_PREFIX}-ball-core {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font: 700 18px/1 "Microsoft YaHei UI", "PingFang SC", sans-serif;
      }
      #${UI_ID_PREFIX}-panel {
        position: fixed;
        z-index: 2147483101;
        width: min(420px, calc(100vw - 12px));
        max-height: 80vh;
        overflow: auto;
        border-radius: 14px;
        border: 1px solid #dbe5ef;
        background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
        color: #1f2937;
        font: 14px/1.45 "Microsoft YaHei UI", "PingFang SC", sans-serif;
        box-shadow: 0 18px 44px rgba(15, 23, 42, 0.2);
      }
      #${UI_ID_PREFIX}-panel * { box-sizing: border-box; }
      .${UI_ID_PREFIX}-drag-handle {
        height: 14px;
        cursor: move;
        background: radial-gradient(circle, rgba(100,116,139,.32) 1px, transparent 1.4px) center/10px 5px repeat-x;
      }
      .${UI_ID_PREFIX}-panel-body { padding: 10px 12px 12px; }
      .${UI_ID_PREFIX}-header { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }
      .${UI_ID_PREFIX}-title { margin:0; font-size:15px; font-weight:700; }
      .${UI_ID_PREFIX}-subtitle { margin:2px 0 0; font-size:12px; color:#64748b; }
      .${UI_ID_PREFIX}-close-btn {
        border:1px solid #d7e0ea; background:#fff; border-radius:10px; padding:6px 10px; cursor:pointer;
      }
      .${UI_ID_PREFIX}-card {
        border:1px solid #e5ecf4; background:rgba(255,255,255,.86); border-radius:12px; padding:10px; margin-bottom:10px;
      }
      .${UI_ID_PREFIX}-host-pill {
        display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:999px;
        border:1px solid #cfe0ff; background:#eff6ff; color:#1d4ed8; font-size:12px;
      }
      .${UI_ID_PREFIX}-hint { margin:8px 0; color:#475569; font-size:12px; }
      .${UI_ID_PREFIX}-primary {
        width:100%; border:1px solid #0d9d70; border-radius:12px; padding:10px 12px; cursor:pointer; color:#fff;
        background:linear-gradient(180deg,#18b37f 0%,#0d9d70 100%); box-shadow:0 8px 16px rgba(13,157,112,.2); font-weight:700;
      }
      .${UI_ID_PREFIX}-primary:disabled { opacity:.7; cursor:not-allowed; }
      .${UI_ID_PREFIX}-primary-sub { display:block; margin-top:4px; font-size:12px; font-weight:400; opacity:.92; }
      .${UI_ID_PREFIX}-details {
        border:1px solid #e5ecf4; border-radius:12px; background:rgba(255,255,255,.86); margin-bottom:10px; overflow:hidden;
      }
      .${UI_ID_PREFIX}-details > summary {
        list-style:none; cursor:pointer; padding:10px 12px; font-weight:600;
      }
      .${UI_ID_PREFIX}-details > summary::-webkit-details-marker { display:none; }
      .${UI_ID_PREFIX}-details[open] > summary { border-bottom:1px solid #e5ecf4; background:#f8fbff; }
      .${UI_ID_PREFIX}-details-content { padding:10px 12px 12px; }
      .${UI_ID_PREFIX}-field { margin-bottom:10px; }
      .${UI_ID_PREFIX}-field:last-child { margin-bottom:0; }
      .${UI_ID_PREFIX}-field label { display:block; margin-bottom:4px; color:#475569; font-size:12px; }
      .${UI_ID_PREFIX}-field input, .${UI_ID_PREFIX}-field select {
        width:100%; border:1px solid #d3dce6; border-radius:10px; background:#fff; padding:8px 10px; font:inherit;
      }
      .${UI_ID_PREFIX}-mini { color:#64748b; font-size:12px; }
      .${UI_ID_PREFIX}-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
      .${UI_ID_PREFIX}-row:last-child { margin-bottom:0; }
      .${UI_ID_PREFIX}-row button {
        flex:1; min-width:0; border:1px solid #d3dce6; background:#f8fafc; border-radius:10px; padding:8px 10px; cursor:pointer;
      }
      .${UI_ID_PREFIX}-row button:hover { background:#eef4fa; }
      .${UI_ID_PREFIX}-status {
        margin-top:8px; border-radius:10px; border:1px solid #dbe5ef; background:#f8fafc; color:#334155; padding:8px 10px; font-size:12px;
        white-space:pre-wrap; word-break:break-word;
      }
      .${UI_ID_PREFIX}-status[data-level="success"] { border-color:#a7f3d0; background:#ecfdf5; color:#065f46; }
      .${UI_ID_PREFIX}-status[data-level="warn"] { border-color:#fde68a; background:#fffbeb; color:#92400e; }
      .${UI_ID_PREFIX}-status[data-level="error"] { border-color:#fecaca; background:#fef2f2; color:#991b1b; }
      .${UI_ID_PREFIX}-btn-row { display:flex; gap:8px; margin-top:8px; }
      .${UI_ID_PREFIX}-btn-row button {
        flex:1; border:1px solid #d3dce6; background:#fff; border-radius:10px; padding:8px 10px; cursor:pointer;
      }
      @media (max-width: 480px) {
        .${UI_ID_PREFIX}-row, .${UI_ID_PREFIX}-btn-row { flex-direction: column; align-items: stretch; }
      }
    `;
    document.head.appendChild(style);
  }

  function createTopUI() {
    if (!IS_TOP_WINDOW) {
      return;
    }
    injectStyles();
    const persistedUi = state.settings.ui || {};
    const EDGE_PADDING = 8;
    const BALL_SIZE = 48;
    const PANEL_FALLBACK_WIDTH = 420;
    const PANEL_FALLBACK_HEIGHT = 520;
    const DRAG_THRESHOLD = 3;
    let ballAnchorTop = Number(persistedUi.ballTop);
    let ballAnchorRight = Number(persistedUi.ballRight);
    let panelAnchorTop = Number(persistedUi.panelTop);
    let panelAnchorRight = Number(persistedUi.panelRight);
    let isPanelOpen = Boolean(persistedUi.panelOpen);
    let suppressOpenUntil = 0;

    if (!Number.isFinite(ballAnchorTop)) {
      ballAnchorTop = 170;
    }
    if (!Number.isFinite(ballAnchorRight)) {
      ballAnchorRight = 16;
    }
    if (!Number.isFinite(panelAnchorTop)) {
      panelAnchorTop = 120;
    }
    if (!Number.isFinite(panelAnchorRight)) {
      panelAnchorRight = 16;
    }

    const ball = document.createElement("button");
    ball.id = `${UI_ID_PREFIX}-ball`;
    ball.type = "button";
    ball.title = "OverlayLex 采集器";
    ball.innerHTML = `
      <span class="${UI_ID_PREFIX}-ball-ring"></span>
      <span class="${UI_ID_PREFIX}-ball-core">采</span>
    `;

    const panel = document.createElement("div");
    panel.id = `${UI_ID_PREFIX}-panel`;
    panel.classList.add(`${UI_ID_PREFIX}-hidden`);
    panel.innerHTML = `
      <div class="${UI_ID_PREFIX}-drag-handle" id="${UI_ID_PREFIX}-panel-drag-handle" title="拖动面板"></div>
      <div class="${UI_ID_PREFIX}-panel-body">
        <div class="${UI_ID_PREFIX}-header">
          <div>
            <h3 class="${UI_ID_PREFIX}-title">OverlayLex 采集器</h3>
            <p class="${UI_ID_PREFIX}-subtitle">当前域名：<span id="${UI_ID_PREFIX}-current-host"></span></p>
          </div>
          <button class="${UI_ID_PREFIX}-close-btn" id="${UI_ID_PREFIX}-close" type="button">关闭</button>
        </div>
        <div class="${UI_ID_PREFIX}-card">
          <div class="${UI_ID_PREFIX}-host-pill">
            <span>默认上传范围</span>
            <strong>本域增量</strong>
          </div>
          <div class="${UI_ID_PREFIX}-hint" id="${UI_ID_PREFIX}-upload-hint">当前页面相关域名未导出词条：0 条（将作为一键上传默认范围）</div>
          <button class="${UI_ID_PREFIX}-primary" id="${UI_ID_PREFIX}-upload-current-increment" type="button">
            <span data-role="upload-label">一键上传（本页相关增量）</span>
            <span class="${UI_ID_PREFIX}-primary-sub">CI 自动生成采集 PR，你只需等待审核</span>
          </button>
        </div>
        <details class="${UI_ID_PREFIX}-details" id="${UI_ID_PREFIX}-settings-details">
          <summary>上传设置（邀请码 / 协作者昵称）</summary>
          <div class="${UI_ID_PREFIX}-details-content">
            <div class="${UI_ID_PREFIX}-field">
              <label for="${UI_ID_PREFIX}-invite-input">邀请码（必填）</label>
              <input id="${UI_ID_PREFIX}-invite-input" type="password" placeholder="输入共享邀请码" autocomplete="off" />
              <div class="${UI_ID_PREFIX}-mini">仅保存在本地脚本配置中，不会清空采集数据时一起删除。</div>
            </div>
            <div class="${UI_ID_PREFIX}-field">
              <label for="${UI_ID_PREFIX}-alias-input">协作者昵称（可选）</label>
              <input id="${UI_ID_PREFIX}-alias-input" type="text" placeholder="例如：Smoke巡检-小王" />
            </div>
            <div class="${UI_ID_PREFIX}-btn-row">
              <button id="${UI_ID_PREFIX}-save-settings" type="button">保存上传设置</button>
              <button id="${UI_ID_PREFIX}-toggle-invite-visibility" type="button">显示/隐藏邀请码</button>
            </div>
          </div>
        </details>
        <details class="${UI_ID_PREFIX}-details" id="${UI_ID_PREFIX}-advanced-details">
          <summary>高级操作（复制 / 清理 / 调试）</summary>
          <div class="${UI_ID_PREFIX}-details-content">
            <div class="${UI_ID_PREFIX}-row">
              <button id="${UI_ID_PREFIX}-copy-increment" type="button">复制本域增量</button>
              <button id="${UI_ID_PREFIX}-copy-full" type="button">复制本域全量</button>
            </div>
            <div class="${UI_ID_PREFIX}-row">
              <button id="${UI_ID_PREFIX}-copy-all-merged" type="button">一键复制全部域名</button>
            </div>
            <div class="${UI_ID_PREFIX}-row">
              <select id="${UI_ID_PREFIX}-host-select"></select>
              <button id="${UI_ID_PREFIX}-copy-selected-host" type="button">复制选定域名</button>
            </div>
            <div class="${UI_ID_PREFIX}-row">
              <button id="${UI_ID_PREFIX}-copy-iframe-hosts" type="button">复制本域 iframe 域名</button>
              <button id="${UI_ID_PREFIX}-reset-exported" type="button">重置本域增量游标</button>
            </div>
            <div class="${UI_ID_PREFIX}-row">
              <button id="${UI_ID_PREFIX}-clear-current-host" type="button">清空当前域数据</button>
              <button id="${UI_ID_PREFIX}-clear-all-hosts" type="button">清空全部采集数据</button>
            </div>
          </div>
        </details>
        <div class="${UI_ID_PREFIX}-status" id="${UI_ID_PREFIX}-status" data-level="info">初始化中...</div>
      </div>
    `;

    document.body.appendChild(ball);
    document.body.appendChild(panel);
    state.ui.ball = ball;
    state.ui.panel = panel;
    state.ui.status = panel.querySelector(`#${UI_ID_PREFIX}-status`);
    state.ui.hostSelect = panel.querySelector(`#${UI_ID_PREFIX}-host-select`);
    state.ui.uploadButton = panel.querySelector(`#${UI_ID_PREFIX}-upload-current-increment`);
    state.ui.inviteInput = panel.querySelector(`#${UI_ID_PREFIX}-invite-input`);
    state.ui.aliasInput = panel.querySelector(`#${UI_ID_PREFIX}-alias-input`);
    state.ui.settingsDetails = panel.querySelector(`#${UI_ID_PREFIX}-settings-details`);
    state.ui.advancedDetails = panel.querySelector(`#${UI_ID_PREFIX}-advanced-details`);
    state.ui.currentHostLabel = panel.querySelector(`#${UI_ID_PREFIX}-current-host`);
    state.ui.uploadHint = panel.querySelector(`#${UI_ID_PREFIX}-upload-hint`);
    if (state.ui.inviteInput) {
      state.ui.inviteInput.value = state.settings.inviteCode || "";
    }
    if (state.ui.aliasInput) {
      state.ui.aliasInput.value = state.settings.alias || "";
    }
    if (state.ui.settingsDetails) {
      state.ui.settingsDetails.open = Boolean(persistedUi.settingsOpen);
    }
    if (state.ui.advancedDetails) {
      state.ui.advancedDetails.open = Boolean(persistedUi.advancedOpen);
    }
    refreshHostSelectorOptions(window.location.hostname.toLowerCase());

    function setVisible(element, visible) {
      if (!element) {
        return;
      }
      element.classList.toggle(`${UI_ID_PREFIX}-hidden`, !visible);
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
      return {
        top: clampValue(top, EDGE_PADDING, Math.max(EDGE_PADDING, viewport.height - BALL_SIZE - EDGE_PADDING)),
        right: clampValue(right, EDGE_PADDING, Math.max(EDGE_PADDING, viewport.width - BALL_SIZE - EDGE_PADDING)),
      };
    }

    function clampPanelAnchor(top, right) {
      const viewport = getViewportSize();
      const rect = panel.getBoundingClientRect();
      const panelWidth = rect.width > 0 ? rect.width : PANEL_FALLBACK_WIDTH;
      const panelHeight = rect.height > 0 ? rect.height : PANEL_FALLBACK_HEIGHT;
      return {
        top: clampValue(top, EDGE_PADDING, Math.max(EDGE_PADDING, viewport.height - panelHeight - EDGE_PADDING)),
        right: clampValue(right, EDGE_PADDING, Math.max(EDGE_PADDING, viewport.width - panelWidth - EDGE_PADDING)),
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

    function persistUiState() {
      updateCollectorSettings({
        ui: {
          ballTop: Math.round(ballAnchorTop),
          ballRight: Math.round(ballAnchorRight),
          panelTop: Math.round(panelAnchorTop),
          panelRight: Math.round(panelAnchorRight),
          panelOpen: isPanelOpen,
          advancedOpen: Boolean(state.ui.advancedDetails?.open),
          settingsOpen: Boolean(state.ui.settingsDetails?.open),
        },
      });
    }

    function openPanelFromBall() {
      panelAnchorTop = ballAnchorTop;
      panelAnchorRight = ballAnchorRight;
      isPanelOpen = true;
      if (!String(state.settings.inviteCode || "").trim() && state.ui.settingsDetails) {
        state.ui.settingsDetails.open = true;
      }
      setVisible(panel, true);
      setVisible(ball, false);
      applyPanelPosition();
      persistUiState();
      refreshStatusText();
    }

    function closePanelToBall() {
      isPanelOpen = false;
      setVisible(panel, false);
      setVisible(ball, true);
      applyBallPosition();
      persistUiState();
    }

    function isInsidePanel(event) {
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
      if (isInsidePanel(event)) {
        return;
      }
      closePanelToBall();
    }

    function getEventPoint(event) {
      if (event.touches?.length) {
        return { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }
      if (event.changedTouches?.length) {
        return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
      }
      if (typeof event.clientX === "number" && typeof event.clientY === "number") {
        return { x: event.clientX, y: event.clientY };
      }
      return null;
    }

    function bindDrag(startEvent, getStart, onMoveFrame, onEnd) {
      const point = getEventPoint(startEvent);
      if (!point) {
        return;
      }
      if (startEvent.cancelable) {
        startEvent.preventDefault();
      }
      const start = getStart(point);
      function handleMove(moveEvent) {
        const movePoint = getEventPoint(moveEvent);
        if (!movePoint) {
          return;
        }
        onMoveFrame(start, movePoint, moveEvent);
      }
      function handleEnd() {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleEnd);
        window.removeEventListener("touchmove", handleMove);
        window.removeEventListener("touchend", handleEnd);
        window.removeEventListener("touchcancel", handleEnd);
        onEnd(start);
      }
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleEnd);
      window.addEventListener("touchmove", handleMove, { passive: false });
      window.addEventListener("touchend", handleEnd);
      window.addEventListener("touchcancel", handleEnd);
    }

    if (isPanelOpen) {
      setVisible(panel, true);
      setVisible(ball, false);
      applyPanelPosition();
    } else {
      setVisible(panel, false);
      setVisible(ball, true);
      applyBallPosition();
    }

    panel.querySelector(`#${UI_ID_PREFIX}-close`)?.addEventListener("click", () => {
      closePanelToBall();
    });
    state.ui.uploadButton?.addEventListener("click", () => {
      submitCurrentHostIncremental().catch((error) => {
        Logger.error("上传流程未捕获异常。", error);
        setUploadButtonBusy(false);
        setStatusText(`上传失败：${String(error?.message || error)}`, "error", 10000);
      });
    });
    panel.querySelector(`#${UI_ID_PREFIX}-save-settings`)?.addEventListener("click", () => {
      updateCollectorSettings({
        inviteCode: String(state.ui.inviteInput?.value || "").trim(),
        alias: String(state.ui.aliasInput?.value || "").trim(),
        ui: {
          settingsOpen: Boolean(state.ui.settingsDetails?.open),
          advancedOpen: Boolean(state.ui.advancedDetails?.open),
        },
      });
      setStatusText("已保存上传设置。", "success", 3500);
    });
    panel.querySelector(`#${UI_ID_PREFIX}-toggle-invite-visibility`)?.addEventListener("click", () => {
      if (!state.ui.inviteInput) {
        return;
      }
      state.ui.inviteInput.type = state.ui.inviteInput.type === "password" ? "text" : "password";
    });
    state.ui.settingsDetails?.addEventListener("toggle", persistUiState);
    state.ui.advancedDetails?.addEventListener("toggle", persistUiState);

    ball.addEventListener("click", (event) => {
      if (Date.now() < suppressOpenUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      openPanelFromBall();
    });
    ball.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      bindDrag(
        event,
        (point) => ({
          startX: point.x,
          startY: point.y,
          startTop: ballAnchorTop,
          startRight: ballAnchorRight,
          moved: false,
        }),
        (start, movePoint, moveEvent) => {
          const dx = movePoint.x - start.startX;
          const dy = movePoint.y - start.startY;
          if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
            start.moved = true;
          }
          ballAnchorTop = start.startTop + dy;
          ballAnchorRight = start.startRight - dx;
          applyBallPosition();
          if (moveEvent.cancelable && moveEvent.type.startsWith("touch")) {
            moveEvent.preventDefault();
          }
        },
        (start) => {
          if (start.moved) {
            suppressOpenUntil = Date.now() + 280;
          }
          persistUiState();
        }
      );
    });
    ball.addEventListener("touchstart", (event) => {
      bindDrag(
        event,
        (point) => ({
          startX: point.x,
          startY: point.y,
          startTop: ballAnchorTop,
          startRight: ballAnchorRight,
          moved: false,
        }),
        (start, movePoint, moveEvent) => {
          const dx = movePoint.x - start.startX;
          const dy = movePoint.y - start.startY;
          if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
            start.moved = true;
          }
          ballAnchorTop = start.startTop + dy;
          ballAnchorRight = start.startRight - dx;
          applyBallPosition();
          if (moveEvent.cancelable) {
            moveEvent.preventDefault();
          }
        },
        (start) => {
          if (start.moved) {
            suppressOpenUntil = Date.now() + 280;
          }
          persistUiState();
        }
      );
    }, { passive: false });
    panel.querySelector(`#${UI_ID_PREFIX}-panel-drag-handle`)?.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      bindDrag(
        event,
        (point) => ({ startX: point.x, startY: point.y, startTop: panelAnchorTop, startRight: panelAnchorRight }),
        (start, movePoint, moveEvent) => {
          panelAnchorTop = start.startTop + (movePoint.y - start.startY);
          panelAnchorRight = start.startRight - (movePoint.x - start.startX);
          applyPanelPosition();
          if (moveEvent.cancelable && moveEvent.type.startsWith("touch")) {
            moveEvent.preventDefault();
          }
        },
        () => persistUiState()
      );
    });
    panel.querySelector(`#${UI_ID_PREFIX}-panel-drag-handle`)?.addEventListener("touchstart", (event) => {
      bindDrag(
        event,
        (point) => ({ startX: point.x, startY: point.y, startTop: panelAnchorTop, startRight: panelAnchorRight }),
        (start, movePoint, moveEvent) => {
          panelAnchorTop = start.startTop + (movePoint.y - start.startY);
          panelAnchorRight = start.startRight - (movePoint.x - start.startX);
          applyPanelPosition();
          if (moveEvent.cancelable) {
            moveEvent.preventDefault();
          }
        },
        () => persistUiState()
      );
    }, { passive: false });
    document.addEventListener("pointerdown", handleOutsidePointerDown, true);
    window.addEventListener("resize", () => {
      if (isPanelOpen) {
        applyPanelPosition();
      } else {
        applyBallPosition();
      }
      persistUiState();
    });

    panel.querySelector(`#${UI_ID_PREFIX}-copy-increment`)?.addEventListener("click", () => {
      const host = window.location.hostname.toLowerCase();
      const { serialized, selectedByHost } = buildHostScopedExport([host], true);
      const copied = copyToClipboard(serialized);
      if (!copied) {
        setStatusText("复制失败：请检查剪贴板权限。", "error", 5000);
        return;
      }
      markExportedByHost(selectedByHost);
      setStatusText(`复制本域增量 JSON 成功：${selectedByHost[host]?.length || 0} 条。`, "success", 4000);
      refreshStatusText();
    });

    panel.querySelector(`#${UI_ID_PREFIX}-copy-full`)?.addEventListener("click", () => {
      const host = window.location.hostname.toLowerCase();
      const { serialized, selectedByHost } = buildHostScopedExport([host], false);
      const copied = copyToClipboard(serialized);
      if (!copied) {
        setStatusText("复制失败：请检查剪贴板权限。", "error", 5000);
        return;
      }
      setStatusText(`复制本域全量 JSON 成功：${selectedByHost[host]?.length || 0} 条。`, "success", 4000);
    });

    panel.querySelector(`#${UI_ID_PREFIX}-copy-all-merged`)?.addEventListener("click", () => {
      const allHosts = getSortedHostList();
      const { serialized } = buildHostScopedExport(allHosts, false);
      const copied = copyToClipboard(serialized);
      if (!copied) {
        setStatusText("复制失败：请检查剪贴板权限。", "error", 5000);
        return;
      }
      setStatusText(`一键复制全部域名 JSON 成功：跨 ${allHosts.length} 个域名。`, "success", 4000);
    });

    panel.querySelector(`#${UI_ID_PREFIX}-copy-selected-host`)?.addEventListener("click", () => {
      const selectedHost = state.ui.hostSelect?.value || "";
      if (!selectedHost) {
        setStatusText("没有可复制的域名数据。", "warn", 3500);
        return;
      }
      const { serialized, selectedByHost } = buildHostScopedExport([selectedHost], false);
      const copied = copyToClipboard(serialized);
      if (!copied) {
        setStatusText("复制失败：请检查剪贴板权限。", "error", 5000);
        return;
      }
      setStatusText(`复制选定域名 JSON 成功：${selectedByHost[selectedHost]?.length || 0} 条。`, "success", 4000);
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
        setStatusText("复制 iframe 域名失败：请检查剪贴板权限。", "error", 5000);
        return;
      }
      setStatusText(`复制 iframe 域名成功：${payload.iframeHosts.length} 个。`, "success", 4000);
    });

    panel.querySelector(`#${UI_ID_PREFIX}-reset-exported`)?.addEventListener("click", () => {
      const host = window.location.hostname.toLowerCase();
      const bucket = ensureHostBucket(host);
      bucket.exportedTexts = {};
      schedulePersistStore();
      setStatusText("已重置本域增量游标。", "success", 3500);
      refreshStatusText();
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
        setStatusText(`当前域名（${host}）没有可清空的数据。`, "warn", 4000);
        return;
      }
      setStatusText(`已清空当前域名（${host}）的采集数据。`, "success", 4000);
    });

    panel.querySelector(`#${UI_ID_PREFIX}-clear-all-hosts`)?.addEventListener("click", () => {
      const hostCount = Object.keys(state.store.hosts).length;
      const confirmed = window.confirm(`确认清空全部采集数据吗？当前包含 ${hostCount} 个域名。`);
      if (!confirmed) {
        return;
      }
      clearAllCollectorData();
      refreshStatusText();
      setStatusText("已清空全部采集数据。", "success", 4000);
    });

    if (state.ui.currentHostLabel) {
      state.ui.currentHostLabel.textContent = window.location.hostname.toLowerCase();
    }
    if (state.ui.uploadHint) {
      const relatedHosts = getCurrentPageRelatedHosts();
      state.ui.uploadHint.textContent = `当前页面相关域名未导出词条：${getPendingCountByHosts(relatedHosts)} 条（${relatedHosts.length} 个域名，将作为一键上传默认范围）`;
    }
    refreshStatusText();
    setUploadButtonBusy(false);
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
