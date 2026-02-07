/**
 * Cloudflare Worker API 入口（教学向）
 *
 * 路由设计：
 * - GET /health              -> 健康检查
 * - GET /manifest            -> 返回所有包版本信息
 * - GET /packages            -> 返回包目录（元信息）
 * - GET /packages/:id.json   -> 返回指定翻译包内容
 * - GET /domain-package.json -> 返回域名准入包内容（便于调试）
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
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data, status = 200) {
  return withCorsHeaders(
    Response.json(data, {
      status,
      headers: {
        "Cache-Control": "public, max-age=60",
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

    if (request.method !== "GET") {
      return jsonResponse(
        {
          error: "Method Not Allowed",
          message: "Only GET is supported in this demo API.",
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
