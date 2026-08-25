import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  build: {
    outDir: 'dist/userscript',
    emptyOutDir: true,
    minify: false,
  },
  plugins: [
    monkey({
      entry: 'src/userscript/overlaylex.entry.js',
      userscript: {
        name: 'OverlayLex Translator',
        namespace: 'https://github.com/ZJHSteven/OverlayLex',
        version: pkg.version,
        description: 'OverlayLex 主翻译脚本：按域名加载翻译包并执行页面文本覆盖翻译。',
        author: 'OverlayLex',
        match: ['*://*/*'],
        grant: ['GM_getValue', 'GM_setValue'],
        runAt: 'document-end',
        updateURL: 'https://raw.githubusercontent.com/ZJHSteven/OverlayLex/main/src/userscript/overlaylex.user.js',
        downloadURL: 'https://raw.githubusercontent.com/ZJHSteven/OverlayLex/main/src/userscript/overlaylex.user.js',
      },
      build: {
        fileName: 'overlaylex.user.js',
        metaFileName: 'overlaylex.meta.js',
      },
    }),
  ],
});
