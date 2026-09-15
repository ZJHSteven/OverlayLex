#!/usr/bin/env node
/**
 * OverlayLex 模板翻译运行时回归测试。
 *
 * 这里不复制一份“看起来一样”的实现，而是直接从真正发布的
 * `src/userscript/overlaylex.user.js` 抽取纯函数区，再用 Node VM 执行。
 * 因此只要用户脚本里的模板逻辑发生变化，本测试就会同步覆盖那份真实代码。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const USER_SCRIPT_PATH = path.resolve(THIS_DIR, "../userscript/overlaylex.user.js");
const START_MARKER = "// TEMPLATE_TRANSLATION_HELPERS_START";
const END_MARKER = "// TEMPLATE_TRANSLATION_HELPERS_END";

function loadTemplateApi() {
  const source = fs.readFileSync(USER_SCRIPT_PATH, "utf8");
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  assert.ok(start >= 0 && end > start, "用户脚本中必须保留模板翻译纯函数区标记");

  const helperSource = source.slice(start + START_MARKER.length, end);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${helperSource}\n` +
      `globalThis.__overlayLexTemplateApi = {` +
      ` compileTemplateTranslation, translateByTemplateRules, getTemplatePlaceholderNames };`,
    sandbox,
    { filename: "overlaylex-template-helpers.vm.js" }
  );
  return sandbox.__overlayLexTemplateApi;
}

const api = loadTemplateApi();

function compileRules(pairs) {
  return pairs
    .map(([source, target]) => api.compileTemplateTranslation(source, target))
    .filter(Boolean)
    .sort((a, b) => b.specificity - a.specificity || b.source.length - a.source.length);
}

test("模板翻译会保留 count 并正确处理正则特殊字符", () => {
  const rules = compileRules([["Blocked {{count}} wall(s).", "已阻挡 {{count}} 面墙。"]]);
  assert.equal(api.translateByTemplateRules("Blocked 12 wall(s).", rules), "已阻挡 12 面墙。");
});

test("用户名称等业务变量保持原值，不会被误翻", () => {
  const rules = compileRules([["{{name}} (You)", "{{name}}（你）"]]);
  assert.equal(api.translateByTemplateRules("Alice (You)", rules), "Alice（你）");
});

test("相邻 Text 占位符中的子模板可继续翻译", () => {
  const rules = compileRules([
    ["({{count}} skipped)", "（跳过 {{count}} 个）"],
    ["({{count}} duplicates removed)", "（移除 {{count}} 个重复项）"],
    [
      "Converted {{count}} fog item(s) to obstruction lines{{skippedText}}{{dedupeText}}.",
      "已将 {{count}} 个迷雾项转换为障碍线{{skippedText}}{{dedupeText}}。",
    ],
  ]);
  assert.equal(
    api.translateByTemplateRules(
      "Converted 3 fog item(s) to obstruction lines(1 skipped)(2 duplicates removed).",
      rules
    ),
    "已将 3 个迷雾项转换为障碍线（跳过 1 个）（移除 2 个重复项）。"
  );
});

test("原文与译文占位符不一致时拒绝编译", () => {
  assert.equal(api.compileTemplateTranslation("Preset {{name}}: {{count}}", "预设 {{name}}"), null);
  assert.equal(api.compileTemplateTranslation("Preset {{name}}", "预设 {{name}} / {{count}}"), null);
});

test("多变量模板允许调整中文语序但保留全部变量", () => {
  const rules = compileRules([
    [
      "Preset \"{{name}}\" applied to {{count}} token(s).",
      "已将预设“{{name}}”应用到 {{count}} 个 token。",
    ],
  ]);
  assert.equal(
    api.translateByTemplateRules('Preset "Dark Room" applied to 4 token(s).', rules),
    "已将预设“Dark Room”应用到 4 个 token。"
  );
});
