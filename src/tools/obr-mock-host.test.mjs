/**
 * OBR Mock Host 本地集成测试。
 *
 * 这里故意不依赖 Smoke & Spectre，也不依赖真实 Owlbear。
 * 测试会临时启动一个“假扩展”HTTP 服务。假扩展只实现最小的 SDK 风格 postMessage：
 * - 收到 OBR_READY 后请求 OBR_SCENE_IS_READY；
 * - 注册一个 Context Menu；
 * - 把收到的 ready 状态渲染到 DOM；
 * - 再创建 ARIA 与 open Shadow DOM 文本。
 *
 * 如果这一测试通过，说明通用 Host 本身成立；Smoke 只是一份真实世界兼容性 fixture。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runObrMockHost } from './obr-mock-host.mjs';

function fakeExtensionHtml() {
  return `<!doctype html>
  <html>
  <body>
    <main id="status">Waiting for OBR_READY...</main>
    <button aria-label="Mock Action">Action</button>
    <div id="shadow"></div>
    <script>
      const params = new URLSearchParams(location.search);
      const obrref = params.get('obrref');
      const decoded = atob(obrref || '');
      const split = decoded.lastIndexOf(' ');
      const hostOrigin = decoded.slice(0, split);
      let nonce = 0;
      let initialized = false;
      const pending = new Map();

      function request(id, data = {}) {
        return new Promise(resolve => {
          const n = String(++nonce);
          pending.set(id + '_RESPONSE' + n, resolve);
          parent.postMessage({ id, data, nonce: n }, hostOrigin);
        });
      }

      addEventListener('message', async event => {
        if (event.origin !== hostOrigin) return;
        if (event.data?.id === 'OBR_READY') {
          // 通用 Host 会发送两次 OBR_READY 做启动容错。这个极简测试页没有真实 SDK
          // 内部的初始化状态机，因此自己保证幂等，避免第二次 Ready 重复 attachShadow。
          if (initialized) return;
          initialized = true;
          const ready = await request('OBR_SCENE_IS_READY');
          document.getElementById('status').textContent = ready.ready ? 'Harness Ready' : 'Harness Not Ready';
          parent.postMessage({
            id: 'OBR_CONTEXT_MENU_CREATE',
            data: { id: 'mock-menu', icons: [{ icon: '/icon.svg', label: 'Mock Menu' }] },
            nonce: String(++nonce)
          }, hostOrigin);
          const shadow = document.getElementById('shadow').attachShadow({ mode: 'open' });
          shadow.innerHTML = '<span aria-description="Shadow Description">Shadow Text</span>';
          return;
        }
        const resolve = pending.get(event.data?.id);
        if (resolve) {
          pending.delete(event.data.id);
          resolve(event.data.data || {});
        }
      });
    </script>
  </body>
  </html>`;
}

test('generic host completes ready/request/registration/DOM capture without real Owlbear', async () => {
  const extensionServer = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fakeExtensionHtml());
  });
  await new Promise(resolve => extensionServer.listen(0, '127.0.0.1', resolve));

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaylex-obr-mock-'));
  try {
    const targetPage = `http://127.0.0.1:${extensionServer.address().port}/extension`;
    const report = await runObrMockHost({ targetPage, outDir, initialWaitMs: 700 });

    assert.equal(report.loaded, true);
    assert.deepEqual(report.pageErrors, []);
    assert.ok(report.messageCounts.OBR_SCENE_IS_READY >= 1);
    assert.ok(report.messageCounts.OBR_CONTEXT_MENU_CREATE >= 1);
    assert.ok(report.sdkUiStrings.some(row => row.text === 'Mock Menu'));
    assert.ok(report.runtimeText.includes('Harness Ready'));
    assert.ok(report.runtimeText.includes('Mock Action'));
    assert.ok(report.runtimeText.includes('Shadow Text'));
    assert.ok(report.runtimeText.includes('Shadow Description'));
  } finally {
    await new Promise(resolve => extensionServer.close(resolve));
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
