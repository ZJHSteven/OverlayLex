#!/usr/bin/env node

/**
 * OBR 上游每日巡检器。
 *
 * 这个脚本把已经验证过的三段能力串成一条无人值守链：
 * 1. `obr-harvester.mjs`：从 manifest 出发递归分析生产 HTML / JS / CSS / chunk；
 * 2. `obr-mock-host`：在 Fake Owlbear + Playwright 中抓 SDK 注册 UI 与真实 DOM；
 * 3. `obr-harvest-merge.mjs`：把 i18n catalog / SDK payload / Mock DOM 合成高置信语料。
 *
 * watcher 本身不直接调用 ParaTranz。原因是 ParaTranz Token 属于部署凭据，应该由
 * GitHub Actions 在“确认 package 确实有新增 original”后通过现有
 * `overlaylex-i18n-flow.mjs push-paratranz --staged-only` 统一处理。
 *
 * 重要安全语义：
 * - 只新增 original，不自动删除旧词；
 * - JS `Set` 天然大小写敏感，`Ignore hidden tokens` 和 `Ignore Hidden Tokens`
 *   会被保留为两个独立词条；不要在这条链里使用 PowerShell `Sort-Object -Unique`；
 * - tracked state 只在真实上游版本/资源/主语料变化时更新，不记录“每日检查时间”，
 *   避免没有变化也每天制造 Git diff / PR。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const options = {
    config: 'config/obr-upstream-targets.json',
    state: 'config/obr-upstream-state.json',
    out: '.harvest/upstream-watch',
    applyPackages: false,
    updateState: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config') options.config = argv[++index];
    else if (token === '--state') options.state = argv[++index];
    else if (token === '--out') options.out = argv[++index];
    else if (token === '--apply-packages') options.applyPackages = true;
    else if (token === '--update-state') options.updateState = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node src/tools/obr-upstream-watch.mjs [options]',
    '',
    '  --config <file>       OBR target 配置文件',
    '  --state <file>        已确认的上游基线状态',
    '  --out <dir>           本次巡检诊断产物目录',
    '  --apply-packages      把新高置信 original 合入 src/packages',
    '  --update-state        真实变化时更新 tracked state'
  ].join('\n');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback;
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * 资源图哈希只采用“成功取得的资源”的稳定字段，并按 URL 排序。
 * `obr-harvester` 已为每个文本响应计算 SHA-256，因此即使 URL、字节数都没有变化，
 * 只要实际内容改变，watcher 仍会识别到上游更新。
 */
export function stableAssetGraphHash(assetGraph) {
  const rows = (assetGraph?.resources || [])
    .filter(row => row?.status === 'ok')
    .map(row => ({
      url: String(row.finalUrl || row.url || ''),
      bytes: Number(row.bytes || 0),
      contentType: String(row.contentType || ''),
      sha256: String(row.sha256 || '')
    }))
    .sort((left, right) => left.url < right.url ? -1 : left.url > right.url ? 1 : 0);
  return hashJson(rows);
}

/**
 * 高置信主语料哈希按 JavaScript 默认代码点顺序排序，保证 Linux / Windows 一致，
 * 同时保持大小写敏感。
 */
export function stableCorpusHash(rows) {
  const texts = [...new Set((rows || [])
    .map(row => String(row?.text || '').trim())
    .filter(Boolean))].sort();
  return hashJson(texts);
}

export function uniqueOriginals(rows) {
  return [...new Set((rows || [])
    .map(row => String(row?.text || '').trim())
    .filter(Boolean))].sort();
}

export function hasSubstantiveStateChange(previous = {}, current = {}) {
  return String(previous.manifestVersion || '') !== String(current.manifestVersion || '')
    || String(previous.assetGraphHash || '') !== String(current.assetGraphHash || '')
    || String(previous.corpusHash || '') !== String(current.corpusHash || '');
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      shell: false
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function resolveManifestPage(manifest, manifestUrl, configuredPage = '') {
  const raw = configuredPage || manifest?.action?.popover || manifest?.background_url || '';
  return raw ? new URL(raw, manifestUrl).href : '';
}

async function fetchManifest(manifestUrl) {
  const response = await fetch(manifestUrl, {
    headers: {
      'user-agent': 'OverlayLex-OBR-Upstream-Watch/0.1 (+https://github.com/ZJHSteven/OverlayLex)'
    }
  });
  if (!response.ok) throw new Error(`Manifest ${manifestUrl} -> HTTP ${response.status}`);
  return response.json();
}

async function runTarget(target, options, state) {
  const targetOut = path.join(options.out, target.id);
  const staticDir = path.join(targetOut, 'static');
  const mockDir = path.join(targetOut, 'mock');
  const mergedDir = path.join(targetOut, 'merged');
  await fs.rm(targetOut, { recursive: true, force: true });
  await fs.mkdir(targetOut, { recursive: true });

  const manifest = await fetchManifest(target.manifest);
  const targetPage = resolveManifestPage(manifest, target.manifest, target.page);
  if (!targetPage) {
    throw new Error(`[${target.id}] manifest 没有 action.popover / background_url，请在 target.page 显式配置入口。`);
  }

  await run(process.execPath, [
    'src/tools/obr-harvester.mjs',
    target.manifest,
    '--existing', target.package,
    '--out', staticDir,
    '--max-assets', String(target.maxAssets || 300)
  ]);

  if (target.runner === 'smoke') {
    await run(process.execPath, ['src/tools/obr-mock-smoke.mjs', mockDir]);
  } else {
    await run(process.execPath, [
      'src/tools/obr-mock-run.mjs',
      targetPage,
      '--out', mockDir,
      '--expect-clean'
    ]);
  }

  await run(process.execPath, [
    'src/tools/obr-harvest-merge.mjs',
    '--static', staticDir,
    '--mock', mockDir,
    '--existing', target.package,
    '--out', mergedDir
  ]);

  const assetGraph = await readJson(path.join(staticDir, 'asset-graph.json'), { resources: [] });
  const highConfidenceRows = await readJson(path.join(mergedDir, 'high-confidence.json'), []);
  const newRows = await readJson(path.join(mergedDir, 'new-high-confidence.json'), []);
  const mergeReport = await readJson(path.join(mergedDir, 'report.json'), {});
  const newOriginals = uniqueOriginals(newRows);

  // collector 输入严格使用 JS Set 生成，避免 PowerShell 大小写不敏感去重造成丢词。
  const collectorInput = { [target.host]: newOriginals };
  const collectorPath = path.join(targetOut, 'collector.selected.json');
  await writeJson(collectorPath, collectorInput);

  if (options.applyPackages && newOriginals.length > 0) {
    await run(process.execPath, [
      'src/tools/overlaylex-i18n-flow.mjs',
      'merge-collected',
      '--input', collectorPath
    ]);
  }

  const current = {
    manifestVersion: String(manifest.version || ''),
    assetGraphHash: stableAssetGraphHash(assetGraph),
    corpusHash: stableCorpusHash(highConfidenceRows)
  };
  const previous = state[target.id] || {};
  const upstreamChanged = hasSubstantiveStateChange(previous, current);

  if (options.updateState && upstreamChanged) {
    state[target.id] = {
      ...current,
      // 只有“基线真的变化”才更新时间；普通每日检查不会改这个字段。
      lastChangedAt: new Date().toISOString()
    };
  }

  const summary = {
    id: target.id,
    manifest: target.manifest,
    targetPage,
    checkedAt: new Date().toISOString(),
    previous,
    current,
    upstreamChanged,
    newHighConfidence: newOriginals.length,
    mergeReport
  };
  await writeJson(path.join(targetOut, 'summary.json'), summary);
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const config = await readJson(options.config);
  if (!config?.targets?.length) throw new Error(`No targets configured in ${options.config}`);
  const state = await readJson(options.state, {});
  const summaries = [];

  await fs.rm(options.out, { recursive: true, force: true });
  await fs.mkdir(options.out, { recursive: true });

  for (const target of config.targets.filter(item => item.enabled !== false)) {
    console.log(`\n=== OBR upstream watch: ${target.id} ===`);
    summaries.push(await runTarget(target, options, state));
  }

  if (options.updateState) await writeJson(options.state, state);
  await writeJson(path.join(options.out, 'summary.json'), {
    generatedAt: new Date().toISOString(),
    targets: summaries
  });

  for (const summary of summaries) {
    console.log(
      `[${summary.id}] version=${summary.current.manifestVersion} `
      + `changed=${summary.upstreamChanged} newHighConfidence=${summary.newHighConfidence}`
    );
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1)));

// Windows 的 file:// pathname 处理比较容易踩盘符坑，因此以文件名再做一个保守兜底。
if (invokedDirectly || process.argv[1]?.endsWith('obr-upstream-watch.mjs')) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
