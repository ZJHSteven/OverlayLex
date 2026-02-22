/**
 * Cloudflare Worker API 入口（教学向）
 *
 * 路由设计：
 * - GET /health              -> 健康检查
 * - GET /manifest            -> 返回所有包版本信息
 * - GET /packages            -> 返回包目录（元信息）
 * - GET /packages/:id.json   -> 返回指定翻译包内容
 * - GET /domain-package.json -> 返回域名准入包内容（便于调试）
 * - POST /collector/submissions -> 接收采集脚本上传并触发 GitHub Actions 采集 PR 流程
 *
 * 说明：
 * - 使用官方推荐的 `export default { async fetch(...) {} }` 结构。
 * - 所有响应都带上 CORS，便于用户脚本跨域拉取。
 */

import {
  BUILTIN_PACKAGE_FALLBACKS,
  DOMAIN_PACKAGE_ID,
  PACKAGE_CATALOG,
  buildManifest,
  buildPackageObjectKey,
} from "./data.js";

function withCorsHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-OverlayLex-Invite-Code");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data, status = 200, cacheControl = "public, max-age=60") {
  return withCorsHeaders(
    Response.json(data, {
      status,
      headers: {
        "Cache-Control": cacheControl,
      },
    })
  );
}

function parsePackageId(pathname) {
  // 例子：/packages/obr-www-owlbear-rodeo.json -> obr-www-owlbear-rodeo
  const match = pathname.match(/^\/packages\/([^/]+)\.json$/);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

function optionsResponse() {
  return withCorsHeaders(new Response(null, { status: 204 }));
}

const COLLECTOR_UPLOAD_SCOPE = "current-host-incremental";
const COLLECTOR_MAX_REQUEST_BYTES = 48 * 1024;
const COLLECTOR_MAX_HOST_COUNT = 1;
const COLLECTOR_MAX_TEXTS_PER_HOST = 2000;
const COLLECTOR_MAX_TEXT_LENGTH = 500;

function noStoreJson(data, status = 200) {
  return jsonResponse(data, status, "no-store");
}

function parseJsonTextSafe(rawText) {
  try {
    return { ok: true, value: JSON.parse(rawText) };
  } catch (error) {
    return { ok: false, error };
  }
}

function normalizeCollectorPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw new Error("payload 必须为 { host: string[] } 对象结构。");
  }

  const normalized = {};
  const hostEntries = Object.entries(rawPayload);
  if (hostEntries.length === 0) {
    throw new Error("payload 不能为空。");
  }
  if (hostEntries.length > COLLECTOR_MAX_HOST_COUNT) {
    throw new Error(`首版仅允许上传 ${COLLECTOR_MAX_HOST_COUNT} 个域名（当前请求过多）。`);
  }

  for (const [hostKey, value] of hostEntries) {
    const host = String(hostKey || "").trim().toLowerCase();
    if (!host) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new Error(`域名 ${host} 的值必须是字符串数组。`);
    }
    const unique = new Set();
    for (const item of value) {
      const text = String(item ?? "").trim();
      if (!text) {
        continue;
      }
      if (text.length > COLLECTOR_MAX_TEXT_LENGTH) {
        continue;
      }
      unique.add(text);
      if (unique.size > COLLECTOR_MAX_TEXTS_PER_HOST) {
        throw new Error(`域名 ${host} 的词条数量超过上限（${COLLECTOR_MAX_TEXTS_PER_HOST}）。`);
      }
    }
    normalized[host] = [...unique].sort((a, b) => a.localeCompare(b, "en"));
  }

  if (Object.keys(normalized).length === 0) {
    throw new Error("payload 中没有可用词条。");
  }
  return normalized;
}

function buildSubmissionId(now = new Date()) {
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  const rand = (typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Math.random()}`)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toLowerCase();
  return `${y}${m}${d}-${hh}${mm}${ss}-${rand}`;
}

async function dispatchCollectorSubmissionToGitHub(env, clientPayload) {
  const token = String(env?.GITHUB_DISPATCH_TOKEN || "").trim();
  const owner = String(env?.GITHUB_REPO_OWNER || "").trim();
  const repo = String(env?.GITHUB_REPO_NAME || "").trim();
  if (!token || !owner || !repo) {
    throw new Error("Worker 缺少 GitHub dispatch 所需环境变量（GITHUB_DISPATCH_TOKEN/OWNER/REPO）。");
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "OverlayLex-Collector-Worker",
    },
    body: JSON.stringify({
      event_type: "collector_submission",
      client_payload: clientPayload,
    }),
  });

  if (response.status === 204) {
    return;
  }
  const responseText = await response.text().catch(() => "");
  throw new Error(`GitHub dispatch 失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
}

async function handleCollectorSubmission(request, env) {
  const inviteCodeExpected = String(env?.COLLECTOR_INVITE_CODE || "").trim();
  if (!inviteCodeExpected) {
    return noStoreJson(
      {
        ok: false,
        error: "SERVER_NOT_CONFIGURED",
        message: "服务端未配置 COLLECTOR_INVITE_CODE。",
      },
      503
    );
  }

  const rawText = await request.text();
  const rawSize = new TextEncoder().encode(rawText).length;
  if (rawSize > COLLECTOR_MAX_REQUEST_BYTES) {
    return noStoreJson(
      {
        ok: false,
        error: "PAYLOAD_TOO_LARGE",
        message: `请求体过大（>${COLLECTOR_MAX_REQUEST_BYTES} bytes），请改用复制 JSON 人工流程。`,
      },
      413
    );
  }

  const parsed = parseJsonTextSafe(rawText);
  if (!parsed.ok) {
    return noStoreJson(
      {
        ok: false,
        error: "INVALID_JSON",
        message: "请求体不是合法 JSON。",
      },
      400
    );
  }

  const body = parsed.value;
  const inviteCode =
    String(request.headers.get("X-OverlayLex-Invite-Code") || "").trim() ||
    String(body?.inviteCode || "").trim();
  if (!inviteCode || inviteCode !== inviteCodeExpected) {
    return noStoreJson(
      {
        ok: false,
        error: "INVALID_INVITE_CODE",
        message: "邀请码错误或已失效。",
      },
      403
    );
  }

  const scope = String(body?.scope || "").trim();
  if (scope !== COLLECTOR_UPLOAD_SCOPE) {
    return noStoreJson(
      {
        ok: false,
        error: "INVALID_SCOPE",
        message: `仅支持 scope=${COLLECTOR_UPLOAD_SCOPE}。`,
      },
      400
    );
  }

  const host = String(body?.host || "").trim().toLowerCase();
  if (!host) {
    return noStoreJson(
      {
        ok: false,
        error: "INVALID_HOST",
        message: "缺少 host。",
      },
      400
    );
  }

  let normalizedPayload;
  try {
    normalizedPayload = normalizeCollectorPayload(body?.payload);
  } catch (error) {
    return noStoreJson(
      {
        ok: false,
        error: "INVALID_PAYLOAD",
        message: String(error?.message || error),
      },
      400
    );
  }

  if (!Object.prototype.hasOwnProperty.call(normalizedPayload, host)) {
    return noStoreJson(
      {
        ok: false,
        error: "HOST_MISMATCH",
        message: "host 与 payload 的域名键不一致。",
      },
      400
    );
  }

  const submissionId = buildSubmissionId();
  const submittedAt = new Date().toISOString();
  const alias = String(body?.meta?.alias || "").trim().slice(0, 64);
  const pageUrl = String(body?.meta?.pageUrl || "").trim().slice(0, 500);
  const collectorScriptVersion = String(body?.meta?.collectorScriptVersion || "").trim().slice(0, 32);
  const totalTexts = Object.values(normalizedPayload).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);

  const clientPayload = {
    submissionId,
    submittedAt,
    host,
    scope: COLLECTOR_UPLOAD_SCOPE,
    alias,
    pageUrl,
    collectorScriptVersion,
    totalTexts,
    collected: normalizedPayload,
  };

  try {
    await dispatchCollectorSubmissionToGitHub(env, clientPayload);
  } catch (error) {
    return noStoreJson(
      {
        ok: false,
        error: "GITHUB_DISPATCH_FAILED",
        message: String(error?.message || error),
      },
      502
    );
  }

  return noStoreJson({
    ok: true,
    submissionId,
    status: "accepted",
    message: "采集已提交，正在触发 CI。",
    totalTexts,
  }, 202);
}

async function readPackageFromR2(env, packageId) {
  // 未绑定 R2 时返回 null，让上层走回退逻辑。
  if (!env || !env.PACKAGES_BUCKET) {
    return null;
  }

  const objectKey = buildPackageObjectKey(packageId);
  const object = await env.PACKAGES_BUCKET.get(objectKey);
  if (!object) {
    return null;
  }

  const raw = await object.text();
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`R2 对象 JSON 解析失败: ${objectKey}; ${String(error)}`);
  }
}

async function resolvePackageData(env, packageId) {
  // 先读 R2，保证正文可独立更新。
  const fromR2 = await readPackageFromR2(env, packageId);
  if (fromR2) {
    return fromR2;
  }

  // R2 缺失时，回退到内置最小包，避免 API 完全不可用。
  return BUILTIN_PACKAGE_FALLBACKS[packageId] || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return optionsResponse();
    }

    if (request.method === "POST" && url.pathname === "/collector/submissions") {
      return handleCollectorSubmission(request, env);
    }

    if (request.method !== "GET") {
      return noStoreJson(
        {
          ok: false,
          error: "Method Not Allowed",
          message: "Only GET / collector POST / OPTIONS are supported in this API.",
        },
        405
      );
    }

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "OverlayLex API Demo",
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/manifest") {
      const origin = `${url.protocol}//${url.host}`;
      const manifest = buildManifest(origin);
      return jsonResponse(manifest);
    }

    if (url.pathname === "/packages") {
      return jsonResponse({
        generatedAt: new Date().toISOString(),
        items: Object.values(PACKAGE_CATALOG),
      });
    }

    if (url.pathname === "/domain-package.json") {
      const domainPackageData = await resolvePackageData(env, DOMAIN_PACKAGE_ID);
      if (!domainPackageData) {
        return jsonResponse(
          {
            error: "Not Found",
            message: `Domain package not found: ${DOMAIN_PACKAGE_ID}`,
          },
          404
        );
      }
      return jsonResponse(domainPackageData);
    }

    const packageId = parsePackageId(url.pathname);
    if (packageId) {
      const packageData = await resolvePackageData(env, packageId);
      if (!packageData) {
        return jsonResponse(
          {
            error: "Not Found",
            message: `Package not found: ${packageId}`,
          },
          404
        );
      }
      return jsonResponse(packageData);
    }

    return jsonResponse(
      {
        error: "Not Found",
        message: `Unknown route: ${url.pathname}`,
      },
      404
    );
  },
};
