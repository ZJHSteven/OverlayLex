#!/usr/bin/env node

/**
 * OverlayLex 模板翻译纯函数测试。
 *
 * 测试直接从 `overlaylex.user.js` 的标记区间提取生产函数，再在 Node vm 中执行。
 * 这样不会为了“方便测试”维护第二份模板算法，能够保证测试覆盖的是浏览器真正使用的实现。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeFile = path.join(repoRoot, 'src', 'userscript', 'overlaylex.user.js');

async function loadHelpers() {
  const source = await fs.readFile(runtimeFile, 'utf8');
  const startMarker = '// OVERLAYLEX_TEMPLATE_HELPERS_START';
  const endMarker = '// OVERLAYLEX_TEMPLATE_HELPERS_END';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, '生产脚本必须保留模板 helper 测试标记');

  const helperSource = source.slice(start + startMarker.length, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nthis.__exports = { compileTemplateTranslation, applyCompiledTemplateTranslation, getTemplatePlaceholderNames };`, context);
  return context.__exports;
}

test('普通 {{count}} 模板能够匹配运行时数字并回填译文', async () => {
  const { compileTemplateTranslation, applyCompiledTemplateTranslation } = await loadHelpers();
  const compiled = compileTemplateTranslation('Blocked {{count}} wall(s).', '已阻挡 {{count}} 面墙。');
  assert.ok(compiled);
  assert.equal(applyCompiledTemplateTranslation('Blocked 12 wall(s).', [compiled]), '已阻挡 12 面墙。');
});

test('多个占位符和相邻可选片段能够保留运行时内容', async () => {
  const { compileTemplateTranslation, applyCompiledTemplateTranslation } = await loadHelpers();
  const compiled = compileTemplateTranslation(
    'Converted {{count}} fog item(s) to obstruction lines{{skippedText}}{{dedupeText}}.',
    '已将 {{count}} 个迷雾项转换为障碍线{{skippedText}}{{dedupeText}}。'
  );
  assert.ok(compiled);
  const result = applyCompiledTemplateTranslation(
    'Converted 8 fog item(s) to obstruction lines (2 skipped) (1 duplicate removed).',
    [compiled]
  );
  assert.equal(result, '已将 8 个迷雾项转换为障碍线 (2 skipped) (1 duplicate removed)。');
});

test('译文包含原文不存在的占位符时拒绝编译，避免显示错误模板', async () => {
  const { compileTemplateTranslation } = await loadHelpers();
  assert.equal(
    compileTemplateTranslation('Preset "{{name}}" saved.', '预设“{{missing}}”已保存。'),
    null
  );
});

test('非模板词不会进入模板列表', async () => {
  const { compileTemplateTranslation, getTemplatePlaceholderNames } = await loadHelpers();
  assert.equal(compileTemplateTranslation('Settings', '设置'), null);
  assert.deepEqual(Array.from(getTemplatePlaceholderNames('{{name}} / {{count}}')), ['name', 'count']);
});
