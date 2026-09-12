#!/usr/bin/env node

/**
 * OBR Mock Host —— 可复用的 Owlbear Rodeo Extension SDK 最小宿主。
 *
 * 设计目标：
 * 1. 不要求登录真实 Owlbear 房间，也不要求人工点击安装扩展；
 * 2. 通过与官方 SDK 相同的 `window.postMessage` 通道，向扩展发送 `OBR_READY`；
 * 3. 对常见的 Scene / Player / Party / Room / Theme / Grid / Fog 请求返回稳定 fixture；
 * 4. 记录扩展向宿主注册的 Context Menu / Tool / Mode / Action / Notification 等 UI；
 * 5. 把浏览器中真实渲染出来的 DOM / ARIA / open Shadow DOM 文案同时采样；
 * 6. 把“未知但带 nonce 的请求”记录下来，让 Mock 能按真实扩展需求渐进补齐，而不是
 *    一开始手写整个 Owlbear SDK。
 *
 * 这个文件只负责“宿主协议 + 浏览器生命周期 + 通用采样”。
 * 具体扩展的导航策略（例如 Smoke 左下角菜单）应放在独立 runner 里，通过 `explore`
 * 回调传入。这样同一套 Mock Host 可以复用于 OverlayLex 之外的其他 Owlbear Extension E2E。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

export const DEFAULT_PLAYER = {
  id: 'mock-user',
  connectionId: 'mock-connection',
  role: 'GM',
  selection: [],
  name: 'Mock GM',
  color: '#7c3aed',
  syncView: false,
  metadata: {}
};

export const DEFAULT_THEME = {
  mode: 'DARK',
  primary: { light: '#a78bfa', main: '#7c3aed', dark: '#5b21b6', contrastText: '#ffffff' },
  secondary: { light: '#67e8f9', main: '#06b6d4', dark: '#0e7490', contrastText: '#ffffff' },
  background: { default: '#111827', paper: '#1f2937' },
  text: { primary: '#f9fafb', secondary: '#d1d5db', disabled: '#6b7280' }
};

/**
 * 收集“来自测试 fixture、但可能被扩展渲染进 UI”的动态字符串。
 *
 * 为什么需要这一步：
 * - Mock Host 会给扩展一个假的玩家，例如默认名称 `Mock GM`；
 * - 某些扩展会把这个动态名称渲染成 `View As: Mock GM`、`Mock GM (You)`；
 * - 这些文字虽然真实出现在 DOM 中，却不是扩展的固定英文原文，不能送进翻译平台。
 *
 * 当前自动收集玩家姓名，并允许 runner 通过 `fixture.volatileTextTokens` 显式补充
 * 其它会进入界面的动态值。这里只记录“污染源 token”，真正过滤仍放在 merge 阶段，
 * 这样原始 Mock 报告仍保留完整现场，便于 E2E 调试和复盘。
 */
function collectVolatileRuntimeTokens(fixture, player) {
  const tokens = [];

  if (player?.name) tokens.push(player.name);
  for (const partyPlayer of fixture.party || []) {
    if (partyPlayer?.name) tokens.push(partyPlayer.name);
  }
  for (const token of fixture.volatileTextTokens || []) {
    tokens.push(token);
  }

  return [...new Set(tokens
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(value => value.length >= 2))];
}

/**
 * 生成默认 SDK 响应表。
 *
 * 返回值刻意模拟官方 SDK 常用 getter 的“外层对象 shape”，例如：
 * - `OBR_SCENE_ITEMS_GET_ALL_ITEMS -> { items: [] }`
 * - `OBR_PLAYER_GET_ROLE -> { role: 'GM' }`
 *
 * 这里不尝试模拟真实业务逻辑，只给扩展足够稳定的最小状态，使它能够完成初始化。
 * 调用方可通过 `fixture.responses` 覆盖任意 ID，以构造“有 token / Player / 特殊 metadata”
 * 等 E2E 场景。
 */
export function createDefaultResponses(fixture = {}) {
  const player = { ...DEFAULT_PLAYER, ...(fixture.player || {}) };
  const theme = { ...DEFAULT_THEME, ...(fixture.theme || {}) };
  const sceneMetadata = fixture.sceneMetadata || {};
  const roomMetadata = fixture.roomMetadata || {};
  const sceneItems = fixture.sceneItems || [];
  const localItems = fixture.localItems || [];
  const party = fixture.party || [player];

  return {
    OBR_SCENE_IS_READY: { ready: fixture.sceneReady ?? true },
    OBR_SCENE_GET_METADATA: { metadata: sceneMetadata },
    OBR_SCENE_ITEMS_GET_ALL_ITEMS: { items: sceneItems },
    OBR_SCENE_ITEMS_GET_ITEMS: { items: sceneItems },
    OBR_SCENE_ITEMS_GET_ITEM_ATTACHMENTS: { items: [] },
    OBR_SCENE_LOCAL_GET_ALL_ITEMS: { items: localItems },
    OBR_SCENE_LOCAL_GET_ITEMS: { items: localItems },
    OBR_SCENE_LOCAL_GET_ITEM_ATTACHMENTS: { items: [] },
    OBR_PLAYER_GET_SELECTION: { selection: player.selection || [] },
    OBR_PLAYER_GET_NAME: { name: player.name },
    OBR_PLAYER_GET_COLOR: { color: player.color },
    OBR_PLAYER_GET_SYNC_VIEW: { syncView: Boolean(player.syncView) },
    OBR_PLAYER_GET_ID: { id: player.id },
    OBR_PLAYER_GET_ROLE: { role: player.role },
    OBR_PLAYER_GET_METADATA: { metadata: player.metadata || {} },
    OBR_PLAYER_GET_CONNECTION_ID: { connectionId: player.connectionId },
    OBR_PARTY_GET_PLAYERS: { players: party },
    OBR_ROOM_GET_PERMISSIONS: { permissions: fixture.permissions || [] },
    OBR_ROOM_GET_METADATA: { metadata: roomMetadata },
    OBR_THEME_GET_THEME: { theme },
    OBR_SCENE_GRID_GET_DPI: { dpi: fixture.grid?.dpi ?? 150 },
    OBR_SCENE_GRID_GET_SCALE: {
      parsed: fixture.grid?.scale?.parsed || { multiplier: 5, unit: 'ft', digits: 0 },
      raw: fixture.grid?.scale?.raw || '5 ft'
    },
    OBR_SCENE_GRID_GET_COLOR: {
      color: fixture.grid?.color || { line: '#000000', background: '#ffffff' }
    },
    OBR_SCENE_GRID_GET_OPACITY: { opacity: fixture.grid?.opacity ?? 1 },
    OBR_SCENE_GRID_GET_TYPE: { type: fixture.grid?.type || 'SQUARE' },
    OBR_SCENE_GRID_GET_LINE_TYPE: { lineType: fixture.grid?.lineType || 'SOLID' },
    OBR_SCENE_GRID_GET_MEASUREMENT: { measurement: fixture.grid?.measurement || 'CHEBYSHEV' },
    OBR_SCENE_GRID_GET_LINE_WIDTH: { lineWidth: fixture.grid?.lineWidth ?? 1 },
    OBR_SCENE_FOG_GET_COLOR: { color: fixture.fog?.color || '#000000' },
    OBR_SCENE_FOG_GET_FILLED: { filled: fixture.fog?.filled ?? false },
    OBR_VIEWPORT_GET_SCALE: { scale: fixture.viewport?.scale ?? 1 },
    OBR_VIEWPORT_GET_POSITION: { position: fixture.viewport?.position || { x: 0, y: 0 } },
    ...(fixture.responses || {})
  };
}

/**
 * 把宿主 HTML 中需要的动态响应逻辑做成字符串函数。
 *
 * 某些 SDK API 的返回值依赖请求参数，例如 grid snap 需要把传入 position 原样返回。
 * 这类逻辑不能仅靠静态 JSON 表完成，因此放在浏览器侧的 resolver 中统一处理。
 */
function browserResolverSource() {
  return `function resolveResponse(id, data, table) {
    if (Object.prototype.hasOwnProperty.call(table, id)) {
      return { known: true, data: table[id] };
    }
    if (id === 'OBR_SCENE_GRID_SNAP_POSITION') {
      return { known: true, data: { position: data?.position || { x: 0, y: 0 } } };
    }
    if (id === 'OBR_SCENE_GRID_GET_DISTANCE') {
      return { known: true, data: { distance: 0 } };
    }
    // 写操作通常只需要 ACK。这里返回空对象，但仍记录 ID，后续如果某个扩展依赖更具体的
    // 返回结构，就可以根据 unhandledRequestIds / pageErrors 再精确补 fixture。
    // Owlbear 的写操作 ID 不一定以动词结尾，例如 OBR_SCENE_SET_METADATA、
    // OBR_BROADCAST_SEND_MESSAGE；因此按“下划线分隔的动作段”识别，而不是只匹配末尾。
    if (/_(?:SET|ADD|DELETE|UPDATE|SELECT|DESELECT|CREATE|OPEN|CLOSE|SEND|SHOW|UPLOAD|CLEAR|UNDO|REDO|REMOVE)(?:_|$)/.test(id)) {
      return { known: true, data: {} };
    }
    return { known: false, data: {} };
  }`;
}

/**
 * 生成假 Owlbear 父页面。
 *
 * `obrref` 的内容遵循官方 SDK 读取方式：`<host origin> <room id>` 再 Base64。
 * 扩展 iframe 加载完成后，宿主主动发送两次 OBR_READY：第一次尽快唤醒 SDK，第二次作为
 * 网络/框架初始化较慢时的容错。所有子页面 postMessage 都会被完整记录到内存。
 */
function createHostHtml({ port, targetPage, targetOrigin, roomId, readyData, responses }) {
  const hostOrigin = `http://127.0.0.1:${port}`;
  const obrref = Buffer.from(`${hostOrigin} ${roomId}`, 'utf8').toString('base64');
  const separator = targetPage.includes('?') ? '&' : '?';
  const src = `${targetPage}${separator}obrref=${encodeURIComponent(obrref)}`;

  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>OverlayLex OBR Mock Host</title>
    <style>html,body,#extension{width:100%;height:100%;margin:0;border:0}body{background:#222}</style>
  </head>
  <body>
    <iframe id="extension" src="${src}"></iframe>
    <script>
      const child = document.getElementById('extension');
      const responseTable = ${JSON.stringify(responses)};
      const resolveResponse = (${browserResolverSource().replace(/^function resolveResponse/, 'function')});
      window.__obrMockMessages = [];
      window.__obrMockUnhandled = [];

      function sendReady() {
        child.contentWindow.postMessage({ id: 'OBR_READY', data: ${JSON.stringify(readyData)} }, '${targetOrigin}');
      }

      child.addEventListener('load', () => {
        setTimeout(sendReady, 50);
        setTimeout(sendReady, 500);
      });

      window.addEventListener('message', event => {
        if (event.source !== child.contentWindow || event.origin !== '${targetOrigin}') return;
        const msg = event.data || {};
        window.__obrMockMessages.push({ id: msg.id, data: msg.data, nonce: msg.nonce || null, at: Date.now() });
        if (!msg.nonce || !msg.id) return;

        const resolved = resolveResponse(msg.id, msg.data, responseTable);
        if (!resolved.known) window.__obrMockUnhandled.push(msg.id);
        child.contentWindow.postMessage({
          id: msg.id + '_RESPONSE' + msg.nonce,
          data: resolved.data
        }, '${targetOrigin}');
      });
    </script>
  </body>
  </html>`;
}

/**
 * 收集当前 frame 中可操作控件，供扩展专用的 explore 策略选择按钮/菜单。
 */
export async function collectControls(frame) {
  return frame.locator('button,a,[role="button"],[role="tab"],[role="menuitem"]').evaluateAll(nodes => nodes.map((el, index) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      index,
      tag: el.tagName,
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      ariaLabel: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      href: el instanceof HTMLAnchorElement ? el.href : '',
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }));
}

/**
 * 递归采集可翻译 UI 文案。
 *
 * 除普通文本节点外，还采集常见可访问性属性；对 open Shadow DOM 递归进入。
 * 这与 OverlayLex Runtime Probe 0.2.5 的采样口径保持一致，便于以后计算自动采集覆盖率。
 */
export async function collectDomUiStrings(frame) {
  return frame.locator('body').evaluate(body => {
    const strings = new Set();
    const attrs = ['aria-label', 'aria-description', 'aria-valuetext', 'placeholder', 'title', 'alt'];
    const add = value => {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (text.length >= 2 && text.length <= 500 && /[A-Za-z]/.test(text)) strings.add(text);
    };
    const scanRoot = root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue;
        add(node.nodeValue);
      }
      const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const element of elements) {
        for (const attr of attrs) add(element.getAttribute?.(attr));
        if (element.shadowRoot) scanRoot(element.shadowRoot);
      }
    };
    scanRoot(body);
    return [...strings];
  });
}

function safeFileName(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'snapshot';
}

/**
 * 创建一个可重复使用的页面快照函数。
 * `runObrMockHost` 会把它传给扩展专用 explore 回调，所以各 runner 不需要重复截图/DOM
 * 采样代码。
 */
function createSnapshotter(outDir) {
  let index = 0;
  return async (frame, name) => {
    await fs.mkdir(path.join(outDir, 'screenshots'), { recursive: true });
    const bodyText = await frame.locator('body').innerText().catch(() => '');
    const controls = await collectControls(frame).catch(() => []);
    const uiStrings = await collectDomUiStrings(frame).catch(() => []);
    const screenshotPath = path.join(outDir, 'screenshots', `${String(index++).padStart(2, '0')}-${safeFileName(name)}.png`);
    await frame.locator('body').screenshot({ path: screenshotPath }).catch(() => {});
    return {
      name,
      url: frame.url(),
      bodyText: bodyText.slice(0, 30000),
      bodyTextLength: bodyText.length,
      uiStrings,
      controls,
      screenshotPath
    };
  };
}

/**
 * 从 SDK 注册 payload 中提取高置信用户可见文本。
 *
 * 这里不做“所有字符串扫描”，只认 Owlbear UI API 中语义明确的字段，避免把 URL、id、
 * metadata key 等内部字符串混进翻译词表。
 */
export function extractSdkUiStrings(messages) {
  const uiCall = /OBR_(?:CONTEXT_MENU_CREATE|TOOL_(?:CREATE|MODE_CREATE|ACTION_CREATE)|POPOVER_OPEN|MODAL_OPEN|NOTIFICATION_SHOW|ACTION_SET)/;
  const keys = new Set(['label', 'title', 'message', 'description', 'tooltip']);
  const rows = [];

  function walk(value, keyPath, messageId) {
    if (Array.isArray(value)) return value.forEach((child, index) => walk(child, [...keyPath, String(index)], messageId));
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const next = [...keyPath, key];
      if (typeof child === 'string' && keys.has(key)) rows.push({ text: child, messageId, path: next.join('.') });
      else walk(child, next, messageId);
    }
  }

  for (const message of messages) {
    if (uiCall.test(message.id || '')) walk(message.data, [], message.id);
  }
  const unique = new Map();
  for (const row of rows) if (!unique.has(row.text)) unique.set(row.text, row);
  return [...unique.values()];
}

/**
 * 启动通用 OBR Mock Host。
 *
 * @param {object} options
 * @param {string} options.targetPage 扩展真正的页面入口，例如 https://example.com/action/
 * @param {string} options.outDir 测试报告输出目录
 * @param {object} [options.fixture] SDK getter 的假场景数据
 * @param {number} [options.initialWaitMs] OBR_READY 后等待扩展初始化的时间
 * @param {object} [options.viewport] Playwright viewport
 * @param {(ctx: object) => Promise<object>} [options.explore] 扩展专用自动探索策略
 * @returns {Promise<object>} 完整 mock report
 */
export async function runObrMockHost(options) {
  const {
    targetPage,
    outDir,
    fixture = {},
    initialWaitMs = 3000,
    viewport = { width: 1280, height: 900 },
    explore = null,
    headless = true
  } = options;

  if (!targetPage) throw new Error('runObrMockHost: targetPage is required');
  if (!outDir) throw new Error('runObrMockHost: outDir is required');

  const targetOrigin = new URL(targetPage).origin;
  const player = { ...DEFAULT_PLAYER, ...(fixture.player || {}) };
  const responses = createDefaultResponses(fixture);
  const readyData = fixture.readyData || { userId: player.id, ref: 'mock-ref' };
  const roomId = fixture.roomId || 'mock-room';
  const volatileRuntimeTokens = collectVolatileRuntimeTokens(fixture, player);
  await fs.mkdir(outDir, { recursive: true });

  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(createHostHtml({
      port: server.address().port,
      targetPage,
      targetOrigin,
      roomId,
      readyData,
      responses
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  let browser;
  try {
    browser = await chromium.launch({ headless });
    const page = await browser.newPage({ viewport });
    const consoleEvents = [];
    const pageErrors = [];
    page.on('console', message => consoleEvents.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', error => pageErrors.push(String(error)));

    await page.goto(`http://127.0.0.1:${server.address().port}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(initialWaitMs);

    const frame = page.frames().find(candidate => candidate.url().startsWith(targetPage));
    const snapshot = createSnapshotter(outDir);
    const initialSnapshot = frame ? await snapshot(frame, 'initial') : null;
    const exploration = frame && explore
      ? await explore({ page, frame, snapshot, initialSnapshot })
      : { snapshots: initialSnapshot ? [initialSnapshot] : [], navigationErrors: [] };

    // explore 过程中还可能触发异步 SDK 注册，因此结束后再留一个短窗口收尾。
    await page.waitForTimeout(500);
    const bodyText = frame ? await frame.locator('body').innerText().catch(() => '') : '';
    const html = frame ? await frame.locator('body').innerHTML().catch(() => '') : '';
    const messages = await page.evaluate(() => window.__obrMockMessages || []);
    const unhandledRequestIds = await page.evaluate(() => [...new Set(window.__obrMockUnhandled || [])]);
    const messageIds = [...new Set(messages.map(message => message.id))].sort();
    const messageCounts = Object.fromEntries(messageIds.map(id => [id, messages.filter(message => message.id === id).length]));
    const registeredUi = messages.filter(message => /OBR_(?:CONTEXT_MENU_CREATE|TOOL_(?:CREATE|MODE_CREATE|ACTION_CREATE)|POPOVER_OPEN|MODAL_OPEN|NOTIFICATION_SHOW|ACTION_SET)/.test(message.id || ''));
    const sdkUiStrings = extractSdkUiStrings(messages);
    const snapshots = exploration?.snapshots || (initialSnapshot ? [initialSnapshot] : []);
    const runtimeText = [...new Set(snapshots.flatMap(item => item.uiStrings || []))];

    const report = {
      target: targetPage,
      loaded: Boolean(frame),
      frameUrl: frame?.url() || null,
      bodyTextLength: bodyText.length,
      bodyText: bodyText.slice(0, 30000),
      htmlLength: html.length,
      messageCount: messages.length,
      messageCounts,
      unhandledRequestIds,
      registeredUi,
      sdkUiStrings,
      sdkUiStringCount: sdkUiStrings.length,
      runtimeText,
      runtimeTextCount: runtimeText.length,
      // 这些值来自测试 fixture，不是扩展固定文案。Harvester merge 会用它们剔除
      // `View As: Mock GM` 这类动态污染，但原始 runtimeText 仍保持完整。
      volatileRuntimeTokens,
      navigation: exploration || { snapshots, navigationErrors: [] },
      consoleEvents: consoleEvents.slice(-200),
      pageErrors
    };

    await fs.writeFile(path.join(outDir, 'mock-report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(outDir, 'messages.json'), JSON.stringify(messages, null, 2));
    await fs.writeFile(path.join(outDir, 'sdk-ui-strings.json'), JSON.stringify(sdkUiStrings, null, 2));
    await fs.writeFile(path.join(outDir, 'runtime-text.json'), JSON.stringify(runtimeText, null, 2));
    await page.screenshot({ path: path.join(outDir, 'mock-host.png'), fullPage: true });
    return report;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
