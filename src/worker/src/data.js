/**
 * Worker 数据层（教学向）
 *
 * 这里集中维护“包元数据”和“翻译包正文”。
 * 后续如果你把数据迁移到对象存储（R2 / OSS / S3），可以保持接口不变，
 * 只替换这里的数据读取逻辑即可。
 */

/**
 * PACKAGE_REGISTRY: 统一维护所有翻译包。
 * - key: 包 ID（主脚本里会用这个 ID 做开关与缓存）
 * - value.version: 包版本（用于缓存比对）
 * - value.package: 翻译包正文（可直接返回给客户端）
 */
export const PACKAGE_REGISTRY = {
  "obr-room-core": {
    version: "0.1.0",
    package: {
      id: "obr-room-core",
      name: "OBR 房间核心中文包",
      target: {
        host: "owlbear.rodeo",
        pathPrefix: "/room",
      },
      version: "0.1.0",
      translations: {
        "Owlbear Rodeo": "枭熊旅馆",
        "You need to enable JavaScript to run this app.": "你需要启用 JavaScript 才能运行此应用。",
        Players: "玩家",
        Search: "搜索",
        "5ft": "5英尺",
      },
    },
  },
};

/**
 * buildManifest: 生成返回给主脚本的 manifest。
 * 输入：
 * - origin: 当前请求来源（用于拼接绝对 URL）
 *
 * 输出：
 * - scriptVersion: 主脚本版本号
 * - generatedAt: 当前生成时间
 * - packages: 包列表（id/version/url/default 开关）
 */
export function buildManifest(origin) {
  const packages = Object.entries(PACKAGE_REGISTRY).map(([id, item]) => {
    return {
      id,
      name: item.package.name || id,
      version: item.version,
      url: `${origin}/packages/${encodeURIComponent(id)}.json`,
      enabledByDefault: true,
      description: "OverlayLex 示例翻译包",
    };
  });

  return {
    scriptVersion: "0.1.0",
    generatedAt: new Date().toISOString(),
    packages,
  };
}
