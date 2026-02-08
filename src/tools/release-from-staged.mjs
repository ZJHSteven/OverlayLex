#!/usr/bin/env node
/**
 * release-from-staged（教学向）
 *
 * 目标：
 * 1) 让“发布哪些包”完全由 Git 暂存区决定，避免再维护额外白名单。
 * 2) 发布前自动补齐元数据：
 *    - 自动递增已暂存发布包的 version（patch +1）
 *    - 自动维护域名准入包（overlaylex-domain-allowlist）
 *    - 自动同步 Worker 的 PACKAGE_CATALOG 版本与目录项
 * 3) 一条命令完成 main -> release：
 *    - 在 main 提交
 *    - cherry-pick 到 release
 *    - push release 触发发布 CI
 *
 * 命令：
 * - prepare-from-staged（默认）: 本地交互式发布命令
 * - verify-release: CI 专用校验（非交互）
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE);
const REPO_ROOT = path.resolve(CURRENT_DIR, "..", "..");
const PACKAGES_DIR = path.resolve(REPO_ROOT, "src", "packages");
const WORKER_DATA_PATH = path.resolve(REPO_ROOT, "src", "worker", "src", "data.js");
const DOMAIN_ALLOWLIST_PATH = path.resolve(PACKAGES_DIR, "overlaylex-domain-allowlist.json");
const DEFAULT_API_URL = "https://overlaylex-demo-api.zhangjiahe0830.workers.dev";
const AUTO_RULE_COMMENT = "自动同步包域名";
const ALLOWED_AUTO_STAGE_FILES = new Set(["src/worker/src/data.js"]);

function logInfo(message, extra = "") {
  if (extra) {
    console.log(`[release-flow] ${message} ${extra}`);
    return;
  }
  console.log(`[release-flow] ${message}`);
}

function logWarn(message, extra = "") {
  if (extra) {
    console.warn(`[release-flow][WARN] ${message} ${extra}`);
    return;
  }
  console.warn(`[release-flow][WARN] ${message}`);
}

function logError(message, extra = "") {
  if (extra) {
    console.error(`[release-flow][ERROR] ${message} ${extra}`);
    return;
  }
  console.error(`[release-flow][ERROR] ${message}`);
}

function printHelp() {
  console.log(`
用法：
  node src/tools/release-from-staged.mjs [command] [options]

命令：
  prepare-from-staged    按“当前暂存区包文件”执行本地一键发布（默认）
  verify-release         CI 校验：校验版本、allowlist 与 worker catalog 一致性

参数：
  --base-ref <ref>       CI 校验基线（verify-release 必填）
  --api-url <url>        线上 API 地址（默认 ${DEFAULT_API_URL}）
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "prepare-from-staged";
  const options = {};
  const startIndex = command === "prepare-from-staged" && args[0] !== "prepare-from-staged" ? 0 : 1;
  for (let i = startIndex; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      throw new Error(`无法解析参数：${token}`);
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

function runGit(args, { allowFailure = false, stdio = "pipe" } = {}) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio,
    shell: process.platform === "win32",
    env: process.env,
  });
  if (allowFailure) {
    return result;
  }
  if (result.error) {
    throw new Error(`git ${args.join(" ")} 执行失败：${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败（exit=${String(result.status)}）：${(result.stderr || "").trim()}`);
  }
  return result;
}

function runGitText(args) {
  const result = runGit(args);
  return String(result.stdout || "").trim();
}

function tryRunGitText(args) {
  const result = runGit(args, { allowFailure: true });
  if (result.error || result.status !== 0) {
    return { ok: false, output: "", error: result.error || new Error((result.stderr || "").trim()) };
  }
  return { ok: true, output: String(result.stdout || "").trim() };
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isJsonFile(relativePath) {
  return relativePath.toLowerCase().endsWith(".json");
}

function isPackagePath(relativePath) {
  return relativePath.startsWith("src/packages/") && isJsonFile(relativePath);
}

function isPublishablePackage(packageData) {
  if (!packageData || typeof packageData !== "object") {
    return false;
  }
  if (packageData.translations && typeof packageData.translations === "object") {
    return true;
  }
  if (Array.isArray(packageData.rules)) {
    return true;
  }
  return false;
}

function isTranslationPackage(packageData) {
  return Boolean(
    packageData &&
      typeof packageData === "object" &&
      packageData.translations &&
      typeof packageData.translations === "object" &&
      !Array.isArray(packageData.rules)
  );
}

function getPackageIdFromFile(filePath, packageData) {
  if (typeof packageData?.id === "string" && packageData.id.trim()) {
    return packageData.id.trim();
  }
  return path.basename(filePath, ".json");
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

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return null;
  }
  if (pa.major !== pb.major) {
    return pa.major > pb.major ? 1 : -1;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor > pb.minor ? 1 : -1;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch > pb.patch ? 1 : -1;
  }
  return 0;
}

function bumpPatch(versionString) {
  const parsed = parseSemver(versionString);
  if (!parsed) {
    return null;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
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

function readAllPublishablePackages() {
  const files = fs
    .readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.resolve(PACKAGES_DIR, entry.name))
    .sort((a, b) => a.localeCompare(b, "en"));

  const records = [];
  for (const filePath of files) {
    const data = readJsonFile(filePath);
    if (!isPublishablePackage(data)) {
      continue;
    }
    const id = getPackageIdFromFile(filePath, data);
    records.push({
      id,
      filePath,
      relativePath: path.relative(REPO_ROOT, filePath).replace(/\\/g, "/"),
      data,
      kind: isTranslationPackage(data) ? "translation" : "domain-allowlist",
      hosts: isTranslationPackage(data) ? getTargetHosts(data.target) : [],
    });
  }
  return records;
}

function promptYes(questionText) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return rl
    .question(`${questionText}\n输入 yes 并回车继续：`)
    .then((answer) => {
      rl.close();
      return String(answer || "").trim().toLowerCase() === "yes";
    })
    .catch((error) => {
      rl.close();
      throw error;
    });
}

function getStagedFiles() {
  const output = runGitText(["diff", "--cached", "--name-only"]);
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getUnstagedFiles() {
  const output = runGitText(["diff", "--name-only"]);
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getUntrackedFiles() {
  const output = runGitText(["ls-files", "--others", "--exclude-standard"]);
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getCurrentBranch() {
  return runGitText(["rev-parse", "--abbrev-ref", "HEAD"]);
}

function ensureCleanForPrepare(stagedFiles) {
  const unstaged = getUnstagedFiles();
  if (unstaged.length > 0) {
    throw new Error(`存在未暂存改动，请先整理工作区：${unstaged.join(", ")}`);
  }
  const untracked = getUntrackedFiles();
  if (untracked.length > 0) {
    throw new Error(`存在未跟踪文件，请先清理或纳入版本控制：${untracked.join(", ")}`);
  }
  if (stagedFiles.length === 0) {
    throw new Error("暂存区为空。请先在 UI 或命令行中暂存要发布的包文件。");
  }
}

function validateStagedPackageFiles(stagedFiles) {
  const invalid = stagedFiles.filter((item) => !isPackagePath(item));
  if (invalid.length > 0) {
    throw new Error(`暂存区只允许包含 src/packages/*.json，发现非法文件：${invalid.join(", ")}`);
  }

  const records = [];
  for (const relativePath of stagedFiles) {
    const absolutePath = path.resolve(REPO_ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`不允许发布删除文件，请先恢复或移除该暂存项：${relativePath}`);
    }
    const packageData = readJsonFile(absolutePath);
    if (!isPublishablePackage(packageData)) {
      throw new Error(`暂存文件不是可发布包（需包含 translations 或 rules）：${relativePath}`);
    }
    records.push({
      relativePath,
      absolutePath,
      data: packageData,
      id: getPackageIdFromFile(absolutePath, packageData),
      kind: isTranslationPackage(packageData) ? "translation" : "domain-allowlist",
    });
  }

  const translationCount = records.filter((item) => item.kind === "translation").length;
  if (translationCount === 0) {
    throw new Error("暂存区没有翻译包（translation），无法执行发布。");
  }
  return records;
}

function validateFinalStagedFiles(stagedFiles) {
  const invalid = stagedFiles.filter((item) => !isPackagePath(item) && !ALLOWED_AUTO_STAGE_FILES.has(item));
  if (invalid.length > 0) {
    throw new Error(`最终暂存区存在非法文件（仅允许包文件与自动元数据文件）：${invalid.join(", ")}`);
  }

  const packageFiles = stagedFiles.filter((item) => isPackagePath(item));
  const packageRecords = validateStagedPackageFiles(packageFiles);
  return {
    packageFiles,
    packageRecords,
    metadataFiles: stagedFiles.filter((item) => ALLOWED_AUTO_STAGE_FILES.has(item)),
  };
}

function isRuleCoveringHost(rule, host) {
  if (!rule || typeof rule !== "object") {
    return false;
  }
  const type = String(rule.type || "").trim().toLowerCase();
  const value = String(rule.value || "").trim().toLowerCase();
  const normalizedHost = String(host || "").trim().toLowerCase();
  if (!type || !value || !normalizedHost) {
    return false;
  }
  if (type === "exact") {
    return value === normalizedHost;
  }
  if (type === "suffix") {
    if (!value.startsWith(".")) {
      return normalizedHost === value || normalizedHost.endsWith(`.${value}`);
    }
    const noDot = value.slice(1);
    return normalizedHost === noDot || normalizedHost.endsWith(value);
  }
  return false;
}

function syncDomainAllowlistWithPackages(allRecords) {
  const allowlist = readJsonFile(DOMAIN_ALLOWLIST_PATH);
  if (!Array.isArray(allowlist.rules)) {
    throw new Error("overlaylex-domain-allowlist.json 的 rules 字段不是数组。");
  }

  // 保留人工维护的规则；自动规则由本脚本重建，避免历史脏规则长期累积。
  const manualRules = allowlist.rules.filter((rule) => String(rule?.comment || "") !== AUTO_RULE_COMMENT);

  const hostOwnerMap = new Map();
  for (const record of allRecords) {
    if (record.kind !== "translation") {
      continue;
    }
    for (const host of record.hosts) {
      if (!hostOwnerMap.has(host)) {
        hostOwnerMap.set(host, record.id);
      }
    }
  }

  const uncoveredHosts = [...hostOwnerMap.keys()]
    .sort((a, b) => a.localeCompare(b, "en"))
    .filter((host) => !manualRules.some((rule) => isRuleCoveringHost(rule, host)));

  const autoRules = uncoveredHosts.map((host) => {
    const ownerId = hostOwnerMap.get(host) || "unknown";
    return {
      type: "exact",
      value: host,
      comment: AUTO_RULE_COMMENT,
      source: ownerId,
    };
  });

  const nextRules = [...manualRules, ...autoRules];
  const changedByRules = JSON.stringify(nextRules) !== JSON.stringify(allowlist.rules);
  let versionChanged = false;

  if (changedByRules) {
    const currentVersion = String(allowlist.version || "").trim();
    const nextVersion = bumpPatch(currentVersion);
    if (!nextVersion) {
      throw new Error(`域名准入包 version 不是 semver：${currentVersion}`);
    }
    allowlist.rules = nextRules;
    allowlist.version = nextVersion;
    versionChanged = true;
    writeJsonFile(DOMAIN_ALLOWLIST_PATH, allowlist);
  }

  return {
    changed: changedByRules,
    versionChanged,
    filePath: DOMAIN_ALLOWLIST_PATH,
    uncoveredHosts,
  };
}

function scanObjectLiteralRange(content, exportName) {
  const marker = `export const ${exportName} =`;
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`未找到导出变量：${exportName}`);
  }
  const startBrace = content.indexOf("{", markerIndex);
  if (startBrace < 0) {
    throw new Error(`未找到 ${exportName} 的对象字面量起始位置。`);
  }

  let depth = 0;
  let inString = false;
  let quote = "";
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = startBrace; i < content.length; i += 1) {
    const char = content[i];
    const nextChar = content[i + 1] || "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && nextChar === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === "/" && nextChar === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && nextChar === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start: startBrace, end: i };
      }
      continue;
    }
  }

  throw new Error(`无法解析 ${exportName} 的对象字面量结束位置。`);
}

function parseExportObject(content, exportName) {
  const range = scanObjectLiteralRange(content, exportName);
  const literal = content.slice(range.start, range.end + 1);
  let value = null;
  try {
    value = Function(`"use strict"; return (${literal});`)();
  } catch (error) {
    throw new Error(`解析 ${exportName} 对象失败：${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${exportName} 不是对象。`);
  }
  return {
    value,
    range,
  };
}

function replaceExportObject(content, exportName, nextObject) {
  const parsed = parseExportObject(content, exportName);
  const nextLiteral = JSON.stringify(nextObject, null, 2);
  return `${content.slice(0, parsed.range.start)}${nextLiteral}${content.slice(parsed.range.end + 1)}`;
}

function buildDefaultDescription(kind, packageData) {
  if (kind === "domain-allowlist") {
    return "控制脚本允许在哪些域名继续执行";
  }
  const name = String(packageData?.name || "").trim();
  if (name) {
    return `${name}（自动同步）`;
  }
  return "自动同步翻译包";
}

function syncWorkerCatalogWithPackages(allRecords) {
  const workerText = fs.readFileSync(WORKER_DATA_PATH, "utf8");
  const parsedCatalog = parseExportObject(workerText, "PACKAGE_CATALOG");
  const existingCatalog = parsedCatalog.value;

  const sortedRecords = [...allRecords].sort((a, b) => a.id.localeCompare(b.id, "en"));
  const nextCatalog = {};
  for (const record of sortedRecords) {
    const existing = existingCatalog[record.id] || {};
    const kind = record.kind;
    nextCatalog[record.id] = {
      id: record.id,
      name: String(existing.name || record.data.name || record.id),
      kind,
      version: String(record.data.version || existing.version || "0.1.0"),
      enabledByDefault:
        typeof existing.enabledByDefault === "boolean" ? existing.enabledByDefault : true,
      description: String(existing.description || buildDefaultDescription(kind, record.data)),
    };
  }

  let nextText = replaceExportObject(workerText, "PACKAGE_CATALOG", nextCatalog);

  // 回退包也保持域名准入包 version/rules 同步，避免 R2 异常时出现陈旧规则。
  const parsedFallback = parseExportObject(nextText, "BUILTIN_PACKAGE_FALLBACKS");
  const nextFallback = { ...parsedFallback.value };
  const allowlistPackage = allRecords.find((item) => item.id === "overlaylex-domain-allowlist");
  if (allowlistPackage && nextFallback["overlaylex-domain-allowlist"]) {
    nextFallback["overlaylex-domain-allowlist"] = {
      ...nextFallback["overlaylex-domain-allowlist"],
      version: String(allowlistPackage.data.version || "0.1.0"),
      rules: Array.isArray(allowlistPackage.data.rules)
        ? allowlistPackage.data.rules
        : nextFallback["overlaylex-domain-allowlist"].rules,
    };
  }
  nextText = replaceExportObject(nextText, "BUILTIN_PACKAGE_FALLBACKS", nextFallback);

  const changed = nextText !== workerText;
  if (changed) {
    fs.writeFileSync(WORKER_DATA_PATH, nextText, "utf8");
  }
  return {
    changed,
    filePath: WORKER_DATA_PATH,
  };
}

function bumpVersionsForStagedPackages(stagedRecords) {
  const bumps = [];
  for (const record of stagedRecords) {
    // 域名准入包由“同步逻辑”统一管理版本，避免同一轮改动重复 bump。
    if (record.id === "overlaylex-domain-allowlist") {
      continue;
    }

    const currentVersion = String(record.data.version || "").trim();
    const nextVersion = bumpPatch(currentVersion);
    if (!nextVersion) {
      throw new Error(`包 version 不是 semver（x.y.z）：${record.relativePath} -> ${currentVersion}`);
    }
    if (nextVersion === currentVersion) {
      continue;
    }

    const nextData = {
      ...record.data,
      version: nextVersion,
    };
    writeJsonFile(record.absolutePath, nextData);
    record.data = nextData;
    bumps.push({
      id: record.id,
      relativePath: record.relativePath,
      from: currentVersion,
      to: nextVersion,
    });
  }
  return bumps;
}

function getChangedPackageFilesByBaseRef(baseRef) {
  const packageRelativeDir = path.relative(REPO_ROOT, PACKAGES_DIR).replace(/\\/g, "/");
  const output = runGitText(["diff", "--name-only", `${baseRef}...HEAD`, "--", packageRelativeDir]);
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => isPackagePath(line))
    .filter((line) => fs.existsSync(path.resolve(REPO_ROOT, line)));
}

function assertAllowlistCoverage(allRecords) {
  const allowlistRecord = allRecords.find((item) => item.id === "overlaylex-domain-allowlist");
  if (!allowlistRecord) {
    throw new Error("缺少 overlaylex-domain-allowlist 包。");
  }
  const rules = Array.isArray(allowlistRecord.data.rules) ? allowlistRecord.data.rules : [];
  const missingHosts = [];

  for (const record of allRecords) {
    if (record.kind !== "translation") {
      continue;
    }
    for (const host of record.hosts) {
      const covered = rules.some((rule) => isRuleCoveringHost(rule, host));
      if (!covered) {
        missingHosts.push(`${host}(${record.id})`);
      }
    }
  }

  if (missingHosts.length > 0) {
    throw new Error(`域名准入包未覆盖以下 host：${missingHosts.join(", ")}`);
  }
}

function assertWorkerCatalogConsistency(allRecords) {
  const workerText = fs.readFileSync(WORKER_DATA_PATH, "utf8");
  const parsedCatalog = parseExportObject(workerText, "PACKAGE_CATALOG");
  const catalog = parsedCatalog.value;
  const errors = [];

  for (const record of allRecords) {
    const item = catalog[record.id];
    if (!item) {
      errors.push(`PACKAGE_CATALOG 缺少包：${record.id}`);
      continue;
    }
    const catalogVersion = String(item.version || "");
    const packageVersion = String(record.data.version || "");
    if (catalogVersion !== packageVersion) {
      errors.push(`PACKAGE_CATALOG 版本不一致：${record.id} catalog=${catalogVersion} package=${packageVersion}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
}

async function assertChangedPackageVersionGreaterThanRemote(changedFiles, apiUrl) {
  if (changedFiles.length === 0) {
    return;
  }

  const manifestUrl = `${String(apiUrl || DEFAULT_API_URL).replace(/\/+$/, "")}/manifest`;
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`拉取线上 manifest 失败：HTTP ${response.status}`);
  }
  const manifest = await response.json();
  const remoteVersionMap = new Map();

  if (manifest && Array.isArray(manifest.packages)) {
    for (const pkg of manifest.packages) {
      const id = String(pkg?.id || "").trim();
      const version = String(pkg?.version || "").trim();
      if (id && version) {
        remoteVersionMap.set(id, version);
      }
    }
  }
  if (manifest?.domainPackage?.id && manifest?.domainPackage?.version) {
    remoteVersionMap.set(String(manifest.domainPackage.id), String(manifest.domainPackage.version));
  }

  const errors = [];
  for (const relativePath of changedFiles) {
    const absolutePath = path.resolve(REPO_ROOT, relativePath);
    const packageData = readJsonFile(absolutePath);
    if (!isPublishablePackage(packageData)) {
      continue;
    }
    const packageId = getPackageIdFromFile(absolutePath, packageData);
    const localVersion = String(packageData.version || "").trim();
    const remoteVersion = remoteVersionMap.get(packageId);
    if (!remoteVersion) {
      // 新包在远端 manifest 不存在，允许首次发布。
      continue;
    }
    const compared = compareSemver(localVersion, remoteVersion);
    if (compared === null) {
      errors.push(`版本格式非法：${packageId} local=${localVersion} remote=${remoteVersion}`);
      continue;
    }
    if (compared <= 0) {
      errors.push(`版本未提升：${packageId} local=${localVersion} remote=${remoteVersion}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`版本校验失败（需大于远端线上版本）：${errors.join(" | ")}`);
  }
}

function ensureReleaseBranchAndSwitch() {
  const localRelease = tryRunGitText(["show-ref", "--verify", "--quiet", "refs/heads/release"]);
  if (localRelease.ok) {
    runGit(["switch", "release"], { stdio: "inherit" });
    return;
  }

  const remoteRelease = tryRunGitText(["show-ref", "--verify", "--quiet", "refs/remotes/origin/release"]);
  if (remoteRelease.ok) {
    runGit(["switch", "-c", "release", "--track", "origin/release"], { stdio: "inherit" });
    return;
  }

  runGit(["switch", "-c", "release"], { stdio: "inherit" });
}

function buildReleaseCommitMessage(changedPackageIds) {
  const shortNames = changedPackageIds
    .map((id) => {
      if (!id.startsWith("obr-")) {
        return id;
      }
      const tail = id.slice(4);
      const token = tail.split("-")[0];
      return token || tail;
    })
    .filter(Boolean);

  const uniqueShortNames = [...new Set(shortNames)];
  const preview = uniqueShortNames.slice(0, 6);
  const suffix = uniqueShortNames.length > 6 ? ",..." : "";
  return `chore(release): publish ${preview.join(",")}${suffix}`;
}

async function commandPrepareFromStaged() {
  const currentBranch = getCurrentBranch();
  if (currentBranch !== "main") {
    throw new Error(`请在 main 分支执行该命令，当前分支：${currentBranch}`);
  }

  const stagedFiles = getStagedFiles();
  ensureCleanForPrepare(stagedFiles);
  const stagedRecords = validateStagedPackageFiles(stagedFiles);

  logInfo("检测到以下暂存包文件：");
  for (const file of stagedFiles) {
    console.log(`  - ${file}`);
  }

  const confirmedRound1 = await promptYes("第一次确认：以上暂存文件将作为发布输入。");
  if (!confirmedRound1) {
    logWarn("你取消了本次发布准备。");
    return;
  }

  const bumpedPackages = bumpVersionsForStagedPackages(stagedRecords);
  let allRecords = readAllPublishablePackages();
  const allowlistResult = syncDomainAllowlistWithPackages(allRecords);
  allRecords = readAllPublishablePackages();
  const workerCatalogResult = syncWorkerCatalogWithPackages(allRecords);

  // 把脚本自动修改的文件重新加入暂存区，确保 commit 与校验对象一致。
  runGit(["add", "src/packages", "src/worker/src/data.js"], { stdio: "inherit" });
  const finalStagedFiles = getStagedFiles();
  const finalStaged = validateFinalStagedFiles(finalStagedFiles);

  // 发布前的最后校验：
  // 1) 域名准入规则覆盖所有翻译包 host
  // 2) Worker catalog 与包版本一致
  // 3) 即将发布的包 version 必须高于线上版本
  const latestAllRecords = readAllPublishablePackages();
  assertAllowlistCoverage(latestAllRecords);
  assertWorkerCatalogConsistency(latestAllRecords);
  await assertChangedPackageVersionGreaterThanRemote(finalStaged.packageFiles, DEFAULT_API_URL);

  logInfo("自动处理结果：");
  if (bumpedPackages.length === 0) {
    logInfo("  - 本轮无翻译包版本递增（可能只改了域名包）。");
  } else {
    for (const item of bumpedPackages) {
      logInfo("  - 版本递增：", `${item.id} ${item.from} -> ${item.to}`);
    }
  }
  if (allowlistResult.changed) {
    logInfo("  - 已更新域名准入包：", "overlaylex-domain-allowlist");
  } else {
    logInfo("  - 域名准入包无需变更。");
  }
  if (workerCatalogResult.changed) {
    logInfo("  - 已同步 Worker PACKAGE_CATALOG。");
  } else {
    logInfo("  - Worker PACKAGE_CATALOG 无需变更。");
  }

  logInfo("最终暂存区文件如下：");
  for (const file of finalStagedFiles) {
    console.log(`  - ${file}`);
  }

  const confirmedRound2 = await promptYes("第二次确认：将执行 commit + push main + cherry-pick 到 release + push release。");
  if (!confirmedRound2) {
    logWarn("你取消了发布推送流程（改动仍保留在本地与暂存区）。");
    return;
  }

  const publishIds = finalStaged.packageRecords.map((item) => item.id);
  const commitMessage = buildReleaseCommitMessage(publishIds);
  runGit(["commit", "-m", commitMessage], { stdio: "inherit" });
  const commitHash = runGitText(["rev-parse", "HEAD"]);

  runGit(["push", "origin", "main"], { stdio: "inherit" });

  try {
    ensureReleaseBranchAndSwitch();
    runGit(["cherry-pick", commitHash], { stdio: "inherit" });

    const remoteRelease = tryRunGitText(["show-ref", "--verify", "--quiet", "refs/remotes/origin/release"]);
    if (remoteRelease.ok) {
      runGit(["push", "origin", "release"], { stdio: "inherit" });
    } else {
      runGit(["push", "-u", "origin", "release"], { stdio: "inherit" });
    }
  } finally {
    runGit(["switch", "main"], { stdio: "inherit" });
  }

  logInfo("发布链路完成：main 已提交并推送，release 已 cherry-pick 并推送。");
}

async function commandVerifyRelease(options) {
  const baseRef = String(options["base-ref"] || "").trim();
  const apiUrl = String(options["api-url"] || DEFAULT_API_URL).trim();
  if (!baseRef) {
    throw new Error("verify-release 缺少 --base-ref。");
  }

  const allRecords = readAllPublishablePackages();
  assertAllowlistCoverage(allRecords);
  assertWorkerCatalogConsistency(allRecords);

  const changedFiles = getChangedPackageFilesByBaseRef(baseRef);
  if (changedFiles.length === 0) {
    logInfo("verify-release：未检测到 src/packages 改动，跳过版本对比。");
    return;
  }
  await assertChangedPackageVersionGreaterThanRemote(changedFiles, apiUrl);

  logInfo("verify-release 通过。");
  logInfo("改动包数量：", String(changedFiles.length));
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printHelp();
    return;
  }
  const { command, options } = parseArgs(process.argv);
  if (command === "help") {
    printHelp();
    return;
  }

  switch (command) {
    case "prepare-from-staged":
      await commandPrepareFromStaged();
      return;
    case "verify-release":
      await commandVerifyRelease(options);
      return;
    default:
      throw new Error(`未知命令：${command}`);
  }
}

main().catch((error) => {
  logError("执行失败：", error?.stack || error?.message || String(error));
  process.exit(1);
});
