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
export const SCRIPT_VERSION = "0.2.1";

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
  "obr-bubbles-for-owlbear-rodeo-pages-dev": {
    "id": "obr-bubbles-for-owlbear-rodeo-pages-dev",
    "name": "OBR 自动翻译包 - bubbles-for-owlbear-rodeo.pages.dev",
    "kind": "translation",
    "version": "0.1.4",
    "enabledByDefault": true,
    "description": "OBR 自动翻译包 - bubbles-for-owlbear-rodeo.pages.dev（自动同步）"
  },
  "obr-clash-battle-system-com": {
    "id": "obr-clash-battle-system-com",
    "name": "Clash 插件中文包（clash.battle-system.com）",
    "kind": "translation",
    "version": "0.1.6",
    "enabledByDefault": true,
    "description": "Clash 插件翻译包（自动采集生成）"
  },
  "obr-dddice-com": {
    "id": "obr-dddice-com",
    "name": "OBR 自动翻译包 - dddice.com",
    "kind": "translation",
    "version": "0.1.1",
    "enabledByDefault": true,
    "description": "OBR 自动翻译包 - dddice.com（自动同步）"
  },
  "obr-dynamic-fog-owlbear-rodeo": {
    "id": "obr-dynamic-fog-owlbear-rodeo",
    "name": "OBR 自动翻译包 - dynamic-fog.owlbear.rodeo",
    "kind": "translation",
    "version": "0.1.1",
    "enabledByDefault": true,
    "description": "OBR 自动翻译包 - dynamic-fog.owlbear.rodeo（自动同步）"
  },
  "obr-marked-battle-system-com": {
    "id": "obr-marked-battle-system-com",
    "name": "OBR 自动翻译包 - marked.battle-system.com",
    "kind": "translation",
    "version": "0.1.1",
    "enabledByDefault": true,
    "description": "OBR 自动翻译包 - marked.battle-system.com（自动同步）"
  },
  "obr-movement-tracker-abarbre-com": {
    "id": "obr-movement-tracker-abarbre-com",
    "name": "OBR 自动翻译包 - movement-tracker.abarbre.com",
    "kind": "translation",
    "version": "0.1.1",
    "enabledByDefault": true,
    "description": "OBR 自动翻译包 - movement-tracker.abarbre.com（自动同步）"
  },
  "obr-music-player-adrf-onrender-com": {
    "id": "obr-music-player-adrf-onrender-com",
    "name": "OBR 自动翻译包 - music-player-adrf.onrender.com",
    "kind": "translation",
    "version": "0.1.1",
    "enabledByDefault": true,
    "description": "OBR 自动翻译包 - music-player-adrf.onrender.com（自动同步）"
  },
  "obr-outliner-owlbear-rodeo": {
    "id": "obr-outliner-owlbear-rodeo",
    "name": "Outliner 插件中文包（outliner.owlbear.rodeo）",
    "kind": "translation",
    "version": "0.1.4",
    "enabledByDefault": true,
    "description": "Outliner 插件翻译包（自动采集生成）"
  },
  "obr-owlbear-hp-tracker-pages-dev": {
    "id": "obr-owlbear-hp-tracker-pages-dev",
    "name": "HP Tracker 插件中文包（owlbear-hp-tracker.pages.dev）",
    "kind": "translation",
    "version": "0.1.0",
    "enabledByDefault": true,
    "description": "HP Tracker 插件翻译包（自动采集生成）"
  },
  "obr-owlbear-rodeo-bubbles-extension-onrender-com": {
    "id": "obr-owlbear-rodeo-bubbles-extension-onrender-com",
    "name": "OBR 自动翻译包 - owlbear-rodeo-bubbles-extension.onrender.com",
    "kind": "translation",
    "version": "0.1.4",
    "enabledByDefault": true,
    "description": "OBR 自动翻译包 - owlbear-rodeo-bubbles-extension.onrender.com（自动同步）"
  },
  "obr-smoke-battle-system-com": {
    "id": "obr-smoke-battle-system-com",
    "name": "Smoke 插件中文包（smoke.battle-system.com）",
    "kind": "translation",
    "version": "0.1.7",
    "enabledByDefault": true,
    "description": "Smoke & Spectre 插件翻译包（自动采集生成）"
  },
  "obr-theatre-battle-system-com": {
    "id": "obr-theatre-battle-system-com",
    "name": "OBR 自动翻译包 - theatre.battle-system.com",
    "kind": "translation",
    "version": "0.1.4",
    "enabledByDefault": true,
    "description": "OBR 自动翻译包 - theatre.battle-system.com（自动同步）"
  },
  "obr-www-dummysheet-com": {
    "id": "obr-www-dummysheet-com",
    "name": "OBR 自动翻译包 - www.dummysheet.com",
    "kind": "translation",
    "version": "0.1.4",
    "enabledByDefault": true,
    "description": "OBR 自动翻译包 - www.dummysheet.com（自动同步）"
  },
  "obr-www-owlbear-rodeo": {
    "id": "obr-www-owlbear-rodeo",
    "name": "OBR 主站与房间中文包（owlbear.rodeo）",
    "kind": "translation",
    "version": "0.2.7",
    "enabledByDefault": true,
    "description": "OBR 主站与房间统一翻译包（已合并 room-core）"
  },
  "overlaylex-domain-allowlist": {
    "id": "overlaylex-domain-allowlist",
    "name": "OverlayLex 域名准入包",
    "kind": "domain-allowlist",
    "version": "0.2.5",
    "enabledByDefault": true,
    "description": "控制脚本允许在哪些域名继续执行"
  }
};

/**
 * BUILTIN_PACKAGE_FALLBACKS: 当 R2 不可用或对象缺失时的最小回退包。
 * 说明：
 * - 这里只放最小可运行数据，确保 API 在极端情况下仍可返回关键内容。
 * - 正式生产仍应以 R2 中的对象为准。
 */
export const BUILTIN_PACKAGE_FALLBACKS = {
  "obr-www-owlbear-rodeo": {
    "id": "obr-www-owlbear-rodeo",
    "name": "OBR 主站与房间中文包（owlbear.rodeo）",
    "target": {
      "hosts": [
        "owlbear.rodeo",
        "www.owlbear.rodeo"
      ],
      "pathPrefix": "/"
    },
    "version": "0.2.0",
    "translations": {
      "Owlbear Rodeo": "枭熊VTT",
      "You need to enable JavaScript to run this app.": "你需要启用 JavaScript 才能运行此应用。",
      "Players": "玩家",
      "Search": "搜索",
      "5ft": "5英尺"
    }
  },
  "obr-room-core": {
    "id": "obr-room-core",
    "name": "OBR 房间核心中文包（兼容别名）",
    "target": {
      "host": "owlbear.rodeo",
      "pathPrefix": "/room"
    },
    "version": "0.2.0",
    "translations": {
      "Owlbear Rodeo": "枭熊VTT",
      "You need to enable JavaScript to run this app.": "你需要启用 JavaScript 才能运行此应用。",
      "Players": "玩家",
      "Search": "搜索",
      "5ft": "5英尺"
    }
  },
  "overlaylex-domain-allowlist": {
    "id": "overlaylex-domain-allowlist",
    "name": "OverlayLex 域名准入包",
    "kind": "domain-allowlist",
    "version": "0.2.5",
    "rules": [
      {
        "type": "exact",
        "value": "owlbear.rodeo",
        "comment": "OBR 主域名"
      },
      {
        "type": "exact",
        "value": "www.owlbear.rodeo",
        "comment": "OBR 主域名（www）"
      },
      {
        "type": "suffix",
        "value": ".owlbear.rodeo",
        "comment": "OBR 相关子域名"
      },
      {
        "type": "suffix",
        "value": ".owlbear.app",
        "comment": "OBR 生态域名"
      },
      {
        "type": "suffix",
        "value": ".battle-system.com",
        "comment": "Battle-System 插件域名"
      },
      {
        "type": "exact",
        "value": "dddice.com",
        "comment": "DDDice 插件域名"
      },
      {
        "type": "exact",
        "value": "aoe.owlbear.davidsev.co.uk",
        "comment": "AoE 插件域名"
      },
      {
        "type": "exact",
        "value": "owlbear-hp-tracker.pages.dev",
        "comment": "HP Tracker 插件域名"
      },
      {
        "type": "exact",
        "value": "resident-uhlig.gitlab.io",
        "comment": "resident-uhlig 插件域名"
      },
      {
        "type": "exact",
        "value": "bubbles-for-owlbear-rodeo.pages.dev",
        "comment": "自动同步包域名",
        "source": "obr-bubbles-for-owlbear-rodeo-pages-dev"
      },
      {
        "type": "exact",
        "value": "movement-tracker.abarbre.com",
        "comment": "自动同步包域名",
        "source": "obr-movement-tracker-abarbre-com"
      },
      {
        "type": "exact",
        "value": "music-player-adrf.onrender.com",
        "comment": "自动同步包域名",
        "source": "obr-music-player-adrf-onrender-com"
      },
      {
        "type": "exact",
        "value": "owlbear-rodeo-bubbles-extension.onrender.com",
        "comment": "自动同步包域名",
        "source": "obr-owlbear-rodeo-bubbles-extension-onrender-com"
      },
      {
        "type": "exact",
        "value": "www.dummysheet.com",
        "comment": "自动同步包域名",
        "source": "obr-www-dummysheet-com"
      }
    ]
  }
};

/**
 * buildPackageObjectKey: 将包 ID 转成 R2 对象键。
 * 例子：
 * - 输入: obr-www-owlbear-rodeo
 * - 输出: packages/obr-www-owlbear-rodeo.json
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
