#!/usr/bin/env node
/**
 * 抽词工具（教学向）
 *
 * 用途：
 * - 从导出的 HTML 快速提取“可能需要翻译”的可见文本候选。
 * - 生成一个可编辑 JSON，便于你逐步补中文。
 *
 * 说明：
 * - 这是“候选抽取”，不是最终翻译真值。
 * - 会主动忽略 script/style/noscript/textarea 里的内容。
 * - 会额外提取 placeholder/title（它们通常是可见提示）。
 *
 * 用法：
 *   node src/tools/extract-visible-texts.js html/owlbear.rodeo/room/.html
 *   node src/tools/extract-visible-texts.js html/owlbear.rodeo/room/.html src/packages/room-candidates.json
 */

import fs from "node:fs";
import path from "node:path";

function decodeHtmlEntity(text) {
  // 这里只做最常见实体的轻量解码，足够当前 demo 使用。
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeCandidate(text) {
  // 统一空白，避免同一句话因为换行/缩进差异被当成多条。
  return decodeHtmlEntity(text).replace(/\s+/g, " ").trim();
}

function collectFromTextNodes(html) {
  const cleaned = html
    // 先移除 script，避免误把代码字符串当 UI 文本。
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    // 再移除 style，避免 CSS 里的英文混入结果。
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    // 移除 noscript，避免“JS 未启用提示”污染正常页面候选。
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    // 移除 textarea，避免把用户输入模板当作 UI 固定文案。
    .replace(/<textarea[\s\S]*?<\/textarea>/gi, " ");

  const textNodeRegex = />([^<]+)</g;
  const result = new Set();
  let match = null;
  while ((match = textNodeRegex.exec(cleaned))) {
    const normalized = normalizeCandidate(match[1]);
    if (!normalized) {
      continue;
    }
    // 过滤太短或纯数字文本，减少噪声（例如“1”“2”）。
    if (normalized.length < 2) {
      continue;
    }
    // 当前目标是英文化文本，所以先筛含英文字母的候选。
    if (!/[A-Za-z]/.test(normalized)) {
      continue;
    }
    result.add(normalized);
  }
  return result;
}

function collectFromAttributes(html) {
  const attrRegex = /\b(?:placeholder|title)="([^"]+)"/gi;
  const result = new Set();
  let match = null;
  while ((match = attrRegex.exec(html))) {
    const normalized = normalizeCandidate(match[1]);
    if (!normalized) {
      continue;
    }
    if (!/[A-Za-z]/.test(normalized)) {
      continue;
    }
    result.add(normalized);
  }
  return result;
}

function buildOutputObject(candidates, sourcePath) {
  const sorted = [...candidates].sort((a, b) => a.localeCompare(b, "en"));
  const translations = {};
  for (const englishText of sorted) {
    // 初始值先留空字符串，后续你逐条补中文。
    translations[englishText] = "";
  }
  return {
    id: "room-candidates",
    name: "房间页候选翻译词条",
    sourceFile: sourcePath,
    extractedAt: new Date().toISOString(),
    count: sorted.length,
    translations,
  };
}

function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error("缺少输入文件路径。");
    console.error("示例: node src/tools/extract-visible-texts.js html/owlbear.rodeo/room/.html");
    process.exit(1);
  }

  const outputFile = process.argv[3] || path.join("src", "packages", "room-candidates.json");
  if (!fs.existsSync(inputFile)) {
    console.error(`输入文件不存在: ${inputFile}`);
    process.exit(1);
  }

  const html = fs.readFileSync(inputFile, "utf8");
  const textCandidates = collectFromTextNodes(html);
  const attrCandidates = collectFromAttributes(html);
  const merged = new Set([...textCandidates, ...attrCandidates]);
  const output = buildOutputObject(merged, inputFile);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), "utf8");

  console.log(`抽取完成: ${outputFile}`);
  console.log(`候选条数: ${output.count}`);
}

main();
