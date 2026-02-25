#!/usr/bin/env node

/**
 * collector-sanitize.mjs
 *
 * 作用：
 * - 对采集脚本上传的 `{ host: string[] }` 结构做“保守型垃圾过滤”。
 * - 输出两份文件：
 *   1) cleaned.json：可直接喂给 `merge-collected`
 *   2) report.json：过滤统计与样例（供 CI 构建 PR 描述）
 *
 * 设计原则（教学向）：
 * - 只过滤高置信垃圾项，尽量不误杀真实 UI 文案。
 * - 不做语言识别，不做 AI 判断，规则可解释、可审计。
 */

import fs from "node:fs";
import path from "node:path";

function printUsage() {
  console.log(`
用法：
  node src/tools/collector-sanitize.mjs --input <raw.json> --output <cleaned.json> --report <report.json>

可选参数：
  --whitelist-file <path>   白名单 JSON 文件（数组），命中后强制保留
`.trim());
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith("--")) {
      continue;
    }
    const name = key.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      options[name] = true;
      continue;
    }
    options[name] = next;
    i += 1;
  }
  return options;
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeCollectedShape(rawData) {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    throw new Error("输入必须为 { host: string[] } 结构。");
  }

  const normalized = {};
  for (const [hostKey, value] of Object.entries(rawData)) {
    const host = String(hostKey || "").trim().toLowerCase();
    if (!host) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new Error(`域名 ${host} 对应值必须为数组。`);
    }
    normalized[host] = value.map((item) => String(item ?? ""));
  }
  return normalized;
}

function buildWhitelistSet(whitelistFile) {
  if (!whitelistFile) {
    return new Set();
  }
  if (!fs.existsSync(whitelistFile)) {
    throw new Error(`白名单文件不存在：${whitelistFile}`);
  }
  const raw = readJsonFile(whitelistFile);
  if (!Array.isArray(raw)) {
    throw new Error("白名单文件必须是字符串数组 JSON。");
  }
  return new Set(
    raw
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
  );
}

/**
 * classifyNoiseText:
 * - 返回 null 表示“保留”
 * - 返回字符串规则名表示“过滤”
 */
function classifyNoiseText(text, whitelistSet) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "empty";
  }
  if (whitelistSet.has(normalized)) {
    return null;
  }

  // 纯短数字（常见页码、计数器）
  if (/^\d{1,4}$/.test(normalized)) {
    return "short-numeric";
  }

  // 常见容量展示（例如 12 MB、1.2 GB）
  if (/^\d+(?:\.\d+)?\s?(?:B|KB|MB|GB|TB)$/i.test(normalized)) {
    return "size-unit";
  }

  // URL / 纯路径型技术字符串（保守规则）
  if (/^(?:https?:\/\/|www\.)/i.test(normalized)) {
    return "url";
  }
  if (/^(?:\/|[A-Za-z]:\\)/.test(normalized) && /[\\/]/.test(normalized) && !/\s/.test(normalized)) {
    return "path-like";
  }

  // 长十六进制串（hash / checksum / id）
  if (/^[a-f0-9]{16,}$/i.test(normalized)) {
    return "hex-like";
  }

  // OverlayLex 翻译脚本包列表中的版本说明（例如：v0.2.16 · obr-www-owlbear-rodeo）
  // 这类文本属于脚本内部 UI 元数据，不应进入翻译包。
  if (/^v\d+\.\d+\.\d+\s*[·•]\s*obr-[a-z0-9-]+$/i.test(normalized)) {
    return "overlaylex-package-meta";
  }

  // OverlayLex 内部 UI 的高置信固定文案（本地采集已尽量排除，这里作为 CI 兜底）
  if (/^OverlayLex(?:\s+(?:控制台|采集器|提示|连接异常))?$/.test(normalized)) {
    return "overlaylex-ui";
  }

  // 极长无空格技术串（疑似 token / 压缩串 / 机器 ID）
  if (!/\s/.test(normalized) && normalized.length >= 40) {
    return "long-token-like";
  }

  return null;
}

function sanitizeCollected(rawCollected, whitelistSet) {
  const cleaned = {};
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      hostCount: 0,
      rawTextCount: 0,
      cleanedTextCount: 0,
      filteredTextCount: 0,
    },
    byRule: {},
    byHost: {},
    examples: {},
  };

  for (const [host, textList] of Object.entries(rawCollected)) {
    report.summary.hostCount += 1;
    report.byHost[host] = {
      raw: textList.length,
      kept: 0,
      filtered: 0,
    };

    const keptSet = new Set();
    for (const rawText of textList) {
      report.summary.rawTextCount += 1;
      const normalizedText = String(rawText ?? "").trim();
      const ruleName = classifyNoiseText(normalizedText, whitelistSet);
      if (ruleName) {
        report.summary.filteredTextCount += 1;
        report.byHost[host].filtered += 1;
        report.byRule[ruleName] = (report.byRule[ruleName] || 0) + 1;
        if (!report.examples[ruleName]) {
          report.examples[ruleName] = [];
        }
        if (report.examples[ruleName].length < 8 && normalizedText) {
          report.examples[ruleName].push(normalizedText);
        }
        continue;
      }
      if (!normalizedText) {
        continue;
      }
      keptSet.add(normalizedText);
    }

    const keptList = [...keptSet].sort((a, b) => a.localeCompare(b, "en"));
    cleaned[host] = keptList;
    report.byHost[host].kept = keptList.length;
    report.summary.cleanedTextCount += keptList.length;
  }

  return { cleaned, report };
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printUsage();
    return;
  }

  const inputPath = String(options.input || "").trim();
  const outputPath = String(options.output || "").trim();
  const reportPath = String(options.report || "").trim();
  const whitelistPath = options["whitelist-file"] ? String(options["whitelist-file"]) : "";

  if (!inputPath || !outputPath || !reportPath) {
    printUsage();
    throw new Error("缺少必填参数：--input / --output / --report");
  }

  const inputData = normalizeCollectedShape(readJsonFile(path.resolve(inputPath)));
  const whitelistSet = buildWhitelistSet(whitelistPath ? path.resolve(whitelistPath) : "");
  const { cleaned, report } = sanitizeCollected(inputData, whitelistSet);

  writeJsonFile(path.resolve(outputPath), cleaned);
  writeJsonFile(path.resolve(reportPath), report);

  console.log("[collector-sanitize] 完成");
  console.log("[collector-sanitize] 原始词条:", report.summary.rawTextCount);
  console.log("[collector-sanitize] 保留词条:", report.summary.cleanedTextCount);
  console.log("[collector-sanitize] 过滤词条:", report.summary.filteredTextCount);
  console.log("[collector-sanitize] 输出 cleaned:", path.resolve(outputPath));
  console.log("[collector-sanitize] 输出 report:", path.resolve(reportPath));
}

try {
  main();
} catch (error) {
  console.error("[collector-sanitize] 失败:", String(error?.message || error));
  process.exitCode = 1;
}

