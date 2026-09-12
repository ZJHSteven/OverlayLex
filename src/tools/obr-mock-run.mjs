#!/usr/bin/env node

/**
 * OBR Mock Host 通用命令行入口。
 *
 * 适用场景：
 * - 想先验证一个 Owlbear Extension 能不能脱离真实 Owlbear 房间启动；
 * - 想在 CI 中快速发现 page error / 尚未模拟的 SDK getter；
 * - 想采集扩展初始页的 DOM / ARIA / Shadow DOM 文案和 SDK UI 注册文案；
 * - 暂时还不需要像 Smoke runner 那样编写扩展专用导航策略。
 *
 * 示例：
 *   node src/tools/obr-mock-run.mjs https://example.com/action/ \
 *     --out .harvest/example \
 *     --fixture tests/fixtures/example-gm.json \
 *     --expect-clean
 */

import fs from 'node:fs/promises';
import process from 'node:process';
import { runObrMockHost } from './obr-mock-host.mjs';

function parseArgs(argv) {
  const result = {
    targetPage: null,
    outDir: '.harvest/mock-extension',
    fixturePath: null,
    waitMs: 3000,
    headless: true,
    expectClean: false
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--') && !result.targetPage) result.targetPage = arg;
    else if (arg === '--out') result.outDir = argv[++index];
    else if (arg === '--fixture') result.fixturePath = argv[++index];
    else if (arg === '--wait') result.waitMs = Number(argv[++index]);
    else if (arg === '--headed') result.headless = false;
    else if (arg === '--expect-clean') result.expectClean = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function printUsage() {
  console.log(`Usage: node src/tools/obr-mock-run.mjs <extension-page-url> [options]\n\n` +
    `Options:\n` +
    `  --out <dir>        报告输出目录，默认 .harvest/mock-extension\n` +
    `  --fixture <json>   可选的 Mock 场景 JSON\n` +
    `  --wait <ms>        OBR_READY 后等待初始化的毫秒数，默认 3000\n` +
    `  --headed           显示 Chromium 窗口，便于本地观察\n` +
    `  --expect-clean     loaded=false、pageErrors 或 unhandled getter 存在时返回非零退出码\n`);
}

async function loadFixture(filePath) {
  if (!filePath) return {};
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.targetPage) {
    printUsage();
    process.exit(args.help ? 0 : 2);
  }

  const fixture = await loadFixture(args.fixturePath);
  const report = await runObrMockHost({
    targetPage: args.targetPage,
    outDir: args.outDir,
    fixture,
    initialWaitMs: args.waitMs,
    headless: args.headless
  });

  const summary = {
    target: report.target,
    loaded: report.loaded,
    messageTypes: Object.keys(report.messageCounts).length,
    messageCount: report.messageCount,
    registeredUiCount: report.registeredUi.length,
    sdkUiStringCount: report.sdkUiStringCount,
    runtimeTextCount: report.runtimeTextCount,
    unhandledRequestIds: report.unhandledRequestIds,
    pageErrors: report.pageErrors
  };
  console.log(JSON.stringify(summary, null, 2));

  if (args.expectClean && (
    !report.loaded ||
    report.pageErrors.length > 0 ||
    report.unhandledRequestIds.length > 0
  )) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
