#!/usr/bin/env node
/**
 * ParaTranz API 通用命令行客户端（教学向版本）
 *
 * 这个脚本的目标是“少记忆 + 少出错”：
 * 1. 先从 operation-index.json 读取所有 operationId；
 * 2. 再按 operationId 自动拼接请求方法和路径；
 * 3. 支持 path/query/header/json/form/raw-body 五类常见传参；
 * 4. 默认从环境变量 PARATRANZ_TOKEN 读取 Token，避免明文写入命令历史。
 *
 * 设计取舍：
 * - 不追求生成强类型 SDK，而是追求命令行快速调试与脚本化调用。
 * - 不强制限制请求体格式，允许你按接口文档灵活选择 json/form/raw-body。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * 默认 API 基础地址。
 * 如果以后迁移到其他环境，可以用 --base-url 覆盖。
 */
const DEFAULT_BASE_URL = 'https://paratranz.cn/api';

/**
 * 基于当前脚本文件路径定位 references 目录。
 * 这样无论在仓库根目录还是其他目录执行命令，都能正确读取索引文件。
 */
const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE_PATH);
const OPERATION_INDEX_PATH = path.resolve(CURRENT_DIR, '../references/operation-index.json');

/**
 * 打印帮助文案。
 * 保持命令示例和选项说明都在一处，方便初学者对照修改。
 */
function printHelp() {
  console.log(`
用法:
  node skills/paratranz-api/scripts/paratranz-api-client.mjs list
  node skills/paratranz-api/scripts/paratranz-api-client.mjs call <operationId> [选项]

常用选项:
  --token <token>                 指定 API Token（不传时读取 PARATRANZ_TOKEN）
  --base-url <url>                指定 API 基础地址，默认 https://paratranz.cn/api
  --path "k=v,k2=v2"              路径参数（用于替换 /projects/{projectId} 里的占位符）
  --query "k=v,k2=v2"             查询参数
  --header "k=v,k2=v2"            额外请求头（会与 Authorization 合并）
  --json '{"k":"v"}'              JSON 请求体
  --form "k=v,file=@./a.json"     表单请求体；值以 @ 开头表示文件上传
  --raw-body '<text>'             原始请求体（与 --content-type 一起使用）
  --content-type "<mime>"         原始请求体内容类型，默认 text/plain;charset=UTF-8
  --dry-run                       只打印请求信息，不真正发起请求
  --output "<path>"               将响应正文写入文件（适合下载或留档）

示例:
  node skills/paratranz-api/scripts/paratranz-api-client.mjs list

  node skills/paratranz-api/scripts/paratranz-api-client.mjs call getProjects \\
    --query "page=1,pageSize=20"

  node skills/paratranz-api/scripts/paratranz-api-client.mjs call getProject \\
    --path "projectId=123"

  node skills/paratranz-api/scripts/paratranz-api-client.mjs call createTerm \\
    --path "projectId=123" \\
    --json '{"term":"apple","translation":"苹果","pos":"noun"}'
`);
}

/**
 * 解析命令行参数。
 * 返回结构:
 * - command: list | call
 * - operationId: 仅 call 命令需要
 * - options: 统一放入键值对象，便于后续处理
 */
function parseCommandLine(argv) {
  const args = argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help', operationId: '', options: {} };
  }

  if (command === 'list') {
    return { command: 'list', operationId: '', options: {} };
  }

  if (command !== 'call') {
    throw new Error(`不支持的命令：${command}。仅支持 list / call / help。`);
  }

  const operationId = args[1];
  if (!operationId) {
    throw new Error('call 命令缺少 operationId。');
  }

  const options = {};
  for (let i = 2; i < args.length; i += 1) {
    const raw = args[i];

    if (!raw.startsWith('--')) {
      throw new Error(`无法解析参数：${raw}。所有选项都应以 -- 开头。`);
    }

    const key = raw.slice(2);
    if (key === 'dry-run') {
      options.dryRun = true;
      continue;
    }

    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`选项 --${key} 缺少值。`);
    }

    options[key] = value;
    i += 1;
  }

  return { command, operationId, options };
}

/**
 * 读取并解析 operation 索引。
 * 这个索引来自 OpenAPI 文档自动生成，能覆盖全部接口。
 */
function loadOperationIndex() {
  if (!fs.existsSync(OPERATION_INDEX_PATH)) {
    throw new Error(`找不到索引文件：${OPERATION_INDEX_PATH}`);
  }

  const content = fs.readFileSync(OPERATION_INDEX_PATH, 'utf8');
  const parsed = JSON.parse(content);

  if (!Array.isArray(parsed.operations)) {
    throw new Error('operation-index.json 格式无效：缺少 operations 数组。');
  }

  return parsed;
}

/**
 * 将 "k=v,k2=v2" 解析为对象。
 * 设计说明：
 * - 用逗号分隔多个项；
 * - 每项只按第一个 "=" 切分，避免值里包含 "=" 时丢数据；
 * - 对空字符串做过滤。
 */
function parsePairList(raw) {
  const result = {};
  if (!raw) return result;

  const items = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  for (const item of items) {
    const eqIndex = item.indexOf('=');
    if (eqIndex <= 0) {
      throw new Error(`键值对格式错误：${item}。应为 key=value。`);
    }

    const key = item.slice(0, eqIndex).trim();
    const value = item.slice(eqIndex + 1).trim();
    result[key] = value;
  }

  return result;
}

/**
 * 按路径参数替换 URL 模板。
 * 例如 /projects/{projectId} + { projectId: 123 } => /projects/123
 */
function applyPathParams(pathTemplate, pathParams) {
  return pathTemplate.replace(/\{([^}]+)\}/g, (full, name) => {
    if (!(name in pathParams)) {
      throw new Error(`缺少路径参数：${name}`);
    }
    return encodeURIComponent(pathParams[name]);
  });
}

/**
 * 将查询参数对象拼成 URLSearchParams 字符串。
 * 会自动跳过 undefined / null，避免产生无意义参数。
 */
function appendQueryParams(url, queryParams) {
  const finalUrl = new URL(url);
  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined || value === null) continue;
    finalUrl.searchParams.set(key, String(value));
  }
  return finalUrl.toString();
}

/**
 * 根据用户输入构建请求体与附加请求头。
 * 返回:
 * - body: fetch 可直接使用的 body
 * - extraHeaders: 由请求体推导的请求头（例如 Content-Type）
 */
function buildRequestBody(options) {
  const hasJson = typeof options.json === 'string';
  const hasForm = typeof options.form === 'string';
  const hasRaw = typeof options['raw-body'] === 'string';

  const modeCount = [hasJson, hasForm, hasRaw].filter(Boolean).length;
  if (modeCount > 1) {
    throw new Error('请求体参数冲突：--json / --form / --raw-body 只能三选一。');
  }

  if (hasJson) {
    /**
     * 先解析再序列化，提前暴露 JSON 格式错误，
     * 也顺带保证输出 JSON 是规范格式。
     */
    const parsed = JSON.parse(options.json);
    return {
      body: JSON.stringify(parsed),
      extraHeaders: { 'Content-Type': 'application/json' },
    };
  }

  if (hasForm) {
    /**
     * 表单模式同时支持普通字段与文件字段：
     * - key=value          => 普通文本字段
     * - key=@./file.json   => 文件字段
     */
    const formData = new FormData();
    const formPairs = parsePairList(options.form);

    for (const [key, value] of Object.entries(formPairs)) {
      if (value.startsWith('@')) {
        const filePath = path.resolve(process.cwd(), value.slice(1));
        if (!fs.existsSync(filePath)) {
          throw new Error(`上传文件不存在：${filePath}`);
        }

        const filename = path.basename(filePath);
        const fileBuffer = fs.readFileSync(filePath);
        const blob = new Blob([fileBuffer]);
        formData.append(key, blob, filename);
      } else {
        formData.append(key, value);
      }
    }

    /**
     * fetch + FormData 会自动生成 multipart 边界并设置 Content-Type，
     * 因此这里不要手动设置 Content-Type。
     */
    return { body: formData, extraHeaders: {} };
  }

  if (hasRaw) {
    const contentType = options['content-type'] || 'text/plain;charset=UTF-8';
    return {
      body: options['raw-body'],
      extraHeaders: { 'Content-Type': contentType },
    };
  }

  return { body: undefined, extraHeaders: {} };
}

/**
 * 按接口定义检查必填路径参数是否已提供。
 * 只检查 path 参数，因为 query/body 是否必填通常更复杂，交给服务端兜底更稳妥。
 */
function validateRequiredPathParams(operation, pathParams) {
  const requiredPathParams = operation.parameters.filter(
    (param) => param.in === 'path' && param.required,
  );

  for (const param of requiredPathParams) {
    if (!(param.name in pathParams)) {
      throw new Error(
        `接口 ${operation.operationId} 缺少必填路径参数 ${param.name}，请使用 --path "${param.name}=..."`,
      );
    }
  }
}

/**
 * 打印接口列表，帮助用户快速定位 operationId。
 */
function printOperationList(operations) {
  console.log(`共 ${operations.length} 个接口：`);
  for (const op of operations) {
    console.log(
      `${op.operationId.padEnd(24, ' ')} | ${op.method.padEnd(6, ' ')} | ${op.path} | ${op.summary}`,
    );
  }
}

/**
 * 根据响应内容类型，决定如何展示或落盘。
 * 规则：
 * - JSON: 解析并格式化输出
 * - 文本: 原样输出
 * - 二进制: 直接写文件（如果提供 --output）
 */
async function handleResponse(response, outputPath) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (outputPath) {
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const finalPath = path.resolve(process.cwd(), outputPath);
    fs.writeFileSync(finalPath, buffer);
    console.log(`响应已写入文件：${finalPath}`);
    return;
  }

  if (contentType.includes('application/json')) {
    const json = await response.json();
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  const text = await response.text();
  console.log(text);
}

/**
 * 执行单次 API 调用。
 * 这是主流程函数：参数解析完成后，统一在这里构建请求并发送。
 */
async function callOperation(indexData, operationId, options) {
  const operation = indexData.operations.find((item) => item.operationId === operationId);
  if (!operation) {
    throw new Error(
      `未找到 operationId=${operationId}。请先执行 list 查看可用接口。`,
    );
  }

  const token = options.token || process.env.PARATRANZ_TOKEN;
  if (!token) {
    throw new Error('缺少 Token。请传 --token 或设置 PARATRANZ_TOKEN 环境变量。');
  }

  const baseUrl = options['base-url'] || indexData.baseUrl || DEFAULT_BASE_URL;
  const pathParams = parsePairList(options.path || '');
  const queryParams = parsePairList(options.query || '');
  const extraHeaders = parsePairList(options.header || '');

  validateRequiredPathParams(operation, pathParams);

  const resolvedPath = applyPathParams(operation.path, pathParams);
  const mergedUrl = appendQueryParams(`${baseUrl}${resolvedPath}`, queryParams);

  const requestBody = buildRequestBody(options);
  const headers = {
    Authorization: `Bearer ${token}`,
    ...extraHeaders,
    ...requestBody.extraHeaders,
  };

  if (options.dryRun) {
    console.log('Dry Run 请求预览：');
    console.log(JSON.stringify(
      {
        operationId: operation.operationId,
        method: operation.method,
        url: mergedUrl,
        headers,
        hasBody: requestBody.body !== undefined,
      },
      null,
      2,
    ));
    return;
  }

  const response = await fetch(mergedUrl, {
    method: operation.method,
    headers,
    body: requestBody.body,
  });

  console.log(`HTTP ${response.status} ${response.statusText}`);
  if (!response.ok) {
    console.error('请求失败，下面是服务端返回内容：');
  }

  await handleResponse(response, options.output);
}

/**
 * 程序入口。
 * 统一捕获异常并返回非零退出码，便于在 CI 或脚本链路中识别失败。
 */
async function main() {
  const parsed = parseCommandLine(process.argv);

  if (parsed.command === 'help') {
    printHelp();
    return;
  }

  const indexData = loadOperationIndex();

  if (parsed.command === 'list') {
    printOperationList(indexData.operations);
    return;
  }

  await callOperation(indexData, parsed.operationId, parsed.options);
}

main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 1;
});

