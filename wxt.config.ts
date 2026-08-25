import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

const version = '0.2.16';
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
  manifest: ({ browser }) => ({
    name: 'OverlayLex 枭熊汉化',
    short_name: 'OverlayLex',
    version,
    description: '为 Owlbear Rodeo 及已适配扩展提供运行时中文覆盖翻译。',
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'overlaylex@zjhstudio.com',
              strict_min_version: '140.0',
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
