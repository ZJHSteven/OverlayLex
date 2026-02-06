/**
 * Worker 元数据层（教学向）
 *
 * 这里专门维护“包目录信息（catalog）”，与“包正文（JSON 内容）”解耦：
 * 1) catalog 放在代码里，负责提供版本、类型、默认开关与接口路由。
 * 2) 包正文放在 R2，对应对象键为 `packages/{id}.json`。
 *
 * 这样做的优点：
 * - 词典包可独立热更新，不需要每次改正文都重新发 Worker 代码。
 * - manifest 仍有稳定结构，主脚本能按版本做缓存策略。
 */

/**
 * SCRIPT_VERSION: 主 API 脚本版本（用于主脚本感知服务端策略变化）。
 */
export const SCRIPT_VERSION = "0.2.0";

/**
 * DOMAIN_PACKAGE_ID: 域名准入包 ID。
 * 主脚本会先拉这个包，判断当前 hostname 是否允许继续运行。
 */
export const DOMAIN_PACKAGE_ID = "overlaylex-domain-allowlist";

/**
 * PACKAGE_CATALOG: 包目录元信息（不含正文）。
 * - kind=translation: 普通翻译包
 * - kind=domain-allowlist: 域名准入包
 */
export const PACKAGE_CATALOG = {
  "obr-room-core": {
    id: "obr-room-core",
    name: "OBR 房间核心中文包",
    kind: "translation",
    version: "0.1.0",
    enabledByDefault: true,
    description: "OBR 房间主界面翻译包（示例）",
  },
  "overlaylex-domain-allowlist": {
    id: "overlaylex-domain-allowlist",
    name: "OverlayLex 域名准入包",
    kind: "domain-allowlist",
    version: "0.1.0",
    enabledByDefault: true,
    description: "控制脚本允许在哪些域名继续执行",
  },
};

/**
 * BUILTIN_PACKAGE_FALLBACKS: 当 R2 不可用或对象缺失时的最小回退包。
 * 说明：
 * - 这里只放最小可运行数据，确保 API 在极端情况下仍可返回关键内容。
 * - 正式生产仍应以 R2 中的对象为准。
 */
export const BUILTIN_PACKAGE_FALLBACKS = {
  "obr-room-core": {
    id: "obr-room-core",
    name: "OBR 房间核心中文包",
    target: {
      host: "owlbear.rodeo",
      pathPrefix: "/room",
    },
    version: "0.1.0",
    translations: {
      "Owlbear Rodeo": "枭熊VTT",
      "You need to enable JavaScript to run this app.": "你需要启用 JavaScript 才能运行此应用。",
      Players: "玩家",
      Search: "搜索",
      "5ft": "5英尺",
    },
  },
  "overlaylex-domain-allowlist": {
    id: "overlaylex-domain-allowlist",
    name: "OverlayLex 域名准入包",
    kind: "domain-allowlist",
    version: "0.1.0",
    rules: [
      { type: "exact", value: "owlbear.rodeo", comment: "OBR 主域名" },
      { type: "exact", value: "www.owlbear.rodeo", comment: "OBR 主域名（www）" },
      { type: "suffix", value: ".owlbear.rodeo", comment: "OBR 相关子域名" },
      { type: "suffix", value: ".owlbear.app", comment: "OBR 生态域名" },
    ],
  },
};

/**
 * buildPackageObjectKey: 将包 ID 转成 R2 对象键。
 * 例子：
 * - 输入: obr-room-core
 * - 输出: packages/obr-room-core.json
 */
export function buildPackageObjectKey(packageId) {
  return `packages/${packageId}.json`;
}

/**
 * buildManifest: 生成返回给主脚本的 manifest。
 * 输出重点：
 * - domainPackage: 域名准入包信息（主脚本先检查这个）
 * - packages: 可勾选的翻译包列表
 */
export function buildManifest(origin) {
  const catalogItems = Object.values(PACKAGE_CATALOG);
  const domainMeta = catalogItems.find((item) => item.kind === "domain-allowlist");

  const translationPackages = catalogItems
    .filter((item) => item.kind === "translation")
    .map((item) => {
      return {
        id: item.id,
        name: item.name,
        kind: item.kind,
        version: item.version,
        url: `${origin}/packages/${encodeURIComponent(item.id)}.json`,
        enabledByDefault: Boolean(item.enabledByDefault),
        description: item.description || "",
      };
    });

  return {
    scriptVersion: SCRIPT_VERSION,
    generatedAt: new Date().toISOString(),
    apiBaseUrl: origin,
    domainPackage: domainMeta
      ? {
          id: domainMeta.id,
          name: domainMeta.name,
          kind: domainMeta.kind,
          version: domainMeta.version,
          url: `${origin}/packages/${encodeURIComponent(domainMeta.id)}.json`,
        }
      : null,
    packages: translationPackages,
  };
}
