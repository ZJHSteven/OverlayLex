import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

const version = '0.2.17';
const allowlist = JSON.parse(
  readFileSync(new URL('./src/packages/overlaylex-domain-allowlist.json', import.meta.url), 'utf8'),
);

function buildBrowserMatches(rules: Array<{ type: string; value: string }>) {
  const matches = new Set<string>();
  for (const rule of rules) {
    const value = String(rule?.value || '').trim().toLowerCase();
    if (!value) continue;
    if (rule.type === 'exact') {
      matches.add(`*://${value}/*`);
      continue;
    }
    if (rule.type === 'suffix' && value.startsWith('.') && value.length > 1) {
      matches.add(`*://*${value}/*`);
    }
  }
  return [...matches].sort();
}

const browserMatches = buildBrowserMatches(allowlist.rules ?? []);

export default defineConfig({
  manifestVersion: 3,
  targetBrowsers: ['chrome', 'edge', 'firefox'],
  zip: {
    /**
     * Firefox AMO 会要求 reviewer sources ZIP。WXT 默认会把 sourcesRoot 下几乎所有
     * 非隐藏文件都装进去，这对我们的真实工作区不安全：未跟踪的术语 CSV、临时采集
     * JSON 等本地资料也可能被意外上传。
     *
     * 因此这里改成严格 allowlist，只包含“能够从源码重建 Firefox 扩展”所需文件。
     */
    includeSources: [
      'entrypoints/**',
      'src/userscript/overlaylex.user.js',
      'src/packages/overlaylex-domain-allowlist.json',
      'wxt.config.ts',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'SOURCE_CODE_REVIEW.md',
    ],
  },
  manifest: ({ browser }) => ({
    name: 'OverlayLex 枭熊汉化',
    short_name: 'OverlayLex',
    version,
    description: '为 Owlbear Rodeo 及已适配扩展提供运行时中文覆盖翻译。',
    // WebExtension 运行时使用扩展级 storage 共享主站与第三方 iframe 的缓存/设置。
    permissions: ['storage'],
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'overlaylex@zjhstudio.com',
              // `data_collection_permissions` 在 Firefox / Firefox for Android 142
              // 起才完整受支持。把最低版本统一到 142，避免 AMO linter 对 Android
              // 兼容性产生误导性警告，也确保商店展示的能力声明与实际 manifest 一致。
              strict_min_version: '142.0',
              data_collection_permissions: {
                // OverlayLex currently requests a domain-specific translation package
                // from its own API. That package identifier can reveal which supported
                // Owlbear/plugin domain is open, so declare browsingActivity rather
                // than incorrectly claiming "none" during AMO review.
                required: ['browsingActivity'],
              },
            },
          },
        }
      : {}),
  }),
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      for (const script of manifest.content_scripts ?? []) {
        if (script.matches?.includes('<all_urls>')) {
          script.matches = browserMatches;
        }
      }
    },
  },
});
