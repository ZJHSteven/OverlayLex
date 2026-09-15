#!/usr/bin/env node

/**
 * OverlayLex 浏览器级回归测试。
 *
 * 这不是 DOM 函数单测，而是把真正构建出来的 Chrome MV3 扩展装进 Playwright Chromium，
 * 再从网络层提供一份可控的 OverlayLex manifest / 翻译包和目标页面。
 *
 * 当前覆盖两类最重要的回归：
 * 1. Smoke & Spectre 5.0.3：使用 ParaTranz 人工初译审计稿覆盖本地尚为空的 261 条，
 *    验证普通 literal、{{count}}、{{name}} 和相邻子模板都能在真实 content script 中翻译；
 * 2. Clash：验证原有精确 Map 翻译仍保持原行为，防止模板能力影响其它插件。
 *
 * 测试页面通过 Playwright route.fulfill 提供，但 URL 使用真实受支持域名，因此经过的
 * manifest host 权限、content-script 注入、远端包下载、DOM observer 与翻译 runtime 都是
 * 正式代码路径。测试不访问生产 R2，也不会污染用户浏览器缓存。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');
const EXTENSION_DIR = path.join(REPO_ROOT, '.output', 'chrome-mv3');

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(REPO_ROOT, relativePath), 'utf8'));
}

function jsonResponse(route, value) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(value),
  });
}

async function waitForText(page, selector, expected, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = String(await page.locator(selector).textContent().catch(() => '')).trim();
    if (last === expected) return;
    await page.waitForTimeout(100);
  }
  assert.equal(last, expected, `${selector} 未在 ${timeoutMs}ms 内翻译为预期文本`);
}

async function main() {
  await fs.access(path.join(EXTENSION_DIR, 'manifest.json'));

  const [allowlist, smokeBase, smokeReview, clashPackage] = await Promise.all([
    readJson('src/packages/overlaylex-domain-allowlist.json'),
    readJson('src/packages/obr-smoke-battle-system-com.json'),
    readJson('src/reviews/obr-smoke-battle-system-com.manual-zh-CN.json'),
    readJson('src/packages/obr-clash-battle-system-com.json'),
  ]);

  // 功能分支遵守“ParaTranz 是译文真源”的规则，不直接把 261 条译文写进 package。
  // E2E 需要测试“回拉之后”的真实效果，因此只在内存里把经过审计的人工初译覆盖进去。
  const smokePackage = structuredClone(smokeBase);
  smokePackage.version = `${smokeBase.version}-e2e`;
  smokePackage.translations = {
    ...smokeBase.translations,
    ...(smokeReview.translations || {}),
  };

  const smokePackageUrl = 'https://overlaylex-api.zjhstudio.com/packages/obr-smoke-battle-system-com.json';
  const clashPackageUrl = 'https://overlaylex-api.zjhstudio.com/packages/obr-clash-battle-system-com.json';
  const allowlistUrl = 'https://overlaylex-api.zjhstudio.com/packages/overlaylex-domain-allowlist.json';
  const manifest = {
    scriptVersion: 'e2e',
    generatedAt: '2026-09-16T00:00:00.000Z',
    apiBaseUrl: 'https://overlaylex-api.zjhstudio.com',
    domainPackage: {
      id: allowlist.id,
      name: allowlist.name,
      kind: allowlist.kind,
      version: allowlist.version,
      url: allowlistUrl,
    },
    packages: [
      {
        id: smokePackage.id,
        name: smokePackage.name,
        kind: 'translation',
        version: smokePackage.version,
        url: smokePackageUrl,
        enabledByDefault: true,
      },
      {
        id: clashPackage.id,
        name: clashPackage.name,
        kind: 'translation',
        version: `${clashPackage.version}-e2e`,
        url: clashPackageUrl,
        enabledByDefault: true,
      },
    ],
  };

  const smokeFixture = `<!doctype html><meta charset="utf-8"><title>Smoke E2E</title>
    <main>
      <p id="literal">Default Vision Range</p>
      <p id="count-template">Blocked 12 wall(s).</p>
      <p id="name-template">Alice (You)</p>
      <p id="nested-template">Converted 3 fog item(s) to obstruction lines(1 skipped)(2 duplicates removed).</p>
    </main>`;
  const clashFixture = `<!doctype html><meta charset="utf-8"><title>Clash E2E</title>
    <main><p id="loading">Loading...</p><p id="settings">Settings</p></main>`;
  const seedFixture = `<!doctype html><meta charset="utf-8"><title>OverlayLex Seed E2E</title>
    <main><p>OverlayLex cold-start seed page</p></main>`;

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overlaylex-e2e-'));
  let context;
  try {
    // Playwright 官方要求扩展测试使用 persistent context，并推荐 `channel: chromium`。
    // 这个 channel 使用完整 Chromium 的新 headless 路径，能够加载 unpacked extension；
    // 普通默认 headless shell 则不保证扩展能力。需要现场观察时可设 OVERLAYLEX_E2E_HEADED=1。
    const headless = process.env.OVERLAYLEX_E2E_HEADED !== '1';
    const executablePath = String(process.env.OVERLAYLEX_E2E_CHROMIUM || '').trim() || undefined;
    const launchOptions = {
      headless,
      // `channel: chromium` 是 Playwright 文档明确给出的扩展测试方式；它和自定义
      // executablePath 二选一。后者只保留给本机故障诊断，不作为 CI 默认路径。
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    };
    context = await chromium.launchPersistentContext(profileDir, launchOptions);

    await context.route('https://overlaylex-api.zjhstudio.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/manifest') return jsonResponse(route, manifest);
      if (url.pathname === '/packages/overlaylex-domain-allowlist.json') return jsonResponse(route, allowlist);
      if (url.pathname === '/packages/obr-smoke-battle-system-com.json') return jsonResponse(route, smokePackage);
      if (url.pathname === '/packages/obr-clash-battle-system-com.json') return jsonResponse(route, clashPackage);
      return route.fulfill({ status: 404, body: 'not found' });
    });

    await context.route('https://smoke.battle-system.com/e2e-overlaylex', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: smokeFixture,
    }));
    await context.route('https://clash.battle-system.com/e2e-overlaylex', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: clashFixture,
    }));

    await context.route('https://www.owlbear.rodeo/e2e-overlaylex', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: seedFixture,
    }));

    // OverlayLex 的本地 seeds 有意只保留 Owlbear 主域。全新 profile 先访问 seed，
    // 让远端 allowlist 写入扩展共享 storage；之后 Smoke / Clash iframe 域才按真实用户路径放行。
    const seedPage = await context.newPage();
    await seedPage.goto('https://www.owlbear.rodeo/e2e-overlaylex', { waitUntil: 'domcontentloaded' });
    await seedPage.locator('.overlaylex-ball').waitFor({ state: 'attached', timeout: 12000 });

    const smokePage = await context.newPage();
    await smokePage.goto('https://smoke.battle-system.com/e2e-overlaylex', { waitUntil: 'domcontentloaded' });
    await waitForText(smokePage, '#literal', '默认视野范围');
    await waitForText(smokePage, '#count-template', '已将 12 面墙设为不可穿过。');
    await waitForText(smokePage, '#name-template', 'Alice（你）');
    await waitForText(smokePage, '#nested-template', '已将 3 个迷雾项转换为障碍线（已跳过 1 项）（已移除 2 个重复项）。');
    assert.equal(await smokePage.locator('.overlaylex-ball').count(), 1, 'Smoke 页面未注入 OverlayLex UI');

    const clashPage = await context.newPage();
    await clashPage.goto('https://clash.battle-system.com/e2e-overlaylex', { waitUntil: 'domcontentloaded' });
    await waitForText(clashPage, '#loading', '加载中…');
    await waitForText(clashPage, '#settings', '设置');
    assert.equal(await clashPage.locator('.overlaylex-ball').count(), 1, 'Clash 页面未注入 OverlayLex UI');

    console.log(JSON.stringify({
      smoke: {
        literal: 'ok',
        countTemplate: 'ok',
        nameTemplate: 'ok',
        nestedTemplate: 'ok',
      },
      clashLiteralRegression: 'ok',
    }, null, 2));
  } finally {
    await context?.close().catch(() => {});
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});

