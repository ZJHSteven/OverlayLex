#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const TARGET_ORIGIN = 'https://smoke.battle-system.com';
const TARGET_PAGE = `${TARGET_ORIGIN}/pages/`;
const OUT_DIR = process.argv[2] || '.harvest/mock-smoke';

const mockPlayer = {
  id: 'mock-user', connectionId: 'mock-connection', role: 'GM', selection: [],
  name: 'Mock GM', color: '#7c3aed', syncView: false, metadata: {}
};
const mockTheme = {
  mode: 'DARK',
  primary: { light: '#a78bfa', main: '#7c3aed', dark: '#5b21b6', contrastText: '#ffffff' },
  secondary: { light: '#67e8f9', main: '#06b6d4', dark: '#0e7490', contrastText: '#ffffff' },
  background: { default: '#111827', paper: '#1f2937' },
  text: { primary: '#f9fafb', secondary: '#d1d5db', disabled: '#6b7280' }
};

function responseFor(id, data) {
  const table = {
    OBR_SCENE_IS_READY: { ready: true },
    OBR_SCENE_GET_METADATA: { metadata: {} },
    OBR_SCENE_ITEMS_GET_ALL_ITEMS: { items: [] },
    OBR_SCENE_ITEMS_GET_ITEMS: { items: [] },
    OBR_SCENE_ITEMS_GET_ITEM_ATTACHMENTS: { items: [] },
    OBR_PLAYER_GET_SELECTION: { selection: [] },
    OBR_PLAYER_GET_NAME: { name: mockPlayer.name },
    OBR_PLAYER_GET_COLOR: { color: mockPlayer.color },
    OBR_PLAYER_GET_SYNC_VIEW: { syncView: false },
    OBR_PLAYER_GET_ID: { id: mockPlayer.id },
    OBR_PLAYER_GET_ROLE: { role: 'GM' },
    OBR_PLAYER_GET_METADATA: { metadata: {} },
    OBR_PLAYER_GET_CONNECTION_ID: { connectionId: mockPlayer.connectionId },
    OBR_PARTY_GET_PLAYERS: { players: [mockPlayer] },
    OBR_ROOM_GET_PERMISSIONS: { permissions: [] },
    OBR_ROOM_GET_METADATA: { metadata: {} },
    OBR_THEME_GET_THEME: { theme: mockTheme },
    OBR_SCENE_GRID_GET_DPI: { dpi: 150 },
    OBR_SCENE_GRID_GET_SCALE: { parsed: { multiplier: 5, unit: 'ft', digits: 0 }, raw: '5 ft' },
    OBR_SCENE_GRID_GET_COLOR: { color: { line: '#000000', background: '#ffffff' } },
    OBR_SCENE_GRID_GET_OPACITY: { opacity: 1 },
    OBR_SCENE_GRID_GET_TYPE: { type: 'SQUARE' },
    OBR_SCENE_GRID_GET_LINE_TYPE: { lineType: 'SOLID' },
    OBR_SCENE_GRID_GET_MEASUREMENT: { measurement: 'CHEBYSHEV' },
    OBR_SCENE_GRID_GET_LINE_WIDTH: { lineWidth: 1 },
    OBR_SCENE_FOG_GET_COLOR: { color: '#000000' },
    OBR_SCENE_FOG_GET_FILLED: { filled: false },
    OBR_VIEWPORT_GET_SCALE: { scale: 1 },
    OBR_VIEWPORT_GET_POSITION: { position: { x: 0, y: 0 } }
  };
  if (Object.hasOwn(table, id)) return table[id];
  if (id === 'OBR_SCENE_GRID_SNAP_POSITION') return { position: data?.position || { x: 0, y: 0 } };
  if (id === 'OBR_SCENE_GRID_GET_DISTANCE') return { distance: 0 };
  if (/_(?:SET|ADD|DELETE|UPDATE|SELECT|DESELECT|CREATE|OPEN|CLOSE|SEND|UPLOAD|CLEAR|UNDO|REDO)/.test(id)) return {};
  return {};
}

function hostHtml(port) {
  const hostOrigin = `http://127.0.0.1:${port}`;
  const obrref = Buffer.from(`${hostOrigin} mock-room`, 'utf8').toString('base64');
  const src = `${TARGET_PAGE}?obrref=${encodeURIComponent(obrref)}`;
  return `<!doctype html><meta charset="utf-8"><title>OBR Mock Host</title>
  <style>html,body,#extension{width:100%;height:100%;margin:0;border:0}body{background:#222}</style>
  <iframe id="extension" src="${src}"></iframe>
  <script>
  const child = document.getElementById('extension');
  window.__obrMockMessages = [];
  const mockPlayer = ${JSON.stringify(mockPlayer)};
  const mockTheme = ${JSON.stringify(mockTheme)};
  const responseFor = ${responseFor.toString()};
  function sendReady() {
    child.contentWindow.postMessage({ id: 'OBR_READY', data: { userId: 'mock-user', ref: 'mock-ref' } }, '${TARGET_ORIGIN}');
  }
  child.addEventListener('load', () => { setTimeout(sendReady, 50); setTimeout(sendReady, 500); });
  window.addEventListener('message', event => {
    if (event.source !== child.contentWindow || event.origin !== '${TARGET_ORIGIN}') return;
    const msg = event.data || {};
    window.__obrMockMessages.push({ id: msg.id, data: msg.data, nonce: msg.nonce || null, at: Date.now() });
    if (msg.nonce && msg.id) {
      const data = responseFor(msg.id, msg.data);
      child.contentWindow.postMessage({ id: msg.id + '_RESPONSE' + msg.nonce, data }, '${TARGET_ORIGIN}');
    }
  });
  </script>`;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(hostHtml(server.address().port));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleEvents = [];
  const pageErrors = [];
  page.on('console', msg => consoleEvents.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(12000);
  const frame = page.frames().find(f => f.url().startsWith(TARGET_PAGE));
  const bodyText = frame ? await frame.locator('body').innerText().catch(() => '') : '';
  const html = frame ? await frame.locator('body').innerHTML().catch(() => '') : '';
  const messages = await page.evaluate(() => window.__obrMockMessages || []);
  const counts = Object.fromEntries([...new Set(messages.map(m => m.id))].map(id => [id, messages.filter(m => m.id === id).length]));
  const registeredUi = messages.filter(m => /(?:CONTEXT_MENU_CREATE|TOOL_CREATE|POPOVER_OPEN|MODAL_OPEN|NOTIFICATION_SHOW|ACTION_SET)/.test(m.id || ''));
  const report = {
    target: TARGET_PAGE,
    loaded: Boolean(frame),
    frameUrl: frame?.url() || null,
    bodyTextLength: bodyText.length,
    bodyText: bodyText.slice(0, 20000),
    htmlLength: html.length,
    messageCount: messages.length,
    messageCounts: counts,
    registeredUi,
    consoleEvents: consoleEvents.slice(-200),
    pageErrors
  };
  await fs.writeFile(path.join(OUT_DIR, 'mock-report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(OUT_DIR, 'messages.json'), JSON.stringify(messages, null, 2));
  await page.screenshot({ path: path.join(OUT_DIR, 'mock-smoke.png'), fullPage: true });
  console.log(JSON.stringify({ loaded: report.loaded, bodyTextLength: report.bodyTextLength, messageCount: report.messageCount, messageCounts: report.messageCounts, registeredUiCount: registeredUi.length, pageErrors }, null, 2));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (!frame) process.exitCode = 2;
}

main().catch(error => { console.error(error); process.exit(1); });
