#!/usr/bin/env node
/**
 * OverlayLex i18n 流程脚本（教学向）
 *
 * 设计目标：
 * 1) 把“采集 -> 本地包 -> Paratranz -> 回拉 -> 发版版本号”串成一条可重复执行的命令链。
 * 2) 所有命令都以“文件可审计、输出可解释”为优先，不在脚本中做 git add/commit。
 * 3) 默认采用安全策略：仅增量新增，不自动删词条，不自动判定“英文改写”。
 *
 * 支持命令：
 * - merge-collected
 * - to-paratranz
 * - from-paratranz
 * - pull-paratranz
 * - push-paratranz
 * - bump-release-version
 * - check-local-translation-policy
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ------------------------------
// 路径与默认配置
// ------------------------------

const CURRENT_FILE = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE);
const REPO_ROOT = path.resolve(CURRENT_DIR, "..", "..");
const DEFAULT_CONFIG_PATH = path.resolve(REPO_ROOT, "config", "overlaylex-i18n.config.json");

/**
 * DEFAULT_CONFIG:
 * - packagesDir: OverlayLex 包目录
 * - tempDir: 中间产物目录（默认 .tmp，不污染 src）
 * - paratranz: ParaTranz API 与路径约定
 * - merge: 采集合并策略
 * - conversion: 互转策略
 */
const DEFAULT_CONFIG = {
  packagesDir: "src/packages",
  tempDir: ".tmp/paratranz",
  paratranz: {
    apiBaseUrl: "https://paratranz.cn/api",
    projectId: "",
    filePathPrefix: "packages/",
    tokenEnv: "PARATRANZ_TOKEN",
  },
  merge: {
    newPackagePrefix: "obr-",
    defaultPathPrefix: "/",
  },
  conversion: {
    skipEmptyTranslationOnImport: true,
  },
};

// ------------------------------
// 控制台输出工具
// ------------------------------

function logInfo(message, extra = "") {
  if (extra) {
    console.log(`[OverlayLex i18n] ${message} ${extra}`);
    return;
  }
  console.log(`[OverlayLex i18n] ${message}`);
}

function logWarn(message, extra = "") {
  if (extra) {
    console.warn(`[OverlayLex i18n][WARN] ${message} ${extra}`);
    return;
  }
  console.warn(`[OverlayLex i18n][WARN] ${message}`);
}

function logError(message, extra = "") {
  if (extra) {
    console.error(`[OverlayLex i18n][ERROR] ${message} ${extra}`);
    return;
  }
  console.error(`[OverlayLex i18n][ERROR] ${message}`);
}

function printHelp() {
  console.log(`
用法：
  node src/tools/overlaylex-i18n-flow.mjs <command> [options]

命令：
  merge-collected       将临时采集 JSON 合并到本地包
  to-paratranz          将本地包导出为 Paratranz 数组格式
  from-paratranz        将 Paratranz 数组格式回写到本地包
  pull-paratranz        从 Paratranz 拉取文件翻译数据到本地目录
  push-paratranz        将本地包推送到 Paratranz（文件级）
  bump-release-version  对发版变更包执行 patch 版本自动递增
  check-local-translation-policy  校验 main 分支的本地译文改动策略

常用参数：
  --config <path>         指定配置文件，默认 config/overlaylex-i18n.config.json
  --input <path>          输入文件路径（merge-collected）
  --input-packages <dir>  输入包目录（to-paratranz）
  --input-dir <dir>       输入目录（from-paratranz）
  --out-dir <dir>         输出目录（to-paratranz / pull-paratranz）
  --project-id <id>       Paratranz 项目 ID（可覆盖配置）
  --base-ref <ref>        git 比较基线（push-paratranz / bump-release-version）
  --changed-only          仅处理变更包（push-paratranz）
  --write                 将版本递增写回文件（bump-release-version）
  --prune                 合并时删除临时文件未出现词条（默认关闭）
  --base-ref <ref>        git 比较基线（check-local-translation-policy）
`);
}

// ------------------------------
// 参数解析
// ------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || "";
  const options = {};

  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      throw new Error(`无法解析参数：${token}，请使用 --key value 或 --flag 形式。`);
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }

  return { command, options };
}

// ------------------------------
// 通用工具函数
// ------------------------------

function isAbsolutePath(inputPath) {
  return path.isAbsolute(inputPath);
}

function resolvePathFromRepo(inputPath) {
  if (!inputPath) {
    return "";
  }
  if (isAbsolutePath(inputPath)) {
    return inputPath;
  }
  return path.resolve(REPO_ROOT, inputPath);
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJsonFile(filePath) {
  const raw = readTextFile(filePath).replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function writeJsonFile(filePath, data) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function deepMerge(baseObj, overrideObj) {
  if (Array.isArray(baseObj) || Array.isArray(overrideObj)) {
    return overrideObj;
  }
  if (typeof baseObj !== "object" || baseObj === null) {
    return overrideObj;
  }
  if (typeof overrideObj !== "object" || overrideObj === null) {
    return overrideObj;
  }

  const result = { ...baseObj };
  for (const [key, overrideValue] of Object.entries(overrideObj)) {
    if (!(key in result)) {
      result[key] = overrideValue;
      continue;
    }
    result[key] = deepMerge(result[key], overrideValue);
  }
  return result;
}

function loadConfig(customConfigPath = "") {
  const resolvedPath = resolvePathFromRepo(customConfigPath || DEFAULT_CONFIG_PATH);
  if (!fs.existsSync(resolvedPath)) {
    logWarn("配置文件不存在，使用默认配置。", resolvedPath);
    return {
      ...DEFAULT_CONFIG,
      __configPath: resolvedPath,
    };
  }

  const parsed = readJsonFile(resolvedPath);
  const merged = deepMerge(DEFAULT_CONFIG, parsed);
  return {
    ...merged,
    __configPath: resolvedPath,
  };
}

function normalizeJsonFileName(filePath) {
  return path.basename(filePath).toLowerCase().endsWith(".json");
}

function getJsonFilesInDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = getJsonFilesInDirectory(absolute);
      files.push(...nestedFiles);
      continue;
    }
    if (entry.isFile() && normalizeJsonFileName(entry.name)) {
      files.push(absolute);
    }
  }
  files.sort((a, b) => a.localeCompare(b, "en"));
  return files;
}

function sortTranslationMap(translations) {
  const orderedKeys = Object.keys(translations).sort((a, b) => a.localeCompare(b, "en"));
  const next = {};
  for (const key of orderedKeys) {
    next[key] = translations[key];
  }
  return next;
}

function isTranslationPackage(packageData) {
  if (!packageData || typeof packageData !== "object") {
    return false;
  }
  if (!packageData.translations || typeof packageData.translations !== "object") {
    return false;
  }
  if (Array.isArray(packageData.rules)) {
    return false;
  }
  return true;
}

function getTargetHosts(target) {
  if (!target || typeof target !== "object") {
    return [];
  }
  const hosts = [];
  if (typeof target.host === "string" && target.host.trim()) {
    hosts.push(target.host.trim().toLowerCase());
  }
  if (Array.isArray(target.hosts)) {
    for (const hostItem of target.hosts) {
      const host = String(hostItem || "").trim().toLowerCase();
      if (host) {
        hosts.push(host);
      }
    }
  }
  return [...new Set(hosts)];
}

function getPrimaryHost(target) {
  const hosts = getTargetHosts(target);
  if (hosts.length > 0) {
    return hosts[0];
  }
  return "unknown-host";
}

function makePackageIdFromHost(hostname, prefix = "obr-") {
  const normalizedHost = String(hostname || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9.-]/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^-+|-+$/g, "");
  const dashed = normalizedHost.replace(/\./g, "-");
  return `${prefix}${dashed}`;
}

function sha1Hex(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function relativeToRepo(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).replace(/\\/g, "/");
}

function normalizeParatranzPathPrefix(prefix) {
  const cleaned = String(prefix || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!cleaned) {
    return "";
  }
  return `${cleaned}/`;
}

function runGitCommand(command) {
  const output = execSync(command, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return output.trim();
}

function tryRunGitCommand(command) {
  try {
    const output = runGitCommand(command);
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: "", error };
  }
}

function getChangedPackageFiles(packagesDir, baseRef) {
  const packageRelativeDir = relativeToRepo(packagesDir);
  const safeBaseRef = String(baseRef || "").trim();
  if (!safeBaseRef) {
    throw new Error("缺少 --base-ref，无法计算变更包列表。");
  }

  const diffOutput = runGitCommand(`git diff --name-only ${safeBaseRef}...HEAD -- ${packageRelativeDir}`);
  if (!diffOutput) {
    return [];
  }
  return diffOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => path.resolve(REPO_ROOT, line))
    .filter((absolutePath) => fs.existsSync(absolutePath) && normalizeJsonFileName(absolutePath));
}

function packageFileExistsInBaseRef(baseRef, packageFileAbsolutePath) {
  const relativePath = relativeToRepo(packageFileAbsolutePath);
  const result = tryRunGitCommand(`git cat-file -e ${baseRef}:${relativePath}`);
  return result.ok;
}

function readJsonFileFromGitRef(baseRef, fileAbsolutePath) {
  const relativePath = relativeToRepo(fileAbsolutePath);
  const raw = runGitCommand(`git show ${baseRef}:${relativePath}`).replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function parseSemver(versionString) {
  const matched = String(versionString || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!matched) {
    return null;
  }
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
  };
}

function bumpPatch(versionString) {
  const parsed = parseSemver(versionString);
  if (!parsed) {
    return null;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function loadTranslationPackageRecords(packagesDir) {
  const files = getJsonFilesInDirectory(packagesDir);
  const records = [];

  for (const filePath of files) {
    const data = readJsonFile(filePath);
    if (!isTranslationPackage(data)) {
      continue;
    }
    records.push({
      absolutePath: filePath,
      relativePath: relativeToRepo(filePath),
      fileName: path.basename(filePath),
      data,
      hosts: getTargetHosts(data.target),
    });
  }
  return records;
}

function createParatranzRowsFromPackage(packageData) {
  const translations = packageData.translations || {};
  const originalList = Object.keys(translations).sort((a, b) => a.localeCompare(b, "en"));
  const hosts = getTargetHosts(packageData.target);
  const hostForKey = getPrimaryHost(packageData.target);
  const contextString = [
    `packageId=${packageData.id || ""}`,
    `hosts=${hosts.join(",")}`,
    `pathPrefix=${packageData?.target?.pathPrefix || "/"}`,
  ].join("; ");

  const rows = [];
  for (const originalText of originalList) {
    const translationText = String(translations[originalText] ?? "");
    rows.push({
      key: `${hostForKey}::${sha1Hex(originalText)}`,
      original: originalText,
      translation: translationText,
      context: contextString,
    });
  }
  return rows;
}

function normalizeCollectedInput(rawData) {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    throw new Error("采集输入格式错误：应为 { host: [\"text1\", \"text2\"] } 结构。");
  }

  const normalized = {};
  for (const [hostKey, value] of Object.entries(rawData)) {
    const host = String(hostKey || "").trim().toLowerCase();
    if (!host) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new Error(`采集输入格式错误：域名 ${host} 对应值应为数组。`);
    }
    const unique = new Set();
    for (const item of value) {
      const text = String(item ?? "").trim();
      if (!text) {
        continue;
      }
      unique.add(text);
    }
    normalized[host] = [...unique].sort((a, b) => a.localeCompare(b, "en"));
  }

  return normalized;
}

function findMatchedPackageRecordByHost(hostname, packageRecords) {
  const targetHost = String(hostname || "").toLowerCase().trim();
  if (!targetHost) {
    return null;
  }
  for (const record of packageRecords) {
    if (record.hosts.includes(targetHost)) {
      return record;
    }
  }
  return null;
}

// ------------------------------
// ParaTranz API 请求封装
// ------------------------------

async function paratranzRequest({
  method,
  url,
  token,
  jsonBody = null,
  formData = null,
}) {
  const headers = {
    Authorization: `Bearer ${token}`,
  };
  const init = {
    method,
    headers,
  };

  if (jsonBody !== null) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(jsonBody);
  }

  if (formData !== null) {
    init.body = formData;
  }

  const response = await fetch(url, init);
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  let payload = null;

  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    const rawText = await response.text();
    payload = rawText;
  }

  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`ParaTranz API 调用失败: ${method} ${url}; HTTP ${response.status}; ${detail}`);
  }

  return {
    status: response.status,
    payload,
  };
}

function extractFileList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && Array.isArray(payload.results)) {
    return payload.results;
  }
  if (payload && Array.isArray(payload.items)) {
    return payload.items;
  }
  if (payload && Array.isArray(payload.data)) {
    return payload.data;
  }
  return [];
}

function buildFormDataForJsonFile(fileName, contentText, pathField = null) {
  const formData = new FormData();
  const blob = new Blob([contentText], { type: "application/json" });
  formData.append("file", blob, fileName);
  if (typeof pathField === "string") {
    formData.append("path", pathField);
  }
  return formData;
}

// ------------------------------
// 命令实现：merge-collected
// ------------------------------

function commandMergeCollected(config, options) {
  const inputPath = resolvePathFromRepo(options.input || "tmp/collector.selected.json");
  const packagesDir = resolvePathFromRepo(config.packagesDir);
  const allowPrune = Boolean(options.prune);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`采集输入文件不存在：${inputPath}`);
  }

  const collected = normalizeCollectedInput(readJsonFile(inputPath));
  const packageRecords = loadTranslationPackageRecords(packagesDir);

  let modifiedPackageCount = 0;
  let createdPackageCount = 0;
  let addedTextCount = 0;
  let prunedTextCount = 0;

  for (const [host, textList] of Object.entries(collected)) {
    let record = findMatchedPackageRecordByHost(host, packageRecords);
    if (!record) {
      const packageId = makePackageIdFromHost(host, config.merge.newPackagePrefix);
      const packageFileName = `${packageId}.json`;
      const packageAbsolutePath = path.join(packagesDir, packageFileName);
      const translations = {};
      for (const text of textList) {
        translations[text] = "";
      }
      const newPackage = {
        id: packageId,
        name: `OBR 自动翻译包 - ${host}`,
        target: {
          host,
          pathPrefix: config.merge.defaultPathPrefix || "/",
        },
        version: "0.1.0",
        translations: sortTranslationMap(translations),
      };
      writeJsonFile(packageAbsolutePath, newPackage);

      createdPackageCount += 1;
      addedTextCount += textList.length;

      record = {
        absolutePath: packageAbsolutePath,
        relativePath: relativeToRepo(packageAbsolutePath),
        fileName: packageFileName,
        data: newPackage,
        hosts: [host],
      };
      packageRecords.push(record);
      continue;
    }

    const packageData = record.data;
    const translations = packageData.translations || {};
    let localAddedCount = 0;

    for (const text of textList) {
      if (Object.prototype.hasOwnProperty.call(translations, text)) {
        continue;
      }
      translations[text] = "";
      localAddedCount += 1;
    }

    if (allowPrune) {
      const sourceSet = new Set(textList);
      for (const existingOriginal of Object.keys(translations)) {
        if (sourceSet.has(existingOriginal)) {
          continue;
        }
        delete translations[existingOriginal];
        prunedTextCount += 1;
      }
    }

    if (localAddedCount > 0 || (allowPrune && prunedTextCount > 0)) {
      packageData.translations = sortTranslationMap(translations);
      writeJsonFile(record.absolutePath, packageData);
      modifiedPackageCount += 1;
      addedTextCount += localAddedCount;
    }
  }

  logInfo("merge-collected 完成。");
  logInfo("新增包数量：", String(createdPackageCount));
  logInfo("更新包数量：", String(modifiedPackageCount));
  logInfo("新增词条数量：", String(addedTextCount));
  if (allowPrune) {
    logInfo("删除词条数量（prune）：", String(prunedTextCount));
  } else {
    logInfo("删除词条策略：", "默认关闭（未执行删除）。");
  }
}

// ------------------------------
// 命令实现：to-paratranz
// ------------------------------

function commandToParatranz(config, options) {
  const inputPackagesDir = resolvePathFromRepo(options["input-packages"] || config.packagesDir);
  const outputDir = resolvePathFromRepo(options["out-dir"] || config.tempDir);
  const pathPrefix = normalizeParatranzPathPrefix(config.paratranz.filePathPrefix);
  const packageRecords = loadTranslationPackageRecords(inputPackagesDir);

  let exportedFileCount = 0;
  for (const record of packageRecords) {
    const rows = createParatranzRowsFromPackage(record.data);
    const outPath = path.join(outputDir, pathPrefix, record.fileName);
    writeJsonFile(outPath, rows);
    exportedFileCount += 1;
  }

  logInfo("to-paratranz 完成。");
  logInfo("导出文件数量：", String(exportedFileCount));
  logInfo("输出目录：", outputDir);
}

// ------------------------------
// 命令实现：from-paratranz
// ------------------------------

function commandFromParatranz(config, options) {
  const inputDir = resolvePathFromRepo(options["input-dir"] || config.tempDir);
  const packagesDir = resolvePathFromRepo(config.packagesDir);
  const skipEmpty = config.conversion.skipEmptyTranslationOnImport !== false;
  const inputFiles = getJsonFilesInDirectory(inputDir);

  let updatedPackageCount = 0;
  let updatedRowCount = 0;
  let skippedFileCount = 0;

  for (const inputFile of inputFiles) {
    const fileName = path.basename(inputFile);
    const targetPackagePath = path.join(packagesDir, fileName);

    if (!fs.existsSync(targetPackagePath)) {
      skippedFileCount += 1;
      logWarn("输入文件未匹配到本地包，已跳过。", relativeToRepo(inputFile));
      continue;
    }

    const packageData = readJsonFile(targetPackagePath);
    if (!isTranslationPackage(packageData)) {
      skippedFileCount += 1;
      logWarn("目标文件不是翻译包，已跳过。", relativeToRepo(targetPackagePath));
      continue;
    }

    const rows = readJsonFile(inputFile);
    if (!Array.isArray(rows)) {
      skippedFileCount += 1;
      logWarn("Paratranz 输入格式非法（应为数组），已跳过。", relativeToRepo(inputFile));
      continue;
    }

    const translations = packageData.translations || {};
    let localUpdatedCount = 0;

    for (const row of rows) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const original = String(row.original ?? "").trim();
      if (!original) {
        continue;
      }
      const translation = String(row.translation ?? "");
      if (skipEmpty && !translation.trim()) {
        continue;
      }
      if (translations[original] === translation) {
        continue;
      }
      translations[original] = translation;
      localUpdatedCount += 1;
    }

    if (localUpdatedCount > 0) {
      packageData.translations = sortTranslationMap(translations);
      writeJsonFile(targetPackagePath, packageData);
      updatedPackageCount += 1;
      updatedRowCount += localUpdatedCount;
    }
  }

  logInfo("from-paratranz 完成。");
  logInfo("更新包数量：", String(updatedPackageCount));
  logInfo("更新词条数量：", String(updatedRowCount));
  logInfo("跳过文件数量：", String(skippedFileCount));
}

// ------------------------------
// 命令实现：pull-paratranz
// ------------------------------

async function commandPullParatranz(config, options) {
  const projectId = String(options["project-id"] || config.paratranz.projectId || "").trim();
  const outputDir = resolvePathFromRepo(options["out-dir"] || config.tempDir);
  const tokenEnvName = String(config.paratranz.tokenEnv || "PARATRANZ_TOKEN");
  const token = String(process.env[tokenEnvName] || "").trim();
  const baseUrl = String(config.paratranz.apiBaseUrl || "https://paratranz.cn/api").replace(/\/+$/, "");
  const prefix = normalizeParatranzPathPrefix(config.paratranz.filePathPrefix);

  if (!projectId) {
    throw new Error("pull-paratranz 缺少项目 ID，请使用 --project-id 或在配置文件中设置 paratranz.projectId。");
  }
  if (!token) {
    throw new Error(`pull-paratranz 缺少 Token，请设置环境变量 ${tokenEnvName}。`);
  }

  const listUrl = `${baseUrl}/projects/${encodeURIComponent(projectId)}/files`;
  const listResponse = await paratranzRequest({
    method: "GET",
    url: listUrl,
    token,
  });
  const remoteFiles = extractFileList(listResponse.payload);

  const selectedFiles = remoteFiles.filter((item) => {
    const fileName = String(item?.name || "");
    return fileName.startsWith(prefix) && fileName.toLowerCase().endsWith(".json");
  });

  let downloadedCount = 0;
  for (const remoteFile of selectedFiles) {
    const fileId = remoteFile?.id;
    const fileName = String(remoteFile?.name || "");
    if (!fileId || !fileName) {
      continue;
    }
    const translationUrl = `${baseUrl}/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/translation`;
    const translationResponse = await paratranzRequest({
      method: "GET",
      url: translationUrl,
      token,
    });
    const payload = translationResponse.payload;
    const outputPath = path.join(outputDir, fileName);

    if (typeof payload === "string") {
      // 某些接口在未设置正确格式时可能返回文本，这里直接落盘，后续由 from-paratranz 判定。
      ensureDirectory(path.dirname(outputPath));
      fs.writeFileSync(outputPath, payload, "utf8");
    } else {
      writeJsonFile(outputPath, payload);
    }
    downloadedCount += 1;
  }

  logInfo("pull-paratranz 完成。");
  logInfo("下载文件数量：", String(downloadedCount));
  logInfo("输出目录：", outputDir);
}

// ------------------------------
// 命令实现：push-paratranz
// ------------------------------

async function commandPushParatranz(config, options) {
  const projectId = String(options["project-id"] || config.paratranz.projectId || "").trim();
  const tokenEnvName = String(config.paratranz.tokenEnv || "PARATRANZ_TOKEN");
  const token = String(process.env[tokenEnvName] || "").trim();
  const baseUrl = String(config.paratranz.apiBaseUrl || "https://paratranz.cn/api").replace(/\/+$/, "");
  const packagesDir = resolvePathFromRepo(config.packagesDir);
  const changedOnly = Boolean(options["changed-only"]);
  const baseRef = String(options["base-ref"] || "").trim();
  const pathPrefix = normalizeParatranzPathPrefix(config.paratranz.filePathPrefix);

  if (!projectId) {
    throw new Error("push-paratranz 缺少项目 ID，请使用 --project-id 或在配置文件中设置 paratranz.projectId。");
  }
  if (!token) {
    throw new Error(`push-paratranz 缺少 Token，请设置环境变量 ${tokenEnvName}。`);
  }

  const allRecords = loadTranslationPackageRecords(packagesDir);
  let targetRecords = allRecords;

  if (changedOnly) {
    if (!baseRef) {
      throw new Error("push-paratranz 使用 --changed-only 时必须提供 --base-ref。");
    }
    const changedFiles = new Set(getChangedPackageFiles(packagesDir, baseRef).map((filePath) => path.resolve(filePath)));
    targetRecords = allRecords.filter((record) => changedFiles.has(path.resolve(record.absolutePath)));
  }

  if (targetRecords.length === 0) {
    logInfo("push-paratranz 无需执行：当前没有待同步翻译包。");
    return;
  }

  const listUrl = `${baseUrl}/projects/${encodeURIComponent(projectId)}/files`;
  const listResponse = await paratranzRequest({
    method: "GET",
    url: listUrl,
    token,
  });
  const remoteFiles = extractFileList(listResponse.payload);
  const remoteFileMap = new Map();
  for (const fileItem of remoteFiles) {
    const name = String(fileItem?.name || "");
    const id = fileItem?.id;
    if (!name || !id) {
      continue;
    }
    remoteFileMap.set(name, id);
  }

  let createdCount = 0;
  let updatedCount = 0;

  for (const record of targetRecords) {
    const rows = createParatranzRowsFromPackage(record.data);
    const payloadText = `${JSON.stringify(rows, null, 2)}\n`;
    const remotePath = `${pathPrefix}${record.fileName}`;
    const existingFileId = remoteFileMap.get(remotePath);

    if (existingFileId) {
      const formData = buildFormDataForJsonFile(record.fileName, payloadText, null);
      const updateUrl = `${baseUrl}/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(existingFileId)}`;
      await paratranzRequest({
        method: "POST",
        url: updateUrl,
        token,
        formData,
      });
      updatedCount += 1;
      logInfo("已更新 Paratranz 文件：", remotePath);
      continue;
    }

    const directoryPath = pathPrefix || "";
    const formData = buildFormDataForJsonFile(record.fileName, payloadText, directoryPath);
    const createUrl = `${baseUrl}/projects/${encodeURIComponent(projectId)}/files`;
    await paratranzRequest({
      method: "POST",
      url: createUrl,
      token,
      formData,
    });
    createdCount += 1;
    logInfo("已创建 Paratranz 文件：", remotePath);
  }

  logInfo("push-paratranz 完成。");
  logInfo("创建文件数量：", String(createdCount));
  logInfo("更新文件数量：", String(updatedCount));
}

// ------------------------------
// 命令实现：bump-release-version
// ------------------------------

function commandBumpReleaseVersion(config, options) {
  const packagesDir = resolvePathFromRepo(config.packagesDir);
  const baseRef = String(options["base-ref"] || "").trim();
  const writeEnabled = Boolean(options.write);

  if (!baseRef) {
    throw new Error("bump-release-version 缺少 --base-ref。");
  }

  const changedFiles = getChangedPackageFiles(packagesDir, baseRef);
  if (changedFiles.length === 0) {
    logInfo("bump-release-version 无需执行：未检测到包文件改动。");
    return;
  }

  let bumpedCount = 0;
  for (const packageFilePath of changedFiles) {
    const packageData = readJsonFile(packageFilePath);
    const currentVersion = packageData?.version;
    if (typeof currentVersion !== "string" || !currentVersion.trim()) {
      continue;
    }

    const existedInBase = packageFileExistsInBaseRef(baseRef, packageFilePath);
    if (!existedInBase) {
      logInfo("新包首发不自动递增版本：", relativeToRepo(packageFilePath));
      continue;
    }

    const nextVersion = bumpPatch(currentVersion);
    if (!nextVersion) {
      logWarn("版本号非 semver（x.y.z），已跳过：", `${relativeToRepo(packageFilePath)} -> ${currentVersion}`);
      continue;
    }

    logInfo(
      "版本递增预览：",
      `${relativeToRepo(packageFilePath)} ${currentVersion} -> ${nextVersion}`
    );

    if (writeEnabled) {
      packageData.version = nextVersion;
      writeJsonFile(packageFilePath, packageData);
      bumpedCount += 1;
    }
  }

  if (writeEnabled) {
    logInfo("bump-release-version 写入完成。");
    logInfo("实际递增文件数量：", String(bumpedCount));
  } else {
    logInfo("bump-release-version 预览完成（未写入）。");
  }
}

// ------------------------------
// 命令实现：check-local-translation-policy
// ------------------------------

function commandCheckLocalTranslationPolicy(config, options) {
  const packagesDir = resolvePathFromRepo(config.packagesDir);
  const baseRef = String(options["base-ref"] || "").trim();
  if (!baseRef) {
    throw new Error("check-local-translation-policy 缺少 --base-ref。");
  }

  const changedFiles = getChangedPackageFiles(packagesDir, baseRef);
  if (changedFiles.length === 0) {
    logInfo("check-local-translation-policy 无需执行：未检测到包文件改动。");
    return;
  }

  const violations = [];

  for (const packageFilePath of changedFiles) {
    const currentData = readJsonFile(packageFilePath);
    if (!isTranslationPackage(currentData)) {
      continue;
    }

    const existedInBase = packageFileExistsInBaseRef(baseRef, packageFilePath);
    if (!existedInBase) {
      // 新包中的词条允许预翻译（translation 可为空或非空）。
      continue;
    }

    const baseData = readJsonFileFromGitRef(baseRef, packageFilePath);
    if (!isTranslationPackage(baseData)) {
      continue;
    }

    const currentTranslations = currentData.translations || {};
    const baseTranslations = baseData.translations || {};

    for (const [originalText, currentTranslation] of Object.entries(currentTranslations)) {
      if (!Object.prototype.hasOwnProperty.call(baseTranslations, originalText)) {
        // 新增 original 允许 translation 非空（支持 AI 预翻译）。
        continue;
      }
      const baseTranslation = String(baseTranslations[originalText] ?? "");
      const nextTranslation = String(currentTranslation ?? "");
      if (baseTranslation === nextTranslation) {
        continue;
      }
      violations.push({
        file: relativeToRepo(packageFilePath),
        original: originalText,
        before: baseTranslation,
        after: nextTranslation,
      });
    }
  }

  if (violations.length === 0) {
    logInfo("check-local-translation-policy 通过：未发现违规译文改动。");
    return;
  }

  logError("发现不允许的本地译文改动（仅允许新增 original 的预翻译）。");
  for (const item of violations) {
    logError(
      `违规词条：${item.file} | original=${JSON.stringify(item.original)} | before=${JSON.stringify(item.before)} | after=${JSON.stringify(item.after)}`
    );
  }
  throw new Error(`校验失败：共 ${violations.length} 处违规译文改动。`);
}

// ------------------------------
// 程序入口
// ------------------------------

async function main() {
  const { command, options } = parseArgs(process.argv);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const config = loadConfig(options.config);

  switch (command) {
    case "merge-collected":
      commandMergeCollected(config, options);
      return;
    case "to-paratranz":
      commandToParatranz(config, options);
      return;
    case "from-paratranz":
      commandFromParatranz(config, options);
      return;
    case "pull-paratranz":
      await commandPullParatranz(config, options);
      return;
    case "push-paratranz":
      await commandPushParatranz(config, options);
      return;
    case "bump-release-version":
      commandBumpReleaseVersion(config, options);
      return;
    case "check-local-translation-policy":
      commandCheckLocalTranslationPolicy(config, options);
      return;
    default:
      throw new Error(`未知命令：${command}。请先执行 help 查看支持命令。`);
  }
}

main().catch((error) => {
  logError("执行失败：", error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
