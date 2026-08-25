import { defineConfig } from 'wxt';

const version = '0.2.16';

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
              data_collection_permissions: {
                required: ['none'],
              },
            },
          },
        }
      : {}),
  }),
});
