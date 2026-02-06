/**
 * Cloudflare Worker API 入口（教学向）
 *
 * 路由设计：
 * - GET /health              -> 健康检查
 * - GET /manifest            -> 返回所有包版本信息
 * - GET /packages/:id.json   -> 返回指定翻译包内容
 *
 * 说明：
 * - 使用官方推荐的 `export default { async fetch(...) {} }` 结构。
 * - 所有响应都带上 CORS，便于用户脚本跨域拉取。
 */

import { PACKAGE_REGISTRY, buildManifest } from "./data.js";

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
  // 例子：/packages/obr-room-core.json -> obr-room-core
  const match = pathname.match(/^\/packages\/([^/]+)\.json$/);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

function optionsResponse() {
  return withCorsHeaders(new Response(null, { status: 204 }));
}

export default {
  async fetch(request) {
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

    const packageId = parsePackageId(url.pathname);
    if (packageId) {
      const packageEntry = PACKAGE_REGISTRY[packageId];
      if (!packageEntry) {
        return jsonResponse(
          {
            error: "Not Found",
            message: `Package not found: ${packageId}`,
          },
          404
        );
      }
      return jsonResponse(packageEntry.package);
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
