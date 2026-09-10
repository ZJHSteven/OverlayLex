#!/usr/bin/env node

/**
 * Smoke & Spectre 的 OBR Mock Host runner。
 *
 * 通用 Owlbear 宿主协议已经移动到 `obr-mock-host.mjs`；本文件只保留 Smoke 特有的
 * “如何展开左下角导航”策略。这样以后测试别的 Owlbear Extension 时，只需要新建另一份
 * runner/fixture，不再复制 OBR_READY、SDK 响应、DOM/ARIA 采样等基础设施。
 */

import process from 'node:process';
import { collectControls, runObrMockHost } from './obr-mock-host.mjs';

const TARGET_PAGE = 'https://smoke.battle-system.com/pages/';
const OUT_DIR = process.argv[2] || '.harvest/mock-smoke';

/**
 * Smoke 的菜单按钮没有稳定文本/aria-label，因此用“左侧底部的小按钮”这一布局特征定位。
 * 这是扩展专用启发式，不应该进入通用 Host。
 */
async function findMenuButton(frame) {
  const buttons = frame.locator('button,[role="button"]');
  const count = await buttons.count();
  let best = null;
  for (let index = 0; index < count; index++) {
    const locator = buttons.nth(index);
    const box = await locator.boundingBox().catch(() => null);
    if (!box) continue;
    const text = (await locator.innerText().catch(() => '')).trim();
    const aria = await locator.getAttribute('aria-label').catch(() => '');
    if (box.x < 120 && box.y > 600 && (!text || text.length < 20)) {
      if (!best || box.y > best.box.y) best = { locator, box, text, aria };
    }
  }
  return best;
}

async function openNavigation(frame) {
  const menu = await findMenuButton(frame);
  if (!menu) return false;
  await menu.locator.click({ timeout: 3000 }).catch(() => {});
  await frame.waitForTimeout(600);
  return true;
}

/**
 * 自动遍历 Smoke 主要导航页。
 *
 * 删除/清空/重置/外链等潜在破坏性或无关入口被明确跳过。每次切页等待 lazy chunk 与 React
 * 渲染稳定，再调用通用 snapshot 采 DOM / ARIA / Shadow 文本和截图。
 */
async function crawlSmokeNavigation({ frame, snapshot, initialSnapshot }) {
  const snapshots = initialSnapshot ? [initialSnapshot] : [];
  if (!(await openNavigation(frame))) {
    return { snapshots, menuLabels: [], navigationErrors: ['menu-button-not-found'] };
  }
  snapshots.push(await snapshot(frame, 'menu-open'));

  const controls = (await collectControls(frame)).filter(control => control.visible && control.text && !control.href);
  const menuLabels = [...new Set(controls.map(control => control.text).filter(text => text.length <= 80))];
  const skip = /(?:patreon|discord|github|changelog|documentation|support|delete|remove|reset|clear)/i;
  const navigationErrors = [];

  for (const label of menuLabels.slice(0, 30)) {
    if (skip.test(label)) continue;
    let candidate = frame.getByRole('button', { name: label, exact: true });
    const visibleNow = (await candidate.count()) > 0 && await candidate.first().isVisible().catch(() => false);
    if (!visibleNow) {
      await openNavigation(frame);
      candidate = frame.getByRole('button', { name: label, exact: true });
    }
    if (!(await candidate.count())) continue;

    try {
      await candidate.first().click({ timeout: 2500 });
      await frame.waitForTimeout(2200);
      snapshots.push(await snapshot(frame, `nav:${label}`));
    } catch (error) {
      navigationErrors.push(`${label}: ${String(error?.message || error).split('\n')[0]}`);
    }
  }

  return { snapshots, menuLabels, navigationErrors };
}

async function main() {
  const report = await runObrMockHost({
    targetPage: TARGET_PAGE,
    outDir: OUT_DIR,
    initialWaitMs: 7000,
    explore: crawlSmokeNavigation
  });

  console.log(JSON.stringify({
    loaded: report.loaded,
    bodyTextLength: report.bodyTextLength,
    messageCount: report.messageCount,
    registeredUiCount: report.registeredUi.length,
    sdkUiStringCount: report.sdkUiStringCount,
    runtimeTextCount: report.runtimeTextCount,
    unhandledRequestIds: report.unhandledRequestIds,
    menuLabels: report.navigation.menuLabels || [],
    snapshots: (report.navigation.snapshots || []).map(snapshot => ({
      name: snapshot.name,
      bodyTextLength: snapshot.bodyTextLength,
      uiStrings: snapshot.uiStrings.length
    })),
    navigationErrors: report.navigation.navigationErrors || [],
    pageErrors: report.pageErrors
  }, null, 2));

  if (!report.loaded) process.exitCode = 2;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
