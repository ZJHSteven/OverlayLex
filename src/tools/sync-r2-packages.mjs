#!/usr/bin/env node
/**
 * sync-r2-packages:
 * 将 src/packages 下可发布的 JSON 包同步到 Cloudflare R2。
 *
 * 设计说明（教学向）：
 * 1) 只上传“可发布包”：包含 translations（翻译包）或 rules（域名准入包）。
 * 2) 上传键统一为 packages/{filename}.json，和 Worker 读取策略一致。
 * 3) 脚本只负责上传对象，不改动仓库文件，不做 git 操作。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE);
const REPO_ROOT = path.resolve(CURRENT_DIR, "..", "..");

function logInfo(message, extra = "") {
  if (extra) {
    console.log(`[sync-r2] ${message} ${extra}`);
    return;
  }
  console.log(`[sync-r2] ${message}`);
}

function logError(message, extra = "") {
  if (extra) {
    console.error(`[sync-r2][ERROR] ${message} ${extra}`);
    return;
  }
  console.error(`[sync-r2][ERROR] ${message}`);
}

function printHelp() {
  console.log(`
用法：
  node src/tools/sync-r2-packages.mjs --bucket-name <name> [--packages-dir src/packages] [--worker-dir src/worker] [--local]

参数：
  --bucket-name   R2 桶名称（必填）
  --packages-dir  包目录，默认 src/packages
  --worker-dir    wrangler 工作目录，默认 src/worker
  --local         上传到本地 R2 模拟存储（默认上传远端，即追加 --remote）
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith("--")) {
      throw new Error(`无法解析参数：${key}`);
    }
    const name = key.slice(2);
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      options[name] = true;
      continue;
    }
    options[name] = value;
    i += 1;
  }
  return options;
}

function resolvePath(inputPath) {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  return path.resolve(REPO_ROOT, inputPath);
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function isPublishablePackage(jsonData) {
  if (!jsonData || typeof jsonData !== "object") {
    return false;
  }
  if (jsonData.translations && typeof jsonData.translations === "object") {
    return true;
  }
  if (Array.isArray(jsonData.rules)) {
    return true;
  }
  return false;
}

function getJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const files = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b, "en"));
  return files;
}

function runWranglerPut(workerDir, bucketName, objectKey, filePath, useRemote) {
  const target = `${bucketName}/${objectKey}`;
  const commandArgs = ["wrangler", "r2", "object", "put", target, "--file", filePath];
  if (useRemote) {
    commandArgs.push("--remote");
  }

  const result = spawnSync("npx", commandArgs, {
    cwd: workerDir,
    stdio: "inherit",
    // Windows 下通过 shell 解析可避免 npx.cmd 解析失败，Linux/macOS 下保持无 shell 以减少不确定性。
    shell: process.platform === "win32",
    env: process.env,
  });
  if (result.error) {
    throw new Error(`上传失败：${target}；原因：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`上传失败：${target}；退出码：${String(result.status)}`);
  }
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help || options.h) {
    printHelp();
    return;
  }

  const bucketName = String(options["bucket-name"] || "").trim();
  const packagesDir = resolvePath(String(options["packages-dir"] || "src/packages"));
  const workerDir = resolvePath(String(options["worker-dir"] || "src/worker"));
  const useRemote = !Boolean(options.local);

  if (!bucketName) {
    throw new Error("缺少 --bucket-name。");
  }
  if (!fs.existsSync(packagesDir)) {
    throw new Error(`包目录不存在：${packagesDir}`);
  }
  if (!fs.existsSync(workerDir)) {
    throw new Error(`worker 目录不存在：${workerDir}`);
  }

  const files = getJsonFiles(packagesDir);
  let uploadedCount = 0;
  let skippedCount = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    let jsonData = null;
    try {
      jsonData = readJsonFile(filePath);
    } catch (error) {
      skippedCount += 1;
      logError("JSON 解析失败，已跳过。", fileName);
      continue;
    }

    if (!isPublishablePackage(jsonData)) {
      skippedCount += 1;
      logInfo("非发布包，已跳过。", fileName);
      continue;
    }

    const objectKey = `packages/${fileName}`;
    runWranglerPut(workerDir, bucketName, objectKey, filePath, useRemote);
    uploadedCount += 1;
    logInfo("上传成功：", objectKey);
  }

  logInfo("同步完成。");
  logInfo("上传位置：", useRemote ? "remote（Cloudflare 线上 R2）" : "local（Wrangler 本地模拟）");
  logInfo("上传数量：", String(uploadedCount));
  logInfo("跳过数量：", String(skippedCount));
}

try {
  main();
} catch (error) {
  logError(error?.message || String(error));
  process.exit(1);
}
