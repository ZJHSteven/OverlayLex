import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");
const PACKAGE_PATH = path.join(REPO_ROOT, "src", "packages", "obr-smoke-battle-system-com.json");
const REVIEW_PATH = path.join(REPO_ROOT, "src", "reviews", "obr-smoke-battle-system-com.manual-zh-CN.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function placeholders(text) {
  return [...String(text || "").matchAll(/{{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*}}/g)]
    .map(match => match[1])
    .sort();
}

const packageData = readJson(PACKAGE_PATH);
const review = readJson(REVIEW_PATH);
const translations = packageData.translations || {};
const reviewed = review.translations || {};

test("Smoke 5.0.3 人工初译批次固定为 261 条且全部属于运行时包", () => {
  const keys = Object.keys(reviewed);
  assert.equal(keys.length, 261);
  for (const original of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(translations, original), `Smoke package 缺少 original: ${original}`);
    assert.ok(String(reviewed[original] || "").trim(), `人工初译不能为空: ${original}`);
  }
});

test("所有模板译文完整保留原文占位符多重集合", () => {
  for (const [original, translation] of Object.entries(reviewed)) {
    assert.deepEqual(
      placeholders(translation),
      placeholders(original),
      `模板占位符不一致: ${original}`
    );
  }
});

test("ParaTranz 回拉后若 package 已有译文，则必须与人工初译审计稿一致", () => {
  for (const [original, expected] of Object.entries(reviewed)) {
    const current = String(translations[original] ?? "");
    // 在 ParaTranz bot PR 合并前，main/功能分支允许仍为空；一旦有值，就不允许静默漂移。
    if (!current.trim()) continue;
    assert.equal(current, expected, `译文与人工初译审计稿不一致: ${original}`);
  }
});
